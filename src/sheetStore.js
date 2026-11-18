// 「多表」数据层：一张表 = sheet，一套字段 = sheet_field，一堆记录 = record 里 sheet_id 指向本表的行。
//
// 设计要点（对齐「以表格为核心」的信息架构）：
//   · 所有内容都是 record。kind 只是「出生地」（log / todo / sheet_row），
//     「在不在表里」由 record.sheet_id 表达 —— 一条随手记被移入表格后 kind 不变、sheet_id 有值。
//   · 表的挂载点：sheet.task_id 指向「这张表挂在哪一行上」，null = 未挂载的独立表。
//     ⚠️ 它不是父子从属关系：那张表本来就是独立表，只是这一行把它挂过来了。
//     删掉挂载点 = 表回到未挂载状态，**表本身与表里的数据都不动**。
//   · 记录整条存 JSON（record.custom），加列 / 改类型不迁移结构；
//   · 所有写入都是单条 SQL，不批量重写，避免「改一格卡一下」。
//
// ⚠️ 本模块已全部直读 record。视图（logs / todos / sheet_row）已冻结，
//    新代码不要再 FROM 视图 —— 给视图加列要重建触发器，漏一列就静默抹值。
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

// 字段配置是「一个 JSON blob 装所有开关」。以前有三处各自重新拼一遍，
// 每拼一次就把没参与拼装的键（典型是列级 format）抹掉。
// 统一走这里：读出现有配置 → 只覆盖本次真正改动的键 → 写回。
// patch 里显式传 null/undefined 表示「删掉这个键」。
export function mergeFieldOptions(field, patch = {}) {
  const base = parseOptions(field);
  const next = { ...base };
  Object.entries(patch).forEach(([key, value]) => {
    if (value === undefined || value === null) delete next[key];
    else next[key] = value;
  });
  if (!next.source) next.source = 'custom';
  if (!Array.isArray(next.options)) next.options = [];
  if (!next.wrap) delete next.wrap;
  if (!next.dateOnly) delete next.dateOnly;
  if (next.format && typeof next.format === 'object' && !Object.keys(next.format).length) delete next.format;
  if (next.format && typeof next.format !== 'object') delete next.format;
  return JSON.stringify(next);
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
  // 列表只有一个真相：listTables。
  // 以前这里自己拼一套 COUNT，v15 之后预置表的行不在 sheet_id 上（是 kind='log'），
  // 两套 SQL 立刻会给出两个不同的行数 —— 列表写 12 条、点进去 0 条。
  // anchor_record_id 是 task_id 的**只读别名**，语义是「这张表挂在哪一行上」。
  // 刻意不叫 parent_record_id：那会被读成「父表」，而表和行不是父子从属。
  // 新代码一律读别名，旧代码继续读 task_id；将来真要改名只改这一处 + 一条迁移。
  return listTables();
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

  // 排序值取「现有最大值 + 1」。
  // 以前用 Date.now() % 100000 —— 每 100 秒循环一次，等于随机数，
  // 「全部表格」的顺序每次新建都可能乱。
  const maxRows = await db().dbQuery('SELECT COALESCE(MAX(sort), -1) AS max_sort FROM sheet');
  const nextSort = Number(maxRows?.[0]?.max_sort ?? -1) + 1;

  // ⚠️ 数据层的 dbExecute 会把参数统一 String()，
  // 直接传 null 会变成字符串 'null' 落库，所以「不归属任务」必须走不带该列的 INSERT。
  if (taskId == null) {
    await db().dbExecute(
      'INSERT INTO sheet (name, created_at, updated_at, sort) VALUES (?, ?, ?, ?)',
      [sheetName, stamp, stamp, nextSort]
    );
  } else {
    await db().dbExecute(
      'INSERT INTO sheet (name, task_id, created_at, updated_at, sort) VALUES (?, ?, ?, ?, ?)',
      [sheetName, Number(taskId), stamp, stamp, nextSort]
    );
  }
  // 不能用 MAX(id)：插入一旦失败，拿到的会是「上一张表」的 id，
  // 后面那批字段就会写进别人的表里。按刚写入的唯一 sort 精确定位。
  const created = await db().dbQuery(
    'SELECT id FROM sheet WHERE sort = ? AND name = ? ORDER BY id DESC LIMIT 1',
    [nextSort, sheetName]
  );
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

  // 每张新表自带一个「表格」视图。没有它，表在视图页签里就是空白的，
  // 用户会以为表建失败了 —— 视图是表的默认读法，不是可选装饰。
  await createView(sheetId, { name: '表格', form: 'table' });

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
  // 最后一张表不给删：快速记录总要有个落点。删空之后「新建记录」会写进虚无，
  // 而用户看到的只是「表没了」—— 数据并没有消失，只是再没有任何地方能读到它。
  const counted = await db().dbQuery('SELECT COUNT(*) AS n FROM sheet');
  if (Number(counted?.[0]?.n || 0) <= 1) {
    throw new Error('这是最后一张表：删掉之后，新建的记录没有地方可落');
  }
  const sheetRows = await db().dbQuery('SELECT kind FROM sheet WHERE id = ?', [sheetId]);
  const sheetKind = String(sheetRows?.[0]?.kind || 'table');

  await db().dbExecute('DELETE FROM sheet_field WHERE sheet_id = ?', [sheetId]);

  // kind 是「出生地」，删表的语义按它分两类，顺序不能反：
  // 1) 在表格里出生的行，只存在于这张表的语境 → 随表销毁（v13 起是软删除）；
  await db().dbExecute(
    "UPDATE record SET deleted_at = ?, kind = kind || '#deleted' WHERE sheet_id = ? AND kind = 'sheet_row'",
    [nowStamp(), sheetId],
  );
  // 2) 被「移入」的行（kind = log / todo）有独立的出生语境 → 退回记录页继续存在。
  //    必须在 DELETE 之后跑，否则会把第 1 类也一起放生，产生「表没了、行还在」的孤儿。
  //    ⚠️ NULL 只能写成 SQL 字面量：dbExecute 会 params.map(String)，传 null 落库是字符串 'null'，
  //    而 'null' 既不满足 IS NULL 也不等于任何 sheet_id，那批行会永远查不到、也删不掉。
  await db().dbExecute('UPDATE record SET sheet_id = NULL WHERE sheet_id = ?', [sheetId]);

  // 3) 预置表是例外：它的行不挂 sheet_id（kind='log'，出处算「记录页」），
  //    上面两条 sheet_id 规则一条都命中不了。不单独处理的话就会「表没了、记录还在
  //    历史/待整理里飘」，再也删不干净 —— 这比连数据一起删更糟。
  if (sheetKind === TABLE_KIND_PRESET) {
    await db().dbExecute(
      "UPDATE record SET deleted_at = ?, kind = 'log#deleted' WHERE kind = 'log' AND deleted_at = ''",
      [nowStamp()],
    );
  }

  // 视图随表一起消失。视图只存配置，删掉不丢一条数据；
  // 留着会变成孤儿（table_id 指向不存在的表），下张表复用 id 时会串味。
  await db().dbExecute('DELETE FROM view_def WHERE table_id = ?', [sheetId]);

  await db().dbExecute('DELETE FROM sheet WHERE id = ?', [sheetId]);

  // 默认表被删了就顺位给剩下第一张 —— settings 里指向一个不存在的 id，
  // 下次快速记录会静默找不到落点。
  const currentDefault = await getDefaultTableId();
  if (String(currentDefault) === String(sheetId)) {
    const next = await db().dbQuery('SELECT id FROM sheet ORDER BY sort, id LIMIT 1');
    if (next?.[0]) await setDefaultTableId(next[0].id);
    else await db().dbExecute("DELETE FROM settings WHERE key = 'default_table_id'");
  }
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
      // 允许直接传已经序列化好的 JSON：再 serializeOptions 一次会把它当成
      // 「一个没有 options 字段的对象」，选项会被清空。
      options ? (typeof options === 'string' ? options : serializeOptions(options)) : null,
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
// 记录（record 里 sheet_id 指向本表的行）
// ==========================================

export async function loadRows(sheetId) {
  // 直读 record，**不看 kind**：一条随手记被移入表格后 kind 仍是 'log'，
  // 走 sheet_row 视图会查不到它 —— 这是坑② 的主病灶。
  // custom AS data：parseRowData 读 row.data，别名一加，103 KB 的 sheetPage 一行都不用改。
  // CAST(sort AS INTEGER)：record.sort 是 REAL，不加会拿到 3.0，
  // 任何 row.sort === 3 的严格比较会变 false（视图当年也是这么做的）。
  // 顺手取回 kind/title/body/parent_id/status：行层级、正文、状态都要用，省一次抽屉查询。
  const rows = await db().dbQuery(
    `SELECT id, sheet_id, custom AS data, CAST(sort AS INTEGER) AS sort,
            height, created_at, updated_at,
            kind, title, body, parent_id, status
       FROM record
      WHERE sheet_id = ? AND deleted_at = ''
      ORDER BY sort, id`,
    [sheetId]
  );
  return (Array.isArray(rows) ? rows : []).map(item => ({ ...item, values: parseRowData(item) }));
}

export async function insertRow(sheetId, values = {}) {
  const stamp = nowStamp();
  // 排序值必须取 MAX(sort)+1，不能取 COUNT(*)：
  // 删过中间行之后 COUNT 比最大 sort 小，新记录会插到表格中间。
  const maxRows = await db().dbQuery(
    'SELECT COALESCE(MAX(sort), -1) AS max_sort FROM record WHERE sheet_id = ?',
    [sheetId]
  );
  const sort = Number(maxRows?.[0]?.max_sort ?? -1) + 1;
  // kind 写 'sheet_row'：在表格里新建的行，出生地就是表格，删表时随表销毁。
  await db().dbExecute(
    "INSERT INTO record (kind, sheet_id, custom, sort, created_at, updated_at) VALUES ('sheet_row', ?, ?, ?, ?, ?)",
    [sheetId, JSON.stringify(values), sort, stamp, stamp]
  );
  const created = await db().dbQuery(
    'SELECT id FROM record WHERE sheet_id = ? AND sort = ? ORDER BY id DESC LIMIT 1',
    [sheetId, sort]
  );
  return created?.[0]?.id || null;
}

// 在第 sortIndex 条之前插入 count 行：后面的行整体后移，保证顺序不乱。
export async function insertRowAt(sheetId, sortIndex, count = 1, values = {}) {
  const stamp = nowStamp();
  const safeCount = Math.max(1, Math.min(50, Number(count) || 1));
  const at = Math.max(0, Number(sortIndex) || 0);
  await db().dbExecute('UPDATE record SET sort = sort + ? WHERE sheet_id = ? AND sort >= ?', [
    safeCount,
    sheetId,
    at,
  ]);
  for (let i = 0; i < safeCount; i += 1) {
    await db().dbExecute(
      "INSERT INTO record (kind, sheet_id, custom, sort, created_at, updated_at) VALUES ('sheet_row', ?, ?, ?, ?, ?)",
      [sheetId, JSON.stringify(values), at + i, stamp, stamp]
    );
  }
}

export async function setRowHeight(rowId, height) {
  const stamp = nowStamp();
  // 参数会被统一 String()，null 传下去会写成字符串 'null'（INTEGER 列存成 TEXT）。
  // 「自动行高」必须走不带参数的 SQL NULL。
  if (height == null) {
    await db().dbExecute('UPDATE record SET height = NULL, updated_at = ? WHERE id = ?', [stamp, rowId]);
    return;
  }
  await db().dbExecute('UPDATE record SET height = ?, updated_at = ? WHERE id = ?', [
    Math.max(28, Math.min(600, Number(height))),
    stamp,
    rowId,
  ]);
}

export async function saveRowValues(rowId, values) {
  const stamp = nowStamp();
  await db().dbExecute('UPDATE record SET custom = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(values),
    stamp,
    rowId,
  ]);
}

export async function deleteRow(rowId) {
  // v13 软删除：kind 打 '#deleted' 后缀，sheet_row 视图的 `WHERE kind='sheet_row'` 自动过滤。
  // 直接 DELETE 会绕过视图的 INSTEAD OF 触发器，所以这里手写同一套标记。
  await db().dbExecute(
    "UPDATE record SET deleted_at = ?, kind = kind || '#deleted' WHERE id = ? AND kind NOT LIKE '%#deleted'",
    [nowStamp(), rowId],
  );
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

// ==========================================
// 表 / 视图分层（v15）
//
// 一句话：**表存数据，视图只存看法**。
//   sheet.kind='preset' 的那一行是预置表（原来的「基础表」），其余是自建表。
//   视图 = view_def 里的一行：绑哪张表 + 用什么形态 + 分组/标题/封面等配置。
//   视图里改值照样落到 record，但视图不能加字段、不能改类型 —— 那是表的职责。
//
// 预置表的字段仍读 field_def、行仍读 kind='log' 的 record。
// 刻意不复制进 sheet_field：一旦复制就有两份真相，改一处忘一处立刻漂移。
// ==========================================

export const TABLE_KIND_PRESET = 'preset';

// ready=false 的形态还在路上：菜单里不出现，避免点了没反应。
export const VIEW_FORMS = [
  { form: 'table', label: '表格', desc: '一行一条，横向看字段', ready: true },
  { form: 'board', label: '看板', desc: '按单选列分栏，拖卡片换状态', ready: true },
  { form: 'gallery', label: '画廊', desc: '大卡片带封面，适合图多的表', ready: true },
  { form: 'calendar', label: '日历', desc: '按日期铺到月历上', ready: false },
];

export function viewFormLabel(form) {
  return VIEW_FORMS.find(item => item.form === form)?.label || form || '视图';
}

// 视图配置的默认值集中在这里。任何读配置的地方都必须过一遍这个函数，
// 否则老视图（config='{}'）会让渲染层拿到 undefined 再炸在某个 .map 上。
export function parseViewConfig(view) {
  const raw = view?.config;
  let parsed = {};
  if (raw && typeof raw === 'object') parsed = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      parsed = JSON.parse(raw) || {};
    } catch (error) {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  const str = value => (typeof value === 'string' ? value : '');
  return {
    groupBy: str(parsed.groupBy),
    dateField: str(parsed.dateField),
    titleField: str(parsed.titleField),
    coverField: str(parsed.coverField),
    filter: Array.isArray(parsed.filter) ? parsed.filter : [],
    sorts: Array.isArray(parsed.sorts) ? parsed.sorts : [],
    fields: Array.isArray(parsed.fields) ? parsed.fields : [],
    // 拖拽锁：这张看板的卡片要不要「拖一下就改数据」。只对看板有意义，
    // 但存在视图配置里 —— 哪张看板要紧是逐个视图的判断，不是全局开关。
    lockDrag: parsed.lockDrag === true,
  };
}

export async function listTables() {
  // field_count / row_count 对两种表各算各的：
  // 预置表的字段在 field_def、行是 kind='log'；自建表反过来。
  // 行数按 sheet_id 数（不按 kind），这样「移入表格的记录」也算进来，
  // 与 loadRows 的口径一致 —— 卡片上写 12 条，点进去必须真有 12 条。
  const rows = await db().dbQuery(
    `SELECT s.id, s.name, s.kind, s.task_id, s.task_id AS anchor_record_id,
            s.created_at, s.updated_at, s.sort,
            CASE WHEN s.kind = 'preset'
                 THEN (SELECT COUNT(*) FROM field_def WHERE entity = 'log')
                 ELSE (SELECT COUNT(*) FROM sheet_field f WHERE f.sheet_id = s.id) END AS field_count,
            CASE WHEN s.kind = 'preset'
                 THEN (SELECT COUNT(*) FROM record r WHERE r.kind = 'log' AND r.deleted_at = '')
                 ELSE (SELECT COUNT(*) FROM record r WHERE r.sheet_id = s.id AND r.deleted_at = '') END AS row_count,
            (SELECT COUNT(*) FROM view_def v WHERE v.table_id = s.id) AS view_count
       FROM sheet s
      ORDER BY s.sort, s.id`
  );
  return (Array.isArray(rows) ? rows : []).map(item => ({
    ...item,
    kind: item.kind || 'table',
    fieldCount: Number(item.field_count) || 0,
    rowCount: Number(item.row_count) || 0,
    viewCount: Number(item.view_count) || 0,
    isPreset: (item.kind || 'table') === TABLE_KIND_PRESET,
  }));
}

export async function loadTable(tableId) {
  const list = await listTables();
  return list.find(item => String(item.id) === String(tableId)) || null;
}

export async function readTableFields(table) {
  if (!table) return [];
  if (table.kind === TABLE_KIND_PRESET) {
    const rows = await db().dbQuery(
      'SELECT id, key, label, type, options, width, sort, visible FROM field_def WHERE entity = ? ORDER BY sort, id',
      ['log']
    );
    return (Array.isArray(rows) ? rows : []).map(item => ({
      ...item,
      sheet_id: table.id,
      visible: Number(item.visible) === 0 ? 0 : 1,
      width: Number(item.width) || defaultWidthFor(item.type),
    }));
  }
  return loadFields(table.id);
}

// 预置表的行 → 统一 values 对象。
// 这一层是「两种物理形态、一种读法」的接缝：上面所有视图只认 values，
// 不再关心这个值原来躺在一个真列里还是 custom JSON 里。
// status 把 'inbox' 归一到 'unprocessed' —— 与 logs 视图、field_def 的选项三者对齐；
// 不归一的话，「待整理」那 12 条会在看板上掉进「未分组」。
function presetValues(row) {
  const custom = parseRowData({ data: row.custom });
  const subTag = String(row.sub_tag ?? '').trim();
  const date = String(row.happened_date ?? '');
  const time = String(row.happened_time ?? '');
  return {
    text: String(row.title ?? ''),
    tag: String(row.tag ?? ''),
    sub_tag: subTag ? subTag.split(/[、,，]/).filter(Boolean) : [],
    date: time && time !== '00:00' ? `${date} ${time}` : date,
    attachments: Array.isArray(custom.attachments) ? custom.attachments : [],
    status: row.status === 'inbox' ? 'unprocessed' : String(row.status ?? ''),
    detail: String(row.body ?? ''),
  };
}

export async function readTableRows(table) {
  if (!table) return [];
  if (table.kind === TABLE_KIND_PRESET) {
    // 只读 sheet_id 为空的行：被「移入」某张表的记录已经属于那张表，
    // 再在预置表里出现一次就是一条记录两个家。
    const rows = await db().dbQuery(
      `SELECT id, custom, CAST(sort AS INTEGER) AS sort, height,
              created_at, updated_at, kind, title, body, parent_id, status,
              tag, sub_tag, happened_date, happened_time
         FROM record
        WHERE kind = 'log' AND deleted_at = '' AND (sheet_id IS NULL OR sheet_id = 0)
        ORDER BY happened_date DESC, happened_time DESC, id DESC`
    );
    return (Array.isArray(rows) ? rows : []).map(item => ({
      ...item,
      sheet_id: table.id,
      values: presetValues(item),
    }));
  }
  return loadRows(table.id);
}

// values → record 的真列。只给预置表用。
// ⚠️ 视图里改一格必须落到真列，不能只写 custom：
// 预置表的界面读的是 title / body / status 这些列，只写 custom 等于改了个没人看的地方，
// 用户会看到「改了、刷新又变回去」。
function presetColumnsOf(values) {
  const raw = values || {};
  const dateText = String(raw.date ?? '').trim();
  const [datePart, timePart] = dateText.split(/\s+/);
  return {
    title: String(raw.text ?? ''),
    body: String(raw.detail ?? ''),
    tag: String(raw.tag ?? ''),
    sub_tag: Array.isArray(raw.sub_tag) ? raw.sub_tag.join('、') : String(raw.sub_tag ?? ''),
    happened_date: datePart || '',
    happened_time: timePart || '',
    // 反向归一：界面上叫 unprocessed（待整理），record 里历史值是 inbox。
    // 两处不一致是 v10 合并时留下的，logs 视图在出口做了同样一趟翻译。
    status: raw.status === 'unprocessed' ? 'inbox' : String(raw.status ?? ''),
  };
}

export async function saveTableRow(table, row, values) {
  if (!table || !row) return;
  if (table.kind !== TABLE_KIND_PRESET) {
    await saveRowValues(row.id, values);
    return;
  }
  const columns = presetColumnsOf(values);
  // custom 要合并写：里面除了 attachments 还躺着白板坐标 _bd 之类的键，
  // 整列覆写会把它们抹掉（白板上的便签会集体跳回原点）。
  const custom = parseRowData({ data: row.custom });
  custom.attachments = Array.isArray(values?.attachments) ? values.attachments : [];
  await db().dbExecute(
    `UPDATE record SET title = ?, body = ?, tag = ?, sub_tag = ?,
            happened_date = ?, happened_time = ?, status = ?, custom = ?, updated_at = ?
      WHERE id = ?`,
    [
      columns.title,
      columns.body,
      columns.tag,
      columns.sub_tag,
      columns.happened_date,
      columns.happened_time,
      columns.status,
      JSON.stringify(custom),
      nowStamp(),
      row.id,
    ]
  );
}

export async function insertTableRow(table, values = {}) {
  if (!table) return null;
  if (table.kind !== TABLE_KIND_PRESET) return insertRow(table.id, values);

  const stamp = nowStamp();
  const columns = presetColumnsOf(values);
  const custom = {};
  if (Array.isArray(values?.attachments) && values.attachments.length) custom.attachments = values.attachments;
  await db().dbExecute(
    `INSERT INTO record (kind, title, body, tag, sub_tag, happened_date, happened_time,
                         status, custom, sort, created_at, updated_at, deleted_at)
     VALUES ('log', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '')`,
    [
      columns.title,
      columns.body,
      columns.tag,
      columns.sub_tag,
      columns.happened_date,
      columns.happened_time,
      columns.status,
      JSON.stringify(custom),
      stamp,
      stamp,
    ]
  );
  const created = await db().dbQuery('SELECT id FROM record ORDER BY id DESC LIMIT 1');
  return created?.[0]?.id ?? null;
}

export async function listViews(tableId) {  const rows = await db().dbQuery(
    'SELECT id, table_id, name, form, config, sort FROM view_def WHERE table_id = ? ORDER BY sort, id',
    [tableId]
  );
  return (Array.isArray(rows) ? rows : []).map(item => ({
    ...item,
    config: parseViewConfig(item),
  }));
}

export async function createView(tableId, { name, form = 'table', config = {} } = {}) {
  const stamp = nowStamp();
  const maxRows = await db().dbQuery(
    'SELECT COALESCE(MAX(sort), -1) AS max_sort FROM view_def WHERE table_id = ?',
    [tableId]
  );
  const nextSort = Number(maxRows?.[0]?.max_sort ?? -1) + 1;
  await db().dbExecute(
    'INSERT INTO view_def (table_id, name, form, config, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [tableId, String(name || viewFormLabel(form)), form, JSON.stringify(config || {}), nextSort, stamp, stamp]
  );
  // dbExecute 只回影响行数，拿不到自增 id。单用户本地库，取最大 id 是安全的。
  const created = await db().dbQuery('SELECT id FROM view_def ORDER BY id DESC LIMIT 1');
  return created?.[0]?.id ?? null;
}

export async function patchView(viewId, patch = {}) {
  const entries = Object.entries(patch).filter(([key]) => ['name', 'form', 'config', 'sort'].includes(key));
  if (!entries.length) return;
  const sets = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([key, value]) => (key === 'config' ? JSON.stringify(value || {}) : value));
  await db().dbExecute(`UPDATE view_def SET ${sets}, updated_at = ? WHERE id = ?`, [...values, nowStamp(), viewId]);
}

export async function deleteView(viewId) {
  // 默认视图（每张表 sort 最小的那个「表格」）不给删：删掉表就失去了默认读法。
  // 判断放在调用方（UI 不渲染删除入口），这里只做一次兜底。
  const rows = await db().dbQuery('SELECT id FROM view_def WHERE table_id = (SELECT table_id FROM view_def WHERE id = ?) ORDER BY sort, id LIMIT 1', [viewId]);
  if (rows?.[0] && String(rows[0].id) === String(viewId)) return false;
  await db().dbExecute('DELETE FROM view_def WHERE id = ?', [viewId]);
  return true;
}

export async function getDefaultTableId() {
  const rows = await db().dbQuery("SELECT value FROM settings WHERE key = 'default_table_id'");
  const value = rows?.[0]?.value;
  return value == null || value === '' ? null : Number(value);
}

export async function setDefaultTableId(tableId) {
  if (tableId == null) return;
  await db().dbExecute("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_table_id', ?)", [String(tableId)]);
}

// ==========================================
// 快速记录的落点
// ==========================================

/**
 * 随手记该写进哪张表。
 *
 * 规则：先认 settings.default_table_id；它指向的表被删了、或者一列文本都没有
 * （内容无处可写），就退到第一张能用的表。**绝不能因为配置坏了就把内容丢掉** ——
 * 用户写下来的那一句话，比「配置正确」重要得多。
 */
export async function resolveCaptureTable() {
  const tables = await listTables();
  if (!tables.length) return null;

  const usable = async table => {
    const fields = await readTableFields(table);
    return fields.some(field => field.type === 'text');
  };

  const wanted = await getDefaultTableId();
  const picked = tables.find(item => String(item.id) === String(wanted));
  if (picked && (await usable(picked))) return picked;

  for (const table of tables) {
    if (await usable(table)) return table;
  }
  return null;
}

/**
 * 把一次快速记录写进「普通表」（预置表仍走原来的 logs 视图 SQL，字段语义齐全）。
 *
 * 只写文本列，其余列留空。不做字段猜测映射 —— 把正文塞进单选、把时间猜成日期，
 * 迟早写出一堆错数据，而且错得比「留空」更难发现。
 * 只有一列文本时不丢信息：整段写进那一列，而不是只写被截断的标题。
 */
export async function insertCaptureRow(table, { title = '', body = '' } = {}) {
  if (!table) return null;
  const fields = await readTableFields(table);
  const texts = fields.filter(field => field.type === 'text');
  if (!texts.length) return null;

  const titleField =
    texts.find(field => /标题|题目|名称|title|name|事项/i.test(`${field.key} ${field.label}`)) || texts[0];
  const bodyField =
    texts.find(field => field.key !== titleField.key && /正文|内容|描述|备注|body|detail|note|desc/i.test(`${field.key} ${field.label}`)) ||
    texts.find(field => field.key !== titleField.key) ||
    null;

  const full = String(body || title || '').trim();
  const values = {};
  if (bodyField) {
    values[titleField.key] = String(title || '').trim() || full;
    values[bodyField.key] = full;
  } else {
    values[titleField.key] = full;
  }
  return insertRow(table.id, values);
}

