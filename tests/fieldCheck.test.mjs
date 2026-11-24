// 字段值 vs 选项的一致性判断（fieldCheck.js）。
//
// 这里的每一条都对应一个「看起来能用、其实是错的」实现：
//   · 只按 value 匹配 → 从别处粘进来的「已完成」全被标成脏数据（选项 value 是 s1，label 才是中文）
//   · 建选项时给个 v1 代号 → 选项建好了，原来那些格子还是红角标（匹配不回自己）
//   · 多选不拆记号 → 「A,B」当成一个整体，永远对不上

import {
  optionLookup,
  matchOption,
  splitTokens,
  unmatchedTokens,
  columnValueStats,
  unmatchedColumnValues,
  optionsFromValues,
} from '../src/fieldCheck.js';

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

const OPTS = [
  { value: 's1', label: '已完成', color: '#2fbf71' },
  { value: 's2', label: '待整理' },
];

// ---------------------------------------------------------------
// 1) 匹配：value 精确 → label 忽略大小写 → 都没有就是 null
// ---------------------------------------------------------------
eq('按 value 命中', matchOption(OPTS, 's1')?.label, '已完成');
eq('按 label 命中（中文）', matchOption(OPTS, '待整理')?.value, 's2');
eq('大小写不敏感', matchOption([{ value: 'x', label: 'Done' }], 'DONE')?.value, 'x');
eq('首尾空格不算内容', matchOption(OPTS, '  待整理  ')?.value, 's2');
eq('空值不算命中', matchOption(OPTS, '   '), null);
eq('对不上就是 null', matchOption(OPTS, '主设备诊断'), null);
eq('空选项表不会炸', matchOption([], '任意'), null);
check('optionLookup 同时建了 value 与 label 两张表',
  optionLookup(OPTS).byValue.size === 2 && optionLookup(OPTS).byLabel.size === 2);

// ---------------------------------------------------------------
// 2) 单选 / 多选的对不上记号
// ---------------------------------------------------------------
const SEL = { key: 'tag', type: 'select' };
const MULTI = { key: 'tags', type: 'multi_select' };
eq('单选：命中选项就没有问题', unmatchedTokens(SEL, 's1', OPTS), []);
eq('单选：对不上就是原值本身', unmatchedTokens(SEL, '主设备诊断', OPTS), ['主设备诊断']);
eq('单选：空格子不算问题', unmatchedTokens(SEL, '', OPTS), []);
eq('单选：null 不算问题', unmatchedTokens(SEL, null, OPTS), []);
eq('单选：首尾空格先 trim 再比', unmatchedTokens(SEL, '  已完成 ', OPTS), []);
eq('多选：全部命中', unmatchedTokens(MULTI, 's1,s2', OPTS), []);
eq('多选：挑出没命中的', unmatchedTokens(MULTI, 's1,测试,主设备诊断', OPTS), ['测试', '主设备诊断']);
eq('多选：数组形状也认', unmatchedTokens(MULTI, ['s1', '测试'], OPTS), ['测试']);
eq('多选：同一个值出现两次只报一次', unmatchedTokens(MULTI, '测试,测试', OPTS), ['测试']);
eq('多选：顿号 / 分号都算分隔符', unmatchedTokens(MULTI, '测试、甲；乙', OPTS), ['测试', '甲', '乙']);
eq('文本列没有「选项」概念', unmatchedTokens({ key: 't', type: 'text' }, '随便写', OPTS), []);
eq('日期列也不在这一层判断', unmatchedTokens({ key: 'd', type: 'date' }, '2026-13-99', OPTS), []);
eq('选项表为空的单选列：有值就算对不上', unmatchedTokens(SEL, '未分类', []), ['未分类']);

// ---------------------------------------------------------------
// 3) 一列里出现过哪些值（面板拿它来自动补选项）
// ---------------------------------------------------------------
const rows = [
  { values: { tag: '主设备诊断' } },
  { values: { tag: '主设备诊断' } },
  { values: { tag: '未分类' } },
  { values: { tag: '' } },
  { values: {} },
  { values: { tag: '  测试  ' } },
];
eq('按次数从多到少，空值不计', columnValueStats(rows, SEL), [
  { value: '主设备诊断', count: 2 },
  { value: '测试', count: 1 },
  { value: '未分类', count: 1 },
]);
eq('非选项类字段返回空数组', columnValueStats(rows, { key: 'tag', type: 'text' }), []);
eq('没有 key 的字段返回空数组', columnValueStats(rows, { type: 'select' }), []);

const multiRows = [
  { values: { tags: '甲,乙' } },
  { values: { tags: ['乙', '丙'] } },
  { values: { tags: '' } },
];
eq('多选列拆成单个记号再计数', columnValueStats(multiRows, MULTI), [
  { value: '乙', count: 2 },
  { value: '丙', count: 1 },
  { value: '甲', count: 1 },
]);

// ---------------------------------------------------------------
// 4) 只挑出「不在选项里」的那些
// ---------------------------------------------------------------
eq('已有的选项不算待补', unmatchedColumnValues(rows, SEL, OPTS).map(item => item.value), ['主设备诊断', '测试', '未分类']);
eq('补上一半之后就只剩另一半', unmatchedColumnValues(rows, SEL, [
  ...OPTS, { value: '主设备诊断', label: '主设备诊断' },
]).map(item => item.value), ['测试', '未分类']);

// ---------------------------------------------------------------
// 5) 把值补成选项：value 必须等于文字本身
// ---------------------------------------------------------------
const made = optionsFromValues(['主设备诊断', '未分类'], OPTS, ['#111111', '#222222']);
eq('原有选项原样保留在前面', made.slice(0, 2).map(o => o.value), ['s1', 's2']);
eq('补出来的 value 就是文字本身', made.slice(2).map(o => o.value), ['主设备诊断', '未分类']);
eq('label 与 value 一致', made.slice(2).map(o => o.label), ['主设备诊断', '未分类']);
check('颜色按调色板轮着用', made[2].color === '#111111' && made[3].color === '#222222', JSON.stringify(made.map(o => o.color)));

const dup = optionsFromValues(['已完成', '测试', '测试'], OPTS);
eq('已有同名选项（按 label）不重复加', dup.map(o => o.label), ['已完成', '待整理', '测试']);
eq('同一批里重复的值只加一次', optionsFromValues(['甲', '甲'], []).length, 1);
eq('空白值不加', optionsFromValues(['', '   '], []).length, 0);
check('补出来的选项能被自己命中',
  Boolean(matchOption(optionsFromValues(['未分类'], []), '未分类')),
  '建完选项值还匹配不上 = 格子上永远挂着红角标');

if (failures.length) {
  console.error(`\n✗ fieldCheck: ${passed} passed, ${failures.length} failed`);
  failures.forEach(item => console.error(`  - ${item}`));
  process.exit(1);
}
console.log(`✓ fieldCheck: ${passed} passed`);
