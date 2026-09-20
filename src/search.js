import { dbQuery } from './data.js';
import { escapeHtml, textWithLineBreaks } from './htmlUtils.js';

const SEARCH_LIMIT_PER_TYPE = 50;

function normalizeKeyword(value) {
  return (value || '').trim();
}

function makeLikeParam(keyword) {
  return `%${keyword}%`;
}

function pickSnippet(record, fields, keyword) {
  const lowerKeyword = keyword.toLowerCase();
  const source = fields
    .map(field => record[field] || '')
    .find(value => String(value).toLowerCase().includes(lowerKeyword))
    || fields.map(field => record[field] || '').find(Boolean)
    || '';

  const text = String(source).replace(/\s+/g, ' ').trim();
  if (text.length <= 140) return text;

  const index = text.toLowerCase().indexOf(lowerKeyword);
  const start = index > 40 ? index - 40 : 0;
  const end = Math.min(text.length, start + 140);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function formatTypeLabel(type) {
  if (type === 'log') return '流水';
  if (type === 'todo') return '待办';
  if (type === 'note') return '笔记';
  return type;
}

async function searchLogs(keyword) {
  const like = makeLikeParam(keyword);
  const rows = await dbQuery(
    `SELECT id, text AS title, detail, remark, tag, sub_tag,
            (date || ' ' || time) AS time, record_type
       FROM logs
      WHERE COALESCE(text, '') LIKE ?
         OR COALESCE(detail, '') LIKE ?
         OR COALESCE(remark, '') LIKE ?
         OR COALESCE(tag, '') LIKE ?
         OR COALESCE(sub_tag, '') LIKE ?
      ORDER BY date DESC, time DESC, id DESC
      LIMIT ?`,
    [like, like, like, like, like, SEARCH_LIMIT_PER_TYPE]
  );

  return rows.map(row => ({
    type: 'log',
    id: row.id,
    title: row.title || '流水记录',
    snippet: pickSnippet(row, ['title', 'detail', 'remark', 'tag', 'sub_tag'], keyword),
    detail: [row.detail, row.remark].filter(Boolean).join('\n\n'),
    tag: row.tag || '',
    sub_tag: row.sub_tag || '',
    time: row.time || '',
    meta: row.record_type || 'log'
  }));
}

async function searchTodos(keyword) {
  const like = makeLikeParam(keyword);
  const rows = await dbQuery(
    `SELECT id, task AS title, detail, remark, tag, sub_tag,
            COALESCE(NULLIF(end_at, ''), NULLIF(deadline, ''), NULLIF(completed_at, ''), '') AS time,
            done
       FROM todos
      WHERE COALESCE(task, '') LIKE ?
         OR COALESCE(detail, '') LIKE ?
         OR COALESCE(remark, '') LIKE ?
         OR COALESCE(tag, '') LIKE ?
         OR COALESCE(sub_tag, '') LIKE ?
      ORDER BY id DESC
      LIMIT ?`,
    [like, like, like, like, like, SEARCH_LIMIT_PER_TYPE]
  );

  return rows.map(row => ({
    type: 'todo',
    id: row.id,
    title: row.title || '待办事项',
    snippet: pickSnippet(row, ['title', 'detail', 'remark', 'tag', 'sub_tag'], keyword),
    detail: [row.detail, row.remark].filter(Boolean).join('\n\n'),
    tag: row.tag || '',
    sub_tag: row.sub_tag || '',
    time: row.time || '',
    meta: row.done === 1 || row.done === '1' || row.done === true ? '已完成' : '未完成'
  }));
}

async function searchNotes(keyword) {
  // 笔记已改为「文件优先」：正文不在数据库里，改为在内存中扫描笔记缓存。
  // 个人笔记量级下这是可接受的，且避免为文件内容维护全文索引。
  const lowerKeyword = keyword.toLowerCase();
  let notes = [];

  try {
    const { getNotesCache, refreshNotesCache } = await import('./notesEditor.js');
    notes = getNotesCache();
    if (!notes.length) {
      notes = await refreshNotesCache();
    }
  } catch (error) {
    console.warn('读取笔记缓存失败，降级为空:', error);
    return [];
  }

  const matched = notes.filter(note => {
    const haystack = [
      note.title,
      note.content,
      note.note_type,
      note.tag,
      note.sub_tag
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(lowerKeyword);
  }).slice(0, SEARCH_LIMIT_PER_TYPE);

  return matched.map(note => ({
    type: 'note',
    id: note.rel_path,          // 改用文件相对路径作为标识
    relPath: note.rel_path,
    title: note.title || '笔记',
    snippet: pickSnippet(
      { title: note.title, content: note.content, note_type: note.note_type, tag: note.tag, sub_tag: note.sub_tag },
      ['title', 'content', 'note_type', 'tag', 'sub_tag'],
      keyword
    ),
    detail: note.content || '',
    tag: note.tag || '',
    sub_tag: note.sub_tag || '',
    time: note.updated_at || note.created_at || '',
    meta: note.note_type || 'note'
  }));
}

async function searchAll(keyword) {
  const [logs, todos, notes] = await Promise.all([
    searchLogs(keyword),
    searchTodos(keyword),
    searchNotes(keyword)
  ]);

  return { logs, todos, notes };
}

function renderSearchGroup(title, records) {
  if (!records.length) return '';

  return `
    <section class="search-result-group">
      <h2>${escapeHtml(title)} <span>${records.length}</span></h2>
      <div class="search-result-list">
        ${records.map(renderSearchItem).join('')}
      </div>
    </section>
  `;
}

function renderSearchItem(record) {
  const meta = [record.tag, record.sub_tag].filter(Boolean).join(' / ') || '未分类';
  const detail = record.detail || record.snippet || '暂无详情';
  // 笔记改为可点击跳转，其余类型保持原样
  const isNote = record.type === 'note' && record.relPath;
  const dataAttrs = isNote ? ` data-note-rel="${escapeHtml(record.relPath)}" role="button" tabindex="0"` : '';

  return `
    <article class="search-result-item${isNote ? ' is-clickable' : ''}"${dataAttrs}>
      <div class="search-result-head">
        <span class="search-type-badge">${formatTypeLabel(record.type)}</span>
        <strong>${escapeHtml(record.title)}</strong>
      </div>
      <div class="search-result-meta">
        <span>${escapeHtml(record.time || '无时间')}</span>
        <span>${escapeHtml(meta)}</span>
        <span>${escapeHtml(record.meta || '')}</span>
        ${isNote ? '<span class="search-note-hint">点击打开笔记</span>' : ''}
      </div>
      <p class="search-result-snippet">${escapeHtml(record.snippet || '暂无摘要')}</p>
      <details class="search-result-detail">
        <summary>展开查看详情</summary>
        <div>${textWithLineBreaks(detail)}</div>
      </details>
    </article>
  `;
}

function renderSearchResults(groups, keyword) {
  const container = document.getElementById('global-search-results');
  const status = document.getElementById('global-search-status');
  if (!container) return;

  const total = groups.logs.length + groups.todos.length + groups.notes.length;
  if (status) status.innerText = total > 0 ? `找到 ${total} 条相关内容` : '';

  if (total === 0) {
    container.innerHTML = '<div class="search-empty">没有找到相关内容</div>';
    return;
  }

  container.innerHTML = [
    renderSearchGroup('流水', groups.logs),
    renderSearchGroup('待办', groups.todos),
    renderSearchGroup('笔记', groups.notes)
  ].join('');
}

export function initSearchModule() {
  const form = document.getElementById('global-search-form');
  const input = document.getElementById('global-search-input');
  const container = document.getElementById('global-search-results');
  const status = document.getElementById('global-search-status');

  if (!form || !input || !container) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const keyword = normalizeKeyword(input.value);

    if (!keyword) {
      if (status) status.innerText = '';
      container.innerHTML = '<div class="search-empty">请输入关键词后搜索。</div>';
      input.focus();
      return;
    }

    if (status) status.innerText = '搜索中...';
    container.innerHTML = '';

    const groups = await searchAll(keyword);
    renderSearchResults(groups, keyword);
  });

  // 点击笔记结果 → 跳到笔记页打开
  container.addEventListener('click', async event => {
    if (event.target.closest('.search-result-detail')) return; // 展开详情不跳转
    const item = event.target.closest('[data-note-rel]');
    if (!item) return;

    const relPath = item.dataset.noteRel;
    if (!relPath) return;

    document.getElementById('nav-notes')?.click();
    try {
      const { openNote } = await import('./notesEditor.js');
      await openNote(relPath);
    } catch (error) {
      console.error('打开笔记失败:', error);
    }
  });

  container.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target.closest('[data-note-rel]');
    if (!item) return;
    event.preventDefault();
    item.click();
  });
}
