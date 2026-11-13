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
import {
  listNotes,
  writeNote,
  addNoteRecord,
  removeNoteRecord,
  normalizeRecordIds,
} from './notesStore.js';
import { renderMarkdown, extractExcerpt } from './markdown.js';
import { logToFile } from './logger.js';

/**
 * 抽屉宽度（v1.2 起按视口算，不再是固定 560）。
 *
 * 设计稿约 48%（@1360 → 652px）。上下限的来历：
 *   上限 720 —— 再宽正文行长会超 60 个汉字，读起来要摆头；
 *   下限 520 —— 两列字段网格每列 (520 − 48 内边距 − 28 列间距) / 2 = 222px，
 *               刚好放得下 62px label + 160px 值（「下次大修核对润滑脂牌号」11 字 ≈ 154px）。
 *   < 800 只会在用户把窗口拉得比设计最小窗口还小时出现，保留 16px 边距即可。
 *
 * ★ 打开后**不**监听 resize 重算宽度 ★
 *   抽屉生命周期以秒计，加一个 resize 监听就多一个必须在每条关闭路径上都摘掉的监听器，
 *   漏摘就是内存泄漏（见 openDrawer 的 onClose / closeRowDrawer / teardown* 三处）。
 *   用户改完窗口大小后重开抽屉即生效。
 *
 * @param {number} viewportWidth window.innerWidth
 * @returns {number} 抽屉宽度（px，整数）
 */
function drawerWidthFor(viewportWidth) {
  const vw = Number(viewportWidth) > 0 ? Number(viewportWidth) : 1360;
  const preferred = Math.min(720, Math.max(520, vw * 0.48));
  return Math.floor(Math.max(320, Math.min(preferred, vw - 32)));
}

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
    // ---- 关联笔记 ----
    // notesReady 与 recordReady 是**两件独立的事**：正文走 recordStore，笔记走文件系统，
    // 谁先回来不一定。共用一个标志会让「笔记已经到了但正文没到」时笔记区点不动。
    // 语义同样统一：false = 数据还没到，此时**任何**笔记操作都直接 return（不猜、不跳空页）。
    notesReady: false,
    // 当前记录挂着的笔记（notes_list 里 record_ids 含本记录 id 的那批）
    notes: [],
    // 面板态：'' = 收起 / 'create' = 新建 / 'link' = 关联已有
    notePanel: '',
    // 关联已有面板的数据源（全量笔记）。只在面板打开时取一次，关掉即丢弃。
    noteCandidates: null,
    // 关联已有面板的筛选词
    noteFilter: '',
    // 待确认「改挂」的笔记（已关联到别的记录，需要用户点一下确认）
    noteMoving: null,
    // 面板打开时挂的 window 捕获 Esc 监听器
    noteKeyCapture: null,
    // 新建中的防连点闸
    noteCreating: false,
    // 成功类提示条的自动收起定时器（关抽屉时必须清掉）
    hintTimer: null,
    // ---- 字段网格（v1.2）----
    // gridFields = 真正渲染成网格的那批字段。与 visibleFields 的差别只有一条：
    // 值与大标题**逐字相同**的字段不渲染（截图里「设备名称 = 2 号机组前置泵驱动端轴承」
    // 白占一整行）。ctx.fields 仍保留全量 —— onCellClick 按 data-key 找字段、
    // startTitleEdit 找 titleField 的格子都靠它。
    gridFields: [],
    // ---- 结构块（v1.2：子项 + 挂载的表合并，默认收起）----
    // 两个异步分区各自到达，计数要等两边都可能有值才画，所以存下来而不是直接写 DOM。
    structChildren: [],
    structSheets: [],
    // ---- footer「⋯」菜单 ----
    // 菜单打开时挂的 window 捕获 Esc / document 捕获 mousedown（关抽屉时必须摘掉）
    menuKeyCapture: null,
    menuOutside: null,
  };

  const initialTitle = resolveTitle(ctx);
  const initialKicker = String(options.subtitle ?? '') || defaultKicker(preload);

  // 字段网格的「显示层过滤」：只删与大标题逐字相同的那些格子，不删字段本身。
  ctx.gridFields = filterGridFields(visibleFields, row, initialTitle);

  const bodyHtml = `
    <div class="rd">
      <div class="rd-hint" data-section="hint" hidden></div>

      <!-- ① 元信息行：一行装完面包屑 + 状态 chip + 日期（空值一律不占行） -->
      <div class="rd-meta-line" data-section="meta" hidden>
        <nav class="rd-crumbs" data-list="crumbs" aria-label="上级路径"></nav>
        <span class="rd-status-chip" data-status-chip hidden></span>
        <span class="rd-meta-when" data-meta-when hidden></span>
      </div>

      <!-- ② 正文：不放 h3 标题 —— 它就在页面第二行，标题纯占位 -->
      <section class="rd-body-block" data-section="body">
        <div class="rd-body markdown-body" data-body></div>
      </section>

      <!-- ③ 字段：.sh-detail 在层 9 变成两列网格，DOM 结构不变 -->
      <div class="rd-block rd-fields" data-section="fields"${ctx.gridFields.length ? '' : ' hidden'}>
        ${fieldsHtml(ctx.gridFields, row)}
      </div>

      <!-- ④ 笔记：标题带计数，空态是一行「＋挂一篇笔记」 -->
      <section class="rd-block" data-section="notes">
        <h3 class="rd-h">笔记<span class="rd-h-count" data-notes-count>· 0</span></h3>
        <div class="rd-notes" data-notes>
          <span class="rd-empty">加载中…</span>
        </div>
        <div class="rd-note-panel" data-notes-panel hidden></div>
        <div class="rd-notes-foot" data-notes-foot hidden>
          <button type="button" class="rd-link-btn" data-note-create>新建笔记</button>
          <button type="button" class="rd-link-btn" data-note-pick-link>挂一篇已有的</button>
        </div>
      </section>

      <!-- ⑤ 结构：子项 + 挂载的表合成一块，默认收起（两者皆空则整块不出现） -->
      <section class="rd-block" data-section="structure" hidden>
        <div class="rd-struct-head" data-struct-toggle role="button" tabindex="0"
             aria-expanded="false" aria-controls="rd-struct-body">
          <span class="rd-struct-label">结构</span>
          <span class="rd-struct-count" data-struct-count></span>
          <svg class="rd-caret" aria-hidden="true"><use href="#ic-chevron-right"/></svg>
        </div>
        <div class="rd-struct-body" id="rd-struct-body" data-struct-body hidden>
          <div class="rd-sub" data-section="children" hidden>
            <div class="rd-sub-h">子项</div>
            <div class="rd-list" data-list="children"></div>
          </div>
          <div class="rd-sub" data-section="sheets" hidden>
            <div class="rd-sub-h">挂载的表</div>
            <div class="rd-sheets" data-list="sheets"></div>
          </div>
        </div>
      </section>

      <!-- ⑥ 被引用于：仅非空才出现（默认 hidden，不留「暂无引用」占位） -->
      <section class="rd-block" data-section="backlinks" hidden>
        <h3 class="rd-h">被引用于</h3>
        <div class="rd-backlinks" data-list="backlinks"></div>
      </section>
    </div>`;

  const drawer = openDrawer({
    title: initialTitle,
    subtitle: initialKicker,
    width: drawerWidthFor(window.innerWidth),
    body: bodyHtml,
    footer: footerHtml(index, total, handlers),
    onClose: () => {
      // 点遮罩 / 点 × / Esc 关抽屉走的是这条路（sheetPage 的上一条/下一条是
      // 先 closeAllPanels 再开新抽屉，同样经过这里）。closeAllPanels 是
      // 「先摘节点、后调 onClose」，所以这里 state.el 还在，只是脱离了文档 ——
      // querySelector 照样能取到编辑框的值，草稿不会丢。
      void flushDrawerBody();
      teardownBodyEditor(ctx);
      teardownNotePanel(ctx);
      closeMenu(ctx);
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

/**
 * 调用方没给 subtitle 时的头部小字：**只放记录类型**。
 *
 * v1.2 之前这里还拼了 `status` 与 `happened_*`，但这两样现在归元信息行
 * （结果 / 状态 chip / 日期），kicker 再写一遍就是同一句话出现两次 ——
 * 截图里「记录 · 待整理 · 2026-11-13 07:45」下面紧跟「待整理 主设备诊断 / 3 号机组 · 2026-11-13 07:45」。
 *
 * @param {object|null} record 部分记录（could be preload）
 * @returns {string} kicker 文案
 */
function defaultKicker(record) {
  if (!record) return '';
  return KIND_LABELS[record.kind] || '';
}

/**
 * 字段网格的「显示层」过滤：值与大标题**逐字相同**的字段不渲染那一格。
 *
 * 只删「逐字相同」，不删「标题字段本身」—— 值不同时它是有信息的。
 * 也不做任何「多于 N 个就折叠」的处理：字段就是这条记录的结论，藏起来等于让用户
 * 多点一次才知道结论是什么（设计 §3.1 末段已明确否决折叠）。
 *
 * @param {object[]} fields 可见字段
 * @param {object|null} row 行（含 values）
 * @param {string} titleText 大标题（已 trim）
 * @returns {object[]} 要渲染的字段
 */
function filterGridFields(fields, row, titleText) {
  const title = String(titleText ?? '').trim();
  if (!fields.length) return [];
  if (!title) return fields.slice();
  return fields.filter(field => String(row?.values?.[field.key] ?? '').trim() !== title);
}

function fieldsHtml(gridFields, row) {
  if (!gridFields.length) return '';
  const cells = gridFields
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

/**
 * footer 的内容（不含 `<footer>` 本身，那层壳由 openDrawer 建）。
 *
 * 布局：左「最后编辑 …」，右「⋯ / 上一条 / 下一条」，4 个兼容动作与「删除记录」收进「⋯」。
 * ★ 这里**不能**用 openPopover（sheetPanels.js）★
 *   那个函数第一行就是 closeAllPanels()，而抽屉本身就是 activePanel ——
 *   用它做菜单等于「点一下 ⋯ 抽屉自己关掉」。菜单是 footer 内的绝对定位块（见层 9 的 9.6）。
 *
 * footer 现在**常显**（哪怕只有一行时间）：底栏突然消失比一条只有时间的底栏更像坏了。
 *
 * @param {number} index 当前行在结果里的序号（从 1 起，0 = 未知）
 * @param {number} total 结果总数（0 = 未知）
 * @param {object} handlers 归一后的 handlers
 * @returns {string} footer 内部 HTML
 */
function footerHtml(index, total, handlers) {
  const actions = Array.isArray(handlers.actions) ? handlers.actions : [];
  const hasDelete = typeof handlers.onDelete === 'function';
  // 一个菜单项都没有就别渲染「⋯」—— 点开是空盒子比没有入口更糟
  const hasMenu = hasDelete || actions.length > 0;
  const hasNav = typeof handlers.onPrev === 'function' || typeof handlers.onNext === 'function';

  const actionItems = actions
    .map(
      item =>
        `<button type="button" class="rd-menu-item" role="menuitem" data-action-key="${escapeHtml(
          item.key
        )}">${escapeHtml(item.label || item.key)}</button>`
    )
    .join('');

  const menu = hasMenu
    ? `<button type="button" class="rd-foot-btn" data-more aria-haspopup="menu" aria-expanded="false" aria-label="更多操作">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-dots"/></svg>
      </button>
      <div class="rd-menu" data-more-menu role="menu" hidden>
        ${actionItems}
        ${actionItems && hasDelete ? '<div class="rd-menu-sep" role="separator"></div>' : ''}
        ${hasDelete ? '<button type="button" class="rd-menu-item is-danger" role="menuitem" data-del>删除记录</button>' : ''}
      </div>`
    : '';

  const prevDisabled = index > 0 && index <= 1 ? 'disabled' : '';
  const nextDisabled = total > 0 && index > 0 && index >= total ? 'disabled' : '';
  const nav = hasNav
    ? `<button type="button" class="rd-foot-btn" data-prev ${prevDisabled}>上一条</button>
       <button type="button" class="rd-foot-btn" data-next ${nextDisabled}>下一条</button>`
    : '';

  return `<span class="rd-foot-when" data-foot-when></span>
    <span class="rd-foot-gap"></span>
    ${menu}
    ${nav}`;
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
    // 没有记录 id 就没有「关联到哪条记录」这件事。整块藏掉，而不是留一个永远点不动的
    // 「新建笔记 / 关联已有」—— 点了没反应比不显示更让人困惑。
    const block = section(ctx, 'notes');
    if (block) block.hidden = true;
    ctx.notesReady = true;
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
    loadNotes(ctx, token),
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
    if (!alive(token)) return;
    // 记录已被删除（getRecord 返回 null）：kicker 上说明一句，与 id 相关的区块全部收掉。
    // 「字段」与「笔记」都靠 id 才有意义，留着一个点不动的空网格比不显示更让人困惑。
    appendKicker(ctx, '记录已删除');
    const fieldsBlock = section(ctx, 'fields');
    if (fieldsBlock) fieldsBlock.hidden = true;
    const notesBlock = section(ctx, 'notes');
    if (notesBlock) notesBlock.hidden = true;
    return;
  }
  if (!alive(token)) return;
  ctx.record = record;

  // 标题：有字段时以行的值为准（表格首列才是真相），没有字段才用 record.title
  if (!ctx.displayField) setTitle(ctx, String(record.title ?? '').trim() || `未命名记录 #${record.id}`);

  // 头部小字：调用方给了就以调用方为准（表名 · 第 x / y 条），没给就用记录自身的类型
  if (!ctx.kickerProvided) setKicker(ctx, defaultKicker(record));

  // 元信息行：面包屑由 loadCrumbs 填，状态 chip / 标签 / 时间这里填。
  // 完全没有字段（随手记 / 待办 / 子项）时状态也走 chip；有字段网格时状态就是网格里的一格，
  // 两处都显示就是刚从字段区删掉的那种重复。
  renderMetaLine(ctx, record);

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
 * 面包屑：自根到父，填进元信息行里的 `[data-list="crumbs"]`。
 * 根为空（顶层记录）时容器留空，元信息行是否显示由 updateMetaLineVisibility 统一裁决。
 * 点击留给 T09 接跳转，现在只打点，不做假动作。
 */
async function loadCrumbs(ctx, token) {
  const chain = await listAncestors(ctx.recordId);
  if (!alive(token) || !chain.length) return;
  const el = section(ctx, 'meta')?.querySelector('[data-list="crumbs"]');
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
  // 面包屑到位后标签段要让位（两者高度重合），时间/截止段不受影响。
  composeMetaWhen(ctx);
  updateMetaLineVisibility(ctx);
}

async function loadChildren(ctx, token) {
  const children = await listChildren(ctx.recordId);
  if (!alive(token)) return;
  ctx.structChildren = Array.isArray(children) ? children.filter(Boolean) : [];

  const sub = section(ctx, 'children');
  const list = sub?.querySelector('[data-list="children"]');
  if (!sub || !list) return;

  list.innerHTML = ctx.structChildren
    .map(
      child => `<button type="button" class="rd-row-item" data-child-id="${escapeHtml(child.id)}">
        <span class="rd-row-title">${escapeHtml(recordTitle(child))}</span>
        <span class="rd-row-meta">${escapeHtml(statusText(child))}</span>
      </button>`
    )
    .join('');
  sub.hidden = !ctx.structChildren.length;
  updateStructure(ctx);
}

async function loadChildSheets(ctx, token) {
  const sheets = await listChildSheets(ctx.recordId);
  if (!alive(token)) return;
  ctx.structSheets = Array.isArray(sheets) ? sheets.filter(Boolean) : [];

  const sub = section(ctx, 'sheets');
  const list = sub?.querySelector('[data-list="sheets"]');
  if (!sub || !list) return;

  list.innerHTML = ctx.structSheets
    .map(
      sheet => `<button type="button" class="rd-sheet-card" data-sheet-id="${escapeHtml(sheet.id)}">
        <span class="rd-sheet-name">${escapeHtml(String(sheet.name ?? '').trim() || `表 #${sheet.id}`)}</span>
        <span class="rd-sheet-meta">${escapeHtml(`${Number(sheet.row_count) || 0} 行 · ${Number(sheet.field_count) || 0} 列`)}</span>
      </button>`
    )
    .join('');
  sub.hidden = !ctx.structSheets.length;
  updateStructure(ctx);
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

// ==========================================
// 元信息行（v1.2：替代原来的「记录信息网格」renderMetaRows）
// ==========================================
//
// 旧做法是给无字段记录（随手记 / 待办 / 子项）画一屏「类型 / 状态 / 标签 / 发生时间 /
// 截止 / 备注 / 所属表」——对刚建的记录几乎全是空值，白白把正文顶到折叠线以下。
// 新做法只有一行 22px：面包屑 + 状态 chip + 标签/时间，**空值一律不占行**（连 span 都不留），
// 整行都没内容时 `[data-section=meta]` 自己 hidden，不占高度。

/**
 * 填元信息行。
 *
 * 状态只显示一次（设计 §3.5 决策 4）：
 *   有字段网格 → 状态就是网格里的一格，chip 不出现；
 *   没有字段网格 → `record.status` 映射成 chip。
 * 这条规则同时挡掉了「标题旁 chip + 字段区状态」这种重复。
 *
 * @param {object} ctx 抽屉上下文
 * @param {object} record 完整记录
 */
function renderMetaLine(ctx, record) {
  const line = section(ctx, 'meta');
  if (!line) return;

  // —— 状态 chip：只在没有字段网格时出现 ——
  const chip = line.querySelector('[data-status-chip]');
  const statusFieldInGrid = ctx.gridFields.some(field => String(field?.key ?? '') === 'status');
  const statusLabel = STATUS_LABELS[record.status] || String(record.status ?? '').trim();
  if (chip) {
    const showChip = ctx.gridFields.length === 0 && !statusFieldInGrid && statusLabel !== '';
    chip.textContent = showChip ? statusLabel : '';
    chip.hidden = !showChip;
  }

  // —— 标签 / 发生时间 / 截止：能装进一行才写，空值连分隔符都不留 ——
  // 标签段存进 ctx，由 composeMetaWhen 统一裁决要不要上屏：
  // 面包屑（异步后到）给出「表 · 父行」路径时，tag/sub_tag 与它高度重合
  // （台账行的主分类就是表名、子项目常常就是父行），再写一遍就是「信息太散」。
  const tags = [record.tag, record.sub_tag]
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
    .join(' / ');
  const happened = [record.happened_date, String(record.happened_time ?? '').slice(0, 5)]
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const deadline = String(record.deadline ?? '').trim();
  ctx.metaTags = tags;
  ctx.metaWhenParts = { happened, deadline };
  composeMetaWhen(ctx);

  updateMetaLineVisibility(ctx);
  paintFootWhen(ctx, record);
}

/**
 * 组装元信息行的「时间 / 标签」段。
 *
 * 标签段只在**没有面包屑**时出现（面包屑后到，所以这里要在 loadCrumbs 里再调一次）。
 * 发生时间 / 截止不受面包屑影响，始终参与。
 * @param {object} ctx 抽屉上下文
 */
function composeMetaWhen(ctx) {
  const when = section(ctx, 'meta')?.querySelector('[data-meta-when]');
  if (!when) return;
  const crumbs = section(ctx, 'meta')?.querySelector('[data-list="crumbs"]');
  const hasCrumbs = Boolean(crumbs && !crumbs.hidden && crumbs.textContent.trim());
  const parts = [];
  if (!hasCrumbs && ctx.metaTags) parts.push(ctx.metaTags);
  if (ctx.metaWhenParts?.happened) parts.push(ctx.metaWhenParts.happened);
  if (ctx.metaWhenParts?.deadline) parts.push(`截止 ${ctx.metaWhenParts.deadline}`);
  when.textContent = parts.join(' · ');
  when.hidden = !when.textContent;
}

/**
 * 元信息行的显隐：三个子元素全空就整行 hidden（22px 也要省，正文首行靠它进首屏）。
 * @param {object} ctx 抽屉上下文
 */
function updateMetaLineVisibility(ctx) {
  const line = section(ctx, 'meta');
  if (!line) return;
  const crumbs = line.querySelector('[data-list="crumbs"]');
  const chip = line.querySelector('[data-status-chip]');
  const when = line.querySelector('[data-meta-when]');
  const hasCrumbs = Boolean(crumbs && !crumbs.hidden && crumbs.textContent.trim());
  const hasChip = Boolean(chip && !chip.hidden && chip.textContent.trim());
  const hasWhen = Boolean(when && !when.hidden && when.textContent.trim());
  line.hidden = !(hasCrumbs || hasChip || hasWhen);
}

/** 在 kicker 后面追加一段说明（记录已删除之类），已追加过就不重复加。 */
function appendKicker(ctx, suffix) {
  const el = ctx.el?.querySelector('.sh-drawer-kicker');
  if (!el) return;
  const text = String(el.textContent ?? '').trim();
  const tail = String(suffix ?? '').trim();
  if (!tail || text.includes(tail)) return;
  el.textContent = text ? `${text} · ${tail}` : tail;
}

/**
 * footer 左侧「最后编辑 10 分钟前」。
 *
 * 相对时间只在抽屉打开时算一次，**不设定时器**：抽屉生命周期以秒计，
 * 一个每 30 秒 reflow 一次的定时器换来「刚才→1 分钟前」的滚动，收益为零、泄漏风险为正。
 *
 * @param {object} ctx 抽屉上下文
 * @param {object} record 完整记录
 */
function paintFootWhen(ctx, record) {
  const el = ctx.el?.querySelector('[data-foot-when]');
  if (!el) return;
  el.textContent = footWhenText(record);
}

/**
 * @param {object|null} record 记录
 * @returns {string} 「最后编辑 …」文案；没有时间戳时返回空串（footer 只剩右侧按钮）
 */
function footWhenText(record) {
  const raw = String(record?.updated_at ?? '').trim();
  if (!raw) return '';
  const then = parseStamp(raw);
  if (!then) return `最后编辑 ${raw.slice(0, 10)}`;
  const diff = Date.now() - then.getTime();
  if (diff < 60 * 1000) return '最后编辑 刚刚';
  const minutes = Math.floor(diff / (60 * 1000));
  if (minutes < 60) return `最后编辑 ${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `最后编辑 ${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `最后编辑 ${days} 天前`;
  return `最后编辑 ${raw.slice(0, 10)}`;
}

/**
 * 解析 `YYYY-MM-DD HH:mm[:ss]`（本地时区，无时区后缀，见 design §8.3）。
 * 不用 `new Date(string)`：那会按 ISO/UTC 规则猜，跨时区时差 8 小时。
 *
 * @param {string} raw 时间戳
 * @returns {Date|null} 解析失败返回 null
 */
function parseStamp(raw) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(raw ?? ''));
  if (!m) return null;
  const date = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0)
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

// ==========================================
// 事件
// ==========================================

/**
 * 挂事件。三个委托各管一片：
 *   `.sh-drawer-body` —— 正文区的一切点击（附件 / 面包屑 / 子项 / 表卡片 / 笔记 / 单元格）；
 *   `footer`         —— 「⋯」菜单与上一条 / 下一条（**不是**同一个父节点，不能塞进 body 委托）；
 *   结构块折叠头      —— 它是 `<div role="button">`，Enter / Space 必须手写（见 §3.5 决策 3）。
 *
 * @param {object} ctx 抽屉上下文
 */
function bindEvents(ctx) {
  const drawer = ctx.el;
  const bodyEl = drawer.querySelector('.sh-drawer-body');
  bodyEl?.addEventListener('click', event => onBodyClick(ctx, event));
  // 笔记面板的输入框是动态换进来的，用委托绑定（面板重绘后不需要重挂）
  bodyEl?.addEventListener('input', event => onBodyInput(ctx, event));
  bodyEl?.addEventListener('keydown', event => onBodyKeydown(ctx, event));

  // footer 由 openDrawer 建（它只给 .sh-drawer-foot，不知道 rd- 前缀），这里补上类名，
  // 让层 9 的 `.rd-foot { position: relative }` 能承载绝对定位的「⋯」菜单。
  const foot = drawer.querySelector('.sh-drawer-foot');
  foot?.classList.add('rd-foot');
  foot?.addEventListener('click', event => onFootClick(ctx, event));

  bindStructureToggle(ctx);
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

  // ② 结构块折叠头（子项 + 挂载的表）。必须在「单元格」之前判：
  //    折叠头里没有 .sh-cell，但排在后面的分支越少越不容易被误伤。
  if (event.target.closest('[data-struct-toggle]')) {
    toggleStructure(ctx);
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

  // ⑥ 关联笔记：打开 / 解除关联 / 新建 / 关联已有 / 改挂确认
  const noteOpen = event.target.closest('[data-note-open]');
  if (noteOpen) {
    void openLinkedNote(ctx, noteOpen.dataset.noteOpen);
    return;
  }

  const noteUnlink = event.target.closest('[data-note-unlink]');
  if (noteUnlink) {
    void unlinkNote(ctx, noteUnlink.dataset.noteUnlink);
    return;
  }

  const noteCreate = event.target.closest('[data-note-create]');
  if (noteCreate) {
    openNotePanel(ctx, 'create');
    return;
  }

  // 底部「关联已有」入口（注意别和候选项的 data-note-pick 撞名）
  if (event.target.closest('[data-note-pick-link]')) {
    openNotePanel(ctx, 'link');
    return;
  }

  const notePick = event.target.closest('[data-note-pick]');
  if (notePick) {
    void pickCandidate(ctx, notePick.dataset.notePick);
    return;
  }

  if (event.target.closest('[data-note-submit]')) {
    void createNoteFromDrawer(ctx);
    return;
  }

  if (event.target.closest('[data-note-move]')) {
    const moving = ctx.noteMoving;
    if (moving) void linkNote(ctx, moving.rel);
    return;
  }

  if (event.target.closest('[data-note-cancel]')) {
    closeNotePanel(ctx);
    return;
  }

  // ⑦ 字段单元格 → 交给 sheetPage 挂上单元格编辑器
  const cell = event.target.closest('.sh-cell');
  if (!cell) return;
  const field = ctx.fields.find(item => item.key === cell.dataset.key);
  if (field) ctx.handlers.onCellClick?.(field, cell, ctx.row);
}

function onBodyInput(ctx, event) {
  const target = event.target;
  if (!target || typeof target.matches !== 'function' || !target.matches('[data-note-filter]')) return;
  // 只重画候选列表，不重画整个面板 —— 否则输入框节点被替换，光标当场丢
  ctx.noteFilter = String(target.value ?? '');
  renderPickList(ctx);
}

function onBodyKeydown(ctx, event) {
  const target = event.target;
  if (!target || typeof target.matches !== 'function') return;
  // 新建面板：回车 = 创建（和「创建并打开」按钮同一条路径）
  if (target.matches('[data-note-title]') && event.key === 'Enter') {
    event.preventDefault();
    void createNoteFromDrawer(ctx);
  }
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

// ==========================================
// footer 与「⋯」菜单
// ==========================================
//
// 为什么菜单是 footer 里的绝对定位块而不是 openPopover：
//   openPopover 第一行是 closeAllPanels()，而抽屉自己就是 activePanel ——
//   用它做菜单等于「点一下 ⋯ 抽屉自己关掉」。
//
// 为什么菜单项不用 body 的委托：菜单在 footer 里，不是 .sh-drawer-body 的后代，
//   冒泡永远到不了那个监听器。所以 footer 有自己的一份委托（onFootClick）。
//
// Esc 的唯一捕获者规则（design §3.5 决策 1）：笔记面板与菜单都挂 window 捕获，
//   同时挂两个时后挂的那个赢，顺序依赖太脆。所以**新开前先关旧的**，统一走 closeTransient。

/**
 * footer 点击委托。
 * @param {object} ctx 抽屉上下文
 * @param {MouseEvent} event 点击事件
 */
function onFootClick(ctx, event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  if (target.closest('[data-more]')) {
    toggleMenu(ctx);
    return;
  }

  const menuItem = target.closest('.rd-menu [data-action-key]');
  if (menuItem) {
    // 先收菜单再执行：动作常常会 closeAllPanels（打开弹窗 / 跳页），
    // 菜单跟着 DOM 一起没了，收尾就轮不到（aria-expanded 会卡在 true）。
    closeMenu(ctx);
    runAction(ctx, menuItem.dataset.actionKey);
    return;
  }

  if (target.closest('.rd-menu [data-del]')) {
    closeMenu(ctx);
    ctx.handlers.onDelete?.(ctx.row);
    return;
  }

  if (target.closest('[data-prev]')) {
    ctx.handlers.onPrev?.(ctx.row);
    return;
  }

  if (target.closest('[data-next]')) {
    ctx.handlers.onNext?.(ctx.row);
  }
}

/**
 * 开 / 关「⋯」菜单。
 * @param {object} ctx 抽屉上下文
 */
function toggleMenu(ctx) {
  const menu = ctx.el?.querySelector('[data-more-menu]');
  const btn = ctx.el?.querySelector('[data-more]');
  if (!menu || !btn) return;
  if (!menu.hidden) {
    closeMenu(ctx);
    return;
  }
  // 同一时刻只允许一个 Esc 捕获者：菜单开之前把笔记面板收掉
  closeTransient(ctx);

  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  bindMenuKeys(ctx);
}

/**
 * 关菜单（幂等：没开也能调）。
 * @param {object} ctx 抽屉上下文
 */
function closeMenu(ctx) {
  if (!ctx) return;
  teardownMenuKeys(ctx);
  const menu = ctx.el?.querySelector('[data-more-menu]');
  if (menu) menu.hidden = true;
  const btn = ctx.el?.querySelector('[data-more]');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/**
 * 菜单打开期间的 Esc / 点外部关闭。
 *
 * Esc 必须挂在 **window 捕获**：抽屉自己挂在 document 捕获（openDrawer 里），
 * 捕获顺序是 window → document，只有比它更早的 window 捕获才能抢在它前面 stopPropagation。
 */
function bindMenuKeys(ctx) {
  teardownMenuKeys(ctx);

  const onKey = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu(ctx);
  };

  const onDown = event => {
    const menu = ctx.el?.querySelector('[data-more-menu]');
    const btn = ctx.el?.querySelector('[data-more]');
    if (!menu || menu.hidden) return;
    if (menu.contains(event.target) || btn?.contains(event.target)) return;
    closeMenu(ctx);
  };

  window.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  ctx.menuKeyCapture = onKey;
  ctx.menuOutside = onDown;
}

/** 摘掉菜单的两条监听器。抽屉关闭时也要走一遍，不能留在 window / document 上。 */
function teardownMenuKeys(ctx) {
  if (!ctx) return;
  if (ctx.menuKeyCapture) {
    window.removeEventListener('keydown', ctx.menuKeyCapture, true);
    ctx.menuKeyCapture = null;
  }
  if (ctx.menuOutside) {
    document.removeEventListener('mousedown', ctx.menuOutside, true);
    ctx.menuOutside = null;
  }
}

/**
 * 临时浮层（笔记面板 / 「⋯」菜单）的统一收口：同一时刻只留一个 Esc 捕获者。
 * @param {object} ctx 抽屉上下文
 */
function closeTransient(ctx) {
  if (!ctx) return;
  if (ctx.notePanel) closeNotePanel(ctx);
  closeMenu(ctx);
}

// ==========================================
// 结构块（子项 + 挂载的表，默认收起）
// ==========================================

/**
 * 给折叠头补 Enter / Space。
 *
 * 折叠头刻意用 `<div role="button" tabindex="0">` 而不是 `<button>`：它长得不像按钮
 * （无底、无边框、无内边距），用 button 就要用 8 条 `!important` 去顶全局按钮规则
 * （styles.css:5608），用 div 则零对抗 —— 代价就是这两个键要手写。
 *
 * @param {object} ctx 抽屉上下文
 */
function bindStructureToggle(ctx) {
  const head = ctx.el?.querySelector('[data-struct-toggle]');
  if (!head) return;
  head.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    event.preventDefault();
    toggleStructure(ctx);
  });
}

/**
 * 展开 / 收起结构块。`aria-expanded` 与 `body.hidden` 是同一份状态的两个投影，
 * 样式（箭头旋转）只读 aria-expanded，所以两者必须同时改。
 * @param {object} ctx 抽屉上下文
 */
function toggleStructure(ctx) {
  const head = ctx.el?.querySelector('[data-struct-toggle]');
  const body = ctx.el?.querySelector('[data-struct-body]');
  if (!head || !body) return;
  const open = head.getAttribute('aria-expanded') === 'true';
  head.setAttribute('aria-expanded', open ? 'false' : 'true');
  body.hidden = open;
}

/**
 * 重算结构块计数并决定整块显隐。
 *
 * 计数只报存在的那一项（「4 个子项」/「1 张表」），两者皆空时整块 hidden ——
 * 不显示「0 个子项」（纯陈述、不提供动作）。
 *
 * @param {object} ctx 抽屉上下文
 */
function updateStructure(ctx) {
  const block = section(ctx, 'structure');
  if (!block) return;

  const childCount = ctx.structChildren.length;
  const sheetCount = ctx.structSheets.length;
  const parts = [];
  if (childCount) parts.push(`${childCount} 个子项`);
  if (sheetCount) parts.push(`${sheetCount} 张表`);

  const count = block.querySelector('[data-struct-count]');
  if (count) count.textContent = parts.join(' · ');

  block.hidden = parts.length === 0;
  if (!parts.length) {
    // 数据清空时把展开态一起复位：否则下次数据回来会「默认展开」，
    // 与「每次打开抽屉都收起」（design §8.6）不一致
    const head = block.querySelector('[data-struct-toggle]');
    const body = block.querySelector('[data-struct-body]');
    if (head) head.setAttribute('aria-expanded', 'false');
    if (body) body.hidden = true;
  }
}

// ==========================================
// 关联笔记（T05b）
//
// 关系定义：笔记**永远**以磁盘上的 .md 为唯一真相源，`record_id` 只是 front-matter
// 里的一行元数据。所以这里只有「挂上 / 解开」两个动作：
//   ① 不提供「删记录顺带删笔记」；解除关联只改元数据，文件一个字不动。
//   ② 不把笔记正文渲染进抽屉 —— 抽屉里的「正文」只属于 record.body，
//      两段正文并排出现的话，用户根本分不清自己在改哪一份。
//
// 时序：notesReady 与 recordReady 是两件独立的事（正文走 recordStore，笔记走文件系统，
// 谁先回来不一定），所以各有各的标志。notesReady=false 期间列表显示「加载中…」、
// 底部入口是 hidden —— 用户**点不到**任何东西，也就不存在「点了但数据没到」的中间态。
// ==========================================

/** 笔记时间戳，格式与 notesEditor.nowString 一致（文件名日期前缀靠它）。 */
function noteTimestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours()
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

async function loadNotes(ctx, token) {
  let all = [];
  try {
    all = await listNotes();
  } catch (error) {
    // notesStore.listNotes 内部已经 catch 过并打了日志，这里只是兜底：
    // 笔记区读挂了不能连累抽屉其它分区。
    console.warn('[rowDrawer] 笔记列表读取失败', error);
    all = [];
  }
  if (!alive(token)) return;

  const list = Array.isArray(all) ? all : [];
  // ★ 多值关联：判据是「这一组 id 里有我」，不是「唯一那个 id 等于我」★
  // v1.1 这里是 `toId(note.record_id) === ctx.recordId`，多值之后它只能匹配第一条，
  // 表现就是「挂了 3 篇只显示 1 篇」。统一走 normalizeRecordIds 收口：
  // 'null' / '' / 0 / NaN / 脏字符串全部被滤掉，不会出现单侧可见的幽灵关联。
  ctx.notes = list.filter(note => normalizeRecordIds(note?.record_ids).includes(ctx.recordId));
  // 排序：最近编辑倒序（R16）。listNotes 已经是按 updated_at 倒序的，但那条契约在
  // notesStore 里没有写死，这里显式排一次，别让「最近改的那篇置顶」依赖上游实现。
  ctx.notes.sort((a, b) => String(b?.updated_at ?? '').localeCompare(String(a?.updated_at ?? '')));
  // 数据就位之后才放开标志（顺序反了，用户就有机会在空列表上点「挂一篇已有的」）
  ctx.notesReady = true;
  renderNotes(ctx);
}

function renderNotes(ctx) {
  const host = section(ctx, 'notes');
  if (!host) return;
  const list = host.querySelector('[data-notes]');
  const foot = host.querySelector('[data-notes-foot]');
  const count = host.querySelector('[data-notes-count]');
  if (!list) return;

  if (!ctx.notesReady) {
    list.innerHTML = '<span class="rd-empty">加载中…</span>';
    if (foot) foot.hidden = true;
    return;
  }

  // 计数常显（包括 0）：「笔记 · 0」本身就是空态的一句陈述，
  // 藏起来会让「笔记」两个字的右边忽有忽无（R02 要求显示计数）。
  if (count) count.textContent = `· ${ctx.notes.length}`;

  list.innerHTML = ctx.notes.length ? ctx.notes.map((note, i) => noteRowHtml(note, i)).join('') : emptyNotesHtml();

  // 面板开着时底部入口收起：面板自带「取消」，看着两组按钮会以为其中一组是多余的
  if (foot) foot.hidden = Boolean(ctx.notePanel);
  // 列表为空时「挂一篇已有的」已经在空态那一行里了，底栏再放一次就是同一句话写两遍。
  // 「新建笔记」保留 —— 那是空态里没有的另一个入口。
  const linkEntry = foot?.querySelector('[data-note-pick-link]');
  if (linkEntry) linkEntry.hidden = ctx.notes.length === 0;
}

/**
 * 空态：一行虚线入口，**不写**「还没有关联笔记」。
 * 纯陈述不提供动作的文案，用户读完还得自己找按钮 —— 入口直接就是这一行。
 * @returns {string} HTML
 */
function emptyNotesHtml() {
  return '<button type="button" class="rd-note-empty" data-note-pick-link>＋挂一篇笔记</button>';
}

/**
 * 一篇关联笔记 = 「标题 + 更新日期 + 一行摘要」三行，外加悬停才出现的解除按钮。
 * 不打开也知道是哪篇（R10）。
 *
 * @param {object} note 笔记
 * @param {number} index 在列表里的位置（0 = 最近编辑的那篇）
 * @returns {string} HTML
 */
function noteRowHtml(note, index) {
  const rel = String(note?.rel_path ?? '');
  // 笔记文件已不在磁盘：显式占位，不可点、不给解除按钮。
  // 数据侧目前靠 Rust 侧下发 missing 标记（notes_list 若补上这个字段即可生效），
  // 没有标记时这一支不会命中 —— 但**不能**让「读不到文件」变成「静默消失」（R07 末条）。
  const missing = note?.missing === true || note?.is_missing === true;
  if (missing) {
    return `<div class="rd-note-item is-missing">
      <span class="rd-note-open is-dead" aria-disabled="true">
        <span class="rd-note-head">
          <span class="rd-row-title">已删除笔记</span>
          <span class="rd-row-meta">${escapeHtml(rel)}</span>
        </span>
      </span>
    </div>`;
  }

  const title = String(note?.title ?? '').trim() || '未命名笔记';
  const meta = noteMetaText(note);
  // 摘要取正文首个非空段落，Markdown 符号已剥离（extractExcerpt 负责）；
  // 一行 ellipsis 截断，长文在抽屉里不该变成一堵墙。
  const excerpt = extractExcerpt(String(note?.content ?? ''), 60);
  const fresh = index === 0 && isFreshNote(note) ? '<span class="rd-note-fresh">刚改过</span>' : '';

  return `<div class="rd-note-item">
      <button type="button" class="rd-row-item rd-note-open" data-note-open="${escapeHtml(
        rel
      )}" title="${escapeHtml(title)}">
        <span class="rd-note-head">
          <span class="rd-row-title">${escapeHtml(title)}</span>
          ${fresh}
          <span class="rd-row-meta">${escapeHtml(meta)}</span>
        </span>
        ${excerpt ? `<span class="rd-note-excerpt">${escapeHtml(excerpt)}</span>` : ''}
      </button>
      <button type="button" class="rd-note-unlink" data-note-unlink="${escapeHtml(
        rel
      )}" title="解除关联（只解挂，笔记文件保留）" aria-label="解除关联">×</button>
    </div>`;
}

/**
 * 笔记项的日期：**只显示日期**（`YYYY-MM-DD`）。列表中精确到分秒在窄栏里是噪音（§8.3）。
 * 取 updated_at（R10 要「更新日期」），没有才退回 created_at。
 *
 * @param {object} note 笔记
 * @returns {string} 日期文本
 */
function noteMetaText(note) {
  const updated = String(note?.updated_at ?? '').trim();
  const created = String(note?.created_at ?? '').trim();
  const source = updated || created;
  return source.length >= 10 ? source.slice(0, 10) : source;
}

/**
 * 「刚改过」只标最近 24 小时编辑过的那一篇：永远挂一个徽标等于没有徽标。
 * @param {object} note 笔记
 * @returns {boolean} 是否算「刚改过」
 */
function isFreshNote(note) {
  const then = parseStamp(String(note?.updated_at ?? ''));
  if (!then) return false;
  return Date.now() - then.getTime() < 24 * 60 * 60 * 1000;
}

// ---- 打开 / 解除关联 ----

async function openLinkedNote(ctx, relPath) {
  if (!ctx.notesReady) return;
  const rel = String(relPath ?? '');
  if (!rel) return;

  // 正文草稿必须先落库：closeRowDrawer 会同步销毁抽屉 DOM，之后再读编辑框只剩空串
  await flushDrawerBody();
  closeRowDrawer();

  // 先切页再开笔记：笔记页是 display:none 的子视图，视图没显示就 openNote 只是白读一遍。
  // 路由 id 是 'nav-notes'（main.js 的路由表里就叫这个；'nav-note' 会让 show() 静默 return）。
  try {
    await window.__wrRouteTo?.('nav-notes');
  } catch (error) {
    console.warn('[rowDrawer] 切换到笔记页失败', error);
  }

  // 动态 import 是硬性要求：本模块被全应用复用，顶层静态引 notesEditor 会把
  // notesEditor 的整条依赖链拉到抽屉的模块求值路径上，一旦哪天后者的依赖回头引到
  // 这里，就是文件头禁令里那种 ESM 循环（openDrawer 落进 TDZ，抽屉偶发打不开）。
  try {
    const { openNote } = await import('./notesEditor.js');
    await openNote(rel);
  } catch (error) {
    // 抽屉已经关了，没有提示条可用；留日志（GUI 应用没有控制台，这是唯一的现场）
    const message = error?.message || String(error);
    console.error('[rowDrawer] 打开笔记失败', error);
    logToFile('error', `[rowDrawer] 打开关联笔记失败 rel=${rel}: ${message}`);
  }
}

async function unlinkNote(ctx, relPath) {
  if (!ctx.notesReady) return;
  const rel = String(relPath ?? '');
  if (!rel) return;
  if (ctx.recordId === null) return;

  const note = ctx.notes.find(item => String(item?.rel_path ?? '') === rel) || null;
  const title = String(note?.title ?? '').trim() || '这篇笔记';

  try {
    // ★ 只摘「当前这条记录」这一个 id ★
    // 不能用 setNoteRecord / setNoteRecords([])：前者清空关联（笔记可能还挂着别的记录），
    // 后者整组替换。removeNoteRecord 在 Rust 侧只删这一个 id，其余原样保留，
    // 而且只改 front-matter，**永远不删笔记文件**。
    await removeNoteRecord(rel, ctx.recordId);
  } catch (error) {
    const message = error?.message || String(error);
    console.error('[rowDrawer] 解除关联失败', error);
    logToFile('error', `[rowDrawer] 解除笔记关联失败 rel=${rel} record=${ctx.recordId}: ${message}`);
    showHint(ctx, `解除关联失败：${message}`);
    return;
  }

  ctx.notes = ctx.notes.filter(item => String(item?.rel_path ?? '') !== rel);
  renderNotes(ctx);
  showHint(ctx, `已解除关联：${title}（笔记仍在笔记页）`);
  scheduleHintClear(ctx);
}

/** 成功类提示不常驻：3.5 秒后收掉，免得抽屉开着时一直挂一行「已解除关联」。 */
function scheduleHintClear(ctx) {
  if (ctx.hintTimer) clearTimeout(ctx.hintTimer);
  ctx.hintTimer = setTimeout(() => {
    ctx.hintTimer = null;
    if (ctx.el?.isConnected) showHint(ctx, '');
  }, 3500);
}

// ---- 面板：新建 / 关联已有（不新开弹层，就地在笔记区里展开） ----

function openNotePanel(ctx, mode) {
  // 数据没到就别开面板：开出来也是空列表，还不如让按钮先别出现
  if (!ctx.notesReady || ctx.recordId === null) return;
  const panel = section(ctx, 'notes')?.querySelector('[data-notes-panel]');
  if (!panel) return;

  // 同一时刻只允许一个 Esc 捕获者：面板开之前把「⋯」菜单收掉（§3.5 决策 1）
  closeTransient(ctx);

  ctx.notePanel = mode;
  ctx.noteMoving = null;
  ctx.noteCandidates = null;
  ctx.noteFilter = '';
  panel.hidden = false;

  if (mode === 'create') {
    panel.innerHTML = createFormHtml();
    panel.querySelector('[data-note-title]')?.focus();
  } else {
    panel.innerHTML = pickerHtml();
    void fillNoteCandidates(ctx);
  }

  bindNotePanelKeys(ctx);
  renderNotes(ctx);
}

function closeNotePanel(ctx) {
  const panel = section(ctx, 'notes')?.querySelector('[data-notes-panel]');
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = '';
  }
  ctx.notePanel = '';
  ctx.noteCandidates = null;
  ctx.noteMoving = null;
  ctx.noteFilter = '';
  ctx.noteCreating = false;
  teardownNotePanelKeys(ctx);
  renderNotes(ctx);
}

function createFormHtml() {
  return `<div class="rd-note-form">
      <input type="text" class="rd-note-input" data-note-title placeholder="笔记标题" autocomplete="off">
      <div class="rd-note-tip" data-note-tip hidden></div>
      <div class="rd-note-actions">
        <button type="button" class="rd-link-btn is-primary" data-note-submit>创建并打开</button>
        <button type="button" class="rd-link-btn" data-note-cancel>取消</button>
      </div>
    </div>`;
}

function pickerHtml() {
  return `<div class="rd-note-picker">
      <input type="text" class="rd-note-input" data-note-filter placeholder="搜索标题 / 分类" autocomplete="off">
      <div class="rd-note-pick-list" data-note-pick-list><span class="rd-empty">加载中…</span></div>
      <div class="rd-note-confirm" data-note-confirm hidden></div>
      <div class="rd-note-tip" data-note-tip hidden></div>
      <div class="rd-note-actions">
        <button type="button" class="rd-link-btn" data-note-cancel>取消</button>
      </div>
    </div>`;
}

async function fillNoteCandidates(ctx) {
  const token = state.token;
  let all = [];
  try {
    all = await listNotes();
  } catch (error) {
    console.warn('[rowDrawer] 读取全部笔记失败', error);
    all = [];
  }
  // 面板可能在扫描期间被关掉 / 抽屉被换掉：两种情况都不该再往 DOM 里写
  if (!alive(token) || ctx.notePanel !== 'link') return;

  const linked = new Set(ctx.notes.map(item => String(item?.rel_path ?? '')));
  const list = Array.isArray(all) ? all : [];
  ctx.noteCandidates = list.filter(note => !linked.has(String(note?.rel_path ?? '')));
  renderPickList(ctx);
}

function renderPickList(ctx) {
  const panel = section(ctx, 'notes')?.querySelector('[data-notes-panel]');
  const host = panel?.querySelector('[data-note-pick-list]');
  if (!host) return;

  if (!ctx.noteCandidates) {
    host.innerHTML = '<span class="rd-empty">加载中…</span>';
    return;
  }

  const keyword = String(ctx.noteFilter ?? '').trim().toLowerCase();
  const matched = keyword
    ? ctx.noteCandidates.filter(note => noteSearchText(note).includes(keyword))
    : ctx.noteCandidates;

  if (!matched.length) {
    host.innerHTML = `<span class="rd-empty">${
      ctx.noteCandidates.length ? '没有匹配的笔记' : '没有可关联的笔记了'
    }</span>`;
    return;
  }

  host.innerHTML = matched.map(note => pickRowHtml(note)).join('');
}

function noteSearchText(note) {
  return [note?.title, note?.tag, note?.sub_tag, noteMetaText(note)].filter(Boolean).join(' ').toLowerCase();
}

function pickRowHtml(note) {
  const rel = String(note?.rel_path ?? '');
  const title = String(note?.title ?? '').trim() || '未命名笔记';
  // 多值之后不再有「被抢走」这回事：这篇笔记可以同时挂在多条记录上，
  // 所以这里改成报告它已经挂了几条（信息量与「已关联其他记录」等价，但没有误导）。
  const linkedCount = normalizeRecordIds(note?.record_ids).length;
  const parts = [noteMetaText(note)];
  if (linkedCount) parts.push(`已挂 ${linkedCount} 条`);
  const meta = parts.filter(Boolean).join(' · ');

  return `<button type="button" class="rd-row-item rd-note-pick-row" data-note-pick="${escapeHtml(
    rel
  )}" title="${escapeHtml(title)}">
      <span class="rd-row-title">${escapeHtml(title)}</span>
      ${meta ? `<span class="rd-row-meta">${escapeHtml(meta)}</span>` : ''}
    </button>`;
}

async function pickCandidate(ctx, relPath) {
  if (ctx.notePanel !== 'link' || !ctx.noteCandidates) return;
  const rel = String(relPath ?? '');
  if (!rel) return;

  const note = ctx.noteCandidates.find(item => String(item?.rel_path ?? '') === rel);
  if (!note) return;

  // 已经挂在别的记录上：照样能挂（多对多不会抢走任何关联），但要先说清楚，
  // 免得用户以为「挂过来 = 从那边摘掉」。
  const others = normalizeRecordIds(note?.record_ids).filter(id => id !== ctx.recordId);
  if (others.length) {
    await showMoveConfirm(ctx, note, others[0]);
    return;
  }
  await linkNote(ctx, rel);
}

/**
 * 「再挂一条」确认：说清「两边都保留」，然后再让用户点。
 * @param {object} ctx 抽屉上下文
 * @param {object} note 候选笔记
 * @param {number} ownerId 它已经挂着的一条记录的 id
 */
async function showMoveConfirm(ctx, note, ownerId) {
  const token = state.token;
  const title = String(note?.title ?? '').trim() || '这篇笔记';

  let ownerTitle = `#${ownerId}`;
  try {
    const owner = await getRecord(ownerId);
    if (owner) ownerTitle = String(owner.title ?? '').trim() || ownerTitle;
  } catch (error) {
    console.warn('[rowDrawer] 读取原关联记录失败', error);
  }
  if (!alive(token) || ctx.notePanel !== 'link') return;

  const panel = section(ctx, 'notes')?.querySelector('[data-notes-panel]');
  const box = panel?.querySelector('[data-note-confirm]');
  if (!box) return;

  ctx.noteMoving = { rel: String(note?.rel_path ?? ''), title };
  box.innerHTML = `<div class="rd-note-confirm-text">「${escapeHtml(title)}」已经挂在「${escapeHtml(
    ownerTitle
  )}」上，再挂到当前记录？（两边都会保留，那边不会少东西）</div>
    <div class="rd-note-actions">
      <button type="button" class="rd-link-btn is-primary" data-note-move>挂到当前记录</button>
      <button type="button" class="rd-link-btn" data-note-cancel>取消</button>
    </div>`;
  box.hidden = false;
  box.querySelector('[data-note-move]')?.focus();
}

async function linkNote(ctx, relPath) {
  const rel = String(relPath ?? '');
  if (!rel || ctx.recordId === null) return;

  try {
    // 追加一条关联（幂等）：不用 setNoteRecord —— 它会把已有其它关联一起清掉
    await addNoteRecord(rel, ctx.recordId);
  } catch (error) {
    const message = error?.message || String(error);
    console.error('[rowDrawer] 关联笔记失败', error);
    logToFile('error', `[rowDrawer] 关联笔记失败 rel=${rel} record=${ctx.recordId}: ${message}`);
    setPanelTip(ctx, `关联失败：${message}`);
    return;
  }

  closeNotePanel(ctx);
  // 重新扫一遍磁盘：front-matter 的最终值（尤其 rel_path）只有文件说了算，
  // 自己拼一个对象塞进列表，一旦 Rust 侧算出的路径不同就成了假数据。
  await loadNotes(ctx, state.token);
  showHint(ctx, '已关联笔记');
  scheduleHintClear(ctx);
}

async function createNoteFromDrawer(ctx) {
  if (ctx.notePanel !== 'create') return;
  const panel = section(ctx, 'notes')?.querySelector('[data-notes-panel]');
  const input = panel?.querySelector('[data-note-title]');
  const title = String(input?.value ?? '').trim();
  if (!title) {
    setPanelTip(ctx, '先写个标题');
    input?.focus();
    return;
  }
  // 连点两下不能建出两篇：按钮 disabled 之外再加一道闸
  if (ctx.noteCreating) return;
  ctx.noteCreating = true;
  const submit = panel?.querySelector('[data-note-submit]');
  if (submit) submit.disabled = true;

  // 记录可能还没到（applyRecord 失败时 ctx.record 为 null）：等一次已发出的 promise，
  // 不为它再查一次库。标签只是默认值，拿不到就落到「未分类」。
  let record = ctx.record;
  if (!record && ctx.recordPromise) {
    record = await ctx.recordPromise.catch(() => null);
  }

  const stamp = noteTimestamp();
  let saved = null;
  try {
    saved = await writeNote({
      id: null,
      title,
      content: '',
      note_type: 'idea',
      status: 'usable',
      tag: String(record?.tag ?? '').trim() || '未分类',
      sub_tag: String(record?.sub_tag ?? '').trim(),
      // ★ 新笔记也要走多值口径 ★
      // 只传 record_id 会退化成「兼容单值」路径（toNoteDoc 里 record_ids 缺席时才用它），
      // 一旦将来这条新笔记被再挂一条，第一次保存就会把旧的单值行写成 record_ids: [...]
      // —— 现在直接给数组，文件里从一开始就是新格式。
      record_ids: ctx.recordId === null ? [] : [ctx.recordId],
      // 空 created_at 会让文件名丢掉日期前缀（Rust 侧不做兜底），这里必须给准时间
      created_at: stamp,
      updated_at: stamp,
      rel_path: '',
      abs_path: '',
    });
  } catch (error) {
    const message = error?.message || String(error);
    console.error('[rowDrawer] 新建笔记失败', error);
    logToFile('error', `[rowDrawer] 新建关联笔记失败 record=${ctx.recordId}: ${message}`);
    setPanelTip(ctx, `创建失败：${message}`);
    if (submit) submit.disabled = false;
    ctx.noteCreating = false;
    return;
  }

  if (!saved) {
    setPanelTip(ctx, '创建失败：数据目录不可用');
    if (submit) submit.disabled = false;
    ctx.noteCreating = false;
    return;
  }

  // 写盘期间用户按 Esc 把面板收了：文章已经落盘，这时既不能装作没发生，
  // 也不该把他硬拽到笔记页 —— 留在这里把新笔记刷进列表，让他自己决定下一步。
  if (ctx.notePanel !== 'create') {
    await loadNotes(ctx, state.token);
    showHint(ctx, `已创建笔记：${title}`);
    scheduleHintClear(ctx);
    ctx.noteCreating = false;
    return;
  }

  // 建完直接把用户送进这篇笔记（新建的笔记是空的，停在抽屉里看不出「建成功了」）
  await openLinkedNote(ctx, saved.rel_path);
}

function setPanelTip(ctx, text) {
  const panel = section(ctx, 'notes')?.querySelector('[data-notes-panel]');
  const tip = panel?.querySelector('[data-note-tip]');
  if (!tip) return;
  tip.textContent = String(text ?? '');
  tip.hidden = !tip.textContent;
}

// ---- 面板键盘：Esc 先关面板，别让抽屉抢走 ----

function bindNotePanelKeys(ctx) {
  teardownNotePanelKeys(ctx);
  const onKeyDown = event => {
    if (event.key !== 'Escape' || !ctx.notePanel) return;
    // 抽屉的 Esc 挂在 document 捕获阶段，只有 window 捕获能抢在它前面。
    // 面板开着时 Esc 的语义是「退一层」，不是「连抽屉一起关掉」。
    event.preventDefault();
    event.stopPropagation();
    closeNotePanel(ctx);
  };
  window.addEventListener('keydown', onKeyDown, true);
  ctx.noteKeyCapture = onKeyDown;
}

function teardownNotePanelKeys(ctx) {
  if (!ctx?.noteKeyCapture) return;
  window.removeEventListener('keydown', ctx.noteKeyCapture, true);
  ctx.noteKeyCapture = null;
}

/** 抽屉关闭时收尾：面板还开着的话监听器和定时器都得摘掉，不能留在 window 上。 */
function teardownNotePanel(ctx) {
  teardownNotePanelKeys(ctx);
  if (ctx.hintTimer) {
    clearTimeout(ctx.hintTimer);
    ctx.hintTimer = null;
  }
  ctx.notePanel = '';
  ctx.noteCandidates = null;
  ctx.noteMoving = null;
  ctx.noteCreating = false;
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
