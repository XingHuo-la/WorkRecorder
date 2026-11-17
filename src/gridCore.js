// 表格交互内核：选区模型 + 键盘意图 + 剪贴板协议。
//
// 为什么要有这一层：项目里有两套表格（tablePage 的 .wr-cell 记录表、
// sheetPage 的 .sh-cell 智能表）。两边 DOM 不同、数据源不同，但「按方向键去哪」
// 「Tab 到行末怎么绕」「从 Excel 粘一块怎么切格子」这些语义必须一致。
// 各写一套的结果是：改一个快捷键要改两处，而且两边很快会漂移成两种手感。
//
// 这一层的边界：
//   ✅ 选区状态、键盘意图解析、TSV 双向编解码、边界计算
//   ❌ 不碰 DOM、不碰数据库、不管渲染 —— 宿主通过 adapter 提供
//
// 宿主接入只需实现 adapter 的 6 个方法（见 createGrid 注释），其余全是共用逻辑。

// ==========================================
// 一、TSV 编解码（与 Excel / WPS 互通的唯一格式）
// ==========================================

// Excel 的转义规则：格子内含 \t \n \r " 时，整格用双引号包起来，内部引号翻倍。
// 不按这个规则写，粘到 Excel 里会错列；按这个规则写，Excel 粘回来也能正确还原。
function escapeCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[\t\n\r"]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * 二维数组 → TSV 文本。
 * @param {Array<Array<any>>} matrix
 * @returns {string}
 */
export function serializeTSV(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) return '';
  return matrix.map(row => (Array.isArray(row) ? row : []).map(escapeCell).join('\t')).join('\n');
}

/**
 * TSV 文本 → 二维数组。逐字符状态机，不能按行 split ——
 * 带引号的单元格内部可以含换行，一 split 就错行。
 * @param {string} text
 * @returns {Array<Array<string>>}
 */
export function parseTSV(text) {
  const source = String(text ?? '');
  if (!source) return [];

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let i = 0;

  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };

  while (i < source.length) {
    const ch = source[i];

    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && cell === '') { quoted = true; i += 1; continue; }
    if (ch === '\t') { pushCell(); i += 1; continue; }
    if (ch === '\r') {
      // CRLF 与单独的 CR 都当换行；\r\n 只算一次
      if (source[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') { pushRow(); i += 1; continue; }

    cell += ch;
    i += 1;
  }

  // 结尾没有换行时，最后一行还在缓冲里
  if (cell !== '' || row.length) pushRow();

  // 纯空文本会产出一个 [''] 的空行，滤掉
  const cleaned = rows.filter(r => !(r.length === 1 && r[0] === ''));
  return cleaned;
}

// ==========================================
// 二、选区模型
// ==========================================

/**
 * 选区。三种形态共存：
 *   · 矩形选区 = anchor + focus（一个坐标对，不展开成集合，大表也不卡）
 *   · 离散选区 = extras（Ctrl 点出来的单格）
 *   · 整行/整列 = mode（由宿主判定行列范围）
 */
export function createSelection() {
  let mode = 'none'; // none | cell | range | rows | cols | all
  let anchor = null; // { r, c }
  let focus = null;  // { r, c }
  const extras = new Set(); // "r:c"

  const key = (r, c) => `${r}:${c}`;

  function bounds() {
    if (!anchor || !focus) return null;
    const r1 = Math.min(anchor.r, focus.r);
    const r2 = Math.max(anchor.r, focus.r);
    const c1 = Math.min(anchor.c, focus.c);
    const c2 = Math.max(anchor.c, focus.c);
    return { r1, r2, c1, c2 };
  }

  function clear() {
    mode = 'none';
    anchor = null;
    focus = null;
    extras.clear();
  }

  /** 单选：普通点击。 */
  function select(r, c) {
    clear();
    mode = 'cell';
    anchor = { r, c };
    focus = { r, c };
    return snapshot();
  }

  /** Shift 扩展：保持 anchor，只动 focus。 */
  function extendTo(r, c) {
    if (!anchor) return select(r, c);
    focus = { r, c };
    mode = anchor.r === r && anchor.c === c ? 'cell' : 'range';
    return snapshot();
  }

  /** Ctrl 点：加/减一格（不拉矩形）。 */
  function toggle(r, c) {
    const k = key(r, c);
    if (extras.has(k)) extras.delete(k);
    else extras.add(k);
    if (!anchor) { anchor = { r, c }; focus = { r, c }; }
    mode = extras.size || anchor ? 'cell' : 'none';
    return snapshot();
  }

  function setMode(next) {
    mode = next;
    return snapshot();
  }

  /** 把选区摊平成 {r,c} 列表。只在大表且真需要逐格处理时调。 */
  function cells() {
    const list = [];
    const box = bounds();
    if (box) {
      for (let r = box.r1; r <= box.r2; r += 1) {
        for (let c = box.c1; c <= box.c2; c += 1) list.push({ r, c });
      }
    }
    extras.forEach(k => {
      const [r, c] = k.split(':').map(Number);
      if (!box || r < box.r1 || r > box.r2 || c < box.c1 || c > box.c2) list.push({ r, c });
    });
    return list;
  }

  function size() {
    const box = bounds();
    // 矩形按面积算，不展开成集合 —— 1000 行 × 20 列的表全选时，
    // 逐格生成对象会把一次 Ctrl+A 变成两万次分配。
    let total = box ? (box.r2 - box.r1 + 1) * (box.c2 - box.c1 + 1) : 0;
    if (extras.size) {
      extras.forEach(k => {
        const [r, c] = k.split(':').map(Number);
        const inside = box && r >= box.r1 && r <= box.r2 && c >= box.c1 && c <= box.c2;
        if (!inside) total += 1;
      });
    }
    return total;
  }

  function contains(r, c) {
    const box = bounds();
    if (box && r >= box.r1 && r <= box.r2 && c >= box.c1 && c <= box.c2) return true;
    return extras.has(key(r, c));
  }

  function snapshot() {
    return {
      mode,
      anchor: anchor ? { ...anchor } : null,
      focus: focus ? { ...focus } : null,
      bounds: bounds(),
      size: size(),
      extras: [...extras],
    };
  }

  /** 当前活动格（键盘操作的落点）。整行/整列模式下仍取 anchor。 */
  function active() {
    return anchor ? { ...anchor } : null;
  }

  return { clear, select, extendTo, toggle, setMode, cells, size, contains, snapshot, active, bounds };
}

// ==========================================
// 三、键盘意图
// ==========================================

const ARROWS = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/**
 * 把 keydown 翻译成意图。纯函数，不碰 DOM，便于单测。
 *
 * @param {KeyboardEvent|object} event  需有 key / ctrlKey / metaKey / shiftKey / altKey / isComposing
 * @param {{editing?: boolean, multiline?: boolean, pageSize?: number}} [ctx]
 * @returns {{type: string, [k: string]: any}}
 *   type: none | move | jump | edit | commit | cancel | clear | clearSelection
 *       | copy | cut | paste | selectAll | undo | redo | type | appendRow
 */
export function resolveKeyIntent(event, ctx = {}) {
  if (!event) return { type: 'none' };

  // 中文输入法：拼音候选状态下的方向键/回车属于 IME，表格一律让行。
  // 漏了这一条，打「zhong」按 ↓ 选字时表格会跳格 —— 同类表格最高频的线上 bug。
  if (event.isComposing || event.keyCode === 229) return { type: 'none', reason: 'ime' };

  const key = event.key;
  const mod = event.ctrlKey || event.metaKey;
  const shift = event.shiftKey;
  const alt = event.altKey;
  const pageSize = Math.max(1, Number(ctx.pageSize) || 10);

  // ---- 编辑态：只关心「怎么退出编辑」 ----
  if (ctx.editing) {
    if (key === 'Escape') return { type: 'cancel' };
    if (key === 'Enter' && alt) return { type: 'none', reason: 'newline' }; // Alt+Enter 交给多行控件
    if (key === 'Enter') return { type: 'commit', dr: shift ? -1 : 1, dc: 0 };
    if (key === 'Tab') return { type: 'commit', dr: 0, dc: shift ? -1 : 1, wrap: true };
    return { type: 'none', reason: 'typing' };
  }

  // ---- 未编辑态 ----
  if (mod) {
    const lower = String(key).toLowerCase();
    if (lower === 'c') return { type: 'copy' };
    if (lower === 'x') return { type: 'cut' };
    if (lower === 'v') return { type: 'paste' };
    if (lower === 'a') return { type: 'selectAll' };
    if (lower === 'z') return { type: shift ? 'redo' : 'undo' };
    if (lower === 'y') return { type: 'redo' };
    if (key === 'Home') return { type: 'move', to: 'tableStart', extend: shift };
    if (key === 'End') return { type: 'move', to: 'tableEnd', extend: shift };
  }

  if (ARROWS[key]) {
    const [dr, dc] = ARROWS[key];
    // Ctrl+方向 = 跳到数据区边界（Excel 语义），不是普通一格
    if (mod) return { type: 'jump', dr, dc, extend: shift };
    return { type: 'move', dr, dc, extend: shift };
  }

  if (key === 'Tab') return { type: 'move', dr: 0, dc: shift ? -1 : 1, wrap: true, extend: false };
  if (key === 'Enter') return { type: 'edit', dr: shift ? -1 : 1 };
  if (key === 'F2') return { type: 'edit', dr: 0 };
  if (key === 'Delete' || key === 'Backspace') return { type: 'clear' };
  if (key === 'Home') return { type: 'move', to: 'rowStart', extend: shift };
  if (key === 'End') return { type: 'move', to: 'rowEnd', extend: shift };
  if (key === 'PageDown') return { type: 'move', dr: pageSize, dc: 0, extend: shift };
  if (key === 'PageUp') return { type: 'move', dr: -pageSize, dc: 0, extend: shift };
  if (key === 'Escape') return { type: 'clearSelection' };

  // 可打印字符 → 进编辑并覆盖（Excel 的「直接敲字」）
  if (key && key.length === 1 && !mod && !alt) return { type: 'type', char: key };

  return { type: 'none' };
}

// ==========================================
// 四、坐标运算
// ==========================================

/** 把坐标夹在 [0, max-1] 内。行/列数是 0 时返回 0。 */
export function clampIndex(value, max) {
  if (!Number.isFinite(value) || max <= 0) return 0;
  return Math.max(0, Math.min(max - 1, Math.trunc(value)));
}

/**
 * Tab 换行：到末列绕到下一行首列，到首列（Shift+Tab）绕到上一行末列。
 * 越界时返回 null，由宿主决定是新建一行还是停住。
 */
export function wrapColumn(next, colCount, rowCount) {
  const { r, c } = next;
  if (c >= 0 && c < colCount) return { r: clampIndex(r, rowCount), c };
  if (c >= colCount) {
    const nr = r + 1;
    if (nr >= rowCount) return null;
    return { r: nr, c: 0 };
  }
  const pr = r - 1;
  if (pr < 0) return null;
  return { r: pr, c: Math.max(0, colCount - 1) };
}

/**
 * Ctrl+方向跳边界：沿方向跳过「相同值」的连续格，停在值变化处。
 * 表格里最有用的是跳过一片空白 —— 和 Excel 一致。
 *
 * @param {{r:number,c:number}} from
 * @param {number} dr
 * @param {number} dc
 * @param {(r:number,c:number)=>boolean} isEmpty
 * @param {number} rowCount
 * @param {number} colCount
 */
export function jumpToEdge(from, dr, dc, isEmpty, rowCount, colCount) {
  let { r, c } = from;
  const step = (rr, cc) => {
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nr >= rowCount || nc < 0 || nc >= colCount) return false;
    r = nr;
    c = nc;
    return true;
  };

  const startEmpty = isEmpty(r, c);
  let moved = false;
  while (step()) {
    moved = true;
    const nowEmpty = isEmpty(r, c);
    if (nowEmpty !== startEmpty) {
      // 从空白进入数据区：停在第一个有值的格子
      // 从数据区进入空白：停在最后一个有值的格子（回退一步）
      if (!startEmpty) { r -= dr; c -= dc; }
      break;
    }
  }
  if (!moved) return from;
  return { r, c };
}

// ==========================================
// 五、网格控制器
// ==========================================

/**
 * 把选区 + 键盘 + 剪贴板串成一个可用的控制器。宿主只需实现 adapter。
 *
 * adapter 契约（全部同步或返回 Promise 均可，本模块不关心落库）：
 *   rowCount()                    → number
 *   colCount()                    → number
 *   isEditing()                   → boolean           当前是否在编辑
 *   isEmpty(r, c)                 → boolean           供 Ctrl+方向跳边界
 *   focus(r, c)                   → void              把键盘焦点/高亮移到该格
 *   onSelection(snapshot)         → void              选区变化后重绘
 *   onEditStart(r, c, { char })   → void              char 有值时是「直接敲字覆盖」
 *   onEditCommit(prev, next)      → void              next 为移动后的落点（可 null）
 *   onEditCancel()                → void
 *   onClear(cells)                → void
 *   onCopy(matrix, { cut })       → void              宿主写系统/内部剪贴板
 *   onPaste(r, c, matrix)         → void
 *   onUndo() / onRedo()           → void
 *   onSelectAll()                 → void
 *   appendRow()                   → boolean           行末 Tab 时是否补一行
 */
export function createGrid(adapter) {
  const sel = createSelection();
  let editing = false;

  const rows = () => Math.max(0, Number(adapter.rowCount?.()) || 0);
  const cols = () => Math.max(0, Number(adapter.colCount?.()) || 0);

  function emit() {
    adapter.onSelection?.(sel.snapshot());
  }

  function moveTo(next, extend) {
    if (!next) return;
    const rowCount = rows();
    const colCount = cols();
    if (!rowCount || !colCount) return;
    const target = { r: clampIndex(next.r, rowCount), c: clampIndex(next.c, colCount) };
    if (extend) sel.extendTo(target.r, target.c);
    else sel.select(target.r, target.c);
    adapter.focus?.(target.r, target.c);
    emit();
  }

  // Shift+方向键的起点是**当前焦点**，不是 anchor。
  // 用 anchor 当起点的话，「Shift+→ 再 Shift+↓」会退化成单选一列两格（anchor 原地不动），
  // 而 Excel 的语义是从焦点继续长，得到 2×2 的块。
  function moveStart(extend) {
    if (extend) {
      const snap = sel.snapshot();
      if (snap.focus) return snap.focus;
    }
    return sel.active() || { r: 0, c: 0 };
  }

  function move(dr, dc, extend, wrap = false) {
    const from = moveStart(extend);
    let next = { r: from.r + dr, c: from.c + dc };

    if (wrap && dc !== 0) {
      const wrapped = wrapColumn(next, cols(), rows());
      if (!wrapped) {
        // 行末 Tab 到最后一行：补一行再落进去，这是 Excel 的手感
        if (dc > 0 && adapter.appendRow?.()) {
          moveTo({ r: rows() - 1, c: 0 }, false);
        }
        return;
      }
      next = wrapped;
    }

    moveTo(next, extend);
  }

  function jump(dr, dc, extend) {
    const from = moveStart(extend);
    const target = jumpToEdge(
      from, dr, dc,
      (r, c) => adapter.isEmpty?.(r, c) !== false,
      rows(), cols(),
    );
    moveTo(target, extend);
  }

  function moveEdge(to, extend) {
    const rowCount = rows();
    const colCount = cols();
    const from = sel.active() || { r: 0, c: 0 };
    let next = from;
    if (to === 'tableStart') next = { r: 0, c: 0 };
    if (to === 'tableEnd') next = { r: rowCount - 1, c: colCount - 1 };
    if (to === 'rowStart') next = { r: from.r, c: 0 };
    if (to === 'rowEnd') next = { r: from.r, c: colCount - 1 };
    moveTo(next, extend);
  }

  function selectedMatrix() {
    if (sel.size() === 0) return [];
    const box = sel.bounds();
    if (!box) return [];
    const matrix = [];
    for (let r = box.r1; r <= box.r2; r += 1) {
      const line = [];
      for (let c = box.c1; c <= box.c2; c += 1) line.push(adapter.readValue?.(r, c) ?? '');
      matrix.push(line);
    }
    return matrix;
  }

  /**
   * 处理一次 keydown。返回 true 表示已消费（宿主应 preventDefault）。
   */
  function handleKeydown(event) {
    const intent = resolveKeyIntent(event, {
      editing: editing || adapter.isEditing?.() === true,
      pageSize: adapter.pageSize?.(),
    });

    switch (intent.type) {
      case 'move':
        if (intent.to) moveEdge(intent.to, intent.extend);
        else move(intent.dr, intent.dc, intent.extend, intent.wrap);
        return true;
      case 'jump':
        jump(intent.dr, intent.dc, intent.extend);
        return true;
      case 'edit': {
        const at = sel.active();
        if (!at) return false;
        adapter.onEditStart?.(at.r, at.c, {});
        return true;
      }
      case 'type': {
        const at = sel.active();
        if (!at) return false;
        adapter.onEditStart?.(at.r, at.c, { char: intent.char });
        return true;
      }
      case 'commit':
        adapter.onEditCommit?.(sel.active(), nextAfterCommit(intent.dr, intent.dc, intent.wrap));
        return true;
      case 'cancel':
        adapter.onEditCancel?.();
        return true;
      case 'clear': {
        const cells = sel.cells();
        if (!cells.length) return false;
        adapter.onClear?.(cells);
        return true;
      }
      case 'clearSelection':
        sel.clear();
        emit();
        return true;
      case 'copy':
      case 'cut': {
        const matrix = selectedMatrix();
        if (!matrix.length) return false;
        adapter.onCopy?.(matrix, { cut: intent.type === 'cut' });
        return true;
      }
      case 'paste':
        adapter.onPasteRequest?.();
        return true;
      case 'selectAll':
        adapter.onSelectAll?.();
        return true;
      case 'undo':
        adapter.onUndo?.();
        return true;
      case 'redo':
        adapter.onRedo?.();
        return true;
      default:
        return false;
    }
  }

  function nextAfterCommit(dr, dc, wrap) {
    const from = sel.active();
    if (!from || (!dr && !dc)) return null;
    let next = { r: from.r + dr, c: from.c + dc };
    if (wrap && dc !== 0) next = wrapColumn(next, cols(), rows()) || null;
    const rowCount = rows();
    const colCount = cols();
    if (!next || next.r < 0 || next.r >= rowCount || next.c < 0 || next.c >= colCount) return null;
    return next;
  }

  /** 宿主进入/离开编辑态时通知内核，键盘语义随之切换。 */
  function setEditing(next) { editing = Boolean(next); }

  return {
    sel,
    handleKeydown,
    setEditing,
    /** 提交后由宿主主动移动光标（编辑器的 Enter 由它自己处理，移动由这里补）。 */
    move: (dr, dc, wrap = false) => move(dr, dc, false, wrap),
    moveTo: (r, c, extend = false) => moveTo({ r, c }, extend),
    select: (r, c, opts = {}) => {
      if (opts.extend) sel.extendTo(r, c);
      else if (opts.additive) sel.toggle(r, c);
      else sel.select(r, c);
      adapter.focus?.(r, c);
      emit();
      return sel.snapshot();
    },
    clearSelection: () => { sel.clear(); emit(); },
    snapshot: () => sel.snapshot(),
    selectedMatrix,
  };
}
