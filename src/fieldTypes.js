// 表格视图的「字段类型系统」。
//
// 每个字段类型提供两类能力：
//   renderCell     —— 只读渲染（表格单元格）
//   openCellEditor —— 就地编辑（点击单元格叠加编辑器，提交落库由调用方负责）
//
// 本模块零顶层依赖（只引 htmlUtils），可被 tablePage.js 与调试壳（ui-review.html）
// 复用；数据读写全部走调用方注入的 actions，模块自身不触碰 Tauri / 数据库。

import { escapeHtml } from './htmlUtils.js';

// ==========================================
// 常量与工具
// ==========================================

// 类型展示顺序（列头菜单的「字段类型」面板按此排列，对齐设计稿③）
export const FIELD_TYPE_ORDER = ['text', 'select', 'multi_select', 'date', 'checkbox', 'attachment'];

export const FIELD_TYPE_LABELS = {
  text: '文本',
  select: '单选',
  multi_select: '多选',
  date: '日期',
  checkbox: '复选框',
  attachment: '附件',
};

const TYPE_ICON_IDS = {
  text: 'ic-type-text',
  select: 'ic-type-select',
  multi_select: 'ic-type-multi',
  date: 'ic-type-date',
  checkbox: 'ic-type-checkbox',
  attachment: 'ic-type-attachment',
};

// 选项没有存储自定义色（第一版），按文本 hash 取稳定色：
// 同一选项在任何主题/位置颜色一致，满足「一眼区分」即可。
const OPTION_PALETTE = [
  '#60a5fa', '#4ade80', '#a78bfa', '#facc15',
  '#f472b6', '#22d3ee', '#fb923c', '#94a3b8',
];

export function optionColor(value) {
  const str = String(value ?? '');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return OPTION_PALETTE[hash % OPTION_PALETTE.length];
}

// 带 tone 的选项用主题令牌（跟随主题换色）；无 tone 走 hash 色板。
const TONE_VARS = {
  muted: 'var(--text-muted)',
  doing: 'var(--color-warning)',
  done: 'var(--color-success)',
  inbox: 'var(--color-primary)',
};

// logs.status 的历史值兼容：老数据 'processed' 显示为「已完成」。
// 仅在「值不在选项库里」时兜底，不做数据迁移。
const LEGACY_SELECT_MAP = { processed: 'done' };

export function renderFieldIcon(type) {
  const id = TYPE_ICON_IDS[type] || TYPE_ICON_IDS.text;
  return `<svg class="wr-icon ft-type-icon" aria-hidden="true"><use href="#${id}"/></svg>`;
}

// field.options 存的是 JSON 字符串（来自 field_def.options）
export function parseFieldConfig(field) {
  if (!field || !field.options) return {};
  try {
    const parsed = typeof field.options === 'string' ? JSON.parse(field.options) : field.options;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

// 解析字段的候选项列表 → [{ value, label, tone }]
export function resolveOptions(field, ctx) {
  const config = parseFieldConfig(field);
  if (config.source === 'custom') return Array.isArray(config.options) ? config.options : [];
  if (typeof ctx?.getOptions === 'function') return ctx.getOptions(config.source || 'tags') || [];
  return [];
}

// 值 → 选项（渲染 label / tone；未知值兜底显示原值）
export function resolveOption(field, value, ctx) {
  const options = resolveOptions(field, ctx);
  let option = options.find(item => item.value === value);
  if (!option && LEGACY_SELECT_MAP[value] != null) {
    option = options.find(item => item.value === LEGACY_SELECT_MAP[value]);
  }
  return option || { value, label: value == null ? '' : String(value), tone: '' };
}

// 多选值统一成数组：存储用英文逗号分隔（与 logs.sub_tag 现有数据兼容）
export function normalizeMulti(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return String(value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function serializeMulti(values) {
  return normalizeMulti(values).join(',');
}

function toAssetUrl(path) {
  try {
    if (window.__TAURI__?.core?.convertFileSrc) return window.__TAURI__.core.convertFileSrc(path);
  } catch (error) { /* 非 Tauri 环境（调试壳）直接回退原路径 */ }
  return path || '';
}

function renderEmpty(actions) {
  return `<span class="ft-cell-empty">${escapeHtml(actions?.placeholder || '—')}</span>`;
}

// ==========================================
// 单元格渲染（只读态）
// ==========================================

function renderPill(label, color, extraClass = '') {
  return `<span class="ft-pill${extraClass ? ` ${extraClass}` : ''}" style="--pill:${color}">${escapeHtml(label)}</span>`;
}

function selectColor(option) {
  if (option.tone && TONE_VARS[option.tone]) return TONE_VARS[option.tone];
  return optionColor(option.value ?? option.label);
}

function renderSelectCell(field, value, ctx) {
  if (value == null || value === '') return renderEmpty(ctx);
  const option = resolveOption(field, String(value), ctx);
  // 带 tone 的选项（内置状态类字段）渲染为「圆点 + 文字」；
  // 标签库来源的选项渲染为 pill —— 对齐设计稿①的状态列与主分类列。
  if (option.tone && TONE_VARS[option.tone]) {
    return `<span class="ft-status" style="--pill:${TONE_VARS[option.tone]}"><span class="ft-status-dot"></span>${escapeHtml(option.label)}</span>`;
  }
  return renderPill(option.label, selectColor(option));
}

function renderMultiSelectCell(field, value, ctx) {
  const values = normalizeMulti(value);
  if (!values.length) return renderEmpty(ctx);
  return `<span class="ft-pill-group">${values
    .map(item => {
      const option = resolveOption(field, item, ctx);
      return renderPill(option.label, selectColor(option));
    })
    .join('')}</span>`;
}

function renderDateCell(value, ctx) {
  const str = String(value ?? '').trim();
  if (!str) return renderEmpty(ctx);
  const [datePart, timePart] = str.split(' ');
  const shortDate = datePart && datePart.length >= 10 ? datePart.slice(5) : datePart;
  const shortTime = timePart ? timePart.slice(0, 5) : '';
  return `<span class="ft-date" title="${escapeHtml(str)}">${escapeHtml(shortDate)}${shortTime ? ` ${escapeHtml(shortTime)}` : ''}</span>`;
}

function renderCheckboxCell(value, ctx) {
  const checked = value === true || value === 1 || value === '1' || value === 'true';
  return `<span class="ft-checkbox${checked ? ' is-checked' : ''}" role="checkbox" aria-checked="${checked}">${
    checked
      ? '<svg class="wr-icon" aria-hidden="true"><use href="#ic-check"/></svg>'
      : ''
  }</span>`;
}

function renderAttachmentCell(value, ctx) {
  const items = Array.isArray(value) ? value.filter(item => item && item.path) : [];
  if (!items.length) return renderEmpty(ctx);
  const visible = items.slice(0, 3);
  const rest = items.length - visible.length;
  const thumbs = visible
    .map(item => `<img class="ft-att-thumb" src="${escapeHtml(toAssetUrl(item.path))}" alt="${escapeHtml(item.name || '附件')}" title="${escapeHtml(item.name || '')}" />`)
    .join('');
  return `<span class="ft-att-group">${thumbs}${rest > 0 ? `<span class="ft-att-more">+${rest}</span>` : ''}</span>`;
}

function renderTextCell(value, ctx) {
  const str = String(value ?? '').trim();
  if (!str) return renderEmpty(ctx);
  return `<span class="ft-text">${escapeHtml(str)}</span>`;
}

// 统一入口：按字段类型渲染只读单元格内容
export function renderCell(field, value, ctx = {}) {
  switch (field?.type) {
    case 'select': return renderSelectCell(field, value, ctx);
    case 'multi_select': return renderMultiSelectCell(field, value, ctx);
    case 'date': return renderDateCell(value, ctx);
    case 'checkbox': return renderCheckboxCell(value, ctx);
    case 'attachment': return renderAttachmentCell(value, ctx);
    case 'text':
    default: return renderTextCell(value, ctx);
  }
}

// ==========================================
// 就地编辑
// ==========================================

function markEditing(cellEl) {
  cellEl.classList.add('ft-cell-editing');
}

function unmarkEditing(cellEl) {
  cellEl.classList.remove('ft-cell-editing');
}

// ---- 文本：单行内嵌输入 ----
function openTextEditor(cellEl, field, value, actions) {
  const original = value == null ? '' : String(value);
  markEditing(cellEl);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ft-inline-input';
  input.value = original;
  input.spellcheck = false;
  cellEl.appendChild(input);

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const next = input.value;
    input.remove();
    unmarkEditing(cellEl);
    if (save && next !== original) Promise.resolve(actions.commit(next)).catch(() => {});
    else actions.onSettled?.();
  };

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.focus();
  input.select();
}

// ---- 日期：flatpickr 内嵌 ----
function openDateEditor(cellEl, field, value, actions) {
  if (!window.flatpickr) return;
  const original = String(value ?? '').trim();
  markEditing(cellEl);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ft-inline-input ft-date-input';
  input.value = original;
  cellEl.appendChild(input);

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const next = input.value;
    try { picker?.destroy(); } catch (error) { /* 忽略 */ }
    input.remove();
    unmarkEditing(cellEl);
    if (save && next !== original) Promise.resolve(actions.commit(next)).catch(() => {});
    else actions.onSettled?.();
  };

  const picker = window.flatpickr(input, {
    enableTime: true,
    time_24hr: true,
    dateFormat: 'Y-m-d H:i',
    minuteIncrement: 5,
    defaultDate: original || null,
    locale: window.flatpickr.l10ns?.zh || 'default',
    onClose: (_dates, valueStr) => {
      if (valueStr) input.value = valueStr;
      finish(true);
    },
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  picker.open();
}

// ---- 复选框：点击切换 ----
function openCheckboxEditor(cellEl, field, value, actions) {
  const checked = !(value === true || value === 1 || value === '1' || value === 'true');
  Promise.resolve(actions.commit(checked)).catch(() => {});
}

// ---- 选项下拉面板（单选 / 多选共用，对齐设计稿②）----
function openSelectPanel(cellEl, field, value, actions, { multiple = false } = {}) {
  const options = resolveOptions(field, actions);
  const searchable = true;

  const panel = document.createElement('div');
  panel.className = 'ft-dropdown';
  panel.innerHTML = `
    ${searchable ? '<div class="ft-dropdown-search"><input type="text" placeholder="搜索或新建选项" spellcheck="false" /></div>' : ''}
    <div class="ft-dropdown-list" role="listbox"></div>
    <button type="button" class="ft-dropdown-create" hidden></button>
  `;
  document.body.appendChild(panel);
  markEditing(cellEl);

  const searchInput = panel.querySelector('.ft-dropdown-search input');
  const listEl = panel.querySelector('.ft-dropdown-list');
  const createBtn = panel.querySelector('.ft-dropdown-create');

  // 定位：优先贴在单元格下方，空间不足时上翻
  const rect = cellEl.getBoundingClientRect();
  const panelWidth = Math.max(rect.width, 200);
  panel.style.width = `${panelWidth}px`;
  const estimatedHeight = Math.min(280, 96 + options.length * 32);
  let top = rect.bottom + 4;
  if (top + estimatedHeight > window.innerHeight - 8) {
    top = Math.max(8, rect.top - estimatedHeight - 4);
  }
  panel.style.left = `${Math.min(rect.left, window.innerWidth - panelWidth - 8)}px`;
  panel.style.top = `${top}px`;

  let selectedValues = multiple ? normalizeMulti(value) : [];
  let singleValue = multiple ? '' : String(value ?? '');
  let keyword = '';
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    panel.remove();
    unmarkEditing(cellEl);
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    actions.onSettled?.();
  };

  const commitMulti = () => {
    const next = serializeMulti(selectedValues);
    Promise.resolve(actions.commit(next)).catch(() => {});
  };

  const selectSingle = nextValue => {
    if (closed) return;
    const next = String(nextValue ?? '');
    if (next !== singleValue) {
      singleValue = next;
      Promise.resolve(actions.commit(next)).catch(() => {});
    }
    close();
  };

  const toggleMulti = nextValue => {
    const target = String(nextValue);
    if (selectedValues.includes(target)) selectedValues = selectedValues.filter(item => item !== target);
    else selectedValues = [...selectedValues, target];
    renderList();
    commitMulti();
  };

  const renderList = () => {
    const filtered = options.filter(item => !keyword || String(item.label).toLowerCase().includes(keyword));
    if (!filtered.length) {
      listEl.innerHTML = '<div class="ft-dropdown-empty">没有匹配的选项</div>';
    } else {
      listEl.innerHTML = filtered.map(item => {
        const active = multiple ? selectedValues.includes(String(item.value)) : String(item.value) === singleValue;
        return `<button type="button" class="ft-option${active ? ' is-active' : ''}" data-value="${escapeHtml(item.value)}" role="option" aria-selected="${active}">
          <span class="ft-option-dot" style="--pill:${selectColor(item)}"></span>
          <span class="ft-option-label">${escapeHtml(item.label)}</span>
          ${active ? '<svg class="wr-icon ft-option-check" aria-hidden="true"><use href="#ic-check"/></svg>' : ''}
        </button>`;
      }).join('');
    }
    const trimmed = keyword.trim();
    const exact = options.some(item => String(item.label).toLowerCase() === trimmed.toLowerCase());
    if (trimmed && !exact) {
      createBtn.hidden = false;
      createBtn.textContent = `＋ 新建「${trimmed}」`;
    } else {
      createBtn.hidden = false;
      createBtn.textContent = '＋ 新建选项';
    }
  };

  listEl.addEventListener('click', event => {
    const optionBtn = event.target.closest('.ft-option');
    if (!optionBtn) return;
    if (multiple) toggleMulti(optionBtn.dataset.value);
    else selectSingle(optionBtn.dataset.value);
  });

  createBtn.addEventListener('click', async () => {
    const label = keyword.trim();
    if (!label) {
      searchInput?.focus();
      return;
    }
    createBtn.disabled = true;
    try {
      const created = await actions.ensureOption(field, label);
      const createdValue = created && created.value != null ? created.value : label;
      if (multiple) {
        // 选项库变了，刷新列表
        options.push({ value: createdValue, label, tone: '' });
        toggleMulti(createdValue);
        keyword = '';
        if (searchInput) searchInput.value = '';
        renderList();
      } else {
        // 单选：新建即选中并关闭
        options.push({ value: createdValue, label, tone: '' });
        selectSingle(createdValue);
      }
    } catch (error) {
      actions.toast?.('新建选项失败');
    } finally {
      createBtn.disabled = false;
    }
  });

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      keyword = searchInput.value.trim().toLowerCase();
      renderList();
    });
    searchInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const first = listEl.querySelector('.ft-option');
        if (first) {
          if (multiple) toggleMulti(first.dataset.value);
          else selectSingle(first.dataset.value);
        } else if (keyword.trim()) {
          createBtn.click();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
  }

  const onOutside = event => {
    if (!panel.contains(event.target) && !cellEl.contains(event.target)) close();
  };
  const onKey = event => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);

  renderList();
  searchInput?.focus();
}

// ---- 附件：Phase 3 接入上传，这里先提供入口回调 ----
function openAttachmentEditor(cellEl, field, value, actions) {
  actions.onAttachmentEdit?.(cellEl, field, value);
}

// ==========================================
// 分发入口
// ==========================================

export function openCellEditor(cellEl, field, value, actions) {
  if (!cellEl || cellEl.querySelector('.ft-inline-input, .ft-dropdown')) return;
  if (cellEl.classList.contains('ft-cell-editing')) return;
  switch (field?.type) {
    case 'select': openSelectPanel(cellEl, field, value, actions, { multiple: false }); break;
    case 'multi_select': openSelectPanel(cellEl, field, value, actions, { multiple: true }); break;
    case 'date': openDateEditor(cellEl, field, value, actions); break;
    case 'checkbox': openCheckboxEditor(cellEl, field, value, actions); break;
    case 'attachment': openAttachmentEditor(cellEl, field, value, actions); break;
    case 'text':
    default: openTextEditor(cellEl, field, value, actions); break;
  }
}
