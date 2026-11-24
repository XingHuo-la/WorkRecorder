// 关联字段（relation）的纯函数验证。
//
// 这里只测「不碰库、不碰 DOM」的那部分：值归一、配置解析、单元格 HTML、纯文本。
// 库的部分（候选列表 / 被引用 / 删除清引用）在 presetCustom.test.mjs 与探针里。
//
// 重点盯三类错：
//   ① 单选存成 3、多选存成 [3] —— 同一个字段改一次类型就读不回来；
//   ② 「还没查到标题」被渲染成「已删除」—— 首帧满屏灰块；
//   ③ 已删除的 id 直接消失 —— 用户以为数据被吃了。

import { relationConfig, normalizeRelationIds, renderRelationCell, relationText } from '../src/relationField.js';
import { serializeOptions } from '../src/sheetStore.js';

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

// ---------------------------------------------------------------
// 1) 配置解析
// ---------------------------------------------------------------
eq('没有 options → 目标 0 / 单选', relationConfig({ key: 'f1', type: 'relation' }), { targetSheetId: 0, multiple: false });
eq('没有字段 → 安全默认值', relationConfig(null), { targetSheetId: 0, multiple: false });
eq(
  '字符串 options 也能读',
  relationConfig({ options: '{"targetSheetId":7,"multiple":true}' }),
  { targetSheetId: 7, multiple: true }
);
eq(
  '对象 options 也能读',
  relationConfig({ options: { targetSheetId: '9', multiple: 'yes' } }),
  { targetSheetId: 9, multiple: false } // multiple 只认真正的 true
);
eq('坏 JSON 不抛错', relationConfig({ options: '{oops' }), { targetSheetId: 0, multiple: false });
eq('目标表是负数 → 当作没配', relationConfig({ options: '{"targetSheetId":-3}' }).targetSheetId, 0);

// ---------------------------------------------------------------
// 2) 值归一：单选也存数组
// ---------------------------------------------------------------
eq('数字', normalizeRelationIds(3), [3]);
eq('字符串数字', normalizeRelationIds('3'), [3]);
eq('数组', normalizeRelationIds([3, 5]), [3, 5]);
eq('去重保序', normalizeRelationIds([5, 3, 5]), [5, 3]);
eq('字符串数组', normalizeRelationIds(['5', '3']), [5, 3]);
eq('小数截断', normalizeRelationIds(3.9), [3]);
eq('0 丢弃', normalizeRelationIds([0, 3]), [3]);
eq('负数丢弃', normalizeRelationIds([-2, 3]), [3]);
eq('null 丢弃', normalizeRelationIds([null, 3]), [3]);
eq('字符串 null 丢弃', normalizeRelationIds(['null', 3]), [3]);
eq('空串丢弃', normalizeRelationIds(['', 3]), [3]);
eq('undefined → 空数组', normalizeRelationIds(undefined), []);
eq('null → 空数组', normalizeRelationIds(null), []);
eq('空对象 → 空数组', normalizeRelationIds({}), []);

// ---------------------------------------------------------------
// 3) 单元格渲染
// ---------------------------------------------------------------
const titles = new Map([
  ['12', { title: '2 号机组', deleted: false }],
  ['13', { title: '3 号机组', deleted: false }],
  ['14', { title: '4 号机组', deleted: false }],
  ['99', { title: '#99', deleted: true }],
]);

const emptyHtml = renderRelationCell([], { placeholder: '—' });
check('空值走占位符', emptyHtml.includes('ft-cell-empty') && emptyHtml.includes('—'), emptyHtml);
check('空值占位符可自定义', renderRelationCell(null, { placeholder: '点击填写' }).includes('点击填写'));

const one = renderRelationCell([12], { relationTitles: titles });
check('单个是标题不是 id', one.includes('2 号机组'), one);
check('标题带 data-rel-open', one.includes('data-rel-open="12"'), one);
check('正常的胶囊不带 is-gone', !one.includes('is-gone'), one);

const two = renderRelationCell([12, 13], { relationTitles: titles });
check('两个都在', two.includes('2 号机组') && two.includes('3 号机组'), two);
check('两个不出现 +N', !two.includes('ft-rel-more'), two);

// 三个 → 只直出 2 个 + 「+1」（第三个标题放进 title 提示里）
const three = renderRelationCell([12, 13, 14], { relationTitles: titles });
check('第三个收进 +1', three.includes('ft-rel-more') && three.includes('+1'), three);
check('第三个标题在 title 里', three.includes('title="14"'), three);
check('第三个不画成胶囊', !three.includes('>4 号机组<'), three);

// 已删除：写明、可点、划线样式
const gone = renderRelationCell([99], { relationTitles: titles });
check('已删除写明', gone.includes('已删除'), gone);
check('已删除仍可点', gone.includes('data-rel-open="99"'), gone);
check('已删除有 is-gone', gone.includes('is-gone'), gone);

// 还没查到标题：只画 #id，绝不能写「已删除」
const pending = renderRelationCell([12], { relationTitles: new Map() });
check('未加载时画 #12', pending.includes('#12'), pending);
check('未加载时不说已删除', !pending.includes('已删除'), pending);
check('未加载时也不画成正常标题', pending.includes('is-pending'), pending);

// 没传 relationTitles（旧调用方）：同上，退化而不是崩
const noCtx = renderRelationCell([12]);
check('没有 ctx 也不抛错', typeof noCtx === 'string' && noCtx.includes('#12'), noCtx);

// ---------------------------------------------------------------
// 4) 纯文本（复制 / 导出 / 搜索）
// ---------------------------------------------------------------
eq('纯文本用标题', relationText([12, 13], { relationTitles: titles }), '2 号机组、3 号机组');
eq('纯文本里已删除用 #id', relationText([99], { relationTitles: titles }), '#99');
eq('纯文本没标题时用 #id', relationText([77], { relationTitles: titles }), '#77');
eq('纯文本空值', relationText([], { relationTitles: titles }), '');

// ---------------------------------------------------------------
// 5) serializeOptions 必须带上关联的两个开关
//    （丢了的表现：选完目标表、保存后变成指向空表，零报错）
// ---------------------------------------------------------------
const serialized = JSON.parse(serializeOptions({ targetSheetId: 5, multiple: true }));
eq('serializeOptions 保留 targetSheetId', serialized.targetSheetId, 5);
eq('serializeOptions 保留 multiple', serialized.multiple, true);
eq('serializeOptions 不写 0 目标表', 'targetSheetId' in JSON.parse(serializeOptions({ targetSheetId: 0 })), false);
eq('serializeOptions 不写 false 多选', 'multiple' in JSON.parse(serializeOptions({ multiple: false })), false);
eq('serializeOptions 仍然带 source/options', [serialized.source, serialized.options], ['custom', []]);

if (failures.length) {
  console.error(`\n✗ relationField: ${passed} passed, ${failures.length} failed`);
  failures.forEach(item => console.error(`  - ${item}`));
  process.exit(1);
}
console.log(`✓ relationField: ${passed} passed`);
