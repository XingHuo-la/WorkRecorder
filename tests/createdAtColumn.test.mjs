// 「创建时间」列（绑定 record.created_at）的往返验证。
//
// 这一列的特殊之处：它是**第一个值不在 custom 里的字段**。
// 由此派生出三类失败形态，全都是静默的（界面不报错，但数据错）：
//   ① 读到空 —— 值没从结构列摊平进 values，格子里永远是空的；
//   ② 写成两份 —— values 整包塞进 custom，库里多一份副本，改一处另一处不动；
//   ③ 身份被抹掉 —— 字段面板保存时把 source 改回 'custom'，列还在但永远空。
// 加上唯一索引这一层，还有第 ④ 类：批量插入共用同一个时间戳 → UNIQUE 冲突。
//
// 用 node:sqlite 起真库，adapter 复刻 data.js 的 params.map(String)。

import { DatabaseSync } from 'node:sqlite';
import {
  setSheetAdapter,
  loadRows,
  insertRowsBulk,
  deleteRowsBulk,
  ensureCreatedAtField,
  saveRowValues,
  mergeFieldOptions,
  serializeOptions,
  createSheet,
  CREATED_AT_KEY,
} from '../src/sheetStore.js';
import { isMicroStamp } from '../src/stampValue.js';

const db = new DatabaseSync(':memory:');

db.exec(`
CREATE TABLE record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'log',
    title TEXT NOT NULL DEFAULT '',
    body TEXT DEFAULT '',
    status TEXT DEFAULT 'done',
    happened_date TEXT DEFAULT '',
    happened_time TEXT DEFAULT '',
    tag TEXT DEFAULT '',
    sub_tag TEXT DEFAULT '',
    parent_id INTEGER,
    sheet_id INTEGER,
    sort REAL DEFAULT 0,
    height INTEGER,
    custom TEXT DEFAULT '{}',
    created_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT '',
    deleted_at TEXT DEFAULT ''
);
CREATE UNIQUE INDEX idx_record_created_uid ON record(created_at) WHERE created_at <> '';
CREATE TABLE sheet_field (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    options TEXT,
    width INTEGER DEFAULT 160,
    sort INTEGER DEFAULT 0,
    visible INTEGER DEFAULT 1,
    UNIQUE(sheet_id, key)
);
CREATE TABLE field_def (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    options TEXT,
    width INTEGER DEFAULT 160,
    sort INTEGER DEFAULT 0,
    visible INTEGER DEFAULT 1,
    builtin INTEGER DEFAULT 0,
    UNIQUE(entity, key)
);
CREATE TABLE sheet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'table',
    task_id INTEGER,
    sort INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE view_def (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    form TEXT NOT NULL DEFAULT 'table',
    config TEXT NOT NULL DEFAULT '{}',
    sort INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
);
`);

setSheetAdapter({
  async dbQuery(sql, params = []) {
    return db.prepare(sql).all(...params.map(value => String(value)));
  },
  async dbExecute(sql, params = []) {
    db.prepare(sql).run(...params.map(value => String(value)));
  },
});

const TABLE = { id: 7, kind: 'table', name: '自建表' };
const PRESET = { id: 1, kind: 'preset', name: '主表' };

let pass = 0;
let fail = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    return;
  }
  fail += 1;
  console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
}

const eq = (name, actual, expected) =>
  ok(name, actual === expected, `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`);

// ---- 1. 批量插入：时间戳必须唯一且递增 ----
{
  const rows = Array.from({ length: 12 }, (_, i) => ({ text: `行 ${i}` }));
  const { ids, stamps } = await insertRowsBulk(TABLE, rows);

  eq('id 数量对', ids.length, 12);
  eq('时间戳数量对', stamps.length, 12);
  ok('全部是 26 字符规范形状', stamps.every(item => isMicroStamp(item)), stamps.join(' | '));
  ok(
    '严格递增且无重复',
    stamps.every((item, i) => i === 0 || item > stamps[i - 1]) && new Set(stamps).size === 12,
    stamps.join(' | ')
  );

  // 库里真的落了这些值，而且各行互不相同
  const stored = db.prepare('SELECT id, created_at, sort, custom FROM record ORDER BY id').all();
  eq('库里行数', stored.length, 12);
  eq('库里时间戳去重后数量', new Set(stored.map(r => r.created_at)).size, 12);
  ok('库里时间戳与返回值一致', stored.map(r => r.created_at).join('|') === stamps.join('|'));
  ok('sort 连续递增', stored.every((row, i) => Number(row.sort) === i), stored.map(r => r.sort).join(','));
  eq('custom 存的是 values', JSON.parse(stored[0].custom).text, '行 0');
  ok(
    'custom 里没有 created_at 副本',
    !('created_at' in JSON.parse(stored[0].custom)),
    stored[0].custom
  );
}

// ---- 2. 第二批插入必须接在上一批之后（不能撞唯一索引）----
{
  const before = db.prepare('SELECT MAX(created_at) AS m FROM record').get().m;
  const { stamps } = await insertRowsBulk(TABLE, [{ text: '第二批' }]);
  ok('第二批时间戳 > 上一批最大值', stamps[0] > before, `${stamps[0]} vs ${before}`);
}

// ---- 3. 读到空就是最危险的失败形态 ----
{
  const rows = await loadRows(TABLE.id);
  eq('读回行数', rows.length, 13);
  ok(
    'values 里带 created_at',
    rows.every(row => isMicroStamp(row.values[CREATED_AT_KEY])),
    JSON.stringify(rows[0]?.values)
  );
  ok('结构列与 values 一致', rows.every(row => row.values[CREATED_AT_KEY] === row.created_at));
}

// ---- 4. 写回：custom 不许有副本，结构列要真的改 ----
{
  const row = db.prepare('SELECT id, created_at FROM record ORDER BY id LIMIT 1').get();
  const target = '2030-01-02 03:04:05.000123';
  await saveRowValues(row.id, { text: '改过的', [CREATED_AT_KEY]: target });

  const after = db.prepare('SELECT custom, created_at FROM record WHERE id = ?').get(row.id);
  eq('结构列被写回', after.created_at, target);
  eq('custom 保留了普通值', JSON.parse(after.custom).text, '改过的');
  ok('custom 里没有 created_at 副本', !('created_at' in JSON.parse(after.custom)), after.custom);
}

// ---- 5. 清空创建时间不能把结构列改成空串 ----
{
  const row = db.prepare('SELECT id, created_at FROM record ORDER BY id LIMIT 1').get();
  await saveRowValues(row.id, { text: '清空试试', [CREATED_AT_KEY]: '' });
  const after = db.prepare('SELECT created_at FROM record WHERE id = ?').get(row.id);
  eq('空值不动结构列', after.created_at, row.created_at);
}

// ---- 6. 唯一索引真的在拦 ----
{
  let blocked = false;
  try {
    await insertRowsBulk(TABLE, [{ text: '撞车' }]);
    db.prepare(
      "INSERT INTO record (kind, sheet_id, custom, sort, created_at, updated_at) VALUES ('sheet_row', '7', '{}', '99', ?, '')"
    ).run('2030-01-02 03:04:05.000123');
  } catch (error) {
    blocked = /UNIQUE/i.test(String(error?.message || ''));
  }
  ok('唯一索引拦住了重复的 created_at', blocked);
}

// ---- 7. 幂等：已有这一列就不再建，而且**不认领**它 ----
//
// 「不认领」是这一层唯一需要小心的语义：ensureCreatedAtField 的返回值只有一个用途 ——
// 导入失败时把「自己刚建的东西」删掉。如果列本来就存在却被报上去，
// 一次失败的导入会顺手删掉用户原有的创建时间列（连带那一列上的所有设置）。
{
  const first = await ensureCreatedAtField(TABLE, []);
  ok('第一次建出来了', Boolean(first?.id), JSON.stringify(first));
  const second = await ensureCreatedAtField(TABLE, []);
  eq('第二次不认领（返回 null）', second, null);
  const count = db.prepare('SELECT COUNT(*) AS n FROM sheet_field WHERE sheet_id = 7').get().n;
  eq('表里只有一条创建时间字段', Number(count), 1);
  // 调用方传进来的 fields 里已经有它 → 一个字节都不该写库
  const third = await ensureCreatedAtField(TABLE, [{ id: 999, key: CREATED_AT_KEY, label: '已有' }]);
  eq('传入已有字段时也不认领', third, null);
  const count2 = db.prepare('SELECT COUNT(*) AS n FROM sheet_field WHERE sheet_id = 7').get().n;
  eq('没有重复插入', Number(count2), 1);
}

// ---- 8. 预置表走 field_def，key 固定、宽度够放下 26 字符 ----
{
  const field = await ensureCreatedAtField(PRESET, []);
  ok('预置表也建出来了', Boolean(field?.id), JSON.stringify(field));
  const row = db
    .prepare("SELECT key, type, options, width FROM field_def WHERE entity = 'log' AND key = ?")
    .get(CREATED_AT_KEY);
  eq('key 固定为 created_at', row?.key, CREATED_AT_KEY);
  eq('类型是日期', row?.type, 'date');
  eq('source 标记落库', JSON.parse(row?.options || '{}').source, CREATED_AT_KEY);
  // 160（field_def 的默认）放不下 26 字符，会折行
  eq("宽度够放下时间戳", Number(row?.width), 210);
  // 重复调用不报错（UNIQUE(entity,key)），也不再认领
  const again = await ensureCreatedAtField(PRESET, []);
  eq('二次调用不认领', again, null);
}

// ---- 9. 字段面板保存不许把 source 改回 custom ----
{
  const original = { options: serializeOptions({ source: CREATED_AT_KEY }) };
  const merged = JSON.parse(
    mergeFieldOptions(original, { source: 'custom', label: '创建时间', type: 'date' })
  );
  eq('source 被按住', merged.source, CREATED_AT_KEY);
  // 普通字段不受影响
  const plain = JSON.parse(
    mergeFieldOptions({ options: JSON.stringify({ source: 'custom', options: [] }) }, { source: 'custom' })
  );
  eq('普通字段仍是 custom', plain.source, 'custom');
}

// ---- 10. 批量软删除回滚 ----
{
  const before = db.prepare("SELECT COUNT(*) AS n FROM record WHERE deleted_at = ''").get().n;
  const { ids } = await insertRowsBulk(TABLE, [{ text: '待回滚 1' }, { text: '待回滚 2' }]);
  await deleteRowsBulk(ids);
  const after = db.prepare("SELECT COUNT(*) AS n FROM record WHERE deleted_at = ''").get().n;
  eq('删除后未删行数回到原值', Number(after), Number(before));
  const kinds = db
    .prepare("SELECT kind FROM record WHERE id IN (?, ?)")
    .all(...ids.map(String))
    .map(row => row.kind);
  ok('kind 打了 #deleted 后缀', kinds.every(kind => String(kind).endsWith('#deleted')), kinds.join(','));
}

// ---- 11. 空表 / 空数组不炸 ----
{
  const { ids } = await insertRowsBulk(TABLE, []);
  eq('空数组给空结果', ids.length, 0);
  const none = await insertRowsBulk(null, [{ text: 'x' }]);
  eq('没有表也给空结果', none.ids.length, 0);
}

// ---- 12. 新建表默认带「创建时间」列，并且排在最前面 ----
//
// 这是 Sir 最直接会看的一眼：「新建一张表，第一列是不是创建时间」。
{
  const sheetId = await createSheet({ name: '验收表' });
  ok('建表成功', Number(sheetId) > 0, String(sheetId));
  const fields = db
    .prepare('SELECT key, label, type, options, sort FROM sheet_field WHERE sheet_id = ? ORDER BY sort, id')
    .all(sheetId);
  ok('模板字段也建出来了', fields.length > 1, fields.length);
  const first = fields[0];
  eq('第一列是创建时间', first?.key, CREATED_AT_KEY);
  eq('标签是「创建时间」', first?.label, '创建时间');
  eq('类型是日期', first?.type, 'date');
  eq('source 标记落库', JSON.parse(first?.options || '{}').source, CREATED_AT_KEY);
  eq('排在最前（sort=0）', Number(first?.sort), 0);
  // 模板字段的 key 必须是生成出来的，不能是空串（空 key 会让两列抢同一个值）
  ok('模板字段都拿到了 key', fields.slice(1).every(item => item.key && item.key !== CREATED_AT_KEY), JSON.stringify(fields.map(f => f.key)));
}

console.log(`\ncreatedAtColumn: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
