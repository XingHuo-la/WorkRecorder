import { appData, dbExecute, dbQuery, getTodayString, loadData, DEFAULT_TAG } from './data.js';
import { escapeHtml } from './htmlUtils.js';
import { showUndoToast } from './undoToast.js';
import { attachDateTimePicker, createTimeRangePicker } from './timeRangePicker.js';
import {
  applyCreatedTodoRelation,
  getCreateParentId,
  renderTaskRelationPickerHtml,
  setupTaskRelationPicker,
  validateTaskRelation
} from './taskRelations.js';

let quickToastTimer = null;
let inboxVisibleLimit = 10;
let quickCaptureBusy = false;
const QUICK_DRAFT_KEY = 'workRecorderQuickDraft';

export function deriveRecordTitle(content) {
  const firstLine = (content || "").replace(/\r\n/g, '\n').split('\n').find(line => line.trim()) || content || "";
  const clean = firstLine.trim().replace(/\s+/g, ' ');
  if (!clean) return "快速记录";
  return clean;
}

function formatInboxTitle(title) {
  const clean = (title || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '快速记录';
  return clean.length > 10 ? `${clean.substring(0, 8)}...` : clean;
}

function formatInboxContent(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 20 ? `${clean.substring(0, 18)}...` : clean;
}

function currentTimeString() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

function resolveQuickMeta() {
  return {
    tag: DEFAULT_TAG,
    subTag: "",
    recordType: 'quick',
    parentId: '',
    relation: { mode: 'independent', targetId: '' },
    plannedTodo: '',
    deadline: '',
    isOverdue: false,
    dateStr: getTodayString(),
    timeStr: currentTimeString(),
    hasManualTime: false
  };
}

async function refreshAfterQuickSave() {
  await loadData();
  import('./log.js').then(m => m.renderHistoryList());
  renderInboxRecords();
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
  import('./todo.js').then(m => m.renderTodoList());
  // 笔记列表现已由 notesEditor 管理
  if (typeof window.__wrRefreshNotes === 'function') window.__wrRefreshNotes();
  if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();
}

function showQuickToast(message, tone = 'success') {
  const toast = document.getElementById('quick-capture-toast');
  if (!toast) return;
  toast.innerText = message;
  toast.dataset.tone = tone;
  toast.classList.add('show');
  if (quickToastTimer) clearTimeout(quickToastTimer);
  quickToastTimer = setTimeout(() => {
    toast.classList.remove('show');
    toast.innerText = '';
  }, 2200);
}

async function saveAsQuickLog(content, title, meta) {
  return dbExecute(
    "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue, status, record_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [meta.dateStr, meta.timeStr, title, meta.tag, meta.subTag, content, "", "", meta.deadline, meta.isOverdue, "unprocessed", "quick"]
  );
}

async function saveAsProcessedLog(content, title, meta) {
  return dbExecute(
    "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue, status, record_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [meta.dateStr, meta.timeStr, title, meta.tag, meta.subTag, content, "", "", meta.deadline, meta.isOverdue, "processed", "log"]
  );
}

async function saveAsTodo(content, title, meta) {
  const relationCheck = validateTaskRelation(meta.relation);
  if (!relationCheck.ok) {
    alert(relationCheck.message);
    return false;
  }
  const parentId = getCreateParentId(relationCheck.relation);
  meta.parentId = parentId;
  const createdTodoId = await insertAndReturnId(
    "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [title, false, meta.tag, meta.subTag, content, "", meta.deadline, meta.hasManualTime ? `${meta.dateStr} ${meta.timeStr}` : "", meta.deadline, parentId, ""]
  );
  await applyCreatedTodoRelation(createdTodoId, relationCheck.relation);
  return createdTodoId;
}

async function saveAsNote(content, title, meta, noteType = 'idea') {
  const now = `${meta.dateStr} ${meta.timeStr}`;
  // 笔记改为「文件优先」：写 .md 文件，不再进 notes 表
  const { writeNote } = await import('./notesStore.js');
  return writeNote({
    title,
    content,
    note_type: noteType,
    status: 'usable',
    tag: meta.tag,
    sub_tag: meta.subTag,
    created_at: now,
    updated_at: now,
    rel_path: ''
  });
}

async function createFollowUpTodo(content, meta) {
  if (!meta.plannedTodo) return;
  const relationCheck = validateTaskRelation(meta.relation);
  if (!relationCheck.ok) {
    alert(relationCheck.message);
    return;
  }
  const parentId = getCreateParentId(relationCheck.relation);
  meta.parentId = parentId;
  const createdTodoId = await insertAndReturnId(
    "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [meta.plannedTodo, false, meta.tag, meta.subTag, `来自快速记录：${content}`, "", meta.deadline, "", meta.deadline, meta.parentId || "", ""]
  );
  await applyCreatedTodoRelation(createdTodoId, relationCheck.relation);
}

function clearQuickInputs(input) {
  if (input) {
    input.value = "";
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  localStorage.removeItem(QUICK_DRAFT_KEY);
  const draftStatus = document.getElementById('quick-capture-draft-status');
  if (draftStatus) draftStatus.textContent = '';
}

function isInboxRecord(log) {
  return log && (log.status === 'unprocessed' || log.record_type === 'quick' || log.record_type === 'record');
}

function getLogDateTime(log) {
  return `${log.date || getTodayString()} ${log.time || '00:00:00'}`;
}

export function loadInboxRecords(limit = 10) {
  if (!appData?.logs) return [];
  return Object.entries(appData.logs)
    .flatMap(([date, logs]) => (logs || []).map(log => ({ ...log, date })))
    .filter(isInboxRecord)
    .sort((a, b) => getLogDateTime(b).localeCompare(getLogDateTime(a)))
    .slice(0, limit);
}

async function refreshAfterInboxAction() {
  await loadData();
  renderInboxRecords();
  import('./log.js').then(m => m.renderHistoryList());
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
  import('./todo.js').then(m => m.renderTodoList());
  // 笔记列表现已由 notesEditor 管理
  if (typeof window.__wrRefreshNotes === 'function') window.__wrRefreshNotes();
  if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();
}

async function insertAndReturnId(query, params) {
  const rows = await dbQuery(`${query} RETURNING id`, params);
  return rows?.[0]?.id || null;
}

function getQuickConvertMessage(targetType) {
  if (targetType === 'todo') return '已转为待办。';
  if (targetType === 'note') return '已转为笔记。';
  if (targetType === 'log') return '已转为流水。';
  if (targetType === 'problem') return '已转为问题笔记。';
  if (targetType === 'conclusion') return '已转为结论笔记。';
  return '已完成转换。';
}

function formatDateOnly(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getThisWeekEnd(date = new Date()) {
  const day = date.getDay();
  return addDays(date, day === 0 ? 0 : 7 - day);
}

function buildTodoPath(todo, byId) {
  const names = [todo.task];
  let current = todo;
  const seen = new Set([todo.id]);
  while (current.parent_id && byId.has(current.parent_id) && !seen.has(current.parent_id)) {
    current = byId.get(current.parent_id);
    seen.add(current.id);
    names.unshift(current.task);
  }
  return names.join(' / ');
}

function renderTagOptions(selectedTag = DEFAULT_TAG) {
  const baseTags = [DEFAULT_TAG, ...(appData?.settings?.active_tags || appData?.tags || []).filter(tag => tag !== DEFAULT_TAG)];
  const tags = selectedTag && !baseTags.includes(selectedTag) ? [...baseTags, selectedTag] : baseTags;
  return tags.map(tag => {
    const safeTag = escapeHtml(tag);
    const selected = tag === selectedTag ? ' selected' : '';
    return `<option value="${safeTag}"${selected}>${safeTag}</option>`;
  }).join('');
}

function renderParentTodoOptions(selectedParentId = '') {
  const byId = new Map((appData?.todos || []).map(todo => [todo.id, todo]));
  const selectedId = String(selectedParentId || '');
  const options = [`<option value=""${selectedId ? '' : ' selected'}>无上级任务</option>`];
  (appData?.todos || [])
    .filter(todo => !todo.done)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id)
    .forEach(todo => {
      const selected = String(todo.id) === selectedId ? ' selected' : '';
      options.push(`<option value="${todo.id}"${selected}>${escapeHtml(buildTodoPath(todo, byId))}</option>`);
    });
  return options.join('');
}

function getActiveTagSet() {
  return new Set(appData?.settings?.active_tags || appData?.tags || []);
}

function getTagSuggestions(keyword = '') {
  const activeSet = getActiveTagSet();
  const query = keyword.trim().toLowerCase();
  return (appData?.tags || [])
    .filter(Boolean)
    .map(name => ({ name, active: activeSet.has(name) }))
    .filter(item => !query || item.name.toLowerCase().includes(query))
    .sort((a, b) => {
      if (a.name === DEFAULT_TAG) return -1;
      if (b.name === DEFAULT_TAG) return 1;
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    })
    .slice(0, 10);
}

async function ensureTagAndSubTag(tag, subTag) {
  const finalTag = tag || DEFAULT_TAG;
  if (finalTag && !(appData?.tags || []).includes(finalTag)) {
    await dbExecute("INSERT OR IGNORE INTO tags (name, is_active) VALUES (?, ?)", [finalTag, true]);
  }
  if (subTag && !(appData?.sub_tags?.[finalTag] || []).includes(subTag)) {
    await dbExecute("INSERT OR IGNORE INTO sub_tags (main_tag, name) VALUES (?, ?)", [finalTag, subTag]);
  }
}

function renderTagPickerHtml(prefix, tag = '', subTag = '') {
  return `
    <div class="form-row inbox-tag-picker-row">
      <div class="field-col inbox-tag-field">
        <label class="field-label">主分类</label>
        <input type="text" id="${prefix}-tag-input" class="hero-input inbox-tag-search-input" value="${escapeHtml(tag || '')}" autocomplete="off" placeholder="未选择则保持未分类" />
        <div id="${prefix}-tag-results" class="tag-search-results" role="listbox"></div>
      </div>
      <div class="field-col inbox-sub-tag-field">
        <label class="field-label">子项目</label>
        <input type="text" id="${prefix}-sub-input" class="hero-input" value="${escapeHtml(subTag || '')}" autocomplete="off" placeholder="可选，输入或选择子项目" />
        <div id="${prefix}-sub-results" class="tag-search-results" role="listbox"></div>
      </div>
    </div>
  `;
}

function setupTagPicker(body, prefix) {
  const tagInput = body.querySelector(`#${prefix}-tag-input`);
  const tagResults = body.querySelector(`#${prefix}-tag-results`);
  const subInput = body.querySelector(`#${prefix}-sub-input`);
  const subResults = body.querySelector(`#${prefix}-sub-results`);
  if (!tagInput || !tagResults || !subInput || !subResults) return;

  let selectedTagIndex = -1;
  let selectedSubIndex = -1;

  const renderTagResults = () => {
    const suggestions = getTagSuggestions(tagInput.value);
    selectedTagIndex = Math.min(selectedTagIndex, suggestions.length - 1);
    tagResults.innerHTML = suggestions.length ? suggestions.map((item, index) => `
      <button type="button" class="tag-search-option${index === selectedTagIndex ? ' active' : ''}" data-value="${escapeHtml(item.name)}">
        <span>${escapeHtml(item.name)}</span>
        <em>${item.active ? '活跃' : '非活跃'}</em>
      </button>
    `).join('') : '<div class="tag-search-empty">没有匹配标签，保存后将新建</div>';
    tagResults.classList.add('show');
  };

  const renderSubResults = () => {
    const mainTag = tagInput.value.trim() || DEFAULT_TAG;
    const query = subInput.value.trim().toLowerCase();
    const suggestions = (appData?.sub_tags?.[mainTag] || [])
      .filter(item => !query || item.toLowerCase().includes(query))
      .slice(0, 8);
    selectedSubIndex = Math.min(selectedSubIndex, suggestions.length - 1);
    subResults.innerHTML = suggestions.length ? suggestions.map((item, index) => `
      <button type="button" class="tag-search-option${index === selectedSubIndex ? ' active' : ''}" data-value="${escapeHtml(item)}">
        <span>${escapeHtml(item)}</span>
      </button>
    `).join('') : '';
    subResults.classList.toggle('show', suggestions.length > 0);
  };

  const chooseTag = value => {
    tagInput.value = value || DEFAULT_TAG;
    selectedTagIndex = -1;
    tagResults.classList.remove('show');
    renderSubResults();
  };

  const chooseSub = value => {
    subInput.value = value || '';
    selectedSubIndex = -1;
    subResults.classList.remove('show');
  };

  tagInput.addEventListener('focus', renderTagResults);
  tagInput.addEventListener('input', () => {
    selectedTagIndex = -1;
    renderTagResults();
    renderSubResults();
  });
  tagInput.addEventListener('keydown', event => {
    const options = [...tagResults.querySelectorAll('.tag-search-option')];
    if (!options.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedTagIndex = (selectedTagIndex + 1) % options.length;
      renderTagResults();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedTagIndex = selectedTagIndex <= 0 ? options.length - 1 : selectedTagIndex - 1;
      renderTagResults();
    } else if (event.key === 'Enter' && selectedTagIndex >= 0) {
      event.preventDefault();
      chooseTag(options[selectedTagIndex].dataset.value);
    } else if (event.key === 'Escape') {
      tagResults.classList.remove('show');
    }
  });
  tagResults.addEventListener('mousedown', event => {
    const option = event.target.closest('.tag-search-option');
    if (option) {
      event.preventDefault();
      chooseTag(option.dataset.value);
    }
  });

  subInput.addEventListener('focus', renderSubResults);
  subInput.addEventListener('input', () => {
    selectedSubIndex = -1;
    renderSubResults();
  });
  subInput.addEventListener('keydown', event => {
    const options = [...subResults.querySelectorAll('.tag-search-option')];
    if (!options.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedSubIndex = (selectedSubIndex + 1) % options.length;
      renderSubResults();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedSubIndex = selectedSubIndex <= 0 ? options.length - 1 : selectedSubIndex - 1;
      renderSubResults();
    } else if (event.key === 'Enter' && selectedSubIndex >= 0) {
      event.preventDefault();
      chooseSub(options[selectedSubIndex].dataset.value);
    } else if (event.key === 'Escape') {
      subResults.classList.remove('show');
    }
  });
  subResults.addEventListener('mousedown', event => {
    const option = event.target.closest('.tag-search-option');
    if (option) {
      event.preventDefault();
      chooseSub(option.dataset.value);
    }
  });

  body.addEventListener('click', event => {
    if (!event.target.closest('.inbox-tag-field')) tagResults.classList.remove('show');
    if (!event.target.closest('.inbox-sub-tag-field')) subResults.classList.remove('show');
  });
}

function getTagPickerValue(tag) {
  return tag && tag !== DEFAULT_TAG ? tag : '';
}

async function createTodoRecord({ task, tag, subTag = '', detail = '', startAt = '', endAt = '', parentId = '', relation = null }) {
  const relationCheck = relation ? validateTaskRelation(relation) : { ok: true, relation: null };
  if (!relationCheck.ok) {
    alert(relationCheck.message);
    return null;
  }
  const finalParentId = relationCheck.relation ? getCreateParentId(relationCheck.relation) : parentId;
  const createdTodoId = await insertAndReturnId(
    "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [task, false, tag || DEFAULT_TAG, subTag || '', detail || '', '', endAt || '', startAt || '', endAt || '', finalParentId || '', '']
  );
  if (createdTodoId && relationCheck.relation) {
    await applyCreatedTodoRelation(createdTodoId, relationCheck.relation);
  }
  return createdTodoId;
}

async function refreshAfterTodoCreate() {
  await loadData();
  renderInboxRecords();
  import('./todo.js').then(m => m.renderTodoList());
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
  if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();
}

export async function addQuickTodo(inputEl) {
  openQuickDirectModal('todo', inputEl);
}

function getQuickDirectDraft(inputEl) {
  const input = inputEl || document.getElementById('quick-capture-input');
  const content = input?.value.trim() || '';
  return {
    input,
    content,
    title: deriveRecordTitle(content),
    detail: content
  };
}

function renderQuickDirectModalHtml(targetType, draft) {
  const tagPicker = renderTagPickerHtml('quick-direct', '', '');
  if (targetType === 'todo') {
    return `
      <div class="quick-direct-modal">
        <div class="form-group">
          <label class="field-label">待办标题</label>
          <input id="quick-direct-title" class="hero-input" value="${escapeHtml(draft.title)}" />
        </div>
        <div class="form-group">
          <label class="field-label">内容</label>
          <textarea id="quick-direct-detail" class="hero-textarea">${escapeHtml(draft.detail)}</textarea>
        </div>
        <div class="form-group">
          <label class="field-label">任务时间</label>
          <div id="quick-direct-time-picker"></div>
          <input id="quick-direct-start" type="hidden" />
          <input id="quick-direct-end" type="hidden" />
        </div>
        ${tagPicker}
        <div class="form-group">
          ${renderTaskRelationPickerHtml('quick-direct-relation', {
            label: '任务关系',
            defaultMode: 'independent'
          })}
        </div>
      </div>
    `;
  }

  if (targetType === 'note') {
    return `
      <div class="quick-direct-modal">
        <div class="form-group">
          <label class="field-label">笔记标题</label>
          <input id="quick-direct-title" class="hero-input" value="${escapeHtml(draft.title)}" />
        </div>
        <div class="form-group">
          <label class="field-label">内容</label>
          <textarea id="quick-direct-detail" class="hero-textarea">${escapeHtml(draft.detail)}</textarea>
        </div>
        ${tagPicker}
      </div>
    `;
  }

  return `
    <div class="quick-direct-modal">
      <div class="form-group">
        <label class="field-label">流水标题</label>
        <input id="quick-direct-title" class="hero-input" value="${escapeHtml(draft.title)}" />
      </div>
      <div class="form-group">
        <label class="field-label">内容</label>
        <textarea id="quick-direct-detail" class="hero-textarea">${escapeHtml(draft.detail)}</textarea>
      </div>
      <div class="form-group">
        <label class="field-label">发生时间</label>
        <input id="quick-direct-occurred-at" class="hero-input datetime-input" value="${escapeHtml(`${getTodayString()} ${currentTimeString()}`)}" />
      </div>
      ${tagPicker}
    </div>
  `;
}

function setupQuickDirectModal(body, targetType) {
  setupTagPicker(body, 'quick-direct');
  if (targetType === 'todo') {
    const startInput = body.querySelector('#quick-direct-start');
    const endInput = body.querySelector('#quick-direct-end');
    body._taskRelationPicker = setupTaskRelationPicker(body, 'quick-direct-relation');
    createTimeRangePicker(body.querySelector('#quick-direct-time-picker'), {
      allowDateOnly: true,
      minuteStep: 30,
      onChange: (start, end) => {
        if (startInput) startInput.value = start;
        if (endInput) endInput.value = end;
      }
    });
  }
  if (targetType === 'log') {
    setupInboxDateTimeInput(body, '#quick-direct-occurred-at');
  }
  body.querySelector('#quick-direct-title')?.focus();
}

async function confirmQuickDirectModal(body, targetType, draft) {
  const title = body.querySelector('#quick-direct-title')?.value.trim() || '';
  const detail = body.querySelector('#quick-direct-detail')?.value.trim() || '';
  const tag = body.querySelector('#quick-direct-tag-input')?.value.trim() || DEFAULT_TAG;
  const subTag = body.querySelector('#quick-direct-sub-input')?.value.trim() || '';
  if (!title) {
    alert('标题不能为空');
    return false;
  }
  await ensureTagAndSubTag(tag, subTag);

  if (targetType === 'todo') {
    const startAt = body.querySelector('#quick-direct-start')?.value || '';
    const endAt = body.querySelector('#quick-direct-end')?.value || '';
    if (startAt && endAt && Date.parse(startAt) > Date.parse(endAt)) {
      alert('计划开始时间不能晚于结束时间');
      return false;
    }
    const createdTodoId = await createTodoRecord({
      task: title,
      tag,
      subTag,
      detail,
      startAt,
      endAt,
      relation: body._taskRelationPicker?.getValue?.() || { mode: 'independent', targetId: '' }
    });
    if (!createdTodoId) return false;
  } else if (targetType === 'note') {
    const now = `${getTodayString()} ${currentTimeString()}`;
    // 笔记改为「文件优先」：写 .md 文件，不再进 notes 表
    const { writeNote } = await import('./notesStore.js');
    let saved = null;
    try {
      saved = await writeNote({
        title,
        content: detail,
        note_type: 'idea',
        status: 'usable',
        tag,
        sub_tag: subTag,
        created_at: now,
        updated_at: now,
        rel_path: ''
      });
    } catch (error) {
      console.error('保存笔记失败:', error);
      saved = null;
    }
    if (!saved) {
      showQuickToast('保存失败，原内容已保留', 'warning');
      return false;
    }
  } else {
    const parts = parseDateTimeParts(body.querySelector('#quick-direct-occurred-at')?.value);
    const rowsAffected = await dbExecute(
      "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue, status, record_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [parts.dateStr, parts.timeStr, title, tag, subTag, detail, "", "", "", false, "processed", "log"]
    );
    if (!rowsAffected) {
      showQuickToast('保存失败，原内容已保留', 'warning');
      return false;
    }
  }

  clearQuickInputs(draft.input);
  await refreshAfterQuickSave();
  showQuickToast(targetType === 'todo' ? '已转为待办' : targetType === 'note' ? '已转为笔记' : '已记为流水');
  return true;
}

export function openQuickDirectModal(targetType, inputEl) {
  const draft = getQuickDirectDraft(inputEl);
  if (!draft.content) {
    showQuickToast('先写点内容', 'warning');
    draft.input?.focus();
    return;
  }
  const titles = {
    todo: '确认转为待办',
    note: '确认转为笔记',
    log: '确认记为流水'
  };
  const buttons = {
    todo: '保存待办',
    note: '保存笔记',
    log: '保存流水'
  };
  window.showModal(
    titles[targetType] || '确认保存',
    renderQuickDirectModalHtml(targetType, draft),
    body => setupQuickDirectModal(body, targetType),
    body => confirmQuickDirectModal(body, targetType, draft),
    { btnText: buttons[targetType] || '保存' }
  );
}

function renderScheduleTodoModalHtml(defaultTitle, options = {}) {
  const parentTodo = options.parentTodo || null;
  const selectedTag = options.defaultTag || DEFAULT_TAG;
  const selectedSubTag = options.defaultSubTag || '';
  const selectedParentId = options.parentTodoId || '';
  const parentHint = parentTodo
    ? `<div class="schedule-parent-context">上级任务：${escapeHtml(buildTodoPath(parentTodo, new Map((appData?.todos || []).map(todo => [todo.id, todo]))))}</div>`
    : '';
  return `
    <div class="schedule-todo-modal">
      ${parentHint}
      <div class="form-group schedule-title-field">
        <label class="field-label">待办标题</label>
        <input id="schedule-todo-title" class="hero-input" value="${escapeHtml(defaultTitle)}" placeholder="输入待办，例如：整理发布说明" />
      </div>
      <div class="form-group schedule-time-field">
        <label class="field-label">什么时候？</label>
        <div id="schedule-time-range-picker"></div>
      </div>

      <details id="schedule-more-settings" class="schedule-more-settings">
        <summary>更多设置</summary>
        <div class="schedule-settings-group">
          <div class="schedule-settings-title">归属</div>
          <div class="form-row schedule-meta-row">
            <div class="field-col">
              <label class="field-label">主分类</label>
              <select id="schedule-todo-tag" class="hero-input select-hero">${renderTagOptions(selectedTag)}</select>
            </div>
            <div class="field-col">
              <label class="field-label">子项目</label>
              <input id="schedule-todo-sub-tag" class="hero-input" value="${escapeHtml(selectedSubTag)}" placeholder="可选" />
            </div>
          </div>
        </div>
        <div class="form-row schedule-custom-time-row time-range-compatible-fields">
          <div class="field-col">
            <label class="field-label">兼容开始时间</label>
            <input id="schedule-todo-start" class="hero-input datetime-input time-range-compatible-input" placeholder="由时间选择器同步" readonly />
          </div>
          <div class="field-col">
            <label class="field-label">兼容结束/截止时间</label>
            <input id="schedule-todo-end" class="hero-input datetime-input time-range-compatible-input" placeholder="由时间选择器同步" readonly />
          </div>
        </div>
        <div class="form-group">
          <label class="field-label">上级任务</label>
          <select id="schedule-todo-parent" class="hero-input select-hero" style="display:none;">${renderParentTodoOptions(selectedParentId)}</select>
          ${renderTaskRelationPickerHtml('schedule-todo-relation', {
            label: '任务关系',
            defaultMode: selectedParentId ? 'child' : 'independent',
            defaultTargetId: selectedParentId
          })}
        </div>
        <div class="form-group">
          <label class="field-label">详细说明</label>
          <textarea id="schedule-todo-detail" class="hero-textarea" placeholder="可选：补充执行标准、背景或注意事项"></textarea>
        </div>
        <div class="form-group">
          <label class="field-label">下级任务</label>
          <div id="schedule-subtasks" class="schedule-subtasks"></div>
          <div class="schedule-subtask-actions">
            <button id="schedule-add-subtask" type="button" class="btn btn-secondary schedule-add-subtask">快速添加下级任务</button>
            <button id="schedule-full-subtask-info" type="button" class="btn btn-ghost schedule-full-subtask-info">完整添加下级任务</button>
          </div>
          <div class="schedule-modal-hint">下级任务会继承当前待办的主分类、子项目和时间；完整创建可在保存后从任务卡片进入。</div>
        </div>
      </details>
    </div>
  `;
}

function addScheduleSubtaskRow(container, value = '') {
  const row = document.createElement('div');
  row.className = 'schedule-subtask-row';
  row.innerHTML = `
    <input class="hero-input schedule-subtask-input" value="${escapeHtml(value)}" placeholder="下级任务内容" />
    <button type="button" class="icon-btn schedule-remove-subtask">删除</button>
  `;
  row.querySelector('.schedule-remove-subtask').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function setupScheduleTodoModal(body) {
  const startInput = body.querySelector('#schedule-todo-start');
  const endInput = body.querySelector('#schedule-todo-end');
  const titleInput = body.querySelector('#schedule-todo-title');
  const timeRangeContainer = body.querySelector('#schedule-time-range-picker');
  const subtasks = body.querySelector('#schedule-subtasks');
  const addSubtaskBtn = body.querySelector('#schedule-add-subtask');
  const fullSubtaskInfoBtn = body.querySelector('#schedule-full-subtask-info');
  body._taskRelationPicker = setupTaskRelationPicker(body, 'schedule-todo-relation');

  createTimeRangePicker(timeRangeContainer, {
    valueStart: startInput?.value || '',
    valueEnd: endInput?.value || '',
    allowDateOnly: true,
    minuteStep: 30,
    onChange: (start, end) => {
      if (startInput) startInput.value = start;
      if (endInput) endInput.value = end;
      startInput?.dispatchEvent(new Event('change', { bubbles: true }));
      endInput?.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  addSubtaskBtn?.addEventListener('click', () => {
    addScheduleSubtaskRow(subtasks);
    subtasks.lastElementChild?.querySelector('input')?.focus();
  });
  fullSubtaskInfoBtn?.addEventListener('click', () => {
    alert('保存当前待办后，可在任务卡片中使用“完整添加下级任务”。');
  });
  titleInput?.focus();
}

async function confirmScheduleTodo(body, input) {
  const title = body.querySelector('#schedule-todo-title')?.value.trim() || '';
  const tag = body.querySelector('#schedule-todo-tag')?.value.trim() || DEFAULT_TAG;
  const subTag = body.querySelector('#schedule-todo-sub-tag')?.value.trim() || '';
  const startAt = body.querySelector('#schedule-todo-start')?.value.trim() || '';
  const endAt = body.querySelector('#schedule-todo-end')?.value.trim() || '';
  const parentId = body.querySelector('#schedule-todo-parent')?.value.trim() || '';
  const relation = body._taskRelationPicker?.getValue?.() || { mode: parentId ? 'child' : 'independent', targetId: parentId };
  const detail = body.querySelector('#schedule-todo-detail')?.value.trim() || '';
  const childTasks = [...body.querySelectorAll('.schedule-subtask-input')]
    .map(item => item.value.trim())
    .filter(Boolean);

  if (!title) {
    alert('先写待办内容');
    return false;
  }
  if (startAt && endAt && Date.parse(startAt) > Date.parse(endAt)) {
    alert('计划开始时间不能晚于计划结束/截止时间');
    return false;
  }

  const parentTodoId = await createTodoRecord({ task: title, tag, subTag, detail, startAt, endAt, parentId, relation });
  if (!parentTodoId) return false;
  for (const childTask of childTasks) {
    await createTodoRecord({
      task: childTask,
      tag,
      subTag,
      detail: '',
      startAt,
      endAt,
      parentId: parentTodoId
    });
  }

  if (input) clearQuickInputs(input);
  await refreshAfterTodoCreate();
  showQuickToast('已添加待办');
  return true;
}

export function openScheduleTodoModal(inputEl, options = {}) {
  const input = inputEl === undefined ? document.getElementById('quick-capture-input') : inputEl;
  const defaultTitle = (options.defaultTitle || input?.value || '').trim().replace(/\s+/g, ' ');
  window.showModal(
    '安排待办',
    renderScheduleTodoModalHtml(defaultTitle, options),
    setupScheduleTodoModal,
    body => confirmScheduleTodo(body, input),
    { btnText: '保存待办' }
  );
}

function getRecordDetail(record) {
  return record?.detail || record?.text || '';
}

function getRecordTitle(record) {
  return record?.text || deriveRecordTitle(getRecordDetail(record));
}

function storedTitleMatchesFirstLine(storedTitle, firstLine) {
  const stored = (storedTitle || '').trim().replace(/\s+/g, ' ');
  const first = (firstLine || '').trim().replace(/\s+/g, ' ');
  if (!stored || !first) return false;
  if (stored === first) return true;
  if (stored.endsWith('...') && first.startsWith(stored.slice(0, -3))) return true;
  return false;
}

function splitRecordDetail(record) {
  const detail = getRecordDetail(record).replace(/\r\n/g, '\n');
  const lines = detail.split('\n');
  const firstContentIndex = lines.findIndex(line => line.trim());
  if (firstContentIndex < 0) return { body: '', full: '' };

  const firstLine = lines[firstContentIndex];
  const title = getRecordTitle(record);
  const hasBodyLines = lines.length > firstContentIndex + 1;
  if (hasBodyLines && storedTitleMatchesFirstLine(title, firstLine)) {
    return {
      body: lines.slice(firstContentIndex + 1).join('\n'),
      full: detail
    };
  }

  if (!hasBodyLines && storedTitleMatchesFirstLine(title, firstLine)) {
    return { body: '', full: detail };
  }

  return { body: detail, full: detail };
}

function renderInboxActions(extraClass = '') {
  return `
    <div class="inbox-record-actions${extraClass ? ` ${extraClass}` : ''}">
      <button type="button" data-action="read" class="inbox-read-action">阅读全文</button>
      <div class="inbox-convert-menu">
        <button type="button" class="inbox-convert-trigger" data-action="convert">类型转换</button>
        <div class="inbox-convert-panel">
          <button type="button" data-action="todo">转待办</button>
          <button type="button" data-action="note">转笔记</button>
          <button type="button" data-action="log">转流水</button>
        </div>
      </div>
      <button type="button" data-action="project">修改分类</button>
      <button type="button" data-action="edit">编辑</button>
    </div>
  `;
}

function getRecordHighlights(text) {
  const labels = [
    ['重点', 'highlight'],
    ['下一步', 'next'],
    ['问题', 'problem'],
    ['决策', 'decision'],
    ['结论', 'conclusion']
  ];
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = labels.find(([label]) => line.startsWith(`${label}：`) || line.startsWith(`${label}:`));
      if (!match) return null;
      return { type: match[1], label: match[0], text: line.replace(new RegExp(`^${match[0]}[：:]\\s*`), '').trim() };
    })
    .filter(item => item?.text);
}

function openRecordReader(record) {
  const overlay = document.getElementById('record-reader-overlay');
  const titleEl = document.getElementById('record-reader-title');
  const kickerEl = document.getElementById('record-reader-kicker');
  const metaEl = document.getElementById('record-reader-meta');
  const highlightsEl = document.getElementById('record-reader-highlights');
  const contentEl = document.getElementById('record-reader-content');
  const actionsEl = document.getElementById('record-reader-actions');
  if (!overlay || !titleEl || !metaEl || !contentEl || !actionsEl || !record) return;

  const title = getRecordTitle(record);
  const detail = getRecordDetail(record);
  const highlights = getRecordHighlights(detail);
  const typeLabel = record.status === 'unprocessed' || record.record_type === 'quick' ? '待整理记录' : '工作记录';
  const meta = [
    typeLabel,
    record.tag || DEFAULT_TAG,
    record.sub_tag || '',
    record.date ? `${record.date} ${(record.time || '').substring(0, 5)}` : ''
  ].filter(Boolean);

  kickerEl.textContent = typeLabel;
  titleEl.textContent = title || '未命名记录';
  metaEl.innerHTML = meta.map(item => `<span>${escapeHtml(item)}</span>`).join('');
  highlightsEl.innerHTML = highlights.length
    ? highlights.map(item => `<div class="reader-highlight reader-highlight-${item.type}"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.text)}</span></div>`).join('')
    : '';
  contentEl.innerHTML = escapeHtml(detail || '没有更多正文。').replace(/\r?\n/g, '<br>');
  actionsEl.innerHTML = `
    <button type="button" class="icon-btn" data-reader-action="todo">转待办</button>
    <button type="button" class="icon-btn" data-reader-action="note">转笔记</button>
    <button type="button" class="icon-btn" data-reader-action="project">修改分类</button>
    <button type="button" class="icon-btn" data-reader-action="edit">编辑</button>
  `;
  actionsEl.querySelectorAll('[data-reader-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.readerAction;
      window.closeRecordReader?.();
      if (action === 'project') openInboxProjectModal(record);
      else if (action === 'edit') openInboxEditModal(record);
      else openQuickConvertModal(record, action);
    });
  });
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  document.getElementById('record-reader-close')?.focus();
}

function setupInboxDateTimeInput(body, selector) {
  const input = body.querySelector(selector);
  if (!input) return;
  attachDateTimePicker(input);
}

function openInboxProjectModal(record) {
  const currentTag = getTagPickerValue(record.tag);
  window.showModal('修改分类', `
    <div class="inbox-modal-note">修改分类不会完成整理，这条内容仍会留在待整理。</div>
    ${renderTagPickerHtml('inbox-project', currentTag, record.sub_tag || '')}
  `, body => {
    setupTagPicker(body, 'inbox-project');
    body.querySelector('#inbox-project-tag-input')?.focus();
  }, async body => {
    const tag = body.querySelector('#inbox-project-tag-input')?.value.trim() || DEFAULT_TAG;
    const subTag = body.querySelector('#inbox-project-sub-input')?.value.trim() || '';
    await ensureTagAndSubTag(tag, subTag);
    await updateQuickRecordProject(record, tag, subTag);
    showQuickToast('分类已更新，这条记录仍在待整理中。');
    return true;
  }, { btnText: '保存分类', themeClass: 'inbox-project-modal' });
}

function openInboxEditModal(record) {
  const detail = getRecordDetail(record);
  const currentTag = getTagPickerValue(record.tag);
  window.showModal('编辑待整理内容', `
    <div class="form-group">
      <label class="field-label">标题</label>
      <input id="inbox-edit-title" class="hero-input" value="${escapeHtml(getRecordTitle(record))}" />
    </div>
    <div class="form-group">
      <label class="field-label">内容</label>
      <textarea id="inbox-edit-detail" class="hero-textarea inbox-edit-detail">${escapeHtml(detail)}</textarea>
    </div>
    ${renderTagPickerHtml('inbox-edit', currentTag, record.sub_tag || '')}
  `, body => {
    setupTagPicker(body, 'inbox-edit');
    body.querySelector('#inbox-edit-detail')?.focus();
  }, async body => {
    const detailValue = body.querySelector('#inbox-edit-detail')?.value.trim() || '';
    const title = body.querySelector('#inbox-edit-title')?.value.trim() || deriveRecordTitle(detailValue);
    const tag = body.querySelector('#inbox-edit-tag-input')?.value.trim() || DEFAULT_TAG;
    const subTag = body.querySelector('#inbox-edit-sub-input')?.value.trim() || '';
    if (!detailValue && !title) {
      alert('内容不能为空');
      return false;
    }
    await ensureTagAndSubTag(tag, subTag);
    await dbExecute("UPDATE logs SET text=?, detail=?, tag=?, sub_tag=? WHERE id=?", [title, detailValue, tag, subTag, record.id]);
    await refreshAfterInboxAction();
    showQuickToast('待整理内容已更新');
    return true;
  }, { btnText: '保存修改' });
}

function renderConvertModalHtml(record, targetType) {
  const title = getRecordTitle(record);
  const detail = getRecordDetail(record);
  const tagPicker = renderTagPickerHtml('inbox-convert', getTagPickerValue(record.tag), record.sub_tag || '');

  if (targetType === 'todo') {
    return `
      <div class="form-group">
        <label class="field-label">待办标题</label>
        <input id="inbox-convert-title" class="hero-input" value="${escapeHtml(title)}" />
      </div>
      <div class="form-group">
        <label class="field-label">详细说明</label>
        <textarea id="inbox-convert-detail" class="hero-textarea inbox-convert-detail">${escapeHtml(detail)}</textarea>
      </div>
      <div class="form-group inbox-convert-time">
        <label class="field-label">任务时长</label>
        <div id="inbox-convert-time-picker"></div>
      </div>
      ${tagPicker}
      <div class="form-group">
        <label class="field-label">上级任务</label>
        <select id="inbox-convert-parent" class="hero-input select-hero" style="display:none;">${renderParentTodoOptions('')}</select>
        ${renderTaskRelationPickerHtml('inbox-convert-relation', {
          label: '任务关系',
          defaultMode: 'independent'
        })}
      </div>
    `;
  }

  if (targetType === 'note' || targetType === 'problem' || targetType === 'conclusion') {
    const defaultNoteType = targetType === 'problem' ? 'problem' : targetType === 'conclusion' ? 'review' : 'idea';
    return `
      <div class="form-group">
        <label class="field-label">笔记标题</label>
        <input id="inbox-convert-title" class="hero-input" value="${escapeHtml(title)}" />
      </div>
      <div class="form-group">
        <label class="field-label">笔记类型</label>
        <select id="inbox-convert-note-type" class="hero-input select-hero">
          <option value="idea"${defaultNoteType === 'idea' ? ' selected' : ''}>想法</option>
          <option value="problem"${defaultNoteType === 'problem' ? ' selected' : ''}>问题</option>
          <option value="source">资料</option>
          <option value="decision">决策</option>
          <option value="method">方法</option>
          <option value="review"${defaultNoteType === 'review' ? ' selected' : ''}>复盘</option>
        </select>
      </div>
      ${tagPicker}
      <div class="form-group">
        <label class="field-label">笔记内容</label>
        <textarea id="inbox-convert-detail" class="hero-textarea">${escapeHtml(detail)}</textarea>
      </div>
      <div class="form-group">
        <label class="field-label">顺手生成待办</label>
        <input id="inbox-convert-followup" class="hero-input" placeholder="可选，例如：整理成行动清单" />
      </div>
    `;
  }

  return `
    <div class="form-group">
      <label class="field-label">流水标题</label>
      <input id="inbox-convert-title" class="hero-input" value="${escapeHtml(title)}" />
    </div>
    <div class="form-row">
      <div class="field-col">
        <label class="field-label">发生时间</label>
        <input id="inbox-convert-occurred-at" class="hero-input datetime-input" value="${escapeHtml(`${record.date || getTodayString()} ${record.time || currentTimeString()}`)}" />
      </div>
      <div class="field-col">
        <label class="field-label">截至时间</label>
        <input id="inbox-convert-deadline" class="hero-input datetime-input" value="${escapeHtml(record.deadline || '')}" placeholder="可选" />
      </div>
    </div>
    ${tagPicker}
    <div class="form-group">
      <label class="field-label">详细说明</label>
      <textarea id="inbox-convert-detail" class="hero-textarea">${escapeHtml(detail)}</textarea>
    </div>
  `;
}

function setupConvertModal(body, targetType) {
  setupTagPicker(body, 'inbox-convert');
  if (targetType === 'todo') {
    body._taskRelationPicker = setupTaskRelationPicker(body, 'inbox-convert-relation');
    const startInput = document.createElement('input');
    const endInput = document.createElement('input');
    startInput.type = 'hidden';
    endInput.type = 'hidden';
    startInput.id = 'inbox-convert-start';
    endInput.id = 'inbox-convert-end';
    body.append(startInput, endInput);
    createTimeRangePicker(body.querySelector('#inbox-convert-time-picker'), {
      allowDateOnly: true,
      minuteStep: 30,
      onChange: (start, end) => {
        startInput.value = start;
        endInput.value = end;
      }
    });
  } else if (targetType === 'log') {
    setupInboxDateTimeInput(body, '#inbox-convert-occurred-at');
    setupInboxDateTimeInput(body, '#inbox-convert-deadline');
  }
  body.querySelector('#inbox-convert-title')?.focus();
}

function parseDateTimeParts(value, fallbackDate = getTodayString(), fallbackTime = currentTimeString()) {
  const raw = (value || '').trim();
  if (!raw) return { dateStr: fallbackDate, timeStr: fallbackTime };
  const [dateStr, timeStr = fallbackTime] = raw.split(' ');
  return { dateStr: dateStr || fallbackDate, timeStr: timeStr || fallbackTime };
}

export function openQuickConvertModal(record, targetType) {
  const titles = {
    todo: '转为待办',
    note: '转为笔记',
    problem: '转为问题笔记',
    conclusion: '转为结论笔记',
    log: '转为流水'
  };
  window.showModal(titles[targetType] || '转换待整理内容', renderConvertModalHtml(record, targetType), body => {
    setupConvertModal(body, targetType);
  }, async body => {
    const title = body.querySelector('#inbox-convert-title')?.value.trim() || '';
    const detail = body.querySelector('#inbox-convert-detail')?.value.trim() || '';
    const tag = body.querySelector('#inbox-convert-tag-input')?.value.trim() || DEFAULT_TAG;
    const subTag = body.querySelector('#inbox-convert-sub-input')?.value.trim() || '';
    if (!title) {
      alert('标题不能为空');
      return false;
    }

    const options = { title, detail, tag, subTag };
    if (targetType === 'todo') {
      options.startAt = body.querySelector('#inbox-convert-start')?.value || '';
      options.endAt = body.querySelector('#inbox-convert-end')?.value || '';
      options.parentId = body.querySelector('#inbox-convert-parent')?.value || '';
      options.relation = body._taskRelationPicker?.getValue?.() || {
        mode: options.parentId ? 'child' : 'independent',
        targetId: options.parentId
      };
      if (options.startAt && options.endAt && Date.parse(options.startAt) > Date.parse(options.endAt)) {
        alert('计划开始时间不能晚于结束时间');
        return false;
      }
    } else if (targetType === 'note' || targetType === 'problem' || targetType === 'conclusion') {
      options.noteType = body.querySelector('#inbox-convert-note-type')?.value || 'idea';
      options.followUpTodo = body.querySelector('#inbox-convert-followup')?.value.trim() || '';
    } else if (targetType === 'log') {
      const parts = parseDateTimeParts(body.querySelector('#inbox-convert-occurred-at')?.value, record.date, record.time);
      options.dateStr = parts.dateStr;
      options.timeStr = parts.timeStr;
      options.deadline = body.querySelector('#inbox-convert-deadline')?.value.trim() || '';
    }

    await convertQuickRecord(record, targetType, options);
    return true;
  }, { btnText: '确认转换' });
}

export function renderInboxRecords() {
  const container = document.getElementById('inbox-records-container');
  if (!container || !appData) return;

  const allRecords = loadInboxRecords(Number.MAX_SAFE_INTEGER);
  const records = allRecords.slice(0, inboxVisibleLimit);
  if (records.length === 0) {
    container.innerHTML = "<div class='inbox-empty' title='修改分类不会完成整理，转为待办、笔记或流水后才会离开这里。'>没有待整理内容</div>";
    return;
  }

  const remainingCount = Math.max(0, allRecords.length - records.length);
  const inboxHint = `
    <div class="inbox-footer">
      <span class="inbox-process-hint">修改分类不会完成整理 · 共 ${allRecords.length} 条</span>
      ${remainingCount > 0 ? `<button type="button" class="text-link-btn inbox-load-more">加载更多（还剩 ${remainingCount} 条）</button>` : ''}
    </div>
  `;
  container.innerHTML = records.map(record => {
    const title = getRecordTitle(record);
    const displayTitle = formatInboxTitle(title);
    const { body, full } = splitRecordDetail(record);
    const detail = body.trim() ? body : full;
    const detailLength = detail.trim().length;
    const previewSource = body.trim() ? body : full;
    const preview = formatInboxContent(previewSource);
    const safeTitle = escapeHtml(displayTitle);
    const safePreview = escapeHtml(preview);
    const safeDetail = escapeHtml(detail || '没有更多内容。');
    const metaParts = [`${record.date || getTodayString()} ${(record.time || '').substring(0, 5)}`];
    if (detailLength > 0) metaParts.push(`${detailLength} 字`);
    const safeMeta = escapeHtml(metaParts.join(' · '));

    return `
      <article class="inbox-record" data-id="${record.id}" data-date="${escapeHtml(record.date)}" tabindex="0" role="button" aria-expanded="false">
        <div class="inbox-record-summary">
          <div class="inbox-record-main">
            <div class="inbox-record-title">${safeTitle}</div>
            <div class="inbox-record-text">${safePreview || '点击查看详情'}</div>
            <div class="inbox-record-time">${safeMeta}<span class="inbox-detail-toggle-label"> · 点击展开详情</span></div>
          </div>
        </div>
        <div class="inbox-record-detail" aria-hidden="true">
          <div class="inbox-record-detail-content">${safeDetail}</div>
        </div>
        ${renderInboxActions('inbox-record-bottom-actions')}
      </article>
    `;
  }).join('') + inboxHint;

  container.querySelectorAll('.inbox-record button[data-action]').forEach(button => {
    button.addEventListener('click', async event => {
      const card = button.closest('.inbox-record');
      const id = parseInt(card.dataset.id);
      const date = card.dataset.date;
       const record = loadInboxRecords(Number.MAX_SAFE_INTEGER).find(item => item.id === id && item.date === date);
      if (!record) return;

      const action = button.dataset.action;
       if (action === 'convert' || action === 'read') {
         if (action === 'read') openRecordReader(record);
         return;
       }
      if (action === 'project') {
        openInboxProjectModal(record);
      } else if (action === 'edit') {
        openInboxEditModal(record);
      } else {
        openQuickConvertModal(record, action);
      }
    });
  });

  container.querySelectorAll('.inbox-record').forEach(card => {
    const id = parseInt(card.dataset.id);
    const date = card.dataset.date;
    const record = loadInboxRecords(Number.MAX_SAFE_INTEGER).find(item => item.id === id && item.date === date);
    if (!record) return;
    card.addEventListener('click', event => {
      if (event.target.closest('button, input, textarea, select, a, .inbox-convert-panel')) return;
      openRecordReader(record);
    });
    card.addEventListener('keydown', event => {
      if (event.target.closest('button, input, textarea, select, a')) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openRecordReader(record);
      }
    });
  });

  container.querySelector('.inbox-load-more')?.addEventListener('click', () => {
    inboxVisibleLimit += 10;
    renderInboxRecords();
  });
}

export async function saveQuickRecord(inputEl) {
  const input = inputEl || document.getElementById('quick-capture-input');
  if (!input) return;
  if (quickCaptureBusy) return;

  const content = input.value.trim();
  if (!content) {
    showQuickToast('先写点内容再保存', 'warning');
    input.focus();
    return;
  }

  quickCaptureBusy = true;
  const saveButton = document.getElementById('quick-capture-save');
  if (saveButton) saveButton.disabled = true;

  try {
    const meta = resolveQuickMeta();
    const title = deriveRecordTitle(content);
    let saved = false;

    if (meta.recordType === 'todo') {
      const createdTodoId = await saveAsTodo(content, title, meta);
      if (!createdTodoId) return;
      saved = true;
    } else if (meta.recordType === 'log') {
      saved = Boolean(await saveAsProcessedLog(content, title, meta));
    } else if (meta.recordType === 'note' || meta.recordType === 'problem' || meta.recordType === 'conclusion') {
      const noteType = meta.recordType === 'problem' ? 'problem' : meta.recordType === 'conclusion' ? 'review' : 'idea';
      saved = Boolean(await saveAsNote(content, title, meta, noteType));
    } else {
      saved = Boolean(await saveAsQuickLog(content, title, meta));
    }

    if (!saved) {
      showQuickToast('保存失败，草稿已保留', 'warning');
      input.focus();
      return;
    }

    await createFollowUpTodo(content, meta);
    clearQuickInputs(input);
    await refreshAfterQuickSave();
    showQuickToast(meta.recordType === 'quick' ? '已保存到待整理' : '已保存');
  } catch (error) {
    console.error('快速记录保存失败', error);
    showQuickToast('保存失败，草稿已保留', 'warning');
    input.focus();
  } finally {
    quickCaptureBusy = false;
    if (saveButton) saveButton.disabled = false;
  }
}

function setupInboxCollapseToggle() {
  const section = document.querySelector('.inbox-section');
  const toggle = document.getElementById('inbox-collapse-toggle');
  if (!section || !toggle || toggle.dataset.bound === '1') return;

  const storageKey = 'workRecorderInboxCollapsed';
  const applyState = collapsed => {
    section.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '展开待整理' : '收起待整理');
    toggle.title = collapsed ? '展开待整理' : '收起待整理';
    toggle.textContent = collapsed ? '+' : '-';
  };

  applyState(localStorage.getItem(storageKey) === '1');
  toggle.addEventListener('click', () => {
    const collapsed = !section.classList.contains('collapsed');
    localStorage.setItem(storageKey, collapsed ? '1' : '0');
    applyState(collapsed);
  });
  toggle.dataset.bound = '1';
}

export function initQuickCapture() {
  const input = document.getElementById('quick-capture-input');
  const saveBtn = document.getElementById('quick-capture-save');
  const addTodoBtn = document.getElementById('quick-add-todo');
  const saveNoteBtn = document.getElementById('quick-save-note');
  const saveLogBtn = document.getElementById('quick-save-log');

  if (!input || !saveBtn) return;

  const draftStatus = document.getElementById('quick-capture-draft-status');
  const resizeInput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 144), 420)}px`;
  };
  const updateDraft = () => {
    const value = input.value;
    resizeInput();
    if (value.trim()) {
      localStorage.setItem(QUICK_DRAFT_KEY, value);
      if (draftStatus) draftStatus.textContent = '草稿已保存';
    } else {
      localStorage.removeItem(QUICK_DRAFT_KEY);
      if (draftStatus) draftStatus.textContent = '';
    }
  };

  const savedDraft = localStorage.getItem(QUICK_DRAFT_KEY);
  if (savedDraft && !input.value) {
    input.value = savedDraft;
    if (draftStatus) draftStatus.textContent = '已恢复未完成草稿';
  }
  input.addEventListener('input', updateDraft);
  resizeInput();

  let isComposing = false;
  input.addEventListener('compositionstart', () => { isComposing = true; });
  input.addEventListener('compositionend', () => { isComposing = false; });
  input.addEventListener('keydown', async (event) => {
    if (isComposing || event.isComposing) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      await saveQuickRecord(input);
    }
  });

  saveBtn.addEventListener('click', async () => {
    await saveQuickRecord(input);
  });
  addTodoBtn?.addEventListener('click', async () => {
    await addQuickTodo(input);
  });
  saveNoteBtn?.addEventListener('click', () => {
    openQuickDirectModal('note', input);
  });
  saveLogBtn?.addEventListener('click', () => {
    openQuickDirectModal('log', input);
  });
  setupInboxCollapseToggle();
  renderInboxRecords();
}

export async function convertQuickRecord(log, targetType, options = {}) {
  if (!log) return;
  const originalLog = {
    date: log.date || getTodayString(),
    time: log.time || currentTimeString(),
    text: log.text || "",
    detail: log.detail || "",
    tag: log.tag || DEFAULT_TAG,
    sub_tag: log.sub_tag || "",
    deadline: log.deadline || "",
    status: log.status || "unprocessed",
    record_type: log.record_type || "quick"
  };
  const tag = options.tag || log.tag || DEFAULT_TAG;
  const subTag = options.subTag ?? log.sub_tag ?? "";
  const title = options.title || log.text || deriveRecordTitle(log.detail || "");
  const detail = options.detail ?? (log.detail || log.text || "");
  let createdTodoId = null;
  let createdNotePath = null;
  let createdFollowUpTodoId = null;

  await ensureTagAndSubTag(tag, subTag);

  if (targetType === 'todo') {
    const endAt = options.endAt || log.deadline || "";
    const startAt = options.startAt || "";
    const relationCheck = validateTaskRelation(options.relation || {
      mode: options.parentId ? 'child' : 'independent',
      targetId: options.parentId || ''
    });
    if (!relationCheck.ok) {
      alert(relationCheck.message);
      return;
    }
    const parentId = getCreateParentId(relationCheck.relation);
    createdTodoId = await insertAndReturnId(
      "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [title, false, tag, subTag, detail, log.remark || "", endAt, startAt, endAt, parentId, ""]
    );
    await applyCreatedTodoRelation(createdTodoId, relationCheck.relation);
  }

  if (targetType === 'note' || targetType === 'problem' || targetType === 'conclusion') {
    const noteType = options.noteType || (targetType === 'problem' ? 'problem' : targetType === 'conclusion' ? 'review' : 'idea');
    const typeName = targetType === 'problem' ? '问题' : targetType === 'conclusion' ? '结论' : '笔记';
    const now = `${getTodayString()} ${currentTimeString()}`;
    // 笔记改为「文件优先」：写 .md 文件，不再进 notes 表
    const { writeNote } = await import('./notesStore.js');
    try {
      const saved = await writeNote({
        title,
        content: detail,
        note_type: noteType,
        status: 'usable',
        tag,
        sub_tag: subTag,
        created_at: now,
        updated_at: now,
        rel_path: ''
      });
      createdNotePath = saved?.rel_path || null;
    } catch (error) {
      console.error('转换笔记失败:', error);
      alert('转为笔记失败，请检查笔记目录是否可用。');
      return;
    }
    if (options.followUpTodo) {
      createdFollowUpTodoId = await insertAndReturnId(
        "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [options.followUpTodo, false, tag, subTag, `来自笔记：${title}`, "", "", "", "", "", ""]
      );
    }
    log.record_type = typeName;
  }

  const recordType = targetType === 'log' ? 'log' : targetType;
  const updatedDate = options.dateStr || originalLog.date;
  const updatedTime = options.timeStr || originalLog.time;
  const updatedDeadline = options.deadline ?? originalLog.deadline;
  await dbExecute(
    "UPDATE logs SET date=?, time=?, text=?, detail=?, deadline=?, status=?, record_type=?, tag=?, sub_tag=? WHERE id=?",
    [updatedDate, updatedTime, title, detail, updatedDeadline, "processed", recordType, tag, subTag, log.id]
  );
  await loadData();
  renderInboxRecords();
  import('./log.js').then(m => m.renderHistoryList());
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
  import('./todo.js').then(m => m.renderTodoList());
  // 笔记列表现已由 notesEditor 管理
  if (typeof window.__wrRefreshNotes === 'function') window.__wrRefreshNotes();
  if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();

  showUndoToast(getQuickConvertMessage(targetType), async () => {
    if (createdTodoId) await dbExecute("DELETE FROM todos WHERE id=?", [createdTodoId]);
    if (createdNotePath) {
      const { deleteNote } = await import('./notesStore.js');
      await deleteNote(createdNotePath);
    }
    if (createdFollowUpTodoId) await dbExecute("DELETE FROM todos WHERE id=?", [createdFollowUpTodoId]);
    await dbExecute(
      "UPDATE logs SET date=?, time=?, text=?, detail=?, deadline=?, tag=?, sub_tag=?, status=?, record_type=? WHERE id=?",
      [originalLog.date, originalLog.time, originalLog.text, originalLog.detail, originalLog.deadline, originalLog.tag, originalLog.sub_tag, originalLog.status, originalLog.record_type, log.id]
    );
    await refreshAfterInboxAction();
  });

  return { logId: log.id, createdTodoId, createdNotePath, createdFollowUpTodoId, targetType };
}

export async function updateQuickRecordProject(log, tag, subTag) {
  if (!log) return;
  await dbExecute("UPDATE logs SET tag=?, sub_tag=? WHERE id=?", [tag || DEFAULT_TAG, subTag || "", log.id]);
  await loadData();
  renderInboxRecords();
  import('./log.js').then(m => m.renderHistoryList());
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
}
