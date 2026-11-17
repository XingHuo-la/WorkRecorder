// 全局撤销栈。Ctrl+Z / Ctrl+Y 的唯一实现。
//
// 为什么不是「每个模块自己攒历史」：
//   ① 用户的 Ctrl+Z 只有一种期望 —— 撤销我刚才做的事，不管那事发生在表格、笔记还是白板。
//      分模块各攒一套，就会出现「在笔记里按 Ctrl+Z，把十分钟前表格里的改动撤了」。
//   ② 撤销是写库操作，必须能被「正在撤销」标记挡住，否则 undo 自己的写入会再进历史，形成死循环。
//   ③ 需要合并：笔记自动保存 800ms 一次，不合并的话撤销一次只回退几个字。
//
// 命令模式：每个操作登记一对反向/正向动作，栈里只存数据不存 SQL。
// 不允许在 undo() 里再 push —— applying 期间 push 被直接丢弃，这是硬约束。

const DEFAULT_LIMIT = 120;
const DEFAULT_MERGE_WINDOW = 800;

export function createUndoStack(options = {}) {
  const limit = Math.max(1, Number(options.limit) || DEFAULT_LIMIT);
  const mergeWindow = Math.max(0, Number(options.mergeWindow ?? DEFAULT_MERGE_WINDOW));

  const past = [];
  const future = [];
  const listeners = new Set();

  let applying = false;
  let lastMergeKey = null;
  let lastAt = 0;

  function notify() {
    const state = { canUndo: past.length > 0, canRedo: future.length > 0, depth: past.length };
    listeners.forEach(fn => {
      try { fn(state); } catch (error) { /* 监听器自己的错不该打断撤销 */ }
    });
  }

  /**
   * 登记一次操作。
   * @param {{label?:string, mergeKey?:string, undo:Function, redo?:Function}} entry
   *   mergeKey：同 key 且在合并窗口内的连续登记会合并成一条。
   *             undo 取最早那次的（回到最初状态），redo 取最新那次的（去到最新状态）。
   */
  function push(entry) {
    if (applying) return false;
    if (!entry || typeof entry.undo !== 'function') return false;

    const now = Date.now();
    const key = entry.mergeKey || null;
    const canMerge = Boolean(key) && key === lastMergeKey && now - lastAt < mergeWindow && past.length > 0;

    // 新操作一律截断重做链：历史是一条线，不是一棵树
    future.length = 0;

    if (canMerge) {
      const top = past[past.length - 1];
      if (typeof entry.redo === 'function') top.redo = entry.redo;
      top.label = entry.label || top.label;
      top.at = now;
      top.merged = (top.merged || 1) + 1;
    } else {
      past.push({ ...entry, at: now });
      if (past.length > limit) past.shift();
    }

    lastMergeKey = key;
    lastAt = now;
    notify();
    return true;
  }

  async function run(entry, direction) {
    const action = direction === 'undo' ? entry.undo : entry.redo;
    if (typeof action !== 'function') return false;
    applying = true;
    try {
      await action();
    } catch (error) {
      // 失败就把它放回去，否则这次操作从历史里凭空消失了
      (direction === 'undo' ? past : future).push(entry);
      notify();
      throw error;
    } finally {
      applying = false;
    }
    return true;
  }

  async function undo() {
    const entry = past.pop();
    if (!entry) return null;
    await run(entry, 'undo');
    future.push(entry);
    lastMergeKey = null;
    lastAt = 0;
    notify();
    return entry;
  }

  async function redo() {
    const entry = future.pop();
    if (!entry) return null;
    await run(entry, 'redo');
    past.push(entry);
    lastMergeKey = null;
    lastAt = 0;
    notify();
    return entry;
  }

  function clear() {
    past.length = 0;
    future.length = 0;
    lastMergeKey = null;
    lastAt = 0;
    notify();
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    push,
    undo,
    redo,
    clear,
    subscribe,
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get depth() { return past.length; },
    get applying() { return applying; },
    /** 测试与调试用：只看不摸 */
    peek: () => past.map(entry => ({ label: entry.label, at: entry.at, merged: entry.merged || 1 })),
  };
}

// 全局单例。所有视图共用一条历史线。
export const undoStack = createUndoStack();

/**
 * 把 Ctrl+Z / Ctrl+Y 绑到全局栈上。
 *
 * 三条放行规则（否则会和原生的文本撤销打架）：
 *   ① 焦点在 input / textarea / contenteditable → 交给浏览器
 *   ② 事件已被更内层处理（defaultPrevented）→ 不重复处理
 *   ③ 正在撤销中 → 忽略
 *
 * @param {{onAfter?: (entry:any, kind:'undo'|'redo')=>void, onEmpty?: ()=>void}} [hooks]
 * @returns {() => void} 解绑函数
 */
export function bindUndoShortcuts(hooks = {}) {
  const isTyping = target => {
    const el = target?.closest?.('input, textarea, [contenteditable="true"]');
    if (!el) return false;
    // 表格单元格的编辑器是 input/textarea，但它的 Ctrl+Z 由 gridCore 接管，
    // 那一边会 preventDefault，所以这里只要看 defaultPrevented 就够了。
    return true;
  };

  const onKey = event => {
    if (event.defaultPrevented) return;
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || event.altKey) return;
    const key = String(event.key).toLowerCase();
    const isUndo = key === 'z' && !event.shiftKey;
    const isRedo = (key === 'z' && event.shiftKey) || key === 'y';
    if (!isUndo && !isRedo) return;
    if (isTyping(event.target)) return;
    if (undoStack.applying) return;

    event.preventDefault();
    const task = isUndo ? undoStack.undo() : undoStack.redo();
    task
      .then(entry => {
        if (!entry) { hooks.onEmpty?.(); return; }
        hooks.onAfter?.(entry, isUndo ? 'undo' : 'redo');
      })
      .catch(error => {
        console.error('[undo] 失败:', error);
      });
  };

  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}
