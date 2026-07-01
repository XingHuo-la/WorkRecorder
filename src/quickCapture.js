import { appData, dbExecute, dbQuery, getTodayString, loadData, DEFAULT_TAG } from './data.js';
import { escapeHtml, insertTextareaNewline } from './htmlUtils.js';
import { showUndoToast } from './undoToast.js';

let quickToastTimer = null;

export function deriveRecordTitle(content) {
  const firstLine = (content || "").split(/\n|。|！|？|\.|\!|\?/).find(Boolean) || content || "";
  const clean = firstLine.trim().replace(/\s+/g, ' ');
  if (!clean) return "快速记录";
  return clean.length > 24 ? `${clean.substring(0, 24)}...` : clean;
}

function currentTimeString() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

function getAdvancedValue(id, fallback = '') {
  const el = document.getElementById(id);
  if (!el) return fallback;
  return el.value?.trim() || fallback;
}

function getAdvancedCheckbox(id) {
  const el = document.getElementById(id);
  return Boolean(el?.checked);
}

function splitDateTime(value) {
  if (!value) return { date: getTodayString(), time: currentTimeString(), hasValue: false };
  const [datePart, timePart = ""] = value.split(" ");
  return {
    date: datePart || getTodayString(),
    time: timePart || currentTimeString(),
    hasValue: true
  };
}

function resolveQuickMeta() {
  const tagSelect = document.getElementById('quick-tag-select');
  const tagNew = getAdvancedValue('quick-tag-new');
  const subSelect = document.getElementById('quick-sub-tag-select');
  const subNew = getAdvancedValue('quick-sub-tag-new');

  const tag = tagSelect?.value === 'NEW' ? tagNew : getAdvancedValue('quick-tag-select', '未分类');
  const subTag = subSelect?.value === 'NEW' ? subNew : getAdvancedValue('quick-sub-tag-select', '');
  const manualTime = getAdvancedValue('quick-time-input', '');
  const dateTime = splitDateTime(manualTime);

  return {
    tag: tag || DEFAULT_TAG,
    subTag: subTag || "",
    recordType: getAdvancedValue('quick-type-select', 'quick') || 'quick',
    parentId: getAdvancedValue('quick-parent-todo-select', ''),
    plannedTodo: getAdvancedValue('quick-action-input', ''),
    deadline: getAdvancedValue('quick-deadline-input', ''),
    isOverdue: getAdvancedCheckbox('quick-is-overdue'),
    dateStr: dateTime.date,
    timeStr: dateTime.time,
    hasManualTime: dateTime.hasValue
  };
}

async function refreshAfterQuickSave() {
  await loadData();
  import('./log.js').then(m => m.renderHistoryList());
  renderInboxRecords();
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
  import('./todo.js').then(m => m.renderTodoList());
  import('./notes.js').then(m => m.renderNotesList());
  if (typeof window.renderQuickParentTodos === 'function') window.renderQuickParentTodos();
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
  await dbExecute(
    "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue, status, record_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [meta.dateStr, meta.timeStr, title, meta.tag, meta.subTag, content, "", "", meta.deadline, meta.isOverdue, "unprocessed", "quick"]
  );
}

async function saveAsProcessedLog(content, title, meta) {
  await dbExecute(
    "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue, status, record_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [meta.dateStr, meta.timeStr, title, meta.tag, meta.subTag, content, "", "", meta.deadline, meta.isOverdue, "processed", "log"]
  );
}

async function saveAsTodo(content, title, meta) {
  await dbExecute(
    "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [title, false, meta.tag, meta.subTag, content, "", meta.deadline, meta.hasManualTime ? `${meta.dateStr} ${meta.timeStr}` : "", meta.deadline, meta.parentId || "", ""]
  );
}

async function saveAsNote(content, title, meta, noteType = 'idea') {
  const now = `${meta.dateStr} ${meta.timeStr}`;
  await dbExecute(
    "INSERT INTO notes (title, content, note_type, status, tag, sub_tag, source_type, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [title, content, noteType, "usable", meta.tag, meta.subTag, "quick", "", now, now]
  );
}

async function createFollowUpTodo(content, meta) {
  if (!meta.plannedTodo) return;
  await dbExecute(
    "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [meta.plannedTodo, false, meta.tag, meta.subTag, `来自快速记录：${content}`, "", meta.deadline, "", meta.deadline, meta.parentId || "", ""]
  );
}

async function syncQuickMetaOptions(meta) {
  const tagSelect = document.getElementById('quick-tag-select');
  const subSelect = document.getElementById('quick-sub-tag-select');

  if (tagSelect?.value === 'NEW' && meta.tag) {
    await dbExecute("INSERT OR IGNORE INTO tags (name, is_active) VALUES (?, ?)", [meta.tag, true]);
  }
  if (subSelect?.value === 'NEW' && meta.subTag) {
    await dbExecute("INSERT INTO sub_tags (main_tag, name) VALUES (?, ?)", [meta.tag, meta.subTag]);
  }
}

function clearQuickInputs(input) {
  input.value = "";
  const actionInput = document.getElementById('quick-action-input');
  const timeInput = document.getElementById('quick-time-input');
  const deadlineInput = document.getElementById('quick-deadline-input');
  const overdueInput = document.getElementById('quick-is-overdue');
  const parentInput = document.getElementById('quick-parent-todo-select');
  if (actionInput) actionInput.value = "";
  if (timeInput?._flatpickr) timeInput._flatpickr.clear();
  else if (timeInput) timeInput.value = "";
  if (deadlineInput?._flatpickr) deadlineInput._flatpickr.clear();
  else if (deadlineInput) deadlineInput.value = "";
  if (overdueInput) overdueInput.checked = false;
  if (parentInput) parentInput.value = "";
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
  import('./notes.js').then(m => m.renderNotesList());
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
  const tags = [DEFAULT_TAG, ...(appData?.settings?.active_tags || appData?.tags || []).filter(tag => tag !== DEFAULT_TAG)];
  return tags.map(tag => {
    const safeTag = escapeHtml(tag);
    const selected = tag === selectedTag ? ' selected' : '';
    return `<option value="${safeTag}"${selected}>${safeTag}</option>`;
  }).join('');
}

function renderParentTodoOptions() {
  const byId = new Map((appData?.todos || []).map(todo => [todo.id, todo]));
  const options = ['<option value="">无父任务</option>'];
  (appData?.todos || [])
    .filter(todo => !todo.done)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id)
    .forEach(todo => {
      options.push(`<option value="${todo.id}">${escapeHtml(buildTodoPath(todo, byId))}</option>`);
    });
  return options.join('');
}

async function createTodoRecord({ task, tag, subTag = '', detail = '', startAt = '', endAt = '', parentId = '' }) {
  return insertAndReturnId(
    "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [task, false, tag || DEFAULT_TAG, subTag || '', detail || '', '', endAt || '', startAt || '', endAt || '', parentId || '', '']
  );
}

async function refreshAfterTodoCreate() {
  await loadData();
  renderInboxRecords();
  import('./todo.js').then(m => m.renderTodoList());
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
  if (typeof window.renderQuickParentTodos === 'function') window.renderQuickParentTodos();
  if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();
}

export async function addQuickTodo(inputEl) {
  const input = inputEl || document.getElementById('quick-capture-input');
  if (!input) return;

  const content = input.value.trim();
  if (!content) {
    showQuickToast('先写点待办内容', 'warning');
    input.focus();
    return;
  }

  const meta = resolveQuickMeta();
  await syncQuickMetaOptions(meta);
  await createTodoRecord({
    task: deriveRecordTitle(content),
    tag: meta.tag || DEFAULT_TAG,
    subTag: meta.subTag || '',
    detail: content
  });

  clearQuickInputs(input);
  await refreshAfterTodoCreate();
  showQuickToast('已添加待办');
}

function renderScheduleTodoModalHtml(defaultTitle) {
  return `
    <div class="schedule-todo-modal">
      <div class="form-group">
        <label class="field-label">待办标题</label>
        <input id="schedule-todo-title" class="hero-input" value="${escapeHtml(defaultTitle)}" placeholder="输入待办标题" />
      </div>
      <div class="form-row">
        <div class="field-col">
          <label class="field-label">主分类：可选，未选择时保存为未分类</label>
          <select id="schedule-todo-tag" class="hero-input select-hero">${renderTagOptions(DEFAULT_TAG)}</select>
        </div>
        <div class="field-col">
          <label class="field-label">子项目（可选）</label>
          <input id="schedule-todo-sub-tag" class="hero-input" placeholder="可选：输入子项目" />
        </div>
      </div>
      <div class="schedule-time-shortcuts" aria-label="时间快捷选项">
        <button type="button" data-range="today">今天</button>
        <button type="button" data-range="tomorrow">明天</button>
        <button type="button" data-range="week">本周</button>
        <button type="button" data-range="custom">自定义</button>
        <button type="button" data-range="none">无时间</button>
      </div>
      <div class="form-row">
        <div class="field-col">
          <label class="field-label">计划开始时间（可选）</label>
          <input id="schedule-todo-start" class="hero-input datetime-input" placeholder="可选：计划开始时间" />
        </div>
        <div class="field-col">
          <label class="field-label">计划结束/截止时间（可选）</label>
          <input id="schedule-todo-end" class="hero-input datetime-input" placeholder="可选：计划结束或截止时间" />
        </div>
      </div>
      <div class="form-group">
        <label class="field-label">父任务（可选）</label>
        <select id="schedule-todo-parent" class="hero-input select-hero">${renderParentTodoOptions()}</select>
      </div>
      <div class="form-group">
        <label class="field-label">详细说明（可选）</label>
        <textarea id="schedule-todo-detail" class="hero-textarea" placeholder="可选：补充执行标准、背景或注意事项"></textarea>
      </div>
      <div class="form-group">
        <label class="field-label">子任务列表（可选）</label>
        <div id="schedule-subtasks" class="schedule-subtasks"></div>
        <button id="schedule-add-subtask" type="button" class="icon-btn schedule-add-subtask">+ 添加子任务</button>
        <div class="schedule-modal-hint">子任务会继承当前待办的主分类、子项目和计划时间。</div>
      </div>
    </div>
  `;
}

function addScheduleSubtaskRow(container, value = '') {
  const row = document.createElement('div');
  row.className = 'schedule-subtask-row';
  row.innerHTML = `
    <input class="hero-input schedule-subtask-input" value="${escapeHtml(value)}" placeholder="子任务内容" />
    <button type="button" class="icon-btn schedule-remove-subtask">删除</button>
  `;
  row.querySelector('.schedule-remove-subtask').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function setupScheduleTodoModal(body) {
  const startInput = body.querySelector('#schedule-todo-start');
  const endInput = body.querySelector('#schedule-todo-end');
  const titleInput = body.querySelector('#schedule-todo-title');
  const subtasks = body.querySelector('#schedule-subtasks');
  const addSubtaskBtn = body.querySelector('#schedule-add-subtask');
  const fpConfig = window.fpGlobalConfig || { enableTime: true, enableSeconds: true, time_24hr: true, dateFormat: "Y-m-d H:i:S", locale: "zh" };

  if (window.flatpickr) {
    flatpickr(startInput, fpConfig);
    flatpickr(endInput, fpConfig);
  }

  body.querySelectorAll('.schedule-time-shortcuts button[data-range]').forEach(button => {
    button.addEventListener('click', () => {
      const today = new Date();
      const range = button.dataset.range;
      if (range === 'today') {
        startInput.value = formatDateOnly(today);
        endInput.value = formatDateOnly(today);
      } else if (range === 'tomorrow') {
        const tomorrow = addDays(today, 1);
        startInput.value = formatDateOnly(tomorrow);
        endInput.value = formatDateOnly(tomorrow);
      } else if (range === 'week') {
        startInput.value = formatDateOnly(today);
        endInput.value = formatDateOnly(getThisWeekEnd(today));
      } else if (range === 'none') {
        if (startInput._flatpickr) startInput._flatpickr.clear();
        else startInput.value = '';
        if (endInput._flatpickr) endInput._flatpickr.clear();
        else endInput.value = '';
      } else if (range === 'custom') {
        startInput.focus();
        startInput._flatpickr?.open();
      }
    });
  });

  addSubtaskBtn.addEventListener('click', () => {
    addScheduleSubtaskRow(subtasks);
    subtasks.lastElementChild?.querySelector('input')?.focus();
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
  const detail = body.querySelector('#schedule-todo-detail')?.value.trim() || '';
  const childTasks = [...body.querySelectorAll('.schedule-subtask-input')]
    .map(item => item.value.trim())
    .filter(Boolean);

  if (!title) {
    alert('待办标题不能为空');
    return false;
  }
  if (startAt && endAt && Date.parse(startAt) > Date.parse(endAt)) {
    alert('计划开始时间不能晚于计划结束/截止时间');
    return false;
  }

  const parentTodoId = await createTodoRecord({ task: title, tag, subTag, detail, startAt, endAt, parentId });
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

export function openScheduleTodoModal(inputEl) {
  const input = inputEl || document.getElementById('quick-capture-input');
  const defaultTitle = (input?.value || '').trim().replace(/\s+/g, ' ');
  window.showModal(
    '安排待办',
    renderScheduleTodoModalHtml(defaultTitle),
    setupScheduleTodoModal,
    body => confirmScheduleTodo(body, input),
    { btnText: '保存待办' }
  );
}

export function renderInboxRecords() {
  const container = document.getElementById('inbox-records-container');
  if (!container || !appData) return;

  const records = loadInboxRecords(10);
  if (records.length === 0) {
    container.innerHTML = "<div class='inbox-empty'>暂无待整理记录，想到什么可以先写在上面。<br>修改分类不会完成整理，转为待办、笔记或流水后才会离开这里。</div>";
    return;
  }

  const inboxHint = "<div class='inbox-process-hint'>修改分类不会完成整理，转为待办、笔记或流水后才会离开这里。</div>";
  container.innerHTML = records.map(record => {
    const content = record.detail || record.text || '';
    const summary = content.replace(/\s+/g, ' ').trim();
    const safeSummary = escapeHtml(summary.length > 96 ? `${summary.substring(0, 96)}...` : summary);
    const safeTime = escapeHtml(`${record.date || getTodayString()} ${(record.time || '').substring(0, 5)}`);

    return `
      <article class="inbox-record" data-id="${record.id}" data-date="${escapeHtml(record.date)}">
        <div class="inbox-record-main">
          <div class="inbox-record-text">${safeSummary || '快速记录'}</div>
          <div class="inbox-record-time">${safeTime}</div>
        </div>
        <div class="inbox-record-actions">
          <button type="button" data-action="todo">转待办</button>
          <button type="button" data-action="note">转笔记</button>
          <button type="button" data-action="log">转流水</button>
          <button type="button" data-action="project">修改分类</button>
        </div>
      </article>
    `;
  }).join('') + inboxHint;

  container.querySelectorAll('.inbox-record button[data-action]').forEach(button => {
    button.addEventListener('click', async () => {
      const card = button.closest('.inbox-record');
      const id = parseInt(card.dataset.id);
      const date = card.dataset.date;
      const record = loadInboxRecords(50).find(item => item.id === id && item.date === date);
      if (!record) return;

      const action = button.dataset.action;
      if (action === 'project') {
        const tag = prompt('输入主分类，留空则保持未分类：', record.tag || '未分类');
        if (tag === null) return;
        const subTag = prompt('输入子项目，留空则设为无项目：', record.sub_tag || '');
        await updateQuickRecordProject(record, tag || '未分类', subTag || '');
        showQuickToast('分类已更新，这条记录仍在待整理中。转为待办、笔记或流水后才算处理完成。');
      } else {
        await convertQuickRecord(record, action);
      }
      await refreshAfterInboxAction();
    });
  });
}

export async function saveQuickRecord(inputEl) {
  const input = inputEl || document.getElementById('quick-capture-input');
  if (!input) return;

  const content = input.value.trim();
  if (!content) {
    showQuickToast('先写点内容再保存', 'warning');
    input.focus();
    return;
  }

  const meta = resolveQuickMeta();
  const title = deriveRecordTitle(content);

  await syncQuickMetaOptions(meta);

  if (meta.recordType === 'todo') {
    await saveAsTodo(content, title, meta);
  } else if (meta.recordType === 'log') {
    await saveAsProcessedLog(content, title, meta);
  } else if (meta.recordType === 'note' || meta.recordType === 'problem' || meta.recordType === 'conclusion') {
    const noteType = meta.recordType === 'problem' ? 'problem' : meta.recordType === 'conclusion' ? 'review' : 'idea';
    await saveAsNote(content, title, meta, noteType);
  } else {
    await saveAsQuickLog(content, title, meta);
  }

  await createFollowUpTodo(content, meta);
  clearQuickInputs(input);
  await refreshAfterQuickSave();
  showQuickToast(meta.recordType === 'quick' ? '已保存到待整理' : '已保存');
}

export function initQuickCapture() {
  const input = document.getElementById('quick-capture-input');
  const saveBtn = document.getElementById('quick-capture-save');
  const addTodoBtn = document.getElementById('quick-add-todo');
  const scheduleTodoBtn = document.getElementById('quick-schedule-todo');
  const advancedToggle = document.getElementById('quick-advanced-toggle');
  const advancedPanel = document.getElementById('quick-advanced-panel');

  if (!input || !saveBtn) return;

  if (advancedToggle && advancedPanel) {
    advancedToggle.addEventListener('click', () => {
      const isHidden = advancedPanel.style.display === 'none';
      advancedPanel.style.display = isHidden ? 'block' : 'none';
      advancedToggle.classList.toggle('active', isHidden);
      advancedToggle.innerText = isHidden ? '收起类型 / 项目 / 时间' : '+ 添加类型 / 项目 / 时间';
    });
  }

  const fpConfig = window.fpGlobalConfig || { enableTime: true, enableSeconds: true, time_24hr: true, dateFormat: "Y-m-d H:i:S", locale: "zh" };
  const timeInput = document.getElementById('quick-time-input');
  const deadlineInput = document.getElementById('quick-deadline-input');
  if (window.flatpickr && timeInput) flatpickr(timeInput, fpConfig);
  if (window.flatpickr && deadlineInput) flatpickr(deadlineInput, fpConfig);

  let isComposing = false;
  input.addEventListener('compositionstart', () => { isComposing = true; });
  input.addEventListener('compositionend', () => { isComposing = false; });
  input.addEventListener('keydown', async (event) => {
    if (isComposing || event.isComposing) return;
    if (event.key === 'Enter' && event.altKey) {
      event.preventDefault();
      insertTextareaNewline(input);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
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
  scheduleTodoBtn?.addEventListener('click', () => {
    openScheduleTodoModal(input);
  });

  renderInboxRecords();
}

export async function convertQuickRecord(log, targetType) {
  if (!log) return;
  const tag = log.tag || DEFAULT_TAG;
  const subTag = log.sub_tag || "";
  const detail = log.detail || log.text || "";
  let createdTodoId = null;
  let createdNoteId = null;

  if (targetType === 'todo') {
    createdTodoId = await insertAndReturnId(
      "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [log.text, false, tag, subTag, detail, log.remark || "", log.deadline || "", "", log.deadline || "", "", ""]
    );
  }

  if (targetType === 'note' || targetType === 'problem' || targetType === 'conclusion') {
    const noteType = targetType === 'problem' ? 'problem' : targetType === 'conclusion' ? 'review' : 'idea';
    const typeName = targetType === 'problem' ? '问题' : targetType === 'conclusion' ? '结论' : '笔记';
    const now = `${getTodayString()} ${currentTimeString()}`;
    createdNoteId = await insertAndReturnId(
      "INSERT INTO notes (title, content, note_type, status, tag, sub_tag, source_type, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [log.text, detail, noteType, "usable", tag, subTag, "log", log.id, now, now]
    );
    log.record_type = typeName;
  }

  const recordType = targetType === 'log' ? 'log' : targetType;
  await dbExecute("UPDATE logs SET status=?, record_type=?, tag=?, sub_tag=? WHERE id=?", ["processed", recordType, tag, subTag, log.id]);
  await loadData();
  renderInboxRecords();
  import('./log.js').then(m => m.renderHistoryList());
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
  import('./todo.js').then(m => m.renderTodoList());
  import('./notes.js').then(m => m.renderNotesList());
  if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();

  showUndoToast(getQuickConvertMessage(targetType), async () => {
    if (createdTodoId) await dbExecute("DELETE FROM todos WHERE id=?", [createdTodoId]);
    if (createdNoteId) await dbExecute("DELETE FROM notes WHERE id=?", [createdNoteId]);
    await dbExecute("UPDATE logs SET status=?, record_type=? WHERE id=?", ["unprocessed", "quick", log.id]);
    await refreshAfterInboxAction();
    if (typeof window.renderQuickParentTodos === 'function') window.renderQuickParentTodos();
  });

  return { logId: log.id, createdTodoId, createdNoteId, targetType };
}

export async function updateQuickRecordProject(log, tag, subTag) {
  if (!log) return;
  await dbExecute("UPDATE logs SET tag=?, sub_tag=? WHERE id=?", [tag || DEFAULT_TAG, subTag || "", log.id]);
  await loadData();
  renderInboxRecords();
  import('./log.js').then(m => m.renderHistoryList());
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
}
