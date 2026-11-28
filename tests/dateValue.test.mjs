// dateValue.js 的精度语义断言。
//
// 这一层存在的唯一理由：读 → 算 → 写 全程不丢精度。
// 所以最该钉死的是「秒不能被抹掉」这条 —— 旧版 datePicker 只会拼到分，
// 库里 42 条 HH:MM:SS 的值只要在选择器里点一下别的日子就被截成 HH:MM。

import {
  PRECISION_LEVELS,
  MICRO_PRECISION,
  normalizePrecision,
  precisionOf,
  parseDateValue,
  formatDateValue,
  shortDateText,
  fieldPrecisionOf,
  dayValueForPrecision,
} from '../src/dateValue.js';

let pass = 0;
let fail = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    return;
  }
  fail += 1;
  console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
}

const eq = (name, actual, expected) => ok(name, actual === expected, `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`);

// ---- 1. 精度由字符串形状自证 ----
{
  eq('日', precisionOf('2026-11-18'), 'day');
  eq('分', precisionOf('2026-11-18 16:30'), 'minute');
  eq('秒', precisionOf('2026-11-18 16:30:22'), 'second');
  eq('T 分隔也认', precisionOf('2026-11-18T16:30:22'), 'second');
  eq('单数字月日', precisionOf('2026-1-5 9:30'), 'minute');
  eq('首尾空格', precisionOf('  2026-11-18  '), 'day');
  eq('空值退回列默认', precisionOf('', 'second'), 'second');
  eq('脏值退回列默认', precisionOf('明天下午', 'day'), 'day');
  eq('默认档是 minute', precisionOf(''), 'minute');
}

// ---- 2. 解析出来的字段 ----
{
  const parsed = parseDateValue('2026-11-18 16:30:22');
  eq('年', parsed.year, 2026);
  eq('月', parsed.month, 11);
  eq('日', parsed.day, 18);
  eq('时', parsed.hour, 16);
  eq('分', parsed.minute, 30);
  eq('秒', parsed.second, 22);
  eq('有值', parsed.hasValue, true);
  eq('精度', parsed.precision, 'second');

  const dayOnly = parseDateValue('2026-11-18');
  eq('只到日：时归零', dayOnly.hour, 0);
  eq('只到日：精度', dayOnly.precision, 'day');

  const empty = parseDateValue('', 'second');
  eq('空值：hasValue', empty.hasValue, false);
  eq('空值：保留列默认精度', empty.precision, 'second');
}

// ---- 3. 格式化：三位一体，不多写也不少写 ----
{
  const parts = { year: 2026, month: 11, day: 18, hour: 16, minute: 30, second: 22 };
  eq('日', formatDateValue(parts, 'day'), '2026-11-18');
  eq('分', formatDateValue(parts, 'minute'), '2026-11-18 16:30');
  eq('秒', formatDateValue(parts, 'second'), '2026-11-18 16:30:22');
  eq('补零', formatDateValue({ year: 2026, month: 1, day: 5, hour: 9, minute: 3, second: 7 }, 'second'), '2026-01-05 09:03:07');
  eq('未知精度退回分', formatDateValue(parts, 'week'), '2026-11-18 16:30');
}

// ---- 4. 回归：原样进出不能掉精度 ----
{
  ['2026-11-18', '2026-11-18 16:30', '2026-11-18 16:30:22'].forEach(value => {
    const parsed = parseDateValue(value);
    eq(`原样回写 ${value}`, formatDateValue(parsed, parsed.precision), value);
  });
}

// ---- 5. 单元格显示 = 值本身，不加工 ----
// 曾经显示成 11-18（看不到年）、整点写成 10时（多一条要背的规则），两条都废掉了。
{
  eq('只到日', shortDateText('2026-11-18'), '2026-11-18');
  eq('整点不写成「时」', shortDateText('2026-11-18 10:00'), '2026-11-18 10:00');
  eq('到分', shortDateText('2026-11-18 16:30'), '2026-11-18 16:30');
  eq('到秒', shortDateText('2026-11-18 16:30:22'), '2026-11-18 16:30:22');
  eq('年份始终在', shortDateText('2019-03-05 08:00').slice(0, 4), '2019');
  eq('去首尾空格', shortDateText('  2026-11-18  '), '2026-11-18');
  eq('空值原样返回', shortDateText(''), '');
  eq('脏值不吞', shortDateText('待定'), '待定');
}

// ---- 6. 列默认精度：新键优先，老键 dateOnly 兼容 ----
{
  const field = options => ({ key: 'd', type: 'date', options: JSON.stringify(options) });
  eq('新键 day', fieldPrecisionOf(field({ precision: 'day' })), 'day');
  eq('新键 second', fieldPrecisionOf(field({ precision: 'second' })), 'second');
  eq('没配置默认到分', fieldPrecisionOf(field({})), 'minute');
  eq('老键 dateOnly=true → day', fieldPrecisionOf(field({ dateOnly: true })), 'day');
  eq('老键 dateOnly=false → minute', fieldPrecisionOf(field({ dateOnly: false })), 'minute');
  eq('新键压过老键', fieldPrecisionOf(field({ precision: 'second', dateOnly: true })), 'second');
  eq('坏 JSON 不抛', fieldPrecisionOf({ key: 'd', type: 'date', options: '{oops' }), 'minute');
  eq('没有 options', fieldPrecisionOf({ key: 'd', type: 'date' }), 'minute');
}

// ---- 7. 日历里新建一行时补的默认值 ----
{
  const field = precision => ({ key: 'd', type: 'date', options: JSON.stringify({ precision }) });
  eq('只到日', dayValueForPrecision(field('day'), '2026-11-18'), '2026-11-18');
  eq('到分', dayValueForPrecision(field('minute'), '2026-11-18'), '2026-11-18 00:00');
  eq('到秒', dayValueForPrecision(field('second'), '2026-11-18'), '2026-11-18 00:00:00');
}

// ---- 8. 精度常量本身 ----
{
  eq('三档', PRECISION_LEVELS.join(','), 'day,minute,second');
  eq('未知值退回回退档', normalizePrecision('week', 'second'), 'second');
  eq('回退档也未知 → minute', normalizePrecision('week', 'nope'), 'minute');
  eq('已知值原样', normalizePrecision('day', 'minute'), 'day');
}

// ---- 9. 第四档：微秒（系统生成的时间戳，用户不可选）----
//
// 这一档存在的唯一理由：record.created_at 要绝对唯一，靠毫秒 + 序号拼成 26 字符。
// 它必须能被解析/格式化，否则那一列在表格里就是一个谁也不认识的字符串。
{
  const micro = '2026-11-18 16:30:22.123456';
  eq('微秒认得出', precisionOf(micro), 'micro');
  eq('常量对齐', MICRO_PRECISION, 'micro');
  ok('微秒不在用户可选档里', !PRECISION_LEVELS.includes('micro'));
  // 关键：不能被 normalizePrecision 悄悄降成分钟 —— 那等于又丢一次精度
  eq('normalize 不认微秒', normalizePrecision('micro', 'second'), 'second');

  const parsed = parseDateValue(micro);
  eq('解析 hasValue', parsed.hasValue, true);
  eq('解析精度', parsed.precision, 'micro');
  eq('解析秒', parsed.second, 22);
  eq('解析微秒', parsed.micro, 123456);

  eq(
    '格式化回原样',
    formatDateValue({ year: 2026, month: 11, day: 18, hour: 16, minute: 30, second: 22, micro: 123456 }, 'micro'),
    micro
  );
  eq(
    '微秒补零',
    formatDateValue({ year: 2026, month: 1, day: 5, hour: 9, minute: 3, second: 4, micro: 7 }, 'micro'),
    '2026-01-05 09:03:04.000007'
  );
  // 手写小数：3 位按毫秒语义补齐，1 位按十万位
  eq('3 位小数', parseDateValue('2026-11-18 16:30:22.123').micro, 123000);
  eq('1 位小数', parseDateValue('2026-11-18 16:30:22.5').micro, 500000);
  eq('3 位小数精度也是微秒', precisionOf('2026-11-18 16:30:22.123'), 'micro');

  // 没有小数秒的值不能被误判成微秒
  eq('无小数仍是秒', precisionOf('2026-11-18 16:30:22'), 'second');

  // 列配置只给三档：微秒值不看列默认，看值自己
  eq(
    '列默认不会把微秒值降级',
    fieldPrecisionOf({ options: JSON.stringify({ precision: 'minute' }) }),
    'minute'
  );
}

console.log(`\ndateValue: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
