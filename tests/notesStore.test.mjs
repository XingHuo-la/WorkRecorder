// notesStore.js 的 payload 契约测试。
//
// 这条测试存在的唯一理由：Rust 侧 NoteDoc 是 `#[derive(Deserialize)]` 且**没有**
// `#[serde(rename_all = "camelCase")]`，serde 对不认识的键**静默忽略**。
// 所以「前端把键写成 noteType」这种改动不会报错、不会进日志，只会让
// note_type 退回默认值、sub_tag 变空串（文件掉一层目录）、rel_path 变空串
// （每次保存多出一个文件）。这类 bug 只能靠断言拦，不能靠眼睛。
//
// 跑法：node tests/notesStore.test.mjs

const calls = [];

function fakeInvoke(cmd, args = {}) {
  // 深拷贝一份：被测代码之后如果再改 payload 对象，断言不会跟着变
  calls.push({ cmd, args: JSON.parse(JSON.stringify(args ?? {})) });

  if (cmd === 'get_current_path') return 'C:/data/recorder.db';
  if (cmd === 'notes_ensure_root') return 'C:/data/notes';
  if (cmd === 'notes_write' || cmd === 'notes_update_meta' || cmd === 'notes_set_record') {
    return {
      ...(args?.doc || {}),
      rel_path: '工作/A项目/2026-09-20-设计评审.md',
      abs_path: 'C:/data/notes/工作/A项目/2026-09-20-设计评审.md',
    };
  }
  return null;
}

// notesStore 用惰性 getInvoke()，但取值时仍然读 window.__TAURI__，
// 所以在 import 之前把 window 桩好；import 必须走动态形式（静态 import 会被提升）。
// addEventListener 是给 logger.js 的：它在模块加载时就装全局错误捕获。
globalThis.window = {
  __TAURI__: { core: { invoke: fakeInvoke } },
  addEventListener() {},
};

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function lastCall(cmd) {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i].cmd === cmd) return calls[i];
  }
  return null;
}

const NOTE_DOC_KEYS = [
  'abs_path',
  'content',
  'created_at',
  'id',
  'note_type',
  'record_id',
  'rel_path',
  'status',
  'sub_tag',
  'tag',
  'title',
  'updated_at',
];

const FORBIDDEN_KEYS = ['noteType', 'subTag', 'createdAt', 'updatedAt', 'relPath', 'absPath'];

const { writeNote, updateNoteMeta, setNoteRecord } = await import('../src/notesStore.js');

console.log('\n[1] writeNote 发出的 doc 键名是 snake_case');
{
  await writeNote({
    title: '设计评审',
    content: '正文',
    note_type: 'problem',
    status: 'usable',
    tag: '工作',
    sub_tag: 'A项目',
    record_id: 12,
    created_at: '2026-09-20 10:00:00',
    updated_at: '2026-09-20 11:00:00',
    rel_path: '',
  });

  const doc = lastCall('notes_write')?.args?.doc || {};
  const keys = Object.keys(doc).sort();

  check('键集合与 Rust NoteDoc 完全一致', JSON.stringify(keys) === JSON.stringify(NOTE_DOC_KEYS), keys.join(','));
  check('没有 camelCase 残留', FORBIDDEN_KEYS.every(k => !(k in doc)), Object.keys(doc).join(','));
  check('note_type 原样传出', doc.note_type === 'problem', String(doc.note_type));
  check('sub_tag 原样传出', doc.sub_tag === 'A项目', String(doc.sub_tag));
  check('record_id 原样传出', doc.record_id === 12, String(doc.record_id));
  check('created_at 原样传出', doc.created_at === '2026-09-20 10:00:00', String(doc.created_at));
  check('updated_at 原样传出', doc.updated_at === '2026-09-20 11:00:00', String(doc.updated_at));
}

console.log('\n[2] writeNote 的驼峰入参仍然被接受（入参兼容，出口只有一种形状）');
{
  await writeNote({ title: 'X', noteType: 'review', subTag: '子项目', recordId: 7 });

  const doc = lastCall('notes_write')?.args?.doc || {};
  check('noteType → note_type', doc.note_type === 'review', String(doc.note_type));
  check('subTag → sub_tag', doc.sub_tag === '子项目', String(doc.sub_tag));
  check('recordId → record_id', doc.record_id === 7, String(doc.record_id));
  check('没有 camelCase 残留', FORBIDDEN_KEYS.every(k => !(k in doc)), Object.keys(doc).join(','));
}

console.log('\n[3] 没传 record_id 时是显式 null（独立笔记，不是 undefined）');
{
  await writeNote({ title: 'Y', content: 'c' });
  const doc = lastCall('notes_write')?.args?.doc || {};
  check('record_id === null', doc.record_id === null, String(doc.record_id));
  check('note_type 缺省为 idea', doc.note_type === 'idea', String(doc.note_type));
  check('sub_tag 缺省为空串', doc.sub_tag === '', JSON.stringify(doc.sub_tag));
}

console.log('\n[4] updateNoteMeta 同样是 snake_case，且空值语义正确');
{
  await updateNoteMeta('工作/A项目/2026-09-20-设计评审.md', { title: '新标题', updated_at: '2026-09-21 09:00:00' });

  const call = lastCall('notes_update_meta');
  const doc = call?.args?.doc || {};
  const keys = Object.keys(doc).sort();

  check('命令参数 relPath 正确（Tauri 只转换顶层参数名）', call?.args?.relPath === '工作/A项目/2026-09-20-设计评审.md', call?.args?.relPath);
  check('键集合与 Rust NoteDoc 完全一致', JSON.stringify(keys) === JSON.stringify(NOTE_DOC_KEYS), keys.join(','));
  check('没有 camelCase 残留', FORBIDDEN_KEYS.every(k => !(k in doc)), Object.keys(doc).join(','));
  check('content 空串（不动正文）', doc.content === '', JSON.stringify(doc.content));
  check('note_type 缺省是空串（Rust 才不会把真实类型打回 idea）', doc.note_type === '', JSON.stringify(doc.note_type));
  check('status 缺省是空串（不会被无条件改成 usable）', doc.status === '', JSON.stringify(doc.status));
  check('record_id 缺省是 null（Rust 不会覆盖已有挂载）', doc.record_id === null, String(doc.record_id));
  check('rel_path 与参数一致', doc.rel_path === '工作/A项目/2026-09-20-设计评审.md', String(doc.rel_path));
}

console.log('\n[5] setNoteRecord：挂载与解除关联');
{
  await setNoteRecord('工作/A项目/2026-09-20-设计评审.md', 12);
  let call = lastCall('notes_set_record');
  check('挂载：relPath 正确', call?.args?.relPath === '工作/A项目/2026-09-20-设计评审.md', call?.args?.relPath);
  check('挂载：recordId 是数字 12', call?.args?.recordId === 12, String(call?.args?.recordId));
  check('挂载：命令里没有 doc 包装（notes_set_record 平铺三个参数）', !('doc' in (call?.args || {})), Object.keys(call?.args || {}).join(','));

  await setNoteRecord('工作/A项目/2026-09-20-设计评审.md', null);
  call = lastCall('notes_set_record');
  check('解除：recordId 显式 null（不是不传）', call?.args?.recordId === null && 'recordId' in (call?.args || {}), JSON.stringify(call?.args));

  await setNoteRecord('工作/A项目/2026-09-20-设计评审.md', '');
  call = lastCall('notes_set_record');
  check('解除：空串也归一成 null', call?.args?.recordId === null, String(call?.args?.recordId));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
