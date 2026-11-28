// recordTree.js 的临时验证脚本（排查用，验证完即删）。
// 覆盖 5 类：6 层链的缩进/路径前缀、折叠整枝、父不在本批、旧数据有环、环检测与性能。

import {
  buildForest,
  flattenVisibleTree,
  wouldCreateCycle,
  moveCandidates,
  toId,
} from '../src/recordTree.js';

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

// ---------- 1. 六层链 ----------
console.log('\n[1] 六层链：缩进封顶 + 路径前缀');
const chain = [
  { id: 1, parent_id: null, title: '机组' },
  { id: 2, parent_id: 1, title: '系统' },
  { id: 3, parent_id: 2, title: '设备' },
  { id: 4, parent_id: 3, title: '部件' },
  { id: 5, parent_id: 4, title: '测点' },
  { id: 6, parent_id: 5, title: '参数' },
];

const visible = flattenVisibleTree(chain, new Set(), { indentMax: 3 });
eq('全部展开时 6 行可见', visible.length, 6);
eq('深度序列', visible.map(v => v.depth), [1, 2, 3, 4, 5, 6]);
eq('缩进序列（第 4 层起封顶 32）', visible.map(v => v.indent), [0, 16, 32, 32, 32, 32]);
eq('前三层无路径前缀', visible.slice(0, 3).map(v => v.pathPrefix), ['', '', '']);
eq('第 4 层前缀取祖先末两段', visible[3].pathPrefix, '⋯ 系统 / 设备');
eq('第 5 层前缀', visible[4].pathPrefix, '⋯ 设备 / 部件');
eq('第 6 层前缀', visible[5].pathPrefix, '⋯ 部件 / 测点');
eq('pathFull 含自身', visible[5].pathFull, '机组 / 系统 / 设备 / 部件 / 测点 / 参数');
ok('叶子无子项标记', visible[5].hasChildren === false);
ok('根有子项标记', visible[0].hasChildren === true);
eq('根的 childCount 只算子项不含孙', visible[0].childCount, 1);

// ---------- 2. 折叠整枝 ----------
console.log('\n[2] 折叠第 2 层：整枝隐藏');
const collapsed = flattenVisibleTree(chain, new Set([2]), { indentMax: 3 });
eq('折叠后只剩 2 行', collapsed.length, 2);
eq('剩的是第 1、2 层', collapsed.map(v => v.row.id), [1, 2]);
ok('被折叠节点标记 isCollapsed', collapsed[1].isCollapsed === true);

// ---------- 3. 父不在本批 ----------
console.log('\n[3] 父不在本批（被筛掉 / 跨表脏数据）→ 当根，不丢行');
const partial = [
  { id: 7, parent_id: 999, title: '孤儿A' },
  { id: 8, parent_id: 7, title: '孤儿A的子' },
];
const forestPartial = buildForest(partial);
eq('孤儿当根后仍有两行', flattenVisibleTree(partial, new Set()).length, 2);
eq('孤儿的深度从 1 起', flattenVisibleTree(partial, new Set()).map(v => v.depth), [1, 2]);
ok('孤儿进了 roots', forestPartial.roots.some(n => n.id === 7));

// ---------- 4. 旧数据有环 ----------
console.log('\n[4] 旧数据成环（v10 前没做校验）→ 不死循环、不丢行');
const cyclic = [
  { id: 11, parent_id: 12, title: '环A' },
  { id: 12, parent_id: 11, title: '环B' },
  { id: 13, parent_id: 11, title: '挂环A下的C' },
];
const forestCycle = buildForest(cyclic);
eq('环上的行一条不少', flattenVisibleTree(cyclic, new Set()).length, 3);
eq('无环数据深度正常', forestCycle.depthById.get(13), 2);

// ---------- 5. 环检测 ----------
console.log('\n[5] wouldCreateCycle');
const nodes = new Map([
  [3, { id: 3, parent_id: null }],
  [4, { id: 4, parent_id: 3 }],
  [5, { id: 5, parent_id: 4 }],
]);
const parentOf = async id => nodes.get(Number(id)) || null;

ok('把 3 挂到 5 下会成环（3 进自己的子树）', (await wouldCreateCycle(3, 5, parentOf)) === true);
ok('把 5 挂到 3 下不成环（5 变成 4 的兄弟）', (await wouldCreateCycle(5, 3, parentOf)) === false);
ok('把自己挂到自己下成环', (await wouldCreateCycle(5, 5, parentOf)) === true);
ok('提到顶层不算环', (await wouldCreateCycle(5, null, parentOf)) === false);
ok('把 3 挂到 5 的兄弟（不存在）不算环', (await wouldCreateCycle(3, 99, parentOf)) === false);
ok('不相关的两层不成环', (await wouldCreateCycle(3, null, parentOf)) === false);

// 旧数据有环时，新操作不应被历史脏数据误判成环
const dirty = new Map([
  [20, { id: 20, parent_id: 21 }],
  [21, { id: 21, parent_id: 20 }],
]);
const dirtyParentOf = async id => dirty.get(Number(id)) || null;
ok('历史环不会让上溯死循环', (await wouldCreateCycle(30, 20, dirtyParentOf)) === false);

// ---------- 6. 性能 ----------
console.log('\n[6] 性能：1000 行 / 20 层');
const big = [];
for (let i = 1; i <= 20; i += 1) big.push({ id: i, parent_id: i === 1 ? null : i - 1, title: `L${i}` });
for (let i = 21; i <= 1000; i += 1) big.push({ id: i, parent_id: 3, title: `B${i}` });

const t0 = performance.now();
const forestBig = buildForest(big);
const flatBig = flattenVisibleTree(big, new Set(), { indentMax: 3 });
const cost = performance.now() - t0;
ok(`1000 行建树+展开 < 20ms（实际 ${cost.toFixed(2)}ms）`, cost < 20);
eq('1000 行全部可见', flatBig.length, 1000);
eq('最深 20 层仍保留真实深度', Math.max(...flatBig.map(v => v.depth)), 20);
eq('第 20 层缩进仍是 32', flatBig.find(v => v.depth === 20).indent, 32);
ok('1000 行建树完成', forestBig.byId.size === 1000);

// ---------- 7. toId 归一 ----------
console.log('\n[7] toId');
eq('字符串数字', toId('12'), 12);
eq('null', toId(null), null);
eq('空串', toId(''), null);
eq('undefined', toId(undefined), null);
eq('非数字', toId('abc'), null);

// ---------- 8. 移入候选：排自己 + 排全部后代 ----------
console.log('\n[8] moveCandidates（「移入其他行下」的候选集）');
{
  // 结构：1 机组 → 2 系统 → 3 设备；1 还有个兄弟 7
  const rows = [
    { id: 1, parent_id: null, title: '机组' },
    { id: 7, parent_id: null, title: '另一台机组' },
    { id: 2, parent_id: 1, title: '系统' },
    { id: 3, parent_id: 2, title: '设备' },
    { id: 8, parent_id: 7, title: '别家的系统' },
  ];

  // 移「系统」：它和它的子项都不能选，但它自己那一支以外的全都该在
  const sys = moveCandidates(rows, 2);
  eq('移 2 → 排掉 {2,3}', [...sys.banned].sort(), [2, 3]);
  eq('移 2 → 候选里没有 2 也没有 3', sys.entries.filter(e => [2, 3].includes(e.row.id)).length, 0);
  eq('移 2 → 兄弟分支还在（1 / 7 / 8）', sys.entries.map(e => e.row.id), [1, 7, 8]);
  eq('移 2 → 自己在候选里 0 次', sys.entries.filter(e => e.row.id === 2).length, 0);
  eq('移 2 → 子孙在候选里 0 次', sys.entries.filter(e => e.row.id === 3).length, 0);

  // 叶子节点：只排自己
  const leaf = moveCandidates(rows, 3);
  eq('移叶子 3 → 只排自己', [...leaf.banned], [3]);
  eq('移叶子 3 → 候选剩 4 行', leaf.entries.length, 4);
  ok('移叶子 3 → 自己的父（2）可以选', leaf.entries.some(e => e.row.id === 2));

  // 根节点：整表都被排掉，「顶层」是唯一出路
  const root = moveCandidates(rows, 1);
  eq('移根 1 → 排掉自己整支 {1,2,3}', [...root.banned].sort(), [1, 2, 3]);
  eq('移根 1 → 候选只剩另一支', root.entries.map(e => e.row.id), [7, 8]);

  // 一行比它的父**先**出现（sort 顺序与父子顺序无关）—— 单轮扫描会漏
  const reversed = [
    { id: 3, parent_id: 2, title: '设备' },
    { id: 2, parent_id: 1, title: '系统' },
    { id: 1, parent_id: null, title: '机组' },
    { id: 9, parent_id: null, title: '别的' },
  ];
  const rev = moveCandidates(reversed, 1);
  eq('子比父先出现也收全后代', [...rev.banned].sort(), [1, 2, 3]);
  eq('子比父先出现 → 候选只剩 9', rev.entries.map(e => e.row.id), [9]);

  // 折叠状态不影响候选：接口里根本没有 collapsed，深度再深也铺开
  const deep = [];
  for (let i = 1; i <= 8; i += 1) deep.push({ id: i, parent_id: i === 1 ? null : i - 1, title: `L${i}` });
  const deepPick = moveCandidates(deep, 8);
  eq('8 层深也不会因为折叠少行', deepPick.entries.length, 7);
  eq('候选里最深的那个 depth 仍是 7', Math.max(...deepPick.entries.map(e => e.depth)), 7);

  // 提示文案里的「它下面的 N 行」= banned.size - 1
  eq('提示行数 = banned.size - 1（移 2）', sys.banned.size - 1, 1);
  eq('提示行数 = banned.size - 1（移根 1）', root.banned.size - 1, 2);

  // 健壮性：行已被删 / id 是字符串 / 脏环
  eq('selfId 不在表里 → 一个都不排', moveCandidates(rows, 999).banned.size, 1);
  eq('selfId 不在表里 → 候选全在', moveCandidates(rows, 999).entries.length, 5);
  eq('selfId 是字符串也认', [...moveCandidates(rows, '2').banned].sort(), [2, 3]);
  ok('selfId 为 null 不抛', moveCandidates(rows, null).entries.length === 5);

  const dirtyCycle = [
    { id: 11, parent_id: 12, title: '环A' },
    { id: 12, parent_id: 11, title: '环B' },
    { id: 13, parent_id: 11, title: '挂环下' },
  ];
  const dirtyPick = moveCandidates(dirtyCycle, 13);
  ok('脏环不会让候选计算死循环', dirtyPick.entries.length === 2, `实际 ${dirtyPick.entries.length}`);
  ok('脏环不会把别人的子项算成自己的后代', dirtyPick.banned.size === 1, `banned=${dirtyPick.banned.size}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
