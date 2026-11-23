// clipboardImport.js 的纯函数断言。导入写库的部分靠探针（真 SQL 走一遍假 adapter），
// 这里只钉两件最容易静默出错的事：
//   ① 值转换：类型猜对了但值没转，等于建了一列「看起来是日期」的文本；
//   ② 新建列的配置：单选列没选项 = 给用户一个空下拉。

import { coerceImportValue, optionsForColumn } from '../src/clipboardImport.js';

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

const cell = (text, images = []) => ({ text, images });
const field = (type, options = '') => ({ id: 1, key: 'k', label: 'X', type, options });
const noImages = new Map();

console.log('\n[1] 值转换');

eq('文本去掉首尾空白', coerceImportValue(field('text'), cell('  含 空格  '), noImages), '含 空格');
eq('空文本不写', coerceImportValue(field('text'), cell(''), noImages), undefined);
eq('数字去千分位', coerceImportValue(field('number'), cell('1,234'), noImages), 1234);
eq('数字带货币符号', coerceImportValue(field('number'), cell('¥88'), noImages), 88);
eq('不像数字就存原文', coerceImportValue(field('number'), cell('约 3 元'), noImages), '约 3 元');
eq('日期归一', coerceImportValue(field('date'), cell('2026/11/19'), noImages), '2026-11-19');
eq('日期认不出就存原文', coerceImportValue(field('date'), cell('下周三'), noImages), '下周三');
eq('复选：是', coerceImportValue(field('checkbox'), cell('是'), noImages), true);
eq('复选：否', coerceImportValue(field('checkbox'), cell('否'), noImages), false);
eq('多选按分隔符切开', coerceImportValue(field('multi_select'), cell('甲、乙,丙'), noImages), ['甲', '乙', '丙']);
eq('单选认标签', coerceImportValue(
  field('select', JSON.stringify({ source: 'custom', options: [{ value: 'doing', label: '进行中' }] })),
  cell('进行中'), noImages
), 'doing');
eq('单选不认识的存原值', coerceImportValue(field('select', ''), cell('随便'), noImages), '随便');

const images = new Map([['a.png', { path: '/tmp/a.png', name: 'a' }]]);
eq('附件列收图', coerceImportValue(field('attachment'), cell('', [{ src: 'a.png' }]), images),
  [{ path: '/tmp/a.png', name: 'a' }]);
eq('附件列没有图 → null（文本塞不进去）', coerceImportValue(field('attachment'), cell('说明'), images), null);
eq('附件列图没下下来 → null', coerceImportValue(field('attachment'), cell('', [{ src: 'b.png' }]), images), null);

console.log('\n[2] 新建列的配置');

eq('单选列把出现过的值变成选项', optionsForColumn('select', [cell('甲'), cell('乙'), cell('甲')]), {
  source: 'custom',
  options: [{ value: '甲', label: '甲' }, { value: '乙', label: '乙' }],
});
eq('多选列按分隔符拆', optionsForColumn('multi_select', [cell('甲、乙'), cell('乙')]), {
  source: 'custom',
  options: [{ value: '甲', label: '甲' }, { value: '乙', label: '乙' }],
});
eq('空单选列不给选项', optionsForColumn('select', [cell('')]), null);
eq('选项最多 60 个', optionsForColumn('select', Array.from({ length: 80 }, (_, i) => cell(`v${i}`))).options.length, 60);
eq('整列没有时分 → 只到日', optionsForColumn('date', [cell('2026-11-19'), cell('2026/11/20')]), { dateOnly: true });
eq('有一个带时分 → 不设 dateOnly', optionsForColumn('date', [cell('2026-11-19 10:30'), cell('2026/11/20')]), null);
eq('文本列不加配置', optionsForColumn('text', [cell('a')]), null);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
