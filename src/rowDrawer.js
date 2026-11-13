// 行详情抽屉 —— 全应用唯一的「记录详情」界面。
//
// 为什么要有这一层：
//   以前有两套详情页：表格里的 drawer（sheetPanels.openRowDrawer）和「今天 / 记录」页的
//   #record-reader-overlay（quickCapture.openRecordReader）。两套各写一遍渲染，能力立刻分叉：
//   一套能改字段但只能看表格行，另一套能「转待办 / 转笔记」但只能读。用户看到的是
//   「同一条记录，从不同入口点开长得不一样、能做的事不一样」。
//   合并成一套之后，详情里能做的事只在这里加一次。
//
// ★ 禁令（改这个文件前必读）★
//   本模块**单向**依赖 sheetPanels.js（openDrawer / closeAllPanels / openImagePreview）。
//   **sheetPanels.js 绝不允许 import rowDrawer.js** —— ESM 循环引用会让 openDrawer 在
//   TDZ（暂时性死区）里被求值，表现为「抽屉偶发打不开，刷新一下又好了」，是最难查的那类 bug。
//   同理：sheetPage.js 从这里 import，而不是从 sheetPanels.js。
//
// 数据：一律走 recordStore（不要在本文件里拼 SQL）。
//   record 是唯一真相表，kind 只是「出生地」，「在不在表里」由 record.sheet_id 决定。

import { escapeHtml } from './htmlUtils.js';
import { renderCell } from './fieldTypes.js';
import { openDrawer, closeAllPanels, openImagePreview } from './sheetPanels.js';
import { toId } from './recordTree.js';
import {
  getRecord,
  listAncestors,
  listChildren,
  listChildSheets,
  patchRecord,
  isRecordStoreReady,
} from './recordStore.js';
import { renderMarkdown } from './markdown.js';
import { logToFile } from './logger.js';

const DRAWER_WIDTH = 560;

const KIND_LABELS = {
  log: '记录',
  todo: '待办',
  sheet_row: '表格行',
};

// 库里 status 的取值混着两套语义：record 表的（inbox / pending / done）
// 和旧视图换算出来的（unprocessed / processed）。两套都认，认不出就原样显示。
const STATUS_LABELS = {
  inbox: '待整理',
  unprocessed: '待整理',
  processed: '已整理',
  pending: '未完成',
  done: '已完成',
  archived: '已归档',
};

// 抽屉当前的会话状态。注意只有一个：openDrawer 本身是单例（内部先 closeAllPanels），
// 不存在「两个抽屉同时打开」的合法场景。
const state = {
  el: null,
  recordId: null,
  open: false,
  // 自增令牌：抽屉被替换 / 关闭后，上一轮还没跑完的异步分区靠它对账后自行放弃，
  // 否则会出现「点了子项，父抽屉的异步结果回来把子抽屉的内容覆盖掉」。
  token: 0,
  // 正文的「已落库基线」。captureBodyDraft() 拿编辑框的值和它比，相同就是没改过，
  // 不写库。打开抽屉时重置为 record.body，保存成功后也推进到这个值。
  bodyBaseline: '',
  // 写库失败时留下的草稿 {recordId, body}。下次 flush（关抽屉 / 切记录 / 关窗口）
  // 再补写一次 —— 失败要能重试，不能静默丢字。
  pendingBody: null,
};

// ==========================================
// 对外接口
// ==========================================

/**
 * 行详情抽屉（唯一入口）。
 *
 * 向后兼容：老的调用只传 {row, fields, index, total, subtitle,
 * onCellClick, onDelete, onPrev, onNext} 也能跑（sheetPage.openDetail 就是这种），
 * 新能力（面包屑 / 子项 / 子表 / 正文）靠 recordId 补齐。
 *
 * @param {object} opts
 * @param {number|string} [opts.recordId] 记录 id；缺省时从 row.id 取
 * @param {number|string} [opts.sheetId]  所属表 id（决定字段网格的语义，本期只用于判断）
 * @param {object} [opts.row]             已装载的行（含 values），传了就省一次查询
 * @param {object[]} [opts.fields]        sheet_field 列表
 * @param {number} [opts.index]           当前行在筛选结果里的序号（从 1 起）
 * @param {number} [opts.total]           筛选结果总行数
 * @param {string} [opts.subtitle]        抽屉头部的小字（表名 · 第 x / y 条 / 记录类型）
 * @param {{rowId:number, fieldKey:string}|null} [opts.anchor] 关闭 / 返回时要定位的格（T09 用）
 * @param {boolean} [opts.fromNav]        true = 由 popNav 触发，不再压栈（T09 用）
 * @param {object} [opts.record]          **只用于首屏**的部分记录（{title, body} 即可）；
 *                                        兼容壳拿旧记录对象顶上，避免等一次查询才见标题。
 *                                        完整字段永远来自 getRecord，不被这个值影响。
 * @param {{onDelete?:Function, onPrev?:Function, onNext?:Function, onCellClick?:Function,
 *          onClose?:Function,
 *          actions?:Array<{key:string, label:string, run:Function, keepOpen?:boolean}>}} [opts.handlers]
 * @returns {HTMLElement} 抽屉根节点
 */
export function openRowDrawer(opts = {}) {
  // ★ 换记录前先把上一份正文草稿抓住并落库。
  // captureBodyDraft() 是**同步**的：值在 DOM 里，而下面 openDrawer → closeAllPanels
  // 会立刻把旧抽屉的节点删掉，等异步回来再读就只剩空字符串。
  // 这里刻意不 await —— 一次写库不该把新抽屉的打开卡住。
  void flushDrawerBody();

  const options = opts && typeof opts === 'object' ? opts : {};
  const row = options.row && typeof options.row === 'object' ? options.row : null;
  const recordId = toId(options.recordId ?? row?.id);
  const fields = normalizeFields(options.fields);
  const visibleFields = fields.filter(field => Number(field.visible) !== 0);
  const handlers = normalizeHandlers(options);
  const preload = options.record && typeof options.record === 'object' ? options.record : null;
  const sheetId = toId(options.sheetId ?? row?.sheet_id ?? preload?.sheet_id);
  const total = Number(options.total) > 0 ? Number(options.total) : 0;
  const index = Number(options.index) > 0 ? Number(options.index) : 0;

  // 标题字段：表格行的标题就是「第一个可见 text 字段」的值，不是 record.title。
  // 写库只能写 text 字段（custom 里那个 key 才是表格首列的来源），
  // 但**显示**时如果没有 text 字段，退到第一个可见字段（和表格首列的取法一致）。
  const titleField = visibleFields.find(field => field.type === 'text') || null;
  const displayField = titleField || visibleFields[0] || null;

  const ctx = {
    el: null,
    recordId,
    sheetId,
    row,
    fields,
    visibleFields,
    titleField,
    displayField,
    handlers,
    preload,
    // 调用方显式给了 subtitle 就不再用记录自身的类型去覆盖（表名 · 第 x / y 条 更有信息量）
    kickerProvided: String(options.subtitle ?? '').trim() !== '',
    // 完整记录（含 custom），异步取一次，各分区共用同一份 Promise —— 不要各查一次。
    recordPromise: null,
    record: null,
    // 正文：bodySource = 当前「库里的值」（编辑放弃时回退到它），
    // bodyEditing = 编辑框是否开着（异步 markdown 渲染回来不能把它冲掉）。
    bodySource: '',
    bodyEditing: false,
    // recordReady = 「库里的正文」是否已经到位（applyRecord 做完 / 或确定不会再有）。
    // 首屏 .rd-body 画的是 preload（可能只是空串），此时进编辑态就会拿 preload 当原文，
    // 保存时把库里的真正文整段覆盖 —— 所以编辑入口必须等这个标志。
    recordReady: false,
    // 进编辑态那一刻 textarea 里的值，给 applyRecord 的第二道防御比对用
    bodyEditOriginal: '',
    // 编辑态挂的 window 捕获监听器，退出时必须摘掉（见 teardownBodyEditor）
    bodyKeyCapture: null,
  };

  const initialTitle = resolveTitle(ctx);
  const initialKicker = String(options.subtitle ?? '') || defaultKicker(preload);

  const bodyHtml = `
    <div class="rd">
      <nav class="rd-crumbs" data-section="crumbs" hidden aria-label="上级路径"></nav>
      <div class="rd-hint" data-section="hint" hidden></div>
      <div class="rd-fields" data-section="fields">${fieldsHtml(visibleFields, row)}</div>
      <section class="rd-block" data-section="children" hidden>
        <h3 class="rd-h">子项</h3>
        <div class="rd-list" data-list="children"></div>
      </section>
      <section class="rd-block" data-section="sheets" hidden>
        <h3 class="rd-h">挂载的表</h3>
        <div class="rd-sheets" data-list="sheets"></div>
      </section>
      <section class="rd-block" data-section="body">
        <h3 class="rd-h">正文</h3>
        <div class="rd-body markdown-body" data-body></div>
      </section>
      <section class="rd-block" data-section="notes">
        <h3 class="rd-h">关联笔记</h3>
        <div class="rd-notes"><span class="rd-empty">暂无关联笔记</span></div>
      </section>
      <section class="rd-block" data-section="backlinks">
        <h3 class="rd-h">被引用于</h3>
        <div class="rd-backlinks"><span class="rd-empty">暂无引用</span></div>
      </section>
      ${actionsHtml(handlers.actions)}
    </div>`;

  const drawer = openDrawer({
    title: initialTitle,
    subtitle: initialKicker,
    width: DRAWER_WIDTH,
    body: bodyHtml,
    footer: footerHtml(index, total, handlers),
    onClose: () => {
      // 点遮罩 / 点 × / Esc 关抽屉走的是这条路（sheetPage 的上一条/下一条是
      // 先 closeAllPanels 再开新抽屉，同样经过这里）。closeAllPanels 是
      // 「先摘节点、后调 onClose」，所以这里 state.el 还在，只是脱离了文档 ——
      // querySelector 照样能取到编辑框的值，草稿不会丢。
      void flushDrawerBody();
      teardownBodyEditor(ctx);
      state.open = false;
      state.el = null;
      handlers.onClose?.();
    },
  });

  if (!drawer) return null;

  // 顺序要紧：openDrawer 内部会先 closeAllPanels()，上一个抽屉的 onClose 已经把
  // state 清空了，这里再写入本次会话的状态。
  state.el = drawer;
  state.recordId = recordId;
  state.open = true;
  state.token += 1;
  const token = state.token;
  ctx.el = drawer;

  // 正文基线：首屏只有 preload 那点信息，真正的 record.body 在 applyRecord 里补正。
  // 基线必须在这里重置 —— 上一条记录的正文不能拿来跟这一条比。
  ctx.bodySource = String(preload?.body ?? '');
  state.bodyBaseline = ctx.bodySource;

  // 首屏：正文先用已知文本顶上（markdown 渲染要等 vendor 脚本，不能阻塞开抽屉）
  paintPreloadBody(ctx);
  bindEvents(ctx);
  // 异步分区：面包屑 / 子项 / 子表 / 正文 markdown 都不阻塞首屏
  void hydrate(ctx, token);

  return drawer;
}

/**
 * 把抽屉里还没落库的正文写进 record.body。
 *
 * 时序上唯一要紧的一点：**抓值必须同步**。调用方（openRowDrawer / closeRowDrawer /
 * openDrawer 的 onClose）会在调用后立刻销毁抽屉 DOM，所以 captureBodyDraft() 先同步
 * 把值取出来并推进基线，之后才是异步写库。
 *
 * 三个调用点：
 *   ① openRowDrawer 开头（换记录 / 重开抽屉）
 *   ② closeRowDrawer（兼容壳主动关）
 *   ③ openDrawer 的 onClose（点遮罩 / 点 × / Esc）
 * 三者都不会重复写：基线的推进发生在同步段，第二次进来时编辑框已经不再是「脏」的。
 *
 * @returns {Promise<boolean>} true = 真的写了库，false = 没有草稿 / 写失败
 */
export async function flushDrawerBody() {
  const fresh = captureBodyDraft();
  const pending = state.pendingBody;
  const draft = fresh || pending;
  if (!draft) return false;

  // 新一轮草稿优先：它的值更新，旧的 pending 只会把更早的内容盖回去
  state.pendingBody = null;
  if (fresh && pending && pending.recordId !== fresh.recordId) {
    logToFile('warn', `[rowDrawer] 丢弃未补写的正文草稿 record=${pending.recordId}（已被新记录覆盖）`);
  }

  // 关抽屉 / 切记录这一步没有 ctx（提示条也随抽屉一起没了），只写日志
  return writeBody(null, draft.recordId, draft.body);
}

/**
 * 抽屉当前是否打开（navigation 判断要不要接管 Esc）。
 * @returns {boolean}
 */
export function isDrawerOpen() {
  return Boolean(state.open && state.el && state.el.isConnected);
}

/**
 * 关掉抽屉。给「兼容壳」用：todayTimeline 会调 window.closeRecordReader() 再跳笔记页，
 * 那个全局函数现在指向这里。
 */
export function closeRowDrawer() {
  if (!state.open) return;
  // 先同步抓草稿，再销毁 DOM
  void flushDrawerBody();
  closeAllPanels();
}

// ==========================================
// 入参归一
// ==========================================

function normalizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.filter(field => field && typeof field === 'object' && String(field.key ?? '') !== '');
}

/**
 * handlers 归一：老的调用把 onDelete / onPrev / onNext / onCellClick 直接挂在顶层，
 * 新的调用把它们收进 handlers。两处都认，新写法优先。
 */
function normalizeHandlers(options) {
  const source = options.handlers && typeof options.handlers === 'object' ? options.handlers : {};
  const pick = key => (typeof source[key] === 'function' ? source[key] : options[key]);
  const actions = Array.isArray(source.actions)
    ? source.actions.filter(item => item && typeof item.run === 'function' && String(item.key ?? '') !== '')
    : [];

  return {
    onDelete: pick('onDelete'),
    onPrev: pick('onPrev'),
    onNext: pick('onNext'),
    onCellClick: pick('onCellClick'),
    onClose: pick('onClose'),
    actions,
  };
}

// ==========================================
// 同步渲染（首屏）
// ==========================================

function resolveTitle(ctx) {
  // 表格行：标题 = 第一个可见 text 字段的值（存在 custom[key] 里，不是 record.title）
  if (ctx.displayField && ctx.row?.values) {
    const value = String(ctx.row.values[ctx.displayField.key] ?? '').trim();
    if (value) return value;
  }
  const preloaded = String(ctx.preload?.title ?? '').trim();
  if (preloaded) return preloaded;
  return ctx.recordId !== null ? `未命名记录 #${ctx.recordId}` : '未命名记录';
}

function defaultKicker(record) {
  if (!record) return '';
  const parts = [];
  const kind = KIND_LABELS[record.kind] || '';
  if (kind) parts.push(kind);
  const status = STATUS_LABELS[record.status] || '';
  if (status) parts.push(status);
  const when = [record.happened_date, String(record.happened_time ?? '').slice(0, 5)]
    .filter(Boolean)
    .join(' ');
  if (when) parts.push(when);
  return parts.join(' · ');
}

function fieldsHtml(visibleFields, row) {
  if (!visibleFields.length) return '';
  const cells = visibleFields
    .map(
      field => `<div class="sh-detail-field">
        <div class="sh-detail-label">${escapeHtml(field.label || field.key)}</div>
        <div class="sh-detail-cell sh-cell" data-key="${escapeHtml(field.key)}" data-row="${escapeHtml(row?.id ?? '')}" tabindex="-1">${renderCell(
          field,
          row?.values?.[field.key],
          { placeholder: field.type === 'attachment' ? '点击添加附件' : '点击填写' }
        )}</div>
      </div>`
    )
    .join('');
  return `<div class="sh-detail">${cells}</div>`;
}

function actionsHtml(actions) {
  if (!actions.length) return '';
  const buttons = actions
    .map(
      item =>
        `<button type="button" class="sh-btn rd-action" data-action-key="${escapeHtml(item.key)}">${escapeHtml(item.label || item.key)}</button>`
    )
    .join('');
  return `<section class="rd-block rd-actions" data-section="actions">${buttons}</section>`;
}

function footerHtml(index, total, handlers) {
  const parts = [];
  if (typeof handlers.onDelete === 'function') {
    parts.push('<button type="button" class="sh-btn is-danger-ghost" data-del>删除记录</button>');
  }

  const withNav = typeof handlers.onPrev === 'function' || typeof handlers.onNext === 'function';
  // 一个按钮都没有就不要渲染 footer：空白的底栏比没有底栏更像坏了
  if (!parts.length && !withNav) return '';

  parts.push('<span class="sh-foot-gap"></span>');
  if (withNav) {
    const prevDisabled = index <= 1 ? 'disabled' : '';
    const nextDisabled = total && index >= total ? 'disabled' : '';
    parts.push(`<button type="button" class="sh-btn" data-prev ${prevDisabled}>上一条</button>`);
    parts.push(`<button type="button" class="sh-btn" data-next ${nextDisabled}>下一条</button>`);
  }
  return parts.join('');
}

function paintPreloadBody(ctx) {
  const host = section(ctx, 'body')?.querySelector('[data-body]');
  if (!host) return;
  const text = String(ctx.preload?.body ?? '');
  ctx.bodySource = text;
  if (!text.trim()) {
    paintEmptyBody(host);
    return;
  }
  // markdown 依赖（marked / DOMPurify）是异步脚本，先用纯文本顶上，避免白屏
  host.innerHTML = plainTextHtml(text);
}

/**
 * 空正文不是「暂无正文」四个字，而是一行可点的提示 —— 空状态在这里同时是入口。
 * @param {HTMLElement} host .rd-body 容器
 */
function paintEmptyBody(host) {
  host.classList.add('is-empty');
  host.innerHTML = '<span class="rd-empty rd-empty-action" data-body-start>写点什么…</span>';
}

// ==========================================
// 异步分区
// ==========================================

async function hydrate(ctx, token) {
  // 没有数据通道（调试壳 / 老调用没给 id）：首屏同步渲染的就是全部，不留「加载中」痕迹。
  // recordReady 也要放开 —— 这条路上不会有人再来补正文，不放开就永远不能编辑。
  if (ctx.recordId === null || !isRecordStoreReady()) {
    ctx.recordReady = true;
    return;
  }

  ctx.recordPromise = getRecord(ctx.recordId).catch(error => {
    console.warn('[rowDrawer] 记录读取失败', error);
    return null;
  });

  const jobs = [
    applyRecord(ctx, token),
    loadCrumbs(ctx, token),
    loadChildren(ctx, token),
    loadChildSheets(ctx, token),
  ];

  const results = await Promise.allSettled(jobs);
  results.forEach(result => {
    if (result.status === 'rejected') console.warn('[rowDrawer] 分区加载失败', result.reason);
  });
}

async function applyRecord(ctx, token) {
  const record = await ctx.recordPromise;

  // 取记录失败（库读挂 / 记录已被删）也要放开正文编辑：
  // 否则表现为「正文永远点不动」，用户只能瞪着它，比写失败更难理解。
  if (!record) {
    ctx.recordReady = true;
    return;
  }
  if (!alive(token)) return;
  ctx.record = record;

  // 标题：有字段时以行的值为准（表格首列才是真相），没有字段才用 record.title
  if (!ctx.displayField) setTitle(ctx, String(record.title ?? '').trim() || `未命名记录 #${record.id}`);

  // 头部小字：调用方给了就以调用方为准（表名 · 第 x / y 条），没给就用记录自身的类型
  if (!ctx.kickerProvided) setKicker(ctx, defaultKicker(record));

  // 完全没有字段（随手记 / 待办 / 子项）才用记录信息网格顶替字段区，
  // 有字段但都不是 text 的行不能走这里 —— 那会把已经渲染好的字段网格覆盖掉。
  if (!ctx.visibleFields.length) renderMetaRows(ctx, record);

  // 正文基线补正：preload 里可能只有临时值，record 才是权威。
  // bodySource 永远代表「库里的值」（Esc 放弃时回退到它），所以编辑态下也要更新；
  // 但**基线**不能在编辑态下动 —— 否则用户敲进去的字会被当成「没改过」。
  const body = String(record.body ?? '');
  ctx.bodySource = body;
  // 到这里「库里的正文」才算就位。startBodyEdit 靠它把「preload 当原文」的窗口堵死。
  ctx.recordReady = true;

  if (!ctx.bodyEditing) {
    state.bodyBaseline = body;
  } else {
    // 第二道防御：万一还是有人在 recordReady 之前进了编辑态（getRecord 重试、
    // 未来抽屉复用之类的路径），只要他一个字都没敲，就把 textarea 换成真正的正文；
    // 已经敲过字就一个字都不动 —— 覆盖用户的输入比让他看到 preload 值更糟。
    const textarea = section(ctx, 'body')?.querySelector('[data-body-edit]');
    if (textarea && typeof ctx.bodyEditOriginal === 'string' && textarea.value === ctx.bodyEditOriginal) {
      textarea.value = body;
      ctx.bodyEditOriginal = body;
      state.bodyBaseline = body;
      autoGrowBody(textarea);
    }
  }

  await renderBody(ctx, body);
}

/**
 * 面包屑：自根到父。根为空（顶层记录）时整块不显示。
 * 点击留给 T09 接跳转，现在只打点，不做假动作。
 */
async function loadCrumbs(ctx, token) {
  const chain = await listAncestors(ctx.recordId);
  if (!alive(token) || !chain.length) return;
  const el = section(ctx, 'crumbs');
  if (!el) return;

  // 只在条目之间放分隔符。链尾再加一个 `›` 会指向「下面那条大标题」，
  // 看起来像少了一项（截图核对时确实被误读成 bug），这里不带尾分隔。
  el.innerHTML = chain
    .map(
      item =>
        `<button type="button" class="rd-crumb" data-crumb-id="${escapeHtml(item.id)}" title="${escapeHtml(
          crumbLabel(item)
        )}">${escapeHtml(crumbLabel(item))}</button>`
    )
    .join('<span class="rd-crumb-sep" aria-hidden="true">›</span>');
  el.hidden = false;
}

async function loadChildren(ctx, token) {
  const children = await listChildren(ctx.recordId);
  if (!alive(token) || !children.length) return;
  const block = section(ctx, 'children');
  const list = block?.querySelector('[data-list="children"]');
  if (!block || !list) return;

  list.innerHTML = children
    .map(
      child => `<button type="button" class="rd-row-item" data-child-id="${escapeHtml(child.id)}">
        <span class="rd-row-title">${escapeHtml(recordTitle(child))}</span>
        <span class="rd-row-meta">${escapeHtml(statusText(child))}</span>
      </button>`
    )
    .join('');
  block.hidden = false;
}

async function loadChildSheets(ctx, token) {
  const sheets = await listChildSheets(ctx.recordId);
  if (!alive(token) || !sheets.length) return;
  const block = section(ctx, 'sheets');
  const list = block?.querySelector('[data-list="sheets"]');
  if (!block || !list) return;

  list.innerHTML = sheets
    .map(
      sheet => `<button type="button" class="rd-sheet-card" data-sheet-id="${escapeHtml(sheet.id)}">
        <span class="rd-sheet-name">${escapeHtml(String(sheet.name ?? '').trim() || `表 #${sheet.id}`)}</span>
        <span class="rd-sheet-meta">${escapeHtml(`${Number(sheet.row_count) || 0} 行 · ${Number(sheet.field_count) || 0} 列`)}</span>
      </button>`
    )
    .join('');
  block.hidden = false;
}

async function renderBody(ctx, rawBody) {
  const host = section(ctx, 'body')?.querySelector('[data-body]');
  if (!host) return;
  // 编辑中：一次晚到的异步渲染会把 textarea 冲掉，正在敲的字就没了
  if (ctx.bodyEditing) return;

  const source = String(rawBody ?? '');
  if (!source.trim()) {
    paintEmptyBody(host);
    return;
  }
  host.classList.remove('is-empty');

  // 先用纯文本顶上（首屏已经有 preload 内容时这里等于不变），markdown 渲染完再换
  if (!host.querySelector('.rd-body-text')) host.innerHTML = plainTextHtml(source);

  try {
    const html = await renderMarkdown(source);
    if (!host.isConnected || ctx.bodyEditing) return;
    host.innerHTML = html;
  } catch (error) {
    // 渲染链挂了不能把正文弄丢：退回纯文本
    console.warn('[rowDrawer] Markdown 渲染失败，降级为纯文本', error);
    host.innerHTML = plainTextHtml(source);
  }
}

/** 无字段记录（随手记 / 待办）的信息网格：字段网格区改用它，免得抽屉上半截全空 */
function renderMetaRows(ctx, record) {
  const host = section(ctx, 'fields');
  if (!host) return;

  const rows = [
    ['类型', KIND_LABELS[record.kind] || String(record.kind ?? '')],
    ['状态', STATUS_LABELS[record.status] || String(record.status ?? '')],
    ['标签', [record.tag, record.sub_tag].filter(Boolean).join(' / ')],
    [
      '发生时间',
      [record.happened_date, String(record.happened_time ?? '').slice(0, 5)].filter(Boolean).join(' '),
    ],
    ['截止', record.deadline],
    ['备注', record.remark],
    // 只有真在表里才说「所属表」。随手记/待办写「不在任何表」是纯噪音 ——
    // 表格行本来就有 sheet_id（没被移出过），空值只在非表格记录上出现。
    ['所属表', record.sheet_id ? `#${record.sheet_id}` : ctx.sheetId ? `#${ctx.sheetId}` : ''],
  ].filter(([, value]) => String(value ?? '').trim());

  host.innerHTML = rows.length
    ? `<div class="rd-meta">${rows
        .map(
          ([label, value]) =>
            `<div class="rd-meta-row"><span class="rd-meta-label">${escapeHtml(label)}</span><span class="rd-meta-value">${escapeHtml(
              value
            )}</span></div>`
        )
        .join('')}</div>`
    : '';
}

// ==========================================
// 事件
// ==========================================

function bindEvents(ctx) {
  const drawer = ctx.el;
  const bodyEl = drawer.querySelector('.sh-drawer-body');
  bodyEl?.addEventListener('click', event => onBodyClick(ctx, event));

  drawer.querySelector('[data-del]')?.addEventListener('click', () => ctx.handlers.onDelete?.(ctx.row));
  drawer.querySelector('[data-prev]')?.addEventListener('click', () => ctx.handlers.onPrev?.(ctx.row));
  drawer.querySelector('[data-next]')?.addEventListener('click', () => ctx.handlers.onNext?.(ctx.row));

  bindTitleEdit(ctx);
  bindBodyEditor(ctx);
}

function onBodyClick(ctx, event) {
  // ① 附件缩略图 → 灯箱。放在最前面：缩略图在单元格内部，先于「点单元格编辑」命中。
  const thumb = event.target.closest('img.ft-att-thumb');
  if (thumb) {
    const cell = thumb.closest('.sh-cell');
    const gallery = [...(cell?.querySelectorAll('img.ft-att-thumb') || [])].map(img => ({
      src: img.getAttribute('src'),
      name: img.getAttribute('alt') || '',
    }));
    openImagePreview(thumb.getAttribute('src'), thumb.getAttribute('alt') || '', gallery);
    return;
  }

  // ② 动作按钮（兼容壳塞进来的「转待办 / 转笔记 / 修改分类 / 编辑」）
  const actionEl = event.target.closest('[data-action-key]');
  if (actionEl) {
    runAction(ctx, actionEl.dataset.actionKey);
    return;
  }

  // ③ 面包屑跳转：T09 才接，现在只打点（不做假动作，免得看起来能点却没反应）
  const crumb = event.target.closest('[data-crumb-id]');
  if (crumb) {
    console.debug('[rowDrawer] 面包屑跳转待接入（T09）', toId(crumb.dataset.crumbId));
    return;
  }

  // ④ 子项 → 打开该子项的抽屉
  const child = event.target.closest('[data-child-id]');
  if (child) {
    openChildDrawer(ctx, toId(child.dataset.childId));
    return;
  }

  // ⑤ 子表卡片：sheetPage 还没导出 __wrOpenSheet（T09 才有），先只留入口判断
  const sheetCard = event.target.closest('[data-sheet-id]');
  if (sheetCard) {
    const sheetId = toId(sheetCard.dataset.sheetId);
    if (typeof window.__wrOpenSheet === 'function') window.__wrOpenSheet(sheetId);
    else console.debug('[rowDrawer] 打开子表待接入（T07 / T09）', sheetId);
    return;
  }

  // ⑥ 字段单元格 → 交给 sheetPage 挂上单元格编辑器
  const cell = event.target.closest('.sh-cell');
  if (!cell) return;
  const field = ctx.fields.find(item => item.key === cell.dataset.key);
  if (field) ctx.handlers.onCellClick?.(field, cell, ctx.row);
}

function runAction(ctx, key) {
  const item = ctx.handlers.actions.find(entry => entry.key === key);
  if (!item) return;
  // 老的阅读器是「先关详情页，再开弹窗」。保持同样的观感：不然弹窗关掉后
  // 下面还压着一份转换前的旧记录，用户会以为没生效。
  if (!item.keepOpen) closeAllPanels();
  try {
    item.run();
  } catch (error) {
    console.warn('[rowDrawer] 动作执行失败', key, error);
  }
}

function openChildDrawer(ctx, childId) {
  if (childId === null) return;
  // 子项的字段集与当前表未必相同：不带 fields，让抽屉走「记录信息 + 正文」形态。
  // 字段网格由 T06 / T07 打开对应表时补上。
  openRowDrawer({
    recordId: childId,
    subtitle: '子项',
    handlers: {
      onClose: ctx.handlers.onClose,
    },
  });
}

// ---- 标题就地编辑 ----

function bindTitleEdit(ctx) {
  const titleEl = ctx.el?.querySelector('.sh-drawer-title');
  if (!titleEl) return;

  titleEl.classList.add('rd-title');
  titleEl.setAttribute('role', 'button');
  titleEl.setAttribute('tabindex', '0');
  titleEl.setAttribute('title', '点击修改标题');

  const start = () => startTitleEdit(ctx, titleEl);
  titleEl.addEventListener('click', start);
  titleEl.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    start();
  });
}

function startTitleEdit(ctx, titleEl) {
  // 表格行：标题就是首列 text 字段。走 sheetPage 的单元格编辑器而不是自己写库 ——
  // 编辑器那条路会 commitCell → writeRow → 重绘表格，表格里那一格立刻同步；
  // 自己 patchRecord 只会改库，state.rows 里的值不动，表格要重开才变。
  if (ctx.titleField && typeof ctx.handlers.onCellClick === 'function') {
    const cell = [...(ctx.el?.querySelectorAll('.sh-detail-cell') || [])].find(
      el => el.dataset.key === ctx.titleField.key
    );
    if (cell) {
      cell.classList.add('is-title-target');
      setTimeout(() => cell.classList.remove('is-title-target'), 600);
      cell.click();
      return;
    }
  }
  openInlineTitleInput(ctx, titleEl);
}

function openInlineTitleInput(ctx, titleEl) {
  const current = String(titleEl.textContent ?? '');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rd-title-input';
  input.value = current;
  input.setAttribute('aria-label', '修改标题');
  titleEl.hidden = true;
  titleEl.after(input);
  input.focus();
  input.select();

  let settled = false;
  const restore = () => {
    input.remove();
    titleEl.hidden = false;
  };

  const finish = async commit => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (!commit || !next || next === current) {
      restore();
      return;
    }

    const recordId = ctx.recordId;
    if (recordId === null) {
      restore();
      return;
    }

    // custom 是整列覆盖写，必须先拿到当前值再合并 —— 否则会把其他字段一起抹掉
    const record = ctx.record || (ctx.recordPromise ? await ctx.recordPromise : null);
    const patch = { title: next };
    if (ctx.titleField) {
      // 表格行的标题存在 custom[第一个 text 字段的 key] 里；
      // 只写 record.title 的话表格首列不会变，用户会以为没保存。
      patch.custom = { ...(record?.custom || {}), [ctx.titleField.key]: next };
    }

    try {
      await patchRecord(recordId, patch);
      if (record) {
        record.title = next;
        if (patch.custom) record.custom = patch.custom;
      }
      // 字段网格里的那一格同步更新（该格是 titleField 的单元格）。
      // 表里没有 text 字段时这里不动作：那种表的首列是数字 / 日期，和「标题」不是一回事，
      // 把 record.title 硬写进去会把首列的值覆盖成一段文字。
      if (ctx.titleField) {
        const cell = [...(ctx.el?.querySelectorAll('.sh-detail-cell') || [])].find(
          el => el.dataset.key === ctx.titleField.key
        );
        if (cell) cell.innerHTML = renderCell(ctx.titleField, next, { placeholder: '点击填写' });
      }
      setTitle(ctx, next);
    } catch (error) {
      console.warn('[rowDrawer] 标题保存失败', error);
      showHint(ctx, `标题保存失败：${error?.message || error}`);
    } finally {
      restore();
    }
  };

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void finish(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // 抽屉自己也监听 Esc（openDrawer 在 document 捕获阶段绑的，先于这里执行），
      // 所以按 Esc 的实际结果是「抽屉关闭 + 本次标题改动不保存」——这正是我们想要的语义。
      // 这里只负责把输入框收回去（抽屉被移除时 blur 不一定触发，不能指望它）。
      void finish(false);
    }
  });
  input.addEventListener('blur', () => {
    void finish(true);
  });
}

// ==========================================
// 正文就地编辑（T05a）
// ==========================================
//
// 交互只有三条，刻意的少：
//   点正文 → 进编辑态（textarea 自适应高度，光标落末尾）
//   Ctrl/⌘+Enter → 保存并退出
//   Esc → 放弃本次修改，回到原值的 markdown 预览
// **不在 blur 上保存**：点「上一条」/ 点子项时 blur 先于 click 触发，
// 自动保存会和「正在切换记录」打架（轻则多一次写库，重则把 A 的正文写到 B 上）。

function bindBodyEditor(ctx) {
  const host = section(ctx, 'body')?.querySelector('[data-body]');
  if (!host) return;
  host.addEventListener('click', event => {
    if (event.target.closest('[data-body-edit]')) return;
    // 正文里的链接要能点，其余位置一律进编辑态
    if (event.target.closest('a')) return;
    startBodyEdit(ctx);
  });
}

function startBodyEdit(ctx) {
  const host = section(ctx, 'body')?.querySelector('[data-body]');
  if (!host || ctx.bodyEditing) return;

  // 库里的正文还没到位（openRowDrawer 是同步的，getRecord 是毫秒级但终究是异步）。
  // 这一段空档里 .rd-body 显示的是 preload，用户此刻点进来、敲两下、关掉，
  // 就会拿「preload + 新键入」把库里的真正文整段覆盖 —— 宁可让他多点一次。
  // 窗口只有一个本地查询的时间，感知不到。
  if (!ctx.recordReady) return;

  const textarea = document.createElement('textarea');
  textarea.className = 'rd-body-edit';
  textarea.setAttribute('data-body-edit', '');
  textarea.setAttribute('aria-label', '编辑正文');
  textarea.spellcheck = false;
  textarea.value = ctx.bodySource;
  // 记下「进编辑时的原值」，applyRecord 只在「用户一个字没敲」时才敢替换它
  ctx.bodyEditOriginal = textarea.value;

  host.classList.remove('is-empty');
  host.classList.add('is-editing');
  host.innerHTML = '';
  host.appendChild(textarea);
  ctx.bodyEditing = true;

  autoGrowBody(textarea);
  textarea.focus();
  // 光标置末尾：用户点进来就是要接着往下写
  const end = textarea.value.length;
  textarea.setSelectionRange(end, end);

  textarea.addEventListener('input', () => autoGrowBody(textarea));
  textarea.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void exitBodyEdit(ctx, { discard: false });
    }
  });

  // Esc 必须拦在 openDrawer 的监听之前。那一层绑在 document 的**捕获**阶段，
  // 而捕获是 window → document → … → 目标，所以只有 window 捕获阶段的监听器
  // 比它更早。不这么做的话，按 Esc 会连抽屉一起关掉，「放弃修改」就成了「关窗丢字」。
  const onKeyCapture = event => {
    if (event.key !== 'Escape') return;
    // 只处理「在编辑框里按的 Esc」：用户可能已经点去别的单元格编辑，
    // 那时 Esc 应该是那一格/抽屉的事，不该被这里截走。
    if (event.target !== textarea) return;
    event.preventDefault();
    event.stopPropagation();
    void exitBodyEdit(ctx, { discard: true });
  };
  ctx.bodyKeyCapture = onKeyCapture;
  window.addEventListener('keydown', onKeyCapture, true);
}

/**
 * 退出编辑态。
 * @param {object} ctx 抽屉上下文
 * @param {{discard?: boolean}} opts discard=true 表示放弃修改（Esc），否则保存（Ctrl+Enter）
 */
async function exitBodyEdit(ctx, { discard = false } = {}) {
  const host = section(ctx, 'body')?.querySelector('[data-body]');
  if (!ctx.bodyEditing || !host) return;

  const textarea = host.querySelector('[data-body-edit]');
  const value = String(textarea?.value ?? '');
  ctx.bodyEditing = false;
  host.classList.remove('is-editing');
  teardownBodyKeyCapture(ctx);

  if (discard) {
    // 回到「库里的值」。ctx.bodySource 只在保存成功或打开抽屉时更新，
    // 所以这里天然是原文，不需要额外缓存一份。
    await renderBody(ctx, ctx.bodySource);
    return;
  }

  const recordId = ctx.recordId ?? state.recordId;
  // 先把用户敲的内容显示出来（保存是异步的，别让画面闪回旧文）
  await renderBody(ctx, value);
  // 一个字没改就退出：不写库（省一次 UPDATE，也免得白抬 updated_at）
  if (value === state.bodyBaseline) return;
  const ok = await writeBody(ctx, recordId, value);
  if (ok) {
    // 只有写成功才认这个值为「库里的值」：写失败时 bodySource 保持旧值，
    // 草稿进了 state.pendingBody，关抽屉时会再补写一次。
    ctx.bodySource = value;
    state.bodyBaseline = value;
  }
}

function teardownBodyKeyCapture(ctx) {
  if (!ctx || !ctx.bodyKeyCapture) return;
  window.removeEventListener('keydown', ctx.bodyKeyCapture, true);
  ctx.bodyKeyCapture = null;
}

/**
 * 抽屉被外部关掉时的收尾（onClose 里调）：编辑态没退就退掉，
 * 不留下一个指向已销毁 DOM 的 window 监听器。
 */
function teardownBodyEditor(ctx) {
  teardownBodyKeyCapture(ctx);
  ctx.bodyEditing = false;
  section(ctx, 'body')?.querySelector('[data-body]')?.classList.remove('is-editing');
}

function autoGrowBody(textarea) {
  // height 先归 auto 才能拿到真实 scrollHeight，否则只会一路变大
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(160, textarea.scrollHeight)}px`;
}

/**
 * **同步**抓取未落库的正文草稿。返回 null 的三种情况：
 *   没有编辑框 / 值是空的同一个值（没改过）/ 不知道是哪条记录。
 *
 * 抓到值后立刻把基线推进到新值 —— 写库是异步的，这期间可能又触发一次 flush
 * （openRowDrawer → closeAllPanels → onClose 就是连着的），不推进就会写两遍。
 *
 * @returns {{recordId:number, body:string}|null}
 */
function captureBodyDraft() {
  const input = state.el?.querySelector('[data-body-edit]');
  if (!input || state.recordId === null) return null;

  const value = String(input.value ?? '');
  if (value === state.bodyBaseline) return null;

  state.bodyBaseline = value;
  return { recordId: state.recordId, body: value };
}

/**
 * 写 record.body。失败不静默：日志文件 + 抽屉提示条（ctx 存在时）+ 留下 pending 草稿。
 *
 * @param {object|null} ctx 抽屉上下文（关抽屉时已没有，只写日志）
 * @param {number|null} recordId
 * @param {string} body
 * @returns {Promise<boolean>}
 */
async function writeBody(ctx, recordId, body) {
  const id = toId(recordId);
  if (id === null) return false;
  try {
    await patchRecord(id, { body });
    if (state.pendingBody && state.pendingBody.recordId === id) state.pendingBody = null;
    return true;
  } catch (error) {
    const message = error?.message || String(error);
    console.error('[rowDrawer] 正文保存失败', error);
    logToFile('error', `[rowDrawer] 正文保存失败 record=${id}: ${message}`);
    state.pendingBody = { recordId: id, body };
    if (ctx) showHint(ctx, `正文保存失败：${message}`);
    return false;
  }
}

// ==========================================
// 小工具
// ==========================================

function alive(token) {
  return token === state.token && Boolean(state.el && state.el.isConnected);
}

function section(ctx, name) {
  return ctx.el?.querySelector(`[data-section="${name}"]`) || null;
}

function setTitle(ctx, text) {
  const el = ctx.el?.querySelector('.sh-drawer-title');
  if (el) el.textContent = String(text ?? '');
}

function setKicker(ctx, text) {
  const el = ctx.el?.querySelector('.sh-drawer-kicker');
  if (el) el.textContent = String(text ?? '');
}

function showHint(ctx, text) {
  const el = section(ctx, 'hint');
  if (!el) return;
  el.textContent = String(text ?? '');
  el.hidden = !el.textContent;
}

function crumbLabel(item) {
  return recordTitle(item);
}

function recordTitle(item) {
  const title = String(item?.title ?? '').trim();
  return title || `#${item?.id ?? '?'}`;
}

function statusText(item) {
  // 表格行不显示状态：record 表给 sheet_row 的 status 永远是建行时的默认值 'done'
  // （见 recordStore.createRecord），没有任何地方会改它。挂在子项列表里就是每行
  // 都写「已完成」，纯噪音。表格行真正的状态在它自己的单选字段里，由字段网格呈现。
  if (item?.kind === 'sheet_row') return '';
  return STATUS_LABELS[item?.status] || String(item?.status ?? '') || KIND_LABELS[item?.kind] || '';
}

function plainTextHtml(text) {
  return `<div class="rd-body-text">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;
}
