import { appData, dbExecute, loadData } from './data.js';
import { renderTodoList } from './todo.js';
import { escapeHtml, textWithLineBreaks } from './htmlUtils.js';

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
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const sec = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`;
}

function getSelectedValue(select, newInput) {
  if (!select) return "";
  return select.value === 'NEW' ? (newInput?.value.trim() || "") : select.value;
}

function deriveTitle(content, noteType) {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (!clean) return NOTE_TYPES[noteType] || '笔记';
  return clean.length > 28 ? `${clean.substring(0, 28)}...` : clean;
}

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
    tagSelect.innerHTML = '';
    const activeTags = appData.settings?.active_tags || appData.tags;
    activeTags.forEach(t => {
      const safeTag = escapeHtml(t);
      tagSelect.innerHTML += `<option value="${safeTag}">${safeTag}</option>`;
    });
    tagSelect.innerHTML += `<option value="NEW">➕ 新建主分类...</option>`;

    if (activeTags.length === 0 || tagSelect.value === 'NEW') {
      tagSelect.value = 'NEW';
      tagNewInput.style.display = 'block';
    } else {
      tagNewInput.style.display = 'none';
    }
    window.renderNoteSubTags();
  };

  window.renderNoteSubTags = () => {
    const mainTag = getSelectedValue(tagSelect, tagNewInput);
    subSelect.innerHTML = '<option value="">(无子项目)</option>';
    if (mainTag && appData.sub_tags?.[mainTag]) {
      appData.sub_tags[mainTag].forEach(t => {
        const safeSub = escapeHtml(t);
        subSelect.innerHTML += `<option value="${safeSub}">${safeSub}</option>`;
      });
    }
    subSelect.innerHTML += `<option value="NEW">➕ 新建子项目...</option>`;
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
    if (!content) { alert("⚠️ 笔记内容不能为空"); return; }

    const noteType = typeSelect.value;
    const finalTag = getSelectedValue(tagSelect, tagNewInput);
    const finalSub = getSelectedValue(subSelect, subNewInput);
    const actionText = actionInput.value.trim();
    const timestamp = nowString();

    if (!finalTag) { alert("⚠️ 请输入或选择主分类"); return; }
    if (tagSelect.value === 'NEW') await dbExecute("INSERT OR IGNORE INTO tags (name, is_active) VALUES (?, ?)", [finalTag, true]);
    if (finalSub && subSelect.value === 'NEW') await dbExecute("INSERT INTO sub_tags (main_tag, name) VALUES (?, ?)", [finalTag, finalSub]);

    await dbExecute(
      "INSERT INTO notes (title, content, note_type, status, tag, sub_tag, source_type, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [deriveTitle(content, noteType), content, noteType, "usable", finalTag, finalSub, "manual", "", timestamp, timestamp]
    );

    if (actionText) {
      await dbExecute(
        "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [actionText, false, finalTag, finalSub, `由${NOTE_TYPES[noteType]}笔记转化`, "", "", "", "", "", ""]
      );
    }

    contentInput.value = "";
    actionInput.value = "";
    if (actionField) actionField.style.display = 'none';
    if (actionToggleBtn) actionToggleBtn.classList.remove('active');
    await loadData();
    window.renderNoteTags();
    renderNotesList();
    renderTodoList();
    if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
    if (window.renderLogTags) window.renderLogTags();
    if (window.renderTodoTags) window.renderTodoTags();
  });

  window.renderNoteTags();
  renderNotesList();
}

export function renderNotesList() {
  const container = document.getElementById('notes-list-container');
  if (!container) return;
  const notes = appData.notes || [];

  if (notes.length === 0) {
    container.innerHTML = "<div class='empty-state'><strong>还没有笔记</strong><span>记录想法、问题、资料、决策或复盘，让工作过程沉淀下来。</span></div>";
    return;
  }

  container.innerHTML = notes.slice(0, 12).map(note => {
    const typeText = NOTE_TYPES[note.note_type] || note.note_type || "笔记";
    const safeTitle = escapeHtml(note.title || deriveTitle(note.content, note.note_type));
    const safeTag = escapeHtml(note.tag);
    const safeSub = escapeHtml(note.sub_tag);
    const safeUpdated = escapeHtml(note.updated_at || note.created_at);
    const subHtml = note.sub_tag ? `<span class="note-chip">📁 ${safeSub}</span>` : "";

    return `
      <details class="glass-accordion note-card border-primary">
        <summary class="log-summary">
          <span class="note-type">${typeText}</span>
          <span class="log-text"><b>[${safeTag}]</b> ${safeTitle} ${subHtml}</span>
          <span class="note-time">${safeUpdated.substring(0, 16)}</span>
        </summary>
        <div class="expanded-content">
          <div class="note-content">${textWithLineBreaks(note.content)}</div>
          <div style="display:flex; justify-content:flex-end; gap:10px; border-top:1px dashed var(--border-light); padding-top:10px; margin-top:12px;">
            <button class="icon-btn note-to-todo-btn" data-id="${note.id}" style="margin:0;">转为待办</button>
            <button class="icon-btn del-note-btn" data-id="${note.id}" style="margin:0;">删除</button>
          </div>
        </div>
      </details>
    `;
  }).join('');

  container.querySelectorAll('.note-to-todo-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = parseInt(btn.dataset.id);
      const note = notes.find(n => n.id === id);
      if (!note) return;
      await dbExecute(
        "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [note.title || deriveTitle(note.content, note.note_type), false, note.tag, note.sub_tag, note.content, "", "", "", "", "", ""]
      );
      await loadData();
      renderTodoList();
      if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
      alert("已生成待办");
    });
  });

  container.querySelectorAll('.del-note-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = parseInt(btn.dataset.id);
      if (!confirm("确定删除这条笔记吗？")) return;
      await dbExecute("DELETE FROM notes WHERE id=?", [id]);
      await loadData();
      renderNotesList();
      if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
    });
  });
}
