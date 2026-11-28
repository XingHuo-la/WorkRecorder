// 预置表（工作记录）的行序：v18 起由 sort 决定，与自建表同一套语义。
//
// 这一组用例锁住的是三个用户直接看得见的行为：
//   ① 新建记录落到**最后一行**（以前日期=今天，永远跳到第一行）
//   ② 「下方插入一行」紧贴点的那一行（以前日期为空、空串排最后，永远掉到最底）
//   ③ 导入的行接在末尾，且「指定创建时间列」的值真的写进 record.created_at
//
// 行序一旦回退成「按日期倒序」，这三条就会同时变红 —— 这正是我们要的报警。

import { DatabaseSync } from 'node:sqlite';
import {
  setSheetAdapter,
  readTableRows,
  insertTableRow,
  insertTableRowsAt,
  insertRowsBulk,
  CREATED_AT_KEY,
} from '../src/sheetStore.js';
import { coerceStamp, isMicroStamp } from '../src/stampValue.js';

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
`);

setSheetAdapter({
  async dbQuery(sql, params = []) {
    return db.prepare(sql).all(...params.map(value => String(value)));
  },
  async dbExecute(sql, params = []) {
    db.prepare(sql).run(...params.map(value => String(value)));
  },
});

const PRESET = { id: 1, kind: 'preset', name: '工作记录' };

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

const titles = async () => (await readTableRows(PRESET)).map(row => row.values.text);

// ---- 0. coerceStamp：认得出、认得准、认不出就交回去 ----
{
  eq('日期补零到 26 字符', coerceStamp('2026-1-2'), '2026-01-02 00:00:00.000000');
  eq('分钟精度', coerceStamp('2026-01-02 03:04'), '2026-01-02 03:04:00.000000');
  eq('秒精度', coerceStamp('2026-01-02 03:04:05'), '2026-01-02 03:04:05.000000');
  eq('毫秒补到 6 位', coerceStamp('2026-01-02 03:04:05.123'), '2026-01-02 03:04:05.123000');
  eq('已是规范值原样返回', coerceStamp('2026-01-02 03:04:05.123456'), '2026-01-02 03:04:05.123456');
  eq('斜杠也认', coerceStamp('2026/01/02 03:04:05'), '2026-01-02 03:04:05.000000');
  eq('T 分隔也认', coerceStamp('2026-01-02T03:04:05'), '2026-01-02 03:04:05.000000');
  eq('认不出的返回 null', coerceStamp('昨天下午'), null);
  eq('空值返回 null', coerceStamp(''), null);
  eq('月份越界返回 null', coerceStamp('2026-13-01'), null);
  eq('时分越界返回 null', coerceStamp('2026-01-01 25:00'), null);
  ok('产物一定是 26 字符', isMicroStamp(coerceStamp('2026-1-2 3:4')));
}

// ---- 1. 行序由 sort 决定，不再看日期 ----
{
  // 插入顺序与日期顺序故意错开：按日期倒序会得到「今天、昨天、前天」，
  // 按 sort 则就是插入顺序。
  const seed = [['第一条', '2026-11-01'], ['第二条', '2026-11-02'], ['第三条', '2026-11-03']];
  seed.forEach(([text, date], index) => {
    db.prepare(
      "INSERT INTO record (kind, title, happened_date, sort, created_at, updated_at) VALUES ('log', ?, ?, ?, ?, '')"
    ).run(text, date, index, `2026-11-01 00:00:0${index}.000000`);
  });
  eq('读出来就是 sort 顺序', (await titles()).join(','), '第一条,第二条,第三条');
}

// ---- 2. 新建记录落到最后一行（哪怕它的日期最新）----
{
  const at = new Date();
  const pad = value => String(value).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const id = await insertTableRow(PRESET, { text: '刚建的', date });
  ok('拿到了新 id', id != null);

  const rows = await readTableRows(PRESET);
  eq('新行在最后一行', rows[rows.length - 1].values.text, '刚建的');
  eq('总行数', rows.length, 4);
  // 日期是最新的，按旧口径它会跑到第一行 —— 这条断言就是那个 bug 的护栏
  ok('没有跳到第一行', rows[0].values.text === '第一条', rows.map(row => row.values.text).join(','));

  const sorts = rows.map(row => Number(row.sort));
  eq('sort 连续递增', sorts.join(','), '0,1,2,3');
}

// ---- 3. 下方插入：紧贴点的那一行 ----
{
  const rows = await readTableRows(PRESET);
  const anchor = rows[1]; // 第二条，sort=1
  await insertTableRowsAt(PRESET, Number(anchor.sort) + 1, 2, { text: '插在第二条下面' });

  const after = await titles();
  eq(
    '两行插在第二条之后',
    after.join(','),
    '第一条,第二条,插在第二条下面,插在第二条下面,第三条,刚建的'
  );
  const sorts = (await readTableRows(PRESET)).map(row => Number(row.sort));
  eq('插完 sort 仍然连续', sorts.join(','), '0,1,2,3,4,5');
}

// ---- 4. 上方插入：紧贴点的那一行之上 ----
{
  const rows = await readTableRows(PRESET);
  const anchor = rows[4]; // 第三条，sort=4
  await insertTableRowsAt(PRESET, Number(anchor.sort), 1, { text: '插在第三条上面' });

  const after = await titles();
  eq(
    '插在第三条之前',
    after.join(','),
    '第一条,第二条,插在第二条下面,插在第二条下面,插在第三条上面,第三条,刚建的'
  );
}

// ---- 5. 导入：接在末尾，且能指定创建时间 ----
{
  const { ids, stamps } = await insertRowsBulk(PRESET, [
    { text: '导入A', [CREATED_AT_KEY]: '2026-01-02' },
    { text: '导入B', [CREATED_AT_KEY]: '2026-01-02' },
    { text: '导入C' },
  ]);
  eq('三行都写进去了', ids.length, 3);
  eq('导入行接在末尾', (await titles()).slice(-3).join(','), '导入A,导入B,导入C');

  // 用户给的是「天」精度 → 补成 26 字符；两条同值 → 第二条 +1 微秒
  eq('指定的创建时间被规范化', stamps[0], '2026-01-02 00:00:00.000000');
  eq('重复值自动 +1 微秒', stamps[1], '2026-01-02 00:00:00.000001');
  ok('没指定的自动分配', isMicroStamp(stamps[2]) && stamps[2] > stamps[1]);

  const stored = db
    .prepare("SELECT created_at FROM record WHERE title LIKE '导入%' ORDER BY sort")
    .all()
    .map(row => row.created_at);
  eq('库里落的就是这三个值', stored.join('|'), stamps.join('|'));
}

// ---- 6. 与库里已有值相撞时必须让开（唯一索引不允许撞）----
{
  const clash = '2026-01-02 00:00:00.000000'; // 第 5 步刚写进去的值
  const { stamps } = await insertRowsBulk(PRESET, [{ text: '撞车', [CREATED_AT_KEY]: clash }]);
  ok('撞上已有值就往后挪', stamps[0] > clash, `${stamps[0]} vs ${clash}`);
  const dup = db.prepare('SELECT COUNT(*) AS n FROM record WHERE created_at = ?').get(clash).n;
  eq('库里那条原值没被覆盖', dup, 1);
}

// ---- 7. 认不出的时间值回落成自动分配，不能整批失败 ----
{
  const { stamps } = await insertRowsBulk(PRESET, [
    { text: '脏值', [CREATED_AT_KEY]: '昨天' },
    { text: '正常', [CREATED_AT_KEY]: '2026-02-03 04:05:06' },
  ]);
  ok('脏值回落到自动分配（26 字符）', isMicroStamp(stamps[0]), stamps[0]);
  eq('正常值照原样落地（不被自动分配挤走）', stamps[1], '2026-02-03 04:05:06.000000');
  eq('批内无重复', new Set(stamps).size, 2);

  const stored = db
    .prepare("SELECT created_at FROM record WHERE title IN ('脏值', '正常') ORDER BY title")
    .all()
    .map(row => row.created_at);
  eq('库里也没有重复', new Set(stored).size, 2);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
