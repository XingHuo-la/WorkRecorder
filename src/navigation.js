// 抽屉的跳转栈。
//
// 起因：关联字段（T08）让「一条记录 → 另一条记录」变成一次点击，但点进去之后
// 只能靠关掉再从头找回来 —— 用户点得越顺，回程越痛。
//
// 语义就四条：
//   ① 每开一个记录抽屉 = 入栈一层；
//   ② Esc = 退一层：栈里还有上一层就回到它，没有就正常关闭；
//   ③ 关掉栈顶 = 用户离开了这条线索 ⇒ 整栈作废；
//   ④ 主动换表 = 整栈作废（那时候「上一条记录」已经不在语境里）。
//
// ③ 与「被后代替换」的区别见 drop()：在 A 里点关联打开 B 时，A 是被替换掉的祖先，
// 它也会收到 onClose，但那是框架行为不是用户意图 —— 这一条必须留在栈里。
//
// 为什么不做「表」这一层：抽屉是浮层，底下的表从来没被替换掉 ——
// 关掉最后一个抽屉，表就在原地，连滚动位置和选区都还在。把表也塞进栈，
// 只会让「深度 1 的抽屉」变成「深度 2」，Esc 要多按一次才关得掉。
//
// 关键约束：**回退时重开的那一层不能再入栈**（restoring 标志），
// 否则每退一次栈就长高一层，Esc 变成永远退不完。

const MAX_DEPTH = 12; // 防御：链再长也不该无限增长

let seq = 0;
const stack = [];
let closer = null;
let restoring = false;
let restoringId = -1;

/** 关掉当前这一层的动作（closeAllPanels）。由宿主注入，避免本模块反向依赖 UI。 */
export function setNavCloser(fn) {
  closer = typeof fn === 'function' ? fn : null;
}

/**
 * 入栈，返回这一层的 id（关掉它的时候要用）。
 *
 * 回退过程中调用 = 宿主把上一层重新画了出来，**不新建条目**：
 * 返回的是被恢复那一层的 id，让重开的抽屉接管同一条记录。
 * 曾经这里返回 -1，结果重开的抽屉拿着 -1 过完一生，最后关掉时 drop(-1) 是空操作，
 * 栈里那条永远清不掉 —— 关掉抽屉之后按 Esc，栈还剩一层，再也退不出去。
 */
export function push(entry = {}) {
  if (restoring) return restoringId;
  const id = ++seq;
  stack.push({ id, kind: entry.kind || 'drawer', label: String(entry.label ?? ''), reopen: entry.reopen });
  if (stack.length > MAX_DEPTH) stack.splice(0, stack.length - MAX_DEPTH);
  return id;
}

/**
 * 这一层被关掉了（点 × / Esc 关最后一层 / 换记录）。
 *
 * 两种情况的区别是这套栈唯一的坑：
 *   · **关的是栈顶** = 用户真的离开了这条线索 → 整栈作废。
 *     留着下面的条目只会让下一次从表格点开新记录时，Esc 莫名其妙回到一条
 *     早已放弃的旧记录上。
 *   · **关的不是栈顶** = 它被后代替换了，不是用户的意图。典型：在 A 里点关联开 B，
 *     openDrawer 开头那句 closeAllPanels() 会顺手把 A 关掉并回调 onClose。
 *     这时候必须**留着** A —— 它就是 B 的「上一条」。
 */
export function drop(id) {
  if (id == null || id < 0) return false;
  const index = stack.findIndex(item => item.id === id);
  if (index < 0) return false;
  if (index !== stack.length - 1) return false;
  reset();
  return true;
}

export function reset() {
  stack.length = 0;
}

export function depth() {
  return stack.length;
}

export function topEntry() {
  return stack.length ? stack[stack.length - 1] : null;
}

/**
 * 退一层：关掉当前层，重开上一层。
 * @returns {boolean} true = 这一下 Esc 已经被用掉了（调用方不要再关面板）
 */
export function back() {
  if (stack.length < 2) return false;
  const prev = stack[stack.length - 2];
  if (!prev || typeof prev.reopen !== 'function') return false;
  stack.pop(); // 当前层出栈；它的 onClose 随后会再 drop 一次，找不到就是空操作
  restoring = true;
  restoringId = prev.id; // 重开的那一层接管这一条记录
  try {
    closer?.();
    prev.reopen();
  } catch (error) {
    console.warn('[navigation] 回退失败', error);
  } finally {
    restoring = false;
    restoringId = -1;
  }
  return true;
}
