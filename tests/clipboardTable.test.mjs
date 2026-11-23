// clipboardTable.js 的断言脚本。只测纯函数部分（HTML 解析要在浏览器里跑，
// 由 _debug/clipboard-import-probe.html 覆盖）。
//
// 这一层的错误代价很高：类型猜错 → 建出一列全是文本的日期列；
// 表头认错 → 把「时间」当成第一条数据导进去，第一行永远是错的，
// 而用户往往过了几天才发现。所以这些边界都钉死。

import {
  normalizeDateText,
  isNumericText,
  isImagePlaceholder,
  inferColumnType,
  detectHeaderRow,
  trimMatrix,
  matrixFromTSV,
  buildColumnDescriptors,
  parseClipboardPayload,
  cleanColumnName,
} from '../src/clipboardTable.js';

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

// ---------- 1. 日期归一 ----------
console.log('\n[1] 日期归一');

eq('斜杠日期', normalizeDateText('2026/11/19'), '2026-11-19');
eq('短横线 + 时间', normalizeDateText('2026-11-19 14:30'), '2026-11-19 14:30');
eq('带秒的时间截到分', normalizeDateText('2026-11-19 14:30:59'), '2026-11-19 14:30');
eq('中文日期', normalizeDateText('2026年11月19日'), '2026-11-19');
eq('点分隔 + 单位数时间补零', normalizeDateText('2026.11.9 8:05'), '2026-11-09 08:05');
eq('T 分隔（ISO）', normalizeDateText('2026-11-19T09:05'), '2026-11-19 09:05');
eq('零点归成纯日期', normalizeDateText('2026-11-19 00:00'), '2026-11-19');
eq('下午补 12 小时', normalizeDateText('2026/11/19 下午2:30'), '2026-11-19 14:30');
eq('下午 12 点就是 12 点', normalizeDateText('2026/11/19 下午12:00'), '2026-11-19 12:00');
eq('中文时分', normalizeDateText('2026年11月19日 14时30分'), '2026-11-19 14:30');
eq('不认识的日期返回空', normalizeDateText('下周三'), '');
eq('月越界返回空', normalizeDateText('2026-13-01'), '');
eq('美式月日年不做猜测', normalizeDateText('11/19/2026'), '');
eq('纯时间不算日期', normalizeDateText('14:30'), '');

// ---------- 2. 数字判定 ----------
console.log('\n[2] 数字判定');

ok('整数', isNumericText('123'));
ok('千分位', isNumericText('1,234'));
ok('货币符号', isNumericText('¥1,234.50'));
ok('负数', isNumericText('-3.5'));
ok('前导零是编号不是数字', !isNumericText('000123'));
ok('带单位不算', !isNumericText('12px'));
ok('空串不算', !isNumericText(''));

// ---------- 3. 列类型推断 ----------
console.log('\n[3] 列类型推断');

eq('有图就是附件列', inferColumnType([cell('a', [{ src: 'x' }]), cell('b')]), 'attachment');
eq('全是日期', inferColumnType([cell('2026-11-19'), cell('2026/11/20')]), 'date');
eq('全是数字', inferColumnType([cell('1'), cell('1,200')]), 'number');
eq('全是是/否', inferColumnType([cell('是'), cell('否')]), 'checkbox');
eq('混了文字就是文本', inferColumnType([cell('1'), cell('两')]), 'text');
eq('空列是文本', inferColumnType([]), 'text');
eq('图片占位符不算数字', inferColumnType([cell('=DISPIMG("ID_1",1)'), cell('=DISPIMG("ID_2",1)')]), 'text');

// ---------- 4. 表头识别 ----------
console.log('\n[4] 表头识别');

const headLike = [
  [cell('时间'), cell('金额')],
  [cell('2026-11-19'), cell('12')],
  [cell('2026-11-20'), cell('8')],
];
ok('首行文本 + 下面是日期/数字 → 表头', detectHeaderRow(headLike));

const plain = [
  [cell('a'), cell('b')],
  [cell('c'), cell('d')],
];
ok('全文本表格不硬认表头', !detectHeaderRow(plain));
ok('th 标签直接算表头', detectHeaderRow(plain, { hasTh: true }));
ok('加粗算表头', detectHeaderRow(plain, { boldRow0: true }));
ok('单行不认表头', !detectHeaderRow([[cell('时间')]]));
ok('首行有图不认表头', !detectHeaderRow([[cell('', [{ src: 'x' }]), cell('b')], [cell('1'), cell('2')]]));
ok('首行有长句不认表头', !detectHeaderRow([
  [cell('这是一段很长的说明文字，明显超过了二十四个字的门槛，属于数据行'), cell('b')],
  [cell('1'), cell('2')],
]));
ok('首行大半是空的，不认表头', !detectHeaderRow([
  [cell('时间'), cell(''), cell('')],
  [cell('2026-11-19'), cell('1'), cell('2')],
]));

// ---------- 5. 裁边与 TSV 兜底 ----------
console.log('\n[5] 裁边与 TSV 兜底');

eq('裁掉尾部空行空列', trimMatrix([
  [cell('a'), cell('b'), cell('')],
  [cell('c'), cell('d'), cell('')],
  [cell(''), cell(''), cell('')],
]), [
  [cell('a'), cell('b')],
  [cell('c'), cell('d')],
]);
eq('中间空行保留', trimMatrix([
  [cell('a')],
  [cell('')],
  [cell('b')],
]).length, 3);

const tsv = matrixFromTSV('=DISPIMG("ID_abc",1)\t标题\n2026/11/19\t第二行');
eq('DISPIMG 占位符被清空', tsv.rows[0][0].text, '');
eq('占位符计数', tsv.placeholders, 1);
ok('占位符判定', isImagePlaceholder('=DISPIMG("ID_x",1)') && !isImagePlaceholder('正常文字'));

// ---------- 6. 列描述 ----------
console.log('\n[6] 列描述（预览用）');

const desc = buildColumnDescriptors([
  [cell('时间'), cell('截图')],
  [cell('2026-11-19'), cell('', [{ src: 'a.png' }])],
], true);
eq('表头当列名', desc.map(item => item.name), ['时间', '截图']);
eq('类型按数据推断', desc.map(item => item.type), ['date', 'attachment']);
eq('图片格计数', desc[1].imageCount, 1);
eq('无表头时用列号', buildColumnDescriptors([[cell('a')]], false)[0].name, '列1');

// ---------- 7. 整包解析（无 HTML，走 TSV） ----------
console.log('\n[7] 整包解析（TSV 兜底）');

const payload = parseClipboardPayload({
  html: '',
  text: '时间\t内容\n2026/11/19\t第一条\n2026/11/20\t第二条',
});
eq('来源是 tsv', payload.source, 'tsv');
eq('识别为表头', payload.header, true);
eq('列数', payload.cols, 2);
eq('数据行数（不含表头）', payload.dataRows, 2);
eq('名字来自表头', payload.columns.map(item => item.name), ['时间', '内容']);

const empty = parseClipboardPayload({ html: '', text: '' });
eq('空剪贴板无行', empty.rows.length, 0);
eq('空剪贴板来源 none', empty.source, 'none');

eq('列名压缩空白', cleanColumnName('  主  分类 \n'), '主 分类');
eq('列名截断到 40 字', cleanColumnName('x'.repeat(60)).length, 40);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
