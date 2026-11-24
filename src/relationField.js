// 关联字段（relation）—— 一行可以指向另一张表里的一行（或多行）。
//
// 数据形状只有一种：**数组**。单选也存 `[3]`，不存 `3`。
// 理由：类型从单选改多选是用户的常规操作，值形状跟着变就要写一次数据迁移；
// 而「单选 / 多选」本来只是字段配置（options.multiple），不是两套数据。
//
// 值存在 `record.custom[field.key]` —— 与自定义列同一个位置，两种表都一样
// （预置表的真列只有那 7 个，关联列一定落在 custom 里，见 sheetStore.presetValues）。
//
// 悬空引用（目标行被删 / 权限外 / 跨表删但没清）**不清理也能读**：
// 渲染层把找不到的 id 画成灰色「#12 已删除」，点不动、也不会静默消失。
// 同表引用在删行时会被清掉（recordStore.deleteRecord），跨表只靠这里兜底。

import { escapeHtml } from './htmlUtils.js';
import { placeDropdown } from './dropdownPlace.js';

// 单元格里最多直出几个胶囊，其余收成 +N（与附件列的取法一致）
const MAX_CHIPS = 2;

/** 字段配置：目标表 id + 单选/多选。老数据没有这个配置时给安全默认值。 */
export function relationConfig(field) {
  let config = {};
  if (field && field.options) {
    try {
      config = typeof field.options === 'string' ? JSON.parse(field.options) : field.options;
    } catch (error) {
      config = {};
    }
  }
  const target = Number(config?.targetSheetId);
  return {
    targetSheetId: Number.isInteger(target) && target > 0 ? target : 0,
    multiple: config?.multiple === true,
  };
}

/** 值 → id 数组。脏值（'null' / 0 / 负数 / 小数 / 字符串数字）一律收口。 */
export function normalizeRelationIds(value) {
  const list = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const out = [];
  for (const item of list) {
    const num = Math.trunc(Number(item));
    if (Number.isInteger(num) && num > 0 && !out.includes(num)) out.push(num);
  }
  return out;
}

export function isRelationEmpty(value) {
  return normalizeRelationIds(value).length === 0;
}

/** 某条记录在渲染层能用的样子：{title, deleted}；null = 标题还没查回来。 */
function briefOf(id, ctx) {
  const map = ctx?.relationTitles;
  if (!map || typeof map.get !== 'function') return null;
  return map.get(String(id)) || null;
}

/**
 * 只读渲染。ctx 需要：
 *   relationTitles: Map<id, {title, deleted}>  —— 查不到（含已删）也会有一条
 *   placeholder:    空值时显示的字（与其它类型一致）
 *
 * 「查不到就画 #id」与「查到了但是已删」必须分开：
 * 首帧标题还没到，把每一格都写成「已删除」是最吓人的假信息。
 * listRecordBriefs 保证「每个请求过的 id 都有一条」，所以「没条目」只可能是还没查。
 */
export function renderRelationCell(value, ctx = {}) {
  const ids = normalizeRelationIds(value);
  if (!ids.length) return `<span class="ft-cell-empty">${escapeHtml(ctx.placeholder || '—')}</span>`;

  const chips = ids.slice(0, MAX_CHIPS).map(id => {
    const brief = briefOf(id, ctx);
    if (!brief) {
      // 还没查到：只写 #id。点得动 —— 点进去就知道这条到底在不在。
      return `<span class="ft-rel-chip is-pending" data-rel-open="${id}" title="记录 #${id}">#${id}</span>`;
    }
    if (brief.deleted) {
      return `<span class="ft-rel-chip is-gone" data-rel-open="${id}" title="记录 #${id} 已删除，点开查看">#${id} 已删除</span>`;
    }
    const title = String(brief.title || `#${id}`);
    return `<span class="ft-rel-chip" data-rel-open="${id}" title="${escapeHtml(title)}">${escapeHtml(title)}</span>`;
  }).join('');

  const rest = ids.length - MAX_CHIPS;
  const more = rest > 0 ? `<span class="ft-rel-more" title="${escapeHtml(ids.slice(MAX_CHIPS).join('、'))}">+${rest}</span>` : '';
  return `<span class="ft-rel-list">${chips}${more}</span>`;
}

/** 纯文本（搜索、导出、复制用）：能查到标题就用标题，查不到用 #id。 */
export function relationText(value, ctx = {}) {
  return normalizeRelationIds(value)
    .map(id => String(briefOf(id, ctx)?.title || `#${id}`))
    .join('、');
}

// ==========================================
// 就地编辑：记录选择器
// ==========================================
//
// 与多选下拉同一套外观（.ft-dropdown），差别只有两处：
//   ① 列表内容是「另一张表里的行」，不是选项；
//   ② 多选是「点一次改一次、面板不关」，单选是「点完即关」。
// 目标行可能很多，所以列表自带搜索；搜索只过滤标题，不打库（数据一次性取回）。

/**
 * @param {HTMLElement} cellEl
 * @param {object} field
 * @param {*} value
 * @param {object} actions
 *   loadTargets() → Promise<Array<{id,title}>>   目标表里的行（不含已删除）
 *   commit(ids)   → Promise<void>
 *   onSettled()   面板关掉后把焦点还给格子
 *   targetName    目标表名（面板标题里写一句「来自 X」）
 */
export function openRelationPicker(cellEl, field, value, actions = {}) {
  const config = relationConfig(field);
  const panel = document.createElement('div');
  panel.className = 'ft-dropdown ft-relpicker';
  panel.innerHTML = `
    <div class="ft-dropdown-search"><input type="text" placeholder="搜索记录" spellcheck="false" /></div>
    <div class="ft-dropdown-list" role="listbox"><div class="ft-dropdown-empty">加载中…</div></div>
  `;
  document.body.appendChild(panel);
  cellEl.classList.add('ft-cell-editing');

  const searchInput = panel.querySelector('.ft-dropdown-search input');
  const listEl = panel.querySelector('.ft-dropdown-list');

  let selected = normalizeRelationIds(value);
  let candidates = [];
  let keyword = '';
  let closed = false;

  const place = () => placeDropdown(panel, cellEl, { minWidth: 240 });

  const close = () => {
    if (closed) return;
    closed = true;
    panel.remove();
    cellEl.classList.remove('ft-cell-editing');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    actions.onSettled?.();
  };

  const commit = () => {
    Promise.resolve(actions.commit?.([...selected])).catch(() => {});
  };

  const renderList = () => {
    const list = candidates.filter(item => !keyword || item.title.toLowerCase().includes(keyword));
    if (!list.length) {
      const text = candidates.length ? '没有匹配的记录' : '这张表里还没有别的行';
      listEl.innerHTML = `<div class="ft-dropdown-empty">${text}</div>`;
      place();
      return;
    }
    listEl.innerHTML = list.map(item => {
      const active = selected.includes(item.id);
      return `<button type="button" class="ft-option ft-relopt${active ? ' is-active' : ''}" data-rel-id="${item.id}" role="option" aria-selected="${active}">
        <span class="ft-relopt-dot${active ? ' is-on' : ''}">${active ? '<svg class="wr-icon" aria-hidden="true"><use href="#ic-check"/></svg>' : ''}</span>
        <span class="ft-option-label">${escapeHtml(item.title)}</span>
      </button>`;
    }).join('');
    place();
  };

  const pick = id => {
    if (config.multiple) {
      selected = selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id];
      renderList();
      commit();
      return;
    }
    selected = [id];
    commit();
    close();
  };

  listEl.addEventListener('click', event => {
    const btn = event.target.closest('[data-rel-id]');
    if (!btn) return;
    pick(Number(btn.dataset.relId));
  });

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      keyword = searchInput.value.trim().toLowerCase();
      renderList();
    });
    searchInput.addEventListener('keydown', event => {
      // 输入法组词中的回车是选词，不是「选第一条」
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        const first = listEl.querySelector('[data-rel-id]');
        if (first) pick(Number(first.dataset.relId));
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
  window.addEventListener('resize', place);

  place();
  renderList();
  searchInput?.focus();

  Promise.resolve(actions.loadTargets?.()).then(list => {
    if (closed) return;
    candidates = Array.isArray(list) ? list : [];
    renderList();
    searchInput?.focus();
  }).catch(() => {
    if (closed) return;
    listEl.innerHTML = '<div class="ft-dropdown-empty">目标表读取失败</div>';
    place();
  });
}
