// 预置表「自定义列持久化」的往返验证（T08 前置）。
//
// 要盯住的失败形态是**静默丢值**：字段建得出来、界面上改得动、刷新就没了，且不报错。
// 所以这里的断言全部是「写进去 → 重新从库里读回来」的往返，而不是只看写入函数返回了什么。
//
// 用 node:sqlite 起真库，adapter 复刻 data.js 的 params.map(String) —— 参数被 String()
// 正是「null 写成 'null'」这类坑的发生地，测试里必须保留这个特性才有意义。

import { DatabaseSync } from 'node:sqlite';
import {
  setSheetAdapter,
  readTableFields,
  readTableRows,
  saveTableRow,
  insertTableRow,
  customKeyOf,
  PRESET_COLUMN_KEYS,
} from '../src/sheetStore.js';

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
CREATE TABLE field_def (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL,
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
    kind TEXT DEFAULT 'table',
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

setSheetAdapter({
  async dbQuery(sql, params = []) {
    return db.prepare(sql).all(...params.map(value => String(value)));
  },
  async dbExecute(sql, params = []) {
    db.prepare(sql).run(...params.map(value => String(value)));
  },
});

const PRESET = { id: 1, kind: 'preset', name: '主表' };

// 内置 7 列（与 main.rs v7 种子一致，只是省掉 label 文案差异）
const BUILTIN = [
  ['text', 'text'], ['tag', 'select'], ['sub_tag', 'multi_select'], ['date', 'date'],
  ['attachments', 'attachment'], ['status', 'select'], ['detail', 'text'],
];
BUILTIN.forEach(([key, type], index) => {
  db.prepare(
    'INSERT INTO field_def (entity, key, label, type, sort, visible, builtin) VALUES (?, ?, ?, ?, ?, 1, 1)'
  ).run('log', key, key, type, index);
});

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed += 1; return; }
  failures.push(`${name}${detail ? ` → ${detail}` : ''}`);
}
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `期望 ${b}，实际 ${a}`);
};

const rawRow = id => db.prepare('SELECT * FROM record WHERE id = ?').get(String(id));
const customOf = id => JSON.parse(rawRow(id).custom || '{}');

async function main() {
  // ---------------------------------------------------------------
  // 1) 内置 7 列是名单常量，两个方向的映射都认它
  // ---------------------------------------------------------------
  eq('内置列名单', PRESET_COLUMN_KEYS, ['text', 'tag', 'sub_tag', 'date', 'attachments', 'status', 'detail']);
  eq('key 归一：老网格的 custom. 前缀', customKeyOf('custom.f1a2b3'), 'f1a2b3');
  eq('key 归一：新 key 原样', customKeyOf('f_xyz'), 'f_xyz');

  // ---------------------------------------------------------------
  // 2) 新字段（模拟「关联」列）：建字段 → 写值 → 重新读行
  // ---------------------------------------------------------------
  const fieldKey = 'f_rel001';
  db.prepare(
    "INSERT INTO field_def (entity, key, label, type, options, sort, visible, builtin) VALUES ('log', ?, ?, 'relation', ?, 7, 1, 0)"
  ).run(fieldKey, '关联', JSON.stringify({ targetSheetId: 2 }));

  const fields = await readTableFields(PRESET);
  check('新字段出现在字段表里', fields.some(item => item.key === fieldKey));
  check('内置 7 列 + 1 个新字段', fields.length === 8, `实际 ${fields.length}`);

  db.prepare(
    "INSERT INTO record (kind, title, body, status, tag, sub_tag, happened_date, happened_time, custom, created_at, updated_at, deleted_at) VALUES ('log', ?, ?, 'inbox', '工作', 'A、B', '2026-11-24', '09:30', '{}', '', '', '')"
  ).run('原始标题', '原始说明');
  const rowId = Number(db.prepare('SELECT MAX(id) AS id FROM record').get().id);

  // 读回来的行：自定义列还没有值，但不该是 undefined 之外的东西
  let rows = await readTableRows(PRESET);
  eq('空库时自定义列读成 undefined', rows[0].values[fieldKey] === undefined, true);

  // 写入：真列 + 自定义列一起
  const values = {
    ...rows[0].values,
    text: '改过的标题',
    status: 'doing',
    detail: '改过的说明',
    [fieldKey]: [3, 5],
  };
  await saveTableRow(PRESET, { id: rowId, custom: rawRow(rowId).custom }, values);

  const saved = rawRow(rowId);
  eq('真列 title 落库', saved.title, '改过的标题');
  eq('真列 body 落库', saved.body, '改过的说明');
  eq('真列 status 反向归一（doing 不翻译）', saved.status, 'doing');
  eq('真列 sub_tag 用顿号拼回', saved.sub_tag, 'A、B');
  eq('自定义列进 custom', customOf(rowId)[fieldKey], [3, 5]);

  rows = await readTableRows(PRESET);
  eq('重新读行：自定义列值回来', rows[0].values[fieldKey], [3, 5]);
  eq('重新读行：真列值回来', [rows[0].values.text, rows[0].values.detail], ['改过的标题', '改过的说明']);
  eq('values 里不该出现 custom. 前缀键', Object.keys(rows[0].values).includes(`custom.${fieldKey}`), false);

  // ---------------------------------------------------------------
  // 3) 合并写：别把 _bd / 其它自定义列抹掉（白板便签会集体跳回原点）
  // ---------------------------------------------------------------
  db.prepare('UPDATE record SET custom = ? WHERE id = ?').run(
    JSON.stringify({ _bd: { x: 120, y: 40, w: 200, h: 120, c: 'yellow' }, keep_me: '在' }),
    String(rowId)
  );
  await saveTableRow(PRESET, { id: rowId, custom: rawRow(rowId).custom }, {
    ...values,
    text: '再改一次',
    otherKey: '顺便',
  });
  const merged = customOf(rowId);
  eq('_bd 没被抹', merged._bd, { x: 120, y: 40, w: 200, h: 120, c: 'yellow' });
  eq('不认识的旧键没被抹', merged.keep_me, '在');
  eq('这次写的自定义列在', merged[fieldKey], [3, 5]);
  eq('新增的自定义列也写进去了', merged.otherKey, '顺便');

  // ---------------------------------------------------------------
  // 4) 内部键不进 custom：__fmt 单独存、清空时要真的删掉
  // ---------------------------------------------------------------
  await saveTableRow(PRESET, { id: rowId, custom: rawRow(rowId).custom }, {
    ...values,
    __fmt: { [fieldKey]: { bg: '#fff3c4' } },
  });
  eq('__fmt 落库', customOf(rowId).__fmt, { [fieldKey]: { bg: '#fff3c4' } });
  rows = await readTableRows(PRESET);
  eq('__fmt 读回', rows[0].values.__fmt, { [fieldKey]: { bg: '#fff3c4' } });

  await saveTableRow(PRESET, { id: rowId, custom: rawRow(rowId).custom }, { ...values, __fmt: {} });
  eq('__fmt 清空后键被删', '__fmt' in customOf(rowId), false);

  // _bd 这种下划线开头的键不该被当成自定义列写进去（它由白板自己维护）
  await saveTableRow(PRESET, { id: rowId, custom: rawRow(rowId).custom }, { ...values, _bd: { x: 1 } });
  eq('values 里的 _bd 不覆盖库里的 _bd', customOf(rowId)._bd, { x: 120, y: 40, w: 200, h: 120, c: 'yellow' });

  // ---------------------------------------------------------------
  // 5) 老字段 key（custom. 前缀）也能读写同一处
  // ---------------------------------------------------------------
  db.prepare(
    "INSERT INTO field_def (entity, key, label, type, sort, visible, builtin) VALUES ('log', 'custom.flegacy', '旧列', 'text', 8, 1, 0)"
  ).run();
  const legacyFields = await readTableFields(PRESET);
  const legacyField = legacyFields.find(item => item.label === '旧列');
  eq('老 key 读成剥前缀后的 key', legacyField.key, 'flegacy');

  db.prepare('UPDATE record SET custom = ? WHERE id = ?').run(
    JSON.stringify({ ...customOf(rowId), flegacy: '老数据' }),
    String(rowId)
  );
  rows = await readTableRows(PRESET);
  eq('老数据按新 key 读出', rows[0].values.flegacy, '老数据');
  await saveTableRow(PRESET, { id: rowId, custom: rawRow(rowId).custom }, { ...rows[0].values, flegacy: '改了' });
  eq('老字段写回同一个键', customOf(rowId).flegacy, '改了');
  eq('老字段不该写出双前缀键', 'custom.flegacy' in customOf(rowId), false);

  // ---------------------------------------------------------------
  // 6) 新建行：自定义列与附件一起落进 custom
  // ---------------------------------------------------------------
  const newId = await insertTableRow(PRESET, {
    text: '新行',
    attachments: [{ path: '/tmp/a.png', name: 'a.png' }],
    [fieldKey]: [7],
    ignoredBlank: '',
  });
  check('新行拿到 id', Number(newId) > 0, String(newId));
  const created = customOf(newId);
  eq('新行自定义列落库', created[fieldKey], [7]);
  eq('新行附件落库', created.attachments, [{ path: '/tmp/a.png', name: 'a.png' }]);
  eq('新行空字符串的自定义列也照写（与真列一致）', created.ignoredBlank, '');

  // ---------------------------------------------------------------
  // 7) 自定义列的空值不是「删除」：写 '' 之后键还在，读回是空串
  // ---------------------------------------------------------------
  await saveTableRow(PRESET, { id: rowId, custom: rawRow(rowId).custom }, { ...rows[0].values, [fieldKey]: [] });
  eq('清空多选写空数组', customOf(rowId)[fieldKey], []);
  rows = await readTableRows(PRESET);
  eq('清空后读回空数组', rows[0].values[fieldKey], []);

  // ---------------------------------------------------------------
  // 汇总
  // ---------------------------------------------------------------
  if (failures.length) {
    console.error(`\n✗ presetCustom: ${passed} passed, ${failures.length} failed`);
    failures.forEach(item => console.error(`  - ${item}`));
    process.exit(1);
  }
  console.log(`✓ presetCustom: ${passed} passed`);
}

main().catch(error => {
  console.error('✗ presetCustom 跑挂了:', error);
  process.exit(1);
});
