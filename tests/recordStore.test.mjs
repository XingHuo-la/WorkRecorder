// recordStore.js 的临时集成验证（排查用，验证完即删）。
// 用 node:sqlite 起一个真库，adapter 刻意复刻 data.js 的 params.map(String) ——
// 这正是「null 被写成字符串 'null'」那个陷阱的发生地。
// 如果 recordStore 把 null 当参数传下去，这里的 typeof 断言会立刻炸。

import { DatabaseSync } from 'node:sqlite';
import {
  setRecordAdapter,
  getRecord,
  listChildren,
  listAncestors,
  listChildSheets,
  patchRecord,
  createRecord,
  setParent,
  deleteRecord,
  restoreRecord,
  moveRecordToSheet,
  removeRecordFromSheet,
  searchRecords,
} from '../src/recordStore.js';

const db = new DatabaseSync(':memory:');

db.exec(`
CREATE TABLE record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'log',
    title TEXT NOT NULL DEFAULT '',
    body TEXT DEFAULT '',
    remark TEXT DEFAULT '',
    status TEXT DEFAULT 'done',
    happened_date TEXT DEFAULT '',
    happened_time TEXT DEFAULT '',
    deadline TEXT DEFAULT '',
    tag TEXT DEFAULT '',
    sub_tag TEXT DEFAULT '',
    parent_id INTEGER,
    linked_todo TEXT DEFAULT '',
    is_overdue INTEGER DEFAULT 0,
    record_type TEXT DEFAULT '',
    sheet_id INTEGER,
    sort REAL DEFAULT 0,
    height INTEGER,
    start_at TEXT DEFAULT '',
    end_at TEXT DEFAULT '',
    completed_at TEXT DEFAULT '',
    custom TEXT DEFAULT '{}',
    legacy_id INTEGER,
    created_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT '',
    deleted_at TEXT DEFAULT ''
);
CREATE TABLE sheet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    task_id INTEGER,
    created_at TEXT,
    updated_at TEXT,
    sort INTEGER DEFAULT 0
);
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
`);

// ⚠️ 复刻真实 adapter 的参数处理：data.js 是 params.map(String)
const bind = params => params.map(v => String(v));
setRecordAdapter({
  async dbQuery(sql, params = []) {
    return db.prepare(sql).all(...bind(params));
  },
  async dbExecute(sql, params = []) {
    return db.prepare(sql).run(...bind(params)).changes;
  },
});

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `期望 ${e}，实际 ${a}`);
};

const insert = (cols, values) => {
  const marks = values.map(() => '?').join(', ');
  return db.prepare(`INSERT INTO record (${cols.join(', ')}) VALUES (${marks})`).run(...values).lastInsertRowid;
};

// ---------- 造数据 ----------
db.exec("INSERT INTO sheet (name, task_id, sort) VALUES ('设备台账', NULL, 0)");
db.exec("INSERT INTO sheet (name, task_id, sort) VALUES ('挂在A行上的表', 1, 1)");
db.exec(`INSERT INTO sheet_field (sheet_id, key, label, type, options)
         VALUES (1, 'f_rel', '关联', 'relation', '{"source":"custom","options":[],"targetSheetId":1}')`);

const A = insert(['kind', 'title', 'sheet_id', 'sort'], ['sheet_row', '前置泵', 1, 0]);
const D = insert(['kind', 'title', 'sheet_id', 'sort', 'parent_id'], ['sheet_row', '轴承', 1, 1, A]);
const E = insert(['kind', 'title', 'sheet_id', 'sort', 'custom'], ['sheet_row', '测点', 1, 2, JSON.stringify({ f_rel: [A, D] })]);
const LOG = insert(['kind', 'title', 'body'], ['log', '随手记', '正文']);

console.log('\n[1] 读');
eq('getRecord 把 custom 解析成对象', (await getRecord(E)).custom, { f_rel: [A, D] });
eq('listChildren 按 sort 返回', (await listChildren(A)).map(r => r.title), ['轴承']);
eq('listChildren(不存在) 返回空', await listChildren(9999), []);
eq('getRecord(不存在) 返回 null', await getRecord(9999), null);

console.log('\n[2] patchRecord：可空列必须写 SQL 字面量 NULL');
await patchRecord(D, { parent_id: null });
const typeofParent = db.prepare('SELECT typeof(parent_id) t FROM record WHERE id = ?').get(D).t;
eq('parent_id 的 typeof', typeofParent, 'null');

await patchRecord(LOG, { sheet_id: null, body: '改过的正文' });
const logRow = db.prepare('SELECT typeof(sheet_id) t, body FROM record WHERE id = ?').get(LOG);
eq('sheet_id 的 typeof', logRow.t, 'null');
eq('其他列未被动过', logRow.body, '改过的正文');

await patchRecord(LOG, { kind: 'todo' });
eq('kind 不在白名单，改不动', db.prepare('SELECT kind FROM record WHERE id = ?').get(LOG).kind, 'log');

console.log('\n[3] createRecord：RETURNING 拿 id + 可空列落 NULL');
const newId = await createRecord({ kind: 'log', title: '新的随手记', parentId: null, sheetId: null });
ok('拿到正数 id', Number(newId) > 0, String(newId));
const created = db.prepare('SELECT kind, title, typeof(parent_id) p, typeof(sheet_id) s, status, happened_date FROM record WHERE id = ?').get(newId);
eq('kind', created.kind, 'log');
eq('title', created.title, '新的随手记');
eq('parent_id typeof', created.p, 'null');
eq('sheet_id typeof', created.s, 'null');
eq('log 默认进待整理', created.status, 'inbox');
ok('happened_date 默认填了今天', /^\d{4}-\d{2}-\d{2}$/.test(created.happened_date), created.happened_date);

console.log('\n[4] setParent：环检测（用独立节点，避免被前面步骤改过）');
const P = insert(['kind', 'title', 'parent_id'], ['sheet_row', '父', null]);
const C1 = insert(['kind', 'title', 'parent_id'], ['sheet_row', '子', P]);
const C2 = insert(['kind', 'title', 'parent_id'], ['sheet_row', '孙', C1]);

eq('设自己为父被拒', await setParent(P, P), { ok: false, reason: 'self' });
eq('父挂到孙下成环，被拒', await setParent(P, C2), { ok: false, reason: 'cycle' });
eq('被拒后 parent_id 没变', db.prepare('SELECT parent_id FROM record WHERE id = ?').get(P).parent_id, null);
eq('子挂到父下合法（本来就是）', await setParent(C1, P), { ok: true });
eq('孙挂到爷下合法（提一级）', await setParent(C2, P), { ok: true });
eq('提级后 parent_id', db.prepare('SELECT parent_id FROM record WHERE id = ?').get(C2).parent_id, Number(P));

console.log('\n[5] listAncestors：无深度上限');
// 重新造一条干净的 6 层链：R → a → b → c → d → e
const R = insert(['kind', 'title', 'parent_id'], ['sheet_row', '根', null]);
let cursor = R;
const titles = [];
for (let i = 0; i < 5; i += 1) {
  const id = insert(['kind', 'title', 'parent_id'], ['sheet_row', `L${i}`, cursor]);
  titles.push(`L${i}`);
  cursor = id;
}
const chain = await listAncestors(cursor);
eq('6 层链取到 5 个祖先', chain.length, 5);
eq('顺序是自根到父', chain.map(a => a.title), ['根', ...titles.slice(0, 4)]);
eq('自身不在祖先链里', chain.some(a => a.id === cursor), false);

console.log('\n[6] deleteRecord：三步');
// 让 A 真的有子项、真的有祖父：删 A 时 D 应该提到祖父 R，而不是变成顶层
await patchRecord(D, { parent_id: A });
await patchRecord(A, { parent_id: R });
await patchRecord(E, { custom: { f_rel: [A, D, 999] } });
const kindBefore = db.prepare('SELECT kind FROM record WHERE id = ?').get(A)?.kind;
const result = await deleteRecord(A);
eq('子项被提到祖父 R', db.prepare('SELECT parent_id FROM record WHERE id = ?').get(D).parent_id, Number(R));
eq('reparented 计数', result.reparented, 1);
eq('挂载的表被释放', db.prepare('SELECT task_id FROM sheet WHERE id = 2').get().task_id, null);
eq('releasedSheets 计数', result.releasedSheets, 1);
eq('同表引用被摘掉，且不误伤其他 id', JSON.parse(db.prepare('SELECT custom FROM record WHERE id = ?').get(E).custom).f_rel, [D, 999]);
eq('clearedRefs 计数', result.clearedRefs, 1);
// v13 起删除是软删除：行留在库里，只打 kind 后缀 + deleted_at，否则 Ctrl+Z 无从恢复
const deletedA = db.prepare('SELECT kind, deleted_at FROM record WHERE id = ?').get(A);
ok('A 被软删除：kind 带 #deleted 后缀', String(deletedA?.kind || '').endsWith('#deleted'), deletedA?.kind);
ok('A 的 deleted_at 有值', Boolean(deletedA?.deleted_at));
ok('软删除不销毁行', db.prepare('SELECT COUNT(*) c FROM record').get().c >= 4);

// 撤销删除：后缀摘掉、时间清空，记录回到正常语义
const restored = await restoreRecord(A);
eq('恢复后 kind 回到原值', db.prepare('SELECT kind FROM record WHERE id = ?').get(A).kind, kindBefore);
eq('恢复后 deleted_at 清空', db.prepare('SELECT deleted_at FROM record WHERE id = ?').get(A).deleted_at, '');
eq('恢复返回记录本体', restored?.id, A);

console.log('\n[7] 移入 / 移出表格');
await moveRecordToSheet(LOG, 1);
const moved = db.prepare('SELECT kind, sheet_id FROM record WHERE id = ?').get(LOG);
eq('移入后 kind 不变', moved.kind, 'log');
eq('移入后 sheet_id 有值', moved.sheet_id, 1);
await removeRecordFromSheet(LOG);
const removed = db.prepare('SELECT typeof(sheet_id) t, kind FROM record WHERE id = ?').get(LOG);
eq('移出后 sheet_id 为 NULL', removed.t, 'null');
eq('移出后 kind 仍不变', removed.kind, 'log');

console.log('\n[8] listChildSheets');
db.exec("INSERT INTO sheet (name, task_id, sort) VALUES ('又挂回来', " + D + ", 2)");
const mounted = await listChildSheets(D);
eq('查到挂载在该行的表', mounted.map(s => s.name), ['又挂回来']);
eq('返回 anchor_record_id 别名', Number(mounted[0].anchor_record_id), Number(D));

console.log('\n[9] searchRecords：标题 LIKE、id 等值（不许 %12% 命中 123）');
{
  db.exec("INSERT INTO record (kind, title, updated_at) VALUES ('log', '泵 12 号', '2026-11-01 10:00:00')");
  db.exec("INSERT INTO record (kind, title, updated_at) VALUES ('log', '泵 123 号', '2026-11-02 10:00:00')");
  db.exec("INSERT INTO record (kind, title, updated_at) VALUES ('log', '50% 负荷试验', '2026-11-03 10:00:00')");

  const id12 = db.prepare("SELECT id FROM record WHERE title = '泵 12 号'").get().id;
  const id123 = db.prepare("SELECT id FROM record WHERE title = '泵 123 号'").get().id;

  // 搜 id：只允许精确命中，123 不许被带出来
  const byId = await searchRecords(String(id12));
  eq('搜 id 只命中一条', byId.map(r => r.id), [id12]);
  ok('123 没被 %12% 带出来', !byId.some(r => r.id === id123), byId.map(r => r.id).join(','));

  // 搜标题：模糊
  const byTitle = await searchRecords('泵 12');
  ok('标题模糊命中 12 与 123 两条', byTitle.length === 2, String(byTitle.length));
  eq('按 updated_at 倒序（123 更新更近）', byTitle.map(r => r.title), ['泵 123 号', '泵 12 号']);

  // % 必须被转义：否则「搜 50%」用通配符会返回全部记录
  const byPercent = await searchRecords('50%');
  eq('百分号当字面量，不当通配符', byPercent.map(r => r.title), ['50% 负荷试验']);

  // 排除已挂的
  const excluded = await searchRecords('泵 12', { excludeIds: [id12] });
  eq('excludeIds 生效', excluded.map(r => r.id), [id123]);

  // limit 夹紧
  const limited = await searchRecords('泵', { limit: 1 });
  eq('limit 生效', limited.length, 1);

  // 返回列只用 id/title/kind（不带 body/custom，避免拖大字段）
  eq('返回列固定为 id,title,kind', Object.keys(byId[0]).sort(), ['id', 'kind', 'title']);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
