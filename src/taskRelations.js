import { appData, dbExecute } from './data.js';
import { escapeHtml } from './htmlUtils.js';

const RELATION_LABELS = {
  independent: '独立任务',
  child: '作为子任务',
  parent: '作为父任务',
  sibling: '作为同级任务'
};

const TARGET_HINTS = {
  child: '选择它的上级任务',
  parent: '选择要放到它下面的任务',
  sibling: '选择一个同级参照任务'
};

function getTodos() {
  return appData?.todos || [];
}

export function getTodoById(id) {
  const targetId = String(id || '');
  if (!targetId) return null;
  return getTodos().find(todo => String(todo.id) === targetId) || null;
}

export function buildTodoPath(todo, byId = new Map(getTodos().map(item => [item.id, item]))) {
  if (!todo) return '';
  const names = [todo.task || '未命名任务'];
  let current = todo;
  const seen = new Set([todo.id]);
  while (current.parent_id && byId.has(current.parent_id) && !seen.has(current.parent_id)) {
    current = byId.get(current.parent_id);
    seen.add(current.id);
    names.unshift(current.task || '未命名任务');
  }
  return names.join(' / ');
}

function isDescendantOf(todoId, ancestorId) {
  const targetId = String(todoId || '');
  const rootId = String(ancestorId || '');
  if (!targetId || !rootId || targetId === rootId) return false;
  const byId = new Map(getTodos().map(todo => [String(todo.id), todo]));
  let current = byId.get(targetId);
  const seen = new Set();
  while (current?.parent_id) {
    const parentId = String(current.parent_id);
    if (parentId === rootId) return true;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    current = byId.get(parentId);
  }
  return false;
}

function isAncestorOf(todoId, descendantId) {
  return isDescendantOf(descendantId, todoId);
}

function normalizeRelation(relation = {}) {
  const mode = relation.mode || 'independent';
  return {
    mode: RELATION_LABELS[mode] ? mode : 'independent',
    targetId: relation.targetId ? String(relation.targetId) : ''
  };
}

export function validateTaskRelation(relation, options = {}) {
  const value = normalizeRelation(relation);
  const sourceId = options.sourceTodoId ? String(options.sourceTodoId) : '';

  if (value.mode === 'independent') return { ok: true, relation: value };
  if (!value.targetId) return { ok: false, message: '请选择一个关联任务。', relation: value };
  if (!getTodoById(value.targetId)) return { ok: false, message: '关联任务不存在或已被删除。', relation: value };
  if (!sourceId) return { ok: true, relation: value };
  if (value.targetId === sourceId) return { ok: false, message: '不能选择任务自己。', relation: value };

  if ((value.mode === 'child' || value.mode === 'sibling') && isDescendantOf(value.targetId, sourceId)) {
    return { ok: false, message: '不能移动到自己的下级任务里。', relation: value };
  }
  if (value.mode === 'parent' && isAncestorOf(value.targetId, sourceId)) {
    return { ok: false, message: '不能把自己的上级任务放到自己下面。', relation: value };
  }

  return { ok: true, relation: value };
}

export function getCreateParentId(relation) {
  const value = normalizeRelation(relation);
  if (value.mode === 'child') return value.targetId;
  if (value.mode === 'parent' || value.mode === 'sibling') {
    return getTodoById(value.targetId)?.parent_id || '';
  }
  return '';
}

export async function applyCreatedTodoRelation(createdTodoId, relation) {
  const value = normalizeRelation(relation);
  if (value.mode !== 'parent' || !createdTodoId || !value.targetId) return;
  await dbExecute('UPDATE todos SET parent_id=? WHERE id=?', [createdTodoId, value.targetId]);
}

export async function applyExistingTodoRelation(sourceTodoId, relation) {
  const checked = validateTaskRelation(relation, { sourceTodoId });
  if (!checked.ok) return checked;

  const sourceId = String(sourceTodoId);
  const value = checked.relation;
  if (value.mode === 'independent') {
    await dbExecute('UPDATE todos SET parent_id=? WHERE id=?', ['', sourceId]);
    return checked;
  }

  const target = getTodoById(value.targetId);
  if (value.mode === 'child') {
    await dbExecute('UPDATE todos SET parent_id=? WHERE id=?', [target.id, sourceId]);
  } else if (value.mode === 'sibling') {
    await dbExecute('UPDATE todos SET parent_id=? WHERE id=?', [target.parent_id || '', sourceId]);
  } else if (value.mode === 'parent') {
    await dbExecute('UPDATE todos SET parent_id=? WHERE id=?', [target.parent_id || '', sourceId]);
    await dbExecute('UPDATE todos SET parent_id=? WHERE id=?', [sourceId, target.id]);
  }
  return checked;
}

export function renderTaskRelationPickerHtml(prefix, options = {}) {
  const mode = options.defaultMode || 'independent';
  const targetId = options.defaultTargetId || '';
  const modes = options.modes || ['independent', 'child', 'parent', 'sibling'];
  const label = options.label || '任务关系';
  const selectedTodo = getTodoById(targetId);
  const selectedPath = selectedTodo ? buildTodoPath(selectedTodo) : '';

  return `
    <div class="task-relation-picker" data-prefix="${escapeHtml(prefix)}">
      <label class="field-label">${escapeHtml(label)}</label>
      <div class="task-relation-mode-grid" role="group" aria-label="${escapeHtml(label)}">
        ${modes.map(item => `
          <button type="button" class="task-relation-mode${item === mode ? ' active' : ''}" data-mode="${item}">
            ${RELATION_LABELS[item]}
          </button>
        `).join('')}
      </div>
      <div class="task-relation-target${mode === 'independent' ? '' : ' show'}">
        <div class="task-relation-selected" data-role="selected">${selectedPath ? escapeHtml(selectedPath) : '尚未选择关联任务'}</div>
        <input type="search" class="hero-input task-relation-search" data-role="search" autocomplete="off" placeholder="搜索任务标题、路径或分类" />
        <input type="hidden" data-role="target" value="${escapeHtml(String(targetId || ''))}" />
        <div class="task-relation-results" data-role="results"></div>
        <div class="task-relation-hint" data-role="hint">${TARGET_HINTS[mode] || ''}</div>
      </div>
    </div>
  `;
}

export function setupTaskRelationPicker(root, prefix, options = {}) {
  const picker = root?.querySelector?.(`.task-relation-picker[data-prefix="${prefix}"]`);
  if (!picker) return null;

  const modeButtons = [...picker.querySelectorAll('.task-relation-mode')];
  const targetWrap = picker.querySelector('.task-relation-target');
  const targetInput = picker.querySelector('[data-role="target"]');
  const searchInput = picker.querySelector('[data-role="search"]');
  const results = picker.querySelector('[data-role="results"]');
  const selected = picker.querySelector('[data-role="selected"]');
  const hint = picker.querySelector('[data-role="hint"]');
  const sourceTodoId = options.sourceTodoId ? String(options.sourceTodoId) : '';

  let mode = modeButtons.find(button => button.classList.contains('active'))?.dataset.mode || 'independent';
  let targetId = targetInput?.value || '';
  let activeIndex = -1;

  const getCandidates = () => {
    const query = (searchInput?.value || '').trim().toLowerCase();
    const byId = new Map(getTodos().map(todo => [todo.id, todo]));
    return getTodos()
      .filter(todo => !todo.done)
      .filter(todo => !sourceTodoId || String(todo.id) !== sourceTodoId)
      .map(todo => ({
        todo,
        path: buildTodoPath(todo, byId),
        invalid: sourceTodoId && (
          ((mode === 'child' || mode === 'sibling') && isDescendantOf(todo.id, sourceTodoId)) ||
          (mode === 'parent' && isAncestorOf(todo.id, sourceTodoId))
        )
      }))
      .filter(item => {
        if (!query) return true;
        const haystack = `${item.path} ${item.todo.tag || ''} ${item.todo.sub_tag || ''}`.toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => {
        if (String(a.todo.id) === targetId) return -1;
        if (String(b.todo.id) === targetId) return 1;
        return (a.todo.sort_order || 0) - (b.todo.sort_order || 0) || a.todo.id - b.todo.id;
      })
      .slice(0, 12);
  };

  const setMode = nextMode => {
    mode = nextMode;
    modeButtons.forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
    targetWrap?.classList.toggle('show', mode !== 'independent');
    if (hint) hint.innerText = TARGET_HINTS[mode] || '';
    renderResults();
  };

  const chooseTodo = todo => {
    targetId = String(todo.id);
    if (targetInput) targetInput.value = targetId;
    if (selected) selected.innerText = buildTodoPath(todo);
    if (searchInput) searchInput.value = '';
    results?.classList.remove('show');
  };

  const renderResults = () => {
    if (!results) return;
    if (mode === 'independent') {
      results.classList.remove('show');
      return;
    }

    const candidates = getCandidates();
    activeIndex = Math.min(activeIndex, candidates.length - 1);
    results.innerHTML = candidates.length ? candidates.map((item, index) => `
      <button type="button" class="task-relation-option${index === activeIndex ? ' active' : ''}" data-id="${item.todo.id}" ${item.invalid ? 'disabled' : ''}>
        <span>${escapeHtml(item.path)}</span>
        <em>${item.invalid ? '不可选' : escapeHtml([item.todo.tag, item.todo.sub_tag].filter(Boolean).join(' / '))}</em>
      </button>
    `).join('') : '<div class="task-relation-empty">没有匹配的未完成任务</div>';
    results.classList.add('show');
  };

  modeButtons.forEach(button => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  searchInput?.addEventListener('focus', renderResults);
  searchInput?.addEventListener('input', () => {
    activeIndex = -1;
    renderResults();
  });
  searchInput?.addEventListener('keydown', event => {
    const options = [...results.querySelectorAll('.task-relation-option:not(:disabled)')];
    if (!options.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % options.length;
      renderResults();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = activeIndex <= 0 ? options.length - 1 : activeIndex - 1;
      renderResults();
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      const option = options[activeIndex];
      const todo = getTodoById(option.dataset.id);
      if (todo) chooseTodo(todo);
    } else if (event.key === 'Escape') {
      results.classList.remove('show');
    }
  });

  results?.addEventListener('mousedown', event => {
    const option = event.target.closest('.task-relation-option');
    if (!option || option.disabled) return;
    event.preventDefault();
    const todo = getTodoById(option.dataset.id);
    if (todo) chooseTodo(todo);
  });

  picker.addEventListener('click', event => {
    if (event.target.closest('.task-relation-search, .task-relation-results')) return;
    if (mode !== 'independent' && !targetId) renderResults();
  });

  document.addEventListener('mousedown', event => {
    if (!picker.contains(event.target)) results?.classList.remove('show');
  });

  const selectedTodo = getTodoById(targetId);
  if (selectedTodo) chooseTodo(selectedTodo);
  setMode(mode);

  return {
    getValue() {
      return normalizeRelation({ mode, targetId });
    },
    validate() {
      return validateTaskRelation({ mode, targetId }, { sourceTodoId });
    },
    reset() {
      targetId = '';
      if (targetInput) targetInput.value = '';
      if (selected) selected.innerText = '尚未选择关联任务';
      if (searchInput) searchInput.value = '';
      setMode(options.defaultMode || 'independent');
    },
    refresh() {
      const todo = getTodoById(targetId);
      if (todo && selected) selected.innerText = buildTodoPath(todo);
      if (targetId && !todo) this.reset();
      renderResults();
    }
  };
}
