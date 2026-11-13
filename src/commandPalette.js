// 命令面板（Ctrl+K）。
//
// 为什么不是「搜索页」：
//   用户要搜东西时，心里想的是「我刚才记的那条在哪」，不是「我要去搜索页」。
//   搜索是一个随时可唤起的动作，不是导航目的地。同一理由让它顺便承载跳转命令 ——
//   「找一条记录」和「去某个地方」在心智上是同一件事。
//
// 覆盖范围：流水 / 待办 / 笔记 / 表格行。四类数据在库里是四张表，
// 但对用户是同一批东西，任何一类搜不到都会被判为「搜不到」。

import { escapeHtml } from './htmlUtils.js';
import { searchAll } from './search.js';

const MAX_PER_GROUP = 8;
const DEBOUNCE_MS = 140;

const ACTIONS = [
  {
    id: 'new-record',
    label: '记一笔',
    hint: '打开捕获浮层',
    run: () => window.__wrOpenCapture?.(),
  },
  {
    id: 'goto-today',
    label: '回到今天',
    hint: '工作台',
    run: () => window.__wrRouteTo?.('nav-dashboard'),
  },
  {
    id: 'goto-records',
    label: '查看记录',
    hint: '按时间回看',
    run: () => window.__wrRouteTo?.('nav-timeline'),
  },
  {
    id: 'goto-table',
    label: '打开表格',
    hint: '全部表格与字段',
    run: () => window.__wrRouteTo?.('nav-table'),
  },
  {
    id: 'goto-notes',
    label: '打开笔记',
    hint: '全部笔记',
    run: () => window.__wrRouteTo?.('nav-notes'),
  },
  {
    id: 'goto-settings',
    label: '设置',
    hint: '主题 · 分类 · 数据',
    run: () => window.__wrRouteTo?.('nav-settings'),
  },
];

const KIND_LABEL = { log: '流水', todo: '待办', note: '笔记', sheet: '表格' };

let overlay = null;
let input = null;
let listEl = null;
let metaEl = null;

let isOpen = false;
// 扁平的键盘选择序列：命令和搜索结果放同一个数组，
// ↑↓ 才能自然地跨越分组移动。
let items = [];
let cursor = 0;
// 竞态序号：慢请求回来时如果用户已经又改了输入，结果直接丢弃。
let seq = 0;
let timer = null;

function formatWhen(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  // 兼容 "2026-03-17 14:20:00" 与 "2026-03-17T14:20" 两种写法
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2}:\d{2})?/);
  if (!match) return text.slice(0, 16);
  const [, , month, day, time] = match;
  return `${month}-${day}${time ? ` ${time}` : ''}`;
}

function metaLine(record) {
  const tag = [record.tag, record.sub_tag].filter(Boolean).join(' / ');
  return [formatWhen(record.time), tag].filter(Boolean).join(' · ');
}

function itemHtml(item, index) {
  const active = index === cursor ? ' is-active' : '';
  const common = `data-index="${index}" role="option" aria-selected="${index === cursor}"`;

  // 不再重复标注类型：分组标题已经说明了这批结果是什么，
  // 每条再加一次「流水/待办」等于把同一信息说两遍，还挤掉了标题宽度。
  if (item.kind === 'action') {
    return `<button type="button" class="cmdk-item${active}" ${common}>
      <strong>${escapeHtml(item.action.label)}</strong>
      <small>${escapeHtml(item.action.hint || '')}</small>
    </button>`;
  }

  const record = item.record;
  const sub = metaLine(record);
  return `<button type="button" class="cmdk-item${active}" ${common}>
    <strong>${escapeHtml(record.title || '未命名')}</strong>
    <small>${escapeHtml(record.snippet || '')}</small>
    ${sub ? `<em>${escapeHtml(sub)}</em>` : ''}
  </button>`;
}

function renderIdle() {
  items = ACTIONS.map(action => ({ kind: 'action', action }));
  cursor = 0;
  listEl.innerHTML = `<div class="cmdk-group">命令</div>`
    + items.map((item, index) => itemHtml(item, index)).join('');
  if (metaEl) metaEl.textContent = '';
}

function renderResults(groups, keyword) {
  const buckets = [
    ['log', groups.logs || []],
    ['todo', groups.todos || []],
    ['note', groups.notes || []],
    ['sheet', groups.sheets || []],
  ];

  items = [];
  let html = '';

  for (const [type, list] of buckets) {
    if (!list.length) continue;
    html += `<div class="cmdk-group">${KIND_LABEL[type]}<span>${list.length}</span></div>`;
    for (const record of list.slice(0, MAX_PER_GROUP)) {
      const index = items.length;
      items.push({ kind: 'result', type, record });
      html += itemHtml(items[index], index);
    }
  }

  if (!items.length) {
    html = `<div class="cmdk-empty">没有找到「${escapeHtml(keyword)}」</div>`;
  }

  listEl.innerHTML = html;
  cursor = 0;
  syncCursor();
  if (metaEl) metaEl.textContent = items.length ? `${items.length} 条` : '';
}

function syncCursor() {
  if (!listEl) return;
  listEl.querySelectorAll('.cmdk-item').forEach(el => {
    const active = Number(el.dataset.index) === cursor;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-selected', String(active));
    if (active) el.scrollIntoView({ block: 'nearest' });
  });
}

function move(delta) {
  if (!items.length) return;
  cursor = (cursor + delta + items.length) % items.length;
  syncCursor();
}

// 打开一条记录：优先用工作台那套详情弹层，保持「点开看到的内容」和别处一致。
// 弹层没挂上（初始化顺序问题）就退回记录页，不让点击变成无反应。
function openRecord(record, type) {
  if (type === 'note' && record.relPath) {
    window.__wrRouteTo?.('nav-notes');
    import('./notesEditor.js')
      .then(module => module.openNote(record.relPath))
      .catch(error => console.warn('打开笔记失败', error));
    return;
  }

  if (type === 'sheet') {
    window.__wrRouteTo?.('nav-table');
    return;
  }

  const reader = window.__wrOpenRecordReader;
  if (typeof reader !== 'function') {
    window.__wrRouteTo?.('nav-timeline');
    return;
  }

  reader({
    id: record.id,
    text: record.title,
    detail: record.detail || record.snippet || '',
    remark: '',
    tag: record.tag || '',
    sub_tag: record.sub_tag || '',
    date: String(record.time || '').slice(0, 10),
    time: String(record.time || '').slice(11),
    status: '',
    record_type: type === 'todo' ? 'todo' : 'log',
  });
}

function run(item) {
  if (!item) return;
  if (item.kind === 'action') {
    close();
    try {
      item.action.run();
    } catch (error) {
      console.warn('命令执行失败', error);
    }
    return;
  }

  close();
  openRecord(item.record, item.type);
}

async function doSearch(keyword) {
  const current = ++seq;
  if (metaEl) metaEl.textContent = '搜索中…';

  try {
    const groups = await searchAll(keyword);
    if (current !== seq) return;
    renderResults(groups, keyword);
  } catch (error) {
    if (current !== seq) return;
    console.warn('搜索失败', error);
    listEl.innerHTML = '<div class="cmdk-empty">搜索失败，请查看日志</div>';
  }
}

function openPalette() {
  if (!overlay || !input) return;
  isOpen = true;
  overlay.hidden = false;
  document.body.classList.add('cmdk-open');
  input.value = '';
  seq += 1;
  renderIdle();
  requestAnimationFrame(() => input.focus());
}

function close() {
  if (!overlay) return;
  isOpen = false;
  overlay.hidden = true;
  document.body.classList.remove('cmdk-open');
  clearTimeout(timer);
}

export function initCommandPalette() {
  overlay = document.getElementById('cmdk-overlay');
  input = document.getElementById('cmdk-input');
  listEl = document.getElementById('cmdk-list');
  metaEl = document.getElementById('cmdk-meta');
  if (!overlay || !input || !listEl) return;

  document.getElementById('cmdk-open-btn')?.addEventListener('click', openPalette);
  document.getElementById('cmdk-close')?.addEventListener('click', close);

  overlay.addEventListener('click', event => {
    if (event.target === overlay) close();
  });

  listEl.addEventListener('click', event => {
    const el = event.target.closest('.cmdk-item');
    if (!el) return;
    const index = Number(el.dataset.index);
    if (!Number.isFinite(index)) return;
    cursor = index;
    run(items[index]);
  });

  input.addEventListener('input', () => {
    const keyword = input.value.trim();
    clearTimeout(timer);
    if (!keyword) {
      seq += 1;
      renderIdle();
      return;
    }
    timer = setTimeout(() => doSearch(keyword), DEBOUNCE_MS);
  });

  // 全局快捷键：Ctrl+K 开关面板。放在 document 上是因为它必须
  // 在任意页面、任意焦点位置都能用 —— 这就是它取代搜索页的理由。
  document.addEventListener('keydown', event => {
    const isToggle = (event.ctrlKey || event.metaKey) && !event.shiftKey
      && (event.key === 'k' || event.key === 'K');

    if (isToggle) {
      event.preventDefault();
      if (isOpen) close();
      else openPalette();
      return;
    }

    if (!isOpen) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(items[cursor]);
    }
  });

  // 供其他模块主动唤起（例如设置页的「搜索」入口）
  window.__wrOpenPalette = openPalette;
}
