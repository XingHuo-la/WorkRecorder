// ==========================================
// 笔记编辑器（v1.2 重排：打开即写 / 关联记录 chips / 三态视图）
//
// 形态：默认单栏源码，可切预览或双栏（settings.note_pane 记忆）。
// 顶栏 = 返回记录（从抽屉进来时）+ 标题 + 保存状态 + 视图切换 + ⋯ 菜单。
// 第二行 = 关联记录 chips（多对多）+ 分类折叠入口。
// 依赖渲染能力由 markdown.js 提供，全部本地 vendored。
// ==========================================

import { renderMarkdown, preloadRenderer, detectDarkTheme } from './markdown.js';
import { escapeHtml } from './htmlUtils.js';
import { logToFile } from './logger.js';
import {
  readNote,
  writeNote,
  deleteNote,
  normalizeRecordIds,
  addNoteRecord,
  removeNoteRecord
} from './notesStore.js';
import { getRecords, searchRecords } from './recordStore.js';
import { undoStack } from './undoCore.js';
import {
  getPreferredEditor,
  openInExternalEditor
} from './externalEditor.js';

const AUTOSAVE_DELAY = 1200;

/** 索引同步失败只降级不报错，但要留下可排查的痕迹。 */
function warnIndexFailure(error) {
  logToFile('warn', `笔记索引同步失败（不影响笔记本身）: ${error?.stack || error}`);
}

/** 编辑器会话状态。 */
const state = {
  /** 当前打开的笔记（磁盘状态） */
  doc: null,
  /** 未保存的草稿内容 */
  draft: '',
  /** 是否有未保存改动 */
  dirty: false,
  /** 自动保存定时器 */
  saveTimer: null,
  /** 预览渲染节流定时器 */
  previewTimer: null,
  /** 预览渲染序号，用于丢弃过期结果 */
  renderSeq: 0,
  /** 防止 Ctrl+S 与自动保存并发写同一文件 */
  saving: false,
  /** 外部编辑器信息 */
  externalEditor: null,
  /** 是否已绑定 DOM 事件 */
  bound: false,
  /** 关闭确认回调，供外部注入 */
  onRequestClose: null,
  /** 视图三态：source | preview | split（settings.note_pane） */
  pane: 'source',
  /** 来源记录（从抽屉点笔记进来时记录，供「← 返回记录」）。null = 独立进入 */
  origin: null,
  /** 关联记录 chips 的标题缓存（id → {title, found}） */
  linkTitles: new Map(),
  /** 「挂到记录」选择器的开关态 */
  pickerOpen: false,
  /** ⋯ 菜单开关态 */
  menuOpen: false,
  /** meta（分类）编辑行展开态 */
  metaOpen: false
};

let els = {};

function cacheElements() {
  els = {
    view: document.getElementById('subview-notes'),
    list: document.getElementById('notes-list-pane'),
    listMeta: document.getElementById('notes-list-meta'),
    editor: document.getElementById('note-editor-pane'),
    empty: document.getElementById('note-editor-empty'),
    emptyNewBtn: document.getElementById('note-empty-new-btn'),
    titleInput: document.getElementById('note-title-input'),
    source: document.getElementById('note-source-input'),
    preview: document.getElementById('note-preview'),
    status: document.getElementById('note-editor-status'),
    tagSelect: document.getElementById('note-editor-tag'),
    subTagSelect: document.getElementById('note-editor-subtag'),
    typeSelect: document.getElementById('note-editor-type'),
    newBtn: document.getElementById('note-new-btn'),
    deleteBtn: document.getElementById('note-delete-btn'),
    externalBtn: document.getElementById('note-open-external-btn'),
    folderBtn: document.getElementById('note-open-folder-btn'),
    folderBtnMenu: document.getElementById('note-open-folder-btn-menu'),
    searchInput: document.getElementById('notes-filter-input'),
    searchToggle: document.getElementById('note-search-toggle'),
    searchRow: document.querySelector('#subview-notes [data-search-row]'),
    backBtn: document.getElementById('note-back-btn'),
    moreBtn: document.getElementById('note-more-btn'),
    menu: document.querySelector('#subview-notes [data-note-menu]'),
    linkRow: document.querySelector('#subview-notes [data-link-row]'),
    metaToggle: document.querySelector('#subview-notes [data-meta-toggle]'),
    metaEdit: document.querySelector('#subview-notes [data-meta-edit]'),
    wordcount: document.getElementById('nt-wordcount'),
    updated: document.getElementById('nt-updated')
  };
}

function setStatus(text, tone = '') {
  if (!els.status) return;
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

/**
 * 生成一个本地时间戳字符串，格式与项目其它模块保持一致。
 */
function nowString() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function dateOnly() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 从正文里推一个标题出来（正文首行非空内容，或首行标题）。 */
function deriveTitle(content) {
  const lines = String(content || '').split('\n');
  for (const line of lines) {
    const cleaned = line.replace(/^#{1,6}\s*/, '').trim();
    if (cleaned) {
      return cleaned.length > 40 ? `${cleaned.slice(0, 40)}...` : cleaned;
    }
  }
  return '未命名笔记';
}

// ==========================================
// 渲染：笔记列表
// ==========================================

/** 当前筛选关键词。 */
let filterKeyword = '';
/** 当前笔记缓存。 */
let notesCache = [];

function matchesFilter(note) {
  if (!filterKeyword) return true;
  const kw = filterKeyword.toLowerCase();
  const haystack = [
    note.title,
    note.content,
    note.tag,
    note.sub_tag,
    note.note_type
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(kw);
}

/**
 * 渲染笔记列表（左侧栏）。
 */
export function renderNotesPane() {
  if (!els.list) return;

  const items = notesCache.filter(matchesFilter);

  if (els.listMeta) {
    els.listMeta.textContent = filterKeyword
      ? `${items.length} / ${notesCache.length} 篇`
      : `${notesCache.length} 篇`;
  }

  if (!items.length) {
    els.list.innerHTML = notesCache.length
      ? `<div class="notes-pane-empty">没有匹配「${escapeHtml(filterKeyword)}」的笔记</div>`
      : '<div class="notes-pane-empty">还没有笔记<br><small>点上方「新建」开始记录</small></div>';
    return;
  }

  const activeRel = state.doc?.rel_path || '';
  els.list.innerHTML = items.map(note => {
    const isActive = note.rel_path === activeRel;
    // 列表项两行：标题 + 一行 meta（`2 条记录 · 10-12`）。
    // 70 字摘要在 210px 列宽下只是噪音（design-v1.2 §3.6 / PRD R12）。
    const linkCount = normalizeRecordIds(note.record_ids).length;
    const updated = (note.updated_at || note.created_at || '').substring(5, 10);
    const bits = [];
    if (linkCount) bits.push(`${linkCount} 条记录`);
    if (updated) bits.push(updated);
    const meta = bits.join(' · ');

    return `
      <button type="button" class="note-list-item${isActive ? ' is-active' : ''}" data-rel="${escapeHtml(note.rel_path)}">
        <div class="note-list-title">${escapeHtml(note.title || '未命名笔记')}</div>
        <div class="note-list-meta">${escapeHtml(meta || '独立笔记')}</div>
      </button>
    `;
  }).join('');
}

// ==========================================
// 渲染：预览
// ==========================================

/**
 * 把源码渲染进预览面板。
 * 用序号丢弃过期结果，避免快速输入时旧渲染覆盖新渲染。
 */
async function refreshPreview() {
  if (!els.preview) return;
  const seq = ++state.renderSeq;
  const source = els.source?.value ?? '';

  let html;
  try {
    html = await renderMarkdown(source, {
      theme: detectDarkTheme() ? 'dark' : 'light'
    });
  } catch (error) {
    console.error('预览渲染失败:', error);
    html = `<p class="md-empty">预览渲染失败：${escapeHtml(String(error.message || error))}</p>`;
  }

  if (seq !== state.renderSeq) return; // 已有更新的渲染在路上
  els.preview.innerHTML = html;
}

function schedulePreview() {
  if (state.previewTimer) clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(refreshPreview, 160);
}

// ==========================================
// 标签 / 类型下拉
// ==========================================

function fillSelect(select, values, current, placeholder) {
  if (!select) return;
  const options = [];
  if (placeholder) {
    options.push(`<option value="">${escapeHtml(placeholder)}</option>`);
  }
  const list = [...new Set(values.filter(Boolean))];
  if (current && !list.includes(current)) list.unshift(current);

  options.push(...list.map(v => {
    const selected = v === current ? ' selected' : '';
    return `<option value="${escapeHtml(v)}"${selected}>${escapeHtml(v)}</option>`;
  }));

  select.innerHTML = options.join('');
}

const NOTE_TYPES = {
  idea: '想法',
  problem: '问题',
  source: '资料',
  decision: '决策',
  method: '方法',
  review: '复盘'
};

/**
 * 用当前 appData 填充编辑器顶部的元数据控件。
 */
function refreshMetaControls() {
  const note = state.doc || {};
  const appData = window.__wrAppData?.() || {};

  fillSelect(els.tagSelect, appData.tags || [], note.tag, '未分类');
  fillSelect(els.typeSelect, Object.keys(NOTE_TYPES),
    note.note_type || 'idea',
    null);

  if (els.typeSelect) {
    // 类型下拉显示中文名
    els.typeSelect.innerHTML = Object.entries(NOTE_TYPES).map(([key, label]) => {
      const selected = key === (note.note_type || 'idea') ? ' selected' : '';
      return `<option value="${key}"${selected}>${label}</option>`;
    }).join('');
  }

  const subs = appData.sub_tags?.[note.tag] || [];
  fillSelect(els.subTagSelect, subs, note.sub_tag, '(无子项目)');
}

// ==========================================
// 关联记录 chips（多对多 · R03）
// ==========================================

/**
 * 刷新第二行：关联记录 chips + 分类折叠入口。
 *
 * 标题解析用 getRecords 一次批量拿；查不到的 id 渲染成灰色占位
 * 「已删除记录（原 #37）」——留痕口径（§9.3 / R06），不静默消失、
 * 也不自动从 front-matter 里清掉。
 */
async function refreshLinkRow() {
  if (!els.linkRow) return;
  const ids = normalizeRecordIds(state.doc?.record_ids);
  state.linkTitles = new Map();

  if (ids.length) {
    const records = await getRecords(ids).catch(() => []);
    const found = new Map((records || []).map(r => [Number(r.id), r]));
    for (const id of ids) {
      const rec = found.get(Number(id));
      state.linkTitles.set(Number(id), rec ? { title: rec.title || `#${id}`, found: true } : { title: `已删除记录（原 #${id}）`, found: false });
    }
  }

  renderLinkRow();
}

function renderLinkRow() {
  if (!els.linkRow) return;
  const ids = normalizeRecordIds(state.doc?.record_ids);
  const chips = ids.map(id => {
    const info = state.linkTitles.get(Number(id)) || { title: `#${id}`, found: true };
    if (!info.found) {
      return `<span class="nt-link-chip is-dead" data-dead-id="${id}" aria-disabled="true" title="这条记录已删除，关联保留在文件里">${escapeHtml(info.title)}</span>`;
    }
    return `<button type="button" class="nt-link-chip" data-record-id="${id}" title="打开这条记录">
      <span class="nt-link-chip-text">${escapeHtml(info.title)}</span>
      <span class="nt-link-chip-x" data-unlink-id="${id}" role="button" aria-label="解除关联" title="解除关联">×</span>
    </button>`;
  });

  const picker = state.pickerOpen ? renderPickerHtml() : '';
  const addBtn = `<button type="button" class="nt-link-add" data-link-add>＋挂到记录…</button>`;
  els.linkRow.innerHTML = chips.join('') + addBtn + picker;
}

function renderPickerHtml() {
  return `
    <div class="nt-picker" data-note-picker>
      <input type="text" class="nt-picker-input" data-picker-input placeholder="搜记录标题或 #id" />
      <div class="nt-picker-list" data-picker-list><div class="nt-picker-hint">输入关键词，回车挂上第一条</div></div>
    </div>`;
}

function closePicker() {
  if (!state.pickerOpen) return;
  state.pickerOpen = false;
  renderLinkRow();
}

/** 在选择器里搜记录（标题 LIKE / id 等值），排除已挂的。 */
async function renderPickerResults(keyword) {
  const list = els.linkRow?.querySelector('[data-picker-list]');
  if (!list) return;
  const kw = String(keyword ?? '').trim();
  if (!kw) {
    list.innerHTML = '<div class="nt-picker-hint">输入关键词，回车挂上第一条</div>';
    return;
  }
  const exclude = normalizeRecordIds(state.doc?.record_ids);
  const rows = await searchRecords(kw, { limit: 8, excludeIds: exclude }).catch(() => []);
  if (!rows?.length) {
    list.innerHTML = '<div class="nt-picker-hint">没有匹配的记录</div>';
    return;
  }
  list.innerHTML = rows.map(r =>
    `<button type="button" class="nt-picker-item" data-pick-id="${Number(r.id)}">
      <span class="nt-picker-title">${escapeHtml(r.title || `#${r.id}`)}</span>
      <span class="nt-picker-kind">#${Number(r.id)}</span>
    </button>`
  ).join('');
}

/** 挂上一条记录：addNoteRecord 是文件级真相的并集操作，幂等。 */
async function attachRecord(recordId) {
  const rel = state.doc?.rel_path;
  if (!rel) {
    setStatus('笔记尚未落盘，先写点内容', 'warn');
    return;
  }
  try {
    const saved = await addNoteRecord(rel, Number(recordId));
    state.doc = { ...state.doc, record_ids: normalizeRecordIds(saved?.record_ids) };
    closePicker();
    await refreshLinkRow();
    await refreshNotesCache({ keepSelection: true });
    setStatus('已挂到记录');
  } catch (error) {
    console.error('挂接记录失败:', error);
    logToFile('error', `笔记挂接记录失败 rel=${rel} record=${recordId}: ${error?.message || error}`);
    setStatus(`挂接失败：${error?.message || error}`, 'error');
  }
}

/** 解除一条关联：只少这一个 id，其余关联原样保留（R02/R03）。 */
async function detachRecord(recordId) {
  const rel = state.doc?.rel_path;
  if (!rel) return;
  try {
    const saved = await removeNoteRecord(rel, Number(recordId));
    state.doc = { ...state.doc, record_ids: normalizeRecordIds(saved?.record_ids) };
    await refreshLinkRow();
    await refreshNotesCache({ keepSelection: true });
    setStatus('已解除关联');
  } catch (error) {
    console.error('解除关联失败:', error);
    logToFile('error', `笔记解除关联失败 rel=${rel} record=${recordId}: ${error?.message || error}`);
    setStatus(`解除失败：${error?.message || error}`, 'error');
  }
}

// ==========================================
// 视图三态 / meta 折叠 / 底部信息 / 返回记录
// ==========================================

const PANE_KEY = 'note_pane';

/** 读回视图偏好。settings 表读不到时给默认值。 */
async function loadPanePref() {
  try {
    const { dbQuery } = await import('./data.js');
    const rows = await dbQuery('SELECT value FROM settings WHERE key = ?', [PANE_KEY]).catch(() => []);
    const value = rows?.[0]?.value;
    if (value === 'source' || value === 'preview' || value === 'split') {
      state.pane = value;
    }
  } catch (error) {
    logToFile('warn', `读取 note_pane 偏好失败（用默认单栏）: ${error?.message || error}`);
  }
  // 双栏只在宽屏可选：窄窗口下即便库里存着 split 也回落单栏
  if (state.pane === 'split' && window.innerWidth < 1200) state.pane = 'source';
  applyPane();
}

/** 双写：内存 + settings 表（与主题同源，能进备份；§八 8.6）。 */
async function savePanePref(pane) {
  state.pane = pane;
  applyPane();
  try {
    const { dbExecute } = await import('./data.js');
    await dbExecute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [PANE_KEY, pane]);
  } catch (error) {
    logToFile('warn', `写入 note_pane 偏好失败: ${error?.message || error}`);
  }
}

function applyPane() {
  if (!els.view) return;
  els.view.dataset.pane = state.pane;
  els.view.querySelectorAll('.nt-seg-btn').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.paneOpt === state.pane));
  });
  // 双栏只在宽屏可选：按钮跟着窗口宽度显隐（applyPane 在 init 与每次切换都会跑）
  const splitBtn = els.view.querySelector('[data-pane-split]');
  if (splitBtn) splitBtn.hidden = window.innerWidth < 1200;
}

function updateMetaToggle() {
  if (!els.metaToggle) return;
  const doc = state.doc;
  if (!doc) {
    els.metaToggle.hidden = true;
    return;
  }
  els.metaToggle.hidden = false;
  if (state.metaOpen) {
    els.metaToggle.textContent = '收起分类';
    if (els.metaEdit) els.metaEdit.hidden = false;
  } else {
    const bits = [NOTE_TYPES[doc.note_type] || doc.note_type, doc.tag, doc.sub_tag].filter(Boolean);
    els.metaToggle.textContent = bits.length ? `分类：${bits.join(' / ')}` : '＋ 分类';
    if (els.metaEdit) els.metaEdit.hidden = true;
  }
}

function updateDocFoot() {
  const content = els.source?.value ?? '';
  const chars = content.replace(/\s/g, '').length;
  if (els.wordcount) els.wordcount.textContent = chars ? `${chars} 字` : '';
  const when = String(state.doc?.updated_at ?? '').substring(5, 16);
  if (els.updated) els.updated.textContent = when ? `更新于 ${when}` : '';
}

/** 来源记录（R09）：由 rowDrawer 打开笔记时传入。 */
export function setOrigin(recordId) {
  const id = Number(recordId);
  state.origin = Number.isFinite(id) && id > 0 ? { recordId: id } : null;
  updateBackButton();
}

function updateBackButton() {
  if (!els.backBtn) return;
  if (!state.origin) {
    els.backBtn.hidden = true;
    els.backBtn.textContent = '';
    return;
  }
  els.backBtn.hidden = false;
  els.backBtn.textContent = `← 记录 #${state.origin.recordId}`;
  els.backBtn.title = '回到这条记录的详情';
}

/** 回到来源记录：直接开抽屉（记录页内定位该行是 T09 的活，这里不越界）。 */
async function goBackToRecord() {
  const recordId = state.origin?.recordId;
  if (!recordId) return;
  try {
    const drawer = await import('./rowDrawer.js');
    drawer.openRowDrawer({ recordId });
  } catch (error) {
    console.error('返回记录失败:', error);
    setStatus('返回记录失败', 'error');
  }
}

function closeMenu() {
  if (!state.menuOpen) return;
  state.menuOpen = false;
  if (els.menu) els.menu.hidden = true;
  if (els.moreBtn) els.moreBtn.setAttribute('aria-expanded', 'false');
}

function toggleMenu() {
  state.menuOpen = !state.menuOpen;
  if (els.menu) els.menu.hidden = !state.menuOpen;
  if (els.moreBtn) els.moreBtn.setAttribute('aria-expanded', String(state.menuOpen));
  if (state.menuOpen) closePicker();
}

// ==========================================
// 编辑器生命周期
// ==========================================

function setEditorVisible(visible) {
  if (els.editor) els.editor.hidden = !visible;
  if (els.empty) els.empty.hidden = visible;
}

/** 把 doc 载入编辑器界面。 */
function loadIntoEditor(doc) {
  state.doc = doc;
  state.draft = doc?.content ?? '';
  state.dirty = false;
  closePicker();
  closeMenu();

  if (!doc) {
    setEditorVisible(false);
    renderNotesPane();
    return;
  }

  setEditorVisible(true);
  if (els.titleInput) els.titleInput.value = doc.title || '';
  if (els.source) els.source.value = doc.content || '';
  refreshMetaControls();
  updateMetaToggle();
  void refreshLinkRow();
  refreshPreview();
  updateDocFoot();
  setStatus('');
  renderNotesPane();
}

/**
 * 打开一篇笔记。
 * @param {string} relPath 相对路径
 * @param {{ fromRecordId?: number|null }} [opts] 从记录抽屉进来时带上来源，
 *        顶栏会出现「← 记录标题」，点它或按 Esc 回到该记录的抽屉（R09）。
 */
export async function openNote(relPath, opts = {}) {
  if (state.dirty) {
    const ok = await confirmDiscard();
    if (!ok) return;
  }

  const doc = await readNote(relPath);
  if (!doc) {
    setStatus('打开失败', 'error');
    return;
  }
  // 来源只由调用方显式设置：从列表点进来的普通浏览要把上一次的来源清掉，
  // 否则「← 某记录」会一直挂在顶栏，指着一个早已离开的记录。
  state.origin = opts.fromRecordId ? { recordId: Number(opts.fromRecordId) } : null;
  updateBackButton();
  loadIntoEditor(doc);
}

/** 新建一篇空白笔记（内存态，尚未落盘）。 */
export function createNewNote() {
  const timestamp = nowString();
  const appData = window.__wrAppData?.() || {};
  const defaultTag = appData.tags?.[0] || '未分类';

  state.origin = null;
  updateBackButton();
  loadIntoEditor({
    id: null,
    title: '',
    content: '',
    note_type: 'idea',
    status: 'usable',
    tag: defaultTag,
    sub_tag: '',
    created_at: timestamp,
    updated_at: timestamp,
    rel_path: '',
    abs_path: ''
  });

  els.titleInput?.focus();
  setStatus('新建中，写入内容后自动保存');
}

/* ───────────── 撤销 ───────────── */

// 笔记的撤销边界刻意比表格窄：**正文输入不登记**。
// 理由是没有收益只有副作用 —— textarea 自带原生 Ctrl+Z（bindUndoShortcuts 会主动让开），
// 而自动保存每 1.2s 跑一次，每次都压一条的话 Ctrl+Z 一次只退一小步，比没有更难用。
// 真正需要保护的是两类**结构性**改动：换分类（文件换目录）、删除笔记（文件消失）。

/**
 * 换分类会让文件在磁盘上换目录，textarea 的原生撤销管不了，登记到全局撤销栈。
 * @param {{ id:number|string, relPath:string, title:string, created_at:string,
 *           record_ids:number[], content:string,
 *           before:{tag:string, sub_tag:string}, after:{tag:string, sub_tag:string} }} entry
 */
function registerNoteMetaUndo(entry) {
  const apply = async meta => {
    // 同一篇还开着就用它**当前**的 rel_path：标题改过之后路径会变，
    // 拿旧路径写会新造一个文件、老文件还留在磁盘上。
    const live = state.doc && String(state.doc.id || '') === String(entry.id) ? state.doc : null;
    const target = live?.rel_path || entry.relPath;
    if (!target) return false;

    // 正文取 textarea 里的实时值：撤销分类不该顺手把用户刚敲的字回退掉
    const content = live ? (els.source?.value ?? live.content ?? '') : entry.content;
    try {
      const saved = await writeNote({
        id: entry.id,
        title: live?.title || entry.title,
        content,
        note_type: live?.note_type || entry.note_type || '',
        status: live?.status || entry.status || '',
        tag: meta.tag,
        sub_tag: meta.sub_tag,
        created_at: live?.created_at || entry.created_at,
        updated_at: nowString(),
        rel_path: target,
        record_ids: normalizeRecordIds(live?.record_ids || entry.record_ids)
      });
      if (!saved) throw new Error('后端未返回保存结果');

      if (live) {
        state.doc = saved;
        state.draft = saved.content;
        state.dirty = false;
        if (els.titleInput && saved.title !== els.titleInput.value) els.titleInput.value = saved.title;
        void refreshLinkRow();
        updateDocFoot();
      }
      await refreshNotesCache({ keepSelection: true });
      setStatus(`分类已回到「${meta.tag || '未分类'}」`);
      return true;
    } catch (error) {
      console.error('撤销笔记分类失败:', error);
      setStatus(`撤销失败：${error.message || error}`, 'error');
      return false;
    }
  };

  undoStack.push({
    label: '修改笔记分类',
    undo: () => apply(entry.before),
    redo: () => apply(entry.after)
  });
}

/**
 * 删除笔记的撤销。
 * 笔记是文件优先的，删掉就是真删文件 —— 撤销只能把整份内容重新写回去
 * （id / 创建时间 / 关联都带着，内容一条不丢）。新文件名可能和原来不同
 * （同名文件存在时 Rust 侧会加后缀），可见但无害。
 * @param {object} snapshot 删除前的完整笔记
 */
function registerNoteDeleteUndo(snapshot) {
  let relPath = snapshot.rel_path;

  undoStack.push({
    label: `删除笔记「${snapshot.title || '未命名'}」`,
    undo: async () => {
      try {
        const saved = await writeNote({ ...snapshot, rel_path: '', updated_at: nowString() });
        if (!saved) throw new Error('后端未返回保存结果');
        relPath = saved.rel_path;
        setStatus('已恢复刚才删除的笔记');
        await refreshNotesCache();
        return true;
      } catch (error) {
        console.error('恢复笔记失败:', error);
        setStatus(`恢复失败：${error.message || error}`, 'error');
        return false;
      }
    },
    redo: async () => {
      if (!relPath) return false;
      try {
        await deleteNote(relPath);
        if (state.doc?.rel_path === relPath) loadIntoEditor(null);
        await refreshNotesCache();
        setStatus('已删除');
        return true;
      } catch (error) {
        console.error('重做删除笔记失败:', error);
        return false;
      }
    }
  });
}

/**
 * 保存当前笔记。
 *
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<boolean>} 是否保存成功
 */
export async function saveCurrentNote(options = {}) {
  if (!state.doc) return false;
  if (state.saving) return false;

  const content = els.source?.value ?? '';
  const titleFromInput = els.titleInput?.value.trim() || '';
  const title = titleFromInput || deriveTitle(content);

  // 空笔记（标题与正文都空）不落盘，避免产生垃圾文件
  if (!content.trim() && !titleFromInput) {
    if (!options.silent) setStatus('内容为空，未保存', 'warn');
    return false;
  }

  state.saving = true;
  if (!options.silent) setStatus('保存中...');

  // 换分类会让文件换目录，撤销要靠「写回旧分类」—— 先把改之前的分类记下来
  const metaBefore = state.doc
    ? { tag: state.doc.tag || '', sub_tag: state.doc.sub_tag || '' }
    : null;

  try {
    const payload = {
      id: state.doc.id,
      title,
      content,
      note_type: els.typeSelect?.value || state.doc.note_type || 'idea',
      status: state.doc.status || 'usable',
      tag: els.tagSelect?.value || '',
      sub_tag: els.subTagSelect?.value || '',
      created_at: state.doc.created_at || nowString(),
      updated_at: nowString(),
      rel_path: state.doc.rel_path || '',
      // ⚠️ 不变式 1（design-v1.2 §2.5）：notes_write 是**整份覆盖** front-matter。
      // 漏传 record_ids 等于每次自动保存都把关联清空，而且零报错。
      // 清空关联的唯一入口是 setNoteRecords(rel, [])，不是漏传。
      record_ids: normalizeRecordIds(state.doc.record_ids)
    };

    const saved = await writeNote(payload);
    if (!saved) throw new Error('后端未返回保存结果');

    // 分类变化会让文件换目录、标题变化会换文件名，重新载入以拿到最终路径
    state.doc = saved;
    state.draft = saved.content;
    state.dirty = false;

    if (els.titleInput && saved.title !== els.titleInput.value) {
      els.titleInput.value = saved.title;
    }

    setStatus(`已保存 ${saved.updated_at.substring(11, 16)}`);
    void refreshLinkRow();
    updateDocFoot();

    // 只在分类真的变了时才登记：正文输入交给 textarea 原生撤销（见上方注释）
    const metaAfter = { tag: saved.tag || '', sub_tag: saved.sub_tag || '' };
    if (metaBefore && (metaBefore.tag !== metaAfter.tag || metaBefore.sub_tag !== metaAfter.sub_tag)) {
      registerNoteMetaUndo({
        id: saved.id,
        relPath: saved.rel_path,
        title: saved.title,
        created_at: saved.created_at,
        // 撤销时这篇笔记可能没开着，note_type / status 必须一起带上：
        // 缺省会落回 'idea' / 'usable'，等于顺手把用户设定的类型也改了
        note_type: saved.note_type,
        status: saved.status,
        record_ids: saved.record_ids || [],
        content: saved.content,
        before: metaBefore,
        after: metaAfter
      });
    }

    await refreshNotesCache({ keepSelection: true });
    return true;
  } catch (error) {
    console.error('保存笔记失败:', error);
    setStatus(`保存失败：${error.message || error}`, 'error');
    return false;
  } finally {
    state.saving = false;
  }
}

function scheduleAutosave() {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    if (state.dirty) saveCurrentNote({ silent: true });
  }, AUTOSAVE_DELAY);
}

function markDirty() {
  state.dirty = true;
  setStatus('未保存', 'warn');
  scheduleAutosave();
}

/**
 * 有未保存内容时询问是否丢弃。
 * 返回 true 表示可以继续（已保存或用户选择丢弃）。
 */
async function confirmDiscard() {
  if (!state.dirty) return true;

  // 尽量先自动保存一次，用户不必做选择
  const saved = await saveCurrentNote({ silent: true });
  if (saved) return true;

  return window.confirm('当前笔记未能保存，确定要放弃修改吗？');
}

/**
 * 删除当前笔记。
 */
export async function deleteCurrentNote() {
  if (!state.doc) return;
  if (!state.doc.rel_path) {
    // 从未落盘的新笔记，直接清空编辑器
    loadIntoEditor(null);
    return;
  }

  const title = state.doc.title || '未命名笔记';
  if (!window.confirm(`确定删除笔记「${title}」吗？\n文件会一并从磁盘删除，删除后可按 Ctrl+Z 撤销。`)) {
    return;
  }

  // 正文取 textarea 实时值：可能刚敲完、自动保存还没跑到
  const snapshot = { ...state.doc, content: els.source?.value ?? state.doc.content ?? '' };

  const ok = await deleteNote(state.doc.rel_path);
  if (!ok) {
    setStatus('删除失败', 'error');
    return;
  }

  registerNoteDeleteUndo(snapshot);
  loadIntoEditor(null);
  await refreshNotesCache();
  setStatus('已删除');
}

/**
 * 重新扫描磁盘笔记，刷新列表缓存。
 */
export async function refreshNotesCache(options = {}) {
  const { listNotes, syncNoteIndex } = await import('./notesStore.js');
  const { dbExecute } = await import('./data.js');

  notesCache = await listNotes();

  // 索引同步是锦上添花，失败不影响主流程，但必须留下痕迹，
  // 否则「列表能看到笔记、搜索却查不到」这类问题无从排查。
  syncNoteIndex(notesCache, dbExecute).catch(error => {
    warnIndexFailure(error);
  });

  if (options.keepSelection && state.doc?.rel_path) {
    // 保存后路径可能变了，按标题找回当前这篇
    const match = notesCache.find(n =>
      n.rel_path === state.doc.rel_path
      || (state.doc.title && n.title === state.doc.title && n.created_at === state.doc.created_at)
    );
    if (match) state.doc = { ...state.doc, ...match };
  }

  renderNotesPane();
  return notesCache;
}

/** 供外部读取当前列表。 */
export function getNotesCache() {
  return notesCache;
}

/** 供搜索等模块复用：按相对路径拿正文。 */
export async function getNoteContent(relPath) {
  const cached = notesCache.find(n => n.rel_path === relPath);
  if (cached) return cached.content;
  const doc = await readNote(relPath);
  return doc?.content || '';
}

// ==========================================
// 事件绑定
// ==========================================

/**
 * 初始化笔记编辑器模块。
 */
export async function initNotesEditor() {
  cacheElements();
  if (!els.view) return;

  // 渲染依赖提前加载，避免第一次预览时出现空白
  preloadRenderer(detectDarkTheme() ? 'dark' : 'light');

  // 探测外部编辑器，探测不到就把按钮藏起来
  try {
    state.externalEditor = await getPreferredEditor();
  } catch (error) {
    state.externalEditor = null;
  }
  updateExternalButton();

  if (!state.bound) {
    bindEvents();
    state.bound = true;
  }

  // 视图三态偏好（settings.note_pane）：要在首帧前定好 data-pane
  await loadPanePref();
  updateBackButton();

  await refreshNotesCache();

  // 默认打开最近一篇
  if (!state.doc && notesCache.length) {
    await openNote(notesCache[0].rel_path);
  } else if (!notesCache.length) {
    setEditorVisible(false);
  }
}

function updateExternalButton() {
  if (!els.externalBtn) return;
  const editor = state.externalEditor;
  if (!editor) {
    els.externalBtn.hidden = true;
    return;
  }
  els.externalBtn.hidden = false;
  els.externalBtn.textContent = `在 ${editor.name} 中打开`;
  els.externalBtn.title = editor.path;
}

function bindEvents() {
  // 列表点击 → 打开笔记（普通浏览，清掉来源）
  els.list?.addEventListener('click', async event => {
    const item = event.target.closest('.note-list-item');
    if (!item) return;
    await openNote(item.dataset.rel);
  });

  // 筛选
  els.searchInput?.addEventListener('input', () => {
    filterKeyword = els.searchInput.value.trim();
    renderNotesPane();
  });

  // 搜索图标 → 展开筛选行（05 设计稿：列表头只留一个 ⌕，不常驻输入框）
  els.searchToggle?.addEventListener('click', () => {
    if (!els.searchRow) return;
    const show = els.searchRow.hidden;
    els.searchRow.hidden = !show;
    if (show) els.searchInput?.focus();
    else if (filterKeyword) {
      filterKeyword = '';
      if (els.searchInput) els.searchInput.value = '';
      renderNotesPane();
    }
  });

  // 正文输入 → 预览节流刷新 + 自动保存计时 + 底部字数
  els.source?.addEventListener('input', () => {
    schedulePreview();
    markDirty();
    updateDocFoot();
  });

  // 标题输入
  els.titleInput?.addEventListener('input', () => {
    markDirty();
  });

  // 元数据变化
  els.tagSelect?.addEventListener('change', () => {
    const appData = window.__wrAppData?.() || {};
    const subs = appData.sub_tags?.[els.tagSelect.value] || [];
    fillSelect(els.subTagSelect, subs, '', '(无子项目)');
    markDirty();
    updateMetaToggle();
  });
  els.subTagSelect?.addEventListener('change', () => {
    markDirty();
    updateMetaToggle();
  });
  els.typeSelect?.addEventListener('change', () => {
    markDirty();
    updateMetaToggle();
  });

  // 分类折叠行
  els.metaToggle?.addEventListener('click', () => {
    state.metaOpen = !state.metaOpen;
    updateMetaToggle();
  });

  // 新建（列表头 ＋ / 空态主按钮）
  els.newBtn?.addEventListener('click', async () => {
    if (state.dirty) {
      const ok = await confirmDiscard();
      if (!ok) return;
    }
    createNewNote();
  });

  els.emptyNewBtn?.addEventListener('click', async () => {
    if (state.dirty) {
      const ok = await confirmDiscard();
      if (!ok) return;
    }
    createNewNote();
  });

  els.deleteBtn?.addEventListener('click', () => {
    closeMenu();
    void deleteCurrentNote();
  });

  // ⋯ 菜单里的「打开文件夹」与列表头的 ⌂ 是同一个动作
  els.folderBtnMenu?.addEventListener('click', () => {
    closeMenu();
    void openNotesFolderSafe();
  });

  els.externalBtn?.addEventListener('click', async () => {
    closeMenu();
    // 未保存的改动先落盘，避免外部编辑器打开的是旧内容
    if (state.dirty) {
      const ok = await saveCurrentNote({ silent: true });
      if (!ok) {
        setStatus('请先保存再外部打开', 'warn');
        return;
      }
    }
    if (!state.doc?.abs_path) {
      setStatus('文件尚未写入磁盘', 'warn');
      return;
    }
    const ok = await openInExternalEditor(state.doc.abs_path, state.externalEditor);
    setStatus(ok ? `已在 ${state.externalEditor.name} 中打开` : '外部打开失败', ok ? '' : 'error');
  });

  els.folderBtn?.addEventListener('click', () => void openNotesFolderSafe());

  // ⋯ 菜单开关 + 点外部关闭
  els.moreBtn?.addEventListener('click', event => {
    event.stopPropagation();
    toggleMenu();
  });
  document.addEventListener('mousedown', event => {
    if (!state.menuOpen) return;
    if (els.menu?.contains(event.target) || els.moreBtn?.contains(event.target)) return;
    closeMenu();
  });

  // 视图三态（source / preview / split）
  els.view?.querySelectorAll('.nt-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      void savePanePref(btn.dataset.paneOpt);
    });
  });

  // 返回记录（R09）
  els.backBtn?.addEventListener('click', goBackToRecord);

  // 关联记录行：chips / 解除 / ＋挂到 / 选择器，全部委托在一个容器上
  els.linkRow?.addEventListener('click', async event => {
    const unlink = event.target.closest('[data-unlink-id]');
    if (unlink) {
      event.stopPropagation();
      await detachRecord(Number(unlink.dataset.unlinkId));
      return;
    }
    if (event.target.closest('[data-link-add]')) {
      // 再点一次＝收起选择器
      if (state.pickerOpen) {
        closePicker();
      } else {
        state.pickerOpen = true;
        renderLinkRow();
        const input = els.linkRow.querySelector('[data-picker-input]');
        input?.focus();
        input?.addEventListener('input', () => void renderPickerResults(input.value));
        input?.addEventListener('keydown', async ev => {
          if (ev.key === 'Escape') {
            ev.stopPropagation();
            closePicker();
            return;
          }
          if (ev.key !== 'Enter') return;
          const first = els.linkRow.querySelector('[data-pick-id]');
          if (first) await attachRecord(Number(first.dataset.pickId));
        });
      }
      return;
    }
    if (event.target.closest('[data-pick-id]')) {
      await attachRecord(Number(event.target.closest('[data-pick-id]').dataset.pickId));
      return;
    }
    if (event.target.closest('[data-note-picker]')) return; // 选择器内部点击不外溢
    if (event.target.closest('.nt-link-chip.is-dead')) return; // 已删除记录占位：连点也无动作（R06）
    const chip = event.target.closest('.nt-link-chip[data-record-id]');
    if (chip) {
      await openRecordChip(Number(chip.dataset.recordId));
    }
  });

  // Esc 优先级：选择器 > 菜单 > 返回记录。抽屉开着时不动（抽屉自己管 Esc）。
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!els.view || els.view.style.display === 'none') return;
    if (state.pickerOpen) {
      event.preventDefault();
      closePicker();
      return;
    }
    if (state.menuOpen) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (state.origin) {
      event.preventDefault();
      void (async () => {
        const drawer = await import('./rowDrawer.js');
        if (drawer.isDrawerOpen?.()) return;
        goBackToRecord();
      })();
    }
  });

  // 快捷键：Ctrl+S 保存，Ctrl+N 新建
  els.source?.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveCurrentNote();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      createNewNote();
      return;
    }
    // Tab 插入两个空格而不是切走焦点
    if (event.key === 'Tab') {
      event.preventDefault();
      const el = event.target;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      el.value = `${el.value.slice(0, start)}  ${el.value.slice(end)}`;
      el.selectionStart = el.selectionEnd = start + 2;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

async function openNotesFolderSafe() {
  const { openNotesFolder } = await import('./notesStore.js');
  const path = await openNotesFolder();
  if (path) setStatus(`笔记目录：${path}`);
}

/** 点关联 chip：抽屉盖在笔记页上，关闭抽屉后仍停在本笔记（R03）。 */
async function openRecordChip(recordId) {
  try {
    const drawer = await import('./rowDrawer.js');
    drawer.openRowDrawer({ recordId });
  } catch (error) {
    console.error('打开记录失败:', error);
    setStatus('打开记录失败', 'error');
  }
}

/** 导出当前是否有未保存内容，供路由切换时判断。 */
export function hasUnsavedChanges() {
  return state.dirty;
}

/** 路由离开笔记页时的钩子。 */
export async function flushBeforeLeave() {
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  if (state.dirty) {
    await saveCurrentNote({ silent: true });
  }
}
