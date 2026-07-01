import { appData, dbExecute, dbQuery, getTodayString, loadData } from './data.js';
import { openUniversalEditModal } from './formUtils.js';
import { appendRemarkEntry, escapeHtml, textWithLineBreaks } from './htmlUtils.js';
import { convertQuickRecord, renderInboxRecords, updateQuickRecordProject } from './quickCapture.js';
import { showUndoToast } from './undoToast.js';

const expandedMoreActionIds = new Set();

function getDateTimeValue(dateStr, timeStr) {
  if ((timeStr || '').includes(' ')) return timeStr;
  const date = dateStr || getTodayString();
  const time = timeStr || '00:00:00';
  return `${date} ${time}`;
}

function getTodoEnd(todo) {
  return todo.end_at || todo.deadline || '';
}

function getTodoDisplayTime(todo) {
  const endText = getTodoEnd(todo);
  if (!endText) return '待办';
  if (endText.includes(' ')) return endText.substring(11, 16);
  if (endText.includes(':')) return endText.substring(0, 5);
  return '待办';
}

async function insertAndReturnId(query, params) {
  const rows = await dbQuery(`${query} RETURNING id`, params);
  return rows?.[0]?.id || null;
}

function renderActionButton(action, label, className = '') {
  return `<button type="button" class="${className}" data-action="${action}">${label}</button>`;
}

function renderTimelineActions(actionKey, primaryActions, secondaryActions) {
  const secondaryHtml = expandedMoreActionIds.has(actionKey)
    ? `<div class="today-actions-more">${secondaryActions.join('')}</div>`
    : '';

  return `
    <div class="today-actions">
      ${primaryActions.join('')}
      ${renderActionButton('more', expandedMoreActionIds.has(actionKey) ? '收起' : '更多', 'more-action')}
      ${secondaryHtml}
    </div>
  `;
}

function renderLogActions(log, isUnprocessed) {
  const actionKey = `log-${log.id}`;
  const primaryActions = isUnprocessed ? [renderActionButton('todo', '转待办', 'primary-action')] : [];
  const secondaryActions = isUnprocessed
    ? [
        renderActionButton('note', '转笔记'),
        renderActionButton('log', '转流水'),
        renderActionButton('problem', '转问题'),
        renderActionButton('conclusion', '转结论'),
        renderActionButton('project', '归类'),
        renderActionButton('edit', '编辑'),
        renderActionButton('remark', '补述'),
        renderActionButton('delete', '删除', 'danger-action')
      ]
    : [
        renderActionButton('edit', '编辑'),
        renderActionButton('remark', '补述'),
        renderActionButton('delete', '删除', 'danger-action')
      ];

  return renderTimelineActions(actionKey, primaryActions, secondaryActions);
}

function renderTodoActions(todo) {
  return renderTimelineActions(
    `todo-${todo.id}`,
    [renderActionButton('done', '完成', 'primary-action')],
    [
      renderActionButton('child', '子任务'),
      renderActionButton('edit', '编辑'),
      renderActionButton('remark', '补述'),
      renderActionButton('delete', '删除', 'danger-action')
    ]
  );
}

function renderNoteActions(note) {
  return renderTimelineActions(
    `note-${note.id}`,
    [],
    [
      renderActionButton('todo', '转待办'),
      renderActionButton('edit', '编辑'),
      renderActionButton('delete', '删除', 'danger-action')
    ]
  );
}

function buildLogCard(log) {
  const isUnprocessed = log.status === 'unprocessed' || log.record_type === 'quick';
  const badge = isUnprocessed ? '未整理' : (log.record_type === 'note' ? '笔记' : '流水');
  const safeTime = escapeHtml(log.time || '').substring(0, 5);
  const safeTitle = escapeHtml(log.text || '');
  const safeTag = escapeHtml(log.tag || '未分类');
  const detail = log.detail ? `<div class="today-detail">${textWithLineBreaks(log.detail)}</div>` : '';

  return `
    <article class="today-item ${isUnprocessed ? 'unprocessed' : ''}" data-kind="log" data-id="${log.id}" data-date="${escapeHtml(log.date || getTodayString())}" data-action-key="log-${log.id}">
      <div class="today-time">${safeTime || '--:--'}</div>
      <div class="today-body">
        <div class="today-line">
          <span class="today-badge">${badge}</span>
          <strong>${safeTitle}</strong>
          <span class="today-tag">${safeTag}</span>
        </div>
        ${detail}
        ${renderLogActions(log, isUnprocessed)}
      </div>
    </article>
  `;
}

function buildTodoCard(todo) {
  const safeTask = escapeHtml(todo.task || '');
  const safeTag = escapeHtml(todo.tag || '未分类');
  const endText = getTodoEnd(todo);
  const safeEnd = escapeHtml(endText);
  const safeStart = escapeHtml(todo.start_at || '');
  const title = todo.done ? '已完成' : '待办';
  const meta = endText ? (safeStart ? `${safeStart} 至 ${safeEnd}` : safeEnd) : '';
  const childTodos = (appData.todos || []).filter(item => item.parent_id === todo.id && !item.done);
  const childPreview = childTodos.length
    ? `<div class="today-children">${childTodos.slice(0, 4).map(child => `<span>${escapeHtml(child.task)}</span>`).join('')}${childTodos.length > 4 ? `<em>还有 ${childTodos.length - 4} 个</em>` : ''}</div>`
    : '';

  return `
    <article class="today-item" data-kind="todo" data-id="${todo.id}" data-action-key="todo-${todo.id}">
      <div class="today-time">${getTodoDisplayTime(todo)}</div>
      <div class="today-body">
        <div class="today-line">
          <span class="today-badge">${title}</span>
          <strong>${safeTask}</strong>
          <span class="today-tag">${safeTag}</span>
        </div>
        ${meta ? `<div class="today-detail">${meta}</div>` : ''}
        ${childPreview}
        ${renderTodoActions(todo)}
      </div>
    </article>
  `;
}

function buildNoteCard(note) {
  const title = note.title || note.content || '笔记';
  const safeTitle = escapeHtml(title.length > 28 ? `${title.substring(0, 28)}...` : title);
  const safeTag = escapeHtml(note.tag || '未分类');
  const safeTime = escapeHtml((note.created_at || note.updated_at || '').substring(11, 16));

  return `
    <article class="today-item" data-kind="note" data-id="${note.id}" data-action-key="note-${note.id}">
      <div class="today-time">${safeTime || '笔记'}</div>
      <div class="today-body">
        <div class="today-line">
          <span class="today-badge">笔记</span>
          <strong>${safeTitle}</strong>
          <span class="today-tag">${safeTag}</span>
        </div>
        ${renderNoteActions(note)}
      </div>
    </article>
  `;
}

function renderEditLogModal(log) {
  const currentTheme = (appData.settings && appData.settings.theme === 'light') ? 'theme-light-modal' : 'theme-dark-modal';
  openUniversalEditModal('编辑流水记录', log, {
    type: 'log',
    dateStr: log.date || getTodayString(),
    themeClass: currentTheme,
    onSave: async (updatedData) => {
      await dbExecute(
        "UPDATE logs SET date=?, time=?, text=?, detail=?, deadline=?, tag=?, sub_tag=? WHERE id=?",
        [updatedData.newDateStr, updatedData.newTimeStr, updatedData.text, updatedData.detail, updatedData.deadline, updatedData.tag, updatedData.sub_tag, log.id]
      );
      await loadData();
      renderTodayTimeline();
      import('./log.js').then(m => m.renderHistoryList());
      return true;
    }
  });
}

function renderEditTodoModal(todo) {
  const currentTheme = (appData.settings && appData.settings.theme === 'light') ? 'theme-light-modal' : 'theme-dark-modal';
  openUniversalEditModal('编辑待办', todo, {
    type: 'todo',
    themeClass: currentTheme,
    onSave: async (updatedData) => {
      await dbExecute(
        "UPDATE todos SET task=?, tag=?, sub_tag=?, detail=?, deadline=?, start_at=?, end_at=? WHERE id=?",
        [updatedData.text, updatedData.tag, updatedData.sub_tag, updatedData.detail, updatedData.deadline, updatedData.start_at, updatedData.deadline, todo.id]
      );
      await loadData();
      renderTodayTimeline();
      import('./todo.js').then(m => m.renderTodoList());
      return true;
    }
  });
}

function renderEditNoteModal(note) {
  const currentTheme = (appData.settings && appData.settings.theme === 'light') ? 'theme-light-modal' : 'theme-dark-modal';
  window.showModal('编辑笔记', `
    <div class="form-group">
      <label class="field-label">标题</label>
      <input id="today-note-title" class="hero-input" value="${escapeHtml(note.title || '')}" />
    </div>
    <div class="form-group">
      <label class="field-label">内容</label>
      <textarea id="today-note-content" class="hero-textarea">${escapeHtml(note.content || '')}</textarea>
    </div>
  `, null, async (body) => {
    const title = body.querySelector('#today-note-title').value.trim();
    const content = body.querySelector('#today-note-content').value.trim();
    if (!content) {
      alert('内容不能为空');
      return false;
    }
    await dbExecute("UPDATE notes SET title=?, content=?, updated_at=? WHERE id=?", [title || content.substring(0, 24), content, `${getTodayString()} ${new Date().toLocaleTimeString('en-US', { hour12: false })}`, note.id]);
    await loadData();
    renderTodayTimeline();
    import('./notes.js').then(m => m.renderNotesList());
    return true;
  }, { themeClass: currentTheme, btnText: '保存' });
}

export function renderTodayTimeline() {
  const container = document.getElementById('today-timeline-container');
  if (!container || !appData) return;
  if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();

  const today = getTodayString();
  const logs = (appData.logs[today] || []).slice();
  const todos = (appData.todos || []).filter(todo => !todo.done);
  const notes = (appData.notes || []).filter(note => (note.created_at || '').startsWith(today));

  const items = [
    ...logs.map(log => ({ kind: 'log', time: getDateTimeValue(log.date || today, log.time), html: buildLogCard({ ...log, date: log.date || today }) })),
    ...todos.map(todo => ({ kind: 'todo', time: getDateTimeValue(today, todo.end_at || todo.deadline || '23:59:59'), html: buildTodoCard(todo) })),
    ...notes.map(note => ({ kind: 'note', time: note.created_at || `${today} 00:00:00`, html: buildNoteCard(note) }))
  ].sort((a, b) => b.time.localeCompare(a.time));

  if (items.length === 0) {
    container.innerHTML = "<div class='empty-state'><strong>今天还没有记录</strong><span>先写一句，记录会自动进入今日时间线。</span></div>";
    return;
  }

  container.innerHTML = items.map(item => item.html).join('');

  container.querySelectorAll('.today-item').forEach(card => {
    const kind = card.dataset.kind;
    const id = parseInt(card.dataset.id);
    const dateStr = card.dataset.date || today;
    const actionKey = card.dataset.actionKey;
    const actions = card.querySelectorAll('button[data-action]');

    actions.forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (action === 'more') {
          if (expandedMoreActionIds.has(actionKey)) expandedMoreActionIds.delete(actionKey);
          else expandedMoreActionIds.add(actionKey);
          renderTodayTimeline();
          return;
        }

        if (kind === 'log') {
          const log = (appData.logs[dateStr] || []).find(item => item.id === id);
          if (!log) return;
          if (action === 'project') {
            alert('归类只会修改主分类和子项目，不会改变处理状态。未整理记录仍需转为待办、笔记或流水后才算处理完成。');
            const tag = prompt('输入主分类，留空则保持未分类：', log.tag || '未分类');
            if (tag === null) return;
            const subTag = prompt('输入子项目，留空则设为无项目：', log.sub_tag || '');
            await updateQuickRecordProject(log, tag || '未分类', subTag || '');
            return;
          }
          if (action === 'remark') {
            const note = prompt('输入补述：', '');
            if (!note) return;
            await dbExecute("UPDATE logs SET remark=? WHERE id=?", [appendRemarkEntry(log.remark || '', note, new Date(), '补述'), log.id]);
            await loadData();
            renderInboxRecords();
            renderTodayTimeline();
            return;
          }
          if (action === 'edit') {
            renderEditLogModal(log);
            return;
          }
          if (action === 'child') {
            const task = prompt('输入子任务内容：', '');
            if (!task) return;
            await dbExecute(
              "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [task.trim(), false, todo.tag || '未分类', todo.sub_tag || '', '', '', getTodoEnd(todo), '', getTodoEnd(todo), todo.id, '']
            );
            await loadData();
            renderTodayTimeline();
            import('./todo.js').then(m => m.renderTodoList());
            if (typeof window.renderQuickParentTodos === 'function') window.renderQuickParentTodos();
            return;
          }
          if (action === 'delete') {
            if (!confirm('确定删除这条记录吗？')) return;
            await dbExecute("DELETE FROM logs WHERE id=?", [log.id]);
            await loadData();
            renderInboxRecords();
            renderTodayTimeline();
            import('./log.js').then(m => m.renderHistoryList());
            return;
          }
          await convertQuickRecord(log, action);
          return;
        }

        if (kind === 'todo') {
          const todo = appData.todos.find(item => item.id === id);
          if (!todo) return;
          if (action === 'done') {
            await dbExecute("UPDATE todos SET done=?, completed_at=? WHERE id=?", [true, today, todo.id]);
            const completedLogId = await insertAndReturnId(
              "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue, status, record_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [today, new Date().toLocaleTimeString('en-US', { hour12: false }), `完成待办: ${todo.task}`, todo.tag, todo.sub_tag || '', todo.detail || '', todo.remark || '', todo.task, getTodoEnd(todo), false, 'processed', 'log']
            );
            await loadData();
            renderInboxRecords();
            renderTodayTimeline();
            import('./todo.js').then(m => m.renderTodoList());
            import('./log.js').then(m => m.renderHistoryList());
            if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();
            showUndoToast('已完成待办，并生成完成流水。', async () => {
              await dbExecute("UPDATE todos SET done=?, completed_at=? WHERE id=?", [false, '', todo.id]);
              if (completedLogId) await dbExecute("DELETE FROM logs WHERE id=?", [completedLogId]);
              await loadData();
              renderInboxRecords();
              renderTodayTimeline();
              import('./todo.js').then(m => m.renderTodoList());
              import('./log.js').then(m => m.renderHistoryList());
              if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();
            });
            return;
          }
          if (action === 'edit') {
            renderEditTodoModal(todo);
            return;
          }
          if (action === 'remark') {
            const note = prompt('输入补述：', '');
            if (!note) return;
            await dbExecute("UPDATE todos SET remark=? WHERE id=?", [appendRemarkEntry(todo.remark || '', note, new Date(), '补述'), todo.id]);
            await loadData();
            renderTodayTimeline();
            return;
          }
          if (action === 'delete') {
            if (!confirm('确定删除这个待办吗？')) return;
            await dbExecute("DELETE FROM todos WHERE id=?", [todo.id]);
            await loadData();
            renderTodayTimeline();
            import('./todo.js').then(m => m.renderTodoList());
            return;
          }
          return;
        }

        if (kind === 'note') {
          const note = appData.notes.find(item => item.id === id);
          if (!note) return;
          if (action === 'todo') {
            await dbExecute(
              "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [note.title || note.content.substring(0, 24), false, note.tag || '未分类', note.sub_tag || '', note.content || '', '', '', '', '', '', '']
            );
            await loadData();
            renderTodayTimeline();
            import('./todo.js').then(m => m.renderTodoList());
            return;
          }
          if (action === 'edit') {
            renderEditNoteModal(note);
            return;
          }
          if (action === 'delete') {
            if (!confirm('确定删除这条笔记吗？')) return;
            await dbExecute("DELETE FROM notes WHERE id=?", [note.id]);
            await loadData();
            renderTodayTimeline();
            import('./notes.js').then(m => m.renderNotesList());
            return;
          }
        }
      });
    });
  });
}
