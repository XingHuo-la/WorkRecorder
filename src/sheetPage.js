// 「表格」页 v2：多表 + 任务归属 + 就地编辑。
//
// 结构：库里一堆表（可按任务分组）→ 打开某张表 → 表内是「字段 + 记录」。
// 页面两个形态（library / sheet）共用同一个容器 #sheet-app，
// 所有 DOM 由本模块生成，index.html 只留一个空壳，避免和旧样式打架。

import { escapeHtml } from './htmlUtils.js';
import { serializeTSV, parseTSV, createGrid, resolveKeyIntent } from './gridCore.js';
// 填充柄 / 拖行下缘：和基础表共用同一套手势实现（gridGestures）。
// 以前这两样只长在基础表里，空白表没有 —— 也正是「两套表格」最直接的体感来源。
import { mountFillHandle, mountRowResizer } from './gridGestures.js';
import { undoStack } from './undoCore.js';
import { renderCell, openCellEditor, renderFieldIcon, FIELD_TYPE_LABELS } from './fieldTypes.js';
import { pickAttachmentItems, storeImageFile, setAttachmentNotifier } from './attachmentOps.js';
// 剪贴板表格：解析在 clipboardTable（纯函数，可单测），预览与落库在 clipboardImport。
// 分两层是因为「HTML → 矩阵」与「矩阵 → 库」的失败模式完全不同：
// 前者是格式问题（要能单独测），后者是写库问题（要能回滚）。
import { parseClipboardPayload } from './clipboardTable.js';
import {
  snapshotClipboard,
  looksTabular,
  buildBlockChanges,
  openImportPreview,
  openPasteCapture,
  isCapturing,
} from './clipboardImport.js';
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
  getDefaultTableId,
  setDefaultTableId,
  touchSheet,
  // 读写一律走「表无关」的门面（P2.5）：预置表的字段在 field_def、行是 kind='log'，
  // 自建表在 sheet_field / sheet_id。差异全在 sheetStore 里，这一层不需要知道。
  readTableFields,
  readTableRows,
  saveTableRow,
  insertTableRow,
  insertTableRowsAt,
  duplicateTableRow,
  createTableField,
  patchTableField,
  saveFieldDrawer,
  deleteTableField,
  setRowHeight,
  deleteRow,
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

// ==========================================
// 字段三件套的分派器（P2.5）
//
// 预置表的字段在 field_def、自建表在 sheet_field —— 写错地方的表现是「改了没反应」
// 而不是报错，所以这两条路必须在**一个**地方分叉，不能让 15 处调用各判一次。
// 签名与原来的 createField(sheetId, opts) / patchField(id, patch) / deleteField(id)
// 完全一致，下面所有调用点一行都不用改。
// ==========================================
const createField = (_sheetId, opts) => createTableField(state.sheet, opts);
const patchField = (fieldId, patch) => patchTableField(state.sheet, fieldId, patch);
const deleteField = fieldId => deleteTableField(state.sheet, fieldId);

// ==========================================
// 预置表的快捷筛选（P2.5）
//
// 合流前它们在 #base-table-tools 里（页面表头那排「全部/今天/待整理 + 主分类/子项目」）。
// 搬到表内之后刻意**不入 state.filters**：
//   state.filters 是「筛选」面板里手写的条件，一个 chip 一个 ×；
//   快捷栏是三个开关 + 两个下拉，语义是「我眼下在看哪一段」。
// 混在一起的话，「清除筛选」会把用户刚点的「今天」也清掉。
// ==========================================
const presetQuick = { mode: 'all', tag: '', sub: '' };

function resetPresetQuick() {
  presetQuick.mode = 'all';
  presetQuick.tag = '';
  presetQuick.sub = '';
}

function todayString() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// 真正生效的筛选条件 = 面板里手写的 + 快捷栏的。filterRows 只认这一个入口。
function activeFilters() {
  const list = [...state.filters];
  if (state.sheet?.kind === 'preset') {
    // 「今天」用 contains 而不是 equals：时间列的值是「2026-11-18 21:30」，
    // equals 要精确到分钟，选不中当天任何一条。
    if (presetQuick.mode === 'today') list.push({ key: 'date', op: 'contains', value: todayString() });
    if (presetQuick.mode === 'inbox') list.push({ key: 'status', op: 'equals', value: 'unprocessed' });
    // 主分类是单选、子项目是多选（数组），所以一个 equals、一个 contains。
    if (presetQuick.tag) list.push({ key: 'tag', op: 'equals', value: presetQuick.tag });
    if (presetQuick.sub) list.push({ key: 'sub_tag', op: 'contains', value: presetQuick.sub });
  }
  return list;
}

// 下拉的候选值从「现有行」里取，不读 field_def.options ——
// 主分类的 options 是 {"source":"tags"}（没有静态列表），子项目干脆没有选项。
function presetQuickOptions() {
  const tags = new Set();
  const subs = new Set();
  state.rows.forEach(row => {
    const tag = String(row.values?.tag ?? '').trim();
    if (tag) tags.add(tag);
    const sub = row.values?.sub_tag;
    (Array.isArray(sub) ? sub : [sub]).forEach(item => {
      const text = String(item ?? '').trim();
      if (text) subs.add(text);
    });
  });
  const sortZh = (a, b) => a.localeCompare(b, 'zh');
  return { tags: [...tags].sort(sortZh), subs: [...subs].sort(sortZh) };
}

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

// 轻提示。导出给宿主复用：全应用只该有一个提示条，
// 各模块自己造一个就会出现「两个 toast 同时挂在右下角」。
export function toast(message, tone = 'success') {
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
  // solidPill：表格里配了色的选项要画成实心色块（编辑提交后重渲染也走这里，
  // 漏标就会「一改完又变回灰字」）。
  return { placeholder: field.type === 'text' ? '未命名' : '—', solidPill: true };
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
  const filters = activeFilters();
  if (filters.length) {
    list = list.filter(row =>
      filters.every(filter => {
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

// 预置表专用的快捷筛选行：三个开关 + 两个下拉。
// 复用页面表头那套 .v4-chip（同一个产品里同一种「快速筛选」不该长两个样）。
function renderPresetQuick() {
  if (state.sheet?.kind !== 'preset') return '';
  const { tags, subs } = presetQuickOptions();
  const chip = (mode, label) => {
    const on = presetQuick.mode === mode;
    return `<button type="button" class="v4-chip${on ? ' is-on' : ''}" data-quick="${mode}"
      aria-pressed="${on ? 'true' : 'false'}">${label}</button>`;
  };
  const option = (value, current, label) =>
    `<option value="${escapeHtml(value)}"${String(current) === String(value) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  return `<div class="sh-quick" role="group" aria-label="快速筛选">
    <div class="v4-chips" role="group" aria-label="按时间/状态快筛">
      ${chip('all', '全部')}${chip('today', '今天')}${chip('inbox', '待整理')}
    </div>
    <span class="sh-quick-sep" aria-hidden="true"></span>
    <label class="sh-quick-pick${presetQuick.tag ? ' is-on' : ''}">
      <select data-quick-tag aria-label="按主分类筛选">
        ${option('', presetQuick.tag, '主分类')}
        ${tags.map(tag => option(tag, presetQuick.tag, tag)).join('')}
      </select>
    </label>
    <label class="sh-quick-pick${presetQuick.sub ? ' is-on' : ''}">
      <select data-quick-sub aria-label="按子项目筛选">
        ${option('', presetQuick.sub, '子项目')}
        ${subs.map(sub => option(sub, presetQuick.sub, sub)).join('')}
      </select>
    </label>
  </div>`;
}

// 快捷筛选行 + 「当前生效的条件」同处一条横带：
// 二者都是「我在看哪一段」的状态，分成两行会白占一格行高；
// 没有条件时不渲染 .sh-chips，横带就只剩快捷栏（预置表之外干脆整条不出现）。
function filterBarHtml(filterChips, sortChip) {
  const quick = renderPresetQuick();
  const chips = filterChips || sortChip ? `<div class="sh-chips">${filterChips}${sortChip}</div>` : '';
  if (!quick && !chips) return '';
  return `<div class="sh-filterbar">${quick}${chips}</div>`;
}

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
  ${filterBarHtml(filterChips, sortChip)}`;
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
  // 整页 innerHTML 换掉后，填充柄节点跟着旧滚动容器一起被丢了。
  // 不补这一下，重绘后手柄会「消失」，直到下一次选区变化才被重新挂上。
  fillHandle?.reposition();
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
  notifySheetList();
}

// 表格列表变化（新建 / 重命名 / 删除 / 首次加载）时通知宿主重画表 tab 条。
// 宿主是 main.js 的 setupRecordsView —— 它不认识 sheet 内部状态，只认这份摘要。
let sheetListListener = null;

function notifySheetList(meta) {
  if (!sheetListListener) return;
  try {
    sheetListListener(getSheetList(), meta || null);
  } catch (error) {
    console.warn('表格列表回调失败', error);
  }
}

export function onSheetListChange(listener) {
  sheetListListener = typeof listener === 'function' ? listener : null;
}

export function getSheetList() {
  // kind / viewCount 一起带出去：宿主（main.js）要用 kind 区分预置表、
  // 用 viewCount 决定列表上写不写「N 个视图」。以前这里只给四个字段，
  // 宿主拿不到身份就只能靠 key 前缀特判，正是「基础表不像普通表」的来源之一。
  return (state.sheets || []).map(item => ({
    id: item.id,
    name: item.name,
    kind: item.kind || 'table',
    task_id: item.task_id ?? null,
    fieldCount: Number(item.field_count) || 0,
    rowCount: Number(item.row_count) || 0,
    viewCount: Number(item.view_count) || 0,
  }));
}

export function currentSheetId() {
  return state.sheet ? state.sheet.id : null;
}

/**
 * 只把表列表拉一遍并返回摘要，不打开任何表。
 * 表格页的「表库」列表用它刷新字段数/记录数 —— 宿主不认识 sheet 内部状态，
 * 只认这份 {id,name,fieldCount,rowCount} 摘要。
 */
export async function refreshSheetList() {
  if (!isSheetStoreReady()) return [];
  await refreshSheets();
  return getSheetList();
}

/**
 * 从外部切到某张自建表。
 * 宿主只需要「切过去」这一个动作，库视图（renderLibrary）在并列 tab 下没有位置，
 * 所以这里不做 state.view === 'library' 的判断 —— 直接进表。
 */
export async function openSheetTab(sheetId) {
  if (!isSheetStoreReady()) return;
  if (!host) host = document.getElementById('sheet-app');
  if (!host) return;
  if (!state.sheets.length) await refreshSheets();
  await openSheet(sheetId);
}

// 「＋ 新建表」：复用原有的新建弹层（含模板 / 归属任务），
// 创建成功后 openNewSheetModal 内部会 refreshSheets + openSheet，
// tab 条通过 onSheetListChange 自动多出一项。
export function openNewSheet() {
  openNewSheetModal();
}

// 表格动作菜单（重命名 / 改所属任务 / 删除）的对外入口。
// 工作表原本把菜单挂在面包屑行的「⋯」上，tab 方案收掉面包屑后，
// 由 #sheet-more-btn 传自己的 rect 进来当锚点 —— 菜单定位逻辑不动。
export function openCurrentSheetMenu(anchorEl) {
  openSheetMenu(anchorEl);
}

async function openSheet(sheetId, options = {}) {
  const sheet = state.sheets.find(item => String(item.id) === String(sheetId));
  if (!sheet) return;
  state.sheet = sheet;
  state.filters = [];
  state.sorts = [];
  state.search = '';
  // 快捷筛选也归零：切到另一张表还挂着「今天」会让人以为那张表空的
  resetPresetQuick();
  state.fields = await readTableFields(sheet);
  state.rows = await readTableRows(sheet);
  state.view = 'sheet';
  // 换了一张表：必须回到顶部，不能沿用上一张表的滚动位置
  renderSheet({ resetScroll: true });
  // 通知宿主：meta.autoOpen 只在「刚建好一张表」时为真 ——
  // 宿主据此把界面带进表内；普通刷新（改名/删除/开关表）不该动用户的当前位置。
  notifySheetList({ autoOpen: !!options.autoOpen });
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
  state.fields = await readTableFields(state.sheet);
}

async function reloadRows() {
  state.rows = await readTableRows(state.sheet);
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
  const next = prev.catch(() => {}).then(() => saveTableRow(state.sheet, row, row.values));
  rowWriteChains.set(key, next.catch(() => {}));
  return next;
}

async function commitCell(field, row, cellEl, value) {
  const previous = row.values[field.key];
  // 编辑器常常「打开又原样提交」，不判等会让撤销栈里塞满空步骤
  if (sameCellValue(previous, value)) {
    focusIfIdle(cellEl);
    return;
  }
  row.values[field.key] = value;
  if (cellEl) cellEl.innerHTML = renderCell(field, value, cellCtx(field));
  markSaving();
  try {
    await writeRow(row);
    await touchSheet(state.sheet.id);
    markSaved();
    registerCellUndo(
      [{ row, field, before: previous, after: value }],
      `${field.label || '单元格'} 改值`,
      state.sheet?.id
    );
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

/* ───────────── 单元格改动的撤销 ───────────── */

function isEmptyCellValue(value) {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function sameCellValue(a, b) {
  if (isEmptyCellValue(a) && isEmptyCellValue(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

/**
 * 批量写单元格并重画受影响的格子。
 * 不整表重排：renderSheet 会把滚动位置和选区一起丢掉，撤销一下就不知道自己在哪了。
 */
async function applyCellBatch(items, sheetId) {
  if (!items.length) return;
  const map = new Map();
  for (const item of items) {
    item.row.values[item.field.key] = item.value;
    map.set(`${item.row.id}:${item.field.key}`, item);
  }
  // 行可能被筛选掉、或还落在未渲染的分块里 —— 那就只改内存，
  // 下次 loadRows / 滚动补块自然是最新的。
  if (!sheetId || String(state.sheet?.id) === String(sheetId)) {
    host?.querySelectorAll('.sh-cell[data-row][data-key]').forEach(el => {
      const hit = map.get(`${el.dataset.row}:${el.dataset.key}`);
      if (hit) el.innerHTML = renderCell(hit.field, hit.value, cellCtx(hit.field));
    });
  }
  markSaving();
  const written = new Set();
  try {
    for (const item of items) {
      if (written.has(item.row)) continue;
      written.add(item.row);
      await writeRow(item.row);
    }
    if (sheetId) await touchSheet(sheetId);
    markSaved();
  } catch (error) {
    markSaved();
    toast(`撤销失败：${error?.message || error}`, 'danger');
  }
}

/**
 * 单元格改动登记到全局撤销栈。
 * changes = [{ row, field, before, after }]
 * 一次批量操作（粘贴一块 / 清空选区 / Ctrl+X）合成一步 —— 和 Excel 一致：
 * Ctrl+Z 撤掉的是「刚才那次粘贴」，不是粘贴里的某一格。
 */
function registerCellUndo(changes, label, sheetId) {
  const list = changes.filter(item => !sameCellValue(item.before, item.after));
  if (!list.length) return;
  const target = sheetId ?? state.sheet?.id;
  undoStack.push({
    label,
    undo: () => applyCellBatch(list.map(item => ({ row: item.row, field: item.field, value: item.before })), target),
    redo: () => applyCellBatch(list.map(item => ({ row: item.row, field: item.field, value: item.after })), target),
  });
}

function startCellEdit(field, row, cellEl, opts = {}) {
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

  // Excel 的「直接敲字覆盖」：选中一格后打第一个字符，编辑器起来时里面只有这个字符，
  // 光标跟在它后面。旧表（tablePage.js）认 opts.char，合流到 sheetPage 时漏接了 ——
  // 结果在基础表里选中一格直接打字，字会凭空消失，只剩原来的内容。
  const typed = opts.char;
  if (typed != null && typed !== '') {
    const input = cellEl.querySelector('.ft-inline-input');
    if (input && (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA')) {
      input.value = String(typed);
      const end = input.value.length;
      try { input.setSelectionRange(end, end); } catch (error) { /* 忽略 */ }
    }
  }
}

// ---- 图片单元格：粘贴 / 选择 / 删除 ----
// 落盘白名单 / 图片尺寸 / 系统选择框都搬到了 attachmentOps.js ——
// 基础表（tablePage）要插同一批图片，两处各写一份白名单必然漂移。
// 这里只留 ui 层：面板、拖拽、单元格刷新。

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
// 导出给宿主用（视图页签的 ⋯ 菜单）：全局只有一套浮层状态，
// 各自再造一个会互相压不住、关不掉。
// panelClass 默认沿用附件面板那套宽度；小菜单传 'sh-attmenu' 就只吃 .sh-pop 的基础样式。
export function openPopoverSimple(anchorEl, html, panelClass = 'sh-imgpanel') {
  closeAllPanels();
  const el = document.createElement('div');
  el.className = panelClass ? `sh-pop ${panelClass}` : 'sh-pop';
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

// 浮层是全局单例状态（同一时刻只该有一个），关闭入口也要跟着导出，
// 否则宿主开了菜单没有办法在动作执行前把它收掉。
export { closeAllPanels };

// ==========================================
// 行操作
// ==========================================

// 预置表「新建一行」的既定形状。老的基础表就是这么写的（今天 + 未分类 + 待开始），
// 不照做的话新行会显示成「时间空、状态空」—— 同一张表两种新建结果。
function presetNewRowValues() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return {
    text: '',
    tag: '未分类',
    status: 'pending',
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

async function addRow() {
  // 自建表：建出来就是一行空记录，不预填任何字段值（所见即所得：建出来什么样就是什么样）
  // 预置表：它是一条「工作记录」，有既定形状，见 presetNewRowValues。
  const values = state.sheet?.kind === 'preset' ? presetNewRowValues() : {};
  let id = null;
  try {
    id = await insertTableRow(state.sheet, values);
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
      if (grid && grid.sel.size() > 1) clearSelection();
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

// Ctrl+C / 菜单「复制」的统一入口：行、单格、多格都能复制。
// 选区形态由 gridCore 判定（矩形 / 离散 / 整行 / 整列），这里只做「摊平成格」。
function copySelectionToClipboard() {
  if (!grid) return false;
  const rows = rowsInView();
  const cols = colsInView();
  const snap = grid.sel.snapshot();
  if (!snap.size) return false;

  // 单独一行：复制整条记录 —— 能连图片和类型化值一起粘到另一行
  if (snap.mode === 'rows' && snap.rows.length === 1) {
    const row = rows[snap.rows[0]];
    if (!row) return false;
    copyRowToClipboard(row);
    return true;
  }

  // 单格（矩形/离散形态）：走单格通道，粘贴时能校验字段类型
  if (snap.mode !== 'rows' && snap.mode !== 'cols' && snap.size === 1) {
    const at = grid.sel.active();
    const row = at ? rows[at.r] : null;
    const field = at ? cols[at.c] : null;
    if (!row || !field) return false;
    copyCellToClipboard(field, row);
    return true;
  }

  // 多格：按相对偏移打包，保留「A1 + D5」这种不连续选区。
  // 整行整列先摊成真实格子（expand），粘贴时才知道每格落在哪。
  const coords = grid.sel.expand(rows.length, cols.length);
  if (!coords.length) return false;
  const minR = Math.min(...coords.map(pair => pair.r));
  const minC = Math.min(...coords.map(pair => pair.c));
  const items = coords
    .map(({ r, c }) => {
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

  // 同时写一份 TSV 到系统剪贴板：粘到 Excel / WPS 时才不会挤成一格。
  // 内部剪贴板继续保留（它能搬图片和类型化值），两条路互不干扰。
  try {
    const maxR = Math.max(...coords.map(pair => pair.r));
    const maxC = Math.max(...coords.map(pair => pair.c));
    const lines = [];
    for (let r = minR; r <= maxR; r += 1) {
      const line = [];
      for (let c = minC; c <= maxC; c += 1) {
        const row = rows[r];
        const field = cols[c];
        line.push(row && field ? displayValue(field, row.values[field.key]) : '');
      }
      lines.push(line);
    }
    navigator.clipboard?.writeText(serializeTSV(lines)).catch(() => {});
  } catch (error) {
    // 写不进系统剪贴板不影响内部复制，静默即可
  }

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
  // 菜单头写「已选 N 格」：右键落点在当前选区里就报整片，否则只报这一格
  const inSelection = Boolean(grid) && grid.sel.contains(Number(cellEl.dataset.rowindex), Number(cellEl.dataset.col));
  const count = inSelection ? Math.max(1, selectedCoords().length) : 1;
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
      const at = { r: Number(cellEl.dataset.rowindex), c: Number(cellEl.dataset.col) };
      if (grid && grid.sel.contains(at.r, at.c) && grid.sel.size() > 1) {
        clearCells(selectedCoords());
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

// 剪贴板内容的读取统一走 attachmentOps.filesFromDataTransfer（经 clipboardImport 的快照），
// 本文件不再自带一份 —— 两份实现漂移过：截图粘贴在其中一份里读不到 items。

// 读剪贴板（异步 API）。WebView 里可能没有权限、也可能压根不支持 ——
// 这里只负责「读到了什么」，降级提示交给调用方，两条路径不要各写一份。
async function readClipboardContent() {
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
  return { files, text };
}

// 菜单里点「粘贴（覆盖）」：走异步剪贴板 API，拿不到就提示用 Ctrl+V
async function pasteFromClipboard(field, row, cellEl) {
  try {
    const { files, text } = await readClipboardContent();
    if (!files.length && !text) { toast('剪贴板里没有可粘贴的内容', 'info'); return false; }
    return applyPastedContent(field, row, cellEl, { files, text });
  } catch (error) {
    toast('无法读取剪贴板，请选中单元格后按 Ctrl+V', 'info');
    return false;
  }
}

// 附件格「＋」→「从剪贴板粘贴」：追加语义（和加号的本意一致，不清空已有附件）。
// 与 pasteFromClipboard 的区别只在落库方式：那边是「覆盖一格」。
async function appendFromClipboard(field, row, cellEl) {
  let content;
  try {
    content = await readClipboardContent();
  } catch (error) {
    toast('读不到剪贴板，选中这一格后按 Ctrl+V 也能粘', 'info');
    return;
  }
  const images = content.files.filter(file => file?.type?.startsWith('image/'));
  if (!images.length) {
    toast('剪贴板里没有图片', 'info');
    return;
  }
  const added = [];
  try {
    for (const file of images) {
      // 顺序落盘：并发写同一个目录时文件名会撞
      added.push(await storeImageFile(file));
    }
  } catch (error) {
    toast(`图片保存失败：${error?.message || error}`, 'danger');
    return;
  }
  const base = Array.isArray(row.values[field.key]) ? [...row.values[field.key]] : [];
  await commitCell(field, row, cellEl, [...base, ...added]);
  clearSelection();
  renderSheet();
  toast(`已添加 ${added.length} 张图片`);
}

// 附件格右下角「＋」的入口菜单：先选来源，再动手。
// 以前这里直接弹系统文件框 —— 可截图已经在剪贴板里，多走一趟「存成文件再选」
// 完全是白费功夫，而 Ctrl+V 其实一直能用，只是没人知道要点哪儿。
async function openAttachmentAddMenu(anchorEl, field, row, cellEl) {
  // 点开菜单即视为选中这一格：不论走哪条路，落点都和 Ctrl+V 一致
  if (cellEl && !cellEl.classList.contains('is-active')) selectFromCell(cellEl);

  const menu = openPopoverSimple(anchorEl, `
    <button type="button" class="sh-attmenu-item" data-act="clipboard">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-copy"/></svg>
      <span class="sh-attmenu-label">从剪贴板粘贴</span>
      <kbd class="sh-attmenu-kbd">Ctrl V</kbd>
    </button>
    <button type="button" class="sh-attmenu-item" data-act="file">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-type-attachment"/></svg>
      <span class="sh-attmenu-label">选择文件…</span>
      <span class="sh-attmenu-kbd"></span>
    </button>`, 'sh-attmenu');

  menu.addEventListener('click', async event => {
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    // 先收菜单：读剪贴板可能是异步的，菜单挂在屏幕上会挡住结果
    closeAllPanels();
    if (act === 'file') { appendAttachments(field, row, cellEl); return; }
    await appendFromClipboard(field, row, cellEl);
  });
  return menu;
}

/** Excel 粘进来的都是纯文本，按字段类型收一下，别把 "1,234" 直接塞进数字列 */
function coercePasteValue(field, raw) {
  const text = String(raw ?? '').replace(/\r/g, '').trim();
  switch (field.type) {
    case 'multi_select':
      return text ? text.split(/[,，、;；]/).map(part => part.trim()).filter(Boolean) : [];
    case 'checkbox':
      return /^(1|true|是|✓|y|yes)$/i.test(text);
    case 'number': {
      if (!text) return '';
      const num = Number(text.replace(/,/g, ''));
      return Number.isFinite(num) ? num : null; // null = 这一格跳过
    }
    case 'attachment':
      return null; // 文本粘不进附件列
    default:
      return text;
  }
}

/**
 * 从 Excel / WPS 粘一块进来。
 * 内部复制走的是类型化对象（能搬图片），这里只处理纯文本 TSV —— 两条路径并存，
 * 因为「内部复制」和「跨应用粘贴」的能力本来就不同，硬合成一条会丢图片。
 */
async function pasteTSVAt(cellEl, text) {
  const matrix = parseTSV(text);
  if (!matrix.length) return false;

  const anchorR = Number(cellEl.dataset.rowindex);
  const anchorC = Number(cellEl.dataset.col);
  if (Number.isNaN(anchorR) || Number.isNaN(anchorC)) return false;

  const rows = rowsInView();
  const cols = visibleOf(state.fields);
  const changes = [];
  let skipped = 0;

  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix[i].length; j += 1) {
      const row = rows[anchorR + i];
      const field = cols[anchorC + j];
      if (!row || !field) { skipped += 1; continue; }
      const value = coercePasteValue(field, matrix[i][j]);
      if (value === null) { skipped += 1; continue; }
      changes.push({ row, field, before: row.values[field.key], after: value });
    }
  }
  return applyPastedChanges(changes, '粘贴', skipped);
}

/**
 * 带 HTML 结构的一块（可能含图片）→ 原地铺开。
 * 图先落地成附件项，再按单元格类型拼值 —— 顺序不能反：
 * coerceImportValue 要拿「src → 本地附件项」这张表。
 */
async function pasteModelAt(cellEl, model) {
  const anchorR = Number(cellEl.dataset.rowindex);
  const anchorC = Number(cellEl.dataset.col);
  if (Number.isNaN(anchorR) || Number.isNaN(anchorC)) return false;

  const rows = rowsInView();
  const cols = visibleOf(state.fields);
  const totalImages = model.imageCount;
  let result;
  markSaving();
  try {
    result = await buildBlockChanges({
      model,
      fields: cols,
      rows,
      anchorRow: anchorR,
      anchorCol: anchorC,
      onProgress: totalImages
        ? progress => setSaveHint(`保存图片 ${progress.done}/${progress.total}…`)
        : null,
    });
  } catch (error) {
    markSaved();
    toast(`粘贴失败：${error?.message || error}`, 'danger');
    return false;
  }
  return applyPastedChanges(result.changes, '粘贴', result.skipped, result.failedImages);
}

/**
 * 一批单元格改动 = 一次写库 + 一步撤销。
 * 粘贴（文本/图片）与以后可能的批量操作都走这里，避免「图片走得通、文本走另一套」
 * 那种两套语义 —— 撤销深度、提示文案、失败回滚必须完全一致。
 */
async function applyPastedChanges(changes, label, skipped = 0, failedImages = 0) {
  if (!changes.length) {
    toast(
      failedImages ? `${failedImages} 张图片没能保存` : '没有可粘贴的内容',
      failedImages ? 'danger' : 'info'
    );
    markSaved();
    return false;
  }

  for (const change of changes) change.row.values[change.field.key] = change.after;
  const touched = new Map();
  for (const change of changes) touched.set(String(change.row.id), change.row);

  const sheetId = state.sheet?.id;
  markSaving();
  try {
    for (const row of touched.values()) await writeRow(row);
    await touchSheet(state.sheet.id);
    markSaved();
    registerCellUndo(changes, `${label} ${changes.length} 格`, sheetId);
  } catch (error) {
    markSaved();
    toast(`粘贴失败：${error?.message || error}`, 'danger');
    await reloadRows();
    renderSheet();
    return false;
  }

  // 整表重绘而不是只改受影响的格子：附件列要重新渲染缩略图，
  // 单格 innerHTML 换不掉图片节点（renderCell 会重建 img，但尺寸/折叠角标要重算）。
  renderSheet();
  const bits = [`已粘贴 ${changes.length} 格`];
  if (skipped) bits.push(`跳过 ${skipped} 格`);
  if (failedImages) bits.push(`${failedImages} 张图片没能保存`);
  toast(bits.join('，'), failedImages ? 'info' : 'success');
  return true;
}

/** 保存状态那一行临时改文案：几十张图下载时总得有进度。 */
function setSaveHint(text) {
  const el = host?.querySelector('[data-save-state]');
  if (el) el.textContent = String(text);
}

/**
 * 没有落点的导入（空表 / 没选中格 / 块比表宽）。
 * 先弹预览：列名、类型、要不要新建列都得让用户看一眼 ——
 * 靠猜列类型建出来的表，改起来比重新导一遍还贵。
 */
function openBlockImport(snapshot, context = {}) {
  const table = context.table || state.sheet;
  if (!table) return;
  const model = parseClipboardPayload(snapshot);
  if (!model.rows.length) { toast('剪贴板里没有可导入的表格', 'info'); return; }

  openImportPreview({
    table,
    fields: context.fields || state.fields,
    rows: context.rows || state.rows,
    model,
    toast,
    onDone: async result => {
      if (state.sheet && String(state.sheet.id) === String(table.id)) {
        await reloadFields();
        await reloadRows();
        renderSheet({ resetScroll: true });
      } else {
        await refreshSheets();
      }
      registerImportUndo(table, result);
    },
  });
}

/**
 * 整批导入登记成**一步**撤销。
 * 只做 undo 不做 redo：导入会新建列，redo 要重建列并还原每一格的 key，
 * 做不到「按一下就回来」的程度，给个半吊子的重做反而会让人以为数据丢了。
 */
function registerImportUndo(table, result) {
  const rowIds = [...(result.createdRows || [])];
  const fieldIds = (result.createdFields || []).map(field => field.id);
  const hiddenIds = (result.hiddenFields || []).map(field => field.id);
  if (!rowIds.length && !fieldIds.length && !hiddenIds.length) return;

  undoStack.push({
    label: result.label || `导入 ${result.rowCount} 行`,
    undo: async () => {
      for (const id of rowIds) {
        try { await deleteRow(id); } catch (error) { /* 尽力回滚 */ }
      }
      for (const id of fieldIds) {
        try { await deleteTableField(table, id); } catch (error) { /* 尽力回滚 */ }
      }
      for (const id of hiddenIds) {
        try { await patchTableField(table, id, { visible: 1 }); } catch (error) { /* 尽力回滚 */ }
      }
      if (state.sheet && String(state.sheet.id) === String(table.id)) {
        await reloadFields();
        await reloadRows();
        renderSheet();
      }
      toast('已撤销导入', 'info');
    },
  });
}

async function insertRows(row, count, side) {
  const sortIndex = Number(row.sort || 0) + (side === 'below' ? 1 : 0);
  try {
    await insertTableRowsAt(state.sheet, sortIndex, count);
    await reloadRows();
    await touchSheet(state.sheet.id);
  } catch (error) {
    toast(`插入行失败：${error?.message || error}`, 'danger');
    return;
  }
  renderSheet();
  toast(`已插入 ${count} 行`);
}

// 行高：拖行下缘 / 双击自适应都落到这里。
// 0 表示「恢复默认」—— 必须写 SQL NULL，不能写 0（buildRow 会把 0 当成没设过，
// 但数据库里留个 0 会让「下次自适应」判等失效）。
async function applyRowHeight(row, height) {
  const before = Number(row.height) || 0;
  const next = Math.round(Number(height) || 0);
  if (before === next) { renderSheet(); return; }
  try {
    await setRowHeight(row.id, next || null);
  } catch (error) {
    toast(`行高没存住：${error?.message || error}`, 'danger');
    renderSheet();
    return;
  }
  row.height = next;
  undoStack.push({
    label: next ? `调整行高到 ${next}px` : '恢复默认行高',
    undo: async () => { await setRowHeight(row.id, before || null); row.height = before; renderSheet(); },
    redo: async () => { await setRowHeight(row.id, next || null); row.height = next; renderSheet(); },
  });
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
    // 抽屉里改标题走的是 patchRecord（没经过 writeRow / commitCell），
    // 网格上那一格不会自己变 —— 关掉抽屉还写着旧字，看起来就是「没保存」。
    // 「字段」区的滑杆面板：隐藏 / 顺序 / 大小都存在这个字段自己的 options 里
    onFieldLayoutChange: (field, drawer) => saveFieldDrawer(state.sheet, field, drawer),
    onTitleSaved: (field, value) => {
      if (!field || !host) return;
      const cellEl = host.querySelector(
        `.sh-cell[data-row="${CSS.escape(String(row.id))}"][data-key="${CSS.escape(field.key)}"]`
      );
      if (cellEl && !cellEl.classList.contains('ft-cell-editing')) {
        cellEl.innerHTML = renderCell(field, value, cellCtx(field));
      }
    },
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
      await openSheet(sheetId, { autoOpen: true });
      toast('表格已创建');
      return true;
    } catch (error) {
      toast(`创建失败：${error?.message || error}`, 'danger');
      return false;
    }
  }, { btnText: '创建表格' });
}

function renameSheet(target = state.sheet) {
  if (!target) return;
  window.showModal?.('重命名表格', `
    <div class="sh-modal">
      <label class="sh-label">表格名称</label>
      <input type="text" class="sh-input" data-name value="${escapeHtml(target.name)}" />
    </div>`, modalBody => {
    const input = modalBody.querySelector('[data-name]');
    input?.focus();
    input?.select();
  }, async modalBody => {
    const name = modalBody.querySelector('[data-name]')?.value.trim();
    if (!name) return false;
    try {
      await updateSheet(target.id, { name });
    } catch (error) {
      toast(`重命名失败：${error?.message || error}`, 'danger');
      return false;
    }
    target.name = name;
    await refreshSheets();
    // 只有「正开着的表」需要重画表内；从列表改名时列表会跟着 refreshSheets 自己更新
    if (state.sheet && String(state.sheet.id) === String(target.id)) renderSheet();
    toast('已重命名');
    return true;
  }, { btnText: '保存' });
}

// 表格动作菜单（重命名 / 设为默认 / 改所属任务 / 删除）。
// target 默认是「正打开的表」，但表格页改成「表库 → 表内」两层之后，
// 列表行上的 ⋯ 也要能用 —— 那时 state.sheet 是 null，必须由调用方传进来。
function openSheetMenu(anchorEl, target = null) {
  const sheet = target || state.sheet;
  if (!sheet) return;

  // 「这张是不是默认表」存在 settings 里，要 await 才能取到；
  // 菜单因此晚一帧出现 —— 比点开一眼看不见当前状态要好。
  void (async () => {
    let defaultId = null;
    try { defaultId = await getDefaultTableId(); } catch (error) { defaultId = null; }
    const isDefault = String(defaultId) === String(sheet.id);

    const el = openPopoverSimple(anchorEl, `
      <button type="button" class="sh-menu-item" data-sheet-act="rename">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-pencil"/></svg>重命名表格
      </button>
      ${isDefault
        ? '<div class="sh-menu-note">默认表：快速记录都写进这张表</div>'
        : `<button type="button" class="sh-menu-item" data-sheet-act="default">
            <svg class="wr-icon" aria-hidden="true"><use href="#ic-check"/></svg>设为默认表
          </button>`}
      <div class="sh-colmenu-sep"></div>
      <button type="button" class="sh-menu-item" data-sheet-act="task">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-tag"/></svg>改所属任务
      </button>
      <button type="button" class="sh-menu-item" data-sheet-act="import">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-copy"/></svg>从剪贴板导入…
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
      if (action === 'rename') renameSheet(sheet);
      if (action === 'default') {
        // 没有文本列的表当默认表等于「随手记没地方写」：让它当场说清楚，
        // 而不是等用户记完一笔才发现什么都没落下。
        if (String(sheet.kind || '') !== 'preset') {
          let fields = [];
          try { fields = await readTableFields(sheet); } catch (error) { fields = []; }
          if (!fields.some(field => field.type === 'text')) {
            toast('这张表没有文本列：快速记录没地方写，先加一列文本', 'info');
            return;
          }
        }
        try {
          await setDefaultTableId(sheet.id);
        } catch (error) {
          toast(`设为默认表失败：${error?.message || error}`, 'danger');
          return;
        }
        await refreshSheets();
        toast('已设为默认表：快速记录会写进这里');
      }
      if (action === 'task') {
        const taskOptions = ['<option value="">不归属任务</option>', ...state.tasks.map(task => `<option value="${escapeHtml(task.id)}" ${String(task.id) === String(sheet.task_id) ? 'selected' : ''}>${escapeHtml(task.label)}${task.done ? '（已完成）' : ''}</option>`)].join('');
        window.showModal?.('改所属任务', `<div class="sh-modal"><label class="sh-label">所属任务</label><select class="sh-select" data-task>${taskOptions}</select></div>`, null, async modalBody => {
          const value = modalBody.querySelector('[data-task]')?.value || null;
          try {
            await updateSheet(sheet.id, { task_id: value == null ? null : Number(value) });
          } catch (error) {
            toast(`更新归属失败：${error?.message || error}`, 'danger');
            return false;
          }
          sheet.task_id = value;
          await refreshSheets();
          if (state.sheet && String(state.sheet.id) === String(sheet.id)) renderSheet();
          toast('已更新归属');
          return true;
        }, { btnText: '保存' });
      }
      if (action === 'import') {
        // 从表库的卡片菜单进来时这张表可能没被打开：字段和行要现查，
        // 不能拿 state 里那张表的数据凑（会把内容导进错误的表）。
        const isOpen = state.sheet && String(state.sheet.id) === String(sheet.id);
        openPasteCapture({
          toast,
          onSnapshot: async snapshot => {
            let fields = isOpen ? state.fields : [];
            let rows = isOpen ? state.rows : [];
            if (!isOpen) {
              try {
                fields = await readTableFields(sheet);
                rows = await readTableRows(sheet);
              } catch (error) {
                fields = [];
                rows = [];
              }
            }
            openBlockImport(snapshot, { table: sheet, fields, rows });
          },
        });
      }
      if (action === 'delete') {
        // 行数优先用列表摘要里的 row_count：从表库删表时这张表没被打开过，state.rows 是空的
        const total = state.sheet && String(state.sheet.id) === String(sheet.id)
          ? state.rows.length
          : Number(sheet.row_count) || 0;
        // 预置表的行不在 sheet_field / sheet_id 体系里，删表会连它的记录一起走。
        // 这句话必须写在按钮之前 —— 用户点的那一下，代价得让他先看见。
        const presetHint = String(sheet.kind || '') === 'preset'
          ? '<br>它的记录会一起清掉（标题、正文、分类、附件都在里面），无法撤销。'
          : '此操作无法撤销。';
        window.showModal?.('删除表格', `<p style="margin:0;">删除「${escapeHtml(sheet.name)}」${total ? `以及它的 ${total} 条记录` : ''}？${presetHint}</p>`, null, async () => {
          const wasOpen = state.sheet && String(state.sheet.id) === String(sheet.id);
          try {
            await deleteSheet(sheet.id);
          } catch (error) {
            const message = String(error?.message || error);
            toast(message.startsWith('这是最后一张表') ? message : `删除失败：${message}`, 'danger');
            return false;
          }
          if (wasOpen) backToLibrary();
          else await refreshSheets();
          toast('表格已删除');
          return true;
        }, { danger: true, btnText: '删除' });
      }
    });
  })();
}

// 表库里按 id 打开菜单：宿主只拿得到列表摘要，不持有 sheet 对象。
export function openSheetMenuFor(sheetId, anchorEl) {
  const sheet = state.sheets.find(item => String(item.id) === String(sheetId));
  if (sheet) openSheetMenu(anchorEl, sheet);
}

// ==========================================
// 事件
// ==========================================

// ==========================================
// 选区（与基础表同一套内核：gridCore.createSelection）
// ==========================================
//
// 这里原来是一套自建状态：{ mode, cells:Set, rowIds, fieldKeys, anchor }，
// 每种形态各配一条绘制路径（applyCellSet / paintCellSelection /
// toggleFieldSelection / toggleRowSelection / paintRowSelection），
// 加上自己的拖框与键盘，约 400 行。基础表那边另有一套 —— 于是「选中一格再按
// 方向键」在两个表里是两种手感，改一个快捷键要改两处。
//
// 现在统一走 gridCore，本文件只做两件事：
//   ① 把内核快照画到 DOM 上（paintSelection）；
//   ② 把「下标」翻译成「行 id / 字段 key」（数据库认的是这两个，不认下标）。
// 内核的坐标 = 筛选后列表里的下标，和 data-rowindex / data-col 完全一致。

let grid = null;
let fillHandle = null;

// "行:列" → 单元格元素。拖框选择时按格遍历，避免每次 pointermove 全表
// querySelectorAll（几千格时明显卡）。
let cellEls = new Map();
let dragSel = null;
let suppressClick = false;

function rebuildCellIndex() {
  cellEls = new Map();
  host?.querySelectorAll('.sh-cell[data-rowindex]').forEach(el => {
    cellEls.set(`${el.dataset.rowindex}:${el.dataset.col}`, el);
  });
}

function rowsInView() {
  return filterRows(state.rows);
}

function colsInView() {
  return visibleOf(state.fields);
}

function cellElAt(r, c) {
  return cellEls.get(`${r}:${c}`) || null;
}

function rowAt(r) {
  return rowsInView()[r] || null;
}

function fieldAt(c) {
  return colsInView()[c] || null;
}

// 整行/整列选区在内核里存的是下标；批量条和写库认的是行 id / 字段 key。
function pickedRowIds() {
  const list = rowsInView();
  if (!grid) return [];
  return grid.sel.rowsList().map(r => list[r]?.id).filter(id => id != null);
}

function pickedFieldKeys() {
  const list = colsInView();
  if (!grid) return [];
  return grid.sel.colsList().map(c => list[c]?.key).filter(Boolean);
}

function isEditingCell() {
  return Boolean(host?.querySelector('.ft-cell-editing'));
}

function clearSelection() {
  if (grid) grid.sel.clear();
  cellEls.forEach(el => el.classList.remove('is-sel', 'is-active'));
  host?.querySelectorAll('.sh-th.is-sel, .sh-rownum.is-sel').forEach(el => el.classList.remove('is-sel'));
  updateBulkBar();
  fillHandle?.reposition();
}

/**
 * 把内核的选区画到 DOM 上。
 * 逐格扫一遍而不是维护三套 diff：一屏最多几百格，扫一遍比「三种形态各写
 * 一条增量路径」简单得多，也不容易出现「切形态后残留高亮」。
 */
function paintSelection() {
  if (!grid || !host) return;
  const snap = grid.sel.snapshot();

  cellEls.forEach((el, key) => {
    const [r, c] = key.split(':').map(Number);
    el.classList.toggle('is-sel', grid.sel.contains(r, c));
    el.classList.remove('is-active');
  });
  host.querySelectorAll('.sh-th.is-sel').forEach(el => el.classList.remove('is-sel'));
  host.querySelectorAll('.sh-rownum.is-sel').forEach(el => el.classList.remove('is-sel'));

  // 整行/整列没有「活动格」—— 用户点的是行号 / 列头，描边画在格子上会误导
  const whole = snap.mode === 'rows' || snap.mode === 'cols';
  const active = grid.sel.active();
  if (active && !whole) cellElAt(active.r, active.c)?.classList.add('is-active');

  if (snap.mode === 'rows') {
    const ids = new Set(pickedRowIds().map(String));
    host.querySelectorAll('.sh-rownum').forEach(btn => btn.classList.toggle('is-sel', ids.has(String(btn.dataset.row))));
  } else if (snap.mode === 'cols') {
    const keys = new Set(pickedFieldKeys());
    host.querySelectorAll('.sh-th[data-key]').forEach(th => th.classList.toggle('is-sel', keys.has(th.dataset.key)));
  }

  updateBulkBar();
  fillHandle?.reposition();
}

function ensureGrid() {
  if (grid) return grid;
  grid = createGrid({
    rowCount: () => rowsInView().length,
    colCount: () => colsInView().length,
    isEditing: isEditingCell,
    pageSize: () => 12,
    isEmpty: (r, c) => {
      const row = rowAt(r);
      const field = fieldAt(c);
      if (!row || !field) return true;
      const value = row.values[field.key];
      if (Array.isArray(value)) return value.length === 0;
      return value === '' || value === null || value === undefined;
    },
    focus: (r, c) => {
      // 行是分块渲染的：目标行可能还没画出来，先补块再落焦点。
      // 不补的话方向键走到第 60 行（第一块末尾）就再也下不去了。
      let el = cellElAt(r, c);
      let guard = 0;
      while (!el && state.rendered < rowsInView().length && guard < 200) {
        renderBodyRows(false);
        el = cellElAt(r, c);
        guard += 1;
      }
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
    onSelection: paintSelection,
    onEditStart: (r, c, opts) => startEditAt(r, c, opts),
    onClear: coords => { clearCells(coords); },
    onCopy: () => { copySelectionToClipboard(); },
    onPasteRequest: () => pasteAtActiveCell(),
    onSelectAll: selectAllCells,
  });
  return grid;
}

function startEditAt(r, c, opts = {}) {
  const cellEl = cellElAt(r, c);
  const row = rowAt(r);
  const field = fieldAt(c);
  if (!cellEl || !row || !field) return;
  startCellEdit(field, row, cellEl, opts);
}

function pasteAtActiveCell() {
  const cell = host?.querySelector('.sh-cell.is-active');
  if (!cell) return;
  const field = state.fields.find(item => item.key === cell.dataset.key);
  const row = state.rows.find(item => String(item.id) === String(cell.dataset.row));
  if (!field || !row) return;
  pasteCellFromClipboard(field, row, cell);
}

function selectAllCells() {
  const rowTotal = rowsInView().length;
  const colTotal = colsInView().length;
  if (!rowTotal || !colTotal || !grid) return;
  grid.sel.select(0, 0);
  grid.sel.extendTo(rowTotal - 1, colTotal - 1);
  paintSelection();
}

// 左键点列头 = 选中整列（Ctrl 累加、Shift 连选）；列菜单走右键 —— Excel 的手势
function selectColumnByKey(key, event) {
  const index = colsInView().findIndex(item => item.key === key);
  if (index < 0 || !grid) return;
  const snap = grid.sel.snapshot();
  const extend = Boolean(event?.shiftKey) && snap.mode === 'cols' && snap.cols.length > 0;
  grid.selectLine({
    axis: 'col',
    index,
    additive: Boolean(event?.ctrlKey || event?.metaKey),
    extend,
  });
}

// 左键点行号 = 选中整行；行菜单走右键，详情走双击
function selectRowByIndex(index, event) {
  if (!Number.isInteger(index) || index < 0 || !grid) return;
  const snap = grid.sel.snapshot();
  const extend = Boolean(event?.shiftKey) && snap.mode === 'rows' && snap.rows.length > 0;
  grid.selectLine({
    axis: 'row',
    index,
    additive: Boolean(event?.ctrlKey || event?.metaKey),
    extend,
  });
}

function selectRowById(rowId, event) {
  const index = rowsInView().findIndex(item => String(item.id) === String(rowId));
  if (index < 0) return;
  selectRowByIndex(index, event);
}

// 单击某格：普通=单选；Ctrl=加/减单格；Shift=从锚点扩矩形。双击才进编辑。
function selectFromCell(cell, event) {
  const r = Number(cell.dataset.rowindex);
  const c = Number(cell.dataset.col);
  if (Number.isNaN(r) || Number.isNaN(c)) return;
  ensureGrid().select(r, c, {
    additive: Boolean(event?.ctrlKey || event?.metaKey),
    extend: Boolean(event?.shiftKey),
  });
}

function updateBulkBar() {
  const page = host?.querySelector('.sh-page');
  if (!page || !grid) return;
  let bar = page.querySelector('.sh-bulk');
  const snap = grid.sel.snapshot();
  const fieldKeys = pickedFieldKeys();
  const rowIds = pickedRowIds();
  const hasFields = snap.mode === 'cols' && fieldKeys.length > 0;
  const hasRows = snap.mode === 'rows' && rowIds.length > 0;
  // 多格：矩形、Ctrl 点出来的离散格、整行整列之外的任何形态，统一按格数判断
  const hasCells = !hasRows && !hasFields && snap.size > 1;

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
    const fields = fieldKeys
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
      <span class="sh-bulk-count">已选 ${rowIds.length} 行</span>
      <span class="sh-bulk-sep"></span>
      <button type="button" class="sh-bulk-btn" data-bulk="dup-rows">复制一份</button>
      <button type="button" class="sh-bulk-btn is-danger" data-bulk="delete-rows">删除</button>
      <span class="sh-bulk-sep"></span>
      <button type="button" class="sh-bulk-btn" data-bulk="cancel">取消</button>`;
    return;
  }

  bar.innerHTML = `
    <span class="sh-bulk-count">已选 ${snap.size} 格</span>
    <span class="sh-bulk-sep"></span>
    <input type="text" class="sh-bulk-input is-wide" data-bulk-value placeholder="批量填入…" />
    <button type="button" class="sh-bulk-btn" data-bulk="fill">填充</button>
    <button type="button" class="sh-bulk-btn" data-bulk="clear">清空</button>
    <span class="sh-bulk-sep"></span>
    <button type="button" class="sh-bulk-btn" data-bulk="cancel">取消</button>`;
}

function selectedCoords() {
  if (!grid) return [];
  return grid.sel.expand(rowsInView().length, colsInView().length);
}

function blankFor(field) {
  if (field.type === 'checkbox') return false;
  if (field.type === 'attachment') return [];
  return '';
}

/**
 * 把一批 {r,c} 坐标写成值：统一算「改哪行哪列、改前改后」，一次落库、一步撤销。
 * 一次批量操作合成一步 —— 和 Excel 一致：Ctrl+Z 撤掉的是「刚才那次清空」，
 * 不是清空里的某一格。pickValue 返回 undefined 表示「这一格不动」。
 */
async function writeCells(coords, pickValue, labelOf) {
  const rows = rowsInView();
  const cols = colsInView();
  const changes = [];
  for (const { r, c } of coords) {
    const row = rows[r];
    const field = cols[c];
    if (!row || !field) continue;
    const before = row.values[field.key];
    const after = pickValue(field, row, before);
    if (after === undefined) continue;
    if (sameCellValue(before, after)) continue;
    changes.push({ row, field, before, after });
  }
  if (!changes.length) return 0;
  const sheetId = state.sheet?.id;
  await applyCellBatch(
    changes.map(item => ({ row: item.row, field: item.field, value: item.after })),
    sheetId
  );
  registerCellUndo(changes, labelOf(changes.length), sheetId);
  return changes.length;
}

// 清空选区（Delete / Ctrl+X / 批量条「清空」）。
// 不清选区也不重排整表：Excel 删完内容仍停在原处，重排会把滚动位置一起带走。
async function clearCells(coords) {
  const count = await writeCells(coords, field => blankFor(field), n => `清空 ${n} 格`);
  if (count) toast(`已清空 ${count} 格`);
  return count;
}

// 批量填同一个值（批量条「填充」）。只有文本/数字列能填，其余跳过。
async function fillCells(coords, rawValue) {
  const text = String(rawValue ?? '');
  const count = await writeCells(
    coords,
    field => (field.type === 'text' || field.type === 'number' ? text : undefined),
    n => `填入 ${n} 格`
  );
  if (count) toast(`已填入 ${count} 格`);
  else toast('选中的单元格不是文本/数字列，填不进去', 'info');
  return count;
}

async function bulkApplyToFields(action, widthValue) {
  const fields = pickedFieldKeys().map(key => state.fields.find(field => field.key === key)).filter(Boolean);
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
    window.showModal?.('删除列', `<p style="margin:0;">删除选中的 ${pickedFieldKeys().length} 列？列里的数据会一起消失。</p>`, null, async () => {
      await bulkApplyToFields('delete');
      return true;
    }, { danger: true, btnText: '删除' });
    return;
  }
  if (action === 'clear') { clearCells(selectedCoords()); return; }
  if (action === 'delete-rows') {
    const ids = pickedRowIds();
    const count = ids.length;
    window.showModal?.('删除记录', `<p style="margin:0;">删除选中的 ${count} 行？此操作无法撤销。</p>`, null, async () => {
      for (const id of ids) {
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
    const ids = pickedRowIds();
    const rowsInOrder = rowsInView().filter(row => ids.some(id => String(id) === String(row.id)));
    for (const row of rowsInOrder) {
      try { await duplicateTableRow(state.sheet, row.values); } catch (error) { console.warn('duplicateRow failed', row.id, error); }
    }
    clearSelection();
    await reloadRows();
    renderSheet();
    toast(`已复制 ${rowsInOrder.length} 行`);
    return;
  }
  if (action === 'fill') {
    const value = bar.querySelector('[data-bulk-value]')?.value ?? '';
    fillCells(selectedCoords(), value);
  }
}

// 拖框选：按住单元格拖出一个矩形。
// 用 rAF 合帧 + 目标格去重 → 每次 pointermove 不再全表重排。
function onSelectPointerMove(event) {
  if (!dragSel || !grid) return;
  const dx = Math.abs(event.clientX - dragSel.x);
  const dy = Math.abs(event.clientY - dragSel.y);
  if (!dragSel.moved) {
    if (dx < 5 && dy < 5) return;
    dragSel.moved = true;
    document.body.classList.add('sh-selecting');
    // 真正开始拖了才把起点定成锚点：单纯点一下的语义交给 click 处理，
    // 在这里抢先选中会让 Ctrl 点选、Shift 连选失去锚点。
    grid.sel.select(dragSel.r, dragSel.c);
  }

  const el = document.elementFromPoint(event.clientX, event.clientY);
  const under = el?.closest?.('.sh-cell');
  let r;
  let c;
  if (under && under.dataset.rowindex != null) {
    r = Number(under.dataset.rowindex);
    c = Number(under.dataset.col);
  } else {
    // 拖框擦到行号栏：按 Excel 的规矩「补到第一列」，而不是原地卡住。
    // 卡住的后果是松手时那一下 click 落到行号上，看起来就像「框选跑成了选整行」。
    const tr = el?.closest?.('.sh-row');
    const first = tr?.querySelector?.('.sh-cell[data-col="0"]');
    if (!first || first.dataset.rowindex == null) return;
    r = Number(first.dataset.rowindex);
    c = 0;
  }
  if (dragSel.last && dragSel.last.r === r && dragSel.last.c === c) return;
  dragSel.last = { r, c };
  if (dragSel.raf) return; // 一帧只画一次
  dragSel.raf = requestAnimationFrame(() => {
    dragSel.raf = 0;
    if (!dragSel?.last || !grid) return;
    grid.sel.extendTo(dragSel.last.r, dragSel.last.c);
    paintSelection();
  });
}

function onSelectPointerUp() {
  document.removeEventListener('pointermove', onSelectPointerMove);
  document.removeEventListener('pointerup', onSelectPointerUp);
  document.body.classList.remove('sh-selecting');
  if (dragSel?.raf) {
    cancelAnimationFrame(dragSel.raf);
    if (dragSel.last && grid) {
      grid.sel.extendTo(dragSel.last.r, dragSel.last.c);
      paintSelection();
    }
  }
  if (dragSel?.moved) suppressClick = true;
  dragSel = null;
}

// ==========================================
// 填充柄 / 行高拖拽（与基础表同一套手势层）
// ==========================================

/**
 * 拖填充柄松手：把源矩形的值按 Excel 规则循环铺到目标区。
 * 只有「扩张出去」的格会写，源格不动（fillPlan 已保证）。
 */
async function applyFillPlan(plan) {
  const rows = rowsInView();
  const cols = colsInView();
  const changes = [];
  for (const cell of plan.cells) {
    const targetRow = rows[cell.r];
    const targetField = cols[cell.c];
    const sourceRow = rows[cell.fromR];
    const sourceField = cols[cell.fromC];
    if (!targetRow || !targetField || !sourceRow || !sourceField) continue;
    const next = cloneValue(sourceRow.values[sourceField.key]);
    // 附件是数组，复制等于让两行共享同一批文件引用 —— 语义不清，跳过（基础表同样）
    if (Array.isArray(next)) continue;
    const before = targetRow.values[targetField.key];
    if (sameCellValue(before, next)) continue;
    changes.push({ row: targetRow, field: targetField, before, after: next });
  }
  if (!changes.length) {
    toast('没有可填充的内容', 'info');
    fillHandle?.reposition();
    return;
  }
  const sheetId = state.sheet?.id;
  try {
    await applyCellBatch(
      changes.map(item => ({ row: item.row, field: item.field, value: item.after })),
      sheetId
    );
    registerCellUndo(changes, `填充 ${changes.length} 格`, sheetId);
  } catch (error) {
    toast(`填充失败：${error?.message || error}`, 'danger');
    return;
  }
  // 填充完选区扩到整个目标矩形（Excel 同款），接着按 Ctrl+C 就能整块复制
  if (grid && plan.box) {
    grid.sel.select(plan.box.r1, plan.box.c1);
    grid.sel.extendTo(plan.box.r2, plan.box.c2);
    paintSelection();
  }
  toast(`已填充 ${changes.length} 格`);
}

function rowOfEl(rowEl) {
  const id = rowEl?.dataset?.id;
  if (id == null) return null;
  return state.rows.find(item => String(item.id) === String(id)) || null;
}

// 手势只挂一次（宿主容器在页面生命周期内不变）。
// 滚动容器每次重绘都会被换掉，所以 getScroll 必须惰性取 —— 传死节点会在
// 第二次 renderSheet 之后把填充柄挂进一个已经脱离文档的 div 里。
function mountGestures(rootEl) {
  if (fillHandle) return;
  fillHandle = mountFillHandle({
    root: rootEl,
    getScroll: () => rootEl.querySelector('[data-scroll]'),
    cellSelector: '.sh-cell',
    tableSelector: '.sh-table',
    getBounds: () => (grid ? grid.sel.bounds() : null),
    getCounts: () => ({ rows: rowsInView().length, cols: colsInView().length }),
    isBlocked: isEditingCell,
    onFill: plan => { applyFillPlan(plan); },
  });
  mountRowResizer({
    root: rootEl,
    rowSelector: '.sh-row',
    cellSelector: '.sh-cell',
    // 行高只从行号栏拖：单元格上下边缘用来「选下一格」，不再兼任行高抓手
    edgeSelector: '.sh-td-index',
    min: 28,
    max: 600,
    isBlocked: isEditingCell,
    onResize: (rowEl, px) => {
      const row = rowOfEl(rowEl);
      if (row) void applyRowHeight(row, px);
    },
    onAutoFit: rowEl => {
      const row = rowOfEl(rowEl);
      if (row) void autoFitRow(row);
    },
  });
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
  // 正在编辑的格子里按下：不开始框选、不挪选区 —— 那一下是「放光标」的意思。
  // 拖动选区在这里起手的话，指针一移就把编辑态甩掉了。
  if (event.target.closest('.sh-cell.ft-cell-editing')) return;
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
    // 已经在编辑的那一格：双击是「选一个词」，交给浏览器去选，不拦、也不重开编辑器
    if (cell.classList.contains('ft-cell-editing')) return;
    event.preventDefault();
    if (field.type === 'attachment') {
      const items = Array.isArray(row.values[field.key]) ? row.values[field.key].filter(item => item && item.path) : [];
      if (!items.length) {
        // 空附件格：双击也先问来源 —— 和右下角「＋」用同一套，
        // 否则同一个「加附件」动作，一个入口问、一个入口不问。
        openAttachmentAddMenu(cell, field, row, cell);
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
    if (field) {
      event.preventDefault();
      selectColumnByKey(field.key);
      openColumnMenuFor(th, field);
      return;
    }
  }
  // 右键单元格 = 单元格菜单（复制/粘贴/编辑/清除/插行/删行），WPS 同款。
  // 如果右键的格子已在当前多选里，保留选区（要操作的是整片选中格）；否则才切成单格。
  const cellEl = event.target.closest('.sh-cell');
  if (cellEl) {
    const field = state.fields.find(item => item.key === cellEl.dataset.key);
    const row = state.rows.find(item => String(item.id) === String(cellEl.dataset.row));
    if (field && row) {
      event.preventDefault();
      const r = Number(cellEl.dataset.rowindex);
      const c = Number(cellEl.dataset.col);
      // 正在编辑的格子不重新选中：select() 会把焦点从编辑器挪走，右键一下编辑就没了。
      // 它的选区本来就在，菜单照开（Excel 右键编辑中的格子也是保留编辑）。
      const editing = cellEl.classList.contains('ft-cell-editing');
      if (!editing && grid && !grid.sel.contains(r, c)) ensureGrid().select(r, c);
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

// 编辑中的格子：点格子里的空白处（换行列的文字块外面那一片）不能把焦点抢到格子上。
// 格子是 tabindex=-1 的可聚焦元素，浏览器默认会把焦点交给它 → 输入框 blur → 提交并收掉编辑态，
// 也就是「想点一下挪光标，结果编辑没了」。这里拦下这一下并把焦点还给编辑器；
// 点在输入框本身上就放行，光标落点交给浏览器（Excel 也是这个手感）。
function onHostMouseDown(event) {
  if (event.button !== 0) return;   // 右键交给 contextmenu，别在这里拦（拦了菜单可能不弹）
  const editingCell = event.target.closest?.('.sh-cell.ft-cell-editing');
  if (!editingCell) return;
  if (event.target.closest('.ft-inline-input, .ft-dropdown')) return;
  event.preventDefault();
  editingCell.querySelector('.ft-inline-input')?.focus({ preventScroll: true });
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

  // 预置表快捷筛选：三个开关。点已选中的那个不取消（「全部」就是取消），
  // 与页面表头原来那排 chip 的手感一致。
  const quick = event.target.closest('[data-quick]');
  if (quick) {
    presetQuick.mode = quick.dataset.quick || 'all';
    renderSheet({ resetScroll: true });
    return;
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
    selectColumnByKey(thBtn.dataset.key, event);
    return;
  }
  if (event.target.closest('.sh-th-add-btn')) { addFieldAt(null, 'right'); return; }

  const rownum = event.target.closest('.sh-rownum');
  if (rownum) {
    // 左键点行号 = 选中这一行（Ctrl 累加 / Shift 连选），和列头同一套手势；
    // 行菜单走右键，详情走双击。
    selectRowById(rownum.dataset.row, event);
    return;
  }

  // 附件格右下角的「＋」：先选来源（剪贴板 / 文件），再落进这一格
  const addAtt = event.target.closest('.ft-att-add');
  if (addAtt) {
    const cellEl = addAtt.closest('.sh-cell');
    const field = cellEl && state.fields.find(item => item.key === cellEl.dataset.key);
    const row = cellEl && state.rows.find(item => String(item.id) === String(cellEl.dataset.row));
    if (field && row) openAttachmentAddMenu(addAtt, field, row, cellEl);
    return;
  }

  // 图片缩略图：单击只是选中单元格（和普通单元格一致），双击才看大图
  const thumb = event.target.closest('img.ft-att-thumb');
  if (thumb) {
    const cell = thumb.closest('.sh-cell');
    if (cell) selectFromCell(cell, event);
    return;
  }

  const cell = event.target.closest('.sh-cell');
  if (cell) {
    // 正在编辑的这一格：点它只是挪光标（Excel 语义），不重新选中。
    // 选中会走 grid.select() → adapter.focus() → 把焦点从输入框挪到格子上，
    // 输入框 blur 立刻提交，表现就是「想点一下改字，结果编辑态没了」。
    if (cell.classList.contains('ft-cell-editing')) return;
    // 单击只选中；Ctrl=加减单个格，Shift=从锚点扩展矩形，双击才编辑
    selectFromCell(cell, event);
    return;
  }

  // 点到表格空白等非操作区域：取消选中（工具条、菜单入口保持）
  const keep = event.target.closest('.sh-toolbar, .sh-filterbar, .sh-quick, .sh-crumbs, .sh-sheet-head, .sh-bulk, .sh-status, .sh-chips, .sh-table-foot, .sh-rownum');
  if (!keep) clearSelection();
}

// 快捷筛选的两个下拉：<select> 只发 change，click 事件里拿不到最终值。
function onHostChange(event) {
  const tag = event.target.closest?.('[data-quick-tag]');
  const sub = event.target.closest?.('[data-quick-sub]');
  if (!tag && !sub) return;
  if (tag) presetQuick.tag = tag.value;
  if (sub) presetQuick.sub = sub.value;
  renderSheet({ resetScroll: true });
  // 整页重排把 <select> 换成了新节点，焦点会掉回 body。
  // 主分类、子项目通常要连着改两次，这里把焦点接回去（只聚焦，不展开）。
  host.querySelector(tag ? '[data-quick-tag]' : '[data-quick-sub]')?.focus({ preventScroll: true });
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

// 键盘语义全部交给 gridCore 的意图解析 —— 与基础表同一套：
// 方向键 / Ctrl+方向跳数据边界 / Tab 绕行 / Home·End / Delete 清空 / Ctrl+A 全选。
// 以前这里是手写的另一份：Ctrl+方向只能跳到首末，Tab 不会补新行，
// 于是一个快捷键在两个表里是两种结果 —— 这正是「两套体系」的日常体感。
function onHostKeydown(event) {
  // 全局 Ctrl+Z 在 document 捕获阶段就处理掉了（并 preventDefault）。
  // 这里不再拦一次，否则一次按键会连撤两步。
  if (event.defaultPrevented) return;
  const cell = document.activeElement?.closest?.('.sh-cell');
  if (!cell || !host?.contains(cell)) return;
  // 编辑器内部：放行给原生控件
  if (cell.querySelector('input, textarea') || isEditingCell()) return;
  if (!grid) return;

  const intent = resolveKeyIntent(event, { editing: false, pageSize: 12 });
  // 只有 paste 必须让路：系统剪贴板要靠原生 paste 事件才拿得到。
  // type（「直接敲字覆盖」）以前也在这条里让路，理由是「编辑器不认首字符」——
  // 但格子的 div 不是可编辑元素，让路的结果是那个字符凭空消失。
  // startCellEdit 现在接 opts.char 了，于是交回给网格：开编辑、预填这个字符。
  if (intent.type === 'none' || intent.type === 'paste') return;
  if (grid.handleKeydown(event)) event.preventDefault();
}

// ==========================================
// 入口
// ==========================================

export async function initSheetPage() {
  host = document.getElementById('sheet-app');
  if (!host) return;
  if (!isSheetStoreReady()) return;
  // 附件的落盘/选择在 attachmentOps 里，失败提示要走本页的 toast。
  setAttachmentNotifier(toast);

  if (!host.dataset.shBound) {
    host.dataset.shBound = '1';
    host.addEventListener('click', onHostClick);
    host.addEventListener('change', onHostChange);
    host.addEventListener('pointerdown', onHostPointerDown);
    // 捕获阶段：编辑态下格子空白处的按下要**先**被拦下来，浏览器才不会把焦点交给格子
    host.addEventListener('mousedown', onHostMouseDown, true);
    // 浏览器默认会把 <img> 拖成 ghost 图，打断拖框选择（图片单元格尤其明显）
    host.addEventListener('dragstart', event => {
      if (event.target.closest('.sh-cell')) event.preventDefault();
    });
    host.addEventListener('dblclick', onHostDblClick);
    host.addEventListener('contextmenu', onHostContextMenu);
    document.addEventListener('keydown', event => {
      if (!grid || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        if (grid.sel.size() || grid.sel.colsList().length || grid.sel.rowsList().length) {
          event.preventDefault();
          clearSelection();
        }
        return;
      }
      // 正在输入时一律放行给原生控件。注意必须包含 textarea ——
      // 自动换行的单元格用的是多行 textarea，漏掉它会导致
      // Backspace/Delete 被下面「清空选区」截获，表现为编辑时删除键失灵。
      // select 也在这里：快捷筛选的两个下拉拿到焦点后，Delete 不该去清表格。
      const typing =
        document.activeElement?.closest?.('input, textarea, select, [contenteditable="true"]') ||
        document.querySelector('.sh-dp, .ft-dropdown, .sh-bulk input');
      if (typing) return;
      // 焦点在格子里时由 onHostKeydown（gridCore）处理，这里只管「没焦点」的情形 ——
      // 比如点完行号、选区还在，但活动元素是行号按钮。
      if (document.activeElement?.closest?.('.sh-cell')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const coords = selectedCoords();
        if (!coords.length) return;
        event.preventDefault();
        clearCells(coords);
      }
    });
    host.addEventListener('keydown', onHostKeydown);
    // 选区内核 + 共用手势层只建一次；表格重绘不影响它们（节点都是惰性取的）
    ensureGrid();
    mountGestures(host);

    // Ctrl+C / Ctrl+V：都走内部剪贴板（能搬图片等复杂值）。
    // 内部剪贴板不写系统剪贴板，所以必须拦 keydown；没内容时才走系统粘贴的 paste 事件。
    document.addEventListener('keydown', event => {
      if (state.view !== 'sheet' || !host) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = String(event.key).toLowerCase();
      if (key !== 'c' && key !== 'v' && key !== 'x') return;
      const typing = document.activeElement?.closest?.('input, textarea, select, [contenteditable="true"]');
      if (typing || document.querySelector('.ft-cell-editing')) return;
      // 导入弹层开着时，内部剪贴板的 Ctrl+V 会把内容粘到弹层背后的表格上 ——
      // 用户明明是在等「把剪贴板里的表格导进来」。所有全局弹层一律让路。
      if (isCapturing()) return;
      const modalOverlay = document.getElementById('global-modal-overlay');
      if (modalOverlay && modalOverlay.style.display === 'flex') return;

      if (key === 'c') {
        if (String(window.getSelection() || '')) return; // 有文本选区 → 交给原生复制
        if (copySelectionToClipboard()) event.preventDefault();
        return;
      }

      // Ctrl+X：先复制再清空。整行不在此列 —— 整行剪切要连带删行，
      // 那是行菜单的语义，不该被一个快捷键顺手做掉。
      if (key === 'x') {
        if (String(window.getSelection() || '')) return;
        const snap = grid ? grid.sel.snapshot() : null;
        if (snap && snap.size >= 1 && snap.mode !== 'rows' && copySelectionToClipboard()) {
          event.preventDefault();
          clearCells(selectedCoords());
        }
        return;
      }

      if (!hasInternalClipboard()) return;

      const snap = grid ? grid.sel.snapshot() : null;
      if (snap && snap.mode === 'rows' && snap.rows.length) {
        event.preventDefault();
        if (clipboard.kind !== 'row') { toast('剪贴板里是一条单元格内容，请选中单元格再粘贴', 'info'); return; }
        const targets = pickedRowIds().map(id => state.rows.find(item => String(item.id) === String(id)));
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
    // Ctrl+V：整块表格优先「导入」，单格内容才走「覆盖这一格」。
    //
    // 以前这里第一件事就是找 .sh-cell.is-active，找不到直接 return ——
    // 于是「新建的空表按 Ctrl+V 毫无反应」，而这恰好是导入最常用的入口。
    // 现在按内容分派：
    //   有结构（HTML 表格 / TSV）+ 有落点 + 放得下 → 原地铺开（Excel 语义）
    //   其余情况都要建列或追加行 → 弹预览确认列结构
    document.addEventListener('paste', event => {
      if (state.view !== 'sheet' || !host) return;
      // 捕获弹层开着的时候由它自己处理（它监听的是同一个 document）
      if (isCapturing()) return;
      // 任何全局弹层开着都不该往表里粘：重命名、删表、导入预览都一样，
      // 否则「在输入框外面按一下 Ctrl+V」会把内容直接灌进底下的表格
      const overlay = document.getElementById('global-modal-overlay');
      if (overlay && overlay.style.display === 'flex') return;
      const typing = document.activeElement?.closest?.('input, textarea, select, [contenteditable="true"]');
      if (typing) return; // 正在输入 → 交给原生粘贴
      if (document.querySelector('.ft-cell-editing')) return;

      const snapshot = snapshotClipboard(event.clipboardData);
      if (!looksTabular(snapshot) && !snapshot.files.length && !snapshot.text) return;

      const cell = host.querySelector('.sh-cell.is-active');

      // 单格：图片 / 纯文本 —— 保持「覆盖这一格」的原语义
      if (!looksTabular(snapshot)) {
        if (!cell) return;
        const field = state.fields.find(item => item.key === cell.dataset.key);
        const row = state.rows.find(item => String(item.id) === String(cell.dataset.row));
        if (!field || !row) return;
        event.preventDefault();
        applyPastedContent(field, row, cell, snapshot);
        return;
      }

      const model = parseClipboardPayload(snapshot);
      if (!model.rows.length) return;
      event.preventDefault();

      const cols = visibleOf(state.fields);
      const anchorC = cell ? Number(cell.dataset.col) : -1;
      const fits = cell && state.rows.length && state.fields.length
        && !Number.isNaN(anchorC) && anchorC >= 0
        && model.cols <= cols.length - anchorC;
      if (fits) { pasteModelAt(cell, model); return; }

      openBlockImport(snapshot);
    }, true);

    // 搜索：只重建表格行，不重建整个页面。
    // 之前每次按键都重渲染整页，输入框被换掉 —— 中文输入法正在组词时会被直接打断，
    // 表现就是「拼音打不进去，只能出英文」。
    let searchTimer = null;
    let composing = false;

    const applySearch = value => {
      state.search = String(value || '').trim();
      // 选区存的是「筛选后列表里的下标」，筛完就不指原来那些行了。
      // 不清掉的话高亮会留在屏幕上，而实际指向的行已经换了一批。
      clearSelection();
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
