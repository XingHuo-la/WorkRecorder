// 跳转栈（navigation.js）的行为验证。
//
// 这一层最怕两种错，两种都不报错、只是「手感怪」：
//   ① 退一层时把上一条也弄丢了（栈掉太快）→ 用户回不去，只能重新找；
//   ② 退一层时反而多长一层（restoring 没挡住）→ Esc 按到天荒地老也关不掉抽屉。
// 所以这里的断言主要是「退完之后还剩几层」和「reopen 被调了几次」。

import {
  setNavCloser,
  push,
  drop,
  reset,
  depth,
  topEntry,
  back,
} from '../src/navigation.js';

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

let closed = 0;
setNavCloser(() => { closed += 1; });

// ---------------------------------------------------------------
// 1) 入栈 / 出栈基础
// ---------------------------------------------------------------
reset();
eq('空栈 depth=0', depth(), 0);
eq('空栈 top=null', topEntry(), null);
const a = push({ label: 'A', reopen: () => {} });
check('push 返回正数 id', a > 0, String(a));
eq('入栈后 depth=1', depth(), 1);
eq('栈顶是 A', topEntry().label, 'A');

const b = push({ label: 'B', reopen: () => {} });
eq('再入一层 depth=2', depth(), 2);
eq('栈顶换成 B', topEntry().label, 'B');
check('两个 id 不同', a !== b);

drop(b);
eq('drop 掉栈顶 = 用户真的离开了这条线索，整栈作废', depth(), 0);
drop(a);
eq('栈已经空了，再 drop 一次还是 0', depth(), 0);
drop(999); // 不存在的 id：不抛错
eq('drop 不存在的 id 是空操作', depth(), 0);
drop(-1); // 回退过程中 push 返回的 -1
eq('drop(-1) 是空操作', depth(), 0);

// ---------------------------------------------------------------
// 1b) 被后代替换掉的祖先：收到 onClose 但必须留住
//     真实链路：在 A 里点关联开 B 时，openDrawer 开头那句 closeAllPanels()
//     会顺手把 A 关掉并回调 onClose —— 如果这里照单全收，B 就没有「上一条」了。
// ---------------------------------------------------------------
reset();
closed = 0;
const reopened2 = [];
const aId = push({ label: 'A', reopen: () => reopened2.push('A') });
const bId = push({ label: 'B', reopen: () => reopened2.push('B') });
eq('A 被 B 替换时 drop(A) 不生效', drop(aId), false);
eq('两条都还在栈里', depth(), 2);
eq('Esc 退一层回到 A', back(), true);
eq('退回时关掉了 B 那一层', closed, 1);
eq('重开的是 A', reopened2, ['A']);
eq('退回后只剩 A', depth(), 1);
// 再按一次 Esc：栈里没有上一条了 → 由调用方正常关闭 → onClose 里 drop(A)
eq('只剩一层时 back 返回 false', back(), false);
eq('关掉最后一层时 drop 生效', drop(aId), true);
eq('整栈清空', depth(), 0);

// ---------------------------------------------------------------
// 2) back()：只有一层时不动手
// ---------------------------------------------------------------
reset();
closed = 0;
push({ label: 'A', reopen: () => {} });
eq('只剩一层时 back 返回 false', back(), false);
eq('一层时 back 不关任何东西', closed, 0);
eq('一层时栈不变', depth(), 1);

// ---------------------------------------------------------------
// 3) back()：两层 → 关掉当前、重开上一层
// ---------------------------------------------------------------
reset();
closed = 0;
const reopens = [];
push({ label: 'A', reopen: () => reopens.push('A') });
push({ label: 'B', reopen: () => reopens.push('B') });
eq('两层时 back 返回 true', back(), true);
eq('back 关掉了当前这一层', closed, 1);
eq('back 重开的是上一层', reopens, ['A']);
eq('退完还剩一层（A 没被丢掉）', depth(), 1);
eq('栈顶回到 A', topEntry().label, 'A');
// 再按一次 Esc：只有一层 → 交给调用方正常关闭
eq('退到底后再 back 返回 false', back(), false);
eq('退到底后不再关面板（由 Esc 默认路径关）', closed, 1);

// ---------------------------------------------------------------
// 4) restoring：重开的那一层不能再入栈，但要接管被恢复那一层的 id
//    （id 必须能用于 drop —— 否则重开的抽屉拿着 -1 过完一生，栈永远清不掉）
// ---------------------------------------------------------------
reset();
let idFromRestore = null;
const aRestore = push({
  label: 'A',
  // 宿主重开抽屉走的就是这里（back() 调 prev.reopen()）
  reopen: () => {
    idFromRestore = push({ label: 'A-again', reopen: () => {} });
  },
});
push({ label: 'B', reopen: () => {} });
back();
eq('回退中 push 不新建条目（栈没变高）', depth(), 1);
check('回退中 push 复用被恢复那一层的 id', idFromRestore === aRestore, `${idFromRestore} vs ${aRestore}`);
// 重开的抽屉最后被关掉 → onClose 里拿这个 id 来 drop，栈必须能清空
eq('用复用来的 id 能清掉栈', drop(idFromRestore), true);
eq('清掉之后 depth=0', depth(), 0);

// ---------------------------------------------------------------
// 5) reopen 不存在时不动手（防止把当前层关了却回不去）
// ---------------------------------------------------------------
reset();
closed = 0;
push({ label: 'A' }); // 没有 reopen
push({ label: 'B', reopen: () => {} });
eq('上一层没有 reopen 时 back 返回 false', back(), false);
eq('这种情况下不关面板', closed, 0);
eq('栈保持不变', depth(), 2);

// ---------------------------------------------------------------
// 6) reset：换表 / 换页时整栈作废
// ---------------------------------------------------------------
reset();
push({ label: 'A', reopen: () => {} });
push({ label: 'B', reopen: () => {} });
reset();
eq('reset 后 depth=0', depth(), 0);
eq('reset 后 top=null', topEntry(), null);

// ---------------------------------------------------------------
// 7) 深度上限：不会无限增长
// ---------------------------------------------------------------
reset();
for (let i = 0; i < 20; i += 1) push({ label: `L${i}`, reopen: () => {} });
check('深度被夹在 12 以内', depth() <= 12, String(depth()));
eq('保留的是最新的那层', topEntry().label, 'L19');

// ---------------------------------------------------------------
// 8) 回退过程中出错不能把栈卡在 restoring
// ---------------------------------------------------------------
reset();
push({ label: 'A', reopen: () => {} });
push({ label: 'B', reopen: () => { throw new Error('重开失败'); } });
eq('上一层重开失败时 back 仍返回 true', back(), true);
eq('失败后栈回到一层', depth(), 1);
const after = push({ label: 'C', reopen: () => {} });
check('失败后 push 恢复正常（restoring 已复位）', after > 0, String(after));

if (failures.length) {
  console.error(`\n✗ navigation: ${passed} passed, ${failures.length} failed`);
  failures.forEach(item => console.error(`  - ${item}`));
  process.exit(1);
}
console.log(`✓ navigation: ${passed} passed`);
