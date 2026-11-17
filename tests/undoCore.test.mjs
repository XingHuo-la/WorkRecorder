// undoCore.js 的断言脚本。纯逻辑，用内存计数器当「数据库」。

import { createUndoStack } from '../src/undoCore.js';

let pass = 0;
let fail = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `期望 ${e}，实际 ${a}`);
}

// 假状态：一个数字，写操作 = 改它
function makeCell(initial = 0) {
  const state = { value: initial };
  return {
    state,
    set(next) { state.value = next; },
    get() { return state.value; },
  };
}

// ---------- 1. 基本撤销 ----------
console.log('\n[1] 基本撤销 / 重做');
{
  const stack = createUndoStack();
  const cell = makeCell('原值');

  cell.set('新值');
  stack.push({
    label: '编辑单元格',
    undo: () => cell.set('原值'),
    redo: () => cell.set('新值'),
  });

  eq('入栈后 canUndo', stack.canUndo, true);
  eq('入栈后 canRedo', stack.canRedo, false);

  const entry = await stack.undo();
  eq('撤销叫出操作名', entry.label, '编辑单元格');
  eq('撤销后值回滚', cell.get(), '原值');
  eq('撤销后可重做', stack.canRedo, true);

  await stack.redo();
  eq('重做后值前进', cell.get(), '新值');
  eq('重做后又可撤销', stack.canUndo, true);
}

// ---------- 2. 空栈 ----------
console.log('\n[2] 空栈');
{
  const stack = createUndoStack();
  eq('空栈 undo 返回 null', await stack.undo(), null);
  eq('空栈 redo 返回 null', await stack.redo(), null);
  eq('空栈 canUndo', stack.canUndo, false);
}

// ---------- 3. 新操作截断重做链 ----------
console.log('\n[3] 新操作截断重做链');
{
  const stack = createUndoStack();
  const log = [];
  stack.push({ label: 'A', undo: () => log.push('undo-A'), redo: () => log.push('redo-A') });
  stack.push({ label: 'B', undo: () => log.push('undo-B'), redo: () => log.push('redo-B') });

  await stack.undo(); // 撤 B
  eq('撤销后可重做 B', stack.canRedo, true);

  stack.push({ label: 'C', undo: () => log.push('undo-C'), redo: () => log.push('redo-C') });
  eq('新操作后重做链被清空', stack.canRedo, false);

  await stack.undo(); // 撤 C
  await stack.undo(); // 撤 A
  eq('历史线正确', log, ['undo-B', 'undo-C', 'undo-A']);
  eq('撤到底', stack.canUndo, false);
}

// ---------- 4. 合并连续编辑 ----------
console.log('\n[4] 合并连续编辑');
{
  const stack = createUndoStack({ mergeWindow: 300 });
  const cell = makeCell('初始');
  const history = [];

  // 模拟笔记自动保存：三次连续保存同一个 mergeKey
  for (const value of ['一', '二', '三']) {
    const before = cell.get();
    cell.set(value);
    history.push(before);
    stack.push({
      label: '编辑正文',
      mergeKey: 'note:abc',
      undo: () => cell.set(before),
      redo: () => cell.set(value),
    });
  }

  eq('三次编辑合并成一条', stack.depth, 1);
  await stack.undo();
  eq('合并后撤销回到最初状态', cell.get(), '初始');
  await stack.redo();
  eq('合并后重做去到最新状态', cell.get(), '三');
}

{
  // 不同 mergeKey 不合并
  const stack = createUndoStack({ mergeWindow: 300 });
  const cell = makeCell('x');
  stack.push({ label: 'A', mergeKey: 'note:1', undo: () => cell.set('x'), redo: () => cell.set('y') });
  stack.push({ label: 'B', mergeKey: 'note:2', undo: () => cell.set('x'), redo: () => cell.set('y') });
  eq('不同 key 各占一条', stack.depth, 2);
}

// ---------- 5. 撤销中不许再入栈（防死循环） ----------
console.log('\n[5] 撤销中拒绝入栈');
{
  const stack = createUndoStack();
  const cell = makeCell(0);
  let reentered = null;

  stack.push({
    label: '外层',
    undo: () => {
      reentered = stack.push({ label: '内层', undo: () => {} });
    },
  });

  await stack.undo();
  eq('applying 期间 push 被拒绝', reentered, false);
  eq('栈里没有多出内层', stack.depth, 0);
}

// ---------- 6. 撤销失败回滚 ----------
console.log('\n[6] 撤销失败不丢历史');
{
  const stack = createUndoStack();
  stack.push({
    label: '会失败',
    undo: () => { throw new Error('数据库被占用'); },
  });

  let caught = '';
  try {
    await stack.undo();
  } catch (error) {
    caught = error.message;
  }
  eq('错误向上抛', caught, '数据库被占用');
  eq('失败的操作留在栈里', stack.depth, 1);
  ok('失败后没进重做链', stack.canRedo === false);
}

// ---------- 7. 容量上限 ----------
console.log('\n[7] 容量上限');
{
  const stack = createUndoStack({ limit: 3 });
  for (let i = 0; i < 5; i += 1) {
    stack.push({ label: `op${i}`, undo: () => {} });
  }
  eq('超出上限后只留最后 3 条', stack.depth, 3);
  eq('留下的是最新三条', stack.peek().map(e => e.label), ['op2', 'op3', 'op4']);
}

// ---------- 8. 订阅 ----------
console.log('\n[8] 状态订阅');
{
  const stack = createUndoStack();
  const seen = [];
  const off = stack.subscribe(state => seen.push(state.canUndo));
  stack.push({ label: 'A', undo: () => {} });
  await stack.undo();
  off();
  stack.push({ label: 'B', undo: () => {} });
  eq('订阅收到两次状态', seen, [true, false]);
}

// ---------- 9. 无效条目 ----------
console.log('\n[9] 无效条目');
{
  const stack = createUndoStack();
  eq('没有 undo 函数被拒绝', stack.push({ label: '空' }), false);
  eq('null 被拒绝', stack.push(null), false);
  eq('栈仍为空', stack.depth, 0);
}

console.log(`\n结果：${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
