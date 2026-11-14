// 白板视图（board）—— 一条记录的第三种看法。
//
// 为什么便签就是 record，而不是另一套「白板文档」：
//   ① 应用的地基是「record 是唯一真相，表格 / 时间流 / 详情是它的几种看法」。
//      白板如果自带一套数据，就变成第二个系统，同一条想法要在两处各存一份。
//   ② 便签天然就是最小的一条记录：一句话 + 状态 + 分类。它不需要新表。
//   ③ 布局是**看法**，不是数据：x / y / w / h / c 存在 record.custom._bd。
//      custom 本来就是 JSON 列，**零迁移**；没有 _bd 的记录按网格自动排。
//   ④ 连线是「这条记录指向那条」，存源便签的 custom._bd.links（id 数组）。
//      目标被删时连线自然悬空 —— 渲染时按现存 id 过滤，不留死线、不报错。
//
// 数据通道注入（与 sheetStore / recordStore 一致）：
//   setBoardAdapter({ dbQuery, dbExecute })，main.js 传严格版。
//   写操作一律走 recordStore.patchRecord —— 可空列 / custom 序列化都在那层兜住了。

import { patchRecord, createRecord, deleteRecord } from './recordStore.js';
import { openRowDrawer } from './rowDrawer.js';
import { escapeHtml } from './htmlUtils.js';
import { logToFile } from './logger.js';

/* ───────────── 常量 ───────────── */

// whiteboard.html 的 6 色便签。**刻意不跟主题走**：
// 便签是纸，纸的颜色不该因为换了深色主题而变成另一种纸。
const NOTE_COLORS = ['#FFE790', '#B9EDCF', '#B8DBFB', '#FBC3CE', '#DCCEFB', '#FBC8A0'];
const NOTE_INK = '#1e293b';

// 状态点：与表格里「圆点 + 文字」同一套语义
const STATUS_DOT = {
  inbox: '#f59e0b',
  pending: '#94a3b8',
  doing: '#2563eb',
  done: '#16a34a',
  processed: '#16a34a',
};
const STATUS_TEXT = {
  inbox: '待整理',
  pending: '待开始',
  doing: '进行中',
  done: '已完成',
  processed: '已完成',
};

const DEFAULT_W = 208;
const DEFAULT_H = 128;
const MIN_W = 148;
const MIN_H = 96;
const Z_MIN = 0.3;
const Z_MAX = 2.4;

// 自动布局（没有 _bd 的记录）。列数乘间距必须大于 DEFAULT_W，否则便签会叠。
const AUTO_ORIGIN = 44;
const AUTO_COLS = 4;
const AUTO_STEP_X = 236;
const AUTO_STEP_Y = 176;

/* ───────────── 数据通道 ───────────── */

let adapter = null;

export function setBoardAdapter(next) {
  adapter = next;
}

function db() {
  if (!adapter) throw new Error('白板数据通道未就绪');
  return adapter;
}

/* ───────────── 运行时状态 ───────────── */

const state = {
  /** @type {Array<{id:number,title:string,status:string,kind:string,tag:string,
   *                c:number,x:number,y:number,w:number,h:number,
   *                hasPos:boolean,links:number[],custom:object}>} */
  notes: [],
  edges: [],
  sel: new Set(),
  tool: 'select',
  editing: null,
  view: { x: 0, y: 0, z: 1 },
  ready: false,
  loading: false,
  /** @type {Map<number, {x:number,y:number,w:number,h:number,c:number}>} */
  dirty: new Map(),
};

let dom = null;
let flushTimer = 0;
let saveTimer = 0;
let marqueeState = null;
let connectState = null;
let dragState = null;

/* ───────────── 小工具 ───────────── */

function safeParse(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 把 custom._bd 读成布局；没有就是 null（判定「从未摆过」）。 */
function readLayout(custom) {
  const raw = custom && typeof custom === 'object' ? custom._bd : null;
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x,
    y,
    w: Number.isFinite(Number(raw.w)) ? Math.max(MIN_W, Number(raw.w)) : DEFAULT_W,
    h: Number.isFinite(Number(raw.h)) ? Math.max(MIN_H, Number(raw.h)) : DEFAULT_H,
    c: clamp(Math.trunc(Number(raw.c) || 0), 0, NOTE_COLORS.length - 1),
  };
}

/** custom._bd.links 读成 id 数组（只认正整数）。 */
function readLinks(custom) {
  const raw = custom && typeof custom === 'object' ? custom._bd : null;
  const list = raw && Array.isArray(raw.links) ? raw.links : [];
  return list.map(v => Math.trunc(Number(v))).filter(v => Number.isFinite(v) && v > 0);
}

/* ───────────── 加载 ───────────── */

/**
 * 取白板上的记录。
 *
 * 范围刻意定成「没被任何表接管的工作记录」：
 *   sheet_id IS NULL   —— 已经进了表格的行，它的位置由表格决定，不该同时出现在画布上
 *   kind IN (log,todo) —— 便签是工作项；笔记是长文（走 .md），不铺在画布上
 *   LIMIT 400          —— 画布是「摊在桌上的一批」，不是全库浏览器
 *
 * 已完成的记录也上来（灰一点），因为回顾时它们构成上下文。
 */
async function fetchNotes() {
  const rows = await db().dbQuery(
    `SELECT id, kind, title, body, status, tag, sub_tag, happened_date, custom
       FROM record
      WHERE sheet_id IS NULL
        AND kind IN ('log', 'todo')
      ORDER BY
        CASE status WHEN 'doing' THEN 0 WHEN 'pending' THEN 1 WHEN 'inbox' THEN 2 ELSE 3 END,
        updated_at DESC, id DESC
      LIMIT 400`
  );
  return (rows || []).map(row => {
    const custom = safeParse(row.custom, {});
    const layout = readLayout(custom);
    return {
      id: Number(row.id),
      kind: String(row.kind || 'log'),
      title: String(row.title ?? ''),
      status: String(row.status ?? ''),
      tag: String(row.tag ?? ''),
      c: layout ? layout.c : 0,
      x: layout ? layout.x : 0,
      y: layout ? layout.y : 0,
      w: layout ? layout.w : DEFAULT_W,
      h: layout ? layout.h : DEFAULT_H,
      hasPos: Boolean(layout),
      links: readLinks(custom),
      custom,
    };
  });
}

/**
 * 没有坐标的记录按网格排：4 列，**从已占位便签的下方开始**。
 *
 * 第一版是从 (44,44) 起排，结果自动排的便签直接压在用户摆好的便签上 ——
 * 一眼看过去像渲染错乱，实际是两套坐标系撞了。画布上「已经摆好的」是用户的
 * 决定，不能覆盖；自动排的只能占用它之外的空间。
 */
function applyAutoLayout(notes) {
  const placed = notes.filter(note => note.hasPos);
  let startY = AUTO_ORIGIN;
  if (placed.length) {
    startY = Math.max(...placed.map(note => note.y + note.h)) + 44;
  }

  let slot = 0;
  notes.forEach(note => {
    if (note.hasPos) return;
    note.x = AUTO_ORIGIN + (slot % AUTO_COLS) * AUTO_STEP_X;
    note.y = startY + Math.floor(slot / AUTO_COLS) * AUTO_STEP_Y;
    slot += 1;
  });
}

/* ───────────── 渲染 ───────────── */

function mountDom() {
  if (dom) return dom;
  const stage = document.getElementById('bd-stage');
  const layer = document.getElementById('bd-node-layer');
  if (!stage || !layer) return null;
  dom = {
    view: document.getElementById('subview-board'),
    stage,
    layer,
    edgeLayer: document.getElementById('bd-edge-layer'),
    tempLayer: document.getElementById('bd-temp-layer'),
    marquee: document.getElementById('bd-marquee'),
    empty: document.getElementById('bd-empty'),
    hint: document.getElementById('bd-hint-text'),
    zoomLabel: document.getElementById('bd-zoom-label'),
    saveBox: document.getElementById('bd-save'),
    saveText: document.getElementById('bd-save-text'),
    menu: document.getElementById('bd-menu'),
    elById: new Map(),
  };
  return dom;
}

function noteStyle(note) {
  return `left:${note.x}px;top:${note.y}px;width:${note.w}px;height:${note.h}px;` +
    `--bd-note-bg:${NOTE_COLORS[note.c]};--bd-ink:${NOTE_INK};`;
}

function noteHtml(note) {
  const dot = STATUS_DOT[note.status] || STATUS_DOT.pending;
  const statusText = STATUS_TEXT[note.status] || '';
  const meta = [note.tag, statusText].filter(Boolean).join(' · ');
  return `<div class="bd-note" data-id="${note.id}" style="${noteStyle(note)}">
    <div class="bd-note-head"><span class="bd-note-dot" style="background:${dot}"></span>${escapeHtml(meta || '未分类')}</div>
    <div class="bd-note-body" data-ph="双击写一句"></div>
    <div class="bd-note-foot"><span>#${note.id}</span></div>
    <div class="bd-handle nw" data-dir="nw"></div>
    <div class="bd-handle ne" data-dir="ne"></div>
    <div class="bd-handle sw" data-dir="sw"></div>
    <div class="bd-handle se" data-dir="se"></div>
  </div>`;
}

/**
 * 全量重建。≤400 条、单次 innerHTML —— 比增量 diff 简单，实测够快；
 * 拖拽过程中只改那一条的 style，不重建。
 */
function renderNotes() {
  if (!dom) return;
  const html = state.notes.map(noteHtml).join('');
  dom.layer.innerHTML = html;
  dom.elById.clear();

  state.notes.forEach(note => {
    const el = dom.layer.querySelector(`.bd-note[data-id="${note.id}"]`);
    if (!el) return;
    const body = el.querySelector('.bd-note-body');
    body.textContent = note.title || '';
    dom.elById.set(note.id, el);
    bindNote(note, el);
    if (note.status === 'done' || note.status === 'processed') el.style.opacity = '.58';
  });

  if (dom.empty) dom.empty.style.display = state.notes.length ? 'none' : '';
  applySelection();
}

function applySelection() {
  if (!dom) return;
  state.notes.forEach(note => {
    const el = dom.elById.get(note.id);
    if (!el) return;
    const on = state.sel.has(note.id);
    el.classList.toggle('selected', on);
    el.classList.toggle('single', on && state.sel.size === 1);
  });
}

function applyView() {
  if (!dom) return;
  const { x, y, z } = state.view;
  dom.layer.style.transform = `translate(${x}px,${y}px) scale(${z})`;
  const t = `translate(${x} ${y}) scale(${z})`;
  dom.edgeLayer?.setAttribute('transform', t);
  dom.tempLayer?.setAttribute('transform', t);
  if (dom.zoomLabel) dom.zoomLabel.textContent = `${Math.round(z * 100)}%`;
}

/* ───────────── 视图变换 ───────────── */

function stagePoint(e) {
  const r = dom.stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function toWorld(p) {
  return { x: (p.x - state.view.x) / state.view.z, y: (p.y - state.view.y) / state.view.z };
}

function toScreen(x, y) {
  return { x: x * state.view.z + state.view.x, y: y * state.view.z + state.view.y };
}

function zoomAt(sx, sy, factor) {
  const z0 = state.view.z;
  const z1 = clamp(z0 * factor, Z_MIN, Z_MAX);
  if (Math.abs(z1 - z0) < 1e-6) return;
  const w = toWorld({ x: sx, y: sy });
  state.view.z = z1;
  state.view.x = sx - w.x * z1;
  state.view.y = sy - w.y * z1;
  applyView();
}

/** 适应内容：把所有便签装进视口。空板则回到左上角 100%。 */
function fitView() {
  if (!dom) return;
  const r = dom.stage.getBoundingClientRect();
  if (!state.notes.length) {
    state.view = { x: 0, y: 0, z: 1 };
    applyView();
    return;
  }
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  state.notes.forEach(note => {
    x1 = Math.min(x1, note.x); y1 = Math.min(y1, note.y);
    x2 = Math.max(x2, note.x + note.w); y2 = Math.max(y2, note.y + note.h);
  });
  const pad = 48;
  const z = clamp(Math.min(
    (r.width - pad * 2) / Math.max(1, x2 - x1),
    (r.height - pad * 2) / Math.max(1, y2 - y1)
  ), 0.35, 1.1);
  state.view.z = z;
  state.view.x = r.width / 2 - ((x1 + x2) / 2) * z;
  state.view.y = r.height / 2 - ((y1 + y2) / 2) * z;
  applyView();
}

/* ───────────── 连线 ───────────── */

function rectOf(note) {
  return { x: note.x, y: note.y, w: note.w, h: note.h };
}

/** 四个边：0 上 1 右 2 下 3 左；off 是沿边的切向偏移。 */
function sidePoint(r, i, off) {
  if (i === 0) return { x: r.x + r.w / 2 + off, y: r.y, nx: 0, ny: -1 };
  if (i === 1) return { x: r.x + r.w, y: r.y + r.h / 2 + off, nx: 1, ny: 0 };
  if (i === 2) return { x: r.x + r.w / 2 + off, y: r.y + r.h, nx: 0, ny: 1 };
  return { x: r.x, y: r.y + r.h / 2 + off, nx: -1, ny: 0 };
}

function sideLen(r, i) {
  return (i === 0 || i === 2) ? r.w : r.h;
}

/** 先选出最短的两条边，再把共用同一条边的端点均匀错开 —— 否则多条线会重合。 */
function planEdges() {
  const byId = new Map(state.notes.map(n => [n.id, n]));
  const plan = [];
  state.edges.forEach(edge => {
    const A = byId.get(edge.from);
    const B = byId.get(edge.to);
    if (!A || !B) return;
    const ra = rectOf(A); const rb = rectOf(B);
    let best = null;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const p = sidePoint(ra, i, 0);
        const q = sidePoint(rb, j, 0);
        const d2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (!best || d2 < best.d2) best = { i, j, d2 };
      }
    }
    plan.push({ edge, ra, rb, i: best.i, j: best.j, offA: 0, offB: 0, A, B });
  });

  const groups = new Map();
  plan.forEach(pl => {
    const ka = `${pl.A.id}|${pl.i}`;
    const kb = `${pl.B.id}|${pl.j}`;
    if (!groups.has(ka)) groups.set(ka, []);
    if (!groups.has(kb)) groups.set(kb, []);
    groups.get(ka).push(pl);
    groups.get(kb).push(pl);
  });
  groups.forEach((list, key) => {
    const [nid, si] = key.split('|');
    const id = Number(nid);
    const side = Number(si);
    const note = byId.get(id);
    if (!note) return;
    const len = sideLen(rectOf(note), side);
    const count = list.length;
    const step = Math.min(26, Math.max(0, len - 30) / Math.max(1, count));
    list.forEach((pl, k) => {
      const off = (k - (count - 1) / 2) * step;
      if (pl.A.id === id && pl.i === side) pl.offA = off;
      if (pl.B.id === id && pl.j === side) pl.offB = off;
    });
  });

  plan.forEach(pl => {
    pl.p = sidePoint(pl.ra, pl.i, pl.offA);
    pl.q = sidePoint(pl.rb, pl.j, pl.offB);
  });
  return plan;
}

function renderEdges() {
  if (!dom) return;
  const plan = planEdges();
  const parts = [];
  plan.forEach(pl => {
    const p = pl.p; const q = pl.q;
    const dist = Math.hypot(q.x - p.x, q.y - p.y);
    const k = clamp(dist * 0.4, 36, 170);
    const c1 = { x: p.x + p.nx * k, y: p.y + p.ny * k };
    const c2 = { x: q.x + q.nx * k, y: q.y + q.ny * k };
    const d = `M${p.x},${p.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${q.x},${q.y}`;

    // 箭头按「进入边」的法线反向，不是按曲线末端切线 —— 后者在短距离时指向会偏
    const size = 8;
    const half = 3.6;
    const bx = q.x - q.nx * size;
    const by = q.y - q.ny * size;
    const px = -q.ny;
    const py = q.nx;
    const arrow = `M${q.x},${q.y} L${bx + px * half},${by + py * half} L${bx - px * half},${by - py * half} Z`;

    parts.push(`<g class="bd-edge" data-from="${pl.edge.from}" data-to="${pl.edge.to}">
      <path class="bd-edge-hit" d="${d}"/>
      <path class="bd-edge-line" d="${d}"/>
      <path class="bd-edge-arrow" d="${arrow}"/>
    </g>`);
  });
  dom.edgeLayer.innerHTML = parts.join('');
  updateEmptyState();
}

function rebuildEdges() {
  const alive = new Set(state.notes.map(n => n.id));
  const edges = [];
  const seen = new Set();
  state.notes.forEach(note => {
    note.links.forEach(to => {
      if (!alive.has(to) || to === note.id) return;
      const key = `${note.id}>${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from: note.id, to });
    });
  });
  state.edges = edges;
}

/* ───────────── 保存 ───────────── */

function flashSaved() {
  if (!dom?.saveBox) return;
  dom.saveBox.classList.add('busy');
  if (dom.saveText) dom.saveText.textContent = '保存中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    dom.saveBox?.classList.remove('busy');
    if (dom.saveText) dom.saveText.textContent = '已同步';
  }, 520);
}

function markDirty(note) {
  state.dirty.set(note.id, { x: note.x, y: note.y, w: note.w, h: note.h, c: note.c });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { void flushDirty(); }, 420);
}

/**
 * 落库。**一条一次 UPDATE**，不用多行写：
 * custom 是整列覆写，批量写需要先把每个人的旧 custom 拼回去，
 * 拼错一次就会把用户别的字段抹掉 —— 这个风险不值得省那几次往返。
 * 失败必须抛到日志，不能静默（否则就是「拖完好看，重开没了」）。
 */
async function flushDirty() {
  if (!state.dirty.size) return;
  const batch = [...state.dirty.entries()];
  state.dirty.clear();
  flashSaved();

  for (const [id, pos] of batch) {
    const note = state.notes.find(n => n.id === id);
    if (!note) continue;
    const nextCustom = { ...(note.custom || {}) };
    nextCustom._bd = {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      w: Math.round(pos.w),
      h: Math.round(pos.h),
      c: Math.round(pos.c),
      ...(note.links.length ? { links: note.links } : {}),
    };
    try {
      await patchRecord(id, { custom: nextCustom });
      note.custom = nextCustom;
      note.hasPos = true;
    } catch (error) {
      logToFile('error', `[board] 保存便签 #${id} 失败: ${error?.stack || error}`);
      if (dom?.saveBox) {
        dom.saveBox.classList.remove('busy');
        if (dom.saveText) dom.saveText.textContent = '保存失败';
      }
    }
  }
}

function updateEmptyState() {
  if (!dom?.empty) return;
  const show = state.notes.length === 0 && !state.loading;
  // 显式写 'flex'：样式层刻意不给 .bd-empty 写 display，
  // 否则 !important 会压掉 inline 的 'none'，空态在有便签时也留在画布上。
  dom.empty.style.display = show ? 'flex' : 'none';
}

/* ───────────── 编辑 ───────────── */

function startEdit(note, el) {
  if (state.editing === note) return;
  endEdit();
  const body = el.querySelector('.bd-note-body');
  if (!body) return;

  state.editing = note;
  body.contentEditable = 'true';
  body.spellcheck = false;
  el.classList.add('editing');
  el.classList.remove('single');
  body.focus();

  const range = document.createRange();
  range.selectNodeContents(body);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  body.addEventListener('keydown', onEditKey);
  body.addEventListener('blur', () => endEdit());
}

function onEditKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    endEdit(true);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    endEdit();
  }
  // 编辑时不要冒泡给画布：空格会触发平移、Delete 会删便签
  e.stopPropagation();
}

function endEdit(cancel = false) {
  const note = state.editing;
  if (!note) return;
  state.editing = null;

  const el = dom?.elById.get(note.id);
  if (!el) return;
  const body = el.querySelector('.bd-note-body');
  el.classList.remove('editing');
  if (!body) return;
  body.contentEditable = 'false';

  if (cancel) {
    body.textContent = note.title || '';
    return;
  }

  const next = (body.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  body.textContent = next;
  if (next === (note.title || '')) return;

  note.title = next;
  // 空便签不写库（它可能是刚创建还没写字的），也就不会污染记录列表
  if (!next) return;
  patchRecord(note.id, { title: next })
    .then(() => flashSaved())
    .catch(error => logToFile('error', `[board] 保存便签正文失败 #${note.id}: ${error?.stack || error}`));
}

/* ───────────── 拖拽 / 缩放 / 框选 / 连线 ───────────── */

function beginDrag(e, onMove, onEnd) {
  e.preventDefault();
  const move = ev => onMove(ev);
  const up = ev => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onEnd?.(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function selectOnly(id) {
  state.sel = new Set([id]);
  applySelection();
}

function toggleSelect(id) {
  if (state.sel.has(id)) state.sel.delete(id);
  else state.sel.add(id);
  applySelection();
}

function clearSelection() {
  if (!state.sel.size) return;
  state.sel.clear();
  applySelection();
}

function bindNote(note, el) {
  el.addEventListener('pointerdown', e => {
    if (e.button === 2) return;
    if (el.classList.contains('editing')) return;
    if (e.target.classList.contains('bd-handle')) return;

    if (state.tool === 'connect') {
      e.stopPropagation();
      startConnect(note, e);
      return;
    }
    // 便签工具下点便签 = 选中 + 拖动（与 whiteboard 一致：只有点空白才落新便签）
    if (state.tool !== 'select' && state.tool !== 'note') return;

    e.stopPropagation();
    if (e.shiftKey) toggleSelect(note.id);
    else if (!state.sel.has(note.id)) selectOnly(note.id);
    if (!state.sel.has(note.id)) return;
    startNoteDrag(e);
  });

  el.addEventListener('dblclick', e => {
    if (state.tool !== 'select' && state.tool !== 'note') return;
    e.stopPropagation();
    selectOnly(note.id);
    startEdit(note, el);
  });

  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.sel.has(note.id)) selectOnly(note.id);
    openNoteMenu(e.clientX, e.clientY, note);
  });

  el.querySelectorAll('.bd-handle').forEach(handle => {
    handle.addEventListener('pointerdown', e => {
      if (state.tool !== 'select') return;
      e.stopPropagation();
      startResize(note, handle.dataset.dir, e);
    });
  });
}

function startNoteDrag(e) {
  const items = [...state.sel]
    .map(id => state.notes.find(n => n.id === id))
    .filter(Boolean)
    .map(n => ({ note: n, x: n.x, y: n.y, el: dom.elById.get(n.id) }));
  if (!items.length) return;

  const start = { x: e.clientX, y: e.clientY };
  let moved = false;
  items.forEach(item => item.el?.classList.add('dragging'));
  state.dragStart = performance.now();

  beginDrag(e, ev => {
    const dx = (ev.clientX - start.x) / state.view.z;
    const dy = (ev.clientY - start.y) / state.view.z;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved = true;
    items.forEach(item => {
      item.note.x = Math.round(item.x + dx);
      item.note.y = Math.round(item.y + dy);
      if (item.el) {
        item.el.style.left = `${item.note.x}px`;
        item.el.style.top = `${item.note.y}px`;
      }
    });
    renderEdges();
  }, () => {
    items.forEach(item => {
      item.el?.classList.remove('dragging');
      if (moved) markDirty(item.note);
    });
  });
}

function startResize(note, dir, e) {
  const start = {
    cx: e.clientX, cy: e.clientY,
    w: note.w, h: note.h, x: note.x, y: note.y,
    el: dom.elById.get(note.id),
  };
  beginDrag(e, ev => {
    const dx = (ev.clientX - start.cx) / state.view.z;
    const dy = (ev.clientY - start.cy) / state.view.z;
    let w = start.w; let h = start.h;
    if (dir.includes('e')) w = Math.max(MIN_W, start.w + dx);
    if (dir.includes('s')) h = Math.max(MIN_H, start.h + dy);
    if (dir.includes('w')) { w = Math.max(MIN_W, start.w - dx); note.x = Math.round(start.x + (start.w - w)); }
    if (dir.includes('n')) { h = Math.max(MIN_H, start.h - dy); note.y = Math.round(start.y + (start.h - h)); }
    note.w = Math.round(w);
    note.h = Math.round(h);
    if (start.el) {
      start.el.style.width = `${note.w}px`;
      start.el.style.height = `${note.h}px`;
      start.el.style.left = `${note.x}px`;
      start.el.style.top = `${note.y}px`;
    }
    renderEdges();
  }, () => markDirty(note));
}

function startConnect(note, e) {
  if (!dom) return;
  const w0 = toWorld(stagePoint(e));
  const r = rectOf(note);
  let anchor = sidePoint(r, 0, 0);
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sidePoint(r, i, 0);
    const d = Math.hypot(s.x - w0.x, s.y - w0.y);
    if (d < best) { best = d; anchor = s; }
  }

  selectOnly(note.id);
  connectState = { note, target: null };

  const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  temp.setAttribute('class', 'bd-temp-line');
  dom.tempLayer.appendChild(temp);

  beginDrag(e, ev => {
    const w = toWorld(stagePoint(ev));
    const k = clamp(Math.hypot(w.x - anchor.x, w.y - anchor.y) * 0.38, 34, 160);
    temp.setAttribute('d',
      `M${anchor.x},${anchor.y} C${anchor.x + anchor.nx * k},${anchor.y + anchor.ny * k} ` +
      `${w.x - 26},${w.y} ${w.x},${w.y}`);

    const targetEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.bd-note');
    const target = targetEl ? state.notes.find(n => n.id === Number(targetEl.dataset.id)) : null;
    if (target !== connectState.target) {
      dom.elById.forEach(el => el.classList.remove('drop-target'));
      connectState.target = (target && target.id !== note.id) ? target : null;
      if (connectState.target) {
        dom.elById.get(connectState.target.id)?.classList.add('drop-target');
      }
    }
  }, () => {
    dom.elById.forEach(el => el.classList.remove('drop-target'));
    temp.remove();
    const to = connectState?.target ?? null;
    connectState = null;
    if (!to) return;
    if (note.links.includes(to.id)) return;
    note.links.push(to.id);
    rebuildEdges();
    renderEdges();
    markDirty(note);
  });
}

function startMarquee(e) {
  if (!dom) return;
  const p0 = stagePoint(e);
  let moved = false;
  dom.marquee.hidden = false;
  dom.marquee.style.left = `${p0.x}px`;
  dom.marquee.style.top = `${p0.y}px`;
  dom.marquee.style.width = '0px';
  dom.marquee.style.height = '0px';
  marqueeState = true;

  beginDrag(e, ev => {
    const p1 = stagePoint(ev);
    if (Math.abs(p1.x - p0.x) > 3 || Math.abs(p1.y - p0.y) > 3) moved = true;
    const x = Math.min(p0.x, p1.x);
    const y = Math.min(p0.y, p1.y);
    const w = Math.abs(p1.x - p0.x);
    const h = Math.abs(p1.y - p0.y);
    dom.marquee.style.left = `${x}px`;
    dom.marquee.style.top = `${y}px`;
    dom.marquee.style.width = `${w}px`;
    dom.marquee.style.height = `${h}px`;

    const a = toWorld({ x, y });
    const b = toWorld({ x: x + w, y: y + h });
    const hit = new Set();
    state.notes.forEach(note => {
      if (note.x < b.x && note.x + note.w > a.x && note.y < b.y && note.y + note.h > a.y) {
        hit.add(note.id);
      }
    });
    state.sel = hit;
    applySelection();
  }, () => {
    dom.marquee.hidden = true;
    marqueeState = null;
    if (!moved) clearSelection();
  });
}

function startPan(e) {
  const start = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
  dom.stage.style.cursor = 'grabbing';
  beginDrag(e, ev => {
    state.view.x = start.vx + (ev.clientX - start.x);
    state.view.y = start.vy + (ev.clientY - start.y);
    applyView();
  }, () => { dom.stage.style.cursor = ''; });
}

/* ───────────── 新建 / 删除 ───────────── */

let colorCursor = 0;

async function createNoteAt(worldPos, opts = {}) {
  if (!dom) return;
  const c = opts.c ?? colorCursor;
  colorCursor = (colorCursor + 1) % NOTE_COLORS.length;

  let id;
  try {
    // 先落一条最小记录：**空标题也建**，因为便签本身就是「这里有一个想法」的占位。
    // status='inbox' 让它出现在首页「待整理」右栏 —— 贴上去没整理的便签本来就该被催。
    id = await createRecord({ kind: 'log', title: '', status: 'inbox', tag: '', custom: {} });
  } catch (error) {
    logToFile('error', `[board] 新建便签失败: ${error?.stack || error}`);
    return;
  }

  const note = {
    id,
    kind: 'log',
    title: '',
    status: 'inbox',
    tag: '',
    c,
    x: Math.round(worldPos.x - DEFAULT_W / 2),
    y: Math.round(worldPos.y - DEFAULT_H / 2),
    w: DEFAULT_W,
    h: DEFAULT_H,
    hasPos: true,
    links: [],
    custom: {},
  };
  state.notes.unshift(note);
  renderNotes();
  selectOnly(id);
  markDirty(note);

  const el = dom.elById.get(id);
  if (el) startEdit(note, el);
}

async function deleteSelected() {
  const ids = [...state.sel];
  if (!ids.length) return;
  state.sel.clear();
  for (const id of ids) {
    try {
      await deleteRecord(id);
    } catch (error) {
      logToFile('error', `[board] 删除便签失败 #${id}: ${error?.stack || error}`);
    }
  }
  state.notes = state.notes.filter(n => !ids.includes(n.id));
  // 别人指向已删便签的连线一并剪掉（源在对方身上）
  state.notes.forEach(note => {
    const next = note.links.filter(to => !ids.includes(to));
    if (next.length !== note.links.length) {
      note.links = next;
      markDirty(note);
    }
  });
  renderNotes();
  rebuildEdges();
  renderEdges();
}

function cycleColor(note) {
  note.c = (note.c + 1) % NOTE_COLORS.length;
  const el = dom?.elById.get(note.id);
  if (el) el.style.setProperty('--bd-note-bg', NOTE_COLORS[note.c]);
  markDirty(note);
}

function setColor(note, index) {
  if (note.c === index) return;
  note.c = index;
  const el = dom?.elById.get(note.id);
  if (el) el.style.setProperty('--bd-note-bg', NOTE_COLORS[note.c]);
  markDirty(note);
}

/* ───────────── 右键菜单 ───────────── */

let menuNote = null;

function openNoteMenu(cx, cy, note) {
  if (!dom?.menu) return;
  menuNote = note;
  const swatches = NOTE_COLORS.map((color, i) =>
    `<button type="button" class="bd-swatch${note.c === i ? ' active' : ''}" data-c="${i}" style="background:${color}" aria-label="第 ${i + 1} 色"></button>`
  ).join('');

  dom.menu.innerHTML = `
    <div class="bd-menu-label">颜色</div>
    <div class="bd-menu-colors">${swatches}</div>
    <div class="bd-menu-sep"></div>
    <button type="button" class="bd-menu-item" data-act="edit">编辑文字<span class="bd-menu-key">双击</span></button>
    <button type="button" class="bd-menu-item" data-act="drawer">打开详情<span class="bd-menu-key">Enter</span></button>
    <button type="button" class="bd-menu-item" data-act="connect">从这里连线<span class="bd-menu-key">L</span></button>
    <div class="bd-menu-sep"></div>
    <button type="button" class="bd-menu-item danger" data-act="delete">删除<span class="bd-menu-key">Del</span></button>
  `;
  dom.menu.hidden = false;

  const stageRect = dom.stage.getBoundingClientRect();
  const mw = dom.menu.offsetWidth;
  const mh = dom.menu.offsetHeight;
  let left = cx - stageRect.left;
  let top = cy - stageRect.top;
  left = Math.min(left, stageRect.width - mw - 10);
  top = Math.min(top, stageRect.height - mh - 10);
  dom.menu.style.left = `${Math.max(10, left)}px`;
  dom.menu.style.top = `${Math.max(10, top)}px`;
}

function closeMenu() {
  if (dom?.menu) dom.menu.hidden = true;
  menuNote = null;
}

function bindMenu() {
  if (!dom?.menu) return;
  dom.menu.addEventListener('pointerdown', e => e.stopPropagation());
  dom.menu.addEventListener('click', e => {
    const swatch = e.target.closest('.bd-swatch');
    if (swatch && menuNote) {
      setColor(menuNote, Number(swatch.dataset.c));
      closeMenu();
      return;
    }
    const item = e.target.closest('[data-act]');
    if (!item || !menuNote) return;
    const note = menuNote;
    const act = item.dataset.act;
    closeMenu();

    if (act === 'edit') {
      const el = dom.elById.get(note.id);
      if (el) startEdit(note, el);
      return;
    }
    if (act === 'drawer') {
      try {
        openRowDrawer({ recordId: note.id, subtitle: '白板便签' });
      } catch (error) {
        logToFile('error', `[board] 打开详情失败: ${error?.stack || error}`);
      }
      return;
    }
    if (act === 'connect') {
      setTool('connect');
      return;
    }
    if (act === 'delete') {
      void deleteSelected();
    }
  });
}

/* ───────────── 工具 / 提示 ───────────── */

const HINTS = {
  select: '拖拽框选 · 双击便签编辑 · 双击空白新建',
  note: '单击空白贴一张便签',
  connect: '从一个便签拖到另一个便签',
  pan: '拖拽移动画布 · 滚轮缩放',
};

function setTool(tool) {
  state.tool = tool;
  if (dom?.stage) dom.stage.dataset.tool = tool;
  document.querySelectorAll('#bd-tools .bd-tool').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.bdTool === tool);
  });
  if (dom?.hint) dom.hint.textContent = HINTS[tool] || '';
  if (tool !== 'select') {
    endEdit();
    if (tool !== 'connect') clearSelection();
  }
}

/* ───────────── 事件绑定 ───────────── */

function bindStage() {
  if (!dom) return;
  const stage = dom.stage;

  stage.addEventListener('pointerdown', e => {
    if (e.button === 2) return;
    closeMenu();
    if (e.button === 1 || state.tool === 'pan') { startPan(e); return; }
    if (e.target.closest?.('.bd-edge')) return;

    if (state.tool === 'select') {
      if (!e.shiftKey) clearSelection();
      endEdit();
      startMarquee(e);
      return;
    }
    if (state.tool === 'note') {
      // 抬起且没拖动才落便签：避免 pointerup 抢走编辑焦点
      const p0 = stagePoint(e);
      let moved = false;
      beginDrag(e, ev => {
        const p1 = stagePoint(ev);
        if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > 4) moved = true;
      }, () => {
        if (moved) return;
        void createNoteAt(toWorld(p0));
        setTool('select');
      });
    }
  });

  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const p = stagePoint(e);
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 400;
    zoomAt(p.x, p.y, Math.exp(-delta * 0.0015));
  }, { passive: false });

  stage.addEventListener('dblclick', e => {
    if (state.tool !== 'select') return;
    if (e.target.closest?.('.bd-note') || e.target.closest?.('.bd-edge')) return;
    if (e.target.closest?.('.bd-hint')) return;
    void createNoteAt(toWorld(stagePoint(e)));
  });

  stage.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (e.target.closest?.('.bd-note') || e.target.closest?.('.bd-edge')) return;
    closeMenu();
  });

  dom.edgeLayer?.addEventListener('pointerdown', e => {
    const g = e.target.closest?.('.bd-edge');
    if (!g || state.tool !== 'select') return;
    e.stopPropagation();
    state.sel.clear();
    applySelection();
  });

  dom.edgeLayer?.addEventListener('contextmenu', e => {
    const g = e.target.closest?.('.bd-edge');
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    const from = Number(g.dataset.from);
    const to = Number(g.dataset.to);
    const note = state.notes.find(n => n.id === from);
    if (!note) return;
    note.links = note.links.filter(id => id !== to);
    rebuildEdges();
    renderEdges();
    markDirty(note);
  });

  dom.view?.addEventListener('click', e => {
    if (!dom.menu.hidden && !dom.menu.contains(e.target)) closeMenu();
  });
}

function bindBar() {
  document.querySelectorAll('#bd-tools .bd-tool').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.bdTool));
  });

  document.getElementById('bd-zoom-in')?.addEventListener('click', () => {
    const r = dom.stage.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1.2);
  });
  document.getElementById('bd-zoom-out')?.addEventListener('click', () => {
    const r = dom.stage.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1 / 1.2);
  });
  document.getElementById('bd-zoom-label')?.addEventListener('click', () => {
    const r = dom.stage.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1 / state.view.z);
  });
  document.getElementById('bd-fit-btn')?.addEventListener('click', fitView);

  document.getElementById('bd-new-btn')?.addEventListener('click', () => {
    if (!dom) return;
    const r = dom.stage.getBoundingClientRect();
    const center = toWorld({ x: r.width / 2, y: r.height / 2 });
    void createNoteAt(center);
  });
}

function bindKeys() {
  document.addEventListener('keydown', e => {
    // 只在本视图可见时接管
    if (!dom?.view || dom.view.style.display === 'none') return;
    const target = e.target;
    const typing = target && (target.isContentEditable ||
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
    if (typing) return;

    const meta = e.ctrlKey || e.metaKey;

    if (meta && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      state.sel = new Set(state.notes.map(n => n.id));
      applySelection();
      return;
    }
    if (meta) return;

    switch (e.key.toLowerCase()) {
      case 'v': setTool('select'); break;
      case 'n': setTool('note'); break;
      case 'l': setTool('connect'); break;
      case 'h': setTool('pan'); break;
      case 'delete':
      case 'backspace':
        if (state.sel.size) { e.preventDefault(); void deleteSelected(); }
        break;
      case 'escape':
        if (state.editing) endEdit(true);
        else if (state.sel.size) clearSelection();
        else setTool('select');
        break;
      case 'enter': {
        const id = [...state.sel][0];
        if (state.sel.size === 1 && id) {
          e.preventDefault();
          openRowDrawer({ recordId: id, subtitle: '白板便签' });
        }
        break;
      }
      case '0':
        state.view = { x: 0, y: 0, z: 1 };
        applyView();
        break;
      default:
        break;
    }
  });
}

/* ───────────── 对外入口 ───────────── */

/**
 * 首次进入时装载；之后每次进入只做一次轻量刷新（别人可能改过标题）。
 * @param {{force?: boolean}} [opts]
 */
export async function initBoardPage(opts = {}) {
  if (!mountDom()) {
    logToFile('error', '[board] 找不到 #bd-stage，白板未挂载');
    return;
  }
  if (state.loading) return;
  if (state.ready && !opts.force) {
    fitViewIfFirstPaint();
    return;
  }

  state.loading = true;
  updateEmptyState();
  try {
    const notes = await fetchNotes();
    applyAutoLayout(notes);
    state.notes = notes;
    state.ready = true;
    colorCursor = notes.length % NOTE_COLORS.length;
    renderNotes();
    rebuildEdges();
    renderEdges();
    bindStage();
    bindBar();
    bindMenu();
    bindKeys();
    setTool('select');
    requestAnimationFrame(() => {
      fitViewIfFirstPaint(true);
    });
  } catch (error) {
    logToFile('error', `[board] 装载失败: ${error?.stack || error}`);
  } finally {
    state.loading = false;
    updateEmptyState();
  }
}

let firstFitDone = false;

function fitViewIfFirstPaint(force = false) {
  if (firstFitDone && !force) return;
  firstFitDone = true;
  const r = dom?.stage.getBoundingClientRect();
  // 面板宽度为 0 说明视图还没真正显示（路由刚切过来），等下一帧
  if (!r || r.width < 40) {
    firstFitDone = false;
    return;
  }
  fitView();
}

/** 视图被切走时把还没落库的位置刷下去，避免「刚拖完就切页」丢位置。 */
export async function flushBoard() {
  clearTimeout(flushTimer);
  await flushDirty();
}

/** 路由切进白板时调用：重扫一次，让别处新建的记录也能上画布。 */
export async function refreshBoard() {
  if (!state.ready) return;
  try {
    await flushBoard();
    const notes = await fetchNotes();
    // 保留当前视图变换与选中，避免「一刷新就跳位置」
    const prevSel = new Set(state.sel);
    applyAutoLayout(notes);
    state.notes = notes;
    state.sel = new Set([...prevSel].filter(id => notes.some(n => n.id === id)));
    renderNotes();
    rebuildEdges();
    renderEdges();
  } catch (error) {
    logToFile('error', `[board] 刷新失败: ${error?.stack || error}`);
  }
}
