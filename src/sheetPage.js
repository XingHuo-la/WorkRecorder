// 「表格」页 v2：多表 + 任务归属 + 就地编辑。
//
// 结构：库里一堆表（可按任务分组）→ 打开某张表 → 表内是「字段 + 记录」。
// 页面两个形态（library / sheet）共用同一个容器 #sheet-app，
// 所有 DOM 由本模块生成，index.html 只留一个空壳，避免和旧样式打架。

import { escapeHtml } from './htmlUtils.js';
import { renderCell, openCellEditor, renderFieldIcon, FIELD_TYPE_LABELS } from './fieldTypes.js';
import { buildColgroup, buildHead, buildRow, tableWidth, autoFitWidth, fieldWidth, visibleOf, cellFormat, fieldFormat, isHexColor } from './sheetTable.js';
import { openDatePicker } from './datePicker.js';
import {
  openColumnMenu,
  openRowMenu,
  openCellMenu,
  openCellFormatPanel,
  openFileActionMenu,
  openFieldPanel,
  openFilterPanel,
  openSortPanel,
  openImagePreview,
  closeAllPanels,
  registerActivePanel,
  operatorLabel,
} from './sheetPanels.js';
// 抽屉从 rowDrawer 取，不从 sheetPanels 取 —— 抽屉本体已迁出（T04），
// 且 sheetPanels 绝不 import rowDrawer（防 ESM 循环引用把 openDrawer 拖进 TDZ）。
import { openRowDrawer } from './rowDrawer.js';
import {
  setSheetAdapter,
  isSheetStoreReady,
  listSheets,
  listAllFields,
  listTasks,
  createSheet,
  updateSheet,
  deleteSheet,
  touchSheet,
  loadFields,
  loadRows,
  createField,
  patchField,
  deleteField,
  insertRow,
  insertRowAt,
  setRowHeight,
  saveRowValues,
  deleteRow,
  duplicateRow,
  SHEET_TEMPLATES,
  serializeOptions,
  mergeFieldOptions,
  fieldOptionsList,
  rowTitle,
} from './sheetStore.js';

const CHUNK = 60;
const ROW_LIMIT_HINT = 5000;

const state = {
  view: 'library',
  sheets: [],
  tasks: [],
  sheet: null,
  fields: [],
  rows: [],
  filters: [],
  sorts: [],
  search: '',
  rendered: 0,
  rowTotal: 0,
  fieldIndex: new Map(), // sheetId → [{label, type}]，库视图卡片上展示字段摘要
};

let host = null;
let saveTimer = null;

// 内部剪贴板：复制 ≠ 立即粘贴。
// 复制只把「值/整行」暂存在这里，等用户选中目标单元格/行后 Ctrl+V 再写进去。
// 系统剪贴板只在复制单元格时顺带写一份纯文本，供外部应用使用。
const clipboard = {
  kind: '',        // '' | 'cell' | 'row' | 'block'
  fieldType: '',   // kind=cell 时的字段类型，粘贴要求同类型
  value: null,     // kind=cell 的原始值（图片是对象数组）
  values: null,    // kind=row 的整行 values
  block: null,     // kind=block：{ items: [{dr,dc,fieldType,value}] }
  rowLabel: '',    // 提示用
};

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  try { return JSON.parse(JSON.stringify(value)); } catch (error) { return value; }
}

function hasInternalClipboard() {
  return clipboard.kind === 'cell' || clipboard.kind === 'row' || clipboard.kind === 'block';
}

// ==========================================
// 小工具
// ==========================================

function invoke(cmd, args) {
  const fn = window.__TAURI__?.core?.invoke;
  if (!fn) return Promise.reject(new Error('Tauri 不可用'));
  return fn(cmd, args);
}

function convertSrc(path) {
  try {
    if (window.__TAURI__?.core?.convertFileSrc) return window.__TAURI__.core.convertFileSrc(path);
  } catch (error) { /* 调试壳直接回退原路径 */ }
  return path || '';
}

function toast(message, tone = 'success') {
  let el = document.getElementById('sh-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sh-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `sh-toast tone-${tone} is-on`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('is-on'), 2200);
}

function markSaving() {
  const el = host?.querySelector('[data-save-state]');
  if (!el) return;
  el.textContent = '保存中…';
  el.classList.add('is-saving');
  clearTimeout(saveTimer);
}

function markSaved() {
  const el = host?.querySelector('[data-save-state]');
  if (!el) return;
  el.textContent = '已保存到本地';
  el.classList.remove('is-saving');
}

function formatStamp(value) {
  const str = String(value || '').trim();
  if (!str) return '';
  const [date, time] = str.split(' ');
  if (!date) return str;
  const [, month, day] = date.split('-');
  return `${month || ''}-${day || ''}${time ? ` ${time.slice(0, 5)}` : ''}`;
}

function visibleFields() {
  return state.fields.filter(field => Number(field.visible) !== 0);
}

function cellCtx(field) {
  return { placeholder: field.type === 'text' ? '未命名' : '—' };
}

function displayValue(field, value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return value.map(item => (typeof item === 'object' ? item.name || item.path || '' : item)).join('、');
  if (field.type === 'checkbox') return value === true || value === 'true' ? '是' : '否';
  return String(value);
}

// 搜索专用的文本：选项字段要按「屏幕上看到的字」匹配。
// 状态列库里存 doing、界面显示「进行中」，拿原始值搜是搜不到的。
// 注意别把它用在筛选的 equals 上 —— 筛选面板传的是选项 value。
function searchTextOf(field, value) {
  if (value == null || value === '') return '';
  if (field.type === 'select') {
    const option = fieldOptionsList(field).find(item => String(item.value) === String(value));
    return option ? String(option.label) : String(value);
  }
  if (field.type === 'multi_select') {
    const options = fieldOptionsList(field);
    const list = Array.isArray(value) ? value : String(value).split(',');
    return list
      .map(item => {
        const hit = options.find(option => String(option.value) === String(item));
        return hit ? String(hit.label) : String(item);
      })
      .join(' ');
  }
  if (field.type === 'checkbox') {
    return value === true || value === 1 || value === '1' || value === 'true' ? '是' : '否';
  }
  if (field.type === 'attachment') {
    return (Array.isArray(value) ? value : []).map(item => `${item?.name || ''} ${item?.path || ''}`).join(' ');
  }
  return String(value);
}

// ==========================================
// 行过滤 / 排序
// ==========================================

function filterRows(rows) {
  let list = rows;
  if (state.filters.length) {
    list = list.filter(row =>
      state.filters.every(filter => {
        const field = state.fields.find(item => item.key === filter.key);
        if (!field) return true;
        const raw = displayValue(field, row.values[filter.key]);
        const target = String(filter.value ?? '');
        switch (filter.op) {
          case 'equals': return raw === target;
          case 'not_equals': return raw !== target;
          case 'empty': return raw === '';
          case 'not_empty': return raw !== '';
          case 'contains':
          default: return target ? raw.toLowerCase().includes(target.toLowerCase()) : true;
        }
      })
    );
  }
  if (state.search) {
    const keyword = state.search.toLowerCase();
    list = list.filter(row =>
      visibleFields().some(field => searchTextOf(field, row.values[field.key]).toLowerCase().includes(keyword))
    );
  }
  if (state.sorts.length) {
    const { key, dir } = state.sorts[0];
    const field = state.fields.find(item => item.key === key);
    if (field) {
      const sign = dir === 'desc' ? -1 : 1;
      list = [...list].sort((a, b) => {
        const av = a.values[key];
        const bv = b.values[key];
        if (field.type === 'number') {
          const an = Number(av);
          const bn = Number(bv);
          if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * sign;
        }
        if (field.type === 'checkbox') {
          return ((av ? 1 : 0) - (bv ? 1 : 0)) * sign;
        }
        return String(displayValue(field, av)).localeCompare(String(displayValue(field, bv)), 'zh-CN') * sign;
      });
    }
  }
  return list;
}

// ==========================================
// 库视图
// ==========================================

function groupSheets() {
  const taskMap = new Map(state.tasks.map(task => [String(task.id), task.label]));
  const groups = new Map();
  state.sheets.forEach(sheetItem => {
    const key = sheetItem.task_id == null ? '__none__' : String(sheetItem.task_id);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: key === '__none__' ? '未归属任务' : taskMap.get(key) || '已删除的任务',
        sheets: [],
      });
    }
    groups.get(key).sheets.push(sheetItem);
  });
  // 未归属的排最后，有归属的按表数量降序，视觉上先看到「有任务在用的表」
  return [...groups.values()].sort((a, b) => {
    if (a.key === '__none__') return 1;
    if (b.key === '__none__') return -1;
    return b.sheets.length - a.sheets.length;
  });
}

function sheetCardHtml(sheetItem) {
  const updated = formatStamp(sheetItem.updated_at || sheetItem.last_at || sheetItem.created_at);
  const fields = state.fieldIndex.get(String(sheetItem.id)) || [];
  // 卡片上直接摊开字段：「任务 文本 · 状态 单选 · 截图 图片」
  // 不用点进去就知道这张表能不能装下自己的活儿。
  const preview = fields
    .slice(0, 5)
    .map(field => `${escapeHtml(field.label)} ${escapeHtml(FIELD_TYPE_LABELS[field.type] || field.type)}`)
    .join(' · ');
  const more = fields.length > 5 ? ` · 还有 ${fields.length - 5} 列` : '';
  return `<button type="button" class="sh-sheet-card" data-sheet="${escapeHtml(sheetItem.id)}">
    <span class="sh-card-icon"><svg class="wr-icon" aria-hidden="true"><use href="#ic-table"/></svg></span>
    <span class="sh-card-body">
      <span class="sh-card-name">${escapeHtml(sheetItem.name)}</span>
      <span class="sh-card-meta">${Number(sheetItem.field_count) || 0} 字段 · ${Number(sheetItem.row_count) || 0} 条记录${updated ? ` · ${escapeHtml(updated)}` : ''}</span>
      ${preview ? `<span class="sh-card-fields">${preview}${more}</span>` : ''}
    </span>
    <svg class="wr-icon sh-card-go" aria-hidden="true"><use href="#ic-chevron-right"/></svg>
  </button>`;
}

function renderLibrary() {
  const groups = groupSheets();
  const hasSheets = state.sheets.length > 0;

  const quickStart = SHEET_TEMPLATES.filter(item => item.key !== 'blank')
    .map(
      item => `<button type="button" class="sh-template-card" data-template="${item.key}">
        <span class="sh-template-name">${escapeHtml(item.name)}</span>
        <span class="sh-template-desc">${escapeHtml(item.desc)}</span>
      </button>`
    )
    .join('');

  host.innerHTML = `<div class="sh-page">
    <header class="sh-page-head">
      <div class="sh-page-titles">
        <span class="sh-kicker">TABLES</span>
        <h1>全部表格</h1>
        <p>一个任务可以有多张表；也可以单独建一张，不挂任务。</p>
      </div>
      <div class="sh-page-actions">
        ${hasSheets ? '<button type="button" class="sh-btn is-primary" data-act="new-sheet">＋ 新建表格</button>' : ''}
      </div>
    </header>

    ${
      hasSheets
        ? `<div class="sh-groups">${groups
            .map(
              group => `<section class="sh-group">
                <div class="sh-group-head">
                  <span class="sh-group-name">${escapeHtml(group.label)}</span>
                  <span class="sh-group-count">${group.sheets.length}</span>
                </div>
                <div class="sh-group-list">${group.sheets.map(sheetCardHtml).join('')}</div>
              </section>`
            )
            .join('')}</div>`
        : `<div class="sh-empty">
            <div class="sh-empty-title">还没有表格</div>
            <div class="sh-empty-desc">表格适合「一批结构相同的记录」：任务跟踪、缺陷清单、实验批次。选个起点，字段之后随时能改。</div>
            <div class="sh-template-grid">${quickStart}</div>
            <button type="button" class="sh-btn is-primary" data-act="new-sheet">＋ 新建表格</button>
            <div class="sh-empty-note">数据全部存在本机 SQLite，不联网也能用。</div>
          </div>`
    }
  </div>`;
}

// ==========================================
// 表视图
// ==========================================

function toolbarHtml() {
  const filterChips = state.filters.length
    ? state.filters
        .map((filter, index) => {
          const field = state.fields.find(item => item.key === filter.key);
          const value = filter.op === 'empty' || filter.op === 'not_empty' ? '' : String(filter.value ?? '');
          return `<span class="sh-chip" data-filter-chip="${index}">
            ${escapeHtml(field?.label || filter.key)} ${operatorLabel(filter.op)}${value ? ` ${escapeHtml(value)}` : ''}
            <button type="button" class="sh-chip-x" data-remove-chip="${index}" aria-label="移除条件">×</button>
          </span>`;
        })
        .join('')
    : '';

  const sortChip = state.sorts.length
    ? (() => {
        const field = state.fields.find(item => item.key === state.sorts[0].key);
        return `<span class="sh-chip is-sort" data-sort-chip>
          排序：${escapeHtml(field?.label || state.sorts[0].key)} ${state.sorts[0].dir === 'desc' ? '降序' : '升序'}
          <button type="button" class="sh-chip-x" data-clear-sort aria-label="清除排序">×</button>
        </span>`;
      })()
    : '';

  return `<div class="sh-toolbar">
    <div class="sh-views" role="tablist">
      <button type="button" class="sh-view is-active" role="tab" aria-selected="true">表格</button>
      <button type="button" class="sh-view" data-soon="看板视图还没做，先专注表格" role="tab" aria-selected="false">看板</button>
      <button type="button" class="sh-view" data-soon="日历视图还没做，先专注表格" role="tab" aria-selected="false">日历</button>
    </div>
    <span class="sh-tool-sep"></span>
    <button type="button" class="sh-tool" data-act="fields"><svg class="wr-icon" aria-hidden="true"><use href="#ic-sliders"/></svg>字段</button>
    <button type="button" class="sh-tool ${state.filters.length ? 'is-on' : ''}" data-act="filter"><svg class="wr-icon" aria-hidden="true"><use href="#ic-filter"/></svg>筛选</button>
    <button type="button" class="sh-tool ${state.sorts.length ? 'is-on' : ''}" data-act="sort"><svg class="wr-icon" aria-hidden="true"><use href="#ic-sort"/></svg>排序</button>
    <span class="sh-tool-gap"></span>
    <label class="sh-search">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-search"/></svg>
      <input type="search" data-search placeholder="搜索记录" value="${escapeHtml(state.search)}" spellcheck="false" />
    </label>
    <button type="button" class="sh-btn is-primary" data-act="new-row">＋ 新建记录</button>
  </div>
  ${filterChips || sortChip ? `<div class="sh-chips">${filterChips}${sortChip}</div>` : ''}`;
}

function renderSheet({ resetScroll = false } = {}) {
  const sheet = state.sheet;
  if (!sheet) { renderLibrary(); return; }
  // 全量重排会把滚动位置打回顶部。改个格式、隐藏一列就跳回第一行，
  // 长表根本没法用。这里先记住位置，重排完再补回来。
  const prevScroll = resetScroll ? null : captureScroll();
  clearSelection();
  const task = state.tasks.find(item => String(item.id) === String(sheet.task_id));
  const total = state.rows.length;
  const shown = filterRows(state.rows).length;

  host.innerHTML = `<div class="sh-page is-sheet">
    <div class="sh-crumbs">
      <button type="button" class="sh-crumb" data-act="back">全部表格</button>
      <span class="sh-crumb-sep">/</span>
      ${task ? `<span class="sh-crumb is-muted">${escapeHtml(task.label)}</span><span class="sh-crumb-sep">/</span>` : ''}
      <span class="sh-crumb is-current">${escapeHtml(sheet.name)}</span>
      <span class="sh-crumb-gap"></span>
      <button type="button" class="sh-icon-btn" data-act="sheet-menu" aria-label="更多">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-dots"/></svg>
      </button>
    </div>

    <header class="sh-sheet-head">
      <h1 class="sh-sheet-title" data-act="rename-sheet" title="点击重命名">${escapeHtml(sheet.name)}</h1>
      <span class="sh-sheet-meta">${visibleFields().length} 字段 · ${total} 条记录</span>
      <span class="sh-save" data-save-state>已保存到本地</span>
    </header>

    ${toolbarHtml()}

    <div class="sh-table-wrap">
      <div class="sh-table-scroll" data-scroll>
        <table class="sh-table" style="min-width:${tableWidth(state.fields)}px">
          ${buildColgroup(state.fields)}
          <thead>${buildHead(state.fields)}</thead>
          <tbody data-tbody></tbody>
        </table>
        <div class="sh-table-foot">
          <button type="button" class="sh-addrow" data-act="new-row">＋ 新建记录</button>
        </div>
      </div>
    </div>

    <div class="sh-status"><span data-status-text>${shown === total ? `共 ${total} 条记录` : `筛选出 ${shown} / ${total} 条`}</span></div>
  </div>`;

  renderBodyRows(true);
  if (prevScroll) restoreScroll(prevScroll);
  bindScroll();
}

function captureScroll() {
  const scroller = host?.querySelector('[data-scroll]');
  return scroller ? { top: scroller.scrollTop, left: scroller.scrollLeft } : null;
}

// 行是分块渲染的，直接写 scrollTop 会被夹到 0：
// 先把块补到「高度够得到目标位置」再恢复。
function restoreScroll(prev) {
  const scroller = host?.querySelector('[data-scroll]');
  if (!scroller || !prev) return;
  let guard = 0;
  const limit = Math.min(state.rowTotal, ROW_LIMIT_HINT);
  while (
    scroller.scrollHeight < prev.top + scroller.clientHeight &&
    state.rendered < limit &&
    guard < ROW_LIMIT_HINT
  ) {
    renderBodyRows(false);
    guard += 1;
  }
  scroller.scrollTop = prev.top;
  scroller.scrollLeft = prev.left;
}

function renderBodyRows(reset) {
  const tbody = host?.querySelector('[data-tbody]');
  if (!tbody) return;
  const list = filterRows(state.rows);

  if (reset) {
    tbody.innerHTML = '';
    state.rendered = 0;
    state.rowTotal = list.length;
  }
  if (!list.length) {
    if (reset) {
      tbody.innerHTML = `<tr class="sh-empty-row"><td colspan="${visibleFields().length + 2}">
        <div class="sh-table-empty">
          <div class="sh-empty-title">还没有记录</div>
          <div class="sh-empty-desc">点下面的「新建记录」，或者直接在第一行写。</div>
        </div>
      </td></tr>`;
      rebuildCellIndex();
    }
    return;
  }

  const start = state.rendered;
  const end = Math.min(start + CHUNK, list.length, ROW_LIMIT_HINT);
  if (start >= end) return;
  const html = list.slice(start, end).map((row, offset) => buildRow(row, state.fields, start + offset + 1)).join('');
  tbody.insertAdjacentHTML('beforeend', html);
  state.rendered = end;
  rebuildCellIndex();
}

function bindScroll() {
  const scroller = host?.querySelector('[data-scroll]');
  if (!scroller) return;
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 320) return;
    renderBodyRows(false);
  });
  // 首屏不足一屏时补齐，避免空着大半屏却没有滚动条可触发
  requestAnimationFrame(() => {
    if (scroller.scrollHeight <= scroller.clientHeight + 8) renderBodyRows(false);
  });
}

// ==========================================
// 数据装载
// ==========================================

async function refreshSheets() {
  // 读失败只提示、不抛：列表读不出来不该把「刚建好的表」也一起回滚掉。
  try {
    state.sheets = await listSheets();
    state.tasks = await listTasks();
  } catch (error) {
    toast(`读取表格列表失败：${error?.message || error}`, 'danger');
  }
  try { state.fieldIndex = await listAllFields(); } catch (error) { state.fieldIndex = new Map(); }
}

async function openSheet(sheetId) {
  const sheet = state.sheets.find(item => String(item.id) === String(sheetId));
  if (!sheet) return;
  state.sheet = sheet;
  state.filters = [];
  state.sorts = [];
  state.search = '';
  state.fields = await loadFields(sheet.id);
  state.rows = await loadRows(sheet.id);
  state.view = 'sheet';
  // 换了一张表：必须回到顶部，不能沿用上一张表的滚动位置
  renderSheet({ resetScroll: true });
}

function backToLibrary() {
  closeAllPanels();
  state.view = 'library';
  state.sheet = null;
  state.fields = [];
  state.rows = [];
  refreshSheets().then(render).catch(() => render());
}

async function reloadFields() {
  state.fields = await loadFields(state.sheet.id);
}

async function reloadRows() {
  state.rows = await loadRows(state.sheet.id);
}

// ==========================================
// 单元格编辑
// ==========================================

// 同一行的写入必须串行：下拉多选连点、格式防抖、单元格提交可能同时在飞，
// 后发先至会把旧快照写回去（表现就是「刚改的值自己弹回去了」）。
// 队列里写的是行对象本身，执行时取最新值，所以连续修改不会互相覆盖。
const rowWriteChains = new Map();
function writeRow(row) {
  const key = String(row.id);
  const prev = rowWriteChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => saveRowValues(row.id, row.values));
  rowWriteChains.set(key, next.catch(() => {}));
  return next;
}

async function commitCell(field, row, cellEl, value) {
  const previous = row.values[field.key];
  row.values[field.key] = value;
  if (cellEl) cellEl.innerHTML = renderCell(field, value, cellCtx(field));
  markSaving();
  try {
    await writeRow(row);
    await touchSheet(state.sheet.id);
    markSaved();
    // 标题类字段改动后，详情抽屉的标题也要跟着变 —— 简单起见重建抽屉不划算，
    // 这里只在表格上体现；重开抽屉即最新。
  } catch (error) {
    row.values[field.key] = previous;
    if (cellEl) cellEl.innerHTML = renderCell(field, previous, cellCtx(field));
    markSaved();
    toast(`保存失败：${error?.message || error}`, 'danger');
  } finally {
    // 编辑器被移除后焦点会落到 body，随后 Delete / ↑↓ / Enter 全部失灵。
    // 只在「没人接手焦点」时把焦点还给单元格；用户点去别处就不抢。
    focusIfIdle(cellEl);
  }
}

function focusIfIdle(cellEl) {
  if (!cellEl || !cellEl.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  cellEl.focus?.({ preventScroll: true });
}

function startCellEdit(field, row, cellEl) {
  if (!cellEl || cellEl.classList.contains('ft-cell-editing')) return;
  if (field.type === 'attachment') {
    openAttachmentEditor(cellEl, field, row);
    return;
  }
  openCellEditor(cellEl, field, row.values[field.key], {
    getOptions: () => fieldOptionsList(field),
    // 表格内的日期统一走自研选择器：可选「只到日 / 到分钟」，风格和应用一致
    openDatePicker: (targetCell, targetField, currentValue, opts = {}) => {
      openDatePicker(targetCell, {
        value: currentValue,
        dateOnly: opts.dateOnly === true,
        onPick: pick => {
          Promise.resolve(opts.commit ? opts.commit(pick) : commitCell(field, row, cellEl, pick)).catch(() => {});
        },
        onClear: () => {
          Promise.resolve(opts.commit ? opts.commit('') : commitCell(field, row, cellEl, '')).catch(() => {});
        },
        onClose: () => opts.done?.(),
      });
    },
    ensureOption: async (targetField, label) => {
      const text = String(label || '').trim();
      if (!text) return null;
      const options = fieldOptionsList(targetField);
      const exists = options.find(item => item.label === text);
      if (exists) return exists;
      const next = [...options, { value: `v${Date.now().toString(36).slice(-5)}`, label: text, color: '#60a5fa' }];
      await patchField(targetField.id, { options: serializeOptions(next) });
      targetField.options = serializeOptions(next);
      return next[next.length - 1];
    },
    commit: value => commitCell(field, row, cellEl, value),
    toast,
    placeholder: cellCtx(field).placeholder,
    onSettled: () => focusIfIdle(cellEl),
  });
}

// ---- 图片单元格：粘贴 / 选择 / 删除 ----
async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

// 读图片原始尺寸：行高自适应时要按比例算，光有文件路径不够
function imageSize(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({});
    img.src = dataUrl;
  });
}

// MIME → 落盘扩展名。必须白名单：以前是 `file.type.split('/')[1]`，
// image/svg+xml 会变成 "svg+xml"、HEIC 会变成 "heic"，后端统一兜底存成 .png，
// 结果文件内容是 SVG/HEIC、扩展名是 png —— 缩略图必然裂。
const MIME_IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};
const IMAGE_EXT_ALLOWED = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

async function storeImageFile(file) {
  if (file.type === 'image/svg+xml' || extOfPath(file.name || '') === 'svg') {
    throw new Error('SVG 不支持嵌入，请先另存为 PNG');
  }
  const ext = MIME_IMAGE_EXT[file.type] || extOfPath(file.name || '') || '';
  if (!IMAGE_EXT_ALLOWED.includes(ext)) {
    throw new Error(`不支持的图片格式：${file.type || ext || '未知'}`);
  }
  const dataUrl = await fileToDataUrl(file);
  const dims = await imageSize(dataUrl);
  const path = await invoke('save_sheet_asset', { data: dataUrl, ext });
  return { path, name: file.name || '粘贴的图片', size: file.size || 0, w: dims.w || 0, h: dims.h || 0 };
}

// ---- 自动识别：图片按路径复制进资源目录，其他文件只记链接 ----
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

function extOfPath(path) {
  const match = String(path).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function nameOfPath(path) {
  const text = String(path);
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

function imageDimsFromSrc(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({});
    img.src = src;
  });
}

async function imageItemFromPath(path) {
  const saved = await invoke('save_sheet_asset_from_path', { source: path });
  const dims = await imageDimsFromSrc(convertSrc(saved.path));
  return {
    path: saved.path,
    name: saved.name || nameOfPath(path),
    size: saved.size || 0,
    w: dims.w || 0,
    h: dims.h || 0,
  };
}

// 打开系统选择框：图片自动嵌入，其他文件自动存链接。返回 nil 表示用户取消。
async function pickAttachmentItems() {
  const dialog = window.__TAURI__?.dialog;
  if (!dialog?.open) { toast('添加附件需要在应用内使用', 'info'); return []; }
  let picked;
  try {
    picked = await dialog.open({ multiple: true, title: '选择图片或文件（图片嵌入，其他只保存链接）' });
  } catch (error) {
    toast(`选择文件失败：${error?.message || error}`, 'danger');
    return [];
  }
  const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
  const items = [];
  for (const path of list) {
    const text = String(path);
    if (IMAGE_EXTS.includes(extOfPath(text))) {
      try {
        items.push(await imageItemFromPath(text));
      } catch (error) {
        toast(`图片处理失败：${error?.message || error}`, 'danger');
      }
    } else {
      items.push({ kind: 'file', path: text, name: nameOfPath(text) });
    }
  }
  return items;
}

// 单元格级追加：有内容的附件格右下角「＋」走这里；空格的双击也走这里
async function appendAttachments(field, row, cellEl, { replace = false } = {}) {
  const items = await pickAttachmentItems();
  if (!items.length) return;
  const base = replace ? [] : Array.isArray(row.values[field.key]) ? [...row.values[field.key]] : [];
  await commitCell(field, row, cellEl, [...base, ...items]);
  clearSelection();
  renderSheet();
  toast(`已添加 ${items.length} 个附件`);
}

function openAttachmentEditor(cellEl, field, row) {
  const current = Array.isArray(row.values[field.key]) ? [...row.values[field.key]] : [];

  const panel = openPopoverSimple(cellEl, `
    <div class="sh-img-zone" data-zone>
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-image"/></svg>
      <div class="sh-img-zone-text">Ctrl+V 粘贴截图，或把图片拖进来</div>
    </div>
    <div class="sh-img-list" data-list></div>
    <div class="sh-panel-foot">
      <button type="button" class="sh-linkbtn" data-pick title="图片会复制进应用目录，其他文件只保存链接">添加附件…</button>
      <span class="sh-foot-gap"></span>
      <button type="button" class="sh-btn" data-done>完成</button>
    </div>`);

  const listEl = panel.querySelector('[data-list]');
  const paintList = () => {
    listEl.innerHTML = current.length
      ? current
          .map((item, index) =>
            item.kind === 'file'
              ? `<span class="sh-img-item is-file" title="${escapeHtml(item.path)}">
                  <span class="sh-file-tile">${escapeHtml(item.name || String(item.path).split(/[\\/]/).pop() || '文件')}</span>
                  <button type="button" class="sh-img-del" data-remove="${index}" aria-label="移除">×</button>
                </span>`
              : `<span class="sh-img-item">
                  <img src="${escapeHtml(convertSrc(item.path))}" alt="${escapeHtml(item.name || '')}" />
                  <button type="button" class="sh-img-del" data-remove="${index}" aria-label="移除">×</button>
                </span>`
          )
          .join('')
      : '<div class="sh-img-empty">还没有图片或文件</div>';
  };
  paintList();

  const commitNow = async () => {
    await commitCell(field, row, cellEl, current);
    paintList();
  };

  const addFiles = async files => {
    const all = [...files];
    const images = all.filter(file => file.type.startsWith('image/'));
    if (!images.length) {
      if (all.length) toast('普通文件请点面板底部「添加附件…」，只保存链接、不复制文件', 'info');
      return;
    }
    if (images.length < all.length) toast('非图片文件已跳过，请用「添加附件…」添加链接', 'info');
    panel.classList.add('is-busy');
    try {
      for (const file of images) {
        // 顺序落盘，避免并发写同一个目录时文件名撞车
        const item = await storeImageFile(file);
        current.push(item);
      }
      await commitNow();
      toast(`已放入 ${images.length} 张图片`);
    } catch (error) {
      toast(`图片保存失败：${error?.message || error}`, 'danger');
    } finally {
      panel.classList.remove('is-busy');
    }
  };

  panel.querySelector('[data-pick]')?.addEventListener('click', async () => {
    const items = await pickAttachmentItems();
    if (!items.length) return;
    current.push(...items);
    await commitNow();
    toast(`已添加 ${items.length} 个附件`);
  });
  panel.querySelector('[data-zone]')?.addEventListener('click', async () => {
    const items = await pickAttachmentItems();
    if (!items.length) return;
    current.push(...items);
    await commitNow();
    toast(`已添加 ${items.length} 个附件`);
  });
  panel.querySelector('[data-done]')?.addEventListener('click', () => closeAllPanels());
  listEl.addEventListener('click', async event => {
    const index = event.target.closest('[data-remove]')?.dataset.remove;
    if (index == null) {
      const img = event.target.closest('img');
      if (img) {
        const gallery = [...listEl.querySelectorAll('img')].map(item => ({
          src: item.getAttribute('src'),
          name: item.getAttribute('alt') || '',
        }));
        openImagePreview(img.getAttribute('src'), img.getAttribute('alt') || '', gallery);
      }
      return;
    }
    current.splice(Number(index), 1);
    await commitNow();
  });

  const onPaste = event => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files = [...items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  };
  const onDragOver = event => { event.preventDefault(); panel.querySelector('[data-zone]')?.classList.add('is-hot'); };
  const onDragLeave = () => panel.querySelector('[data-zone]')?.classList.remove('is-hot');
  const onDrop = event => {
    event.preventDefault();
    panel.querySelector('[data-zone]')?.classList.remove('is-hot');
    addFiles(event.dataTransfer?.files || []);
  };

  document.addEventListener('paste', onPaste);
  panel.addEventListener('dragover', onDragOver);
  panel.addEventListener('dragleave', onDragLeave);
  panel.addEventListener('drop', onDrop);
  panel._cleanup = () => {
    document.removeEventListener('paste', onPaste);
    panel.removeEventListener('dragover', onDragOver);
    panel.removeEventListener('dragleave', onDragLeave);
    panel.removeEventListener('drop', onDrop);
  };
}

// 简化版浮层：不依赖 sheetPanels 的 anchor 逻辑（锚点是单元格，带滚动偏移）
function openPopoverSimple(anchorEl, html) {
  closeAllPanels();
  const el = document.createElement('div');
  el.className = 'sh-pop sh-imgpanel';
  el.innerHTML = html;
  document.body.appendChild(el);

  const rect = anchorEl.getBoundingClientRect();
  const width = el.offsetWidth || 280;
  const height = el.offsetHeight || 240;
  let left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const onOutside = event => {
    if (el.contains(event.target) || anchorEl.contains(event.target)) return;
    closeAllPanels();
  };
  const onKey = event => { if (event.key === 'Escape') closeAllPanels(); };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);

  // 借用 closeAllPanels 的统一收尾：注册到同一套状态里
  registerActivePanel({ el, onOutside, onKey, onClose: () => el._cleanup?.() });
  return el;
}

// ==========================================
// 行操作
// ==========================================

async function addRow() {
  // 新建的就是一行空记录，不预填任何字段值（所见即所得：建出来什么样就是什么样）
  const values = {};
  let id = null;
  try {
    id = await insertRow(state.sheet.id, values);
    await reloadRows();
    await touchSheet(state.sheet.id);
  } catch (error) {
    toast(`新建记录失败：${error?.message || error}`, 'danger');
    return;
  }
  renderSheet();

  // 长表是分块渲染的，新记录在最后一块：先补块补到能看见它，再滚过去。
  // 以前超过 60 行时这里根本查不到元素，新建完什么都不发生。
  const cell = ensureRowRendered(id);
  if (cell) {
    cell.scrollIntoView({ block: 'nearest' });
    const field = state.fields.find(item => item.key === cell.dataset.key);
    const row = state.rows.find(item => String(item.id) === String(id));
    if (field && row) {
      if (sel.cells.size > 1 || sel.fieldKeys.length) clearSelection();
      startCellEdit(field, row, cell);
    }
  }
}

// 分块渲染的表格里按 row id 找单元格；找不到就继续往下补块（最多补到上限）。
function ensureRowRendered(rowId) {
  if (rowId == null) return null;
  const selector = `.sh-cell[data-row="${CSS.escape(String(rowId))}"]`;
  let cell = host?.querySelector(selector) || null;
  const limit = Math.min(state.rowTotal, ROW_LIMIT_HINT);
  let guard = 0;
  while (!cell && state.rendered < limit && guard < ROW_LIMIT_HINT) {
    renderBodyRows(false);
    cell = host?.querySelector(selector) || null;
    guard += 1;
  }
  return cell;
}

async function removeRow(row) {
  const title = rowTitle(row.values, state.fields);
  window.showModal?.('删除记录', `<p style="margin:0;">删除「${escapeHtml(title)}」？此操作无法撤销。</p>`, null, async () => {
    try {
      await deleteRow(row.id);
      await reloadRows();
    } catch (error) {
      toast(`删除失败：${error?.message || error}`, 'danger');
      return false;
    }
    closeAllPanels();
    renderSheet();
    toast('记录已删除');
    return true;
  }, { danger: true, btnText: '删除' });
}

function openRowMenuFor(anchorEl, row) {
  const list = rowsInView();
  const index = list.findIndex(item => String(item.id) === String(row.id)) + 1;
  openRowMenu(anchorEl, row, index, {
    detail: () => openDetail(row),
    // 复制记录 = 暂存到内部剪贴板；粘贴靠目标行右键或 Ctrl+V
    copy: () => copyRowToClipboard(row),
    paste: () => pasteRowFromClipboard([row]),
    insertAbove: count => insertRows(row, count, 'above'),
    insertBelow: count => insertRows(row, count, 'below'),
    height: value => applyRowHeight(row, value),
    'autofit-row': () => autoFitRow(row),
    delete: () => removeRow(row),
  });
}

// ==========================================
// 复制 / 粘贴（内部剪贴板：先复制，再选中目标粘贴）
// ==========================================

function copyCellToClipboard(field, row) {
  clipboard.kind = 'cell';
  clipboard.fieldType = field.type;
  clipboard.value = cloneValue(row.values[field.key]);
  clipboard.values = null;
  clipboard.block = null;
  clipboard.rowLabel = field.label;
  // 顺带给系统剪贴板留一份纯文本，方便粘到外面
  const text = displayValue(field, row.values[field.key]);
  if (text) navigator.clipboard?.writeText(text).catch(() => {});
  toast('已复制该单元格，选中同类型的单元格后 Ctrl+V 粘贴');
}

function copyRowToClipboard(row) {
  clipboard.kind = 'row';
  clipboard.values = cloneValue(row.values);
  clipboard.fieldType = '';
  clipboard.value = null;
  clipboard.block = null;
  clipboard.rowLabel = rowTitle(row.values, state.fields) || '记录';
  toast('已复制整行，选中目标行后 Ctrl+V 粘贴');
}

// Ctrl+C / 菜单「复制」的统一入口：行、单格、多格都能复制
function copySelectionToClipboard() {
  const rows = rowsInView();
  const cols = visibleOf(state.fields);

  if (sel.mode === 'rows' && sel.rowIds.length) {
    const row = rows.find(item => String(item.id) === String(sel.rowIds[0]));
    if (!row) return false;
    copyRowToClipboard(row);
    return true;
  }
  if (!sel.cells.size) return false;

  if (sel.cells.size === 1) {
    const [r, c] = [...sel.cells][0].split(':').map(Number);
    const row = rows[r];
    const field = cols[c];
    if (!row || !field) return false;
    copyCellToClipboard(field, row);
    return true;
  }

  // 多格：按相对偏移打包，保留「A1 + D5」这种不连续选区
  const coords = [...sel.cells].map(key => key.split(':').map(Number));
  const minR = Math.min(...coords.map(pair => pair[0]));
  const minC = Math.min(...coords.map(pair => pair[1]));
  const items = coords
    .map(([r, c]) => {
      const row = rows[r];
      const field = cols[c];
      if (!row || !field) return null;
      return {
        dr: r - minR,
        dc: c - minC,
        fieldType: field.type,
        value: cloneValue(row.values[field.key]),
      };
    })
    .filter(Boolean);
  if (!items.length) return false;
  clipboard.kind = 'block';
  clipboard.block = { items };
  clipboard.fieldType = '';
  clipboard.value = null;
  clipboard.values = null;
  clipboard.rowLabel = `${items.length} 格`;
  toast(`已复制 ${items.length} 格，选中目标单元格后 Ctrl+V 粘贴`);
  return true;
}

async function pasteCellFromClipboard(field, row, cellEl) {
  if (clipboard.kind === 'block') return pasteBlockFromClipboard(cellEl);

  const applyValue = async value => {
    await commitCell(field, row, cellEl, value);
    // 图片会改变行高，重绘一次；普通字段只重画这一格，保住选中态
    if (field.type === 'attachment') {
      renderSheet();
      clearSelection();
    }
    toast('已粘贴（覆盖原内容）');
  };

  if (clipboard.kind === 'cell') {
    if (clipboard.fieldType !== field.type) {
      toast('字段类型不同，不能粘贴', 'info');
      return false;
    }
    await applyValue(cloneValue(clipboard.value));
    return true;
  }
  if (clipboard.kind === 'row') {
    if (!clipboard.values || !Object.prototype.hasOwnProperty.call(clipboard.values, field.key)) {
      toast('复制的记录里没有这一列', 'info');
      return false;
    }
    await applyValue(cloneValue(clipboard.values[field.key]));
    return true;
  }
  return false;
}

// 粘贴多格：以目标格为左上角，按相对偏移写入；类型不一致的列跳过
async function pasteBlockFromClipboard(cellEl) {
  const block = clipboard.block;
  if (!block || !block.items?.length) return false;
  const rows = rowsInView();
  const cols = visibleOf(state.fields);
  const r0 = Number(cellEl.dataset.rowindex);
  const c0 = Number(cellEl.dataset.col);
  const touchedRows = new Map();
  const skipped = new Set();

  block.items.forEach(item => {
    const row = rows[r0 + item.dr];
    const field = cols[c0 + item.dc];
    if (!row || !field) return;
    if (field.type !== item.fieldType) { skipped.add(field.label); return; }
    let entry = touchedRows.get(row.id);
    if (!entry) { entry = { row, touched: false }; touchedRows.set(row.id, entry); }
    row.values[field.key] = cloneValue(item.value);
    entry.touched = true;
  });

  if (!touchedRows.size) {
    toast(skipped.size ? '目标区域字段类型不一致，无法粘贴' : '放不下：目标位置超出表格范围', 'info');
    return false;
  }
  markSaving();
  try {
    for (const { row, touched } of touchedRows.values()) {
      if (touched) await writeRow(row);
    }
    await touchSheet(state.sheet.id);
    markSaved();
    clearSelection();
    renderSheet();
    toast(skipped.size ? `已粘贴，跳过 ${skipped.size} 列（类型不一致）` : `已粘贴 ${block.items.length} 格`);
    return true;
  } catch (error) {
    markSaved();
    toast(`粘贴失败：${error?.message || error}`, 'danger');
    return false;
  }
}

async function pasteRowFromClipboard(targetRows) {
  if (clipboard.kind !== 'row' || !clipboard.values) {
    toast('剪贴板里没有整行记录，先「复制记录」', 'info');
    return false;
  }
  const rows = targetRows.filter(Boolean);
  if (!rows.length) return false;
  try {
    for (const row of rows) {
      visibleFields().forEach(field => {
        if (Object.prototype.hasOwnProperty.call(clipboard.values, field.key)) {
          row.values[field.key] = cloneValue(clipboard.values[field.key]);
        }
      });
      await writeRow(row);
    }
    await touchSheet(state.sheet.id);
  } catch (error) {
    toast(`粘贴失败：${error?.message || error}`, 'danger');
    return false;
  }
  clearSelection();
  renderSheet();
  toast(rows.length > 1 ? `已粘贴到 ${rows.length} 行` : '已粘贴记录内容');
  return true;
}

// ==========================================
// 单元格格式（底色 / 对齐 / 换行）
// ==========================================

function applyCellFormatToEl(cellEl, field, row) {
  if (!cellEl) return;
  const fmt = cellFormat(row, field);
  cellEl.classList.remove('is-h-left', 'is-h-center', 'is-h-right', 'is-v-top', 'is-v-middle', 'is-v-bottom');
  if (fmt.h) cellEl.classList.add(`is-h-${fmt.h}`);
  if (fmt.v) cellEl.classList.add(`is-v-${fmt.v}`);
  if (isHexColor(fmt.bg)) cellEl.style.setProperty('--cell-bg', fmt.bg);
  else cellEl.style.removeProperty('--cell-bg');
  const wrap = fmt.wrap === undefined ? field.type === 'text' && isWrapField(field) : fmt.wrap === true;
  cellEl.classList.toggle('is-wrap', wrap);
  // 行高固定 + 换行：按可用高度重算截断行数。
  // 以前只关不打开，格式面板里把换行打开后文字会直接溢出到下一行。
  const fixedHeight = Number(row?.height) || 0;
  if (wrap && fixedHeight > 0) {
    cellEl.style.setProperty('--clamp', String(Math.max(1, Math.floor((fixedHeight - 18) / 21))));
    cellEl.classList.add('is-clamped');
  } else {
    cellEl.style.removeProperty('--clamp');
    cellEl.classList.remove('is-clamped');
  }
}

// 格式改动很频繁（点一下一个色块），350ms 合并成一次写库，拖动/连点都不卡。
// 定时器必须按行分桶：共用一个定时器时，350ms 内改了两行，前一行永远不会落库。
const formatSaveTimers = new Map();
function saveRowSoon(row) {
  const key = String(row.id);
  clearTimeout(formatSaveTimers.get(key));
  formatSaveTimers.set(
    key,
    setTimeout(() => {
      formatSaveTimers.delete(key);
      writeRow(row).catch(() => toast('格式保存失败', 'danger'));
    }, 350)
  );
}

function setCellFormat(cellEl, field, row, patch) {
  const values = row.values;
  const map = values.__fmt && typeof values.__fmt === 'object' ? { ...values.__fmt } : {};
  const current = { ...(map[field.key] || {}) };
  Object.entries(patch || {}).forEach(([key, val]) => {
    if (val === undefined || val === null || val === '') delete current[key];
    else current[key] = val;
  });
  if (Object.keys(current).length) map[field.key] = current;
  else delete map[field.key];
  if (Object.keys(map).length) values.__fmt = map;
  else delete values.__fmt;
  applyCellFormatToEl(cellEl, field, row);
  saveRowSoon(row);
}

function clearCellFormat(cellEl, field, row) {
  if (row.values.__fmt && typeof row.values.__fmt === 'object') {
    delete row.values.__fmt[field.key];
    if (!Object.keys(row.values.__fmt).length) delete row.values.__fmt;
  }
  applyCellFormatToEl(cellEl, field, row);
  saveRowSoon(row);
}

async function applyFormatToColumn(field, format) {
  // 走统一合并器：选项、换行、日期精度都原样保留，只替换 format
  const next = mergeFieldOptions(field, {
    format: format && Object.keys(format).length ? format : null,
  });
  try {
    await patchField(field.id, { options: next });
  } catch (error) {
    toast(`设置列格式失败：${error?.message || error}`, 'danger');
    return;
  }
  field.options = next;
  renderSheet();
  toast(`「${field.label}」已设为该列默认格式`);
}

// ==========================================
// 单元格右键菜单 + 粘贴
// ==========================================

function openCellMenuFor(cellEl, field, row) {
  const value = row.values[field.key];
  const attachItems = field.type === 'attachment' && Array.isArray(value) ? value.filter(item => item && item.path) : [];
  const hasImages = attachItems.some(item => item.kind !== 'file');
  const cellKey = `${Number(cellEl.dataset.rowindex)}:${Number(cellEl.dataset.col)}`;
  const count = (sel.mode === 'cells' || sel.mode === 'cell') && sel.cells.has(cellKey) ? sel.cells.size : 1;
  openCellMenu(cellEl, { field, value, hasImages, hasItems: attachItems.length > 0, count }, {
    copy: () => copySelectionToClipboard(),
    paste: () => {
      // 优先用内部剪贴板（能搬图片等复杂值），没有才读系统剪贴板
      if (hasInternalClipboard()) { pasteCellFromClipboard(field, row, cellEl); return; }
      pasteFromClipboard(field, row, cellEl);
    },
    edit: () => startCellEdit(field, row, cellEl),
    format: () => openCellFormatPanel(
      cellEl,
      {
        field,
        columnFormat: fieldFormat(field),
        cellFormat: (row.values.__fmt && row.values.__fmt[field.key]) || {},
      },
      {
        set: patch => setCellFormat(cellEl, field, row, patch),
        clear: () => clearCellFormat(cellEl, field, row),
        column: format => applyFormatToColumn(field, format),
      }
    ),
    preview: () => {
      const gallery = [...cellEl.querySelectorAll('img.ft-att-thumb')].map(img => ({
        src: img.getAttribute('src'),
        name: img.getAttribute('alt') || '',
      }));
      if (gallery.length) openImagePreview(gallery[0].src, gallery[0].name, gallery);
    },
    clear: () => {
      // 菜单头写的是「已选 N 格」，就清整片选区，不能只清右键落点那一格
      if ((sel.mode === 'cells' || sel.mode === 'cell') && sel.cells.size > 1 && sel.cells.has(cellKey)) {
        bulkWriteCells('clear');
        return;
      }
      const empty = field.type === 'checkbox' ? false : field.type === 'attachment' ? [] : '';
      commitCell(field, row, cellEl, empty);
    },
    insertAbove: () => insertRows(row, 1, 'above'),
    insertBelow: () => insertRows(row, 1, 'below'),
    deleteRow: () => removeRow(row),
  });
}

// 剪贴板内容写进单元格：图片/文本都是「覆盖」语义
async function applyPastedContent(field, row, cellEl, { files = [], text = '' }) {
  const imageFile = [...files].find(file => file && file.type && file.type.startsWith('image/'));
  if (imageFile) {
    if (field.type !== 'attachment') { toast('这一列不是图片字段', 'info'); return false; }
    try {
      const item = await storeImageFile(imageFile);
      await commitCell(field, row, cellEl, [item]);
      clearSelection();
      renderSheet();
      toast('已粘贴图片（覆盖原内容；要追加请右键「管理附件」）');
      return true;
    } catch (error) {
      toast(`粘贴失败：${error?.message || error}`, 'danger');
      return false;
    }
  }
  if (!text) return false;
  if (field.type === 'text' || field.type === 'number') {
    // 所见即所得：粘贴进来的文本原样存，不转数字、不 trim
    await commitCell(field, row, cellEl, text);
    toast('已粘贴');
    return true;
  }
  toast('这一列不支持粘贴文本', 'info');
  return true;
}

function filesFromDataTransfer(dt) {
  if (!dt) return { files: [], text: '' };
  const files = [...(dt.files || [])];
  if (!files.length && dt.items) {
    for (const item of dt.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  return { files, text: dt.getData ? dt.getData('text/plain') || '' : '' };
}

// 菜单里点「粘贴（覆盖）」：走异步剪贴板 API，拿不到就提示用 Ctrl+V
async function pasteFromClipboard(field, row, cellEl) {
  try {
    const files = [];
    let text = '';
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(type => type.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          files.push(new File([blob], `粘贴的图片-${Date.now()}.png`, { type: imageType }));
          continue;
        }
        if (item.types.includes('text/plain')) {
          text = await (await item.getType('text/plain')).text();
        }
      }
    }
    if (!files.length && !text) text = (await navigator.clipboard?.readText?.()) || '';
    if (!files.length && !text) { toast('剪贴板里没有可粘贴的内容', 'info'); return false; }
    return applyPastedContent(field, row, cellEl, { files, text });
  } catch (error) {
    toast('无法读取剪贴板，请选中单元格后按 Ctrl+V', 'info');
    return false;
  }
}

async function insertRows(row, count, side) {
  const sortIndex = Number(row.sort || 0) + (side === 'below' ? 1 : 0);
  try {
    await insertRowAt(state.sheet.id, sortIndex, count);
    await reloadRows();
    await touchSheet(state.sheet.id);
  } catch (error) {
    toast(`插入行失败：${error?.message || error}`, 'danger');
    return;
  }
  renderSheet();
  toast(`已插入 ${count} 行`);
}

async function applyRowHeight(row, height) {
  try {
    await setRowHeight(row.id, height);
  } catch (error) {
    toast(`行高没存住：${error?.message || error}`, 'danger');
    return;
  }
  row.height = height;
  renderSheet();
}

// 最适合的行高：文字按列宽折行算行数，图片按列宽等比折算高度，取最大。
function estimateLines(text, width, fontSize = 13.5, lineHeight = 21) {
  if (!text) return 1;
  const canvas = estimateLines._canvas || (estimateLines._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px system-ui, -apple-system, "Noto Sans SC", sans-serif`;
  let lines = 1;
  let current = 0;
  for (const char of String(text)) {
    if (char === '\n') { lines += 1; current = 0; continue; }
    const w = ctx.measureText(char).width;
    if (current + w > width) { lines += 1; current = w; }
    else current += w;
  }
  return Math.max(1, lines);
}

function measureRowHeight(row) {
  const cols = visibleOf(state.fields);
  let height = 42;
  cols.forEach(field => {
    const value = row.values[field.key];
    if (value == null || value === '') return;

    if (field.type === 'attachment') {
      // 折叠式多图与单图一样：第一张铺满列宽，行高跟着它的比例走
      const items = Array.isArray(value) ? value.filter(item => item && item.path) : [];
      const first = items[0];
      if (first?.w && first?.h) {
        const imgHeight = Math.round((fieldWidth(field) - 24) * (Number(first.h) / Number(first.w)));
        height = Math.max(height, imgHeight + 18);
      }
      return;
    }

    if (field.type !== 'text') return;
    const wrap = isWrapField(field);
    const text = String(value);
    if (!wrap) {
      // 单行：内容再长也只需要一行
      return;
    }
    const usable = Math.max(40, fieldWidth(field) - 26);
    const lines = estimateLines(text, usable);
    height = Math.max(height, lines * 21 + 20);
  });
  return Math.min(600, Math.max(28, Math.round(height)));
}

function isWrapField(field) {
  try {
    const parsed = field?.options ? JSON.parse(field.options) : null;
    return Boolean(parsed && parsed.wrap);
  } catch (error) {
    return false;
  }
}

async function autoFitRow(row) {
  const height = measureRowHeight(row);
  await applyRowHeight(row, height);
  toast(`行高已按内容调整为 ${height}px`);
}

function openDetail(row) {
  const list = filterRows(state.rows);
  const index = list.findIndex(item => String(item.id) === String(row.id)) + 1;
  openRowDrawer({
    row,
    fields: state.fields,
    index,
    total: list.length,
    subtitle: `${state.sheet.name} · 第 ${index} / ${list.length} 条`,
    onCellClick: (field, cellEl) => {
      const live = state.rows.find(item => String(item.id) === String(row.id)) || row;
      startCellEdit(field, live, cellEl);
    },
    onDelete: target => removeRow(target),
    onPrev: () => {
      const prev = list[index - 2];
      if (!prev) return;
      closeAllPanels();
      openDetail(prev);
    },
    onNext: () => {
      const next = list[index];
      if (!next) return;
      closeAllPanels();
      openDetail(next);
    },
  });
}

// ==========================================
// 字段操作
// ==========================================

function addFieldAt(anchorField, side) {
  const ordered = [...state.fields].sort((a, b) => Number(a.sort) - Number(b.sort));
  const index = anchorField ? ordered.findIndex(item => item.id === anchorField.id) : ordered.length - 1;
  const anchorSort = Number(ordered[index]?.sort || 0);
  const insertSort = side === 'left' ? anchorSort : anchorSort + 1;
  // 不再「先落一条新字段再开面板」：用户按 Esc / 取消会永久留下一条空列。
  // 现在只有点了「保存字段」才真正建列。
  openFieldPanelFor(null, { mode: 'new', sort: insertSort });
}

function openFieldPanelFor(field, { mode = 'edit', sort = null } = {}) {
  openFieldPanel({
    field: mode === 'edit' ? field : null,
    sheetName: state.sheet?.name || '',
    onSave: async payload => {
      try {
        const hasOptions = payload.type === 'select' || payload.type === 'multi_select';
        // 只覆盖本次真正改到的键。以前是「重新拼一个 options JSON」，
        // 顺手把列级 format（底色/对齐/换行）抹掉了 —— 改个字段名就丢格式。
        const optionsJson = mergeFieldOptions(field, {
          source: 'custom',
          options: hasOptions ? payload.options || [] : undefined,
          // 类型换了就把不再适用的开关显式清掉，别留一个看不见的 wrap/dateOnly
          wrap: payload.type === 'text' ? (payload.wrap ? true : null) : null,
          dateOnly: payload.type === 'date' ? (payload.dateOnly ? true : null) : null,
        });
        if (mode === 'edit' && field) {
          await patchField(field.id, {
            label: payload.label,
            type: payload.type,
            options: optionsJson,
          });
          toast('字段已更新');
        } else {
          await createField(state.sheet.id, {
            label: payload.label,
            type: payload.type,
            options: optionsJson,
            sort,
          });
          toast('字段已添加');
        }
        await reloadFields();
        renderSheet();
      } catch (error) {
        toast(`保存字段失败：${error?.message || error}`, 'danger');
      }
    },
    onDelete: async target => {
      if (!target) return;
      try {
        await deleteField(target.id);
        await reloadFields();
      } catch (error) {
        toast(`删除字段失败：${error?.message || error}`, 'danger');
        return;
      }
      renderSheet();
      toast(`已删除「${target.label}」`);
    },
  });
}

// ==========================================
// 新建 / 重命名 / 删除表
// ==========================================

// 模板名 → 默认表名：「任务跟踪」补成「任务跟踪表」，读起来才像一张表
function defaultSheetName(templateKey) {
  const name = SHEET_TEMPLATES.find(item => item.key === templateKey)?.name || '新建表格';
  return name.endsWith('表') ? name : `${name}表`;
}

function openNewSheetModal(preset = null) {
  const defaultTemplate = preset || 'task';
  const taskOptions = [
    '<option value="">不归属任务</option>',
    ...state.tasks.map(
      task => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.label)}${task.done ? '（已完成）' : ''}</option>`
    ),
  ].join('');

  const body = `
    <div class="sh-modal">
      <label class="sh-label">表格名称</label>
      <input type="text" class="sh-input" data-name value="${escapeHtml(defaultSheetName(defaultTemplate))}" placeholder="例如：任务跟踪表" />

      <label class="sh-label sh-label-gap">所属任务</label>
      <select class="sh-select" data-task>${taskOptions}</select>

      <label class="sh-label sh-label-gap">起点</label>
      <div class="sh-template-list" data-templates>
        ${SHEET_TEMPLATES.map(
          item => `<button type="button" class="sh-template${item.key === defaultTemplate ? ' is-active' : ''}" data-template="${item.key}">
            <span class="sh-template-name">${escapeHtml(item.name)}</span>
            <span class="sh-template-desc">${escapeHtml(item.desc)}</span>
          </button>`
        ).join('')}
      </div>
      <div class="sh-empty-note">数据写入本地数据库，不联网也能用。</div>
    </div>`;

  window.showModal?.('新建表格', body, modalBody => {
    const nameInput = modalBody.querySelector('[data-name]');
    nameInput?.focus();
    nameInput?.select();
    modalBody.querySelector('[data-templates]')?.addEventListener('click', event => {
      const btn = event.target.closest('[data-template]');
      if (!btn) return;
      modalBody.querySelectorAll('.sh-template').forEach(item => item.classList.toggle('is-active', item === btn));
      if (nameInput) nameInput.value = defaultSheetName(btn.dataset.template);
    });
  }, async modalBody => {
    const name = modalBody.querySelector('[data-name]')?.value.trim();
    const template = modalBody.querySelector('.sh-template.is-active')?.dataset.template || 'blank';
    const taskId = modalBody.querySelector('[data-task]')?.value || null;
    if (!name) { modalBody.querySelector('[data-name]')?.focus(); return false; }
    try {
      const sheetId = await createSheet({ name, taskId, templateKey: template });
      await refreshSheets();
      await openSheet(sheetId);
      toast('表格已创建');
      return true;
    } catch (error) {
      toast(`创建失败：${error?.message || error}`, 'danger');
      return false;
    }
  }, { btnText: '创建表格' });
}

function renameSheet() {
  if (!state.sheet) return;
  window.showModal?.('重命名表格', `
    <div class="sh-modal">
      <label class="sh-label">表格名称</label>
      <input type="text" class="sh-input" data-name value="${escapeHtml(state.sheet.name)}" />
    </div>`, modalBody => {
    const input = modalBody.querySelector('[data-name]');
    input?.focus();
    input?.select();
  }, async modalBody => {
    const name = modalBody.querySelector('[data-name]')?.value.trim();
    if (!name) return false;
    try {
      await updateSheet(state.sheet.id, { name });
    } catch (error) {
      toast(`重命名失败：${error?.message || error}`, 'danger');
      return false;
    }
    state.sheet.name = name;
    await refreshSheets();
    renderSheet();
    toast('已重命名');
    return true;
  }, { btnText: '保存' });
}

function openSheetMenu(anchorEl) {
  if (!state.sheet) return;
  const el = openPopoverSimple(anchorEl, `
    <button type="button" class="sh-menu-item" data-sheet-act="rename">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-pencil"/></svg>重命名表格
    </button>
    <button type="button" class="sh-menu-item" data-sheet-act="task">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-tag"/></svg>改所属任务
    </button>
    <div class="sh-colmenu-sep"></div>
    <button type="button" class="sh-menu-item is-danger" data-sheet-act="delete">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-trash"/></svg>删除表格
    </button>`);
  el.classList.add('sh-rowmenu');
  el.addEventListener('click', async event => {
    const action = event.target.closest('[data-sheet-act]')?.dataset.sheetAct;
    if (!action) return;
    closeAllPanels();
    if (action === 'rename') renameSheet();
    if (action === 'task') {
      const taskOptions = ['<option value="">不归属任务</option>', ...state.tasks.map(task => `<option value="${escapeHtml(task.id)}" ${String(task.id) === String(state.sheet.task_id) ? 'selected' : ''}>${escapeHtml(task.label)}${task.done ? '（已完成）' : ''}</option>`)].join('');
      window.showModal?.('改所属任务', `<div class="sh-modal"><label class="sh-label">所属任务</label><select class="sh-select" data-task>${taskOptions}</select></div>`, null, async modalBody => {
        const value = modalBody.querySelector('[data-task]')?.value || null;
        try {
          await updateSheet(state.sheet.id, { task_id: value == null ? null : Number(value) });
        } catch (error) {
          toast(`更新归属失败：${error?.message || error}`, 'danger');
          return false;
        }
        state.sheet.task_id = value;
        await refreshSheets();
        renderSheet();
        toast('已更新归属');
        return true;
      }, { btnText: '保存' });
    }
    if (action === 'delete') {
      window.showModal?.('删除表格', `<p style="margin:0;">删除「${escapeHtml(state.sheet.name)}」以及它的 ${state.rows.length} 条记录？此操作无法撤销。</p>`, null, async () => {
        try {
          await deleteSheet(state.sheet.id);
        } catch (error) {
          toast(`删除失败：${error?.message || error}`, 'danger');
          return false;
        }
        backToLibrary();
        toast('表格已删除');
        return true;
      }, { danger: true, btnText: '删除' });
    }
  });
}

// ==========================================
// 事件
// ==========================================

// ==========================================
// 多选：拖框选单元格 / Ctrl 点表头选列
// ==========================================

const sel = {
  mode: '',           // '' | 'cell' | 'cells' | 'fields'
  cells: new Set(),   // "rowIndex:colIndex"，只用于高亮
  rowIds: [],
  fieldKeys: [],
  anchor: null,       // Ctrl 扩展选区的起点 {r,c}
};

let dragSel = null;
let suppressClick = false;
// "行:列" → 单元格元素。拖框选择时按 diff 只改变化的格子，
// 避免每次 pointermove 全表 querySelectorAll + classList（几千格时明显卡）。
let cellEls = new Map();

function rebuildCellIndex() {
  cellEls = new Map();
  host?.querySelectorAll('.sh-cell[data-rowindex]').forEach(el => {
    cellEls.set(`${el.dataset.rowindex}:${el.dataset.col}`, el);
  });
}

function rowsInView() {
  return filterRows(state.rows);
}

function clearSelection() {
  sel.mode = '';
  sel.cells.clear();
  sel.rowIds = [];
  sel.fieldKeys = [];
  sel.anchor = null;
  cellEls.forEach(el => el.classList.remove('is-sel', 'is-active'));
  host?.querySelectorAll('.sh-th.is-picked').forEach(el => el.classList.remove('is-picked'));
  host?.querySelectorAll('.sh-row.is-picked').forEach(el => el.classList.remove('is-picked'));
  host?.querySelector('.sh-bulk')?.remove();
}

// 用「目标集合」统一驱动高亮：只 toggle 进出集合的格子（拖选时通常只有一列/一行变化）。
// anchorEl 会被标成 is-active（Ctrl+V 的粘贴起点）。
function applyCellSet(next, anchorEl) {
  const prev = sel.cells;
  prev.forEach(key => {
    if (next.has(key)) return;
    cellEls.get(key)?.classList.remove('is-sel', 'is-active');
  });
  next.forEach(key => {
    if (prev.has(key)) return;
    cellEls.get(key)?.classList.add('is-sel');
  });
  cellEls.forEach(el => el.classList.remove('is-active'));
  if (anchorEl) anchorEl.classList.add('is-active');

  sel.cells = next;
  sel.mode = next.size > 1 ? 'cells' : 'cell';
  host.querySelectorAll('.sh-row.is-picked').forEach(el => el.classList.remove('is-picked'));
  host.querySelectorAll('.sh-th.is-picked').forEach(el => el.classList.remove('is-picked'));
  updateBulkBar();
}

function paintCellSelection(a, b) {
  const top = Math.min(a.r, b.r);
  const bottom = Math.max(a.r, b.r);
  const left = Math.min(a.c, b.c);
  const right = Math.max(a.c, b.c);
  const next = new Set();
  for (let r = top; r <= bottom; r += 1) {
    for (let c = left; c <= right; c += 1) next.add(`${r}:${c}`);
  }
  const anchorEl = cellEls.get(`${a.r}:${a.c}`) || cellEls.get(`${top}:${left}`);
  sel.anchor = { r: a.r, c: a.c };
  applyCellSet(next, anchorEl);
}

// 单击选中：普通=单格；Ctrl=加/减单格（不拉矩形）；Shift=从锚点扩展矩形
function selectCell(cell, options = {}) {
  const additive = options.additive === true;
  const range = options.range === true;
  const rowIndex = Number(cell.dataset.rowindex);
  const colIndex = Number(cell.dataset.col);
  if (Number.isNaN(rowIndex) || Number.isNaN(colIndex)) return;

  if (range && sel.anchor) {
    paintCellSelection(sel.anchor, { r: rowIndex, c: colIndex });
    return;
  }

  if (additive) {
    const key = `${rowIndex}:${colIndex}`;
    const base = sel.mode === 'cells' || sel.mode === 'cell' ? sel.cells : new Set();
    const next = new Set(base);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    if (!next.size) { clearSelection(); return; }
    sel.anchor = { r: rowIndex, c: colIndex };
    applyCellSet(next, cell);
    return;
  }

  clearSelection();
  sel.anchor = { r: rowIndex, c: colIndex };
  const next = new Set([`${rowIndex}:${colIndex}`]);
  applyCellSet(next, cell);
  const row = state.rows.find(item => String(item.id) === String(cell.dataset.row));
  const field = state.fields.find(item => item.key === cell.dataset.key);
  sel.rowIds = row ? [row.id] : [];
  sel.fieldKeys = field ? [field.key] : [];
}

function toggleFieldSelection(key, range, additive = true) {
  const cols = visibleOf(state.fields);
  if (!additive) {
    // 普通左键：只选中这一列
    sel.mode = 'fields';
    sel.fieldKeys = [key];
    sel.cells.clear();
    sel.rowIds = [];
    host.querySelectorAll('.sh-cell.is-sel, .sh-cell.is-active').forEach(el => el.classList.remove('is-sel', 'is-active'));
    host.querySelectorAll('.sh-row.is-picked').forEach(el => el.classList.remove('is-picked'));
    host.querySelectorAll('.sh-th').forEach(th => th.classList.toggle('is-picked', th.dataset.key === key));
    updateBulkBar();
    return;
  }
  if (range && sel.fieldKeys.length) {
    const from = cols.findIndex(field => field.key === sel.fieldKeys[sel.fieldKeys.length - 1]);
    const to = cols.findIndex(field => field.key === key);
    if (from >= 0 && to >= 0) {
      const [a, b] = from <= to ? [from, to] : [to, from];
      sel.fieldKeys = cols.slice(a, b + 1).map(field => field.key);
    }
  } else if (sel.fieldKeys.includes(key)) {
    sel.fieldKeys = sel.fieldKeys.filter(item => item !== key);
  } else {
    sel.fieldKeys = [...sel.fieldKeys, key];
  }
  sel.mode = 'fields';
  sel.cells.clear();
  sel.rowIds = [];
  host.querySelectorAll('.sh-cell.is-sel').forEach(el => el.classList.remove('is-sel'));
  host.querySelectorAll('.sh-row.is-picked').forEach(el => el.classList.remove('is-picked'));
  host.querySelectorAll('.sh-th').forEach(th => th.classList.toggle('is-picked', sel.fieldKeys.includes(th.dataset.key)));
  updateBulkBar();
}

// 行选中：与列选中同一套手势——单击选一行、Ctrl 累加、Shift 连选。
// 高亮整行（is-picked），批量条给「删除」。
function paintRowSelection() {
  host.querySelectorAll('.sh-cell.is-sel, .sh-cell.is-active').forEach(el => el.classList.remove('is-sel', 'is-active'));
  host.querySelectorAll('.sh-th.is-picked').forEach(el => el.classList.remove('is-picked'));
  const picked = new Set(sel.rowIds.map(id => String(id)));
  host.querySelectorAll('.sh-row').forEach(tr => tr.classList.toggle('is-picked', picked.has(String(tr.dataset.id))));
  updateBulkBar();
}

function toggleRowSelection(rowId, range, additive = true) {
  const rows = rowsInView();
  const isPicked = sel.mode === 'rows' && sel.rowIds.some(id => String(id) === String(rowId));

  if (range && sel.mode === 'rows' && sel.rowIds.length) {
    // Shift 连选：从最近一次选中的行拉到这一行
    const from = rows.findIndex(item => String(item.id) === String(sel.rowIds[sel.rowIds.length - 1]));
    const to = rows.findIndex(item => String(item.id) === String(rowId));
    if (from >= 0 && to >= 0) {
      const [a, b] = from <= to ? [from, to] : [to, from];
      sel.rowIds = rows.slice(a, b + 1).map(item => item.id);
    }
  } else if (additive && sel.mode === 'rows') {
    // Ctrl 累加 / 反选
    sel.rowIds = isPicked
      ? sel.rowIds.filter(id => String(id) !== String(rowId))
      : [...sel.rowIds, rowId];
  } else {
    sel.rowIds = [rowId];
  }

  sel.mode = 'rows';
  sel.cells.clear();
  sel.fieldKeys = [];
  paintRowSelection();
}

function updateBulkBar() {
  const page = host?.querySelector('.sh-page');
  if (!page) return;
  let bar = page.querySelector('.sh-bulk');
  const hasFields = sel.mode === 'fields' && sel.fieldKeys.length > 0;
  const hasCells = sel.mode === 'cells' && sel.cells.size > 1;
  const hasRows = sel.mode === 'rows' && sel.rowIds.length > 0;

  if (!hasFields && !hasCells && !hasRows) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'sh-bulk';
    bar.onclick = onBulkBarClick;
    page.appendChild(bar);
  }

  if (hasFields) {
    const fields = sel.fieldKeys
      .map(key => state.fields.find(field => field.key === key))
      .filter(Boolean);
    bar.innerHTML = `
      <span class="sh-bulk-count">已选 ${fields.length} 列</span>
      <span class="sh-bulk-sep"></span>
      <span class="sh-bulk-label">列宽</span>
      <input type="number" class="sh-bulk-input" data-bulk-width min="72" max="640" step="4" value="${fieldWidth(fields[0])}" />
      <span class="sh-bulk-label">px</span>
      <button type="button" class="sh-bulk-btn" data-bulk="width">应用</button>
      <button type="button" class="sh-bulk-btn" data-bulk="hide">隐藏</button>
      <button type="button" class="sh-bulk-btn is-danger" data-bulk="delete">删除</button>
      <span class="sh-bulk-sep"></span>
      <button type="button" class="sh-bulk-btn" data-bulk="cancel">取消</button>`;
    return;
  }

  if (hasRows) {
    bar.innerHTML = `
      <span class="sh-bulk-count">已选 ${sel.rowIds.length} 行</span>
      <span class="sh-bulk-sep"></span>
      <button type="button" class="sh-bulk-btn" data-bulk="dup-rows">复制一份</button>
      <button type="button" class="sh-bulk-btn is-danger" data-bulk="delete-rows">删除</button>
      <span class="sh-bulk-sep"></span>
      <button type="button" class="sh-bulk-btn" data-bulk="cancel">取消</button>`;
    return;
  }

  bar.innerHTML = `
    <span class="sh-bulk-count">已选 ${sel.cells.size} 格</span>
    <span class="sh-bulk-sep"></span>
    <input type="text" class="sh-bulk-input is-wide" data-bulk-value placeholder="批量填入…" />
    <button type="button" class="sh-bulk-btn" data-bulk="fill">填充</button>
    <button type="button" class="sh-bulk-btn" data-bulk="clear">清空</button>
    <span class="sh-bulk-sep"></span>
    <button type="button" class="sh-bulk-btn" data-bulk="cancel">取消</button>`;
}

async function bulkWriteCells(mode, rawValue) {
  const rows = rowsInView();
  const cols = visibleOf(state.fields);
  if (!sel.cells.size || !rows.length || !cols.length) return;

  // 直接遍历选区集合（支持 Ctrl 加选的离散格），按行聚合后每行只存一次
  const touchedRows = new Map(); // rowId → { row, touched }
  let touchedCells = 0;
  sel.cells.forEach(key => {
    const [r, c] = key.split(':').map(Number);
    const row = rows[r];
    const field = cols[c];
    if (!row || !field) return;
    let entry = touchedRows.get(row.id);
    if (!entry) { entry = { row, touched: false }; touchedRows.set(row.id, entry); }
    const current = row.values[field.key];
    if (mode === 'clear') {
      if (current !== '' && current !== undefined && current !== null) {
        row.values[field.key] = field.type === 'checkbox' ? false : field.type === 'attachment' ? [] : '';
        entry.touched = true;
        touchedCells += 1;
      }
      return;
    }
    if (field.type !== 'text' && field.type !== 'number') return;
    const next = String(rawValue ?? '');
    if (current !== next) { row.values[field.key] = next; entry.touched = true; touchedCells += 1; }
  });
  if (![...touchedRows.values()].some(entry => entry.touched)) {
    // 非文本列会被跳过：全都填不进去时给个明确提示，别静默无反应
    if (mode === 'fill') toast('选中的单元格不是文本/数字列，填不进去', 'info');
    return;
  }

  const count = touchedCells;
  markSaving();
  try {
    for (const { row, touched } of touchedRows.values()) {
      if (touched) await writeRow(row);
    }
    await touchSheet(state.sheet.id);
    markSaved();
    toast(mode === 'clear' ? `已清空 ${count} 格` : `已批量填入 ${count} 格`);
    clearSelection();
    renderSheet();
  } catch (error) {
    markSaved();
    toast(`批量写入失败：${error?.message || error}`, 'danger');
  }
}

async function bulkApplyToFields(action, widthValue) {
  const fields = sel.fieldKeys.map(key => state.fields.find(field => field.key === key)).filter(Boolean);
  if (!fields.length) return;
  try {
    for (const field of fields) {
      if (action === 'width') {
        const width = Math.max(72, Math.min(640, Number(widthValue) || 160));
        await patchField(field.id, { width });
        field.width = width;
      }
      if (action === 'hide') await patchField(field.id, { visible: 0 });
      if (action === 'delete') await deleteField(field.id);
    }
  } catch (error) {
    toast(`批量操作失败：${error?.message || error}`, 'danger');
    return;
  }
  const label = action === 'width' ? '列宽已更新' : action === 'hide' ? '已隐藏所选列' : '已删除所选列';
  clearSelection();
  await reloadFields();
  renderSheet();
  toast(label);
}

async function onBulkBarClick(event) {
  const action = event.target.closest('[data-bulk]')?.dataset.bulk;
  if (!action) return;
  const bar = event.currentTarget;
  if (action === 'cancel') { clearSelection(); return; }
  if (action === 'width') {
    const value = bar.querySelector('[data-bulk-width]')?.value;
    bulkApplyToFields('width', value);
    return;
  }
  if (action === 'hide') { bulkApplyToFields('hide'); return; }
  if (action === 'delete') {
    window.showModal?.('删除列', `<p style="margin:0;">删除选中的 ${sel.fieldKeys.length} 列？列里的数据会一起消失。</p>`, null, async () => {
      await bulkApplyToFields('delete');
      return true;
    }, { danger: true, btnText: '删除' });
    return;
  }
  if (action === 'clear') { bulkWriteCells('clear'); return; }
  if (action === 'delete-rows') {
    const count = sel.rowIds.length;
    window.showModal?.('删除记录', `<p style="margin:0;">删除选中的 ${count} 行？此操作无法撤销。</p>`, null, async () => {
      for (const id of sel.rowIds) {
        try { await deleteRow(id); } catch (error) { console.warn('deleteRow failed', id, error); }
      }
      clearSelection();
      await reloadRows();
      renderSheet();
      toast(`已删除 ${count} 行`);
      return true;
    }, { danger: true, btnText: '删除' });
    return;
  }
  if (action === 'dup-rows') {
    const ids = [...sel.rowIds];
    const rowsInOrder = rowsInView().filter(row => ids.some(id => String(id) === String(row.id)));
    for (const row of rowsInOrder) {
      try { await duplicateRow(state.sheet.id, row.values); } catch (error) { console.warn('duplicateRow failed', row.id, error); }
    }
    clearSelection();
    await reloadRows();
    renderSheet();
    toast(`已复制 ${rowsInOrder.length} 行`);
    return;
  }
  if (action === 'fill') {
    const value = bar.querySelector('[data-bulk-value]')?.value ?? '';
    bulkWriteCells('fill', value);
  }
}

// 拖框选：按住单元格拖出一个矩形。
// 用 rAF 合帧 + 目标格去重 → 每次 pointermove 不再全表重排/全表 toggle。
function onSelectPointerMove(event) {
  if (!dragSel) return;
  const dx = Math.abs(event.clientX - dragSel.x);
  const dy = Math.abs(event.clientY - dragSel.y);
  if (!dragSel.moved) {
    if (dx < 5 && dy < 5) return;
    dragSel.moved = true;
    document.body.classList.add('sh-selecting');
  }

  const under = document.elementFromPoint(event.clientX, event.clientY)?.closest('.sh-cell');
  if (!under || under.dataset.rowindex == null) return;
  const r = Number(under.dataset.rowindex);
  const c = Number(under.dataset.col);
  if (dragSel.last && dragSel.last.r === r && dragSel.last.c === c) return;
  dragSel.last = { r, c };
  if (dragSel.raf) return; // 一帧只画一次
  dragSel.raf = requestAnimationFrame(() => {
    dragSel.raf = 0;
    if (!dragSel?.last) return;
    paintCellSelection({ r: dragSel.r, c: dragSel.c }, dragSel.last);
  });
}

function onSelectPointerUp() {
  document.removeEventListener('pointermove', onSelectPointerMove);
  document.removeEventListener('pointerup', onSelectPointerUp);
  document.body.classList.remove('sh-selecting');
  if (dragSel?.raf) {
    cancelAnimationFrame(dragSel.raf);
    if (dragSel.last) paintCellSelection({ r: dragSel.r, c: dragSel.c }, dragSel.last);
  }
  if (dragSel?.moved) suppressClick = true;
  dragSel = null;
}

// ==========================================
// 列宽：拖拽调整 / 双击自适应
// ==========================================

let resizeState = null;

function colElements() {
  const table = host?.querySelector('.sh-table');
  if (!table) return { table: null, cols: [] };
  return { table, cols: [...table.querySelectorAll('col')] };
}

function applyColumnWidth(field, width) {
  const visible = visibleOf(state.fields);
  const index = visible.findIndex(item => item.key === field.key);
  const { cols } = colElements();
  if (index < 0 || !cols.length) return;

  // 列宽是百分比（权重），拖一列等于改权重，其余列按比例让出空间。
  // 只写被拖的那一列会和其他列的总和打架，所以整组重算一次。
  const next = visible.map(item => (item.key === field.key ? width : fieldWidth(item)));
  const total = next.reduce((sum, item) => sum + item, 0) || 1;
  next.forEach((item, i) => {
    const col = cols[i + 1];
    if (col) col.style.width = `${((item / total) * 100).toFixed(4)}%`;
  });
  field.width = width;
}

function onHostPointerDown(event) {
  if (event.button !== 0) return; // 右键/中键不参与框选
  // 上一次拖选留下的「吞掉下一次点击」标记在这里复位。
  // pointerup 落在表格外时，click 不会经过 host，标记会一直留着，
  // 下一轮第一次点按钮就被吃掉。
  suppressClick = false;
  const handle = event.target.closest('.sh-col-resizer');
  if (!handle) {
    // 单元格拖选：记下起点，移动超过 5px 才算框选（否则仍然是单击编辑）
    const cell = event.target.closest('.sh-cell');
    if (cell && cell.dataset.rowindex != null && !event.target.closest('input, textarea, button')) {
      dragSel = {
        r: Number(cell.dataset.rowindex),
        c: Number(cell.dataset.col),
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      document.addEventListener('pointermove', onSelectPointerMove);
      document.addEventListener('pointerup', onSelectPointerUp);
    }
    return;
  }
  const field = state.fields.find(item => item.key === handle.dataset.resize);
  if (!field) return;
  event.preventDefault();
  event.stopPropagation();

  const visible = visibleOf(state.fields);
  const index = visible.findIndex(item => item.key === field.key);
  const { cols } = colElements();
  const col = cols[index + 1];
  const startWidth = fieldWidth(field);
  // 权重/像素的换算比：拖动 1px 要换算成多少权重，否则列被压缩后拖不动。
  const scroller = host?.querySelector('[data-scroll]');
  const avail = (scroller?.clientWidth || 0) - 96;
  const totalWeight = visible.reduce((sum, item) => sum + fieldWidth(item), 0);
  const scale = avail > 0 ? totalWeight / avail : 1;

  resizeState = { field, col, startX: event.clientX, startWidth, width: startWidth, scale };
  handle.classList.add('is-active');
  document.body.classList.add('sh-col-resizing');
  document.addEventListener('pointermove', onResizeMove);
  document.addEventListener('pointerup', onResizeEnd, { once: true });
}

function onResizeMove(event) {
  if (!resizeState) return;
  const scale = resizeState.scale || 1;
  const raw = resizeState.startWidth + (event.clientX - resizeState.startX) * scale;
  // 上下限也按权重换算：视觉上收紧在 64~640px
  const next = Math.max(Math.round(64 * scale), Math.min(Math.round(640 * scale), Math.round(raw)));
  if (next === resizeState.width) return;
  resizeState.width = next;
  applyColumnWidth(resizeState.field, next);
}

async function onResizeEnd() {
  document.removeEventListener('pointermove', onResizeMove);
  document.body.classList.remove('sh-col-resizing');
  host?.querySelectorAll('.sh-col-resizer.is-active').forEach(el => el.classList.remove('is-active'));
  const state2 = resizeState;
  resizeState = null;
  if (!state2) return;
  try {
    await patchField(state2.field.id, { width: state2.width });
  } catch (error) {
    toast(`列宽没存住：${error?.message || error}`, 'danger');
  }
}

async function autoFitColumn(field) {
  const width = autoFitWidth(field, state.rows, fieldOptionsList(field));
  applyColumnWidth(field, width);
  renderSheet();
  try { await patchField(field.id, { width }); } catch (error) { /* 忽略 */ }
  toast(`「${field.label}」已按内容适应宽度`);
}

function onHostDblClick(event) {
  const handle = event.target.closest('.sh-col-resizer');
  if (handle) {
    const field = state.fields.find(item => item.key === handle.dataset.resize);
    if (field) autoFitColumn(field);
    return;
  }
  // 双击行索引 = 打开该行详情
  if (event.target.closest('.sh-td-index')) {
    const tr = event.target.closest('.sh-row');
    const row = state.rows.find(item => String(item.id) === String(tr?.dataset.id));
    if (row) openDetail(row);
    return;
  }
  // 双击链接文件 → 定位 / 默认应用打开 / 选择打开方式
  const fileChip = event.target.closest('.ft-file-chip');
  if (fileChip) {
    event.preventDefault();
    openFileActionMenu(fileChip, { path: fileChip.dataset.path, name: fileChip.dataset.name }, {
      reveal: path => invoke('reveal_path', { path }).catch(error => toast(`定位失败：${error?.message || error}`, 'danger')),
      open: path => invoke('open_path_with_app', { path, app: null }).catch(error => toast(`打开失败：${error?.message || error}`, 'danger')),
      openWith: path => invoke('open_path_with_dialog', { path }).catch(error => toast(`打开方式失败：${error?.message || error}`, 'danger')),
    });
    return;
  }

  // 双击单元格 = 进入编辑；附件格：空的直接选文件，有图的看大图
  const cell = event.target.closest('.sh-cell');
  if (!cell) return;
  const field = state.fields.find(item => item.key === cell.dataset.key);
  const row = state.rows.find(item => String(item.id) === String(cell.dataset.row));
  if (field && row) {
    event.preventDefault();
    if (field.type === 'attachment') {
      const items = Array.isArray(row.values[field.key]) ? row.values[field.key].filter(item => item && item.path) : [];
      if (!items.length) {
        // 空附件格：双击直接弹系统选择框（图片嵌入、其他存链接）
        appendAttachments(field, row, cell);
        return;
      }
      const imgs = [...cell.querySelectorAll('img.ft-att-thumb')];
      if (imgs.length) {
        const gallery = imgs.map(img => ({ src: img.getAttribute('src'), name: img.getAttribute('alt') || '' }));
        openImagePreview(gallery[0].src, gallery[0].name, gallery);
      }
      return;
    }
    startCellEdit(field, row, cell);
  }
}

// 右键：列 → 列菜单；行 → 行菜单
function onHostContextMenu(event) {
  const th = event.target.closest('.sh-th[data-key]');
  if (th) {
    const field = state.fields.find(item => item.key === th.dataset.key);
    if (!field) return;
    event.preventDefault();
    toggleFieldSelection(field.key, false, false);
    openColumnMenuFor(th, field);
    return;
  }
  // 右键单元格 = 单元格菜单（复制/粘贴/编辑/清除/插行/删行），WPS 同款。
  // 如果右键的格子已在当前多选里，保留选区（要操作的是整片选中格）；否则才切成单格。
  const cellEl = event.target.closest('.sh-cell');
  if (cellEl) {
    const field = state.fields.find(item => item.key === cellEl.dataset.key);
    const row = state.rows.find(item => String(item.id) === String(cellEl.dataset.row));
    if (field && row) {
      event.preventDefault();
      const key = `${Number(cellEl.dataset.rowindex)}:${Number(cellEl.dataset.col)}`;
      const inSelection = (sel.mode === 'cells' || sel.mode === 'cell') && sel.cells.has(key);
      if (!inSelection) selectCell(cellEl, {});
      openCellMenuFor(cellEl, field, row);
      return;
    }
  }
  // 行号区右键 = 行菜单
  const rowEl = event.target.closest('.sh-row');
  if (!rowEl) return;
  const row = state.rows.find(item => String(item.id) === String(rowEl.dataset.id));
  if (!row) return;
  event.preventDefault();
  openRowMenuFor(rowEl, row);
}

function onHostClick(event) {
  if (suppressClick) { suppressClick = false; return; }

  const soon = event.target.closest('[data-soon]');
  if (soon) { toast(soon.dataset.soon, 'info'); return; }

  const actEl = event.target.closest('[data-act]');
  if (actEl) {
    const act = actEl.dataset.act;
    if (act === 'new-sheet') { openNewSheetModal(); return; }
    if (act === 'back') { backToLibrary(); return; }
    if (act === 'new-row') { addRow(); return; }
    if (act === 'fields') { openFieldsPanel(actEl); return; }
    if (act === 'filter') { openFilterPanel(actEl, { fields: state.fields, filters: state.filters, onApply: applyFilters }); return; }
    if (act === 'sort') { openSortPanel(actEl, { fields: state.fields, sorts: state.sorts, onApply: applySorts }); return; }
    if (act === 'rename-sheet') { renameSheet(); return; }
    if (act === 'sheet-menu') { openSheetMenu(actEl); return; }
  }

  const card = event.target.closest('.sh-sheet-card');
  if (card) { openSheet(card.dataset.sheet).catch(error => toast(`打开失败：${error?.message || error}`, 'danger')); return; }

  const libraryTemplate = event.target.closest('[data-template]');
  if (libraryTemplate && state.view === 'library') { openNewSheetModal(libraryTemplate.dataset.template); return; }

  const removeChip = event.target.closest('[data-remove-chip]');
  if (removeChip) {
    state.filters.splice(Number(removeChip.dataset.removeChip), 1);
    renderSheet();
    return;
  }
  if (event.target.closest('[data-clear-sort]')) { state.sorts = []; renderSheet(); return; }

  const thBtn = event.target.closest('.sh-th-btn');
  if (thBtn) {
    // 左键点列头 = 选中这一列（Ctrl/⌘ 累加、Shift 连选）；
    // 列菜单改到右键，避免「想选列却弹菜单」。
    toggleFieldSelection(thBtn.dataset.key, event.shiftKey, Boolean(event.ctrlKey || event.metaKey || event.shiftKey));
    return;
  }
  if (event.target.closest('.sh-th-add-btn')) { addFieldAt(null, 'right'); return; }

  const rownum = event.target.closest('.sh-rownum');
  if (rownum) {
    // 左键点行号 = 选中这一行（Ctrl 累加 / Shift 连选），和列头同一套手势；
    // 行菜单走右键，详情走双击。
    toggleRowSelection(rownum.dataset.row, event.shiftKey, Boolean(event.ctrlKey || event.metaKey || event.shiftKey));
    return;
  }

  // 附件格右下角的「＋」：追加图片或链接文件（不清空已有内容）
  const addAtt = event.target.closest('.ft-att-add');
  if (addAtt) {
    const cellEl = addAtt.closest('.sh-cell');
    const field = cellEl && state.fields.find(item => item.key === cellEl.dataset.key);
    const row = cellEl && state.rows.find(item => String(item.id) === String(cellEl.dataset.row));
    if (field && row) appendAttachments(field, row, cellEl);
    return;
  }

  // 图片缩略图：单击只是选中单元格（和普通单元格一致），双击才看大图
  const thumb = event.target.closest('img.ft-att-thumb');
  if (thumb) {
    const cell = thumb.closest('.sh-cell');
    if (cell) selectCell(cell, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey });
    return;
  }

  const cell = event.target.closest('.sh-cell');
  if (cell) {
    // 单击只选中；Ctrl=加减单个格，Shift=从锚点扩展矩形，双击才编辑
    selectCell(cell, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey });
    return;
  }

  // 点到表格空白等非操作区域：取消选中（工具条、菜单入口保持）
  const keep = event.target.closest('.sh-toolbar, .sh-crumbs, .sh-sheet-head, .sh-bulk, .sh-status, .sh-chips, .sh-table-foot, .sh-rownum');
  if (!keep) clearSelection();
}

function applyFilters(filters) {
  state.filters = Array.isArray(filters) ? filters : [];
  // 换了筛选条件，列表已经换了，回顶部才是对的
  renderSheet({ resetScroll: true });
}

function applySorts(sorts) {
  state.sorts = Array.isArray(sorts) ? sorts : [];
  renderSheet({ resetScroll: true });
}

function openColumnMenuFor(anchor, field) {
  openColumnMenu(anchor, field, {
    edit: () => openFieldPanelFor(field),
    autofit: () => autoFitColumn(field),
    wrap: async next => {
      // 只改 wrap，别顺手把列级 format / 选项重写一遍
      const nextOptions = mergeFieldOptions(field, { wrap: next ? true : null });
      try {
        await patchField(field.id, { options: nextOptions });
      } catch (error) {
        toast(`保存换行设置失败：${error?.message || error}`, 'danger');
        return;
      }
      field.options = nextOptions;
      renderSheet();
      toast(next ? '已改为自动换行' : '已改为单行省略');
    },
    width: value => {
      applyColumnWidth(field, value);
      renderSheet();
      patchField(field.id, { width: value }).catch(() => {});
    },
    filter: () => openFilterPanel(anchor, { fields: state.fields, filters: state.filters, onApply: applyFilters }),
    sort: () => openSortPanel(anchor, { fields: state.fields, sorts: state.sorts, onApply: applySorts }),
    left: () => addFieldAt(field, 'left'),
    right: () => addFieldAt(field, 'right'),
    hide: async () => {
      try {
        await patchField(field.id, { visible: 0 });
        await reloadFields();
      } catch (error) {
        toast(`隐藏失败：${error?.message || error}`, 'danger');
        return;
      }
      renderSheet();
      toast(`已隐藏「${field.label}」，可从「字段」里恢复`);
    },
    del: () => {
      window.showModal?.('删除字段', `<p style="margin:0;">删除「${escapeHtml(field.label)}」这一列？列里的数据会一起消失。</p>`, null, async () => {
        try {
          await deleteField(field.id);
          await reloadFields();
        } catch (error) {
          toast(`删除失败：${error?.message || error}`, 'danger');
          return false;
        }
        renderSheet();
        toast('字段已删除');
        return true;
      }, { danger: true, btnText: '删除' });
    },
  });
}

function openFieldsPanel(anchorEl) {
  const el = openPopoverSimple(anchorEl, `
    <div class="sh-panel-title">显示字段</div>
    <div class="sh-field-list">
      ${state.fields
        .map(
          field => `<label class="sh-field-row">
            <input type="checkbox" data-field-toggle="${escapeHtml(field.key)}" ${Number(field.visible) !== 0 ? 'checked' : ''} />
            ${renderFieldIcon(field.type)}
            <span class="sh-field-name">${escapeHtml(field.label)}</span>
            <span class="sh-field-type">${escapeHtml(FIELD_TYPE_LABELS[field.type] || field.type)}</span>
          </label>`
        )
        .join('')}
    </div>
    <div class="sh-panel-foot">
      <button type="button" class="sh-btn" data-add-field>＋ 新建字段</button>
    </div>`);

  el.addEventListener('change', async event => {
    const key = event.target.closest('[data-field-toggle]')?.dataset.fieldToggle;
    if (!key) return;
    const field = state.fields.find(item => item.key === key);
    if (!field) return;
    try {
      await patchField(field.id, { visible: event.target.checked ? 1 : 0 });
      await reloadFields();
    } catch (error) {
      event.target.checked = !event.target.checked;
      toast(`保存字段显隐失败：${error?.message || error}`, 'danger');
      return;
    }
    renderSheet();
  });
  el.addEventListener('click', event => {
    if (!event.target.closest('[data-add-field]')) return;
    closeAllPanels();
    addFieldAt(null, 'right');
  });
}

// ==========================================
// 键盘
// ==========================================

function onHostKeydown(event) {
  const cell = document.activeElement?.closest?.('.sh-cell');
  if (!cell || !host?.contains(cell)) return;
  if (cell.querySelector('input, textarea')) return;

  const field = state.fields.find(item => item.key === cell.dataset.key);
  const row = state.rows.find(item => String(item.id) === String(cell.dataset.row));
  if (!field || !row) return;

  if (event.key === 'Enter') {
    event.preventDefault();
    startCellEdit(field, row, cell);
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    event.stopPropagation();
    // 有多格选区时清空整个选区，而不是只清当前聚焦的那一格
    if (sel.mode === 'cells' && sel.cells.size > 1) {
      bulkWriteCells('clear');
      return;
    }
    commitCell(field, row, cell, field.type === 'checkbox' ? false : '');
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const cells = [...host.querySelectorAll(`.sh-cell[data-key="${CSS.escape(field.key)}"]`)];
    const index = cells.indexOf(cell);
    const next = cells[index + (event.key === 'ArrowDown' ? 1 : -1)];
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  }
}

// ==========================================
// 入口
// ==========================================

export async function initSheetPage() {
  host = document.getElementById('sheet-app');
  if (!host) return;
  if (!isSheetStoreReady()) return;

  if (!host.dataset.shBound) {
    host.dataset.shBound = '1';
    host.addEventListener('click', onHostClick);
    host.addEventListener('pointerdown', onHostPointerDown);
    // 浏览器默认会把 <img> 拖成 ghost 图，打断拖框选择（图片单元格尤其明显）
    host.addEventListener('dragstart', event => {
      if (event.target.closest('.sh-cell')) event.preventDefault();
    });
    host.addEventListener('dblclick', onHostDblClick);
    host.addEventListener('contextmenu', onHostContextMenu);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && (sel.cells.size > 1 || sel.fieldKeys.length)) {
        clearSelection();
        return;
      }
      // 正在输入时一律放行给原生控件。注意必须包含 textarea ——
      // 自动换行的单元格用的是多行 textarea，漏掉它会导致
      // Backspace/Delete 被下面「清空选区」截获，表现为编辑时删除键失灵。
      const typing =
        document.activeElement?.closest?.('input, textarea, [contenteditable="true"]') ||
        document.querySelector('.sh-dp, .ft-dropdown, .sh-bulk input');
      if (typing) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && sel.cells.size >= 1) {
        event.preventDefault();
        bulkWriteCells('clear');
      }
    });
    host.addEventListener('keydown', onHostKeydown);

    // Ctrl+C / Ctrl+V：都走内部剪贴板（能搬图片等复杂值）。
    // 内部剪贴板不写系统剪贴板，所以必须拦 keydown；没内容时才走系统粘贴的 paste 事件。
    document.addEventListener('keydown', event => {
      if (state.view !== 'sheet' || !host) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = String(event.key).toLowerCase();
      if (key !== 'c' && key !== 'v') return;
      const typing = document.activeElement?.closest?.('input, textarea, [contenteditable="true"]');
      if (typing || document.querySelector('.ft-cell-editing')) return;

      if (key === 'c') {
        if (String(window.getSelection() || '')) return; // 有文本选区 → 交给原生复制
        if (copySelectionToClipboard()) event.preventDefault();
        return;
      }

      if (!hasInternalClipboard()) return;

      if (sel.mode === 'rows' && sel.rowIds.length) {
        event.preventDefault();
        if (clipboard.kind !== 'row') { toast('剪贴板里是一条单元格内容，请选中单元格再粘贴', 'info'); return; }
        const targets = sel.rowIds.map(id => state.rows.find(item => String(item.id) === String(id)));
        pasteRowFromClipboard(targets);
        return;
      }

      const cell = host.querySelector('.sh-cell.is-active');
      if (!cell) return;
      const field = state.fields.find(item => item.key === cell.dataset.key);
      const row = state.rows.find(item => String(item.id) === String(cell.dataset.row));
      if (!field || !row) return;
      event.preventDefault();
      pasteCellFromClipboard(field, row, cell);
    }, true);
    // Ctrl+V：选中单元格（非编辑态）时直接粘贴，图片覆盖原内容
    document.addEventListener('paste', event => {
      if (state.view !== 'sheet' || !host) return;
      const typing = document.activeElement?.closest?.('input, textarea, [contenteditable="true"]');
      if (typing) return; // 正在输入 → 交给原生粘贴
      if (document.querySelector('.ft-cell-editing')) return;
      const cell = host.querySelector('.sh-cell.is-active');
      if (!cell) return;
      const field = state.fields.find(item => item.key === cell.dataset.key);
      const row = state.rows.find(item => String(item.id) === String(cell.dataset.row));
      if (!field || !row) return;
      const { files, text } = filesFromDataTransfer(event.clipboardData);
      if (!files.length && !text) return;
      event.preventDefault();
      applyPastedContent(field, row, cell, { files, text });
    }, true);

    // 搜索：只重建表格行，不重建整个页面。
    // 之前每次按键都重渲染整页，输入框被换掉 —— 中文输入法正在组词时会被直接打断，
    // 表现就是「拼音打不进去，只能出英文」。
    let searchTimer = null;
    let composing = false;

    const applySearch = value => {
      state.search = String(value || '').trim();
      renderBodyRows(true);
      host.querySelector('[data-scroll]')?.scrollTo({ top: 0 });
      const status = host.querySelector('[data-status-text]');
      if (status) {
        const total = state.rows.length;
        const shown = filterRows(state.rows).length;
        status.textContent = shown === total ? `共 ${total} 条记录` : `筛选出 ${shown} / ${total} 条`;
      }
    };

    host.addEventListener('compositionstart', event => {
      if (event.target.closest?.('[data-search]')) composing = true;
    }, true);
    host.addEventListener('compositionend', event => {
      if (!event.target.closest?.('[data-search]')) return;
      composing = false;
      applySearch(event.target.value);
    }, true);

    host.addEventListener('input', event => {
      const input = event.target.closest('[data-search]');
      if (!input) return;
      if (composing || event.isComposing) return;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => applySearch(input.value), 160);
    });
  }

  try {
    await refreshSheets();
    if (state.view === 'sheet' && state.sheet) {
      const fresh = state.sheets.find(item => String(item.id) === String(state.sheet.id));
      if (fresh) { state.sheet = fresh; await reloadFields(); await reloadRows(); }
      else { state.view = 'library'; state.sheet = null; }
    }
    render();
  } catch (error) {
    host.innerHTML = `<div class="sh-empty"><div class="sh-empty-title">表格加载失败</div><div class="sh-empty-desc">${escapeHtml(
      String(error?.message || error)
    )}</div></div>`;
  }
}

function render() {
  if (!host) return;
  if (state.view === 'sheet' && state.sheet) renderSheet();
  else renderLibrary();
}

export { setSheetAdapter };
