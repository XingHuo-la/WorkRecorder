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
export const FIELD_TYPE_ORDER = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'attachment'];

export const FIELD_TYPE_LABELS = {
  text: '文本',
  number: '数字',
  select: '单选',
  multi_select: '多选',
  date: '日期',
  checkbox: '复选框',
  attachment: '图片 / 附件',
};

const TYPE_ICON_IDS = {
  text: 'ic-type-text',
  number: 'ic-type-number',
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

// 中文输入法正在组词时按回车，是「选词」不是「提交」。
// Chrome/WebView2 会把这类按键报成 keyCode 229 / isComposing=true，
// 不拦掉就会出现「拼音还没选完，编辑器就把半截文字存了并关掉」。
export function isImeKey(event) {
  return event.isComposing === true || event.keyCode === 229;
}

// 带 tone 的选项用主题令牌（跟随主题换色）；无 tone 走 hash 色板。
// v1.2 白板风格：状态 tone 改用粉彩 pill 配色 token（--pill-*，底/字成对，
// 见 themes.json 每套主题的 pill-yellow/-green/-blue 与各自 -ink）。
const TONE_VARS = {
  muted: 'var(--text-muted)',
  doing: 'var(--pill-yellow)',
  done: 'var(--pill-green)',
  inbox: 'var(--pill-blue)',
};

// 粉彩 pill 的底色 token（--pill-*）与配字 token（--pill-*-ink）在 themes.json 里成对存在。
// inline style 只声明 --pill（既有契约不动）；当底色恰好是 pill token 时，
// 顺带把 ink 一起带上，供 styles.css 设计层 10 的 color 优先取用 ——
// 粉彩底上用主题色 color-mix 出来的文字在浅色主题下对比度不够，必须跟 ink。
function pillInkVar(color) {
  if (typeof color !== 'string') return '';
  const match = /^var\(--(pill-[a-z0-9-]+)\)$/.exec(color.trim());
  return match ? `var(--${match[1]}-ink)` : '';
}

// 用户自选色（#rrggbb）上没有现成的 ink token，得自己算一个：
// 深底白字、亮底深字。不能一律用白字 —— 黄 / 亮青这类底色上白字读不出来。
// 也不用 CSS 的 color-contrast()（WebView2 版本不可控），按 WCAG 相对亮度
// 一刀切，0.42 是实测几条常用色板的分界：橙 #fb923c(0.414) 留白字，
// 黄 #facc15(0.636) / 亮绿 #4ade80(0.553) / 青 #22d3ee(0.531) 转深字。
function readableInk(hex) {
  const num = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(num >> 16) & 255, (num >> 8) & 255, num & 255].map(value => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.42 ? '#1f2328' : '#ffffff';
}

// 把底色与 ink 拼进 inline style。ink 为空串时输出与旧版完全一致。
// solid = 表格语境：底色是用户显式配的 hex，要画成实心色块，
// 所以顺带算一个可读的 ink（见 styles-v5.css 里 .ft-pill.is-solid）。
function pillStyle(color, solid = false) {
  const ink = pillInkVar(color) || (solid && /^#[0-9a-f]{6}$/i.test(color) ? readableInk(color) : '');
  return ink ? `--pill:${color};--pill-ink:${ink}` : `--pill:${color}`;
}

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

function renderPill(label, color, extraClass = '', solid = false) {
  // 颜色会拼进 inline style，必须限定成「十六进制色 / 主题变量」两种形态，
  // 否则一条脏数据就能往 style 里塞任意声明。
  const safe = typeof color === 'string' && /^(#[0-9a-f]{6}|var\(--[a-z0-9-]+\))$/i.test(color)
    ? color
    : optionColor(label);
  const classes = `ft-pill${extraClass ? ` ${extraClass}` : ''}${solid ? ' is-solid' : ''}`;
  return `<span class="${classes}" style="${pillStyle(safe, solid)}">${escapeHtml(label)}</span>`;
}

// 「用户在图表面板里给这个选项配过颜色」——用于区分「用户指定的色」和
// 「按文案 hash 出来的兜底色」。两者在表格里都上色，但只有前者是实心饱和块。
function hasExplicitColor(option) {
  return typeof option?.color === 'string' && /^#[0-9a-f]{6}$/i.test(option.color);
}

function selectColor(option) {
  // 选项自带颜色优先（用户在图表面板里配的），其次是内置 tone，最后按值取稳定色。
  if (option.color) return option.color;
  if (option.tone && TONE_VARS[option.tone]) return TONE_VARS[option.tone];
  return optionColor(option.value ?? option.label);
}

// ctx.solidPill = 「这个值要用彩色标签画」。
// 名字是历史包袱（最早只在表格里用），现在覆盖三处：表格单元格、字段面板预览、
// 记录详情抽屉 —— 同一个值在这几处必须同色，否则用户会以为是两条数据。
// 留空的（卡片、看板、视图列表）仍是安静文字。
function renderSelectCell(field, value, ctx) {
  if (value == null || value === '') return renderEmpty(ctx);
  const option = resolveOption(field, String(value), ctx);
  const colored = ctx?.solidPill === true;

  // 带 tone 的选项（内置状态类字段）默认渲染为「圆点 + 文字」——
  // 但要上色时它也得是一块看得见的颜色：预置表的「状态」走的就是 tone，
  // 全用圆点的话同一张表里「我配了色的列」和「内置状态列」长得像两个产品。
  // 所以上色语境下 tone 交给 pill，底色取主题粉彩（--pill-*），
  // 字色取配对的 -ink —— 深色主题下这对 token 会自动换成半透明底 + 亮字。
  if (option.tone && TONE_VARS[option.tone]) {
    if (colored) return renderPill(option.label, TONE_VARS[option.tone], '', true);
    // 状态 = 圆点（粉彩底色）+ 文字（ink，深浅主题都可读，见设计层 10）
    return `<span class="ft-status" style="${pillStyle(TONE_VARS[option.tone])}"><span class="ft-status-dot"></span>${escapeHtml(option.label)}</span>`;
  }

  // 上色时的三层强弱：用户配的色 → 实心饱和块；没配色的 → hash 稳定色淡底标签。
  // 淡底这一档不能省：预置表的「主分类」来自标签库（tags 表里根本没有颜色列），
  // 全是灰字就等于没有分类信息，v4 之前本来就是靠这层淡色区分的。
  if (colored) {
    return hasExplicitColor(option)
      ? renderPill(option.label, option.color, '', true)
      : renderPill(option.label, selectColor(option), 'is-tinted');
  }
  // 卡片 / 看板 / 视图列表保持 v4 的安静基调，不跟着变彩色。
  return renderPill(option.label, selectColor(option));
}

function renderMultiSelectCell(field, value, ctx) {
  const values = normalizeMulti(value);
  if (!values.length) return renderEmpty(ctx);
  const colored = ctx?.solidPill === true;
  return `<span class="ft-pill-group">${values
    .map(item => {
      const option = resolveOption(field, item, ctx);
      // 多选里混着 tone 选项也要上色，判断与单选同源
      const solid = colored && (hasExplicitColor(option) || Boolean(option.tone && TONE_VARS[option.tone]));
      const extra = solid ? '' : colored ? 'is-tinted' : '';
      return renderPill(option.label, selectColor(option), extra, solid);
    })
    .join('')}</span>`;
}

// 日期字段的精度存在字段配置里：{ dateOnly: true } 表示只到日。
export function isDateOnly(field) {
  const config = parseFieldConfig(field);
  return config.dateOnly === true;
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

function baseName(path) {
  const text = String(path || '');
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

function renderAttachmentCell(value, ctx) {
  const items = Array.isArray(value) ? value.filter(item => item && item.path) : [];
  if (!items.length) return renderEmpty(ctx);
  // 两类附件：图片（嵌入到数据目录，可缩略预览）与普通文件（只存路径链接）
  const images = items.filter(item => item.kind !== 'file');
  const files = items.filter(item => item.kind === 'file');
  // 有内容的附件格右下角给一个「＋」：点它选来源（剪贴板 / 文件），空格双击也能加
  const addBtn = '<span class="ft-att-add" data-add-att="1" title="添加附件（剪贴板或文件）">＋</span>';
  return `${images.length ? renderImagePart(images) : ''}${files.length ? renderFilePart(files, images.length > 0) : ''}${addBtn}`;
}

function renderImagePart(items) {
  const img = item =>
    `<img class="ft-att-thumb" src="${escapeHtml(toAssetUrl(item.path))}" alt="${escapeHtml(item.name || '附件')}" title="${escapeHtml(item.name || '')}" />`;
  // 单图：铺满列宽按比例展示。
  // 多图（WPS 式折叠）：只完整显示第一张，其余以隐藏 img 折叠在后面（点开灯箱仍能翻全组），
  // 右上角「+N」角标提示还有几张。
  if (items.length === 1) {
    return `<span class="ft-att-group">${img(items[0])}</span>`;
  }
  const rest = items.length - 1;
  return `<span class="ft-att-group is-multi">${img(items[0])}${items
    .slice(1)
    .map(item => `<img class="ft-att-thumb is-folded" src="${escapeHtml(toAssetUrl(item.path))}" alt="${escapeHtml(item.name || '附件')}" title="${escapeHtml(item.name || '')}" />`)
    .join('')}${rest > 0 ? `<span class="ft-att-more">+${rest}</span>` : ''}</span>`;
}

// 普通文件只显示「文件名」小胶囊（不暴露长路径），双击弹三个动作：
// 资源管理器定位 / 默认应用打开 / 选择打开方式
function renderFilePart(files, compact) {
  const max = compact ? 1 : 2;
  const visible = files.slice(0, max);
  const rest = files.length - visible.length;
  const chips = visible
    .map(item => `<span class="ft-file-chip" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name || baseName(item.path))}" title="${escapeHtml(item.name || baseName(item.path))}">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-type-attachment"/></svg>
      <span class="ft-file-name">${escapeHtml(item.name || baseName(item.path))}</span>
    </span>`)
    .join('');
  return `<span class="ft-file-list">${chips}${rest > 0 ? `<span class="ft-file-more">+${rest}</span>` : ''}</span>`;
}

function renderTextCell(value, ctx) {
  // 所见即所得：不 trim、不合并空格，用户敲进去什么样就显示什么样
  const str = String(value ?? '');
  if (!str) return renderEmpty(ctx);
  return `<span class="ft-text">${escapeHtml(str)}</span>`;
}

function formatNumber(value) {
  // 不做千分位、不四舍五入：输入 00123 / 1.50 就按原样显示
  if (value == null || value === '') return '';
  return String(value);
}

function renderNumberCell(value, ctx) {
  if (value == null || value === '') return renderEmpty(ctx);
  const text = formatNumber(value);
  if (!text) return renderEmpty(ctx);
  return `<span class="ft-number">${escapeHtml(text)}</span>`;
}

// 统一入口：按字段类型渲染只读单元格内容
export function renderCell(field, value, ctx = {}) {
  switch (field?.type) {
    case 'number': return renderNumberCell(value, ctx);
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

// 固定行高的行（tr 带 inline height），编辑器的合法高度 = 静态文字块的高度。
//
// 为什么不能靠 CSS 的 max-height:100%：tr 的 height 在表格里只是「下限」，
// td 又是 height:100%（相对于一个由内容决定的 tr 高度），成了循环依赖 ——
// 实测 42px 的行会被 textarea 顶到 139px，同时 max-height 解析不出值而失效，
// 格子里反而冒出原生滚动条（用户截图里的那条灰色横条）。
//
// 固定行高的格子已经把文字 clamp 成 n 行，静态文字块多高、编辑器就该多高：
// 高度一致 ⇒ 行撑不开、首行落点不跳、多出来的内容交给 overflow:hidden。
// 返回 0 表示「不是固定行高」，仍按 field-sizing:content 随内容长高。
function fixedRowEditorHeight(cellEl) {
  if (!cellEl.closest('.sh-row[style]')) return 0;
  // 量「格子里那块内容」的高度：有字时是 .ft-text（固定行高下已被 clamp 成 n 行），
  // 空格子时是占位符那一个 span。不能用整格高度 —— 空格子的占位符是一行居中，
  // 编辑器却会在整格里顶格排，文字照样跳（实测高行空格差 84px）。
  const block = cellEl.firstElementChild;
  const measured = block ? block.getBoundingClientRect().height : 0;
  if (measured > 0) return Math.ceil(measured);
  return 22;
}

// ---- 文本：单行内嵌输入 ----
function openTextEditor(cellEl, field, value, actions) {
  const original = value == null ? '' : String(value);
  markEditing(cellEl);
  // 换行的列用多行输入：单行 input 装不下两三行文字，编辑时只能看到末尾
  const multiline = cellEl.classList.contains('is-wrap');
  // 必须在清空内容之前量：静态文字块的高度正是编辑器的目标高度
  const capHeight = multiline ? fixedRowEditorHeight(cellEl) : 0;
  // 关键：把原内容收起来再放输入框。
  // 否则 flex 布局会把 input 排在原文字后面，变成「文字 + 旁边一个小框」。
  const restore = cellEl.innerHTML;
  cellEl.innerHTML = '';
  const input = document.createElement(multiline ? 'textarea' : 'input');
  if (!multiline) input.type = 'text';
  input.className = `ft-inline-input${multiline ? ' is-multiline' : ''}`;
  input.value = original;
  input.spellcheck = false;
  cellEl.appendChild(input);

  if (capHeight) {
    // 固定行高：把高度钉死，配合 styles-v5 的 .is-row-capped 规则
    input.classList.add('is-row-capped');
    input.style.setProperty('height', `${capHeight}px`, 'important');
    // 盒子只有 n 行高，内容一多就超出可视区。overflow:hidden 时浏览器不一定
    // 替我们把光标滚进视野，所以在末尾输入时手动贴底（Enter 是提交，输入几乎都发生在末尾）。
    input.addEventListener('input', () => {
      if (input.selectionStart === input.value.length) input.scrollTop = input.scrollHeight;
    });
  } else if (multiline) {
    input.rows = 1;
    // 优先用 CSS 的 field-sizing: content（浏览器自己按内容算高度，最准）。
    // 老内核不支持时退回手动量 scrollHeight —— 但要等一帧，否则量到的是空内容。
    const supportsFieldSizing = window.CSS?.supports?.('field-sizing', 'content');
    if (!supportsFieldSizing) {
      const grow = () => {
        // 必须带 important：styles-v5 里换行列的编辑器统一写的是 height:auto !important
        //（为了「文字原地不动」，不能让输入框拉满整格），普通 inline 高度压不过它，
        // 结果就是多行文字永远只显示第一行。
        input.style.setProperty('height', 'auto', 'important');
        input.style.setProperty('height', `${input.scrollHeight}px`, 'important');
      };
      input.addEventListener('input', grow);
      requestAnimationFrame(grow);
      setTimeout(grow, 30);
    }
  }

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const next = input.value;
    input.remove();
    unmarkEditing(cellEl);
    // 任何分支都先把原内容放回去，保存成功后由 commit 重新渲染
    cellEl.innerHTML = restore;
    if (save && next !== original) Promise.resolve(actions.commit(next)).catch(() => {});
    else actions.onSettled?.();
  };

  input.addEventListener('keydown', event => {
    if (isImeKey(event)) return;
    // Shift+Enter 在多行模式里换行，其余情况 Enter 直接提交
    if (event.key === 'Enter' && !(multiline && event.shiftKey)) { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.focus();
  // 进编辑态一律「光标落在文字末尾」，不 select()。
  // 以前单行走 input.select()、换行列走 setSelectionRange(len,len)，于是同一张网格里
  // 出现了两种表现：基础表双击 → 整格文字反白；自建表双击 → 光标在末尾。
  // 用户看到的就是「两套表格」。而且全选反白配上格子的 2px 描边，很像又冒出一个小框。
  // Excel 双击进编辑也不反白，它只把光标放到点上。
  placeCaretAtEnd(input, original);
}

// 光标落到末尾：text/textarea 都吃 setSelectionRange；多行编辑器内容比可视高度高时，
// 光标在末尾而视图还停在第 1 屏，得手动滚到底才能看见自己正在改哪一句。
function placeCaretAtEnd(input, text) {
  const end = String(text ?? '').length;
  try {
    input.setSelectionRange(end, end);
  } catch (error) {
    // number 等不支持选区操作的控件：退化成不选中，只保证有焦点
  }
  if (input.tagName === 'TEXTAREA' && input.scrollHeight > input.clientHeight) {
    input.scrollTop = input.scrollHeight;
  }
}

// ---- 数字：内嵌输入，只接受数字 ----
function openNumberEditor(cellEl, field, value, actions) {
  const original = value == null || value === '' ? '' : String(value);
  markEditing(cellEl);
  const restore = cellEl.innerHTML;
  cellEl.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.className = 'ft-inline-input ft-number-input';
  input.value = original;
  input.spellcheck = false;
  cellEl.appendChild(input);

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const raw = input.value.trim();
    input.remove();
    unmarkEditing(cellEl);
    cellEl.innerHTML = restore;
    if (!save) { actions.onSettled?.(); return; }
    if (raw === '' ) {
      if (original !== '') Promise.resolve(actions.commit('')).catch(() => {});
      else actions.onSettled?.();
      return;
    }
    // 存用户输入的原始字符串（保留 00123 / 1.50 这类写法），只做合法性校验
    const num = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(num)) { actions.onSettled?.(); return; }
    if (raw !== original) Promise.resolve(actions.commit(raw)).catch(() => {});
    else actions.onSettled?.();
  };

  input.addEventListener('input', () => {
    // 只保留数字、小数点和负号，避免输入法塞进奇怪字符
    const cleaned = input.value.replace(/[^\d.\-]/g, '');
    if (cleaned !== input.value) input.value = cleaned;
  });
  input.addEventListener('keydown', event => {
    if (isImeKey(event)) return;
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    else if (event.key === 'Tab') { finish(true); }
  });
  input.addEventListener('blur', () => finish(true));
  input.focus();
  // 与文本格一致：光标在末尾，不整段选中（数字格全选会被误以为「又要重输」）
  placeCaretAtEnd(input, original);
}

// ---- 日期：统一选择器（调用方注入），没注入时退回 flatpickr ----
function openDateEditor(cellEl, field, value, actions) {
  if (typeof actions.openDatePicker === 'function') {
    markEditing(cellEl);
    actions.openDatePicker(cellEl, field, value, {
      dateOnly: isDateOnly(field),
      commit: next => Promise.resolve(actions.commit(next)).catch(() => {}),
      done: () => { unmarkEditing(cellEl); actions.onSettled?.(); },
    });
    return;
  }
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

  // 定位：先量真实高度，再决定朝下还是朝上。
  // 以前是「96 + 选项数 × 32」估的 —— 估得比实际高就无缘无故上翻：
  // 选项被搜索过滤掉一半、标签很短、下面明明还有一整屏空间，它也会翻到单元格上方。
  // 现在按 offsetHeight 量（.ft-dropdown-list 自带 max-height，超出的内部滚动，量出来就是最终高度）。
  panel.style.top = '0px';
  panel.style.visibility = 'hidden';

  function placePanel() {
    const GAP = 4;   // 与单元格留 4px，鼠标不用横跳
    const PAD = 8;   // 离窗口边缘至少 8px
    const anchor = cellEl.getBoundingClientRect();  // 每次现取：面板开着时窗口可能被拉大
    const panelWidth = Math.min(Math.max(anchor.width, 200), window.innerWidth - 16);
    panel.style.width = `${panelWidth}px`;
    panel.style.left = `${Math.max(PAD, Math.min(anchor.left, window.innerWidth - panelWidth - PAD))}px`;
    const below = window.innerHeight - PAD - (anchor.bottom + GAP);
    const above = anchor.top - GAP - PAD;
    // 量之前先放开限高，否则上一次算出的 maxHeight 会把这次的结果算小
    panel.style.maxHeight = '';
    const natural = panel.offsetHeight;
    // 下面放得下就永远朝下；只有下面真放不下、上面更宽裕时才上翻
    const openUp = natural > below && above > below;
    const room = Math.max(120, openUp ? above : below);
    if (natural > room) panel.style.maxHeight = `${room}px`;
    const height = Math.min(natural, room);
    const top = openUp
      ? Math.max(PAD, anchor.top - GAP - height)
      : Math.min(anchor.bottom + GAP, window.innerHeight - PAD - height);
    panel.style.top = `${Math.round(top)}px`;
    panel.style.visibility = '';
  }

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
    window.removeEventListener('resize', placePanel);
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
    // 只有「输入了内容、且没有完全同名选项」时才有可新建的东西。
    // 以前两个分支都 hidden=false，空输入时也挂着一个「＋ 新建选项」的死按钮。
    if (trimmed && !exact) {
      createBtn.hidden = false;
      createBtn.textContent = `＋ 新建「${trimmed}」`;
    } else {
      createBtn.hidden = true;
      createBtn.textContent = '＋ 新建选项';
    }
    // 内容变了高度就变了（搜索过滤 / 新建按钮出现）——每次都重新量一次再贴回单元格，
    // 否则面板会在打字过程中慢慢盖住单元格，或者朝上的方向算错。
    placePanel();
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
      if (isImeKey(event)) return;
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
  // 窗口拉大/缩小后，单元格的视口坐标就变了，面板得跟着贴回去
  window.addEventListener('resize', placePanel);

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
    case 'number': openNumberEditor(cellEl, field, value, actions); break;
    case 'select': openSelectPanel(cellEl, field, value, actions, { multiple: false }); break;
    case 'multi_select': openSelectPanel(cellEl, field, value, actions, { multiple: true }); break;
    case 'date': openDateEditor(cellEl, field, value, actions); break;
    case 'checkbox': openCheckboxEditor(cellEl, field, value, actions); break;
    case 'attachment': openAttachmentEditor(cellEl, field, value, actions); break;
    case 'text':
    default: openTextEditor(cellEl, field, value, actions); break;
  }
}
