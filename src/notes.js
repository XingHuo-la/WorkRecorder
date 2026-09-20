// ==========================================
// 「完整录入 → 笔记」表单
//
// 这里只负责把表单内容写成 .md 文件（文件优先）。
// 笔记的浏览与编辑在 notesEditor.js 里。
//
// 说明：保留旧文件名的目的是让 index.html 里的表单结构不用大改，
// 但内部已经完全不碰 SQLite 的 notes 表。
// ==========================================

import { appData, dbExecute } from './data.js';
import { escapeHtml } from './htmlUtils.js';
import { writeNote, ensureNotesRoot } from './notesStore.js';

const NOTE_TYPES = {
  idea: '想法',
  problem: '问题',
  source: '资料',
  decision: '决策',
  method: '方法',
  review: '复盘'
};

function nowString() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function getSelectedValue(select, newInput) {
  if (!select) return '';
  return select.value === 'NEW' ? (newInput?.value.trim() || '') : select.value;
}

function deriveTitle(content, noteType) {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (!clean) return NOTE_TYPES[noteType] || '笔记';
  return clean.length > 28 ? `${clean.substring(0, 28)}...` : clean;
}

/**
 * 初始化「完整录入」里的笔记表单。
 */
export function initNotesModule() {
  const typeSelect = document.getElementById('note-type-select');
  const tagSelect = document.getElementById('note-tag-select');
  const tagNewInput = document.getElementById('note-tag-new');
  const subSelect = document.getElementById('note-sub-tag-select');
  const subNewInput = document.getElementById('note-sub-tag-new');
  const contentInput = document.getElementById('note-content-input');
  const actionInput = document.getElementById('note-action-input');
  const actionField = document.querySelector('.note-action-field');
  const actionToggleBtn = document.getElementById('toggle-note-action-btn');
  const saveBtn = document.getElementById('add-note-btn');

  if (!typeSelect || !tagSelect || !subSelect || !contentInput || !saveBtn) return;

  window.renderNoteTags = () => {
    const activeTags = appData?.settings?.active_tags || appData?.tags || [];
    const all = [DEFAULT_TAG_FALLBACK, ...activeTags.filter(t => t !== DEFAULT_TAG_FALLBACK)];
    tagSelect.innerHTML = all
      .map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)
      .join('') + '<option value="NEW">➕ 新建主分类...</option>';

    tagNewInput.style.display = tagSelect.value === 'NEW' ? 'block' : 'none';
    window.renderNoteSubTags();
  };

  window.renderNoteSubTags = () => {
    const mainTag = getSelectedValue(tagSelect, tagNewInput);
    subSelect.innerHTML = '<option value="">(无子项目)</option>';
    if (mainTag && appData?.sub_tags?.[mainTag]) {
      appData.sub_tags[mainTag].forEach(t => {
        subSelect.innerHTML += `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`;
      });
    }
    subSelect.innerHTML += '<option value="NEW">➕ 新建子项目...</option>';
  };

  tagSelect.addEventListener('change', () => {
    tagNewInput.style.display = tagSelect.value === 'NEW' ? 'block' : 'none';
    if (tagSelect.value === 'NEW') tagNewInput.focus();
    subNewInput.style.display = 'none';
    window.renderNoteSubTags();
  });
  tagNewInput.addEventListener('input', window.renderNoteSubTags);
  subSelect.addEventListener('change', () => {
    subNewInput.style.display = subSelect.value === 'NEW' ? 'block' : 'none';
    if (subSelect.value === 'NEW') subNewInput.focus();
  });

  document.querySelectorAll('.note-chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.note-chip-btn').forEach(item => item.classList.remove('active'));
      btn.classList.add('active');
      typeSelect.value = btn.dataset.noteType;
    });
  });

  if (actionToggleBtn && actionField) {
    actionToggleBtn.addEventListener('click', () => {
      const isHidden = actionField.style.display === 'none';
      actionField.style.display = isHidden ? 'block' : 'none';
      actionToggleBtn.classList.toggle('active', isHidden);
      if (isHidden) actionInput.focus();
    });
  }

  saveBtn.addEventListener('click', async () => {
    const content = contentInput.value.trim();
    if (!content) { alert('⚠️ 笔记内容不能为空'); return; }

    const noteType = typeSelect.value;
    const finalTag = getSelectedValue(tagSelect, tagNewInput) || DEFAULT_TAG_FALLBACK;
    const finalSub = getSelectedValue(subSelect, subNewInput);
    const actionText = actionInput.value.trim();
    const timestamp = nowString();

    // 新分类先登记到标签库，笔记目录由写入时按分类自动创建
    if (tagSelect.value === 'NEW' && finalTag !== DEFAULT_TAG_FALLBACK) {
      await dbExecute('INSERT OR IGNORE INTO tags (name, is_active) VALUES (?, ?)', [finalTag, true]);
    }
    if (finalSub && subSelect.value === 'NEW') {
      await dbExecute('INSERT INTO sub_tags (main_tag, name) VALUES (?, ?)', [finalTag, finalSub]);
    }

    try {
      await ensureNotesRoot();
      await writeNote({
        title: deriveTitle(content, noteType),
        content,
        note_type: noteType,
        status: 'usable',
        tag: finalTag,
        sub_tag: finalSub,
        created_at: timestamp,
        updated_at: timestamp,
        rel_path: ''
      });
    } catch (error) {
      console.error('保存笔记失败:', error);
      alert(`保存笔记失败：${error.message || error}`);
      return;
    }

    // 可选的后续待办
    if (actionText) {
      await dbExecute(
        'INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [actionText, false, finalTag, finalSub, `由${NOTE_TYPES[noteType]}笔记转化`, '', '', '', '', '', '']
      );
    }

    contentInput.value = '';
    actionInput.value = '';
    if (actionField) actionField.style.display = 'none';
    if (actionToggleBtn) actionToggleBtn.classList.remove('active');

    window.renderNoteTags();
    if (typeof window.__wrRefreshNotes === 'function') await window.__wrRefreshNotes();
    if (typeof window.renderTodoList === 'function') window.renderTodoList();
    else import('./todo.js').then(m => m.renderTodoList());
    if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
    if (window.renderLogTags) window.renderLogTags();
    if (window.renderTodoTags) window.renderTodoTags();
    if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();
  });

  window.renderNoteTags();
}

const DEFAULT_TAG_FALLBACK = '未分类';

/**
 * 兼容旧调用点：笔记列表已迁移到 notesEditor，这里转发过去。
 * @deprecated 请改用 notesEditor 的 refreshNotesCache()
 */
export function renderNotesList() {
  if (typeof window.__wrRefreshNotes === 'function') {
    return window.__wrRefreshNotes();
  }
  return Promise.resolve([]);
}
