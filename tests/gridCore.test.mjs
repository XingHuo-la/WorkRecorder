// gridCore.js 的断言脚本。纯函数，不需要 DOM。
// 覆盖四块：TSV 双向编解码、键盘意图解析、选区模型、坐标运算。

import {
  serializeTSV,
  parseTSV,
  resolveKeyIntent,
  createSelection,
  clampIndex,
  wrapColumn,
  jumpToEdge,
  createGrid,
} from '../src/gridCore.js';

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

const K = (key, extra = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 0,
  ...extra,
});

// ---------- 1. TSV 编解码 ----------
console.log('\n[1] TSV 双向编解码');

eq('普通矩阵', parseTSV(serializeTSV([['a', 'b'], ['c', 'd']])), [['a', 'b'], ['c', 'd']]);
eq('含 Tab 的格子被引号包裹', serializeTSV([['a\tb']]), '"a\tb"');
eq('含 Tab 往返', parseTSV(serializeTSV([['a\tb', 'c']])), [['a\tb', 'c']]);
eq('含换行的格子往返', parseTSV(serializeTSV([['第一行\n第二行', 'x']])), [['第一行\n第二行', 'x']]);
eq('引号翻倍往返', parseTSV(serializeTSV([['他说"你好"']])), [['他说"你好"']]);
eq('空值占位不吞列', parseTSV('a\t\tc'), [['a', '', 'c']]);
eq('CRLF 当换行', parseTSV('a\tb\r\nc\td'), [['a', 'b'], ['c', 'd']]);
eq('结尾无换行也成行', parseTSV('a\tb'), [['a', 'b']]);
eq('空文本无行', parseTSV(''), []);
eq('数字转文本', serializeTSV([[1, 2.5, null]]), '1\t2.5\t');

// ---------- 2. 键盘意图 ----------
console.log('\n[2] 键盘意图解析');

eq('方向键下', resolveKeyIntent(K('ArrowDown')), { type: 'move', dr: 1, dc: 0, extend: false });
eq('Shift+方向键右', resolveKeyIntent(K('ArrowRight', { shiftKey: true })), { type: 'move', dr: 0, dc: 1, extend: true });
eq('Ctrl+方向键下 = 跳边界', resolveKeyIntent(K('ArrowDown', { ctrlKey: true })), { type: 'jump', dr: 1, dc: 0, extend: false });
eq('Tab 右移带绕行', resolveKeyIntent(K('Tab')), { type: 'move', dr: 0, dc: 1, wrap: true, extend: false });
eq('Shift+Tab 左移', resolveKeyIntent(K('Tab', { shiftKey: true })), { type: 'move', dr: 0, dc: -1, wrap: true, extend: false });
eq('Enter 进编辑', resolveKeyIntent(K('Enter')), { type: 'edit', dr: 1 });
eq('Shift+Enter 进编辑', resolveKeyIntent(K('Enter', { shiftKey: true })), { type: 'edit', dr: -1 });
eq('F2 进编辑不移动', resolveKeyIntent(K('F2')), { type: 'edit', dr: 0 });
eq('Delete 清空', resolveKeyIntent(K('Delete')), { type: 'clear' });
eq('Backspace 清空', resolveKeyIntent(K('Backspace')), { type: 'clear' });
eq('Home 到行首', resolveKeyIntent(K('Home')), { type: 'move', to: 'rowStart', extend: false });
eq('Ctrl+Home 到表首', resolveKeyIntent(K('Home', { ctrlKey: true })), { type: 'move', to: 'tableStart', extend: false });
eq('Ctrl+A 全选', resolveKeyIntent(K('a', { ctrlKey: true })), { type: 'selectAll' });
eq('Ctrl+C 复制', resolveKeyIntent(K('c', { ctrlKey: true })), { type: 'copy' });
eq('Ctrl+X 剪切', resolveKeyIntent(K('x', { ctrlKey: true })), { type: 'cut' });
eq('Ctrl+Z 撤销', resolveKeyIntent(K('z', { ctrlKey: true })), { type: 'undo' });
eq('Ctrl+Shift+Z 重做', resolveKeyIntent(K('z', { ctrlKey: true, shiftKey: true })), { type: 'redo' });
eq('Ctrl+Y 重做', resolveKeyIntent(K('y', { ctrlKey: true })), { type: 'redo' });
eq('可打印字符进编辑', resolveKeyIntent(K('你')), { type: 'type', char: '你' });
eq('空格也进编辑', resolveKeyIntent(K(' ')), { type: 'type', char: ' ' });

// IME：这条最重要，漏了就是打拼音按方向键跳格
eq('IME 组合中一律不消费', resolveKeyIntent(K('ArrowDown', { isComposing: true })), { type: 'none', reason: 'ime' });
eq('keyCode 229 同样让行', resolveKeyIntent(K('Enter', { keyCode: 229 })), { type: 'none', reason: 'ime' });

// 编辑态
eq('编辑态 Enter 提交下移', resolveKeyIntent(K('Enter'), { editing: true }), { type: 'commit', dr: 1, dc: 0 });
eq('编辑态 Shift+Enter 提交上移', resolveKeyIntent(K('Enter', { shiftKey: true }), { editing: true }), { type: 'commit', dr: -1, dc: 0 });
eq('编辑态 Tab 提交右移', resolveKeyIntent(K('Tab'), { editing: true }), { type: 'commit', dr: 0, dc: 1, wrap: true });
eq('编辑态 Esc 取消', resolveKeyIntent(K('Escape'), { editing: true }), { type: 'cancel' });
eq('编辑态 Alt+Enter 换行放行', resolveKeyIntent(K('Enter', { altKey: true }), { editing: true }), { type: 'none', reason: 'newline' });
eq('编辑态方向键放行', resolveKeyIntent(K('ArrowLeft'), { editing: true }), { type: 'none', reason: 'typing' });

// ---------- 3. 选区模型 ----------
console.log('\n[3] 选区模型');

{
  const sel = createSelection();
  sel.select(2, 3);
  eq('单选 size=1', sel.size(), 1);
  eq('单选 active', sel.active(), { r: 2, c: 3 });
  ok('单选包含自己', sel.contains(2, 3));
  ok('单选不包含邻居', !sel.contains(2, 4));

  sel.extendTo(4, 5);
  eq('Shift 扩展后 size=9', sel.size(), 9);
  eq('扩展后 anchor 不动', sel.active(), { r: 2, c: 3 });
  ok('扩展后含对角', sel.contains(4, 5));
  eq('扩展后 bounds', sel.bounds(), { r1: 2, r2: 4, c1: 3, c2: 5 });

  sel.select(0, 0);
  sel.toggle(0, 2);
  sel.toggle(0, 3);
  eq('Ctrl 离散 size=3', sel.size(), 3);
  eq('离散摊平不重复', sel.cells(), [{ r: 0, c: 0 }, { r: 0, c: 2 }, { r: 0, c: 3 }]);
  sel.toggle(0, 2);
  eq('Ctrl 再点取消该格', sel.size(), 2);

  sel.clear();
  eq('清空后 size=0', sel.size(), 0);
  eq('清空后无 active', sel.active(), null);
}

{
  // 反向拖框（从右下往左上拉）也要正确
  const sel = createSelection();
  sel.select(5, 5);
  sel.extendTo(2, 1);
  eq('反向拖框 bounds 归一', sel.bounds(), { r1: 2, r2: 5, c1: 1, c2: 5 });
  eq('反向拖框 size', sel.size(), 20);
}

// ---------- 4. 坐标运算 ----------
console.log('\n[4] 坐标运算');

eq('clamp 负数归零', clampIndex(-3, 10), 0);
eq('clamp 超界取末格', clampIndex(99, 10), 9);
eq('clamp 空网格', clampIndex(3, 0), 0);

eq('Tab 行内不动（+1 由 move 负责）', wrapColumn({ r: 1, c: 3 }, 5, 4), { r: 1, c: 3 });
eq('Tab 末列绕到下行首', wrapColumn({ r: 1, c: 5 }, 5, 4), { r: 2, c: 0 });
eq('Tab 最后一行末列越界', wrapColumn({ r: 3, c: 5 }, 5, 4), null);
eq('Shift+Tab 首列绕到上行末', wrapColumn({ r: 2, c: -1 }, 5, 4), { r: 1, c: 4 });
eq('Shift+Tab 首行越界', wrapColumn({ r: 0, c: -1 }, 5, 4), null);

{
  // 一列 6 行：第 2..3 行有值，其余空
  const filled = new Set(['1:0', '2:0']);
  const isEmpty = (r, c) => !filled.has(`${r}:${c}`);
  eq('从顶向下跳到第一个有值格', jumpToEdge({ r: 0, c: 0 }, 1, 0, isEmpty, 6, 1), { r: 1, c: 0 });
  eq('从有值区跳到空白区停在最后有值格', jumpToEdge({ r: 1, c: 0 }, 1, 0, isEmpty, 6, 1), { r: 2, c: 0 });
  eq('到底无变化时原地不动', jumpToEdge({ r: 5, c: 0 }, 1, 0, isEmpty, 6, 1), { r: 5, c: 0 });
}

// ---------- 5. 控制器接线 ----------
console.log('\n[5] 控制器接线');

{
  const calls = [];
  const grid = createGrid({
    rowCount: () => 3,
    colCount: () => 3,
    isEditing: () => false,
    isEmpty: (r, c) => r === 0 && c === 0,
    focus: (r, c) => calls.push(['focus', r, c]),
    onSelection: s => calls.push(['sel', s.size]),
    onEditStart: (r, c, opts) => calls.push(['edit', r, c, opts.char ?? '']),
    onClear: cells => calls.push(['clear', cells.length]),
    onCopy: (matrix, opts) => calls.push(['copy', matrix.length, opts.cut]),
    onUndo: () => calls.push(['undo']),
  });

  grid.select(1, 1);
  ok('select 命中', calls.some(c => c[0] === 'sel'));

  calls.length = 0;
  ok('方向键被消费', grid.handleKeydown(K('ArrowDown')) === true);
  ok('焦点移到 (2,1)', calls.some(c => c.join() === 'focus,2,1'));

  calls.length = 0;
  grid.handleKeydown(K('Enter'));
  ok('Enter 触发编辑', calls.some(c => c[0] === 'edit' && c[1] === 2 && c[2] === 1));

  calls.length = 0;
  grid.handleKeydown(K('x'));
  ok('敲字带初始字符', calls.some(c => c[0] === 'edit' && c[3] === 'x'));

  calls.length = 0;
  grid.handleKeydown(K('Delete'));
  ok('Delete 清空当前格', calls.some(c => c[0] === 'clear' && c[1] === 1));

  calls.length = 0;
  grid.handleKeydown(K('c', { ctrlKey: true }));
  ok('Ctrl+C 带出选区矩阵', calls.some(c => c[0] === 'copy' && c[1] === 1));

  calls.length = 0;
  grid.handleKeydown(K('z', { ctrlKey: true }));
  ok('Ctrl+Z 走撤销', calls.some(c => c[0] === 'undo'));

  // Shift 连续扩展必须从焦点继续长，不能每次都从 anchor 重算 —— 后者的表现是
  // 「Shift+→ 再 Shift+↓」只选出竖着的两格（探针里实测到过）。
  grid.select(0, 0);
  grid.handleKeydown(K('ArrowRight', { shiftKey: true }));
  grid.handleKeydown(K('ArrowDown', { shiftKey: true }));
  const grow = grid.snapshot();
  eq('Shift 连续扩展得到 2×2', grow.size, 4);
  eq('anchor 留在起点', grow.anchor, { r: 0, c: 0 });
  eq('focus 走到右下', grow.focus, { r: 1, c: 1 });

  // 边界：焦点在最后一行继续按下，不应抛错也不应越界
  grid.select(2, 2);
  calls.length = 0;
  grid.handleKeydown(K('ArrowDown'));
  ok('末行向下不越界', calls.every(c => c[0] !== 'focus' || c[1] <= 2));
}

console.log(`\n结果：${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
