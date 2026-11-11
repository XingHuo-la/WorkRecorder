// 「多表」数据层：一张表 = sheet，一套字段 = sheet_field，一堆记录 = sheet_row。
//
// 设计要点（对齐设计稿：任务 = 母文件夹，任务内可建多张表）：
//   · 表可以归属某个任务（sheet.task_id → todos.id），也可以不归属；
//   · 记录整条存 JSON（sheet_row.data），加列 / 改类型不迁移结构；
//   · 所有写入都是单条 SQL，不批量重写，避免「改一格卡一下」。
//
// 本模块只依赖注入的 adapter（dbQuery / dbExecute），
// 不直接碰 window.__TAURI__，这样调试壳可以换成本地假数据。

import { FIELD_TYPE_LABELS } from './fieldTypes.js';

let adapter = null;

export function setSheetAdapter(next) {
  adapter = next;
}

export function isSheetStoreReady() {
  return Boolean(adapter);
}

function db() {
  if (!adapter) throw new Error('表格数据通道未就绪');
  return adapter;
}

// ==========================================
// 基础工具
// ==========================================

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function nowStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function newFieldKey() {
  return `f_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

// 各类型的默认列宽（px）。表格用固定布局 + 横向滚动，
// 宽度是用户能直接感知的「这一列够不够用」，不按容器等比压缩。
export const FIELD_DEFAULT_WIDTH = {
  text: 220,
  number: 110,
  select: 124,
  multi_select: 180,
  date: 132,
  checkbox: 92,
  attachment: 112,
};

export function defaultWidthFor(type) {
  return FIELD_DEFAULT_WIDTH[type] || 160;
}

export function parseOptions(field) {
  if (!field || !field.options) return {};
  try {
    const parsed = typeof field.options === 'string' ? JSON.parse(field.options) : field.options;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

export function fieldOptionsList(field) {
  const config = parseOptions(field);
  return Array.isArray(config.options) ? config.options : [];
}

// 字段配置统一存成一个 JSON：选项数组 + 该类型的附加开关
// （text 的 wrap、date 的 dateOnly）。这样加配置不需要改表结构。
export function serializeOptions(configOrList) {
  if (Array.isArray(configOrList)) {
    return JSON.stringify({ source: 'custom', options: configOrList });
  }
  const config = configOrList || {};
  const payload = { source: 'custom', options: Array.isArray(config.options) ? config.options : [] };
  if (config.wrap) payload.wrap = true;
  if (config.dateOnly) payload.dateOnly = true;
  // 列级默认格式（底色/对齐/换行），单元格级覆盖存在行数据里
  if (config.format && typeof config.format === 'object' && Object.keys(config.format).length) {
    payload.format = config.format;
  }
  return JSON.stringify(payload);
}

export function parseRowData(row) {
  if (!row || !row.data) return {};
  try {
    const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function firstTextOf(data, fields) {
  const field = fields.find(item => item.type === 'text');
  if (!field) return '';
  return String(data[field.key] ?? '').trim();
}

// ==========================================
// 模板
// ==========================================

const STATUS_OPTIONS = [
  { value: 'todo', label: '待开始', color: '#f5a524' },
  { value: 'doing', label: '进行中', color: '#60a5fa' },
  { value: 'done', label: '已完成', color: '#2fbf71' },
  { value: 'blocked', label: '阻塞', color: '#e5484d' },
];

export const SHEET_TEMPLATES = [
  {
    key: 'task',
    name: '任务跟踪',
    desc: '7 字段 · 状态单选 / 日期 / 截图',
    fields: [
      { label: '任务', type: 'text', width: 280 },
      { label: '负责人', type: 'text', width: 110 },
      { label: '状态', type: 'select', width: 124, options: STATUS_OPTIONS },
      { label: '截止日期', type: 'date', width: 132 },
      { label: '进度', type: 'number', width: 92 },
      { label: '截图', type: 'attachment', width: 112 },
      { label: '备注', type: 'text', width: 260 },
    ],
  },
  {
    key: 'bug',
    name: '缺陷记录',
    desc: '6 字段 · 严重度 / 复现步骤',
    fields: [
      { label: '缺陷', type: 'text', width: 280 },
      {
        label: '严重度',
        type: 'select',
        width: 110,
        options: [
          { value: 'high', label: '严重', color: '#e5484d' },
          { value: 'mid', label: '一般', color: '#f5a524' },
          { value: 'low', label: '轻微', color: '#94a3b8' },
        ],
      },
      { label: '状态', type: 'select', width: 124, options: STATUS_OPTIONS },
      { label: '复现步骤', type: 'text', width: 280 },
      { label: '截图', type: 'attachment', width: 112 },
      { label: '发现日期', type: 'date', width: 132 },
    ],
  },
  {
    key: 'experiment',
    name: '实验记录',
    desc: '5 字段 · 批次 / 结果 / 日期',
    fields: [
      { label: '批次', type: 'text', width: 220 },
      { label: '参数', type: 'text', width: 220 },
      {
        label: '结果',
        type: 'select',
        width: 124,
        options: [
          { value: 'pass', label: '通过', color: '#2fbf71' },
          { value: 'review', label: '待复核', color: '#f5a524' },
          { value: 'fail', label: '失败', color: '#e5484d' },
        ],
      },
      { label: '日期', type: 'date', width: 132 },
      { label: '截图', type: 'attachment', width: 112 },
    ],
  },
  {
    key: 'blank',
    name: '空白表格',
    desc: '2 字段 · 从零自己搭',
    fields: [
      { label: '名称', type: 'text', width: 260 },
      { label: '备注', type: 'text', width: 300 },
    ],
  },
];

// ==========================================
// 表（sheet）
// ==========================================

export async function listSheets() {
  const rows = await db().dbQuery(
    `SELECT s.id, s.name, s.task_id, s.created_at, s.updated_at, s.sort,
            (SELECT COUNT(*) FROM sheet_field f WHERE f.sheet_id = s.id) AS field_count,
            (SELECT COUNT(*) FROM sheet_row r WHERE r.sheet_id = s.id) AS row_count,
            (SELECT r2.updated_at FROM sheet_row r2 WHERE r2.sheet_id = s.id ORDER BY r2.updated_at DESC LIMIT 1) AS last_at
     FROM sheet s
     ORDER BY s.sort, s.id`
  );
  return Array.isArray(rows) ? rows : [];
}

// 库视图卡片上要展示「这张表有哪些列」，所以一次把所有字段取回来按表分组。
// 字段总量是几十到几百条，一次查完比分表查 N 次快得多。
export async function listAllFields() {
  const rows = await db().dbQuery('SELECT sheet_id, label, type FROM sheet_field ORDER BY sheet_id, sort, id');
  const index = new Map();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const key = String(row.sheet_id);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ label: row.label, type: row.type });
  });
  return index;
}

export async function listTasks() {
  // ⚠️ todos.done 在历史数据里是字符串 'true' / 'false'（还有个别整数 1），
  // 所以不能用 `WHERE done = 0` 过滤，一条都查不出来。取回来在 JS 里判。
  const rows = await db().dbQuery('SELECT id, task, done, deadline FROM todos ORDER BY id DESC LIMIT 200');
  const isDone = value => value === true || value === 1 || value === '1' || value === 'true';
  return (Array.isArray(rows) ? rows : [])
    .map(item => ({
      id: item.id,
      label: String(item.task || '未命名任务').slice(0, 60),
      deadline: item.deadline || '',
      done: isDone(item.done),
    }))
    .sort((a, b) => Number(a.done) - Number(b.done));
}

export async function createSheet({ name, taskId = null, templateKey = 'blank' }) {
  const template = SHEET_TEMPLATES.find(item => item.key === templateKey) || SHEET_TEMPLATES[3];
  const stamp = nowStamp();
  const sheetName = String(name || '未命名表格').trim();

  // ⚠️ 数据层的 dbExecute 会把参数统一 String()，
  // 直接传 null 会变成字符串 'null' 落库，所以「不归属任务」必须走不带该列的 INSERT。
  if (taskId == null) {
    await db().dbExecute(
      'INSERT INTO sheet (name, created_at, updated_at, sort) VALUES (?, ?, ?, ?)',
      [sheetName, stamp, stamp, Date.now() % 100000]
    );
  } else {
    await db().dbExecute(
      'INSERT INTO sheet (name, task_id, created_at, updated_at, sort) VALUES (?, ?, ?, ?, ?)',
      [sheetName, Number(taskId), stamp, stamp, Date.now() % 100000]
    );
  }
  const created = await db().dbQuery('SELECT id FROM sheet ORDER BY id DESC LIMIT 1');
  const sheetId = created?.[0]?.id;
  if (!sheetId) throw new Error('创建表格失败');

  let sort = 0;
  for (const field of template.fields) {
    await db().dbExecute(
      'INSERT INTO sheet_field (sheet_id, key, label, type, options, width, sort, visible) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      [
        sheetId,
        newFieldKey(),
        field.label,
        field.type,
        field.options ? serializeOptions(field.options) : null,
        field.width || defaultWidthFor(field.type),
        sort,
      ]
    );
    sort += 1;
  }

  return sheetId;
}

export async function updateSheet(sheetId, patch) {
  const entries = Object.entries(patch).filter(([key]) => ['name', 'task_id', 'sort'].includes(key));
  if (!entries.length) return;
  // 同上：null 必须写成 SQL NULL，否则会被 String() 成 'null'
  const sets = entries.map(([key, value]) => (value == null ? `${key} = NULL` : `${key} = ?`)).join(', ');
  const values = entries.filter(([, value]) => value != null).map(([, value]) => value);
  await db().dbExecute(`UPDATE sheet SET ${sets}, updated_at = ? WHERE id = ?`, [...values, nowStamp(), sheetId]);
}

export async function touchSheet(sheetId) {
  await db().dbExecute('UPDATE sheet SET updated_at = ? WHERE id = ?', [nowStamp(), sheetId]);
}

export async function deleteSheet(sheetId) {
  await db().dbExecute('DELETE FROM sheet_field WHERE sheet_id = ?', [sheetId]);
  await db().dbExecute('DELETE FROM sheet_row WHERE sheet_id = ?', [sheetId]);
  await db().dbExecute('DELETE FROM sheet WHERE id = ?', [sheetId]);
}

// ==========================================
// 字段（sheet_field）
// ==========================================

export async function loadFields(sheetId) {
  const rows = await db().dbQuery(
    'SELECT id, sheet_id, key, label, type, options, width, sort, visible FROM sheet_field WHERE sheet_id = ? ORDER BY sort, id',
    [sheetId]
  );
  return (Array.isArray(rows) ? rows : []).map(item => ({
    ...item,
    visible: Number(item.visible) === 0 ? 0 : 1,
    width: Number(item.width) || defaultWidthFor(item.type),
  }));
}

export async function createField(sheetId, { label, type = 'text', options = null, width = null, sort = null }) {
  const existing = await loadFields(sheetId);
  const nextSort = sort == null ? (existing.length ? Math.max(...existing.map(item => Number(item.sort) || 0)) + 1 : 0) : sort;
  const key = newFieldKey();

  if (sort != null) {
    // 在指定位置插入：先把后面的字段整体后移一格
    for (const field of existing) {
      const current = Number(field.sort) || 0;
      if (current >= sort) {
        await db().dbExecute('UPDATE sheet_field SET sort = ? WHERE id = ?', [current + 1, field.id]);
      }
    }
  }

  await db().dbExecute(
    'INSERT INTO sheet_field (sheet_id, key, label, type, options, width, sort, visible) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    [
      sheetId,
      key,
      String(label || '新字段').trim(),
      type,
      options ? serializeOptions(options) : null,
      width || defaultWidthFor(type),
      nextSort,
    ]
  );

  const rows = await loadFields(sheetId);
  return rows.find(item => item.key === key) || null;
}

export async function patchField(fieldId, patch) {
  const allowed = ['label', 'type', 'options', 'width', 'visible', 'sort'];
  const entries = Object.entries(patch).filter(([key]) => allowed.includes(key) && patch[key] !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([key, value]) => (value == null ? `${key} = NULL` : `${key} = ?`)).join(', ');
  const values = entries.filter(([, value]) => value != null).map(([, value]) => value);
  await db().dbExecute(`UPDATE sheet_field SET ${sets} WHERE id = ?`, [...values, fieldId]);
}

export async function deleteField(fieldId) {
  await db().dbExecute('DELETE FROM sheet_field WHERE id = ?', [fieldId]);
}

// ==========================================
// 记录（sheet_row）
// ==========================================

export async function loadRows(sheetId) {
  const rows = await db().dbQuery(
    'SELECT id, sheet_id, data, sort, height, created_at, updated_at FROM sheet_row WHERE sheet_id = ? ORDER BY sort, id',
    [sheetId]
  );
  return (Array.isArray(rows) ? rows : []).map(item => ({ ...item, values: parseRowData(item) }));
}

export async function insertRow(sheetId, values = {}) {
  const stamp = nowStamp();
  const rows = await db().dbQuery('SELECT COUNT(*) AS total FROM sheet_row WHERE sheet_id = ?', [sheetId]);
  const sort = Number(rows?.[0]?.total || 0);
  await db().dbExecute(
    'INSERT INTO sheet_row (sheet_id, data, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [sheetId, JSON.stringify(values), sort, stamp, stamp]
  );
  const created = await db().dbQuery('SELECT id FROM sheet_row WHERE sheet_id = ? ORDER BY id DESC LIMIT 1', [sheetId]);
  return created?.[0]?.id || null;
}

// 在第 sortIndex 条之前插入 count 行：后面的行整体后移，保证顺序不乱。
export async function insertRowAt(sheetId, sortIndex, count = 1, values = {}) {
  const stamp = nowStamp();
  const safeCount = Math.max(1, Math.min(50, Number(count) || 1));
  const at = Math.max(0, Number(sortIndex) || 0);
  await db().dbExecute('UPDATE sheet_row SET sort = sort + ? WHERE sheet_id = ? AND sort >= ?', [
    safeCount,
    sheetId,
    at,
  ]);
  for (let i = 0; i < safeCount; i += 1) {
    await db().dbExecute(
      'INSERT INTO sheet_row (sheet_id, data, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [sheetId, JSON.stringify(values), at + i, stamp, stamp]
    );
  }
}

export async function setRowHeight(rowId, height) {
  await db().dbExecute('UPDATE sheet_row SET height = ?, updated_at = ? WHERE id = ?', [
    height == null ? null : Math.max(28, Math.min(600, Number(height))),
    nowStamp(),
    rowId,
  ]);
}

export async function saveRowValues(rowId, values) {
  const stamp = nowStamp();
  await db().dbExecute('UPDATE sheet_row SET data = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(values),
    stamp,
    rowId,
  ]);
}

export async function deleteRow(rowId) {
  await db().dbExecute('DELETE FROM sheet_row WHERE id = ?', [rowId]);
}

export async function duplicateRow(sheetId, values) {
  return insertRow(sheetId, values);
}

// ==========================================
// 展示用派生数据
// ==========================================

export function rowTitle(values, fields) {
  const title = firstTextOf(values, fields);
  if (title) return title;
  for (const field of fields) {
    const value = values[field.key];
    if (value == null || value === '') continue;
    if (Array.isArray(value)) return value.join('、');
    return String(value);
  }
  return '未命名记录';
}

export function describeField(field) {
  const label = FIELD_TYPE_LABELS[field?.type] || field?.type || '文本';
  const count = fieldOptionsList(field).length;
  if ((field?.type === 'select' || field?.type === 'multi_select') && count) {
    return `${label} · ${count} 个选项`;
  }
  return label;
}
