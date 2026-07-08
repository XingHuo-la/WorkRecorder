import { appData, dbExecute, dbQuery, loadData, getTodayString, DEFAULT_TAG } from './data.js';
import { renderHistoryList } from './log.js'; 
import { openUniversalEditModal } from './formUtils.js';
import { appendRemarkEntry, escapeHtml, insertTextareaNewline, textWithLineBreaks } from './htmlUtils.js';
import { openScheduleTodoModal } from './quickCapture.js';
import { showUndoToast } from './undoToast.js';
import { createTimeRangePicker } from './timeRangePicker.js';
import {
  applyCreatedTodoRelation,
  applyExistingTodoRelation,
  getCreateParentId,
  renderTaskRelationPickerHtml,
  setupTaskRelationPicker,
  validateTaskRelation
} from './taskRelations.js';

function refreshTaskRelatedViews() {
  if (window.renderTodoParents) window.renderTodoParents();
  if (window.renderQuickParentTodos) window.renderQuickParentTodos();
  if (typeof window.renderTodayTimeline === 'function') window.renderTodayTimeline();
  if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();
}

function hasPendingDescendant(todoId) {
  const targetId = String(todoId);
  const children = (appData.todos || []).filter(todo => String(todo.parent_id || '') === targetId);
  return children.some(child => !child.done || hasPendingDescendant(child.id));
}

async function insertAndReturnId(query, params) {
  const rows = await dbQuery(`${query} RETURNING id`, params);
  return rows?.[0]?.id || null;
}

export function initTodoModule() {
  const hasDateRangeCb = document.getElementById('todo-has-date-range');
  const dateRangeFields = document.getElementById('todo-date-range-fields');
  const timeRangeContainer = document.getElementById('todo-time-range-picker');
  const startInput = document.getElementById('todo-start-input');
  const endInput = document.getElementById('todo-end-input');
  const hasParentCb = document.getElementById('todo-has-parent');
  const parentSelect = document.getElementById('todo-parent-select');
  const parentControl = document.querySelector('.parent-task-control');
  const tagSelect = document.getElementById('todo-tag-select'); const tagNewInput = document.getElementById('todo-tag-new');
  const subSelect = document.getElementById('todo-sub-tag-select'); const subNewInput = document.getElementById('todo-sub-tag-new');
  const addTodoBtn = document.getElementById('add-todo-btn');

  if (!hasDateRangeCb || !dateRangeFields || !startInput || !endInput || !hasParentCb || !parentSelect || !tagSelect || !tagNewInput || !subSelect || !subNewInput || !addTodoBtn) {
    return;
  }

  const timeRangePicker = createTimeRangePicker(timeRangeContainer, {
    valueStart: startInput.value,
    valueEnd: endInput.value,
    allowDateOnly: true,
    minuteStep: 30,
    onChange: (start, end) => {
      startInput.value = start;
      endInput.value = end;
    }
  });

  hasDateRangeCb.onchange = () => dateRangeFields.style.display = hasDateRangeCb.checked ? 'flex' : 'none';
  hasParentCb.onchange = () => parentSelect.style.display = hasParentCb.checked ? 'block' : 'none';
  if (parentControl && !parentControl.querySelector('.task-relation-picker')) {
    hasParentCb.closest('label')?.style.setProperty('display', 'none');
    parentSelect.style.display = 'none';
    parentSelect.insertAdjacentHTML('afterend', renderTaskRelationPickerHtml('todo-create-relation', {
      label: '任务关系',
      defaultMode: 'independent'
    }));
  }
  const todoCreateRelationPicker = setupTaskRelationPicker(parentControl, 'todo-create-relation');

  window.renderTodoParents = () => {
    if (!parentSelect) return;
    const currentValue = parentSelect.value;
    const byId = new Map((appData.todos || []).map(todo => [todo.id, todo]));
    const buildPath = (todo) => {
      const names = [todo.task];
      let current = todo;
      const seen = new Set([todo.id]);
      while (current.parent_id && byId.has(current.parent_id) && !seen.has(current.parent_id)) {
        current = byId.get(current.parent_id);
        seen.add(current.id);
        names.unshift(current.task);
      }
      return names.join(' / ');
    };

    parentSelect.innerHTML = '<option value="">选择上级任务...</option>';
    appData.todos
      .filter(t => !t.done)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id)
      .forEach(todo => {
        const safeTask = escapeHtml(buildPath(todo));
        parentSelect.innerHTML += `<option value="${todo.id}">${safeTask}</option>`;
      });
    if ([...parentSelect.options].some(opt => opt.value === currentValue)) parentSelect.value = currentValue;
    todoCreateRelationPicker?.refresh?.();
  };

  window.renderTodoTags = () => {
      tagSelect.innerHTML = '';
      const activeTags = (appData.settings && appData.settings.active_tags) ? appData.settings.active_tags : appData.tags;
      [DEFAULT_TAG, ...activeTags.filter(t => t !== DEFAULT_TAG)].forEach(t => {
        const safeTag = escapeHtml(t);
        tagSelect.innerHTML += `<option value="${safeTag}">${safeTag}</option>`;
      });
      tagSelect.innerHTML += `<option value="NEW">新建主分类...</option>`;
      
      // 当没有任何活跃分类时，强制显示输入框。
      tagNewInput.style.display = tagSelect.value === 'NEW' ? 'block' : 'none';
      window.renderTodoSubTags();
    };

  window.renderTodoSubTags = () => {
    const mainTag = tagSelect.value === 'NEW' ? tagNewInput.value.trim() : tagSelect.value;
    subSelect.innerHTML = '<option value="">(无子项目)</option>';
    if (mainTag && appData.sub_tags && appData.sub_tags[mainTag]) appData.sub_tags[mainTag].forEach(t => {
      const safeSub = escapeHtml(t);
      subSelect.innerHTML += `<option value="${safeSub}">${safeSub}</option>`;
    });
    subSelect.innerHTML += `<option value="NEW">新建子项目...</option>`;
  };

  tagSelect.addEventListener('change', () => { tagNewInput.style.display = tagSelect.value === 'NEW' ? 'block' : 'none'; if(tagSelect.value === 'NEW') tagNewInput.focus(); subNewInput.style.display = 'none'; window.renderTodoSubTags(); });
  tagNewInput.addEventListener('input', window.renderTodoSubTags);
  subSelect.addEventListener('change', () => { subNewInput.style.display = subSelect.value === 'NEW' ? 'block' : 'none'; if(subSelect.value === 'NEW') subNewInput.focus(); });
  window.renderTodoTags();
  window.renderTodoParents();

  addTodoBtn.addEventListener('click', async () => {
    const taskInput = document.getElementById('todo-task-input').value.trim();
    if (!taskInput) { alert("待办内容不能为空"); return; }
    const finalTag = (tagSelect.value === 'NEW' ? tagNewInput.value.trim() : tagSelect.value) || DEFAULT_TAG;
    const finalSub = subSelect.value === 'NEW' ? subNewInput.value.trim() : subSelect.value;

    // 🌟 外科手术 1：如果新建了标签，直接写进数据库
    if (tagSelect.value === 'NEW' && finalTag !== DEFAULT_TAG) {
        await dbExecute("INSERT OR IGNORE INTO tags (name, is_active) VALUES (?, ?)", [finalTag, true]);
    }
    if (finalSub && subSelect.value === 'NEW') {
        await dbExecute("INSERT INTO sub_tags (main_tag, name) VALUES (?, ?)", [finalTag, finalSub]);
    }

    const detailInput = document.getElementById('todo-detail-input').value.trim();
    const startVal = hasDateRangeCb.checked ? startInput.value : "";
    const endVal = hasDateRangeCb.checked ? endInput.value : "";
    if (hasDateRangeCb.checked && startVal && endVal && new Date(startVal) > new Date(endVal)) {
      alert("计划开始时间不能晚于结束时间");
      return;
    }
    const relation = todoCreateRelationPicker?.getValue?.() || {
      mode: hasParentCb.checked && parentSelect.value ? 'child' : 'independent',
      targetId: hasParentCb.checked ? parentSelect.value : ''
    };
    const relationCheck = validateTaskRelation(relation);
    if (!relationCheck.ok) {
      alert(relationCheck.message);
      return;
    }
    const parentId = getCreateParentId(relationCheck.relation);

    // 🌟 外科手术 2：插入一条新待办
    const createdTodoId = await insertAndReturnId(
        "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [taskInput, false, finalTag, finalSub, detailInput, "", endVal, startVal, endVal, parentId, ""]
    );
    await applyCreatedTodoRelation(createdTodoId, relationCheck.relation);
    
    // 刷新数据与UI
    await loadData(); 
    
    // 👇 核心修复 2：提交后必须先重新渲染下拉菜单，再重新设置选中项！
    window.renderTodoTags(); 
    tagSelect.value = finalTag; 
    tagNewInput.style.display = 'none'; 
    window.renderTodoSubTags(); 
    subSelect.value = finalSub; 
    window.renderTodoParents();

    document.getElementById('todo-task-input').value = ""; document.getElementById('todo-detail-input').value = "";
    if(hasDateRangeCb.checked) {
      hasDateRangeCb.checked = false;
      dateRangeFields.style.display = 'none';
      startInput.value = "";
      endInput.value = "";
      timeRangePicker?.clear();
    }
    if(hasParentCb.checked) {
      hasParentCb.checked = false;
      parentSelect.style.display = 'none';
      parentSelect.value = "";
    }
    todoCreateRelationPicker?.reset?.();
    renderTodoList(); 
    if(window.renderLogTags) window.renderLogTags();
    refreshTaskRelatedViews();
  });
  
  autoCleanupTodos();
}

export async function renderTodoList() {
  const container = document.getElementById('todo-list-container'); if(!container) return; container.innerHTML = ""; 
  const completedContainer = document.getElementById('completed-todos-container');
  if (completedContainer) completedContainer.innerHTML = "";
  if (typeof window.updateWorkspaceSummary === 'function') window.updateWorkspaceSummary();
  let pendingTodos = appData.todos.filter(t => !t.done); const completedTodos = appData.todos.filter(t => t.done);
  const completedSection = completedContainer?.closest('.completed-todos-section');
  if (completedSection) completedSection.style.display = completedTodos.length > 0 ? '' : 'none';

  const getTodoEnd = (todo) => todo.end_at || todo.deadline || "";
  const sortTodos = (a, b) => {
    const aEnd = getTodoEnd(a);
    const bEnd = getTodoEnd(b);
    if (aEnd && bEnd) return new Date(aEnd) - new Date(bEnd);
    if (aEnd) return -1;
    if (bEnd) return 1;
    if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0);
    return appData.todos.indexOf(a) - appData.todos.indexOf(b);
  };
  pendingTodos.sort(sortTodos);

  const allChildrenByParent = new Map();
  appData.todos.forEach(todo => {
    if (!todo.parent_id) return;
    if (!allChildrenByParent.has(todo.parent_id)) allChildrenByParent.set(todo.parent_id, []);
    allChildrenByParent.get(todo.parent_id).push(todo);
  });

  const pendingChildrenByParent = new Map();
  pendingTodos.forEach(todo => {
    if (!todo.parent_id) return;
    if (!pendingChildrenByParent.has(todo.parent_id)) pendingChildrenByParent.set(todo.parent_id, []);
    pendingChildrenByParent.get(todo.parent_id).push(todo);
  });

  const pendingIds = new Set(pendingTodos.map(t => t.id));
  const rootTodos = pendingTodos.filter(t => !t.parent_id || !pendingIds.has(t.parent_id)).sort(sortTodos);

  const buildTodoCard = (todo, depth = 0) => {
      const safeTag = escapeHtml(todo.tag);
      const safeTask = escapeHtml(todo.task);
      const safeSubTag = escapeHtml(todo.sub_tag);
      const startAt = todo.start_at || "";
      const endAt = getTodoEnd(todo);
      const safeStart = escapeHtml(startAt);
      const safeEnd = escapeHtml(endAt);
      const childTodos = (pendingChildrenByParent.get(todo.id) || []).sort(sortTodos);
      const allChildren = allChildrenByParent.get(todo.id) || [];
      const doneChildren = allChildren.filter(child => child.done).length;
      const childProgressHtml = allChildren.length > 0
        ? `<span class="todo-progress-badge">${doneChildren}/${allChildren.length}</span>`
        : "";
      let subTagHtml = todo.sub_tag ? `<span style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px;">📁 ${safeSubTag}</span>` : "";
      
      let deadlineHtml = "";
      let accordionThemeClass = depth > 0 ? "border-muted" : "border-primary";

      if (endAt) {
          const today = new Date(); today.setHours(0,0,0,0);
          const dl = new Date(endAt); dl.setHours(0,0,0,0);
          const diff = dl - today;
          
          let bg, color, border, text;
          if (diff < 0) {
              bg = 'rgba(var(--color-danger-rgb), 0.15)'; color = 'var(--color-danger)'; border = 'rgba(var(--color-danger-rgb), 0.5)'; 
              text = startAt ? `已延期 ${safeStart} 至 ${safeEnd}` : `已延期 (${safeEnd})`;
              accordionThemeClass = "border-danger";
          } else if (diff === 0) {
              bg = 'rgba(var(--color-warning-rgb), 0.15)'; color = 'var(--color-warning)'; border = 'rgba(var(--color-warning-rgb), 0.5)'; 
              text = startAt ? `今日到期 ${safeStart} 至 ${safeEnd}` : `今日到期 (${safeEnd})`;
              accordionThemeClass = "border-warning";
          } else {
              bg = 'rgba(var(--color-primary-rgb), 0.15)'; color = 'var(--color-primary)'; border = 'rgba(var(--color-primary-rgb), 0.5)'; 
              text = startAt ? `${safeStart} 至 ${safeEnd}` : `截至 ${safeEnd}`;
          }
          
          deadlineHtml = `<span style="background: ${bg}; color: ${color}; border: 1px solid ${border}; padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 10px; white-space: nowrap;">${text}</span>`;
      }
      
      let remarkHtml = todo.remark ? `<div class="item-remark">${textWithLineBreaks(todo.remark)}</div>` : "";
      let detailBadge = todo.detail ? `<span style="background: var(--overlay-light); color: var(--text-muted); border: 1px solid var(--border-medium); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">详</span>` : "";
      let remarkBadge = todo.remark ? `<span style="background: rgba(var(--color-warning-rgb), 0.15); color: var(--color-warning); border: 1px solid rgba(var(--color-warning-rgb), 0.3); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">述</span>` : "";
      const childHtml = childTodos.length > 0
        ? `<div class="subtask-list">${childTodos.map(child => buildTodoCard(child, depth + 1)).join('')}</div>`
        : "";

      return `
        <details class="glass-accordion ${accordionThemeClass} ${depth > 0 ? 'subtask-card' : ''} ${depth >= 2 ? 'deep-subtask-card' : ''}" data-depth="${depth}" style="margin-bottom: 8px;">
          <summary class="log-summary" style="display:flex; align-items:center;">
            <input type="checkbox" class="todo-cb" data-id="${todo.id}" style="margin-right:12px; width:18px; height:18px; cursor:pointer;" onclick="event.stopPropagation();">
            <span class="log-text"><b>[${safeTag}]</b> ${safeTask} ${childProgressHtml} ${subTagHtml} ${deadlineHtml} ${detailBadge} ${remarkBadge}</span>
          </summary>
          <div class="expanded-content">
            <div style="margin-bottom: 15px;">${todo.detail ? textWithLineBreaks(todo.detail) : '(未填写详细说明)'}</div>
            ${remarkHtml}
            ${childHtml}
            <div class="quick-note" data-kind="todo" data-id="${todo.id}">
              <select class="quick-note-type">
                <option value="过程">过程</option>
                <option value="问题">问题</option>
                <option value="想法">想法</option>
                <option value="结论">结论</option>
                <option value="复盘">复盘</option>
                <option value="资料">资料</option>
              </select>
              <input type="text" class="quick-note-input" placeholder="追加一条记录，回车保存..." />
              <button class="quick-note-btn" type="button">追加</button>
            </div>
            <div style="display: flex; gap: 10px; border-top: 1px dashed var(--border-light); padding-top: 10px; justify-content: flex-end; flex-wrap: wrap;">
              <button type="button" class="icon-btn add-child-todo-btn" data-id="${todo.id}" style="margin:0;">快速添加下级任务</button>
              <button type="button" class="icon-btn full-child-todo-btn" data-id="${todo.id}" style="margin:0;">完整添加下级任务</button>
              <div class="dropdown-wrapper" onclick="event.preventDefault(); event.stopPropagation();">
                  <button class="dots-btn icon-btn" style="padding: 4px 10px; margin: 0; font-size: 13px;" onclick="
                      const menu = this.nextElementSibling; const isShow = menu.classList.contains('show');
                      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
                      document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
                      if (!isShow) { menu.classList.add('show'); const card = this.closest('.glass-accordion'); if(card) card.classList.add('elevated-zindex'); }
                  ">操作</button>
                  <div class="dropdown-menu">
                      <div class="dropdown-item add-remark-todo-btn" data-id="${todo.id}">💬 添加/修改补述</div>
                      <div class="dropdown-item move-todo-btn" data-id="${todo.id}">调整层级</div>
                      <div class="dropdown-item edit-todo-btn" data-id="${todo.id}">✏️ 编辑任务</div>
                      <div class="dropdown-item danger del-todo-btn" data-id="${todo.id}">删除待办</div>
                  </div>
              </div>
            </div>
          </div>
        </details>
      `;
    };

  if (pendingTodos.length === 0) {
    container.innerHTML = "<div class='empty-state'><strong>今天还没有待办</strong></div>";
  } else {
    rootTodos.forEach(todo => container.insertAdjacentHTML('beforeend', buildTodoCard(todo)));

    const closeMenus = () => {
      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
      document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
    };

    document.querySelectorAll('.quick-note[data-kind="todo"]').forEach(box => {
      const input = box.querySelector('.quick-note-input');
      const typeSelect = box.querySelector('.quick-note-type');
      const btn = box.querySelector('.quick-note-btn');
      const save = async () => {
        const note = input.value.trim();
        if (!note) return;
        const id = parseInt(box.dataset.id);
        const todo = appData.todos.find(item => item.id === id);
        if (!todo) return;
        btn.disabled = true;
        await dbExecute("UPDATE todos SET remark=? WHERE id=?", [appendRemarkEntry(todo.remark || "", note, new Date(), typeSelect.value), id]);
        await loadData();
        renderTodoList();
        refreshTaskRelatedViews();
      };
      btn.addEventListener('click', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.altKey) {
          e.preventDefault();
          insertTextareaNewline(input);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          save();
        }
      });
    });

    document.querySelectorAll('.add-child-todo-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const parentId = btn.getAttribute('data-id');
        const parentTodo = appData.todos.find(item => String(item.id) === String(parentId));
        if (!parentTodo) return;
        const task = prompt('输入下级任务内容：', '');
        if (!task) return;
        const currentTag = parentTodo.tag || '';
        const currentSub = parentTodo.sub_tag || '';
        dbExecute(
          "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [task.trim(), false, currentTag, currentSub, '', '', parentTodo.deadline || '', '', parentTodo.deadline || '', parentTodo.id, '']
        ).then(async () => {
          await loadData();
          renderTodoList();
          refreshTaskRelatedViews();
        });
      });
    });

    document.querySelectorAll('.full-child-todo-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const parentId = btn.getAttribute('data-id');
        const parentTodo = appData.todos.find(item => String(item.id) === String(parentId));
        if (!parentTodo) return;
        openScheduleTodoModal(null, {
          parentTodoId: parentTodo.id,
          parentTodo,
          defaultTag: parentTodo.tag || DEFAULT_TAG,
          defaultSubTag: parentTodo.sub_tag || ''
        });
      });
    });

    document.querySelectorAll('.todo-cb').forEach(cb => {
      cb.addEventListener('change', async (e) => {
        const id = parseInt(e.target.getAttribute('data-id')); 
        const todo = appData.todos.find(t => t.id === id);
        if (hasPendingDescendant(id) && !confirm('该任务还有未完成的下级任务，仍要完成吗？')) {
          e.target.checked = false;
          return;
        }
        
        const todayStr = getTodayString();
        const timeStr = new Date().toLocaleTimeString('en-US', {hour12: false});
        
        // 1. 改变待办状态
        await dbExecute("UPDATE todos SET done = ?, completed_at = ? WHERE id = ?", [true, todayStr, id]);
        const completedLogId = await insertAndReturnId(
            "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [todayStr, timeStr, todo.task, todo.tag, todo.sub_tag || "", todo.detail || "", todo.remark || "", todo.task, getTodoEnd(todo), false]
        );
        
        await loadData(); renderTodoList(); renderHistoryList(); 
        refreshTaskRelatedViews();
        showUndoToast('已完成待办，并生成完成流水。', async () => {
          await dbExecute("UPDATE todos SET done = ?, completed_at = ? WHERE id = ?", [false, "", id]);
          if (completedLogId) await dbExecute("DELETE FROM logs WHERE id=?", [completedLogId]);
          await loadData();
          renderTodoList();
          renderHistoryList();
          refreshTaskRelatedViews();
        });
      });
    });

    // 修改补述
    document.querySelectorAll('.add-remark-todo-btn').forEach(btn => {
        btn.onclick = (e) => {
            closeMenus();
            const id = parseInt(e.target.getAttribute('data-id')); 
            const todo = appData.todos.find(t => t.id === id);
            window.showModal("待办事项补述与复盘", `
                <div class="form-group">
                    <label class="field-label" style="color:var(--color-primary);">记录执行情况、不完善的地方、遗留问题或注意事项：</label>
                    <textarea id="m-todo-remark" class="hero-textarea" style="margin-top:10px; min-height: 120px;">${escapeHtml(todo.remark)}</textarea>
                </div>
            `, body => body.querySelector('#m-todo-remark').focus(), async (body) => {
                const remark = body.querySelector('#m-todo-remark').value.trim();
                await dbExecute("UPDATE todos SET remark = ? WHERE id = ?", [remark, id]);
                await loadData(); renderTodoList();
                refreshTaskRelatedViews();
            });
        };
    });

    document.querySelectorAll('.move-todo-btn').forEach(btn => {
      btn.onclick = async (e) => {
        closeMenus();
        const id = parseInt(e.target.getAttribute('data-id'));
        const todo = appData.todos.find(t => t.id === id);
        if (!todo) return;
        let relationPicker = null;
        window.showModal('调整任务层级', `
          <div class="form-group">
            <div class="task-relation-current">当前任务：${escapeHtml(todo.task || '')}</div>
            ${renderTaskRelationPickerHtml('move-todo-relation', {
              label: '移动方式',
              defaultMode: todo.parent_id ? 'child' : 'independent',
              defaultTargetId: todo.parent_id || ''
            })}
          </div>
        `, body => {
          relationPicker = setupTaskRelationPicker(body, 'move-todo-relation', { sourceTodoId: todo.id });
        }, async () => {
          const relation = relationPicker?.getValue?.() || { mode: 'independent', targetId: '' };
          const result = await applyExistingTodoRelation(todo.id, relation);
          if (!result.ok) {
            alert(result.message);
            return false;
          }
          await loadData();
          renderTodoList();
          refreshTaskRelatedViews();
          return true;
        }, { btnText: '保存层级' });
      };
    });

    // 编辑待办
    document.querySelectorAll('.edit-todo-btn').forEach(btn => {
      btn.onclick = (e) => {
        closeMenus();
        const id = parseInt(e.target.getAttribute('data-id')); 
        const todo = appData.todos.find(t => t.id === id);
        const currentTheme = (appData.settings && appData.settings.theme === 'light') ? 'theme-light-modal' : 'theme-dark-modal';

        openUniversalEditModal("✏️ 编辑待办事项", todo, {
            type: 'todo',
            themeClass: currentTheme,
            onSave: async (updatedData) => {
                await dbExecute(
                    "UPDATE todos SET task=?, tag=?, sub_tag=?, detail=?, deadline=?, start_at=?, end_at=? WHERE id=?",
                    [updatedData.text, updatedData.tag, updatedData.sub_tag, updatedData.detail, updatedData.deadline, updatedData.start_at, updatedData.deadline, id]
                );
                await loadData(); renderTodoList(); 
                refreshTaskRelatedViews();
                return true; 
            }
        });
      };
    });

    // 删除待办
    document.querySelectorAll('.del-todo-btn').forEach(btn => {
      btn.onclick = async (e) => {
        closeMenus();
        const id = parseInt(e.target.getAttribute('data-id')); 
        const todo = appData.todos.find(t => t.id === id);
        const safeTask = escapeHtml(todo.task);
        window.showModal("确认删除待办", `<div style="font-size: 15px; color: var(--text-main);">确定要永久删除待办 <b>"${safeTask}"</b> 吗？</div>`, null, async () => {
            await dbExecute("UPDATE todos SET parent_id=? WHERE parent_id=?", ["", id]);
            await dbExecute("DELETE FROM todos WHERE id=?", [id]);
            await loadData(); renderTodoList(); 
            refreshTaskRelatedViews();
        }, { danger: true });
      };
    });
  }

  // ---------------- 已完成待办区域 ----------------
  if (completedTodos.length > 0) {
    const completedMount = completedContainer || container;
    const detailsStr = `<details class="glass-accordion border-success completed-todos-accordion"><summary class="log-summary completed-todos-summary"><span class="log-text">已完成 ${completedTodos.length} 个</span></summary><div class="expanded-content" id="completed-todos-drawer" style="padding: 15px;"></div></details>`;
    completedMount.insertAdjacentHTML('beforeend', detailsStr);
    const drawer = document.getElementById('completed-todos-drawer');
    
    completedTodos.forEach(todo => {
      const safeTag = escapeHtml(todo.tag);
      const safeTask = escapeHtml(todo.task);
      const safeSubTag = escapeHtml(todo.sub_tag);
      const safeCompletedAt = escapeHtml(todo.completed_at || '未知');
      const itemDiv = document.createElement('div'); 
      itemDiv.className = 'todo-item'; 
      itemDiv.style.opacity = '0.6'; 
      itemDiv.style.border = '1px dashed rgba(255,255,255,0.1)';
      itemDiv.style.alignItems = 'flex-start';

      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.style.accentColor = '#4ade80';
      checkbox.style.marginTop = '4px'; 
      
      // 撤销已完成
      checkbox.addEventListener('change', async () => {
        const completedDate = todo.completed_at || getTodayString(); 
        // 1. 恢复待办状态
        await dbExecute("UPDATE todos SET done = ?, completed_at = ? WHERE id = ?", [false, "", todo.id]);
        // 2. 删掉流水记录
        await dbExecute("DELETE FROM logs WHERE date = ? AND linked_todo = ?", [completedDate, todo.task]);
        
        await loadData(); renderTodoList(); renderHistoryList(); 
        refreshTaskRelatedViews();
      });
      
      const contentCol = document.createElement('div');
      contentCol.style.flex = "1"; contentCol.style.display = "flex"; contentCol.style.flexDirection = "column";

      const textSpan = document.createElement('span'); textSpan.className = 'todo-text';
      let subTagHtml = todo.sub_tag ? `<span style="color: gray; font-size: 12px; margin-left: 5px;">📁 ${safeSubTag}</span>` : "";
      textSpan.innerHTML = `<del style="color: gray;"><span class="todo-tag">[${safeTag}]</span> ${safeTask} ${subTagHtml}</del> <span style="font-size:12px;color:#64748B;margin-left:8px;">(完成于 ${safeCompletedAt})</span>`;
      contentCol.appendChild(textSpan);

      if (todo.remark) {
          const rDiv = document.createElement('div'); rDiv.className = 'item-remark-completed';
          rDiv.innerHTML = `<b>补述：</b>${textWithLineBreaks(todo.remark)}`; contentCol.appendChild(rDiv);
      }
      
      const actionsDiv = document.createElement('div'); actionsDiv.className = 'item-actions'; actionsDiv.style.marginTop = '0';
      
      const remarkBtn = document.createElement('button'); remarkBtn.className = 'icon-btn'; remarkBtn.innerText = '💬'; remarkBtn.title = "添加/修改补述";
      remarkBtn.onclick = () => {
          window.showModal("待办事项补述与复盘", `
              <div class="form-group">
                  <label class="field-label" style="color:var(--color-primary);">记录执行情况、遗留问题或注意事项：</label>
                  <textarea id="m-todo-remark" class="hero-textarea" style="margin-top:10px; min-height: 120px;">${escapeHtml(todo.remark)}</textarea>
              </div>
          `, body => body.querySelector('#m-todo-remark').focus(), async (body) => {
              const remark = body.querySelector('#m-todo-remark').value.trim();
              await dbExecute("UPDATE todos SET remark = ? WHERE id = ?", [remark, todo.id]);
              await loadData(); renderTodoList();
              refreshTaskRelatedViews();
          });
      };

      const delBtn = document.createElement('button'); delBtn.className = 'icon-btn del-btn'; delBtn.innerText = '删除';
      delBtn.onclick = async () => { 
          window.showModal("永久删除", `<div style="font-size: 15px; color: var(--text-main);">确定永久删除已完成的待办 <b>"${safeTask}"</b> 吗？此操作不可恢复。</div>`, null, async () => {
              await dbExecute("DELETE FROM todos WHERE id=?", [todo.id]);
              await loadData(); renderTodoList();
              refreshTaskRelatedViews();
          }, { danger: true });
      };
      
      actionsDiv.append(remarkBtn, delBtn); itemDiv.append(checkbox, contentCol, actionsDiv); drawer.appendChild(itemDiv);
    });

    const clearAllBtn = document.createElement('button'); clearAllBtn.className = 'icon-btn completed-clear-btn'; clearAllBtn.style.width = 'auto'; clearAllBtn.style.marginTop = '15px'; clearAllBtn.innerText = '一键清理所有已完成待办';
    
    clearAllBtn.onclick = async () => { 
        window.showModal("清理已完成待办", `<div style="font-size: 15px; color: var(--text-main);">确定要永久删除 <b>所有已完成待办</b> 吗？<br><br><span style="color:#ff6b6b;font-size:13px;">删除后无法恢复，建议先备份数据库。</span></div>`, null, async () => {
            const confirmed = confirm("将永久删除所有已完成待办，删除后无法恢复。建议先备份数据库。\n\n确定继续删除吗？");
            if (!confirmed) return false;
            await dbExecute("DELETE FROM todos WHERE done = ?", [true]);
            await loadData(); renderTodoList(); 
            refreshTaskRelatedViews();
        }, { danger: true, btnText: "🧹 立即清理" });
    };
    drawer.appendChild(clearAllBtn);
  }
}

export async function autoCleanupTodos(options = {}) {
    if (!appData.settings || appData.settings.auto_cleanup_days === undefined) {
        renderTodoList(); return;
    }
    const days = parseInt(appData.settings.auto_cleanup_days);
    if (!Number.isFinite(days) || days <= 0) { renderTodoList(); return; }

    const shouldConfirm = options.confirmBeforeCleanup !== false;
    if (shouldConfirm) {
        const confirmed = confirm(`自动清理将永久删除所有已完成超过 ${days} 天的待办，删除后无法恢复。建议先备份数据库。\n\n确定现在执行自动清理吗？`);
        if (!confirmed) {
            renderTodoList();
            return;
        }
    }

    // 利用 SQLite 原生的时间计算功能自动清理。
    await dbExecute(
        "DELETE FROM todos WHERE done = ? AND completed_at != ? AND date(completed_at) < date('now', 'localtime', ?)", 
        [true, "", `-${days} days`]
    );
    
    await loadData();
    renderTodoList();
}
