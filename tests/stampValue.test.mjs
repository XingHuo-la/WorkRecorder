// stampValue.js 的形状与单调性断言。
//
// 这一层被三件事依赖，任何一条坏了都不是「显示不好看」而是数据出错：
//   ① 唯一索引建在 record.created_at 上 —— 撞一个就是 INSERT 失败；
//   ② 字典序 = 时间序 —— 位数不齐就会出现「10 点排在 9 点前面」；
//   ③ 批量导入靠 +1μs 造时间 —— 不单调就等于排序乱掉。

import {
  STAMP_LENGTH,
  isMicroStamp,
  microStampOf,
  bumpStamp,
  nextStamps,
  currentStamp,
  stampBaseAfter,
  __resetStampWatermark,
} from '../src/stampValue.js';

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

// 固定一个时刻：2026-11-18 16:30:22.123
const AT = new Date(2026, 10, 18, 16, 30, 22, 123);

// ---- 1. 形状 ----
{
  eq('长度是 26', STAMP_LENGTH, 26);
  ok('生成的是规范形状', isMicroStamp(microStampOf(AT)));
  eq('定长', microStampOf(AT).length, 26);
  ok('秒级旧值不认', !isMicroStamp('2026-11-18 16:30:22'));
  ok('空值不认', !isMicroStamp(''));
  ok('7 位小数不认', !isMicroStamp('2026-11-18 16:30:22.1234567'));
  ok('5 位小数不认', !isMicroStamp('2026-11-18 16:30:22.12345'));
  ok('null 不认', !isMicroStamp(null));
}

// ---- 2. 毫秒 → 6 位小数 ----
{
  eq('毫秒补齐', microStampOf(AT), '2026-11-18 16:30:22.123000');
  eq('毫秒为 0', microStampOf(new Date(2026, 10, 18, 16, 30, 22, 0)), '2026-11-18 16:30:22.000000');
  eq('毫秒为 7', microStampOf(new Date(2026, 10, 18, 16, 30, 22, 7)), '2026-11-18 16:30:22.007000');
  eq('月日补零', microStampOf(new Date(2026, 0, 5, 9, 3, 4, 9)), '2026-01-05 09:03:04.009000');
}

// ---- 3. 序号偏移 ----
{
  eq('+1μs', microStampOf(AT, 1), '2026-11-18 16:30:22.123001');
  eq('+999μs 落在同一毫秒', microStampOf(AT, 999), '2026-11-18 16:30:22.123999');
  eq('+1000μs 进到下一毫秒', microStampOf(AT, 1000), '2026-11-18 16:30:22.124000');
  eq('+2000μs', microStampOf(AT, 2000), '2026-11-18 16:30:22.125000');
  // 从 .123 起再走 877ms 才到 1 秒整
  eq('+1s 进位到下一秒', microStampOf(AT, 877000), '2026-11-18 16:30:23.000000');
  eq('负数偏移当 0', microStampOf(AT, -5), '2026-11-18 16:30:22.123000');
}

// ---- 4. 递增 ----
{
  const base = '2026-11-18 16:30:22.123456';
  eq('+1', bumpStamp(base, 1), '2026-11-18 16:30:22.123457');
  eq('+0 原样', bumpStamp(base, 0), base);
  eq('默认 +1', bumpStamp(base), '2026-11-18 16:30:22.123457');
  eq('跨秒进位', bumpStamp('2026-11-18 16:30:22.999999', 1), '2026-11-18 16:30:23.000000');
  eq('跨分进位', bumpStamp('2026-11-18 16:30:59.999999', 1), '2026-11-18 16:31:00.000000');
  eq('跨日进位', bumpStamp('2026-11-18 23:59:59.999999', 1), '2026-11-19 00:00:00.000000');
  eq('跨月末进位', bumpStamp('2026-11-30 23:59:59.999999', 1), '2026-12-01 00:00:00.000000');
  eq('跨年末进位', bumpStamp('2026-12-31 23:59:59.999999', 1), '2027-01-01 00:00:00.000000');
  eq('大跨度进位', bumpStamp('2026-11-18 16:30:22.000000', 2_500_000), '2026-11-18 16:30:24.500000');
  // 非规范值原样返回：宁可不动，也不要把例外值改成看起来正常的假时间
  eq('秒级值不动', bumpStamp('2026-11-18 16:30:22', 1), '2026-11-18 16:30:22');
  eq('空值不动', bumpStamp('', 1), '');
  eq('乱码不动', bumpStamp('abc', 1), 'abc');
}

// ---- 5. 批量取一串 ----
{
  const list = nextStamps('2026-11-18 16:30:22.999998', 4);
  eq('数量对', list.length, 4);
  eq('第一条是起点', list[0], '2026-11-18 16:30:22.999998');
  eq('第二条', list[1], '2026-11-18 16:30:22.999999');
  eq('跨秒', list[2], '2026-11-18 16:30:23.000000');
  eq('跨秒后继续', list[3], '2026-11-18 16:30:23.000001');
  ok(
    '严格递增无重复',
    list.every((item, i) => i === 0 || item > list[i - 1]) && new Set(list).size === list.length
  );
  eq('count=0 给空数组', nextStamps('2026-11-18 16:30:22.123000', 0).length, 0);
  eq('非法起点给空数组', nextStamps('2026-11-18', 3).length, 0);
  // 2000 行（导入上限）走完只吃掉 2 毫秒
  const bulk = nextStamps('2026-11-18 16:30:22.123000', 2000);
  eq('2000 行最后一条', bulk[1999], '2026-11-18 16:30:22.124999');
}

// ---- 6. 进程内单调水位 ----
{
  __resetStampWatermark();
  const first = currentStamp(AT);
  const second = currentStamp(AT);
  const third = currentStamp(AT);
  eq('第一次就是当前时刻', first, '2026-11-18 16:30:22.123000');
  eq('同一毫秒第二次 +1', second, '2026-11-18 16:30:22.123001');
  eq('同一毫秒第三次 +2', third, '2026-11-18 16:30:22.123002');
  ok('三次互不相同', new Set([first, second, third]).size === 3);

  // 时钟往回走（用户改了系统时间 / 夏令时）时不能倒退
  const back = currentStamp(new Date(2026, 10, 18, 16, 0, 0, 0));
  ok('时钟倒退也不倒退值', back > third, `back=${back} third=${third}`);

  // 时钟前进则跟上真实时间
  const forward = currentStamp(new Date(2026, 10, 18, 17, 0, 0, 500));
  eq('时钟前进跟真实时间', forward, '2026-11-18 17:00:00.500000');
}

// ---- 7. 起点必须越过库里已有的最大值 ----
{
  __resetStampWatermark();
  const plain = stampBaseAfter('', AT);
  eq('空库用当前时刻', plain, '2026-11-18 16:30:22.123000');

  __resetStampWatermark();
  const ahead = stampBaseAfter('2026-11-18 16:30:22.999999', AT);
  eq('库里的值在未来 → 接在它后面', ahead, '2026-11-18 16:30:23.000000');

  __resetStampWatermark();
  const behind = stampBaseAfter('2020-01-01 00:00:00.000000', AT);
  eq('库里的值在过去 → 用当前时刻', behind, '2026-11-18 16:30:22.123000');

  __resetStampWatermark();
  const garbage = stampBaseAfter('not-a-stamp', AT);
  eq('库里是脏值 → 忽略它', garbage, '2026-11-18 16:30:22.123000');
}

// ---- 8. 字典序 = 时间序 ----
{
  const samples = [
    '2026-01-09 09:00:00.000000',
    '2026-01-09 10:00:00.000000',
    '2026-01-10 09:00:00.000000',
    '2026-02-01 00:00:00.000000',
    '2026-11-18 16:30:22.123456',
    '2026-11-18 16:30:22.123457',
  ];
  const sorted = [...samples].sort();
  ok('字符串排序等于时间排序', sorted.join('|') === samples.join('|'), sorted.join('|'));
}

console.log(`\nstampValue: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
