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
// 关联字段的值解析只有一份（relationField），别在这里抄第二份：
// 「单选也存数组」这条如果两处不一致，读回来就会是 [3] 与 3 混着用。
import { relationConfig, normalizeRelationIds } from './relationField.js';
// created_at 有 UNIQUE INDEX 压着：同一个秒级时间戳插两行就是 INSERT 失败。
// 所以「新建行的创建时间」一律走微秒分配器；updated_at 仍是秒级（不要求唯一）。
import { bumpStamp, coerceStamp, currentStamp, stampBaseAfter, nextStamps } from './stampValue.js';

// 「创建时间」列住在 record.created_at 这个结构列里，不在 custom 的 JSON 里。
//
// 为什么用**固定 key** 而不是 newFieldKey() 生成的 f_xxx：
//   ① 读值不用再查一遍字段表 —— readTableRows 是热路径，每张表多一次 IPC 不值得；
//   ② 任何地方看到 values.created_at 都就是「这条记录的出生时间」，不需要上下文；
//   ③ sheet_field 的唯一约束是 UNIQUE(sheet_id, key)，跨表不冲突。
// 代价：所有「把 values 整包写进 custom」的地方都必须把它摘出去，
// 否则结构列会被抄成一份副本，改一处另一处不动。落点见 saveRowValues / presetCustomOf。
export const CREATED_AT_KEY = 'created_at';
export const CREATED_AT_LABEL = '创建时间';

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
  // 关联：标题 + 第二个胶囊要放得下，比多选宽一点
  relation: 200,
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
  // 「创建时间」列的身份是建表那一刻定的，字段面板不许把它改回普通列 ——
  // 面板每次保存都会显式传 source:'custom'，不在这里按住，
  // 用户改一下列名，这一列就变成一个永远空着的普通日期列（零报错）。
  if (base.source === CREATED_AT_KEY) next.source = CREATED_AT_KEY;
  if (!Array.isArray(next.options)) next.options = [];
  if (!next.wrap) delete next.wrap;
  if (!next.dateOnly) delete next.dateOnly;
  // precision 的默认档就是 minute，「不写这个键」与它等价 —— 不落库，
  // 免得每份配置里都躺一个永不变的精度。
  if (!next.precision || next.precision === 'minute') delete next.precision;
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
  const payload = {
    // 「创建时间」列是个例外：它的值不在 custom 里，而是 record.created_at 那一列。
    // 不加这一行，重启之后字段就变回普通日期列，格子里永远是空的。
    source: config.source === CREATED_AT_KEY ? CREATED_AT_KEY : 'custom',
    options: Array.isArray(config.options) ? config.options : [],
  };
  if (config.wrap) payload.wrap = true;
  if (config.dateOnly) payload.dateOnly = true;
  // 日期列的默认精度：day / minute / second。minute 不落库（省一个键）。
  // dateOnly 继续双写：老版本读到它仍然按「只到日」显示，不会突然冒时间。
  if (config.precision && config.precision !== 'minute') payload.precision = config.precision;
  // 关联字段的两个开关：指向哪张表、能不能选多个。
  // 不加这两行的话，serializeOptions 会把它们当「未知键」丢掉 ——
  // 表现是「选完目标表、保存后字段变成指向空表」，而且没有任何报错。
  if (Number(config.targetSheetId) > 0) payload.targetSheetId = Number(config.targetSheetId);
  if (config.multiple) payload.multiple = true;
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

/**
 * 每一条记录挂着哪些笔记。表格的附件列要把笔记当成附件项画出来，
 * 而单元格渲染必须是同步纯函数 —— 所以这里一次取全量，由页面建 record_id → 笔记 的映射。
 *
 * 真相仍是 note_record（v12 派生表）+ 笔记文件的 front-matter；
 * **不要把笔记路径再抄进 attachments 数组** —— 那样笔记改名/移动一次，
 * 附件列就会留下一条永远点不开的死链，而 note_record 是随文件同步的。
 *
 * @returns {Promise<Map<string, Array<{relPath: string, title: string}>>>}
 */
export async function listRecordNotes() {
  const rows = await db().dbQuery(
    `SELECT n.record_id AS record_id, n.rel_path AS rel_path,
            COALESCE(i.title, '') AS title, COALESCE(i.updated_at, '') AS updated_at
       FROM note_record n
       LEFT JOIN note_index i ON i.rel_path = n.rel_path
      ORDER BY n.record_id, i.updated_at DESC`
  );
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach(item => {
    const id = Number(item.record_id);
    const relPath = String(item.rel_path || '');
    if (!Number.isFinite(id) || id <= 0 || !relPath) return;
    const key = String(id);
    if (!map.has(key)) map.set(key, []);
    const title = String(item.title || '').trim() || relPath.split('/').pop().replace(/\.md$/i, '');
    map.get(key).push({ relPath, title });
  });
  return map;
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
  // 每张新表自带一列「创建时间」，排在最前面：新建一行，第一眼就该看到它什么时候进来的。
  // 它绑定的是 record.created_at（固定 key），不是 custom 里的一份拷贝 ——
  // 拷贝等于两处时间，改一处另一处不动。
  //
  // 宽度 210：值是 26 字符（2026-11-18 16:30:22.123456），13px 字号量下来约 170px，
  // 再加左右内边距 24px = 194。但列宽是**权重不是像素**（实际像素 = w × 可用宽 / 权重和），
  // 和模板里那 1110 权重挤在一起时 190 会缩到 167px 左右 —— 正好卡在截断线上。
  // 210 换算下来约 181px，留得住。列宽本来就是可以拖的。
  const seedFields = [
    {
      key: CREATED_AT_KEY,
      label: CREATED_AT_LABEL,
      type: 'date',
      options: { source: CREATED_AT_KEY },
      width: 210,
    },
    ...template.fields,
  ];
  for (const field of seedFields) {
    await db().dbExecute(
      'INSERT INTO sheet_field (sheet_id, key, label, type, options, width, sort, visible) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      [
        sheetId,
        // 模板里的字段没有 key（key 是建表那一刻才生成的），自带 key 的（创建时间）原样用
        field.key || newFieldKey(),
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
  return (Array.isArray(rows) ? rows : []).map(item => ({
    ...item,
    values: {
      ...parseRowData(item),
      // 把结构列摊进 values，渲染层才不用为「创建时间」单独开一条取值路径。
      // 放最后覆盖：custom 里就算残留了同名脏键，也不许盖掉真实创建时间。
      [CREATED_AT_KEY]: String(item.created_at ?? ''),
    },
  }));
}

export async function insertRow(sheetId, values = {}) {
  const stamp = nowStamp();
  const createdAt = currentStamp();
  // 复制行时 values 会带着源行的 created_at 一起过来。
  // 它是结构列：既不该进 custom（否则库里多一份副本），也不该被复用
  // （唯一索引不允许两行同一个创建时间，复制出来的必须是新时间）。
  const { [CREATED_AT_KEY]: _ignoredCreatedAt, ...customValues } = values || {};
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
    [sheetId, JSON.stringify(customValues), sort, createdAt, stamp]
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
    // 每行单独取一次创建时间：批量插入共用同一个值会直接撞唯一索引
    // （values 里若带着源行的 created_at 也要摘掉，理由同 insertRow）
    const { [CREATED_AT_KEY]: _ignoredCreatedAt, ...customValues } = values || {};
    await db().dbExecute(
      "INSERT INTO record (kind, sheet_id, custom, sort, created_at, updated_at) VALUES ('sheet_row', ?, ?, ?, ?, ?)",
      [sheetId, JSON.stringify(customValues), at + i, currentStamp(), stamp]
    );
  }
}

// ==========================================
// 批量插入（剪贴板导入专用）
// ==========================================
//
// 为什么必须有这一条路径：一次导入 2000 行，逐条走 insertRow 是
// 2000 × 3 次 IPC（查 MAX(sort) + INSERT + 回查 id），实测十几秒、界面假死，
// 而用户的要求是「性能第一」。
//
// 做法：把 N 行拼成一条多值 INSERT，一次 IPC 拿回全部 id。
// db_query 在 Rust 侧是 prepare + query_map，对 `INSERT ... RETURNING` 会真的
// step 并把结果集读出来，所以 id 一次拿全 —— 不需要新增 Rust 命令。
const BULK_CHUNK = 200;

/**
 * 批量插入表格行。
 *
 * 创建时间由这里统一分配：**第一条 = 现在，其后每条 +1 微秒**，
 * 并且起点会越过库里已有的最大值（上一次导入刚写完时，直接拿 now 会撞唯一索引）。
 *
 * @param {object} table
 * @param {Array<object>} rowsValues 每行的 values（与单行插入同构）
 * @returns {Promise<{ids: Array<number>, stamps: Array<string>}>}
 */
/**
 * 合成这一批要写入的创建时间：用户指定的优先，没指定或认不出的回落到自动分配。
 *
 * 三条硬约束都是唯一索引逼出来的：
 *   ① 形状必须规范 26 字符 —— 认不出的值直接丢弃（回落到自动分配），
 *      因为 19 字符的值和 26 字符的值比较时行为就是错的；
 *   ② 必须严格大于前一个 —— 批内两个相同的值会撞唯一索引，
 *      整批 2000 行一起回滚；
 *   ③ 不能撞库里已有的值 —— 粘贴来的历史数据很可能与库里重样。
 *
 * ②③ 只在「用户真的指定了创建时间列」时才需要（自动分配的值天然严格递增），
 * 所以按列判断，不让所有导入都背上这次查询。
 */
async function resolveStamps(list, autoStamps) {
  const provided = list.map(values => coerceStamp(values?.[CREATED_AT_KEY]));
  if (!provided.some(Boolean)) return autoStamps;

  const taken = new Set();
  const valid = provided.filter(Boolean).sort();
  if (valid.length) {
    // 上界要多留 list.length 个微秒：让位是一路往后挪的，挪出来的值可能
    // 落在「用户给的最后一个值」之外。不预留的话，第二次导入同一批时间
    // 会一路挪进上一批的地盘，撞唯一索引整批回滚。
    const upper = bumpStamp(valid[valid.length - 1], list.length + 1);
    const rows = await db().dbQuery(
      'SELECT created_at FROM record WHERE created_at >= ? AND created_at <= ?',
      [valid[0], upper]
    );
    (rows || []).forEach(row => taken.add(String(row.created_at)));
  }

  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    let value = provided[i] || autoStamps[i];
    // 只保证「唯一」，**不强制「递增」**：用户给的是历史时间，硬把它拉成递增
    // 等于篡改他的数据（2026-02 的会被推到 2026-11 的后面）。唯一索引认的是
    // 唯一性，不是单调性；相撞就往后挪 1μs，挪出来的值同样占位。
    let guard = 0;
    while (taken.has(value) && guard < 100000) {
      value = bumpStamp(value, 1);
      guard += 1;
    }
    taken.add(value);
    out.push(value);
  }
  return out;
}

export async function insertRowsBulk(table, rowsValues) {
  const list = Array.isArray(rowsValues) ? rowsValues : [];
  if (!table || !list.length) return { ids: [], stamps: [] };

  const updatedAt = nowStamp();
  const maxRows = await db().dbQuery('SELECT MAX(created_at) AS max_stamp FROM record');
  const autoStamps = nextStamps(stampBaseAfter(maxRows?.[0]?.max_stamp), list.length);
  if (!autoStamps.length) throw new Error('无法分配创建时间');
  const stamps = await resolveStamps(list, autoStamps);

  const ids = [];
  const isPreset = table.kind === TABLE_KIND_PRESET;

  // sort 一次性算好基线，chunk 内逐个 +1 —— 不能每行查一次 MAX。
  // 两种表同一条规矩：追加到末尾（预置表 v18 起也按 sort 排序）。
  let baseSort = 0;
  if (isPreset) {
    baseSort = await nextPresetSort();
  } else {
    const maxSort = await db().dbQuery(
      'SELECT COALESCE(MAX(sort), -1) AS max_sort FROM record WHERE sheet_id = ?',
      [table.id]
    );
    baseSort = Number(maxSort?.[0]?.max_sort ?? -1) + 1;
  }

  for (let start = 0; start < list.length; start += BULK_CHUNK) {
    const chunk = list.slice(start, start + BULK_CHUNK);
    const chunkStamps = stamps.slice(start, start + BULK_CHUNK);
    const params = [];

    let sql;
    if (isPreset) {
      // 预置表：值要落回真列，与 insertTableRow 保持同一套映射
      sql = `INSERT INTO record (kind, title, body, tag, sub_tag, happened_date, happened_time,
                                 status, custom, sort, created_at, updated_at, deleted_at)
             VALUES ${chunk.map(() => "('log', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')").join(', ')}`;
      chunk.forEach((values, offset) => {
        const columns = presetColumnsOf(values);
        const custom = presetCustomOf(values);
        if (Array.isArray(values?.attachments) && values.attachments.length) {
          custom.attachments = values.attachments;
        }
        params.push(
          columns.title,
          columns.body,
          columns.tag,
          columns.sub_tag,
          columns.happened_date,
          columns.happened_time,
          columns.status,
          JSON.stringify(custom),
          String(baseSort + start + offset),
          chunkStamps[offset],
          updatedAt
        );
      });
    } else {
      sql = `INSERT INTO record (kind, sheet_id, custom, sort, created_at, updated_at)
             VALUES ${chunk.map(() => "('sheet_row', ?, ?, ?, ?, ?)").join(', ')}`;
      chunk.forEach((values, offset) => {
        // 复制行带过来的 created_at 要摘掉：结构列不进 custom，也不许复用
        const { [CREATED_AT_KEY]: _ignoredCreatedAt, ...customValues } = values || {};
        params.push(
          String(table.id),
          JSON.stringify(customValues),
          String(baseSort + start + offset),
          chunkStamps[offset],
          updatedAt
        );
      });
    }

    await db().dbExecute(sql, params);

    // 拿 id 不走 `INSERT ... RETURNING`，而是按刚写入的那批创建时间**精确回查**。
    //
    // 为什么不用 RETURNING：它要求 db_query 对**写语句**也真的 step 出结果集。
    // 本仓库的 db_query 确实如此，但这属于一个隐式约定 —— 换个适配器
    // （调试壳、探针的假库）就不成立，表现是「导入 50 行，一行没写进去」。
    //
    // 为什么不用「区间」回查：用户指定「创建时间列」之后，这一批的值可能横跨几年
    // （粘进来的就是历史数据），区间里会混进别人的行 —— 3 行导回 10 个 id，
    // 触发下面的「批量写入只成功 N/M 行」把整批回滚掉。
    // 精确 IN 查询仍然只有一次 IPC；chunk 上限 200 远低于 SQLite 的变量上限。
    // 排序用 created_at：这批值严格递增，回查顺序就等于写入顺序。
    const marks = chunkStamps.map(() => '?').join(', ');
    const rows = await db().dbQuery(
      `SELECT id FROM record WHERE created_at IN (${marks}) ORDER BY created_at, id`,
      chunkStamps
    );
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const id = Number(row?.id);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    });
  }

  if (ids.length !== list.length) {
    throw new Error(`批量写入只成功 ${ids.length}/${list.length} 行`);
  }
  return { ids, stamps };
}

/**
 * 批量软删除。导入失败回滚用 —— 逐条 deleteRow 是 2000 次 IPC，
 * 而这一批刚插进去的行不可能有子项，不需要 deleteRow 里的 parent_id 交接。
 */
export async function deleteRowsBulk(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(id => Number.isInteger(id) && id > 0);
  if (!list.length) return;
  const stamp = nowStamp();
  for (let start = 0; start < list.length; start += BULK_CHUNK) {
    const chunk = list.slice(start, start + BULK_CHUNK);
    await db().dbExecute(
      `UPDATE record SET deleted_at = ?, kind = kind || '#deleted'
        WHERE id IN (${chunk.map(() => '?').join(',')}) AND kind NOT LIKE '%#deleted'`,
      [stamp, ...chunk]
    );
  }
}

/**
 * 确保这张表有「创建时间」列：有就沿用，没有就建。
 *
 * 导入 50 行时调用一次，不是每行调用。
 *
 * @returns {Promise<object|null>} **只有真的新建了才返回字段对象**；
 *   已经存在时返回 null。调用方拿返回值的唯一用途是「失败回滚时删掉自己建的东西」，
 *   把已存在的列报上去，会让一次导入失败顺手删掉用户原有的列。
 */
export async function ensureCreatedAtField(table, fields = []) {
  if (!table) return null;
  const fromCaller = (fields || []).find(item => String(item?.key) === CREATED_AT_KEY);
  if (fromCaller) return null;

  // 沿用建表时的同一份配置，两处不能各写一套
  const options = serializeOptions({ source: CREATED_AT_KEY });
  if (table.kind === TABLE_KIND_PRESET) {
    // 预置表字段是全局的（entity='log'），多张预置表共用一条定义
    const existing = await db().dbQuery(
      "SELECT id FROM field_def WHERE entity = 'log' AND key = ?",
      [CREATED_AT_KEY]
    );
    if (existing?.[0]) return null;
    // width 必须显式给：field_def.width 的默认是 160，
    // 而 26 字符的时间戳在 13px 字号下要约 170px，160 会折行或截断。
    await db().dbExecute(
      'INSERT OR IGNORE INTO field_def (entity, key, label, type, options, width, sort, visible, builtin) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0)',
      ['log', CREATED_AT_KEY, CREATED_AT_LABEL, 'date', options, 210]
    );
    const rows = await db().dbQuery(
      "SELECT id, key, label, type, options FROM field_def WHERE entity = 'log' AND key = ?",
      [CREATED_AT_KEY]
    );
    return rows?.[0] || null;
  }
  const existing = await db().dbQuery(
    'SELECT id FROM sheet_field WHERE sheet_id = ? AND key = ?',
    [table.id, CREATED_AT_KEY]
  );
  if (existing?.[0]) return null;
  await db().dbExecute(
    'INSERT OR IGNORE INTO sheet_field (sheet_id, key, label, type, options, width, sort, visible) VALUES (?, ?, ?, ?, ?, ?, 0, 1)',
    [table.id, CREATED_AT_KEY, CREATED_AT_LABEL, 'date', options, 210]
  );
  const rows = await db().dbQuery(
    'SELECT id, key, label, type, options FROM sheet_field WHERE sheet_id = ? AND key = ?',
    [table.id, CREATED_AT_KEY]
  );
  return rows?.[0] || null;
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
  // values 里带着摊平进来的 created_at（读的时候注进去的），它属于结构列。
  // 不能跟着整包塞进 custom —— 否则库里会多一份副本，改一处另一处不动。
  const { [CREATED_AT_KEY]: createdAt, ...custom } = values || {};
  const next = String(createdAt ?? '').trim();
  if (!next) {
    // 没带创建时间 / 被清空：结构列一个字都不动（创建时间不允许变空）
    await db().dbExecute('UPDATE record SET custom = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(custom),
      stamp,
      rowId,
    ]);
    return;
  }
  // 用户在格子里改了创建时间：连结构列一起写。
  // 值没变也照写 —— 多一次读当前值的 IPC 比多写一次贵得多。
  await db().dbExecute('UPDATE record SET custom = ?, created_at = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(custom),
    next,
    stamp,
    rowId,
  ]);
}

export async function deleteRow(rowId) {
  // v13 软删除：kind 打 '#deleted' 后缀，sheet_row 视图的 `WHERE kind='sheet_row'` 自动过滤。
  // 直接 DELETE 会绕过视图的 INSTEAD OF 触发器，所以这里手写同一套标记。
  //
  // 行层级（T06）：删父行必须把子项交还给祖父，否则它们会挂在一个已删除的 id 上 ——
  // 树里看着像根，点开抽屉面包屑却是「已删除记录」，而且再也提升不回来。
  // 先摘父再删，两条 UPDATE 的顺序不能反：反了就先查不到 parent_id 了。
  const rows = await db().dbQuery('SELECT parent_id FROM record WHERE id = ?', [rowId]);
  const parentId = Number(rows?.[0]?.parent_id);
  if (Number.isInteger(parentId) && parentId > 0) {
    await db().dbExecute('UPDATE record SET parent_id = ? WHERE parent_id = ?', [parentId, rowId]);
  } else {
    // NULL 只能是 SQL 字面量：dbExecute 会 params.map(String)，传 null 会写成字符串 'null'
    await db().dbExecute('UPDATE record SET parent_id = NULL WHERE parent_id = ?', [rowId]);
  }
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
  { form: 'calendar', label: '日历', desc: '按日期铺到月历上', ready: true },
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
    // 抽屉「内容」槽位绑哪一列。空 = 用记录自身的正文（record.body，走 markdown 渲染）；
    // 指到某一列时正文区改成该列的大号文本块（纯文本、保留换行）。
    bodyField: str(parsed.bodyField),
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
    const list = Array.isArray(rows) ? rows : [];
    // key 归一（剥掉老网格的 `custom.` 前缀）：values 里的键 = custom JSON 的键 = field.key，
    // 三条路对齐之后「改一格」才知道该往哪写。只在读的时候归一，不动库里的值：
    // 一旦 UPDATE key，旧网格回退（wrPresetGrid=legacy）就读不到自己当年建的那几列了。
    const used = new Set(list.map(item => String(item.key ?? '')));
    return list.map(item => {
      const rawKey = String(item.key ?? '');
      const key = customKeyOf(rawKey);
      return {
        ...item,
        // 剥完撞上另一条字段的 key 就保持原样：两条字段抢一个值比读不出来更难查
        key: key && !used.has(key) ? key : rawKey,
        sheet_id: table.id,
        visible: Number(item.visible) === 0 ? 0 : 1,
        width: Number(item.width) || defaultWidthFor(item.type),
      };
    });
  }
  return loadFields(table.id);
}

// 预置表的「真列」只有这 7 个（record 表上有对应字段）。
// 其余字段都是用户在预置表上新建的列，值存在 record.custom JSON 里，键名就是 field_def.key。
// 这两个方向的映射必须共用同一份名单，否则会出现「写了读不回来」的静默丢值。
export const PRESET_COLUMN_KEYS = ['text', 'tag', 'sub_tag', 'date', 'attachments', 'status', 'detail'];
const PRESET_COLUMN_KEY_SET = new Set(PRESET_COLUMN_KEYS);

/**
 * 字段 key → custom JSON 里的键。
 *
 * 老网格（tablePage.js 的「加一列」）当年生成的 key 是 `custom.f1a2b3`，
 * 写库时 `key.slice(7)` 存成 custom 里的 `f1a2b3`。新 key 是 `f_xxx`，没有前缀。
 * 读字段时统一剥掉前缀（见 readTableFields），两个时代的字段就落在同一个键上，
 * 老数据不用迁移、也不用一次性洗库。
 */
export function customKeyOf(fieldKey) {
  const key = String(fieldKey ?? '');
  return key.startsWith('custom.') ? key.slice(7) : key;
}

/** custom JSON → values 里的自定义列。跳过内部键（`_bd` 白板布局、`__fmt` 格式）与撞内置名的脏数据。 */
function customValuesOf(custom) {
  const out = {};
  for (const [key, value] of Object.entries(custom || {})) {
    if (!key || key.startsWith('_')) continue;
    if (PRESET_COLUMN_KEY_SET.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** values → 该写进 custom 的自定义列（presetValues 的逆运算，只取真正的字段键）。 */
function presetCustomOf(values) {
  const out = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (!key || key.startsWith('_')) continue;
    // 创建时间是 record.created_at 结构列，不是自定义列。
    // 抄进 custom 就等于库里有两份创建时间，改一处另一处不动。
    if (key === CREATED_AT_KEY) continue;
    if (value === undefined) continue;
    const dataKey = customKeyOf(key);
    if (!dataKey || PRESET_COLUMN_KEY_SET.has(dataKey)) continue;
    out[dataKey] = value;
  }
  return out;
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
    // 单元格级格式（底色/对齐/换行）在 values 里叫 __fmt，键名和别的自定义列一样是字段 key。
    // 以前预置表这一格根本没往 custom 里写，用户点完颜色刷新就白点 —— 同一个接缝，顺手补上。
    ...(custom.__fmt && typeof custom.__fmt === 'object' && !Array.isArray(custom.__fmt)
      ? { __fmt: custom.__fmt }
      : {}),
    // 自定义列（v15 之后的「关联」「补充说明」这类）住在 custom 里，一并摊平。
    // 上面 7 个真列先写，这里再覆盖不了它们（customValuesOf 已挡掉同名键）。
    ...customValuesOf(custom),
    // 结构列永远最后写：custom 里就算有同名脏键，也不许盖掉真实的创建时间。
    [CREATED_AT_KEY]: String(row.created_at ?? ''),
  };
}

// 「预置表里的一行」= 没被移入任何自建表的 log 记录。这个条件在读写两侧
// 必须逐字一致，否则「算出来的 MAX(sort)」和「看到的行」不是同一批。
const PRESET_ROW_WHERE = "kind = 'log' AND deleted_at = '' AND (sheet_id IS NULL OR sheet_id = 0)";

// 预置表下一行的 sort：MAX+1。与自建表 insertRow 同一条规矩 ——
// 不能用 COUNT(*)：删过中间行之后 COUNT 比最大 sort 小，新行会插到中间。
//
// 注意这里**不过滤 deleted_at**（与自建表那条一致）：软删除的行还占着它的
// sort，恢复时要回到原位。过滤掉会让新行复用一个「死人」的序号，恢复之后
// 两行同号，只能靠 id 分先后 —— 用户看到的是「恢复的行跑到了别处」。
async function nextPresetSort() {
  const rows = await db().dbQuery(
    `SELECT COALESCE(MAX(sort), -1) AS max_sort FROM record
      WHERE kind = 'log' AND (sheet_id IS NULL OR sheet_id = 0)`
  );
  return Number(rows?.[0]?.max_sort ?? -1) + 1;
}

export async function readTableRows(table) {
  if (!table) return [];
  if (table.kind === TABLE_KIND_PRESET) {
    // 只读 sheet_id 为空的行：被「移入」某张表的记录已经属于那张表，
    // 再在预置表里出现一次就是一条记录两个家。
    //
    // v18 起行序由 `sort` 决定，与自建表同一套语义 —— 以前是
    // `happened_date DESC, happened_time DESC, id DESC`，由此派生出两个
    // 用户看得见的毛病：新建记录（日期=今天）永远跳到第一行；
    // 「下方插入一行」插出来的行日期是空的，空串在倒序里排最后，
    // 于是永远掉到整张表最底下，跟点的是哪一行毫无关系。
    // 迁移把「升级那一刻看到的顺序」原样写成了 sort（0,1,2…），画面不变。
    const rows = await db().dbQuery(
      `SELECT id, custom, CAST(sort AS INTEGER) AS sort, height,
              created_at, updated_at, kind, title, body, parent_id, status,
              tag, sub_tag, happened_date, happened_time
         FROM record
        WHERE kind = 'log' AND deleted_at = '' AND (sheet_id IS NULL OR sheet_id = 0)
        ORDER BY sort, id`
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
  // 自定义列（预置表上新建的字段）没有真列可落，只能进 custom。
  // 不写这一步的后果是：字段面板里加得出「关联」列，界面上改得动，
  // 一刷新全部变空 —— 而且零报错，看起来像渲染 bug。
  Object.assign(custom, presetCustomOf(values));
  // 格式跟值一起存；全清掉时要真的删键，否则「取消格式」刷新后又回来了。
  // 只有调用方**提到过** __fmt 才动它：局部更新（只给了几个字段）不该顺手清格式。
  if (values && '__fmt' in values) {
    const fmt = values.__fmt;
    if (fmt && typeof fmt === 'object' && Object.keys(fmt).length) custom.__fmt = fmt;
    else delete custom.__fmt;
  }
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

export async function insertTableRow(table, values = {}, options = {}) {
  if (!table) return null;
  // 父子关系（行层级）：新行可以一出生就挂在某一行下面。
  // 不用 INSERT 完再 UPDATE 两步（预置表那条尤其危险：两次写库之间刷新会看到一条孤儿行）。
  const parentId = options.parentId == null ? null : Number(options.parentId);
  if (table.kind !== TABLE_KIND_PRESET) {
    const id = await insertRow(table.id, values);
    if (id != null && Number.isFinite(parentId)) await setRowParent(id, parentId);
    return id;
  }

  const stamp = nowStamp();
  // 创建时间必须唯一（UNIQUE INDEX 在 record.created_at 上），
  // updated_at 不需要 —— 两列从这一版起形状不同：26 字符 vs 19 字符。
  const createdAt = currentStamp();
  const columns = presetColumnsOf(values);
  // 新行没有旧 custom 可合并；自定义列（含关联）直接进 custom，与写回路径共用一份映射
  const custom = presetCustomOf(values);
  if (Array.isArray(values?.attachments) && values.attachments.length) custom.attachments = values.attachments;
  // 行序：默认追加到末尾；「上方/下方插入 N 行」会显式传位置
  // （调用方已经先把后面的行整体后移过，这里只管落位）。
  const sortValue = options.sort == null ? await nextPresetSort() : Number(options.sort);
  if (Number.isFinite(parentId)) {
    await db().dbExecute(
      `INSERT INTO record (kind, title, body, tag, sub_tag, happened_date, happened_time,
                           status, custom, parent_id, sort, created_at, updated_at, deleted_at)
       VALUES ('log', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
      [
        columns.title,
        columns.body,
        columns.tag,
        columns.sub_tag,
        columns.happened_date,
        columns.happened_time,
        columns.status,
        JSON.stringify(custom),
        parentId,
        sortValue,
        createdAt,
        stamp,
      ]
    );
  } else {
    await db().dbExecute(
      `INSERT INTO record (kind, title, body, tag, sub_tag, happened_date, happened_time,
                           status, custom, sort, created_at, updated_at, deleted_at)
       VALUES ('log', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
      [
        columns.title,
        columns.body,
        columns.tag,
        columns.sub_tag,
        columns.happened_date,
        columns.happened_time,
        columns.status,
        JSON.stringify(custom),
        sortValue,
        createdAt,
        stamp,
      ]
    );
  }
  // 预置表按时间排序，`ORDER BY id DESC LIMIT 1` 拿到的就是刚插的那条。
  // （自建表不能这么拿：sort 相同时 id 未必最大；那边用的是 insertRow 自己的返回值。）
  const created = await db().dbQuery('SELECT id FROM record ORDER BY id DESC LIMIT 1');
  return created?.[0]?.id ?? null;
}

// ==========================================
// 表无关的读写门面（P2.5）
//
// 起因：sheetPage 以前只认自建表 —— 它读 sheet_field / 按 sheet_id 读 record。
// 预置表的字段在 field_def、行是 kind='log' 且 sheet_id 为空，两套口径完全不同。
// 这里把差异收进四个函数：上面的视图层只认 (table, values)，不再关心值躺在哪。
//
// 两种物理形态、一种读法 —— 与 readTableFields / readTableRows 是同一条原则。
// ==========================================

// 连着插 N 条空行（sheetPage 的「上方/下方插入 N 行」）。
//
// v18 起两种表走同一套语义：**先给后面的行整体腾出 N 个位置，再逐条落位**。
// 以前预置表这一支直接丢弃 sortIndex、只插 N 条 —— 而那张表当时按日期排序，
// 插出来的行日期为空、空串在倒序里排最后，于是无论点哪一行，新行都出现在
// 整张表最底下。这条注释就是那个 bug 的墓碑。
export async function insertTableRowsAt(table, sortIndex, count = 1, values = {}) {
  if (!table) return;
  if (table.kind !== TABLE_KIND_PRESET) {
    await insertRowAt(table.id, sortIndex, count, values);
    return;
  }
  const safeCount = Math.max(1, Math.min(50, Number(count) || 1));
  const at = Math.max(0, Number(sortIndex) || 0);
  await db().dbExecute(
    `UPDATE record SET sort = sort + ? WHERE ${PRESET_ROW_WHERE} AND sort >= ?`,
    [safeCount, at]
  );
  for (let i = 0; i < safeCount; i += 1) {
    await insertTableRow(table, values, { sort: at + i });
  }
}

// 复制一行：两种表都是「拿一份 values 再插一条」，差别已经在 insertTableRow 里了。
export async function duplicateTableRow(table, values) {
  if (!table) return null;
  return insertTableRow(table, values);
}

export async function createTableField(table, { label, type = 'text', options = null, width = null, sort = null } = {}) {
  if (!table) return null;
  if (table.kind !== TABLE_KIND_PRESET) return createField(table.id, { label, type, options, width, sort });

  // ⚠️ 预置表的新字段必须写 field_def。往 sheet_field 里补一条「看起来一样」的复制，
  // readTableFields 读不到（它只认 field_def），界面表现为「加了字段但没出现」。
  const existing = await readTableFields(table);
  const nextSort = sort == null ? (existing.length ? Math.max(...existing.map(item => Number(item.sort) || 0)) + 1 : 0) : sort;
  await db().dbExecute(
    'INSERT INTO field_def (entity, key, label, type, options, sort, visible, builtin) VALUES (?, ?, ?, ?, ?, ?, 1, 0)',
    [
      'log',
      newFieldKey(),
      String(label || '新字段').trim(),
      type,
      // 与 createField 同一条坑：已经序列化好的 JSON 不能再过一遍 serializeOptions，
      // 否则它被当成「没有 options 的对象」，选项会被清空。
      options ? (typeof options === 'string' ? options : serializeOptions(options)) : null,
      nextSort,
    ]
  );
  return null;
}

export async function patchTableField(table, fieldId, patch) {
  if (!table || !fieldId) return;
  if (table.kind !== TABLE_KIND_PRESET) return patchField(fieldId, patch);

  const allowed = ['label', 'type', 'options', 'width', 'visible', 'sort'];
  const entries = Object.entries(patch || {}).filter(([key]) => allowed.includes(key) && patch[key] !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([key, value]) => (value == null ? `${key} = NULL` : `${key} = ?`)).join(', ');
  const values = entries.filter(([, value]) => value != null).map(([, value]) => value);
  await db().dbExecute(`UPDATE field_def SET ${sets} WHERE id = ?`, [...values, fieldId]);
}

/**
 * 把「这个字段在抽屉里怎么显示」写回 field.options.drawer。
 *
 * 存 options 而不是新开一张表：预置表落 field_def、自建表落 sheet_field，两边都有
 * 这一列，零迁移；而且它天然跟着**表**走 —— 同一个字段在表格、看板、日历里点开，
 * 抽屉长得一样，不会出现「卡片一套、抽屉另一套」。
 *
 * options 是整列覆盖写，必须先读出来合并：直接写 {drawer} 会把 wrap / dateOnly /
 * source 这些别的设置一起抹掉。
 *
 * @param {object} table 表（决定写 field_def 还是 sheet_field）
 * @param {object} field 字段（写完就地更新 field.options，宿主缓存不用重查）
 * @param {{hidden?:boolean, size?:string, order?:number|null}|null} drawer
 *        传 null / 空 = 清掉这套参数，回到默认（显示 / 中等 / 按字段顺序）
 * @returns {Promise<string|null>} 写进去的 options 字符串
 */
export async function saveFieldDrawer(table, field, drawer) {
  if (!table || !field || field.id == null) return null;
  const raw = typeof field.options === 'string' ? field.options : '';
  let config = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    } catch (error) {
      config = {};
    }
  }
  const next = { ...config };
  if (drawer && typeof drawer === 'object') next.drawer = drawer;
  else delete next.drawer;
  const options = JSON.stringify(next);
  await patchTableField(table, field.id, { options });
  field.options = options;
  return options;
}

export async function deleteTableField(table, fieldId) {
  if (!table || !fieldId) return;
  if (table.kind !== TABLE_KIND_PRESET) return deleteField(fieldId);
  // 与老的基础表一致：不拦 builtin。删掉 text 这类内置列会让快速记录找不到落点，
  // 但那是用户明确按下的删除 —— 拦住反而和以前不一样。
  await db().dbExecute('DELETE FROM field_def WHERE id = ?', [fieldId]);
}

export async function listViews(tableId) {
  const rows = await db().dbQuery(
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
// 通用的按表设置（settings 表）
//
// 为什么不用 localStorage：折叠状态、视图偏好这类东西要跟表走、要能进备份。
// localStorage 换台机器就没了，而且和主题等设置不同源。
// ==========================================

async function readSetting(key) {
  const rows = await db().dbQuery('SELECT value FROM settings WHERE key = ?', [String(key)]);
  const value = rows?.[0]?.value;
  return value == null ? '' : String(value);
}

async function writeSetting(key, value) {
  await db().dbExecute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [String(key), String(value)]);
}

/**
 * 某张表折叠了哪些行（id 数组）。
 * 返回 **null** 表示「没存过」——调用方据此走默认策略（只展开第 1 层），
 * 而不是把「用户展开了所有枝」和「从没动过」混成同一种空数组。
 */
export async function getSheetCollapsed(sheetId) {
  const raw = await readSetting(`sheet_collapsed:${sheetId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(Number).filter(id => Number.isInteger(id) && id > 0);
  } catch (error) {
    return null;
  }
}

/**
 * 一批挂载点的显示名。
 *
 * 库视图要写「挂载于：2 号机组」，而挂载点可能是一条 `sheet_row`（自建表的行），
 * 它的标题不在 record.title 里，而在 custom 的某个文本列里 —— 所以不能只查 todos。
 *
 * @param {Array<number|string>} ids
 * @returns {Promise<Map<string, string>>} id → 标题
 */
export async function listAnchorTitles(ids) {
  const list = Array.from(new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0)));
  if (!list.length) return new Map();
  const rows = await db().dbQuery(
    `SELECT id, title, custom FROM record WHERE id IN (${list.map(() => '?').join(',')})`,
    list
  );
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    map.set(String(row.id), displayTitleOf(row));
  });
  return map;
}

/** 一条记录的显示名：真列标题 → custom 里第一个像标题的字符串 → #id。 */
function displayTitleOf(row) {
  const title = String(row?.title ?? '').trim();
  if (title) return title;
  let data = {};
  try {
    data = typeof row?.custom === 'string' ? JSON.parse(row.custom || '{}') : row?.custom || {};
  } catch (error) {
    data = {};
  }
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) continue; // _bd（白板布局）这类内部键
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 60);
  }
  return `#${row?.id ?? ''}`;
}

export async function setSheetCollapsed(sheetId, ids) {
  const list = Array.from(new Set((ids || []).map(Number).filter(id => Number.isInteger(id) && id > 0)));
  await writeSetting(`sheet_collapsed:${sheetId}`, JSON.stringify(list));
}

// ==========================================
// 关联字段（T08）
//
// 值住在 record.custom[field.key]，形状永远是 id 数组（单选也存 [3]）。
// 这里只解决「库里的 id 怎么变成人能读的东西」：
//   · listRelationTargets —— 选择器里的候选（某张表的所有行）
//   · listRecordBriefs   —— 单元格里那几个胶囊的标题 / 是否已删
//   · findBacklinks      —— 抽屉里的「被引用于」
//
// 两个都很容易写成「N+1 查询」：一次查 id、再逐条查标题。这里刻意都是 IN 一条 SQL，
// 因为表格里一次要画几百个单元格，每条一个来回会把界面拖住。
// ==========================================

/** 预置表的 sheet.id（没有预置表时 null）。关联字段要按表算，预置表也得有 id。 */
export async function getPresetSheetId() {
  const rows = await db().dbQuery('SELECT id FROM sheet WHERE kind = ? ORDER BY id LIMIT 1', [TABLE_KIND_PRESET]);
  return rows?.[0]?.id ?? null;
}

/** 某张表里的行（关联选择器的候选）。已删除的不出现。 */
export async function listRelationTargets(tableId) {
  const table = await loadTable(tableId);
  if (!table) return [];
  const isPreset = table.kind === TABLE_KIND_PRESET;
  // 预置表的行是 kind='log' 且不挂 sheet_id；自建表是 sheet_row + sheet_id。
  // 两套口径不能混：混了会把「移入某张表的记录」同时算进预置表。
  const where = isPreset
    ? "kind = 'log' AND deleted_at = '' AND (sheet_id IS NULL OR sheet_id = 0)"
    : "kind = 'sheet_row' AND deleted_at = '' AND sheet_id = ?";
  const rows = await db().dbQuery(
    `SELECT id, title, custom FROM record WHERE ${where} ORDER BY sort, id`,
    isPreset ? [] : [table.id]
  );
  return (Array.isArray(rows) ? rows : []).map(row => ({ id: Number(row.id), title: displayTitleOf(row) }));
}

/**
 * 一批记录 id → 显示名 + 是否已删除。关系胶囊与抽屉里的引用都靠它。
 * 查不到的 id 也会有一条 `{title:'#id', deleted:true}` —— 渲染层不用再判空。
 */
export async function listRecordBriefs(ids) {
  const list = Array.from(new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0)));
  const map = new Map();
  if (!list.length) return map;
  const rows = await db().dbQuery(
    `SELECT id, title, custom, kind, deleted_at FROM record WHERE id IN (${list.map(() => '?').join(',')})`,
    list
  );
  for (const row of Array.isArray(rows) ? rows : []) {
    const deleted = String(row.deleted_at ?? '').trim() !== '' || String(row.kind ?? '').includes('#deleted');
    map.set(String(row.id), { title: displayTitleOf(row), deleted });
  }
  for (const id of list) {
    if (!map.has(String(id))) map.set(String(id), { title: `#${id}`, deleted: true });
  }
  return map;
}

/**
 * 全库的关联字段清单（含它属于哪张表、指向哪张表）。
 * 「被引用于」和「删行时清引用」都从这里取范围，避免各写一遍 SQL 各漏一张表。
 */
export async function listRelationFieldDefs() {
  const out = [];
  const presetId = await getPresetSheetId();
  if (presetId != null) {
    const presetName = (await db().dbQuery('SELECT name FROM sheet WHERE id = ?', [presetId]))?.[0]?.name || '';
    const rows = await db().dbQuery(
      "SELECT key, label, options FROM field_def WHERE entity = 'log' AND type = 'relation' ORDER BY sort, id"
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      out.push({
        tableId: Number(presetId),
        tableName: String(presetName || ''),
        isPreset: true,
        // custom 里的键是剥掉老前缀之后的形态（与 readTableFields 同一条规则）
        key: customKeyOf(row.key),
        label: String(row.label ?? ''),
        targetSheetId: relationConfig({ options: row.options }).targetSheetId,
      });
    }
  }
  const rows = await db().dbQuery(
    `SELECT f.key, f.label, f.options, s.id AS table_id, s.name AS table_name
       FROM sheet_field f JOIN sheet s ON s.id = f.sheet_id
      WHERE f.type = 'relation' ORDER BY s.sort, s.id, f.sort, f.id`
  );
  for (const row of Array.isArray(rows) ? rows : []) {
    out.push({
      tableId: Number(row.table_id),
      tableName: String(row.table_name ?? ''),
      isPreset: false,
      key: String(row.key ?? ''),
      label: String(row.label ?? ''),
      targetSheetId: relationConfig({ options: row.options }).targetSheetId,
    });
  }
  return out;
}

/** 一条记录属于哪张表（关联的「目标表」口径）。预置表的行不挂 sheet_id，要靠 kind 认。 */
async function tableIdOfRecord(record) {
  const sheetId = Number(record?.sheet_id);
  if (Number.isInteger(sheetId) && sheetId > 0) return sheetId;
  return String(record?.kind ?? '').startsWith('log') ? getPresetSheetId() : null;
}

/**
 * 「谁引用了我」：扫所有「目标表 = 我这条记录所在表」的关联字段，
 * 找出值里含我 id 的行。
 *
 * 只扫目标表匹配的字段 —— 一个关联列只会指向一张表，扫全库是浪费。
 * 跨表悬空引用**不清理**（见 recordStore.deleteRecord 的注释），
 * 所以这里可能扫到指向已删记录的 id，那属于预期，不影响结论。
 */
export async function findBacklinks(recordId) {
  const id = Number(recordId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const rows = await db().dbQuery('SELECT id, sheet_id, kind FROM record WHERE id = ?', [id]);
  const target = Array.isArray(rows) ? rows[0] : null;
  if (!target) return [];
  const targetTableId = await tableIdOfRecord(target);
  if (targetTableId == null) return [];

  const fields = (await listRelationFieldDefs()).filter(
    field => Number(field.targetSheetId) === Number(targetTableId)
  );
  if (!fields.length) return [];

  // 按表分组：一张表只扫一遍，而不是一个字段扫一遍
  const byTable = new Map();
  for (const field of fields) {
    const list = byTable.get(field.tableId) || [];
    list.push(field);
    byTable.set(field.tableId, list);
  }

  const out = [];
  for (const [tableId, list] of byTable) {
    const isPreset = list[0].isPreset === true;
    const where = isPreset
      ? "kind = 'log' AND deleted_at = '' AND (sheet_id IS NULL OR sheet_id = 0)"
      : "kind = 'sheet_row' AND deleted_at = '' AND sheet_id = ?";
    const tableRows = await db().dbQuery(
      `SELECT id, title, custom FROM record WHERE ${where}`,
      isPreset ? [] : [tableId]
    );
    for (const row of Array.isArray(tableRows) ? tableRows : []) {
      const custom = parseRowData({ data: row.custom });
      for (const field of list) {
        const ids = normalizeRelationIds(custom[field.key]);
        if (!ids.includes(id)) continue;
        out.push({
          tableId,
          tableName: field.tableName,
          rowId: Number(row.id),
          rowTitle: displayTitleOf(row),
          fieldKey: field.key,
          fieldLabel: field.label,
        });
      }
    }
  }
  return out;
}

/**
 * 改某一行的父记录。parentId=null 表示提升为根。
 *
 * ⚠️ NULL 只能写成 SQL 字面量：dbExecute 会 params.map(String)，
 * 传 null 落库会变成字符串 'null'，之后 `parent_id IS NULL` 与 `= 3` 都查不到，
 * 这一行会「凭空消失」且零报错。
 */
export async function setRowParent(rowId, parentId, options = {}) {
  if (rowId == null) return;
  const sort = Number.isFinite(Number(options.sort)) ? Number(options.sort) : null;
  if (parentId == null) {
    if (sort == null) {
      await db().dbExecute('UPDATE record SET parent_id = NULL, updated_at = ? WHERE id = ?', [nowStamp(), rowId]);
    } else {
      await db().dbExecute('UPDATE record SET parent_id = NULL, sort = ?, updated_at = ? WHERE id = ?', [sort, nowStamp(), rowId]);
    }
    return;
  }
  if (sort == null) {
    await db().dbExecute('UPDATE record SET parent_id = ?, updated_at = ? WHERE id = ?', [parentId, nowStamp(), rowId]);
  } else {
    await db().dbExecute('UPDATE record SET parent_id = ?, sort = ?, updated_at = ? WHERE id = ?', [parentId, sort, nowStamp(), rowId]);
  }
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

