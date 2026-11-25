// 日期值的精度与格式化 —— 全应用唯一一份。
//
// 精度不另存标记，由字符串形状自证：
//   2026-11-18            → day      只到日
//   2026-11-18 16:30      → minute   到分
//   2026-11-18 16:30:22   → second   到秒
//
// 为什么能不存标记：库里这一列本来就是 TEXT（预置表拆成 happened_date + happened_time
// 两个 TEXT 列也一样，秒就在 happened_time 里，读的时候拼回去），
// 所以「同一列里每格精度不同」在存储层今天就已经成立，不需要迁移、不需要加列。
//
// 反过来说，旧版把解析写死成「只认到分」（datePicker 的 parseValue 正则 + formatValue），
// 等于每次在选择器里点一下别的日子就把秒静默截掉 —— 库里已经有 42 条 HH:MM:SS 的值在等着被吃掉。
// 这一层存在的意义就是让「读 → 算 → 写」全程不丢精度。

export const PRECISION_LEVELS = ['day', 'minute', 'second'];
export const PRECISION_LABELS = { day: '日', minute: '分', second: '秒' };

// 允许 1~2 位的月/日/时，是为了兜住手工粘进来的 `2026-1-5 9:30` 这类值。
const FULL = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export function pad2(value) {
  const num = Math.trunc(Math.abs(Number(value) || 0));
  return String(num).padStart(2, '0');
}

export function normalizePrecision(value, fallback = 'minute') {
  if (PRECISION_LEVELS.includes(value)) return value;
  return PRECISION_LEVELS.includes(fallback) ? fallback : 'minute';
}

// 从值本身读精度；空值 / 认不出来时退回列默认。
export function precisionOf(value, fallback = 'minute') {
  const raw = String(value ?? '').trim();
  const match = FULL.exec(raw);
  if (!match) return normalizePrecision(fallback);
  if (match[6] != null) return 'second';
  if (match[4] != null) return 'minute';
  return 'day';
}

// 统一解析。认不出来时 hasValue=false，但 precision 仍然给一个（列默认），
// 选择器要用它决定初始显示哪几档。
export function parseDateValue(value, fallback = 'minute') {
  const raw = String(value ?? '').trim();
  const precision = precisionOf(raw, fallback);
  const match = FULL.exec(raw);
  if (!match) {
    return { hasValue: false, precision, year: null, month: null, day: null, hour: 0, minute: 0, second: 0 };
  }
  return {
    hasValue: true,
    precision,
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: match[4] != null ? Number(match[4]) : 0,
    minute: match[5] != null ? Number(match[5]) : 0,
    second: match[6] != null ? Number(match[6]) : 0,
  };
}

// 按精度拼回字符串。day 档刻意不带时间 —— 这是「这一格只到日」的唯一表达方式。
export function formatDateValue(parts, precision) {
  const level = normalizePrecision(precision);
  const base = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  if (level === 'day') return base;
  const hhmm = `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  if (level === 'minute') return `${base} ${hhmm}`;
  return `${base} ${hhmm}:${pad2(parts.second)}`;
}

// 表格单元格的短形态（完整值永远留在 title 里）：
//   11-18 / 11-18 10时 / 11-18 16:30 / 11-18 16:30:22
// 「10时」这一档是刻意的：分秒都是 0 时，写 10:00 只是噪音，
// 而 10时 一眼就知道「这一个只知道整点」。
export function shortDateText(value) {
  const parsed = parseDateValue(value);
  if (!parsed.hasValue) return String(value ?? '').trim();
  const datePart = `${pad2(parsed.month)}-${pad2(parsed.day)}`;
  if (parsed.precision === 'day') return datePart;
  if (parsed.precision === 'minute' && parsed.minute === 0) return `${datePart} ${pad2(parsed.hour)}时`;
  const hhmm = `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  return parsed.precision === 'second' ? `${datePart} ${hhmm}:${pad2(parsed.second)}` : `${datePart} ${hhmm}`;
}

// 字段配置里「这一列的默认精度」：新键 precision 优先，
// 老键 dateOnly=true 读成 day（不改老数据，只做兼容读）。
export function fieldPrecisionOf(field) {
  let config = {};
  try {
    const parsed = field?.options ? JSON.parse(field.options) : null;
    if (parsed && typeof parsed === 'object') config = parsed;
  } catch (error) {
    config = {};
  }
  if (config.precision === 'day' || config.precision === 'minute' || config.precision === 'second') {
    return config.precision;
  }
  return config.dateOnly === true ? 'day' : 'minute';
}

// 「只知道整点」→ 10:00。用于日历视图新建行、以及选择器把精度切到分时补默认值。
export function dayValueForPrecision(field, dayKey) {
  const precision = fieldPrecisionOf(field);
  if (precision === 'day') return dayKey;
  return precision === 'second' ? `${dayKey} 00:00:00` : `${dayKey} 00:00`;
}
