// 浮动层：列头菜单 / 字段面板 / 筛选排序 / 记录详情抽屉。
//
// 统一节奏：所有浮层从 openPopover / openDrawer 出生，
// 由 closeAllPanels 统一收尾，保证任意时刻最多一层，不会叠成三明治。

import { escapeHtml } from './htmlUtils.js';
import {
  FIELD_TYPE_ORDER,
  FIELD_TYPE_LABELS,
  renderFieldIcon,
  renderCell,
  optionColor,
} from './fieldTypes.js';

let activePanel = null; // { kind, el, scrim, onOutside, onKey, onClose }

export function closeAllPanels() {
  if (!activePanel) return;
  const { el, scrim, onOutside, onKey, onClose } = activePanel;
  activePanel = null;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  scrim?.remove();
  el?.remove();
  onClose?.();
}

export function hasOpenPanel() {
  return Boolean(activePanel);
}

// 给外部自建浮层（如图片面板）接入同一套「同时只开一层」的收尾逻辑。
export function registerActivePanel(entry) {
  activePanel = {
    kind: 'custom',
    el: entry.el,
    scrim: entry.scrim || null,
    onOutside: entry.onOutside,
    onKey: entry.onKey,
    onClose: entry.onClose,
  };
}

function place(el, rect, { align = 'left', width = 220 } = {}) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth || width;
  const h = el.offsetHeight || 220;
  let left = align === 'right' ? rect.right - w : rect.left;
  left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8));
  let top = rect.bottom + 6;
  if (top + h > vh - 8) top = Math.max(8, rect.top - h - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// ==========================================
// 浮层基座
// ==========================================

export function openPopover(anchor, className, html, options = {}) {
  closeAllPanels();
  const anchorEl = anchor?.nodeType === 1 ? anchor : null;
  const rect = anchorEl ? anchorEl.getBoundingClientRect() : options.rect;
  if (!rect) return null;

  const el = document.createElement('div');
  el.className = `sh-pop ${className}`.trim();
  el.innerHTML = html;
  document.body.appendChild(el);
  place(el, rect, { align: options.align, width: options.width });
  anchorEl?.setAttribute?.('aria-expanded', 'true');
  anchorEl?.closest?.('.sh-th')?.classList.add('is-open');

  const onOutside = event => {
    if (!el.contains(event.target) && !anchorEl?.contains(event.target)) closeAllPanels();
  };
  const onKey = event => {
    if (event.key === 'Escape') closeAllPanels();
  };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);

  activePanel = {
    kind: 'popover',
    el,
    scrim: null,
    onOutside,
    onKey,
    onClose: () => {
      anchorEl?.setAttribute?.('aria-expanded', 'false');
      anchorEl?.closest?.('.sh-th')?.classList.remove('is-open');
      options.onClose?.();
    },
  };
  return el;
}

export function openDrawer({ title, subtitle = '', width = 396, body, footer = '', onMount, onClose }) {
  closeAllPanels();
  const scrim = document.createElement('div');
  scrim.className = 'sh-scrim';
  const el = document.createElement('aside');
  el.className = 'sh-drawer';
  el.style.width = `${width}px`;
  el.innerHTML = `
    <header class="sh-drawer-head">
      <div class="sh-drawer-titles">
        <div class="sh-drawer-kicker">${escapeHtml(subtitle)}</div>
        <h2 class="sh-drawer-title">${escapeHtml(title)}</h2>
      </div>
      <button type="button" class="sh-icon-btn" data-close aria-label="关闭">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-close"/></svg>
      </button>
    </header>
    <div class="sh-drawer-body"></div>
    ${footer ? `<footer class="sh-drawer-foot">${footer}</footer>` : ''}`;
  el.querySelector('.sh-drawer-body').innerHTML = body;

  document.body.append(scrim, el);
  requestAnimationFrame(() => {
    scrim.classList.add('is-on');
    el.classList.add('is-open');
  });

  const onOutside = event => {
    if (el.contains(event.target)) return;
    // 单元格编辑器（下拉 / 日期日历 / 附件面板 / 灯箱 / 全局弹窗）都挂在 body 上，
    // 点它们不算「点在外面」，否则从抽屉里编辑字段时抽屉会先被关掉。
    if (event.target.closest?.('.ft-dropdown, .flatpickr-calendar, .sh-pop, .sh-dp, .sh-lightbox, .custom-modal-overlay')) return;
    closeAllPanels();
  };
  const onKey = event => {
    if (event.key !== 'Escape') return;
    // Esc 是「退一层」，不是「一次全关」。下列情况把这一下让给里面那层：
    //   · 单元格编辑器开着（抽屉里改字段时按 Esc 想撤掉这一格，不是关掉整条记录）
    //   · 日期选择器 / 下拉 / 灯箱开着（它们各自有 Esc 处理）
    //   · 标题就地改名、饰框改名开着
    // 曾经的表现：在抽屉里编辑任意一格，按一次 Esc 连抽屉一起没了。
    if (document.querySelector(
      '.ft-cell-editing, .ft-inline-input, .sh-dp, .ft-dropdown, .sh-lightbox, .custom-modal-overlay, .rd-title-input, .rd-fieldcfg-rename'
    )) return;
    closeAllPanels();
  };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  el.querySelector('[data-close]')?.addEventListener('click', () => closeAllPanels());
  scrim.addEventListener('mousedown', () => closeAllPanels());

  activePanel = { kind: 'drawer', el, scrim, onOutside, onKey, onClose };
  onMount?.(el);
  return el;
}

// ==========================================
// 列头菜单（设计稿③）
// ==========================================

const MENU_ICONS = {
  edit: '#ic-swap',
  filter: '#ic-filter',
  sort: '#ic-sort',
  left: '#ic-insert-left',
  right: '#ic-insert-right',
  hide: '#ic-eye-off',
  del: '#ic-trash',
};

export function openColumnMenu(anchor, field, handlers = {}) {
  const el = openPopover(anchor, 'sh-colmenu', '', { width: 236 });
  if (!el) return;
  // 本地记一份换行状态：handlers.wrap 是异步写库的，
  // 写完之前 paint 会拿回旧值，表现就是「点了没反应」。
  let wrapState = parseWrap(field);

  const mainView = () => `
    <div class="sh-menu-head">
      <span class="sh-menu-title">${escapeHtml(field.label)}</span>
      <span class="sh-menu-sub">${escapeHtml(FIELD_TYPE_LABELS[field.type] || field.type)}</span>
    </div>
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item" data-act="edit">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-pencil"/></svg>编辑字段
    </button>
    <button type="button" class="sh-menu-item" data-act="left">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-insert-left"/></svg>在左侧插入列
    </button>
    <button type="button" class="sh-menu-item" data-act="right">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-insert-right"/></svg>在右侧插入列
    </button>
    <div class="sh-menu-sep"></div>
    <div class="sh-menu-field">
      <span class="sh-menu-field-label">列宽</span>
      <input type="number" class="sh-menu-field-input" data-width-input min="72" max="640" step="4"
        value="${Number(field.width) || 160}" aria-label="列宽像素" />
      <span class="sh-menu-field-unit">px</span>
      <button type="button" class="sh-menu-field-ok" data-apply-width aria-label="应用列宽">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-check"/></svg>
      </button>
    </div>
    <button type="button" class="sh-menu-item" data-act="autofit">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-swap"/></svg>自适应列宽
    </button>
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item" data-act="filter">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-filter"/></svg>筛选此列
    </button>
    <button type="button" class="sh-menu-item" data-act="sort">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-sort"/></svg>按此列排序
    </button>
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item is-more" data-view="more">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-dots"/></svg>更多
      <svg class="wr-icon sh-menu-arrow" aria-hidden="true"><use href="#ic-chevron-right"/></svg>
    </button>`;

  const moreView = () => {
    const wrapOn = wrapState;
    return `
    <button type="button" class="sh-menu-item is-back" data-view="main">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-chevron-right"/></svg>返回
    </button>
    <div class="sh-menu-sep"></div>
    <div class="sh-menu-label">内容显示</div>
    <div class="sh-menu-seg">
      <button type="button" class="sh-menu-seg-item${wrapOn ? '' : ' is-on'}" data-wrap="0">单行省略</button>
      <button type="button" class="sh-menu-seg-item${wrapOn ? ' is-on' : ''}" data-wrap="1">自动换行</button>
    </div>
    <div class="sh-menu-hint">单行：超出用省略号；换行：行高不足时也会截断加省略号。</div>
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item" data-act="hide">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-eye-off"/></svg>隐藏此列
    </button>
    <button type="button" class="sh-menu-item is-danger" data-act="del">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-trash"/></svg>删除此列
    </button>`;
  };

  const paint = view => {
    el.innerHTML = view === 'more' ? moreView() : mainView();
    const input = el.querySelector('[data-width-input]');
    input?.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      applyWidth();
    });
  };

  const applyWidth = () => {
    const value = Math.max(72, Math.min(640, Number(el.querySelector('[data-width-input]')?.value) || 160));
    closeAllPanels();
    handlers.width?.(value);
  };

  el.addEventListener('click', event => {
    if (event.target.closest('[data-apply-width]')) { applyWidth(); return; }
    const viewBtn = event.target.closest('[data-view]');
    if (viewBtn) { paint(viewBtn.dataset.view); return; }
    const wrapBtn = event.target.closest('[data-wrap]');
    if (wrapBtn) {
      wrapState = wrapBtn.dataset.wrap === '1';
      handlers.wrap?.(wrapState);
      paint('more');
      return;
    }
    const action = event.target.closest('[data-act]')?.dataset.act;
    if (!action) return;
    closeAllPanels();
    handlers[action]?.(field);
  });

  paint('main');
}

function parseWrap(field) {
  try {
    const parsed = field?.options ? JSON.parse(field.options) : null;
    return Boolean(parsed && parsed.wrap);
  } catch (error) {
    return false;
  }
}

// 行菜单：插行 / 行高 / 最适合的行高 / 详情 / 删除
export function openRowMenu(anchor, row, index, handlers = {}) {
  const el = openPopover(anchor, 'sh-rowmenu', `
    <div class="sh-menu-head">
      <span class="sh-menu-title">第 ${index} 条记录</span>
      <span class="sh-menu-sub">行高 ${row.height ? `${row.height} px` : '自动'}</span>
    </div>
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item" data-act="detail">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-pencil"/></svg>打开详情
    </button>
    <button type="button" class="sh-menu-item" data-act="copy">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-copy"/></svg>复制记录
    </button>
    <button type="button" class="sh-menu-item" data-act="paste">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-insert-right"/></svg>粘贴记录
    </button>
    <div class="sh-menu-sep"></div>
    <div class="sh-menu-field">
      <span class="sh-menu-field-label">上方插入</span>
      <input type="number" class="sh-menu-field-input" data-insert-above min="1" max="50" step="1" value="1" aria-label="上方插入行数" />
      <span class="sh-menu-field-unit">行</span>
      <button type="button" class="sh-menu-field-ok" data-do-insert-above aria-label="在上方插入">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-check"/></svg>
      </button>
    </div>
    <div class="sh-menu-field">
      <span class="sh-menu-field-label">下方插入</span>
      <input type="number" class="sh-menu-field-input" data-insert-below min="1" max="50" step="1" value="1" aria-label="下方插入行数" />
      <span class="sh-menu-field-unit">行</span>
      <button type="button" class="sh-menu-field-ok" data-do-insert-below aria-label="在下方插入">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-check"/></svg>
      </button>
    </div>
    <div class="sh-menu-sep"></div>
    <div class="sh-menu-field">
      <span class="sh-menu-field-label">行高</span>
      <input type="number" class="sh-menu-field-input" data-row-height min="28" max="600" step="4"
        value="${Number(row.height) || 42}" aria-label="行高像素" />
      <span class="sh-menu-field-unit">px</span>
      <button type="button" class="sh-menu-field-ok" data-apply-height aria-label="应用行高">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-check"/></svg>
      </button>
    </div>
    <button type="button" class="sh-menu-item" data-act="autofit-row">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-swap"/></svg>最适合的行高
    </button>
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item is-danger" data-act="delete">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-trash"/></svg>删除记录
    </button>`, { width: 236 });
  if (!el) return;

  const readNumber = sel => {
    const input = el.querySelector(sel);
    return Math.max(1, Math.min(50, Number(input?.value) || 1));
  };
  const readHeight = () => {
    const input = el.querySelector('[data-row-height]');
    return Math.max(28, Math.min(600, Number(input?.value) || 42));
  };

  el.querySelectorAll('.sh-menu-field-input').forEach(input => {
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      // 顺序很关键：先把值读出来，再关面板。
      // 反过来的话面板已从 DOM 移除，readHeight() 读到 undefined，永远写回默认值。
      if (input.matches('[data-insert-above]')) { const n = readNumber('[data-insert-above]'); closeAllPanels(); handlers.insertAbove?.(n); }
      else if (input.matches('[data-insert-below]')) { const n = readNumber('[data-insert-below]'); closeAllPanels(); handlers.insertBelow?.(n); }
      else if (input.matches('[data-row-height]')) { const h = readHeight(); closeAllPanels(); handlers.height?.(h); }
    });
  });

  el.addEventListener('click', event => {
    if (event.target.closest('[data-do-insert-above]')) { const n = readNumber('[data-insert-above]'); closeAllPanels(); handlers.insertAbove?.(n); return; }
    if (event.target.closest('[data-do-insert-below]')) { const n = readNumber('[data-insert-below]'); closeAllPanels(); handlers.insertBelow?.(n); return; }
    if (event.target.closest('[data-apply-height]')) { const h = readHeight(); closeAllPanels(); handlers.height?.(h); return; }
    const action = event.target.closest('[data-act]')?.dataset.act;
    if (!action) return;
    closeAllPanels();
    handlers[action]?.(row);
  });
}

// ==========================================
// 单元格右键菜单（参考 WPS：复制/粘贴/编辑/清除/插行/删行）
// ==========================================
export function openCellMenu(anchor, { field, value, hasImages = false, hasItems = false, count = 1 }, handlers = {}) {
  const typeLabel = FIELD_TYPE_LABELS[field.type] || field.type;
  const isAttachment = field.type === 'attachment';
  const el = openPopover(anchor, 'sh-cellmenu', `
    <div class="sh-menu-head">
      <span class="sh-menu-title">${escapeHtml(field.label)}</span>
      <span class="sh-menu-sub">${count > 1 ? `已选 ${count} 格` : escapeHtml(typeLabel)}</span>
    </div>
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item" data-act="copy">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-copy"/></svg>${count > 1 ? `复制 ${count} 格` : '复制内容'}
    </button>
    <button type="button" class="sh-menu-item" data-act="paste">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-insert-right"/></svg>粘贴（覆盖）
    </button>
    <button type="button" class="sh-menu-item" data-act="edit">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-pencil"/></svg>${isAttachment ? (hasItems ? '管理附件…' : '添加附件…') : '编辑内容'}
    </button>
    <button type="button" class="sh-menu-item" data-act="format">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-sliders"/></svg>设置单元格格式…
    </button>
    ${isAttachment && hasImages ? `<button type="button" class="sh-menu-item" data-act="preview">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-search"/></svg>查看大图
    </button>` : ''}
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item" data-act="clear">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-close"/></svg>${count > 1 ? `清空 ${count} 格` : '清空内容'}
    </button>
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item" data-act="insertAbove">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-insert-left"/></svg>上方插入一行
    </button>
    <button type="button" class="sh-menu-item" data-act="insertBelow">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-insert-right"/></svg>下方插入一行
    </button>
    <button type="button" class="sh-menu-item is-danger" data-act="deleteRow">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-trash"/></svg>删除本行
    </button>`, { width: 214 });
  if (!el) return;

  el.addEventListener('click', event => {
    const action = event.target.closest('[data-act]')?.dataset.act;
    if (!action) return;
    closeAllPanels();
    handlers[action]?.();
  });
}

// ==========================================
// 链接文件的动作菜单：定位 / 默认应用 / 打开方式
// ==========================================
export function openFileActionMenu(anchor, { name, path }, handlers = {}) {
  const el = openPopover(anchor, 'sh-filemenu', `
    <div class="sh-menu-head">
      <span class="sh-menu-title">${escapeHtml(name || '链接文件')}</span>
      <span class="sh-menu-sub">仅保存链接</span>
    </div>
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item" data-act="reveal">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-search"/></svg>在资源管理器显示
    </button>
    <button type="button" class="sh-menu-item" data-act="open">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-notebook"/></svg>用默认应用打开
    </button>
    <button type="button" class="sh-menu-item" data-act="openWith">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-sliders"/></svg>选择打开方式…
    </button>`, { width: 232 });
  if (!el) return;

  el.addEventListener('click', event => {
    const action = event.target.closest('[data-act]')?.dataset.act;
    if (!action) return;
    closeAllPanels();
    handlers[action]?.(path);
  });
}

// ==========================================
// 单元格格式面板（底色 / 对齐 / 换行）
// ==========================================const CELL_BG_SWATCHES = ['', '#0f172a', '#1e293b', '#334155', '#7f1d1d', '#14532d', '#1e3a8a', '#4c1d95', '#78350f'];

export function openCellFormatPanel(anchor, { field, columnFormat = {}, cellFormat = {} }, handlers = {}) {
  let merged = { ...columnFormat, ...cellFormat };
  let hasOverride = Object.keys(cellFormat || {}).length > 0;

  const el = openPopover(anchor, 'sh-fmtpanel', `
    <div class="sh-menu-head">
      <span class="sh-menu-title">单元格格式</span>
      <span class="sh-menu-sub">${escapeHtml(field.label)}</span>
    </div>
    <div class="sh-menu-sep"></div>
    <div class="sh-fmt-label">底色</div>
    <div class="sh-fmt-swatches">
      ${CELL_BG_SWATCHES.map(color => `<button type="button" class="sh-fmt-swatch${color ? '' : ' is-none'}" data-bg="${color}" title="${color || '无底色'}"${color ? ` style="--sw:${color}"` : ''}></button>`).join('')}
    </div>
    <div class="sh-fmt-label">水平对齐</div>
    <div class="sh-fmt-row">
      <button type="button" class="sh-fmt-opt" data-h="left">左</button>
      <button type="button" class="sh-fmt-opt" data-h="center">中</button>
      <button type="button" class="sh-fmt-opt" data-h="right">右</button>
    </div>
    <div class="sh-fmt-label">垂直对齐</div>
    <div class="sh-fmt-row">
      <button type="button" class="sh-fmt-opt" data-v="top">上</button>
      <button type="button" class="sh-fmt-opt" data-v="middle">中</button>
      <button type="button" class="sh-fmt-opt" data-v="bottom">下</button>
    </div>
    ${field.type === 'text' ? `<div class="sh-fmt-label">自动换行</div>
    <div class="sh-fmt-row">
      <button type="button" class="sh-fmt-opt" data-wrap="follow">跟随列</button>
      <button type="button" class="sh-fmt-opt" data-wrap="on">开</button>
      <button type="button" class="sh-fmt-opt" data-wrap="off">关</button>
    </div>` : ''}
    <div class="sh-menu-sep"></div>
    <button type="button" class="sh-menu-item" data-fmt="clear">清除本格格式</button>
    <button type="button" class="sh-menu-item" data-fmt="column">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-table"/></svg>应用到整列（默认）
    </button>`, { width: 252 });
  if (!el) return;

  const paint = () => {
    el.querySelectorAll('[data-bg]').forEach(btn => {
      const color = btn.dataset.bg;
      const on = color ? merged.bg === color : !merged.bg;
      btn.classList.toggle('is-on', on);
    });
    el.querySelectorAll('[data-h]').forEach(btn => btn.classList.toggle('is-on', merged.h === btn.dataset.h));
    el.querySelectorAll('[data-v]').forEach(btn => btn.classList.toggle('is-on', merged.v === btn.dataset.v));
    el.querySelectorAll('[data-wrap]').forEach(btn => {
      const key = btn.dataset.wrap;
      const cur = merged.wrap === undefined ? 'follow' : merged.wrap ? 'on' : 'off';
      btn.classList.toggle('is-on', key === cur);
    });
    const clearBtn = el.querySelector('[data-fmt="clear"]');
    if (clearBtn) clearBtn.style.opacity = hasOverride ? '1' : '.45';
  };
  paint();

  el.addEventListener('click', event => {
    const bg = event.target.closest('[data-bg]');
    if (bg) {
      merged = { ...merged, bg: bg.dataset.bg || undefined };
      handlers.set?.({ bg: bg.dataset.bg || undefined });
      paint();
      return;
    }
    const h = event.target.closest('[data-h]');
    if (h) {
      merged = { ...merged, h: h.dataset.h };
      handlers.set?.({ h: h.dataset.h });
      paint();
      return;
    }
    const v = event.target.closest('[data-v]');
    if (v) {
      merged = { ...merged, v: v.dataset.v };
      handlers.set?.({ v: v.dataset.v });
      paint();
      return;
    }
    const w = event.target.closest('[data-wrap]');
    if (w) {
      const mode = w.dataset.wrap;
      const wrap = mode === 'follow' ? undefined : mode === 'on';
      merged = { ...merged, wrap };
      handlers.set?.({ wrap });
      paint();
      return;
    }
    const action = event.target.closest('[data-fmt]')?.dataset.fmt;
    if (action === 'clear') {
      merged = { ...columnFormat };
      // 清掉之后本格已经没有覆盖了，按钮该跟着变灰（以前一直是亮的）
      hasOverride = false;
      handlers.clear?.();
      paint();
      return;
    }
    if (action === 'column') {
      handlers.column?.(merged);
      closeAllPanels();
    }
  });
}

// ==========================================
// 字段面板（设计稿④）
// ==========================================

const COLOR_SWATCHES = ['#60a5fa', '#2fbf71', '#f5a524', '#e5484d', '#a78bfa', '#22d3ee', '#f472b6', '#94a3b8'];

export function openFieldPanel({ field = null, sheetName, onSave, onDelete, onClose }) {
  const isEdit = Boolean(field);
  const config = (() => {
    try {
      const parsed = field?.options ? JSON.parse(field.options) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  })();

  const state = {
    label: field?.label || '',
    type: field?.type || 'text',
    wrap: config.wrap === true,
    dateOnly: config.dateOnly === true,
    options: Array.isArray(config.options) ? config.options.map(item => ({ ...item })) : [],
  };
  if (!state.options.length && (state.type === 'select' || state.type === 'multi_select')) {
    state.options = [
      { value: 'a', label: '选项 A', color: COLOR_SWATCHES[0] },
      { value: 'b', label: '选项 B', color: COLOR_SWATCHES[1] },
    ];
  }

  const drawer = openDrawer({
    title: isEdit ? '编辑字段' : '新建字段',
    subtitle: sheetName ? `${sheetName} · ${isEdit ? '修改会立即生效' : '字段类型决定单元格怎么填'}` : '',
    width: 404,
    body: '<div class="sh-fieldpanel"></div>',
    footer: `
      ${isEdit ? '<button type="button" class="sh-btn is-danger-ghost" data-del>删除字段</button>' : ''}
      <span class="sh-foot-gap"></span>
      <button type="button" class="sh-btn" data-cancel>取消</button>
      <button type="button" class="sh-btn is-primary" data-save>保存字段</button>`,
    onClose,
  });

  const host = drawer.querySelector('.sh-fieldpanel');

  const needsOptions = () => state.type === 'select' || state.type === 'multi_select';

  const paint = () => {
    host.innerHTML = `
      <label class="sh-label">字段名称</label>
      <input type="text" class="sh-input" data-name placeholder="例如：状态" value="${escapeHtml(state.label)}" />

      <label class="sh-label sh-label-gap">字段类型</label>
      <div class="sh-type-grid">
        ${FIELD_TYPE_ORDER.map(
          type => `<button type="button" class="sh-type${type === state.type ? ' is-active' : ''}" data-type="${type}">
            ${renderFieldIcon(type)}<span>${escapeHtml(FIELD_TYPE_LABELS[type])}</span>
          </button>`
        ).join('')}
      </div>

      ${
        state.type === 'text'
          ? `<div class="sh-label sh-label-gap">内容显示</div>
             <div class="sh-seg" data-seg="wrap">
               <button type="button" class="sh-seg-item${state.wrap ? '' : ' is-on'}" data-wrap="0">单行省略</button>
               <button type="button" class="sh-seg-item${state.wrap ? ' is-on' : ''}" data-wrap="1">自动换行</button>
             </div>
             <div class="sh-hint">长文本换行后行高自动撑开；单行则超出时显示省略号。</div>`
          : ''
      }

      ${
        state.type === 'date'
          ? `<div class="sh-label sh-label-gap">日期精度</div>
             <div class="sh-seg" data-seg="date">
               <button type="button" class="sh-seg-item${state.dateOnly ? ' is-on' : ''}" data-dateonly="1">只到日</button>
               <button type="button" class="sh-seg-item${state.dateOnly ? '' : ' is-on'}" data-dateonly="0">到分钟</button>
             </div>
             <div class="sh-hint">「只到日」的列在选择器里不会出现时间输入，也不会存时间。</div>`
          : ''
      }

      ${
        needsOptions()
          ? `<div class="sh-label sh-label-gap">选项 <span class="sh-label-hint">颜色决定单元格标签配色</span></div>
             <div class="sh-options" data-options>
               ${state.options
                 .map(
                   (option, index) => `
                 <div class="sh-option-row" data-index="${index}">
                   <input type="color" class="sh-color" value="${escapeHtml(option.color || optionColor(option.label))}" data-color aria-label="选项颜色" />
                   <input type="text" class="sh-input sh-input-flat" data-option-label value="${escapeHtml(option.label)}" />
                   <button type="button" class="sh-icon-btn" data-remove-option aria-label="删除选项">
                     <svg class="wr-icon" aria-hidden="true"><use href="#ic-trash"/></svg>
                   </button>
                 </div>`
                 )
                 .join('')}
             </div>
             <button type="button" class="sh-add-option" data-add-option>＋ 添加选项</button>`
          : ''
      }

      <div class="sh-label sh-label-gap">预览 · 表格里长这样</div>
      <div class="sh-preview" data-preview></div>`
    ;

    const previewCell = host.querySelector('[data-preview]');
    previewCell.innerHTML = renderCell(previewField(), sampleValue(), { placeholder: '（空）', solidPill: true });
  };

  // 预览要有东西可看：日期给个样例、数字给 42，不然永远是「（空）」
  const previewField = () => ({
    key: 'preview',
    type: state.type,
    options: JSON.stringify({ source: 'custom', options: state.options, dateOnly: state.dateOnly }),
  });

  const sampleValue = () => {
    switch (state.type) {
      case 'date': return state.dateOnly ? '2026-11-10' : '2026-11-10 09:30';
      case 'number': return 42;
      case 'checkbox': return true;
      case 'select':
      case 'multi_select': return state.options[0]?.value ?? '';
      case 'attachment': return [];
      default: return '示例文本';
    }
  };

  const repaintPreview = () => {
    const previewCell = host.querySelector('[data-preview]');
    if (!previewCell) return;
    previewCell.innerHTML = renderCell(previewField(), sampleValue(), { placeholder: '（空）', solidPill: true });
  };

  paint();
  host.querySelector('[data-name]')?.focus();

  host.addEventListener('input', event => {
    const nameInput = event.target.closest('[data-name]');
    if (nameInput) { state.label = nameInput.value; return; }

    const labelInput = event.target.closest('[data-option-label]');
    if (labelInput) {
      const index = Number(labelInput.closest('[data-index]')?.dataset.index);
      if (Number.isInteger(index) && state.options[index]) {
        state.options[index].label = labelInput.value;
        state.options[index].value = state.options[index].value || labelInput.value;
        repaintPreview();
      }
      return;
    }

    const colorInput = event.target.closest('[data-color]');
    if (colorInput) {
      const index = Number(colorInput.closest('[data-index]')?.dataset.index);
      if (Number.isInteger(index) && state.options[index]) {
        state.options[index].color = colorInput.value;
        repaintPreview();
      }
    }
  });

  host.addEventListener('click', event => {
    const wrapBtn = event.target.closest('[data-wrap]');
    if (wrapBtn) {
      state.wrap = wrapBtn.dataset.wrap === '1';
      paint();
      return;
    }
    const dateBtn = event.target.closest('[data-dateonly]');
    if (dateBtn) {
      state.dateOnly = dateBtn.dataset.dateonly === '1';
      paint();
      return;
    }
    const typeBtn = event.target.closest('[data-type]');
    if (typeBtn) {
      state.type = typeBtn.dataset.type;
      if ((state.type === 'select' || state.type === 'multi_select') && !state.options.length) {
        state.options = [
          { value: 'a', label: '选项 A', color: COLOR_SWATCHES[0] },
          { value: 'b', label: '选项 B', color: COLOR_SWATCHES[1] },
        ];
      }
      paint();
      return;
    }
    if (event.target.closest('[data-add-option]')) {
      const label = `选项 ${state.options.length + 1}`;
      state.options.push({
        value: `${label}-${Date.now().toString(36).slice(-4)}`,
        label,
        color: COLOR_SWATCHES[state.options.length % COLOR_SWATCHES.length],
      });
      paint();
      return;
    }
    const removeBtn = event.target.closest('[data-remove-option]');
    if (removeBtn) {
      const index = Number(removeBtn.closest('[data-index]')?.dataset.index);
      if (Number.isInteger(index)) {
        state.options.splice(index, 1);
        paint();
      }
    }
  });

  drawer.querySelector('[data-cancel]')?.addEventListener('click', () => closeAllPanels());
  drawer.querySelector('[data-save]')?.addEventListener('click', () => {
    const label = state.label.trim();
    if (!label) {
      host.querySelector('[data-name]')?.focus();
      return;
    }
    if (needsOptions()) {
      state.options = state.options
        .map((option, index) => ({
          ...option,
          label: String(option.label || '').trim() || `选项 ${index + 1}`,
          value: option.value || `v${index}`,
        }))
        .filter(option => option.label);
    }
    onSave?.({
      label,
      type: state.type,
      options: needsOptions() ? state.options : [],
      wrap: state.type === 'text' ? state.wrap : false,
      dateOnly: state.type === 'date' ? state.dateOnly : false,
    });
    closeAllPanels();
  });
  drawer.querySelector('[data-del]')?.addEventListener('click', () => {
    if (!field) return;
    // 列菜单里的「删除此列」有二次确认，字段面板里原本没有 ——
    // 同一个不可逆动作不能两套标准。
    if (typeof window.showModal !== 'function') {
      Promise.resolve(onDelete?.(field)).then(() => closeAllPanels()).catch(() => closeAllPanels());
      return;
    }
    window.showModal(
      '删除字段',
      `<p style="margin:0;">删除「${escapeHtml(field.label)}」这一列？列里的数据会一起消失，无法撤销。</p>`,
      null,
      async () => {
        try {
          await onDelete?.(field);
        } finally {
          closeAllPanels();
        }
        return true;
      },
      { danger: true, btnText: '删除' }
    );
  });
}

// ==========================================
// 筛选 / 排序
// ==========================================

const OPERATORS = [
  { value: 'contains', label: '包含' },
  { value: 'equals', label: '等于' },
  { value: 'not_equals', label: '不等于' },
  { value: 'empty', label: '为空' },
  { value: 'not_empty', label: '不为空' },
];

export function operatorLabel(value) {
  return OPERATORS.find(item => item.value === value)?.label || value;
}

export function openFilterPanel(anchor, { fields, filters, onApply }) {
  const usable = fields.filter(field => Number(field.visible) !== 0);
  const draft = filters.map(item => ({ ...item }));
  if (!draft.length && usable.length) {
    draft.push({ key: usable[0].key, op: 'contains', value: '' });
  }

  const renderRows = () => draft.map((filter, index) => {
    const field = usable.find(item => item.key === filter.key) || usable[0];
    const options = (() => {
      try {
        const parsed = field?.options ? JSON.parse(field.options) : null;
        return Array.isArray(parsed?.options) ? parsed.options : [];
      } catch (error) { return []; }
    })();
    const needsValue = filter.op !== 'empty' && filter.op !== 'not_empty';
    return `<div class="sh-filter-row" data-index="${index}">
      <select class="sh-select" data-filter-key>
        ${usable.map(item => `<option value="${escapeHtml(item.key)}" ${item.key === filter.key ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
      </select>
      <select class="sh-select sh-select-sm" data-filter-op>
        ${OPERATORS.map(op => `<option value="${op.value}" ${op.value === filter.op ? 'selected' : ''}>${op.label}</option>`).join('')}
      </select>
      ${needsValue
        ? options.length
          ? `<select class="sh-select" data-filter-value>
               <option value="">（任意）</option>
               ${options.map(option => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(filter.value) ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
             </select>`
          : `<input type="text" class="sh-input sh-input-flat" data-filter-value placeholder="值" value="${escapeHtml(filter.value ?? '')}" />`
        : '<span class="sh-filter-placeholder"></span>'}
      <button type="button" class="sh-icon-btn" data-remove-filter aria-label="删除条件">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-trash"/></svg>
      </button>
    </div>`;
  }).join('');

  const el = openPopover(anchor, 'sh-filterpanel', `
    <div class="sh-panel-title">筛选记录</div>
    <div class="sh-filter-rows" data-rows>${renderRows()}</div>
    <button type="button" class="sh-add-option" data-add-filter>＋ 添加条件</button>
    <div class="sh-panel-foot">
      <button type="button" class="sh-btn" data-clear>清空</button>
      <button type="button" class="sh-btn is-primary" data-apply>应用</button>
    </div>`);
  if (!el) return;

  const rowsHost = el.querySelector('[data-rows]');
  const repaint = () => { rowsHost.innerHTML = renderRows(); };

  el.addEventListener('change', event => {
    const row = event.target.closest('[data-index]');
    if (!row) return;
    const index = Number(row.dataset.index);
    if (!draft[index]) return;
    if (event.target.matches('[data-filter-key]')) {
      // 换了字段，值控件（文本框 / 选项下拉）必须跟着换：
      // 以前只改 key 不重绘，值还停在上一列的选项上，筛出来永远是空。
      draft[index].key = event.target.value;
      draft[index].value = '';
      repaint();
      el.querySelectorAll('[data-filter-key]')[index]?.focus();
      return;
    }
    if (event.target.matches('[data-filter-op]')) { draft[index].op = event.target.value; repaint(); }
    if (event.target.matches('[data-filter-value]')) draft[index].value = event.target.value;
  });

  el.addEventListener('input', event => {
    const row = event.target.closest('[data-index]');
    if (!row || !event.target.matches('[data-filter-value]')) return;
    const index = Number(row.dataset.index);
    if (draft[index]) draft[index].value = event.target.value;
  });

  el.addEventListener('click', event => {
    if (event.target.closest('[data-add-filter]')) {
      draft.push({ key: usable[0]?.key, op: 'contains', value: '' });
      repaint();
      return;
    }
    const removeBtn = event.target.closest('[data-remove-filter]');
    if (removeBtn) {
      const index = Number(removeBtn.closest('[data-index]')?.dataset.index);
      draft.splice(index, 1);
      repaint();
      return;
    }
    if (event.target.closest('[data-clear]')) {
      onApply?.([]);
      closeAllPanels();
      return;
    }
    if (event.target.closest('[data-apply]')) {
      onApply?.(draft.filter(item => item.key));
      closeAllPanels();
    }
  });
}

export function openSortPanel(anchor, { fields, sorts, onApply }) {
  const usable = fields.filter(field => Number(field.visible) !== 0);
  const current = sorts[0] || { key: '', dir: 'asc' };

  const el = openPopover(anchor, 'sh-sortpanel', `
    <div class="sh-panel-title">排序</div>
    <div class="sh-sort-row">
      <select class="sh-select" data-sort-key>
        <option value="">不排序（按创建顺序）</option>
        ${usable.map(field => `<option value="${escapeHtml(field.key)}" ${field.key === current.key ? 'selected' : ''}>${escapeHtml(field.label)}</option>`).join('')}
      </select>
      <select class="sh-select sh-select-sm" data-sort-dir>
        <option value="asc" ${current.dir === 'asc' ? 'selected' : ''}>升序</option>
        <option value="desc" ${current.dir === 'desc' ? 'selected' : ''}>降序</option>
      </select>
    </div>
    <div class="sh-panel-foot">
      <button type="button" class="sh-btn" data-clear>清除排序</button>
      <button type="button" class="sh-btn is-primary" data-apply>应用</button>
    </div>`);
  if (!el) return;

  const keySelect = el.querySelector('[data-sort-key]');
  const dirSelect = el.querySelector('[data-sort-dir]');

  el.addEventListener('click', event => {
    if (event.target.closest('[data-clear]')) {
      onApply?.([]);
      closeAllPanels();
      return;
    }
    if (event.target.closest('[data-apply]')) {
      const key = keySelect.value;
      onApply?.(key ? [{ key, dir: dirSelect.value }] : []);
      closeAllPanels();
    }
  });
}

// ==========================================
// 图片大图预览
// ==========================================

// 单元格里再大也只有几十像素，看不清图上的字。
// 点缩略图直接铺满屏幕看原图，Esc 或点任意处关掉。
export function openImagePreview(src, name = '', gallery = null) {
  if (!src) return null;
  const items = (Array.isArray(gallery) && gallery.length ? gallery : [{ src, name }]).filter(item => item && item.src);
  let index = Math.max(0, items.findIndex(item => item.src === src));

  const wrap = document.createElement('div');
  wrap.className = 'sh-lightbox';
  // 箭头必须挂在「图片自己的盒子」（.sh-lightbox-stage）里，不能挂在 .sh-lightbox 上：
  // 后者是 position:fixed 的整屏容器，top:50% 算的是视口中心，而 figure 底下还有一行
  // figcaption（gap 10 + 行高 18 = 28px），图片中心比视口中心高 14px —— 箭头就跟着偏 14px。
  // 挂进 stage 之后「图片中心」就是 stage 中心，两边都不用再猜。
  wrap.innerHTML = `
    <figure class="sh-lightbox-figure">
      <div class="sh-lightbox-stage">
        <img class="sh-lightbox-img" src="${escapeHtml(items[index].src)}" alt="${escapeHtml(items[index].name || '')}" />
        ${items.length > 1 ? `
          <button type="button" class="sh-lightbox-nav is-prev" data-nav="-1" aria-label="上一张">
            <svg class="wr-icon" aria-hidden="true"><use href="#ic-chevron-right"/></svg>
          </button>
          <button type="button" class="sh-lightbox-nav is-next" data-nav="1" aria-label="下一张">
            <svg class="wr-icon" aria-hidden="true"><use href="#ic-chevron-right"/></svg>
          </button>` : ''}
      </div>
      <figcaption class="sh-lightbox-cap"></figcaption>
    </figure>
    <button type="button" class="sh-lightbox-close" aria-label="关闭">
      <svg class="wr-icon" aria-hidden="true"><use href="#ic-close"/></svg>
    </button>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-on'));

  const img = wrap.querySelector('.sh-lightbox-img');
  const cap = wrap.querySelector('.sh-lightbox-cap');

  const paint = () => {
    const item = items[index];
    img.src = item.src;
    img.alt = item.name || '';
    cap.textContent = items.length > 1
      ? `${item.name || '图片'}　${index + 1} / ${items.length}`
      : (item.name || '');
  };
  paint();

  const step = delta => {
    if (items.length < 2) return;
    index = (index + delta + items.length) % items.length;
    paint();
  };

  const close = () => {
    wrap.classList.remove('is-on');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => wrap.remove(), 160);
  };
  const onKey = event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); step(-1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); step(1); }
  };

  wrap.addEventListener('click', event => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      event.stopPropagation();
      step(Number(nav.dataset.nav));
      return;
    }
    if (event.target.closest('.sh-lightbox-close') || event.target === wrap) { close(); return; }
    // 点图片本身也关掉，符合「点哪都能退出」的直觉
    close();
  });
  document.addEventListener('keydown', onKey, true);
  return close;
}

// ==========================================
// 记录详情抽屉已迁出本文件
// ==========================================
// 抽屉本体在 rowDrawer.js（T04 把「表格行详情」和「记录阅读器」合成一套）。
// ★ 本文件禁止引用抽屉模块（rowDrawer）：ESM 循环引用会让本文件的 openDrawer
// 在 TDZ 里被求值，表现为「抽屉偶发打不开，刷新后又好了」。依赖方向只能是
// 抽屉 → 本文件（浮层基座），不能反过来。
// 这里原来那个「表格行详情」函数已删除，调用方（sheetPage.js）直接从抽屉模块取。

