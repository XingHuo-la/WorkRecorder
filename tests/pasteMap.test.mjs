// 跨表 / 同表粘贴的落点决策。
//
// 这一组断言盯的是「值有没有写进对的列」——真实事故不是崩溃，而是**悄悄错位**：
// A 表第 2 列是「处理方」、B 表第 2 列是「时间」，按下标粘就把处理方写进了日期列。
import assert from 'node:assert/strict';
import { adaptClipValue, resolveBlockTargets, resolveRowTargets } from '../src/pasteMap.js';

const results = [];
const test = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error?.message || String(error) });
  }
};

const field = (key, label, type) => ({ key, label, type });

// ---------- adaptClipValue：类型兜底 ----------
test('同类型原样克隆（不共享引用）', () => {
  const source = ['a', 'b'];
  const out = adaptClipValue(field('t', '标签', 'multi_select'), 'multi_select', source);
  assert.deepEqual(out, ['a', 'b']);
  assert.notEqual(out, source);
});

test('多选 → 文本：用顿号拼', () => {
  assert.equal(adaptClipValue(field('t', '说明', 'text'), 'multi_select', ['甲', '乙']), '甲、乙');
});

test('附件数组 → 文本：取 name', () => {
  const value = [{ name: '图纸.png', path: '/a/b.png' }, { path: '/a/c.png' }];
  assert.equal(adaptClipValue(field('t', '说明', 'text'), 'attachment', value), '图纸.png、/a/c.png');
});

test('单选 → 多选：包成单元素数组', () => {
  assert.deepEqual(adaptClipValue(field('t', '标签', 'multi_select'), 'select', '甲'), ['甲']);
});

test('多选 → 单选：取第一个', () => {
  assert.equal(adaptClipValue(field('t', '状态', 'select'), 'multi_select', ['甲', '乙']), '甲');
});

test('日期 → 文本：原样保留字符串', () => {
  assert.equal(adaptClipValue(field('t', '说明', 'text'), 'date', '2026-11-19'), '2026-11-19');
});

test('文本 → 数字：吃不下，返回 null', () => {
  assert.equal(adaptClipValue(field('n', '数量', 'number'), 'text', '三个'), null);
});

test('图片粘进数字列：吃不下', () => {
  assert.equal(adaptClipValue(field('n', '数量', 'number'), 'attachment', [{ path: '/a.png' }]), null);
});

// ---------- 同表：按位置（Excel 语义） ----------
const tableA = [
  field('text', '内容', 'text'),
  field('status', '状态', 'select'),
  field('owner', '处理方', 'select'),
];
const tableB = [
  field('note', '说明', 'text'),
  field('when', '时间', 'date'),
  field('owner', '处理方', 'select'),
  field('other', '备注', 'text'),
];

test('同表内按位置落列', () => {
  const { targets, skipped } = resolveBlockTargets({
    cols: tableA,
    anchorCol: 0,
    sameTable: true,
    items: [
      { dr: 0, dc: 0, fieldKey: 'text', fieldLabel: '内容', fieldType: 'text', value: '甲' },
      { dr: 0, dc: 1, fieldKey: 'status', fieldLabel: '状态', fieldType: 'select', value: 'doing' },
    ],
  });
  assert.equal(skipped.length, 0);
  assert.deepEqual(targets.map(item => item.field.key), ['text', 'status']);
  assert.deepEqual(targets.map(item => item.value), ['甲', 'doing']);
});

test('同表内类型不一致就跳过，并报出目标列名', () => {
  const { targets, skipped } = resolveBlockTargets({
    cols: tableA,
    anchorCol: 0,
    sameTable: true,
    items: [{ dr: 0, dc: 1, fieldKey: 'status', fieldLabel: '状态', fieldType: 'text', value: 'x' }],
  });
  assert.equal(targets.length, 0);
  assert.deepEqual(skipped.map(item => item.label), ['状态']);
});

// ---------- 跨表：列名优先 ----------
test('跨表按列名对位，而不是按下标', () => {
  // 从 A 表复制「状态 + 处理方」，粘到 B 表的第 0 列：
  // 按下标会写成「说明=doing、时间=班组甲」，按列名应该落到「处理方」。
  const { targets, byName } = resolveBlockTargets({
    cols: tableB,
    anchorCol: 0,
    sameTable: false,
    items: [
      { dr: 0, dc: 0, fieldKey: 'status', fieldLabel: '状态', fieldType: 'select', value: 'doing' },
      { dr: 0, dc: 1, fieldKey: 'owner', fieldLabel: '处理方', fieldType: 'select', value: '班组甲' },
    ],
  });
  const owner = targets.find(item => item.field.key === 'owner');
  assert.equal(owner?.value, '班组甲');
  // 「状态」在 B 表里没有同名列 → 靠类型兜底落到某个 select 列，绝不能写进日期列
  const status = targets.find(item => item.value === 'doing');
  assert.notEqual(status?.field.key, 'when');
  assert.equal(byName, 1);
});

test('跨表：同名列优先于同位置列', () => {
  const { targets } = resolveBlockTargets({
    cols: tableB,
    anchorCol: 0,
    sameTable: false,
    items: [{ dr: 0, dc: 0, fieldKey: 'status', fieldLabel: '处理方', fieldType: 'select', value: '班组乙' }],
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].field.key, 'owner');
  assert.equal(targets[0].by, 'label');
});

test('跨表：列名对不上时退到同位置的兼容列', () => {
  const { targets } = resolveBlockTargets({
    cols: tableB,
    anchorCol: 3,
    sameTable: false,
    items: [{ dr: 0, dc: 0, fieldKey: 'zzz', fieldLabel: '不存在的列', fieldType: 'text', value: '随手记' }],
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].field.key, 'other');
  assert.equal(targets[0].by, 'position');
});

test('跨表：两列同类型时不写到同一列', () => {
  const { targets } = resolveBlockTargets({
    cols: tableB,
    anchorCol: 0,
    sameTable: false,
    items: [
      { dr: 0, dc: 0, fieldKey: 'x1', fieldLabel: '甲', fieldType: 'text', value: '一' },
      { dr: 0, dc: 1, fieldKey: 'x2', fieldLabel: '乙', fieldType: 'text', value: '二' },
    ],
  });
  const keys = targets.map(item => item.field.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('跨表：目标表一个能接的列都没有 → 全部跳过', () => {
  const { targets, skipped } = resolveBlockTargets({
    cols: [field('n', '数量', 'number'), field('d', '时间', 'date')],
    anchorCol: 0,
    sameTable: false,
    items: [{ dr: 0, dc: 0, fieldKey: 'text', fieldLabel: '内容', fieldType: 'text', value: '一段文字' }],
  });
  assert.equal(targets.length, 0);
  assert.deepEqual(skipped.map(item => item.label), ['内容']);
});

// ---------- 整行粘贴 ----------
test('整行：key 命中就不用列名', () => {
  const { targets } = resolveRowTargets({
    fields: tableB,
    values: { owner: '班组甲', note: '说明' },
    labels: { 处理方: '班组甲', 说明: '说明' },
    types: { owner: 'select', note: 'text' },
    crossTable: true,
  });
  assert.equal(targets.find(item => item.field.key === 'note')?.value, '说明');
});

test('整行：跨表 key 对不上时按列名找', () => {
  const { targets, skipped } = resolveRowTargets({
    fields: tableB,
    values: { status: 'doing', owner_person: '班组甲' },
    labels: { 状态: 'doing', 处理方: '班组甲' },
    types: { status: 'select', owner_person: 'select' },
    crossTable: true,
  });
  assert.equal(targets.find(item => item.field.key === 'owner')?.value, '班组甲');
  assert.ok(skipped.includes('时间'));
});

test('整行：同表不按列名兜底（避免把别的表的值串进来）', () => {
  const { targets } = resolveRowTargets({
    fields: tableB,
    values: { note: '只有这一列' },
    labels: { 处理方: '不该被用' },
    crossTable: false,
  });
  assert.deepEqual(targets.map(item => item.field.key), ['note']);
});

test('整行：类型吃不下的列跳过', () => {
  const { targets, skipped } = resolveRowTargets({
    fields: [field('n', '数量', 'number')],
    values: { n: '不是数字' },
    labels: null,
    types: { n: 'text' },
    crossTable: false,
  });
  assert.equal(targets.length, 0);
  assert.deepEqual(skipped, ['数量']);
});

// ---------- 汇总 ----------
let failed = 0;
for (const item of results) {
  if (item.ok) {
    console.log(`  ok   ${item.name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${item.name} → ${item.error}`);
  }
}
console.log(`\n通过 ${results.length - failed} · 失败 ${failed}`);
if (failed) process.exit(1);
