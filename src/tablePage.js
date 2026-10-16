// 「记录表格」页（设计稿：表格视图 / 就地编辑 / 列头字段菜单）。
//
// 行 = logs 表的一条工作记录；列 = field_def 表里 entity='log' 的字段定义。
// 数据访问通过 setTableAdapter 注入（main.js 注入真 adapter；
// _debug/ui-review.html 壳绕过 Tauri 直接调用 renderTable 渲染演示数据）。
//
// 本模块顶层只依赖 fieldTypes.js / htmlUtils.js（均零依赖），
// 不能在顶层 import data.js —— 否则调试壳（无 __TAURI__）无法加载本模块。

import { escapeHtml } from './htmlUtils.js';
import {
  FIELD_TYPE_ORDER,
  FIELD_TYPE_LABELS,
  renderFieldIcon,
  renderCell,
  openCellEditor,
} from './fieldTypes.js';

const TABLE_ENTITY = 'log';
const DEFAULT_TAG = '未分类';
const ADD_COL_WIDTH = 44;

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

function widthOf(field) {
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

async function refresh() {
  const logs = await adapter.dbQuery('SELECT * FROM logs ORDER BY date DESC, time DESC, id DESC');
  rows = Array.isArray(logs) ? logs : [];
  await loadOptionCache();
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
  };
}

function buildHeadHtml(visibleFields) {
  const cells = visibleFields.map(field => `
    <th class="wr-table-th" data-key="${escapeHtml(field.key)}">
      <button type="button" class="wr-th-btn" data-key="${escapeHtml(field.key)}" aria-haspopup="true" aria-expanded="false">
        ${renderFieldIcon(field.type)}
        <span class="wr-th-label">${escapeHtml(field.label)}</span>
      </button>
    </th>`).join('');
  return `<tr>${cells}<th class="wr-table-th wr-table-th-add">
    <button type="button" class="wr-th-add-btn" aria-label="添加字段">＋</button>
  </th></tr>`;
}

function buildRowHtml(row, visibleFields) {
  const cells = visibleFields.map(field => {
    const value = readFieldValue(field, row);
    return `<td class="wr-table-td wr-table-td-${escapeHtml(field.key.replace('.', '-'))}">
      <div class="wr-cell" data-key="${escapeHtml(field.key)}" data-id="${escapeHtml(row.id)}">${renderCell(field, value, cellCtxFor(field, row))}</div>
    </td>`;
  }).join('');
  return `<tr class="wr-table-row" data-id="${escapeHtml(row.id)}">${cells}<td class="wr-table-td wr-table-td-add"></td></tr>`;
}

function buildEmptyHtml(colSpan) {
  return `<tr class="wr-table-empty-row"><td colspan="${colSpan}">
    <div class="wr-table-empty">还没有记录。点「＋ 新建记录」写下第一条。</div>
  </td></tr>`;
}

// 渲染入口（壳内也直接调用本函数渲染演示数据；
// 传入的数据同步为模块状态，使点击编辑在壳内同样可用）
export function renderTable(rootEl, data = {}) {
  if (!rootEl) return;
  if (data.fields) fields = data.fields;
  if (data.rows) rows = data.rows;
  if (data.optionCache) optionCache = data.optionCache;

  const useFields = fields;
  const useRows = rows;

  const visibleFields = useFields.filter(field => Number(field.visible) !== 0);
  // 列宽用百分比（基准权重见 DEFAULT_WIDTHS）：
  // table-layout:fixed 下 px 列宽之和是表格的硬下限，会导致容器窄时无法压缩列；
  // 百分比则随表格宽度（100% 或 min-width:900px）等比缩放。
  const totalWeight = visibleFields.reduce((sum, field) => sum + widthOf(field), 0) + ADD_COL_WIDTH;
  const colgroup = [
    ...visibleFields.map(field => `<col style="width:${((widthOf(field) / totalWeight) * 100).toFixed(3)}%" />`),
    `<col style="width:${((ADD_COL_WIDTH / totalWeight) * 100).toFixed(3)}%" />`,
  ].join('');

  const tbody = useRows.length
    ? useRows.map(row => buildRowHtml(row, visibleFields)).join('')
    : buildEmptyHtml(visibleFields.length + 1);

  rootEl.innerHTML = `
    <div class="wr-table-shell">
      <div class="wr-table-scroll">
        <table class="wr-table">
          <colgroup>${colgroup}</colgroup>
          <thead>${buildHeadHtml(visibleFields)}</thead>
          <tbody>${tbody}</tbody>
        </table>
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

function rerenderCell(cellEl, field, row) {
  // inline 输入框开着时不重绘（输入中）；下拉面板挂在 body 上，重绘 cell 内容不受影响
  if (cellEl.querySelector('.ft-inline-input')) return;
  const value = readFieldValue(field, row);
  cellEl.innerHTML = renderCell(field, value, cellCtxFor(field, row));
}

function render() {
  const root = document.getElementById('table-view-root');
  if (!root) return;
  closeTransientEditors();
  renderTable(root, { fields, rows, optionCache });
}

// ==========================================
// 就地编辑
// ==========================================

async function commitCellValue(field, row, cellEl, newValue) {
  if (!adapter) return;
  try {
    await writeFieldValue(field, row, newValue);
    rerenderCell(cellEl, field, row);
  } catch (error) {
    showTableToast(`保存失败：${error?.message || error}`, 'danger');
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

function handleCellClick(cellEl) {
  if (!adapter) return;
  const key = cellEl.dataset.key;
  const rowId = cellEl.dataset.id;
  const field = fields.find(item => item.key === key);
  const row = rows.find(item => String(item.id) === String(rowId));
  if (!field || !row) return;
  const value = readFieldValue(field, row);

  openCellEditor(cellEl, field, value, {
    getOptions: source => sortedOptionsFor(source, row),
    ensureOption: (f, label) => ensureOption(f, label, row),
    commit: next => commitCellValue(field, row, cellEl, next),
    toast: showTableToast,
    placeholder: field.key === 'text' ? '未命名' : undefined,
    onAttachmentEdit: () => showTableToast('附件功能正在开发，稍后接入', 'info'),
  });
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
    panel.innerHTML = `
      <div class="wr-colmenu-main">
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
        ${FIELD_TYPE_ORDER.map(type => `
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
  filter: '筛选：开发中，后续版本提供',
  sort: '排序：开发中，后续版本提供',
};

function notReady(feature) {
  showTableToast(NOT_READY_MESSAGES[feature] || '该功能开发中', 'info');
}

// ==========================================
// 事件绑定（一次性，事件委托）
// ==========================================

function onRootClick(event) {
  const thBtn = event.target.closest('.wr-th-btn');
  if (thBtn) {
    const field = fields.find(item => item.key === thBtn.dataset.key);
    if (field) openColumnMenu(thBtn, field);
    return;
  }
  const addFieldBtn = event.target.closest('.wr-th-add-btn');
  if (addFieldBtn) { addField(); return; }

  const addRowBtn = event.target.closest('.wr-table-addrow');
  if (addRowBtn) { createRecord(); return; }

  const cell = event.target.closest('.wr-cell');
  if (cell) { handleCellClick(cell); return; }
}

export function bindTableEvents(rootEl) {
  if (!rootEl || rootEl.dataset.wrTableBound === '1') return;
  rootEl.dataset.wrTableBound = '1';
  rootEl.addEventListener('click', onRootClick);
}

function bindToolbar() {
  document.getElementById('table-new-record-btn')?.addEventListener('click', createRecord);
  document.getElementById('table-fields-btn')?.addEventListener('click', event => {
    openFieldsPanel(event.currentTarget);
  });
  document.getElementById('table-filter-btn')?.addEventListener('click', () => notReady('filter'));
  document.getElementById('table-sort-btn')?.addEventListener('click', () => notReady('sort'));
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
    bindToolbar();
    bindTableEvents(root);
  }
  try {
    await loadFields();
    await refresh();
  } catch (error) {
    console.error('表格页加载失败:', error);
    showTableToast('表格加载失败，请查看日志', 'danger');
  }
}
