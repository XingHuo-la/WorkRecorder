// 表格上的「直接操作」手势层：填充柄、拖行下缘改行高。
//
// 为什么单独成文件：这两样之前只长在基础表里，空白表没有 —— 因为它们是直接
// 写在 tablePage.js 内部、和那个页面的状态绑死的。两套表格要「只有一套手感」，
// 就必须把「怎么拖」和「拖完改什么」分开：本文件只管前者（DOM、指针、几何），
// 后者由宿主通过钩子给。
//
// 本层不认数据、不写库、不知道行列的意义，只依赖一个约定：
// 单元格带 data-rowindex / data-col，行元素带 class（rowSelector 指定）。

import { fillPlan } from './gridCore.js';

const HANDLE_CLASS = 'gt-fill-handle';
const PREVIEW_CLASS = 'gt-fill-preview';

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * 填充柄：选区右下角的小方块，拖出去按 Excel 规则循环复制。
 *
 * @param {object} opts
 * @param {HTMLElement} opts.root        事件根（表格容器）
 * @param {() => HTMLElement} opts.getScroll 返回定位上下文的滚动容器（手柄绝对定位在它里面）。
 *       必须传函数：表格每次重绘都会换掉这个节点，句柄要每次重新挂上去。
 * @param {string} opts.cellSelector     单元格选择器，如 '.wr-cell'
 * @param {string} opts.tableSelector    表格选择器，用于「拖到表格外」时算边界
 * @param {() => ({r1,r2,c1,c2}|null)} opts.getBounds   当前源矩形（没有选区就返回 null）
 * @param {() => ({rows:number, cols:number})} opts.getCounts
 * @param {() => boolean} [opts.isBlocked] 编辑态等不适用的场景
 * @param {(plan) => any} opts.onFill    松手后拿到填充计划
 * @returns {{reposition: Function, destroy: Function}}
 */
export function mountFillHandle(opts) {
  const {
    root, getScroll, cellSelector, tableSelector,
    getBounds, getCounts, isBlocked = () => false, onFill,
  } = opts;

  if (!root || typeof getScroll !== 'function') return { reposition() {}, destroy() {} };

  const doc = root.ownerDocument || document;
  const handle = doc.createElement('div');
  handle.className = HANDLE_CLASS;
  handle.hidden = true;
  handle.setAttribute('aria-hidden', 'true');
  const preview = doc.createElement('div');
  preview.className = PREVIEW_CLASS;
  preview.hidden = true;
  preview.setAttribute('aria-hidden', 'true');

  let drag = null;

  // 表格重绘会整体换掉 innerHTML，手柄节点跟着没了 —— 每次定位时重新挂一次。
  function ensureMounted() {
    const scroll = getScroll();
    if (!scroll) return null;
    if (handle.parentNode !== scroll) {
      scroll.appendChild(handle);
      scroll.appendChild(preview);
      handle.hidden = true;
      preview.hidden = true;
    }
    return scroll;
  }

  const cellAt = (r, c) => root.querySelector(`${cellSelector}[data-rowindex="${r}"][data-col="${c}"]`);

  function reposition() {
    const scroll = ensureMounted();
    if (!scroll) return;
    const box = getBounds();
    const corner = box ? cellAt(box.r2, box.c2)?.closest('td') : null;
    if (!box || !corner || isBlocked()) {
      handle.hidden = true;
      return;
    }
    const cr = scroll.getBoundingClientRect();
    const tr = corner.getBoundingClientRect();
    handle.hidden = false;
    // -4 = 手柄边长的一半，让它骑在角上（Excel 也是骑在角上的）
    handle.style.left = `${Math.round(tr.right - cr.left + scroll.scrollLeft) - 4}px`;
    handle.style.top = `${Math.round(tr.bottom - cr.top + scroll.scrollTop) - 4}px`;
  }

  function pointAt(x, y) {
    // 命中真实格就信它；命中不到（拖到表格外/边框上）再按方向夹到已有行列边界。
    // Excel 不会因为你拖到末行下面就在数据里长出新行，这里也不长。
    const direct = doc.elementFromPoint(x, y)?.closest?.(cellSelector);
    if (direct && direct.dataset.rowindex != null && direct.dataset.col != null) {
      return { r: Number(direct.dataset.rowindex), c: Number(direct.dataset.col) };
    }
    const table = root.querySelector(tableSelector);
    if (!table || !drag) return null;
    const counts = getCounts();
    const rect = table.getBoundingClientRect();
    const r = y >= rect.bottom ? counts.rows - 1 : y <= rect.top ? 0 : null;
    const c = x >= rect.right ? counts.cols - 1 : x <= rect.left ? 0 : null;
    if (r === null && c === null) return null;
    return { r: r === null ? drag.last.r : r, c: c === null ? drag.last.c : c };
  }

  function paintPreview(box) {
    const scroll = ensureMounted();
    if (!scroll) return;
    const head = box ? cellAt(box.r1, box.c1)?.closest('td') : null;
    const tail = box ? cellAt(box.r2, box.c2)?.closest('td') : null;
    if (!head || !tail) {
      preview.hidden = true;
      return;
    }
    const cr = scroll.getBoundingClientRect();
    const hr = head.getBoundingClientRect();
    const tr = tail.getBoundingClientRect();
    preview.hidden = false;
    preview.style.left = `${Math.round(hr.left - cr.left + scroll.scrollLeft)}px`;
    preview.style.top = `${Math.round(hr.top - cr.top + scroll.scrollTop)}px`;
    preview.style.width = `${Math.round(tr.right - hr.left)}px`;
    preview.style.height = `${Math.round(tr.bottom - hr.top)}px`;
  }

  function onMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const counts = getCounts();
    const point = pointAt(event.clientX, event.clientY) || drag.last;
    drag.last = point;
    const plan = fillPlan(drag.src, point, counts.rows, counts.cols);
    drag.plan = plan;
    // 没扩张时也画框：框停在源矩形上，用户才知道「拖了但不够远」
    paintPreview(plan ? plan.box : drag.src);
  }

  function endDrag(event) {
    doc.removeEventListener('pointermove', onMove);
    doc.removeEventListener('pointerup', onUp);
    doc.removeEventListener('pointercancel', onUp);
    root.classList.remove('is-filling');
    preview.hidden = true;
    handle.hidden = false;
    const state = drag;
    drag = null;
    if (!state || (event && state.pointerId !== event.pointerId)) return null;
    return state;
  }

  function onUp(event) {
    const state = endDrag(event);
    if (!state || !state.plan) {
      reposition();
      return;
    }
    onFill?.(state.plan);
  }

  function onDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest?.(`.${HANDLE_CLASS}`) !== handle) return;
    const box = getBounds();
    if (!box || isBlocked()) return;
    // 不拦的话这一下会顺手把选区清掉、并且开始选文字
    event.preventDefault();
    event.stopPropagation();
    drag = { src: box, last: { r: box.r2, c: box.c2 }, plan: null, pointerId: event.pointerId };
    // 捕获指针能保证拖出窗口也收得到 pointerup；pointerId 不活跃时（合成事件、
    // 指针已释放）会抛 NotFoundError，不该因此中断整个拖拽。
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch (error) {
      /* 拿不到捕获也能靠 document 上的 move/up 走完 */
    }
    root.classList.add('is-filling');
    handle.hidden = true;
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onUp);
  }

  root.addEventListener('pointerdown', onDown);

  return {
    reposition,
    destroy() {
      root.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('pointercancel', onUp);
      handle.remove();
      preview.remove();
    },
  };
}

/**
 * 拖行下缘改行高。双击行下缘交给 onAutoFit。
 *
 * 两个非显然的约束（都是踩出来的）：
 *   1. pointerdown **不能** preventDefault —— 拦掉后浏览器不再补发 mousedown/click，
 *      同一位置的「双击自适应」就永远收不到 dblclick。文字选中靠 .is-row-resizing
 *      的 user-select:none 挡住。
 *   2. 拖完浏览器会补一次 click，落到那一格上会把选区挪走。要用时间窗吞掉，
 *      不能用「等下一次 click 再复位」的布尔量（那次 click 不来就永久挂着，
 *      吞掉后面第一次正常点击）。
 *
 * @param {object} opts
 * @param {HTMLElement} opts.root
 * @param {string} opts.rowSelector     行元素选择器，如 '.wr-table-row'
 * @param {string} opts.cellSelector
 * @param {number} [opts.min] @param {number} [opts.max]
 * @param {() => boolean} [opts.isBlocked]
 * @param {(rowEl, px) => any} opts.onResize  px 为最终高度（已夹在 min..max）
 * @param {(rowEl) => any} [opts.onAutoFit]   双击行下缘
 * @returns {{destroy: Function}}
 */
export function mountRowResizer(opts) {
  const {
    root, rowSelector, cellSelector,
    min = 32, max = 600, isBlocked = () => false,
    onResize, onAutoFit,
  } = opts;

  if (!root) return { destroy() {} };

  const doc = root.ownerDocument || document;
  const EDGE = 5;          // 命中区：行下缘 5px，正好落在单元格内边距里
  const JITTER = 2;        // 手抖容差
  let drag = null;
  let swallowUntil = 0;

  function nearEdge(rowEl, clientY) {
    const rect = rowEl.getBoundingClientRect();
    const gap = rect.bottom - clientY;
    return gap >= -1 && gap <= EDGE;
  }

  function clearEdge() {
    root.querySelectorAll(`${rowSelector}.is-row-edge`).forEach(el => el.classList.remove('is-row-edge'));
  }

  // 光标提示：CSS 没法表达「一行的最下面 5px」，只能靠 JS 挂类。
  // 没有这个提示，用户永远发现不了行下缘可以拖。
  function onHover(event) {
    if (drag || isBlocked()) return;
    const rowEl = event.target.closest?.(rowSelector);
    const onEdge = Boolean(rowEl) && nearEdge(rowEl, event.clientY);
    root.querySelectorAll(`${rowSelector}.is-row-edge`).forEach(el => {
      if (!onEdge || el !== rowEl) el.classList.remove('is-row-edge');
    });
    if (onEdge) rowEl.classList.add('is-row-edge');
  }

  function onMove(event) {
    if (!drag) return;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < JITTER) return;
    drag.moved = true;
    const px = Math.round(clamp(drag.startPx + dy, min, max));
    drag.px = px;
    // 拖动中只改这一行的行内高度，不重绘 —— 重绘会打断正在进行的编辑
    drag.rowEl.style.height = `${px}px`;
    drag.rowEl.classList.add('is-row-sized');
  }

  function onUp() {
    doc.removeEventListener('pointermove', onMove);
    root.classList.remove('is-row-resizing');
    const state = drag;
    drag = null;
    if (!state || !state.moved) return;
    swallowUntil = performance.now() + 400;
    onResize?.(state.rowEl, state.px);
  }

  function onDown(event) {
    if (event.button !== 0) return false;
    const rowEl = event.target.closest?.(rowSelector);
    if (!rowEl || isBlocked() || !nearEdge(rowEl, event.clientY)) return false;
    // 捕获阶段阻断：宿主自己的 pointerdown（列宽抓手等）在冒泡阶段，别让它再跑一遍
    event.stopPropagation();
    drag = { rowEl, startY: event.clientY, startPx: rowEl.getBoundingClientRect().height, px: 0, moved: false };
    root.classList.add('is-row-resizing');
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp, { once: true });
    doc.addEventListener('pointercancel', onUp, { once: true });
    return true;
  }

  function onDblClick(event) {
    const rowEl = event.target.closest?.(rowSelector);
    if (!rowEl || isBlocked() || !nearEdge(rowEl, event.clientY)) return false;
    // 必须阻断：否则宿主的 dblclick 会把这一下当成「双击单元格 → 进编辑」
    event.preventDefault();
    event.stopPropagation();
    onAutoFit?.(rowEl);
    return true;
  }

  function onClick(event) {
    // 刚拖完行高：浏览器补发的那次 click 不该改变选区（只吞 400ms 内的那一次）
    if (swallowUntil && performance.now() < swallowUntil) {
      swallowUntil = 0;
      event.stopPropagation();
      return true;
    }
    return false;
  }

  // pointerdown / dblclick 挂捕获：行下缘和单元格区域重叠，必须先于宿主判断
  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('pointermove', onHover);
  root.addEventListener('pointerleave', clearEdge);
  root.addEventListener('dblclick', onDblClick, true);
  root.addEventListener('click', onClick, true);

  return {
    destroy() {
      root.removeEventListener('pointerdown', onDown, true);
      root.removeEventListener('pointermove', onHover);
      root.removeEventListener('pointerleave', clearEdge);
      root.removeEventListener('dblclick', onDblClick, true);
      root.removeEventListener('click', onClick, true);
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
    },
  };
}
