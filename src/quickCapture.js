import { appData, dbExecute, getTodayString, loadData } from './data.js';

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
    tag: tag || "未分类",
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
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
  import('./todo.js').then(m => m.renderTodoList());
  import('./notes.js').then(m => m.renderNotesList());
  if (typeof window.renderQuickParentTodos === 'function') window.renderQuickParentTodos();
  if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();
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

export function initQuickCapture() {
  const input = document.getElementById('quick-capture-input');
  const saveBtn = document.getElementById('quick-capture-save');
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

  saveBtn.addEventListener('click', async () => {
    const content = input.value.trim();
    if (!content) {
      alert("先写点内容再保存");
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
  });
}

export async function convertQuickRecord(log, targetType) {
  if (!log) return;
  const tag = log.tag || "未分类";
  const subTag = log.sub_tag || "";
  const detail = log.detail || log.text || "";

  if (targetType === 'todo') {
    await dbExecute(
      "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [log.text, false, tag, subTag, detail, log.remark || "", log.deadline || "", "", log.deadline || "", "", ""]
    );
  }

  if (targetType === 'note' || targetType === 'problem' || targetType === 'conclusion') {
    const noteType = targetType === 'problem' ? 'problem' : targetType === 'conclusion' ? 'review' : 'idea';
    const typeName = targetType === 'problem' ? '问题' : targetType === 'conclusion' ? '结论' : '笔记';
    const now = `${getTodayString()} ${currentTimeString()}`;
    await dbExecute(
      "INSERT INTO notes (title, content, note_type, status, tag, sub_tag, source_type, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [log.text, detail, noteType, "usable", tag, subTag, "log", log.id, now, now]
    );
    log.record_type = typeName;
  }

  const recordType = targetType === 'log' ? 'log' : targetType;
  await dbExecute("UPDATE logs SET status=?, record_type=? WHERE id=?", ["processed", recordType, log.id]);
  await loadData();
  import('./log.js').then(m => m.renderHistoryList());
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
  import('./todo.js').then(m => m.renderTodoList());
  import('./notes.js').then(m => m.renderNotesList());
}

export async function updateQuickRecordProject(log, tag, subTag) {
  if (!log) return;
  await dbExecute("UPDATE logs SET tag=?, sub_tag=? WHERE id=?", [tag || "未分类", subTag || "", log.id]);
  await loadData();
  import('./log.js').then(m => m.renderHistoryList());
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
}
