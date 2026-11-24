// 「记录表格」页（设计稿：表格视图 / 就地编辑 / 列头字段菜单）。
//
// 行 = logs 表的一条工作记录；列 = field_def 表里 entity='log' 的字段定义。
// 数据访问通过 setTableAdapter 注入（main.js 注入真 adapter；
// _debug/ui-review.html 壳绕过 Tauri 直接调用 renderTable 渲染演示数据）。
//
// 本模块顶层只依赖 fieldTypes.js / htmlUtils.js（均零依赖），
// 不能在顶层 import data.js —— 否则调试壳（无 __TAURI__）无法加载本模块。

import { escapeHtml } from './htmlUtils.js';
import { pickAttachmentItems, storeImageFile, filesFromDataTransfer, setAttachmentNotifier, convertSrc } from './attachmentOps.js';
import { createGrid, serializeTSV, parseTSV, fillPlan } from './gridCore.js';
import { mountFillHandle, mountRowResizer } from './gridGestures.js';
import { undoStack } from './undoCore.js';
import {
  FIELD_TYPE_ORDER,
  FIELD_TYPE_LABELS,
  renderFieldIcon,
  renderCell,
  openCellEditor,
  resolveOption,
  normalizeMulti,
} from './fieldTypes.js';
// 筛选/排序面板与自建表共用：sheetPanels 只依赖 htmlUtils + fieldTypes（都零依赖），
// 顶层静态 import 不会把调试壳（无 __TAURI__）拖挂。
import { openFilterPanel, openSortPanel } from './sheetPanels.js';

const TABLE_ENTITY = 'log';
const DEFAULT_TAG = '未分类';
const ADD_COL_WIDTH = 44;
// 行号列的宽度权重。Excel 的行号栏就是这个作用：既是「第几行」的读数，
// 也是点选整行的抓手。没有它，用户没法表达「我要这一整行」。
const ROWNUM_WIDTH = 56;

// 列宽基准权重（对照设计稿：内容 280 / 主分类 120 / 标签 170 / 时间 128 / 附件 96 / 状态 108 / 说明 180）。
// 渲染时换算为百分比列宽，随容器宽度等比缩放；容器 < 900px 才出现横向滚动。
const DEFAULT_WIDTHS = {
  text: 280,
  tag: 120,
  sub_tag: 170,
  date: 128,
  attachments: 96,
  status: 108,
  detail: 180,
};
const FALLBACK_WIDTH = 150;

let adapter = null;      // { dbQuery, dbExecute }
let inited = false;
let fields = [];         // field_def 行（entity='log'，按 sort 排序）
let rows = [];           // logs 行
let optionCache = { tags: [], sub_tags: [] };
/* 当前渲染出来的行/列。gridCore 的坐标（r/c）指的是这两个数组的下标，
   不是 rows/fields —— filterRows 之后顺序会变，用原数组下标点错行。 */
let renderedRows = [];
let renderedFields = [];
let grid = null;         // gridCore 控制器
/* 成功写库的次数。刷新是「先查再渲染」，若查询在途时有写入落地，
   这份快照就比库旧 —— 直接渲染会把用户刚改的值刷回去（实测缺陷）。
   refresh 拿它做版本校验，读到旧版本就重读一次。 */
let writeTick = 0;
// v4 快速筛选：mode = all | today | inbox，另外可按主分类/子项目收窄。
// 过滤只影响渲染，不改变 rows —— 「今天」切回「全部」时不用重读库。
let activeFilter = { mode: 'all', tag: '', subTag: '' };
/* 条件筛选 / 排序（Excel 式按列）。与快速 chip 并存，职责不同：
   chip 先划范围（今天 / 待整理 / 某分类），条件在范围内再收窄，最后排序。
   排序只支持单列 —— 多列排序的 UI 复杂度和收益不成正比，缺了再说。 */
let baseFilters = [];   // [{ key, op, value }]
let baseSorts = [];     // [{ key, dir }]

export function setTableFilter(patch = {}) {
  activeFilter = { ...activeFilter, ...patch };
  if (document.getElementById('table-view-root')) render();
}

/**
 * 设/清排序。列头菜单和工具栏排序面板都走这里 —— 两个入口写同一份状态，
 * 不然很容易出现「面板里清掉了，列头还挂着箭头」。
 */
function setBaseSort(key, dir) {
  baseSorts = key ? [{ key, dir: dir === 'desc' ? 'desc' : 'asc' }] : [];
  // 行序变了，原来选中的坐标指向的是另一条记录 —— 必须先清，否则下一次
  // 键盘编辑会写到隔壁行去。
  grid?.sel.clear();
  syncToolbarState();
  render();
  if (key) {
    const field = fields.find(item => item.key === key);
    showTableToast(`已按「${field?.label || key}」${dir === 'desc' ? '降序' : '升序'}排列`, 'info');
  } else {
    showTableToast('已取消排序', 'info');
  }
}

function setBaseFilters(next) {
  baseFilters = Array.isArray(next)
    ? next.filter(item => item && item.key).map(item => ({ key: item.key, op: item.op || 'contains', value: item.value ?? '' }))
    : [];
  grid?.sel.clear();
  syncToolbarState();
  render();
  // 筛选后行数从 renderedRows 读 —— render() 刚把它换成过滤后的集合
  showTableToast(
    baseFilters.length ? `筛选出 ${renderedRows.length} 条记录` : '已清除筛选条件',
    'info'
  );
}

/** 工具栏徽标/高亮跟着状态走。DOM 可能还没渲染（首次 init 前），全部可选链。 */
function syncToolbarState() {
  const filterBtn = document.getElementById('table-filter-btn');
  const badge = document.getElementById('table-filter-count');
  if (badge) {
    badge.textContent = String(baseFilters.length);
    badge.style.display = baseFilters.length ? '' : 'none';
  }
  if (filterBtn) {
    filterBtn.classList.toggle('is-on', baseFilters.length > 0);
    filterBtn.setAttribute('aria-label', baseFilters.length ? `筛选（${baseFilters.length} 个条件生效）` : '筛选');
  }
  document.getElementById('table-sort-btn')?.classList.toggle('is-on', baseSorts.length > 0);
}

function visibleFieldList() {
  return fields.filter(field => Number(field.visible) !== 0);
}

function isEmptyCell(value) {
  return value === '' || value === null || value === undefined
    || (Array.isArray(value) && value.length === 0);
}

/**
 * 一个单元格的「原始值 / 展示文本」两条路。
 * 条件既可能来自选项下拉（拿到的是 value 码，如 unprocessed），也可能是手输
 * （拿到的是中文 label）。两种都认，用户不用记哪个字段存的是码哪个是文字。
 */
function filterPair(field, row) {
  const value = readFieldValue(field, row);
  const raw = Array.isArray(value)
    ? value.map(item => (typeof item === 'object' ? item.name || item.path || '' : item)).join(',')
    : String(value ?? '');
  let text = raw;
  const ctx = cellCtxFor(field, row);
  if (field.type === 'select') {
    text = String(resolveOption(field, value, ctx).label ?? '');
  } else if (field.type === 'multi_select') {
    text = normalizeMulti(value).map(item => resolveOption(field, item, ctx).label).join('、');
  } else if (field.type === 'checkbox') {
    text = value === true || value === 'true' || value === 1 ? '是' : '否';
  } else if (field.type === 'attachment') {
    text = Array.isArray(value) && value.length ? value.map(item => item?.name || item?.path || '').join(' ') : '';
  }
  return { raw, text };
}

function matchFilter(row, filter) {
  const field = fields.find(item => item.key === filter.key);
  if (!field) return true;
  const { raw, text } = filterPair(field, row);
  const target = String(filter.value ?? '');
  const hit = (haystack) => haystack === target
    || (target !== '' && haystack.toLowerCase().includes(target.toLowerCase()));
  switch (filter.op) {
    case 'equals':
      return raw === target || text === target;
    case 'not_equals':
      return !(raw === target || text === target);
    case 'empty':
      return isEmptyCell(raw) && text === '';
    case 'not_empty':
      return !(isEmptyCell(raw) && text === '');
    case 'contains':
    default:
      return target ? hit(raw) || hit(text) : true;
  }
}

function compareField(field, a, b) {
  const av = readFieldValue(field, a);
  const bv = readFieldValue(field, b);
  if (field.type === 'number') {
    const an = Number(av);
    const bn = Number(bv);
    const aOk = Number.isFinite(an) && String(av ?? '') !== '';
    const bOk = Number.isFinite(bn) && String(bv ?? '') !== '';
    if (aOk && bOk) return an - bn;
    if (aOk !== bOk) return aOk ? -1 : 1;
  }
  if (field.type === 'checkbox') {
    const at = av === true || av === 'true' || av === 1 ? 1 : 0;
    const bt = bv === true || bv === 'true' || bv === 1 ? 1 : 0;
    return at - bt;
  }
  // 日期是 'YYYY-MM-DD HH:MM'，字典序即时间序；其余文本按中文拼音排
  return String(av ?? '').localeCompare(String(bv ?? ''), 'zh-CN');
}

function sortList(list) {
  if (!baseSorts.length) return list;
  const { key, dir } = baseSorts[0];
  const field = fields.find(item => item.key === key);
  if (!field) return list;
  const sign = dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    // 空值永远沉底：跟着 sign 一起翻转的话，一按降序空行全冲到最上面
    const aEmpty = isEmptyCell(readFieldValue(field, a));
    const bEmpty = isEmptyCell(readFieldValue(field, b));
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    if (aEmpty && bEmpty) return 0;
    return compareField(field, a, b) * sign;
  });
}

function filterRows(list) {
  const today = todayString();
  let out = list.filter(row => {
    if (activeFilter.tag && row.tag !== activeFilter.tag) return false;
    if (activeFilter.subTag) {
      const subs = String(row.sub_tag || '').split(',').map(item => item.trim()).filter(Boolean);
      if (!subs.includes(activeFilter.subTag)) return false;
    }
    if (activeFilter.mode === 'today' && row.date !== today) return false;
    if (activeFilter.mode === 'inbox' && row.status !== 'unprocessed') return false;
    return true;
  });
  if (baseFilters.length) {
    out = out.filter(row => baseFilters.every(filter => matchFilter(row, filter)));
  }
  return sortList(out);
}

// ==========================================
// 工具
// ==========================================

function pad2(value) {
  return String(value).padStart(2, '0');
}

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function timeString() {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

/**
 * 列宽权重。优先用库里存的（v14 起 field_def.width 有真实值），
 * 没存过才回落到内置比例 —— 否则用户拖过的宽度一刷新就白拖。
 */
function widthOf(field) {
  const stored = Number(field.width);
  if (stored > 0) return stored;
  return DEFAULT_WIDTHS[field.key] || FALLBACK_WIDTH;
}

function nextCustomKey() {
  return `custom.f${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

function readCustom(row) {
  if (!row || !row.custom) return {};
  try {
    const parsed = JSON.parse(row.custom);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

async function writeCustom(row, custom) {
  row.custom = JSON.stringify(custom);
  await adapter.dbExecute('UPDATE logs SET custom=? WHERE id=?', [row.custom, row.id]);
}

// 字段 key → logs 表列名白名单（防拼接注入；custom.* 单独处理）
const COLUMN_WHITELIST = {
  text: 'text',
  tag: 'tag',
  sub_tag: 'sub_tag',
  status: 'status',
  detail: 'detail',
  remark: 'remark',
  deadline: 'deadline',
  is_overdue: 'is_overdue',
  record_type: 'record_type',
};

function readFieldValue(field, row) {
  const key = field.key || '';
  if (key === 'date') {
    const date = row.date || '';
    const time = (row.time || '').slice(0, 5);
    return `${date} ${time}`.trim();
  }
  if (key === 'attachments') return readCustom(row).attachments || [];
  if (key.startsWith('custom.')) return readCustom(row)[key.slice(7)];
  return row[key] ?? '';
}

// 把 'YYYY-MM-DD HH:MM' 拆成 [date, 'HH:MM:SS']（秒补齐为 00，与现有数据格式一致）
function splitDateTime(value) {
  const str = String(value || '').trim();
  if (!str) return ['', ''];
  const parts = str.split(/\s+/);
  const date = parts[0] && /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) ? parts[0] : '';
  let time = parts[1] || '';
  if (time && time.length === 5) time = `${time}:00`;
  if (time && !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) time = '';
  return [date, time];
}

async function writeFieldValue(field, row, value) {
  const key = field.key || '';
  if (key === 'date') {
    const [date, time] = splitDateTime(value);
    await adapter.dbExecute('UPDATE logs SET date=?, time=? WHERE id=?', [date, time, row.id]);
    row.date = date;
    row.time = time;
    return;
  }
  if (key === 'attachments') {
    const custom = readCustom(row);
    custom.attachments = Array.isArray(value) ? value : [];
    await writeCustom(row, custom);
    return;
  }
  if (key.startsWith('custom.')) {
    const custom = readCustom(row);
    custom[key.slice(7)] = value;
    await writeCustom(row, custom);
    return;
  }
  const column = COLUMN_WHITELIST[key];
  if (!column) throw new Error(`字段 ${key} 暂不支持写入`);
  await adapter.dbExecute(`UPDATE logs SET ${column}=? WHERE id=?`, [value, row.id]);
  row[key] = value;
}

let toastTimer = null;

export function showTableToast(message, tone = 'success') {
  let el = document.getElementById('wr-table-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wr-table-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `wr-table-toast tone-${tone} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ==========================================
// 数据加载
// ==========================================

export function setTableAdapter(nextAdapter) {
  adapter = nextAdapter;
}

async function loadFields() {
  const res = await adapter.dbQuery(
    `SELECT id, entity, key, label, type, options, sort, visible, builtin FROM field_def WHERE entity='${TABLE_ENTITY}' ORDER BY sort, id`
  );
  fields = Array.isArray(res) ? res : [];
}

async function loadOptionCache() {
  const tags = await adapter.dbQuery('SELECT name, is_active FROM tags');
  optionCache.tags = (Array.isArray(tags) ? tags : [])
    .filter(item => item.is_active === 1 || item.is_active === 'true' || item.is_active === true)
    .map(item => ({ value: item.name, label: item.name }));

  const subs = await adapter.dbQuery('SELECT main_tag, name FROM sub_tags');
  optionCache.sub_tags = (Array.isArray(subs) ? subs : []).map(item => ({
    value: item.name,
    label: item.name,
    main_tag: item.main_tag,
  }));
}

let refreshGen = 0;

async function refresh(depth = 0) {
  const gen = ++refreshGen;
  const tick = writeTick;
  const logs = await adapter.dbQuery('SELECT * FROM logs ORDER BY date DESC, time DESC, id DESC');
  // 行高存在 record.height（智能表早就在用这一列），logs 视图里没有它 —— 视图定义
  // 被测试冻结，不为一行高度去动视图和 9 个触发器，这里单独补一次读。
  const heights = await adapter.dbQuery("SELECT id, height FROM record WHERE kind = 'log' AND height IS NOT NULL");
  // 读取期间有写入落地：这份快照可能不含刚写进去的值，重读（最多重试 2 次，避免写多时打转）
  if (tick !== writeTick && depth < 2) { await refresh(depth + 1); return; }
  const nextRows = Array.isArray(logs) ? logs : [];
  await loadOptionCache();
  // loadOptionCache 也是两次 IO，这里到 render() 之间还有一段异步窗口：
  // 若期间用户刚提交了一次就地编辑，这份快照就是过期的，直接渲染会把新值冲回旧文案
  // （实测缺陷：库已更新、界面回退）。有更新的刷新接管时也一样，让位给它。
  if (gen !== refreshGen) return;
  if (tick !== writeTick && depth < 2) { await refresh(depth + 1); return; }
  const heightMap = new Map();
  (Array.isArray(heights) ? heights : []).forEach(item => {
    const value = Number(item?.height);
    if (Number.isFinite(value) && value > 0) heightMap.set(String(item.id), value);
  });
  rows = heightMap.size
    ? nextRows.map(row => {
      const height = heightMap.get(String(row.id));
      return height ? { ...row, height } : row;
    })
    : nextRows;
  render();
}

// ==========================================
// 渲染
// ==========================================

function sortedOptionsFor(source, row) {
  const list = optionCache[source] || [];
  if (source === 'sub_tags' && row?.tag) {
    // 当前记录所属主分类下的子标签排前面
    return [...list].sort((a, b) => {
      const av = a.main_tag === row.tag ? 0 : 1;
      const bv = b.main_tag === row.tag ? 0 : 1;
      return av - bv;
    });
  }
  return list;
}

function cellCtxFor(field, row) {
  return {
    getOptions: source => sortedOptionsFor(source, row),
    placeholder: field.key === 'text' ? '未命名' : undefined,
    solidPill: true,
  };
}

function buildHeadHtml(visibleFields) {
  const sorted = baseSorts[0] || null;
  const cells = visibleFields.map(field => {
    const isSorted = Boolean(sorted) && sorted.key === field.key;
    const arrow = isSorted ? (sorted.dir === 'desc' ? '▼' : '▲') : '';
    return `
    <th class="wr-table-th${isSorted ? ' is-sorted' : ''}" data-key="${escapeHtml(field.key)}">
      <button type="button" class="wr-th-btn" data-key="${escapeHtml(field.key)}" aria-haspopup="true" aria-expanded="false">
        ${renderFieldIcon(field.type)}
        <span class="wr-th-label">${escapeHtml(field.label)}</span>
        ${isSorted ? `<span class="wr-th-sort" aria-label="${sorted.dir === 'desc' ? '降序' : '升序'}">${arrow}</span>` : ''}
      </button>
      <span class="wr-th-resize" data-resize="${escapeHtml(field.key)}" role="separator" aria-orientation="vertical"
            aria-label="拖动调整「${escapeHtml(field.label)}」列宽，双击按内容自适应"></span>
    </th>`;
  }).join('');
  // 左上角那格留空：Excel 里点它是「全选」，这里不做全选，留空更不容易误触
  return `<tr><th class="wr-table-th wr-th-rownum" aria-label="行号"></th>${cells}<th class="wr-table-th wr-table-th-add">
    <button type="button" class="wr-th-add-btn" aria-label="添加字段">＋</button>
  </th></tr>`;
}

function buildRowHtml(row, visibleFields, rowIndex = 0) {
  const cells = visibleFields.map((field, colIndex) => {
    const value = readFieldValue(field, row);
    // data-rowindex / data-col 是 gridCore 的坐标来源，必须与「当前渲染顺序」一致。
    // data-id / data-key 用于写库与重新定位，两者并存不是冗余。
    return `<td class="wr-table-td wr-table-td-${escapeHtml(field.key.replace('.', '-'))}">
      <div class="wr-cell" tabindex="-1" data-key="${escapeHtml(field.key)}" data-id="${escapeHtml(row.id)}" data-rowindex="${rowIndex}" data-col="${colIndex}">${renderCell(field, value, cellCtxFor(field, row))}</div>
    </td>`;
  }).join('');
  // 行高按 record.height 落到 <tr> 上；没有值就走 CSS 的 46px 自然高度。
  const rowHeight = Number(row.height) || 0;
  const trCls = `wr-table-row${rowHeight ? ' is-row-sized' : ''}`;
  const trStyle = rowHeight ? ` style="height:${rowHeight}px"` : '';
  // data-row 存的是渲染顺序下标（不是 id）：行号列点选、Shift 连选都按它算
  const rownum = `<td class="wr-table-td wr-rownum" data-row="${rowIndex}">${rowIndex + 1}</td>`;
  return `<tr class="${trCls}" data-id="${escapeHtml(row.id)}"${trStyle}>${rownum}${cells}<td class="wr-table-td wr-table-td-add"></td></tr>`;
}

function buildEmptyHtml(colSpan) {
  return `<tr class="wr-table-empty-row"><td colspan="${colSpan}">
    <div class="wr-table-empty">还没有记录。点「＋ 新建记录」写下第一条。</div>
  </td></tr>`;
}

// ==========================================
// 列宽：拖边界调整 / 双击按内容自适应
// ==========================================
//
// 列宽存的是**权重**不是 px：colgroup 用百分比，权重按比例分配容器宽度。
// 存 px 的话 table-layout:fixed 会把「px 之和」当成硬下限，窗口一窄就横向溢出
// （这是当初把列宽改成百分比的原因，不能退回去）。

const MIN_COL_PX = 84;
const MAX_COL_PX = 560;

let measureCanvas = null;

function textWidthPx(text, font) {
  if (!measureCanvas) measureCanvas = document.createElement('canvas').getContext('2d');
  measureCanvas.font = font || '13.5px system-ui, sans-serif';
  return measureCanvas.measureText(String(text ?? '')).width;
}

/**
 * 这一列「按内容该多宽」。字体从真实单元格取 —— 写死 13.5px 在三套主题里
 * 会差 1~2px，量出来的宽度就跟渲染对不上，双击自适后会差一点点。
 */
function desiredWidthOf(field) {
  const sample = tableRoot()?.querySelector('.wr-cell');
  const font = sample ? getComputedStyle(sample).font : '13.5px system-ui, sans-serif';
  let widest = textWidthPx(field.label, font);
  for (const row of rows) {
    const width = textWidthPx(filterPair(field, row).text, font);
    if (width > widest) widest = width;
  }
  // 32 = 左右各 12 的内边距 + 8 的呼吸位，免得文字贴着边界
  return Math.max(MIN_COL_PX, Math.min(MAX_COL_PX, Math.ceil(widest) + 32));
}

/**
 * 把「这一列应该多宽（px）」换算成权重落库。
 * 已知目标宽 d、表格宽 T、其它列权重和 S，解 w/(S+w) = d/T → w = S·d/(T−d)。
 * 直接按 px 存会让百分比模型失效，所以必须解这一步。
 */
async function applyColumnWidth(field, desiredPx) {
  const table = tableRoot()?.querySelector('.wr-table');
  if (!table || !adapter) return;
  const total = table.getBoundingClientRect().width || 0;
  if (total <= 0) return;

  // 至少给其它列留 140px，否则把某一列拖到占满会把别的列挤成 0
  const cap = Math.max(MIN_COL_PX, total - 140);
  const d = Math.max(MIN_COL_PX, Math.min(MAX_COL_PX, cap, Math.round(desiredPx)));

  const others = visibleFieldList()
    .filter(item => item.key !== field.key)
    .reduce((sum, item) => sum + widthOf(item), 0) + ADD_COL_WIDTH + ROWNUM_WIDTH;

  const weight = total > d && others > 0
    ? Math.max(40, Math.round((others * d) / (total - d)))
    : Math.round(widthOf(field));

  try {
    await adapter.dbExecute('UPDATE field_def SET width=? WHERE id=?', [weight, field.id]);
    field.width = weight;
  } catch (error) {
    console.error('保存列宽失败:', error);
    showTableToast('列宽保存失败，请看日志', 'danger');
    return;
  }
  render();
}

async function autofitColumn(field) {
  const px = desiredWidthOf(field);
  await applyColumnWidth(field, px);
  showTableToast(`「${field.label}」已按内容调宽`, 'info');
}

let colDrag = null;

function onRootPointerDown(event) {
  // 行下缘的命中判断在 gridGestures 的捕获阶段就处理掉了，这里只管列宽
  const handle = event.target.closest('.wr-th-resize');
  if (!handle || !adapter) return;
  const key = handle.dataset.resize;
  const field = fields.find(item => item.key === key);
  const index = renderedFields.findIndex(item => item.key === key);
  const th = handle.closest('.wr-table-th');
  // +1 跳过行号列（colgroup 第 0 个）
  const col = tableRoot()?.querySelectorAll('.wr-table col')[index + 1];
  if (!field || index < 0 || !th || !col) return;

  // 不 preventDefault 的话拖动会顺带把表头文字刷蓝
  event.preventDefault();
  event.stopPropagation();

  colDrag = { field, col, startX: event.clientX, startPx: th.getBoundingClientRect().width, px: 0, moved: false };
  tableRoot()?.classList.add('is-col-resizing');
  document.addEventListener('pointermove', onColResizeMove);
  document.addEventListener('pointerup', onColResizeEnd, { once: true });
  document.addEventListener('pointercancel', onColResizeEnd, { once: true });
}

function onColResizeMove(event) {
  if (!colDrag) return;
  const dx = event.clientX - colDrag.startX;
  // 2px 抖动容差：手抖一下不该被记成「改过列宽」
  if (!colDrag.moved && Math.abs(dx) < 2) return;
  colDrag.moved = true;
  const px = Math.round(Math.max(MIN_COL_PX, Math.min(MAX_COL_PX, colDrag.startPx + dx)));
  colDrag.px = px;
  // 拖动过程中只改这一列的 col 宽度，不重排整表 —— 重排会掉帧，也会打断正在编辑的格
  colDrag.col.style.width = `${px}px`;
}

function onColResizeEnd() {
  document.removeEventListener('pointermove', onColResizeMove);
  tableRoot()?.classList.remove('is-col-resizing');
  const drag = colDrag;
  colDrag = null;
  if (!drag || !drag.moved) return;
  void applyColumnWidth(drag.field, drag.px);
}

// ==========================================
// 行高：拖行下边界调整 / 双击复位
// ==========================================
//
// 基础表没有行首编号列，Excel 那种「在行号栏拖边界」的入口在这里不存在。
// 改成「行下缘 5px 热区」—— 那段正好落在单元格 12px 下内边距里，压不到文字，
// 也不用往表格骨架里插一列（插列会连带改 colgroup 权重、列宽换算、探针坐标）。

// 行高的上下限与默认值；拖拽本身在 gridGestures.js，两边表格共用
const MIN_ROW_PX = 32;
const MAX_ROW_PX = 600;
const DEFAULT_ROW_PX = 46; // 与 styles-v4 里 .wr-cell 的 min-height 对齐

function rowIndexOf(tr) {
  const cell = tr?.querySelector?.('.wr-cell[data-rowindex]');
  const index = Number(cell?.dataset.rowindex);
  return Number.isInteger(index) ? index : -1;
}

function rowOfTr(tr) {
  const index = rowIndexOf(tr);
  return index >= 0 ? renderedRows[index] : null;
}

// 参数会被适配器统一 String()，null 传下去会写成字符串 'null'（INTEGER 列存成 TEXT）。
// 「恢复默认行高」必须走不带参数的 SQL NULL。
async function writeRowHeight(row, px) {
  if (!px) {
    await adapter.dbExecute('UPDATE record SET height = NULL WHERE id = ?', [row.id]);
    delete row.height;
  } else {
    await adapter.dbExecute('UPDATE record SET height = ? WHERE id = ?', [px, row.id]);
    row.height = px;
  }
  writeTick += 1;
}

async function applyRowHeight(row, px) {
  const before = Number(row.height) || 0;
  const next = px || 0;
  if (before === next) {
    render();
    return;
  }
  await writeRowHeight(row, next);
  undoStack.push({
    label: next ? `调整行高到 ${next}px` : '恢复默认行高',
    undo: async () => { await writeRowHeight(row, before); render(); },
    redo: async () => { await writeRowHeight(row, next); render(); },
  });
  render();
}

// 双击行下边界 = 让它自己合适。
// 基础表的单元格是单行不折行，量出来的自然高度就是默认值，所以这一步实际是
// 「复位被拖高的行」；名字仍叫自适应，因为用户的心智是「让它自己合适」。
async function autofitRow(tr) {
  const row = rowOfTr(tr);
  if (!row) return;
  const previous = Number(row.height) || 0;
  tr.style.height = '';
  tr.classList.remove('is-row-sized');
  const natural = Math.round(tr.getBoundingClientRect().height) || DEFAULT_ROW_PX;
  const target = natural <= DEFAULT_ROW_PX + 1 ? 0 : natural;
  if (previous === target) {
    render();
    if (!previous) showTableToast(`行高已经是默认的 ${DEFAULT_ROW_PX}px`, 'info');
    return;
  }
  await writeRowHeight(row, target);
  render();
  showTableToast(target ? `行高已按内容调整为 ${natural}px` : `行高已恢复默认 ${DEFAULT_ROW_PX}px`, 'info');
}

// 渲染入口（壳内也直接调用本函数渲染演示数据；
// 传入的数据同步为模块状态，使点击编辑在壳内同样可用）
export function renderTable(rootEl, data = {}) {
  if (!rootEl) return;
  if (data.fields) fields = data.fields;
  if (data.rows) rows = data.rows;
  if (data.optionCache) optionCache = data.optionCache;

  const useFields = fields;
  const useRows = filterRows(rows);

  const visibleFields = useFields.filter(field => Number(field.visible) !== 0);
  // 渲染快照：gridCore 的坐标全部基于这两个数组
  renderedRows = useRows;
  renderedFields = visibleFields;
  // 列宽用百分比（基准权重见 DEFAULT_WIDTHS）：
  // table-layout:fixed 下 px 列宽之和是表格的硬下限，会导致容器窄时无法压缩列；
  // 百分比则随表格宽度（100% 或 min-width:900px）等比缩放。
  // 行号列也参与权重分配，否则它会挤占别的列（百分比总和必须为 100）
  const totalWeight = visibleFields.reduce((sum, field) => sum + widthOf(field), 0)
    + ADD_COL_WIDTH + ROWNUM_WIDTH;
  const colgroup = [
    `<col style="width:${((ROWNUM_WIDTH / totalWeight) * 100).toFixed(3)}%" class="wr-col-rownum" />`,
    ...visibleFields.map(field => `<col style="width:${((widthOf(field) / totalWeight) * 100).toFixed(3)}%" />`),
    `<col style="width:${((ADD_COL_WIDTH / totalWeight) * 100).toFixed(3)}%" />`,
  ].join('');

  const tbody = useRows.length
    ? useRows.map((row, index) => buildRowHtml(row, visibleFields, index)).join('')
    : buildEmptyHtml(visibleFields.length + 2); // 行号 + 字段 + 加列

  rootEl.innerHTML = `
    <div class="wr-table-shell">
      <div class="wr-table-scroll">
        <table class="wr-table">
          <colgroup>${colgroup}</colgroup>
          <thead>${buildHeadHtml(visibleFields)}</thead>
          <tbody>${tbody}</tbody>
        </table>
        <div class="wr-fill-handle" hidden aria-hidden="true"></div>
        <div class="wr-fill-preview" hidden aria-hidden="true"></div>
      </div>
      <div class="wr-table-footer">
        <button type="button" class="wr-table-addrow">＋ 新建记录</button>
      </div>
    </div>`;
}

function closeTransientEditors() {
  document.querySelectorAll('.ft-dropdown').forEach(el => el.remove());
  document.querySelectorAll('.ft-cell-editing').forEach(el => el.classList.remove('ft-cell-editing'));
}

// 提交发生在「输入框还在 cell 里」的瞬间：这里直接 return 会让单元格停在旧值，
// 用户要重新进表才看到新内容（实测缺陷）。改成挂一个观察器，等编辑器收掉再画一次。
const pendingCellPaints = new WeakMap();

function paintCell(cellEl, field, row) {
  if (!cellEl || !cellEl.isConnected) return;
  const value = readFieldValue(field, row);
  cellEl.innerHTML = renderCell(field, value, cellCtxFor(field, row));
}

function rerenderCell(cellEl, field, row) {
  if (cellEl.querySelector('.ft-inline-input')) {
    if (!pendingCellPaints.has(cellEl)) {
      const observer = new MutationObserver(() => {
        if (!cellEl.isConnected) { observer.disconnect(); pendingCellPaints.delete(cellEl); return; }
        if (cellEl.querySelector('.ft-inline-input')) return;
        observer.disconnect();
        pendingCellPaints.delete(cellEl);
        paintCell(cellEl, field, row);
      });
      observer.observe(cellEl, { childList: true, subtree: true });
      pendingCellPaints.set(cellEl, observer);
    }
    return;
  }
  paintCell(cellEl, field, row);
}

function render() {
  const root = document.getElementById('table-view-root');
  if (!root) return;
  closeTransientEditors();
  renderTable(root, { fields, rows, optionCache });
  paintGridSelection();
}

// ==========================================
// 网格交互：选中 / 键盘 / 剪贴板 / 撤销
// ==========================================
//
// 分工：编辑器（fieldTypes.js）自己管 Enter 提交、Esc 放弃；本层只负责
// 「提交完往哪走」以及选中、导航、复制粘贴。两边都拦 Enter 会打架，
// 所以这里只在 capture 阶段记账（pendingMove），不 preventDefault。

let pendingMove = null;

function tableRoot() {
  return document.getElementById('table-view-root');
}

function cellElOf(r, c) {
  const root = tableRoot();
  if (!root) return null;
  return root.querySelector(`.wr-cell[data-rowindex="${r}"][data-col="${c}"]`);
}

function cellAt(r, c) {
  const row = renderedRows[r];
  const field = renderedFields[c];
  if (!row || !field) return null;
  return { row, field };
}

function isEditingCell() {
  return Boolean(tableRoot()?.querySelector('.ft-inline-input, .ft-cell-editing'));
}

function paintGridSelection() {
  const root = tableRoot();
  if (!root || !grid) return;
  root.querySelectorAll('.wr-cell.is-sel, .wr-cell.is-active')
    .forEach(el => el.classList.remove('is-sel', 'is-active'));
  root.querySelectorAll('.wr-table-th.is-sel, .wr-rownum.is-sel')
    .forEach(el => el.classList.remove('is-sel'));

  const snap = grid.sel.snapshot();
  // 整行/整列模式没有活动格（anchor 为空），高亮靠宿主自己按行列画
  if (snap.mode === 'rows' || snap.mode === 'cols') {
    root.querySelectorAll('.wr-cell[data-rowindex]').forEach(el => {
      const r = Number(el.dataset.rowindex);
      const c = Number(el.dataset.col);
      if (grid.sel.contains(r, c)) el.classList.add('is-sel');
    });
    if (snap.mode === 'rows') {
      root.querySelectorAll('.wr-rownum').forEach(td => {
        if (snap.rows.includes(Number(td.dataset.row))) td.classList.add('is-sel');
      });
    } else {
      root.querySelectorAll('.wr-table-th[data-key]').forEach(th => {
        const index = renderedFields.findIndex(item => item.key === th.dataset.key);
        if (index >= 0 && snap.cols.includes(index)) th.classList.add('is-sel');
      });
    }
    fillHandle?.reposition();
    return;
  }

  const active = grid.sel.active();
  if (!active) {
    fillHandle?.reposition();
    return;
  }

  root.querySelectorAll('.wr-cell[data-rowindex]').forEach(el => {
    const r = Number(el.dataset.rowindex);
    const c = Number(el.dataset.col);
    if (Number.isNaN(r) || Number.isNaN(c)) return;
    if (grid.sel.contains(r, c)) el.classList.add('is-sel');
  });
  cellElOf(active.r, active.c)?.classList.add('is-active');
  fillHandle?.reposition();
}

// ==========================================
// 填充柄
// ==========================================
//
// 选区右下角一个 8px 小方块，拖出去按 Excel 规则循环复制（见 gridCore.fillPlan）。
// 手柄用绝对定位贴在 .wr-table-scroll 里，所以横向滚动时它跟着格子走，不用监听 scroll。

async function applyFillPlan(plan) {
  const picked = [];
  for (const cell of plan.cells) {
    const target = cellAt(cell.r, cell.c);
    const source = cellAt(cell.fromR, cell.fromC);
    if (!target || !source) continue;
    const next = readFieldValue(source.field, source.row);
    // 附件是数组，复制等于让两条记录共享同一批文件引用 —— 语义不清，直接跳过
    if (Array.isArray(next)) continue;
    const before = readFieldValue(target.field, target.row);
    if (String(before ?? '') === String(next ?? '')) continue;
    picked.push({ ...target, before, next });
  }

  if (!picked.length) {
    showTableToast('没有可填充的内容', 'info');
    fillHandle?.reposition();
    return;
  }

  for (const item of picked) {
    await writeFieldValue(item.field, item.row, item.next);
    repaintRowCell(item.row, item.field);
  }
  writeTick += 1;

  undoStack.push({
    label: `填充 ${picked.length} 格`,
    undo: async () => {
      for (const item of picked) await writeFieldValue(item.field, item.row, item.before);
      writeTick += 1;
      picked.forEach(item => repaintRowCell(item.row, item.field));
    },
    redo: async () => {
      for (const item of picked) await writeFieldValue(item.field, item.row, item.next);
      writeTick += 1;
      picked.forEach(item => repaintRowCell(item.row, item.field));
    },
  });

  // 填充完选区变成整个目标矩形（Excel 同款），用户接着按 Ctrl+C 就能整块复制
  const box = plan.box;
  if (grid && box) {
    grid.select(box.r1, box.c1);
    grid.sel.extendTo(box.r2, box.c2);
    paintGridSelection();
  }
  showTableToast(`已填充 ${picked.length} 格`, 'success');
}

function startEditAt(r, c, opts = {}) {
  const target = cellAt(r, c);
  const el = cellElOf(r, c);
  if (!target || !el) return;
  const { field, row } = target;

  openCellEditor(el, field, readFieldValue(field, row), {
    getOptions: source => sortedOptionsFor(source, row),
    ensureOption: (f, label) => ensureOption(f, label, row),
    commit: next => commitCellValue(field, row, el, next),
    toast: showTableToast,
    placeholder: field.key === 'text' ? '未命名' : undefined,
    onAttachmentEdit: () => openAttachPanel(el, field, row),
  });

  // 直接敲字：编辑器已经建好输入框并全选原值，这里用首字符替换
  if (opts.char) {
    const input = el.querySelector('.ft-inline-input');
    if (input) {
      input.value = opts.char;
      if (typeof input.setSelectionRange === 'function') {
        input.setSelectionRange(opts.char.length, opts.char.length);
      }
    }
  }
}

async function clearCells(cells) {
  const picked = [];
  for (const { r, c } of cells) {
    const target = cellAt(r, c);
    if (!target) continue;
    const before = readFieldValue(target.field, target.row);
    const isEmptyValue = before === '' || before === null || before === undefined
      || (Array.isArray(before) && before.length === 0);
    if (isEmptyValue) continue;
    picked.push({ ...target, before });
  }
  if (!picked.length) return;

  for (const item of picked) {
    await writeFieldValue(item.field, item.row, '');
    repaintRowCell(item.row, item.field);
  }
  writeTick += 1;

  undoStack.push({
    label: `清空 ${picked.length} 格`,
    undo: async () => {
      for (const item of picked) await writeFieldValue(item.field, item.row, item.before);
      writeTick += 1;
      picked.forEach(item => repaintRowCell(item.row, item.field));
    },
    redo: async () => {
      for (const item of picked) await writeFieldValue(item.field, item.row, '');
      writeTick += 1;
      picked.forEach(item => repaintRowCell(item.row, item.field));
    },
  });

  showTableToast(`已清空 ${picked.length} 格`, 'info');
}

function copyMatrix(matrix, { cut = false } = {}) {
  if (!matrix.length) return;
  const text = serializeTSV(matrix);
  navigator.clipboard?.writeText(text).catch(() => {});
  const cols = matrix[0]?.length || 0;
  showTableToast(cut ? `已剪切 ${matrix.length} × ${cols}` : `已复制 ${matrix.length} × ${cols}`, 'info');
  if (cut) {
    const cells = grid?.sel.cells() || [];
    clearCells(cells);
  }
}

/** 从 (r, c) 开始把二维数组铺进表格。类型不匹配的列（附件）跳过，不硬塞。 */
async function pasteMatrix(r, c, matrix) {
  if (!matrix.length) return;
  const changes = [];

  for (let i = 0; i < matrix.length; i += 1) {
    const line = matrix[i];
    for (let j = 0; j < line.length; j += 1) {
      const target = cellAt(r + i, c + j);
      if (!target) continue;
      if (target.field.type === 'attachment') continue;
      const before = readFieldValue(target.field, target.row);
      const next = line[j];
      if (String(before ?? '') === String(next ?? '')) continue;
      changes.push({ ...target, before, next });
    }
  }

  if (!changes.length) {
    showTableToast('粘贴内容与现有值相同，未做改动', 'info');
    return;
  }

  for (const item of changes) {
    await writeFieldValue(item.field, item.row, item.next);
    repaintRowCell(item.row, item.field);
  }
  writeTick += 1;

  undoStack.push({
    label: `粘贴 ${changes.length} 格`,
    undo: async () => {
      for (const item of changes) await writeFieldValue(item.field, item.row, item.before);
      writeTick += 1;
      changes.forEach(item => repaintRowCell(item.row, item.field));
    },
    redo: async () => {
      for (const item of changes) await writeFieldValue(item.field, item.row, item.next);
      writeTick += 1;
      changes.forEach(item => repaintRowCell(item.row, item.field));
    },
  });

  showTableToast(`已粘贴 ${changes.length} 格`, 'success');
}

function selectAllCells() {
  if (!renderedRows.length || !renderedFields.length || !grid) return;
  grid.select(0, 0);
  grid.sel.extendTo(renderedRows.length - 1, renderedFields.length - 1);
  paintGridSelection();
}

function ensureGrid() {
  if (grid) return grid;
  grid = createGrid({
    rowCount: () => renderedRows.length,
    colCount: () => renderedFields.length,
    isEditing: isEditingCell,
    pageSize: () => 12,
    isEmpty: (r, c) => {
      const target = cellAt(r, c);
      if (!target) return true;
      const value = readFieldValue(target.field, target.row);
      if (Array.isArray(value)) return value.length === 0;
      return value === '' || value === null || value === undefined;
    },
    focus: (r, c) => {
      const el = cellElOf(r, c);
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
    onSelection: paintGridSelection,
    onEditStart: (r, c, opts) => startEditAt(r, c, opts),
    onClear: cells => clearCells(cells),
    onCopy: (matrix, opts) => copyMatrix(matrix, opts),
    onSelectAll: selectAllCells,
    onUndo: () => undoStack.undo(),
    onRedo: () => undoStack.redo(),
    // 新建记录是异步的，行还没出来就移动会落空 —— 先不接管「末行 Tab 补一行」
    appendRow: () => false,
  });
  return grid;
}

function onRootKeydown(event) {
  if (!grid) return;
  // 全局 Ctrl+Z 在 document 捕获阶段就处理掉了（并 preventDefault）。
  // 这里不再拦一次，否则一次按键会连撤两步。
  if (event.defaultPrevented) return;

  // 编辑态：编辑器自己管 Enter / Esc，这里只补 Tab（文本编辑器没绑 Tab）
  if (isEditingCell()) {
    if (event.key === 'Tab') {
      event.preventDefault();
      pendingMove = { dr: 0, dc: event.shiftKey ? -1 : 1, wrap: true };
      tableRoot()?.querySelector('.ft-inline-input')?.blur();
      return;
    }
    if (event.key === 'Enter') {
      // 只记账，提交仍由编辑器触发
      pendingMove = { dr: event.shiftKey ? -1 : 1, dc: 0, wrap: false };
      return;
    }
    return;
  }

  if (!event.target.closest?.('.wr-cell')) return;
  if (ensureGrid().handleKeydown(event)) event.preventDefault();
}

function onRootPaste(event) {
  if (isEditingCell()) return;
  const active = grid?.sel.active();
  if (!active) return;
  const text = event.clipboardData?.getData('text/plain') || '';
  if (!text.trim()) return;
  event.preventDefault();
  pasteMatrix(active.r, active.c, parseTSV(text));
}

function onRootDblClick(event) {
  if (event.target.closest('.ft-inline-input, .ft-dropdown')) return;
  // 双击列边界 = 按内容自适应（Excel 同款手势；不放在列头文字上，
  // 那里单击是开列菜单，双击会变成「开了又关」）
  const resizeHandle = event.target.closest('.wr-th-resize');
  if (resizeHandle) {
    const field = fields.find(item => item.key === resizeHandle.dataset.resize);
    if (field) {
      event.preventDefault();
      void autofitColumn(field);
    }
    return;
  }
  // 双击行下边界由 gridGestures 的捕获阶段截走，这里只处理单元格
  const cell = event.target.closest('.wr-cell');
  if (!cell) return;
  const r = Number(cell.dataset.rowindex);
  const c = Number(cell.dataset.col);
  if (Number.isNaN(r) || Number.isNaN(c)) return;
  event.preventDefault();
  startEditAt(r, c, {});
}

function registerCellUndo(field, row, before, after) {
  if (JSON.stringify(before ?? '') === JSON.stringify(after ?? '')) return;
  undoStack.push({
    label: `编辑「${field.label || field.key}」`,
    undo: async () => {
      await writeFieldValue(field, row, before);
      writeTick += 1;
      repaintRowCell(row, field);
    },
    redo: async () => {
      await writeFieldValue(field, row, after);
      writeTick += 1;
      repaintRowCell(row, field);
    },
  });
}

// ==========================================
// 就地编辑
// ==========================================

// 提交瞬间表格可能被整体重绘（切表 / 刷新 / 筛选），旧 cell 已脱离文档：
// 对旧节点渲染等于没画，界面会停在旧值，直到重新进表才看到新内容。
// 这里按 row.id + field.key 重新定位一次单元格再画。
function repaintRowCell(row, field) {
  const root = document.getElementById('table-view-root');
  if (!root || !row || !field) return;
  const id = String(row.id);
  const key = String(field.key);
  const fresh = [...root.querySelectorAll('.wr-table-row')]
    .find(tr => tr.dataset.id === id)
    ?.querySelector(`.wr-cell[data-key="${key}"]`);
  if (fresh) paintCell(fresh, field, row);
}

async function commitCellValue(field, row, cellEl, newValue) {
  if (!adapter) return;
  const before = readFieldValue(field, row);
  const move = pendingMove;
  pendingMove = null;

  try {
    await writeFieldValue(field, row, newValue);
    writeTick += 1;
    rerenderCell(cellEl, field, row);
    if (!cellEl.isConnected) repaintRowCell(row, field);
    registerCellUndo(field, row, before, newValue);
  } catch (error) {
    showTableToast(`保存失败：${error?.message || error}`, 'danger');
  } finally {
    // Excel 手感：Enter 提交后下移、Tab 提交后右移。移动必须在提交完成之后，
    // 否则落点按旧行数算，最后一行提交完会移到不存在的位置。
    if (move) grid?.move(move.dr, move.dc, move.wrap);
  }
}

async function ensureOption(field, label, row) {
  const label2 = String(label || '').trim();
  if (!label2) return null;
  const configSource = (() => {
    try {
      const parsed = field.options ? JSON.parse(field.options) : {};
      return parsed.source || 'custom';
    } catch (error) {
      return 'custom';
    }
  })();

  if (configSource === 'tags') {
    await adapter.dbExecute('INSERT OR IGNORE INTO tags (name, is_active) VALUES (?, 1)', [label2]);
    if (!optionCache.tags.some(item => item.value === label2)) {
      optionCache.tags.push({ value: label2, label: label2 });
    }
    return { value: label2, label: label2 };
  }
  if (configSource === 'sub_tags') {
    const mainTag = row?.tag || DEFAULT_TAG;
    await adapter.dbExecute('INSERT INTO sub_tags (main_tag, name) VALUES (?, ?)', [mainTag, label2]);
    if (!optionCache.sub_tags.some(item => item.value === label2)) {
      optionCache.sub_tags.push({ value: label2, label: label2, main_tag: mainTag });
    }
    return { value: label2, label: label2 };
  }
  // 自定义选项：写回 field_def.options
  let parsed = {};
  try { parsed = field.options ? JSON.parse(field.options) : {}; } catch (error) { parsed = {}; }
  const options = Array.isArray(parsed.options) ? parsed.options : [];
  if (!options.some(item => item.value === label2)) {
    options.push({ value: label2, label: label2, tone: '' });
    parsed.options = options;
    field.options = JSON.stringify(parsed);
    await adapter.dbExecute('UPDATE field_def SET options=? WHERE id=?', [field.options, field.id]);
  }
  return { value: label2, label: label2 };
}

// 直接进编辑（新建记录后自动聚焦标题列就是走这里）。
// 不再自己拼一套 actions：坐标交给 gridCore 选中，编辑交给 startEditAt，
// 否则会出现「两处传的 commit/ensureOption 不一样」这种只有线上才会发作的漂移。
function handleCellClick(cellEl) {
  if (!adapter) return;
  const r = Number(cellEl.dataset.rowindex);
  const c = Number(cellEl.dataset.col);
  if (Number.isNaN(r) || Number.isNaN(c)) return;
  ensureGrid().select(r, c);
  startEditAt(r, c, {});
}

// ==========================================
// 附件单元格：粘贴 / 选择 / 移除
// ==========================================

// 单元格里的图片列。值形如 [{ path, name, w, h }] 或 [{ kind:'file', path, name }]，
// 统一存进 logs.custom.attachments（writeFieldValue 里特判），不需要加列。
function attachItemsOf(field, row) {
  const value = readFieldValue(field, row);
  return Array.isArray(value) ? value.filter(item => item && item.path) : [];
}

function openAttachPanel(cellEl, field, row) {
  const panel = openFloatingPanel(cellEl, 'wr-attpanel');
  panel.innerHTML = `
    <div class="wr-att-zone" data-zone>
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-image"/></svg>
      <span>Ctrl+V 粘贴截图，或把图片拖进来</span>
    </div>
    <div class="wr-att-list" data-list></div>
    <div class="wr-att-foot">
      <button type="button" class="wr-att-pick" data-pick title="图片会复制进应用目录，其他文件只保存链接">添加附件…</button>
      <span class="wr-att-gap"></span>
      <button type="button" class="wr-att-done" data-done>完成</button>
    </div>`;

  const listEl = panel.querySelector('[data-list]');
  const zone = panel.querySelector('[data-zone]');

  // openFloatingPanel 量的是「还没填内容」的空壳（offsetWidth = 0），
  // 于是它按 220 兜底算右边界；这张面板实际 300 宽，靠右的列会被推出屏幕。
  // 内容填好后再按真实宽度夹一次。
  const cellRect = cellEl.getBoundingClientRect();
  const panelWidth = panel.offsetWidth || 300;
  const clampedLeft = Math.min(cellRect.left, Math.max(8, window.innerWidth - panelWidth - 8));
  panel.style.left = `${Math.max(8, clampedLeft)}px`;

  const paint = () => {
    const items = attachItemsOf(field, row);
    listEl.innerHTML = items.length
      ? items
          .map((item, index) => {
            if (item.kind === 'file') {
              return `<span class="wr-att-item is-file" title="${escapeHtml(item.path)}">
                  <span class="wr-att-file">${escapeHtml(item.name || String(item.path).split(/[\\/]/).pop() || '文件')}</span>
                  <button type="button" class="wr-att-del" data-remove="${index}" aria-label="移除">×</button>
                </span>`;
            }
            return `<span class="wr-att-item">
                <img src="${escapeHtml(convertSrc(item.path))}" alt="${escapeHtml(item.name || '附件')}" />
                <button type="button" class="wr-att-del" data-remove="${index}" aria-label="移除">×</button>
              </span>`;
          })
          .join('')
      : '<div class="wr-att-empty">还没有图片或文件</div>';
  };

  // 写回：先把数组落到 custom.attachments，再重画这一格，面板本身留在原地
  const apply = async next => {
    await commitCellValue(field, row, cellEl, next);
    paint();
  };

  const append = async extra => {
    if (!extra.length) return;
    await apply([...attachItemsOf(field, row), ...extra]);
    showTableToast(`已添加 ${extra.length} 个附件`);
  };

  panel.addEventListener('click', async event => {
    if (event.target.closest('[data-done]')) { closeFloatingPanel(); return; }
    if (event.target.closest('[data-pick]')) {
      const items = await pickAttachmentItems();
      await append(items);
      return;
    }
    const del = event.target.closest('[data-remove]');
    if (del) {
      const index = Number(del.dataset.remove);
      const next = attachItemsOf(field, row).filter((item, i) => i !== index);
      await apply(next);
    }
  });

  // 粘贴：面板开着时 Ctrl+V 直接把图片塞进这一格
  const onPaste = async event => {
    const { files } = filesFromDataTransfer(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    const items = [];
    let skipped = 0;
    for (const file of files) {
      // 剪贴板里的非图片文件拿不到真实路径（只有 name），存下来就是个点不开的死链。
      // 这类文件走「添加附件…」的系统选择框，才能拿到路径。
      if (!String(file.type || '').startsWith('image/')) { skipped += 1; continue; }
      try { items.push(await storeImageFile(file)); }
      catch (error) { showTableToast(`图片处理失败：${error?.message || error}`, 'danger'); }
    }
    if (skipped) showTableToast(`粘贴只能收图片，其他文件请用「添加附件…」`, 'info');
    await append(items);
  };
  document.addEventListener('paste', onPaste, true);

  // 拖拽：整块面板当投放区，免得非要精确落在小方块里
  const onDragOver = event => { event.preventDefault(); zone.classList.add('is-over'); };
  const onDragLeave = () => zone.classList.remove('is-over');
  const onDrop = async event => {
    event.preventDefault();
    zone.classList.remove('is-over');
    const { files } = filesFromDataTransfer(event.dataTransfer);
    const items = [];
    let skippedDrop = 0;
    for (const file of files) {
      if (!String(file.type || '').startsWith('image/')) { skippedDrop += 1; continue; }
      try { items.push(await storeImageFile(file)); }
      catch (error) { showTableToast(`图片处理失败：${error?.message || error}`, 'danger'); }
    }
    if (skippedDrop) showTableToast(`拖进来的非图片文件没有路径，请用「添加附件…」`, 'info');
    await append(items);
  };
  panel.addEventListener('dragover', onDragOver);
  panel.addEventListener('dragleave', onDragLeave);
  panel.addEventListener('drop', onDrop);

  // 面板关掉时把全局粘贴监听一起撤掉，否则在别处 Ctrl+V 也会写进这一格
  const stop = () => {
    document.removeEventListener('paste', onPaste, true);
    panel.removeEventListener('dragover', onDragOver);
    panel.removeEventListener('dragleave', onDragLeave);
    panel.removeEventListener('drop', onDrop);
    observer.disconnect();
  };
  const observer = new MutationObserver(() => {
    if (!document.body.contains(panel)) stop();
  });
  observer.observe(document.body, { childList: true });

  paint();
}

// ==========================================
// 浮层（列头菜单 / 字段面板共用）
// ==========================================

let floatingPanel = null;

function closeFloatingPanel() {
  if (!floatingPanel) return;
  floatingPanel.panel.remove();
  document.removeEventListener('mousedown', floatingPanel.onOutside, true);
  document.removeEventListener('keydown', floatingPanel.onKey, true);
  floatingPanel.anchor?.setAttribute?.('aria-expanded', 'false');
  floatingPanel.anchor?.closest?.('.wr-table-th')?.classList.remove('is-menu-open');
  floatingPanel = null;
}

function openFloatingPanel(anchorEl, className, { below = true } = {}) {
  closeFloatingPanel();
  const panel = document.createElement('div');
  panel.className = className;
  document.body.appendChild(panel);

  const rect = anchorEl.getBoundingClientRect();
  const width = panel.offsetWidth || 220;
  const height = panel.offsetHeight || 240;
  let left = rect.left;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
  let top = rect.bottom + 6;
  if (below && top + height > window.innerHeight - 8 && rect.top - height - 6 > 8) {
    top = rect.top - height - 6;
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;

  anchorEl.setAttribute?.('aria-expanded', 'true');
  anchorEl.closest?.('.wr-table-th')?.classList.add('is-menu-open');

  const onOutside = event => {
    if (!panel.contains(event.target) && !anchorEl.contains(event.target)) closeFloatingPanel();
  };
  const onKey = event => {
    if (event.key === 'Escape') closeFloatingPanel();
  };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  floatingPanel = { panel, anchor: anchorEl, onOutside, onKey };
  return panel;
}

// ==========================================
// 列头菜单（设计稿③）
// ==========================================

function openColumnMenu(anchorEl, field) {
  const panel = openFloatingPanel(anchorEl, 'wr-colmenu');

  const renderMenu = () => {
    const sorted = baseSorts[0] || null;
    const isSorted = Boolean(sorted) && sorted.key === field.key;
    panel.innerHTML = `
      <div class="wr-colmenu-main">
        <!-- 排序放在列头上，是 Excel / Notion 的共同习惯：想按哪列排就点哪列 -->
        <button type="button" class="wr-colmenu-item" data-action="sort-asc">
          <span class="wr-colmenu-glyph" aria-hidden="true">↑</span>升序
          ${isSorted && sorted.dir === 'asc' ? '<svg class="wr-icon wr-type-check" aria-hidden="true"><use href="#ic-check"/></svg>' : ''}
        </button>
        <button type="button" class="wr-colmenu-item" data-action="sort-desc">
          <span class="wr-colmenu-glyph" aria-hidden="true">↓</span>降序
          ${isSorted && sorted.dir === 'desc' ? '<svg class="wr-icon wr-type-check" aria-hidden="true"><use href="#ic-check"/></svg>' : ''}
        </button>
        ${isSorted ? `<button type="button" class="wr-colmenu-item" data-action="sort-clear">
          <span class="wr-colmenu-glyph" aria-hidden="true">×</span>清除排序
        </button>` : ''}
        <button type="button" class="wr-colmenu-item" data-action="autofit">
          <span class="wr-colmenu-glyph" aria-hidden="true">⇔</span>按内容自适应列宽
        </button>
        <div class="wr-colmenu-sep"></div>
        <button type="button" class="wr-colmenu-item" data-action="change-type">
          <svg class="wr-icon" aria-hidden="true"><use href="#ic-swap"/></svg>更改类型
        </button>
        <button type="button" class="wr-colmenu-item" data-action="rename">
          <svg class="wr-icon" aria-hidden="true"><use href="#ic-pencil"/></svg>重命名
        </button>
        <button type="button" class="wr-colmenu-item" data-action="duplicate">
          <svg class="wr-icon" aria-hidden="true"><use href="#ic-copy"/></svg>复制字段
        </button>
        <button type="button" class="wr-colmenu-item" data-action="insert-left">
          <svg class="wr-icon" aria-hidden="true"><use href="#ic-insert-left"/></svg>插入左列
        </button>
        <button type="button" class="wr-colmenu-item" data-action="insert-right">
          <svg class="wr-icon" aria-hidden="true"><use href="#ic-insert-right"/></svg>插入右列
        </button>
        <button type="button" class="wr-colmenu-item" data-action="hide">
          <svg class="wr-icon" aria-hidden="true"><use href="#ic-eye-off"/></svg>隐藏列
        </button>
        ${Number(field.builtin) === 1 ? '' : `
        <div class="wr-colmenu-sep"></div>
        <button type="button" class="wr-colmenu-item is-danger" data-action="delete">
          <svg class="wr-icon" aria-hidden="true"><use href="#ic-trash"/></svg>删除列
        </button>`}
      </div>
      <div class="wr-colmenu-types" hidden>
        <div class="wr-colmenu-types-title">字段类型</div>
        <!-- 关联记录不在这里：老网格的写入白名单只认真列与 custom.* 键，
             选了这个类型会「能建列、改不动、也不报错」。预置表的关联列必须在
             sheetPage 里配（那里才有一整条读写路径）。等老网格退役就删掉这段过滤。 -->
        ${FIELD_TYPE_ORDER.filter(type => type !== 'relation').map(type => `
          <button type="button" class="wr-type-option${type === field.type ? ' is-active' : ''}" data-type="${type}">
            ${renderFieldIcon(type)}
            <span>${FIELD_TYPE_LABELS[type]}</span>
            ${type === field.type ? '<svg class="wr-icon wr-type-check" aria-hidden="true"><use href="#ic-check"/></svg>' : ''}
          </button>`).join('')}
      </div>`;
  };
  renderMenu();

  const typesPane = panel.querySelector('.wr-colmenu-types');

  panel.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'sort-asc' || action === 'sort-desc') {
      closeFloatingPanel();
      setBaseSort(field.key, action === 'sort-desc' ? 'desc' : 'asc');
      return;
    }
    if (action === 'sort-clear') {
      closeFloatingPanel();
      setBaseSort('', '');
      return;
    }
    if (action === 'autofit') {
      closeFloatingPanel();
      void autofitColumn(field);
      return;
    }
    if (action === 'change-type') {
      typesPane.hidden = !typesPane.hidden;
      panel.classList.toggle('show-types', !typesPane.hidden);
      // 类型面板展开后宽度变化，重新校正水平位置避免超出右缘
      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        panel.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
      }
      return;
    }
    if (action === 'rename') { closeFloatingPanel(); promptRenameField(field); return; }
    if (action === 'duplicate') { closeFloatingPanel(); await duplicateField(field); return; }
    if (action === 'insert-left') { closeFloatingPanel(); await insertFieldAt(field, 'left'); return; }
    if (action === 'insert-right') { closeFloatingPanel(); await insertFieldAt(field, 'right'); return; }
    if (action === 'hide') {
      closeFloatingPanel();
      await adapter.dbExecute('UPDATE field_def SET visible=0 WHERE id=?', [field.id]);
      await loadFields();
      render();
      showTableToast(`已隐藏「${field.label}」，可在「字段」里恢复`);
      return;
    }
    if (action === 'delete') { closeFloatingPanel(); promptDeleteField(field); return; }
  });

  typesPane.addEventListener('click', async event => {
    const type = event.target.closest('[data-type]')?.dataset.type;
    if (!type || type === field.type) { closeFloatingPanel(); return; }
    closeFloatingPanel();
    window.showModal?.('更改字段类型', `
      <p style="margin:0 0 6px;">把「${escapeHtml(field.label)}」的类型从 <b>${FIELD_TYPE_LABELS[field.type] || field.type}</b> 改为 <b>${FIELD_TYPE_LABELS[type]}</b>？</p>
      <p style="margin:0; color:var(--color-text-muted); font-size:12.5px;">已有数据不会丢失；无法按新类型显示的值会显示为空。</p>
    `, null, async () => {
      await adapter.dbExecute('UPDATE field_def SET type=? WHERE id=?', [type, field.id]);
      await loadFields();
      render();
      showTableToast(`「${field.label}」已改为${FIELD_TYPE_LABELS[type]}`);
      return true;
    }, { btnText: '确认更改' });
  });
}

function promptRenameField(field) {
  if (typeof window.showModal !== 'function') return;
  window.showModal('重命名字段', `
    <div class="form-group">
      <label class="field-label">字段名</label>
      <input type="text" id="wr-rename-input" class="hero-input" value="${escapeHtml(field.label)}" />
    </div>
  `, body => {
    const input = body.querySelector('#wr-rename-input');
    input?.focus();
    input?.select();
  }, async body => {
    const next = body.querySelector('#wr-rename-input')?.value.trim();
    if (!next) return false;
    await adapter.dbExecute('UPDATE field_def SET label=? WHERE id=?', [next, field.id]);
    await loadFields();
    render();
    showTableToast('字段已重命名');
    return true;
  }, { btnText: '保存' });
}

function promptDeleteField(field) {
  if (typeof window.showModal !== 'function') return;
  window.showModal('删除字段', `
    <p style="margin:0 0 6px;">删除「${escapeHtml(field.label)}」后，表格中不再显示该列。</p>
    <p style="margin:0; color:var(--color-text-muted); font-size:12.5px;">已写入该字段的扩展数据不会被清掉，但界面上将无法访问。</p>
  `, null, async () => {
    await adapter.dbExecute('DELETE FROM field_def WHERE id=?', [field.id]);
    await loadFields();
    render();
    showTableToast(`已删除「${field.label}」`);
    return true;
  }, { danger: true, btnText: '删除' });
}

async function duplicateField(field) {
  const ordered = fields.slice();
  const key = nextCustomKey();
  const sort = ordered.length ? Math.max(...ordered.map(item => Number(item.sort) || 0)) + 1 : 0;
  await adapter.dbExecute(
    'INSERT INTO field_def (entity, key, label, type, options, sort, visible, builtin) VALUES (?, ?, ?, ?, ?, ?, 1, 0)',
    [TABLE_ENTITY, key, `${field.label} 副本`, field.type, field.options || null, sort]
  );
  await loadFields();
  render();
  showTableToast(`已复制「${field.label}」`);
}

async function insertFieldAt(anchorField, side) {
  const ordered = fields.slice();
  const idx = ordered.findIndex(item => item.id === anchorField.id);
  if (idx < 0) return;
  const insertIdx = side === 'left' ? idx : idx + 1;
  const key = nextCustomKey();

  // 先给现有字段让位（重排 sort，把 insertIdx 空出来），再插入新字段
  const sequence = ordered.map((item, i) => ({ item, slot: i >= insertIdx ? i + 1 : i }));
  for (const { item, slot } of sequence) {
    if (Number(item.sort) !== slot) {
      await adapter.dbExecute('UPDATE field_def SET sort=? WHERE id=?', [slot, item.id]);
    }
  }
  await adapter.dbExecute(
    'INSERT INTO field_def (entity, key, label, type, options, sort, visible, builtin) VALUES (?, ?, ?, ?, NULL, ?, 1, 0)',
    [TABLE_ENTITY, key, '新字段', 'text', insertIdx]
  );
  await loadFields();
  render();
}

async function addField() {
  const key = nextCustomKey();
  const sort = fields.length ? Math.max(...fields.map(item => Number(item.sort) || 0)) + 1 : 0;
  await adapter.dbExecute(
    'INSERT INTO field_def (entity, key, label, type, options, sort, visible, builtin) VALUES (?, ?, ?, ?, NULL, ?, 1, 0)',
    [TABLE_ENTITY, key, '新字段', 'text', sort]
  );
  await loadFields();
  render();
  const created = fields.find(item => item.key === key);
  if (created) promptRenameField(created);
}

// ==========================================
// 工具栏
// ==========================================

function openFieldsPanel(anchorEl) {
  const panel = openFloatingPanel(anchorEl, 'wr-fieldspanel');
  const renderPanel = () => {
    panel.innerHTML = `
      <div class="wr-fieldspanel-title">显示字段</div>
      <div class="wr-fieldspanel-list">
        ${fields.map(field => `
          <label class="wr-fieldspanel-row">
            <input type="checkbox" data-key="${escapeHtml(field.key)}" ${Number(field.visible) !== 0 ? 'checked' : ''} />
            ${renderFieldIcon(field.type)}
            <span>${escapeHtml(field.label)}</span>
          </label>`).join('')}
      </div>`;
  };
  renderPanel();

  panel.addEventListener('change', async event => {
    const input = event.target.closest('input[data-key]');
    if (!input) return;
    const field = fields.find(item => item.key === input.dataset.key);
    if (!field) return;
    await adapter.dbExecute('UPDATE field_def SET visible=? WHERE id=?', [input.checked ? 1 : 0, field.id]);
    await loadFields();
    render();
    renderPanel();
  });
}

async function createRecord() {
  if (!adapter) return;
  const existing = new Set(rows.map(row => String(row.id)));
  await adapter.dbExecute(
    'INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue, status, record_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [todayString(), timeString(), '', DEFAULT_TAG, '', '', '', '', '', '', 'pending', 'log']
  );
  await refresh();
  const created = rows.find(row => !existing.has(String(row.id)));
  if (created) {
    const cell = document.querySelector(`.wr-cell[data-key="text"][data-id="${created.id}"]`);
    cell?.scrollIntoView({ block: 'nearest' });
    if (cell) handleCellClick(cell);
  }
}

const NOT_READY_MESSAGES = {
  kanban: '看板视图：开发中，后续版本提供',
  calendar: '日历视图：开发中，后续版本提供',
};

function notReady(feature) {
  showTableToast(NOT_READY_MESSAGES[feature] || '该功能开发中', 'info');
}

// ==========================================
// 事件绑定（一次性，事件委托）
// ==========================================

function selectColumnByKey(key, event) {
  const index = renderedFields.findIndex(item => item.key === key);
  if (index < 0 || !grid) return;
  const snap = grid.sel.snapshot();
  // 还没有整列选区时，Shift 点击当成普通点击（否则 extendCols 找不到起点）
  const extend = Boolean(event.shiftKey) && snap.mode === 'cols' && snap.cols.length > 0;
  grid.selectLine({
    axis: 'col',
    index,
    additive: Boolean(event.ctrlKey || event.metaKey),
    extend,
  });
  paintGridSelection();
}

function selectRowByIndex(index, event) {
  if (!Number.isInteger(index) || index < 0 || !grid) return;
  const snap = grid.sel.snapshot();
  const extend = Boolean(event.shiftKey) && snap.mode === 'rows' && snap.rows.length > 0;
  grid.selectLine({
    axis: 'row',
    index,
    additive: Boolean(event.ctrlKey || event.metaKey),
    extend,
  });
  paintGridSelection();
}

function onRootContextMenu(event) {
  const th = event.target.closest('.wr-table-th[data-key]');
  if (!th) return;
  const field = fields.find(item => item.key === th.dataset.key);
  if (!field) return;
  event.preventDefault();
  openColumnMenu(th, field);
}

function onRootClick(event) {
  // 左键点列头 = 选中整列，列菜单走右键 —— 这是 Excel 的手势。
  // 以前这里点一下就弹菜单，和自建表正好相反，也是「两套手感」最刺眼的一处。
  const thBtn = event.target.closest('.wr-th-btn');
  if (thBtn) {
    selectColumnByKey(thBtn.dataset.key, event);
    return;
  }
  // 点行号 = 选中整行
  const rownum = event.target.closest('.wr-rownum');
  if (rownum) {
    selectRowByIndex(Number(rownum.dataset.row), event);
    return;
  }
  const addFieldBtn = event.target.closest('.wr-th-add-btn');
  if (addFieldBtn) { addField(); return; }

  const addRowBtn = event.target.closest('.wr-table-addrow');
  if (addRowBtn) { createRecord(); return; }

  const cell = event.target.closest('.wr-cell');
  if (cell) {
    // 点在编辑器里不改变选中，否则点输入框会把选区挪走、提交落点算错
    if (event.target.closest('.ft-inline-input, .ft-dropdown')) return;

    const r = Number(cell.dataset.rowindex);
    const c = Number(cell.dataset.col);
    if (Number.isNaN(r) || Number.isNaN(c)) return;

    const extend = event.shiftKey;
    const additive = event.ctrlKey || event.metaKey;
    const prev = grid?.sel.active();
    const wasActive = Boolean(prev) && prev.r === r && prev.c === c;

    ensureGrid().select(r, c, { extend, additive });

    // 第二次点同一格进编辑：比要求精确双击宽容，也保留了原来「点一下就能改」的手感
    if (wasActive && !extend && !additive && !isEditingCell()) startEditAt(r, c, {});
    return;
  }
}

// 填充柄与行高拖拽由 gridGestures 提供（空白表用的是同一套，别再各写一遍）
let fillHandle = null;

function mountGestures(rootEl) {
  if (fillHandle) return;
  fillHandle = mountFillHandle({
    root: rootEl,
    // 表格每次重绘都会换掉滚动容器，必须惰性取
    getScroll: () => rootEl.querySelector('.wr-table-scroll'),
    cellSelector: '.wr-cell',
    tableSelector: '.wr-table',
    getBounds: () => grid?.sel.bounds() || null,
    getCounts: () => ({ rows: renderedRows.length, cols: renderedFields.length }),
    isBlocked: () => isEditingCell(),
    onFill: plan => applyFillPlan(plan),
  });
  mountRowResizer({
    root: rootEl,
    rowSelector: '.wr-table-row',
    cellSelector: '.wr-cell',
    // 行高只从行号栏拖：单元格上下边缘用来「选下一格」，不再兼任行高抓手
    edgeSelector: '.wr-rownum',
    min: MIN_ROW_PX,
    max: MAX_ROW_PX,
    isBlocked: () => isEditingCell(),
    onResize: (rowEl, px) => {
      const row = rowOfTr(rowEl);
      if (row) void applyRowHeight(row, px);
    },
    onAutoFit: rowEl => { void autofitRow(rowEl); },
  });
}

export function bindTableEvents(rootEl) {
  if (!rootEl || rootEl.dataset.wrTableBound === '1') return;
  rootEl.dataset.wrTableBound = '1';
  rootEl.addEventListener('click', onRootClick);
  rootEl.addEventListener('dblclick', onRootDblClick);
  rootEl.addEventListener('contextmenu', onRootContextMenu);
  rootEl.addEventListener('keydown', onRootKeydown);
  rootEl.addEventListener('paste', onRootPaste);
  rootEl.addEventListener('pointerdown', onRootPointerDown);
  ensureGrid();
  mountGestures(rootEl);
}

function bindToolbar() {
  document.getElementById('table-new-record-btn')?.addEventListener('click', createRecord);
  document.getElementById('table-fields-btn')?.addEventListener('click', event => {
    openFieldsPanel(event.currentTarget);
  });
  // 筛选 / 排序面板与自建表是同一套（sheetPanels），只是数据源换成 logs + field_def
  document.getElementById('table-filter-btn')?.addEventListener('click', event => {
    const anchor = event.currentTarget;
    openFilterPanel(anchor, {
      fields: visibleFieldList(),
      filters: baseFilters,
      onApply: next => setBaseFilters(next),
    });
  });
  document.getElementById('table-sort-btn')?.addEventListener('click', event => {
    const anchor = event.currentTarget;
    openSortPanel(anchor, {
      fields: visibleFieldList(),
      sorts: baseSorts,
      onApply: next => {
        const first = Array.isArray(next) ? next[0] : null;
        setBaseSort(first?.key || '', first?.dir || 'asc');
      },
    });
  });
  document.querySelectorAll('.table-view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.viewMode;
      if (mode === 'table') return;
      notReady(mode);
    });
  });
}

// ==========================================
// 入口
// ==========================================

export async function initTablePage() {
  if (!adapter) return;
  const root = document.getElementById('table-view-root');
  if (!root) return;

  if (!inited) {
    inited = true;
    setAttachmentNotifier(showTableToast);
    bindToolbar();
    bindTableEvents(root);
  }
  try {
    await loadFields();
    await refresh();
    // 筛选/排序是模块级状态：切走再切回来、或重进这张表时要让按钮跟上，
    // 否则「有 2 个条件生效」的徽标会消失，用户以为筛选失效了。
    syncToolbarState();
  } catch (error) {
    console.error('表格页加载失败:', error);
    showTableToast('表格加载失败，请查看日志', 'danger');
  }
}
