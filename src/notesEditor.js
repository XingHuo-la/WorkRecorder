// ==========================================
// 笔记编辑器
//
// 形态：左侧 Markdown 源码，右侧实时预览。
// 当前版本不支持语法速插（工具栏输入）。工具栏按钮仅切换预览主题与外部编辑器。
// 依赖渲染能力由 markdown.js 提供，全部本地 vendored。
// ==========================================

import { renderMarkdown, preloadRenderer, detectDarkTheme, extractExcerpt } from './markdown.js';
import { escapeHtml } from './htmlUtils.js';
import { logToFile } from './logger.js';
import {
  readNote,
  writeNote,
  deleteNote
} from './notesStore.js';
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
  onRequestClose: null
};

let els = {};

function cacheElements() {
  els = {
    view: document.getElementById('subview-notes'),
    list: document.getElementById('notes-list-pane'),
    listMeta: document.getElementById('notes-list-meta'),
    editor: document.getElementById('note-editor-pane'),
    empty: document.getElementById('note-editor-empty'),
    titleInput: document.getElementById('note-title-input'),
    source: document.getElementById('note-source-input'),
    preview: document.getElementById('note-preview'),
    status: document.getElementById('note-editor-status'),
    tagSelect: document.getElementById('note-editor-tag'),
    subTagSelect: document.getElementById('note-editor-subtag'),
    typeSelect: document.getElementById('note-editor-type'),
    newBtn: document.getElementById('note-new-btn'),
    saveBtn: document.getElementById('note-save-btn'),
    deleteBtn: document.getElementById('note-delete-btn'),
    externalBtn: document.getElementById('note-open-external-btn'),
    folderBtn: document.getElementById('note-open-folder-btn'),
    searchInput: document.getElementById('notes-filter-input'),
    splitToggle: document.getElementById('note-split-toggle')
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
    const excerpt = extractExcerpt(note.content, 70);
    const updated = (note.updated_at || note.created_at || '').substring(0, 16);
    const tagBits = [note.tag, note.sub_tag].filter(Boolean);
    const tagHtml = tagBits.length
      ? `<span class="note-list-tag">${escapeHtml(tagBits.join(' / '))}</span>`
      : '<span class="note-list-tag is-muted">未分类</span>';

    return `
      <button type="button" class="note-list-item${isActive ? ' is-active' : ''}" data-rel="${escapeHtml(note.rel_path)}">
        <div class="note-list-title">${escapeHtml(note.title || '未命名笔记')}</div>
        ${excerpt ? `<div class="note-list-excerpt">${escapeHtml(excerpt)}</div>` : ''}
        <div class="note-list-foot">
          ${tagHtml}
          <span class="note-list-time">${escapeHtml(updated)}</span>
        </div>
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

  if (!doc) {
    setEditorVisible(false);
    renderNotesPane();
    return;
  }

  setEditorVisible(true);
  if (els.titleInput) els.titleInput.value = doc.title || '';
  if (els.source) els.source.value = doc.content || '';
  refreshMetaControls();
  refreshPreview();
  setStatus('已加载');
  renderNotesPane();
}

/**
 * 打开一篇笔记。
 */
export async function openNote(relPath) {
  if (state.dirty) {
    const ok = await confirmDiscard();
    if (!ok) return;
  }

  const doc = await readNote(relPath);
  if (!doc) {
    setStatus('打开失败', 'error');
    return;
  }
  loadIntoEditor(doc);
}

/** 新建一篇空白笔记（内存态，尚未落盘）。 */
export function createNewNote() {
  const timestamp = nowString();
  const appData = window.__wrAppData?.() || {};
  const defaultTag = appData.tags?.[0] || '未分类';

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
      rel_path: state.doc.rel_path || ''
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
  if (!window.confirm(`确定删除笔记「${title}」吗？\n文件会一并从磁盘删除，此操作不可恢复。`)) {
    return;
  }

  const ok = await deleteNote(state.doc.rel_path);
  if (!ok) {
    setStatus('删除失败', 'error');
    return;
  }

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
  // 列表点击 → 打开笔记
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

  // 正文输入 → 预览节流刷新 + 自动保存计时
  els.source?.addEventListener('input', () => {
    schedulePreview();
    markDirty();
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
  });
  els.subTagSelect?.addEventListener('change', markDirty);
  els.typeSelect?.addEventListener('change', markDirty);

  // 工具栏
  els.newBtn?.addEventListener('click', async () => {
    if (state.dirty) {
      const ok = await confirmDiscard();
      if (!ok) return;
    }
    createNewNote();
  });

  els.saveBtn?.addEventListener('click', () => saveCurrentNote());

  els.deleteBtn?.addEventListener('click', deleteCurrentNote);

  els.externalBtn?.addEventListener('click', async () => {
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

  els.folderBtn?.addEventListener('click', async () => {
    const { openNotesFolder } = await import('./notesStore.js');
    const path = await openNotesFolder();
    if (path) setStatus(`笔记目录：${path}`);
  });

  // 分栏 / 单栏切换
  els.splitToggle?.addEventListener('click', () => {
    const enabled = els.view.classList.toggle('is-single-pane');
    els.splitToggle.textContent = enabled ? '显示预览' : '隐藏预览';
    els.splitToggle.setAttribute('aria-pressed', String(enabled));
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

  // 窗口关闭前兜底保存
  window.addEventListener('beforeunload', () => {
    if (!state.dirty || !state.doc) return;
    // beforeunload 里无法 await，只能用同步手段提示
    // 这里依赖自动保存已经落盘，因此不再阻塞关闭
  });
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
