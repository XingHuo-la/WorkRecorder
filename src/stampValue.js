// 26 字符的微秒时间戳 —— 生成、递增、比较，全应用唯一一份。
//
//   YYYY-MM-DD HH:MM:SS.mmmSSS
//   └─── 19 字符 ──┘ └ 7 字符 ┘
//                     毫秒(3) + 同毫秒内序号(3)
//
// ── 为什么是「毫秒 + 序号」而不是真微秒 ──────────────────────────────
// JS 的 Date 只有毫秒（getMilliseconds()，3 位），拿不到物理微秒。真微秒必须去
// Rust 侧取，代价是每个插入点多一次 IPC —— 一次导入 2000 行就是 2000 次。
// 而我们真正需要的只有两件事：**单调递增** 与 **绝对唯一**。
// 毫秒后补 3 位序号，这两件事都满足，且零 IPC 开销。
//
// ── 为什么形状必须与微秒完全一致（26 字符 / 6 位小数）────────────────
// 值的字符串就是它的排序键：唯一索引建在 created_at 上，字符串字典序 = 时间序。
// 等宽才能直接比字符串（`a < b` 不用解析）。将来真接上 Rust 微秒，格式不用动。
//
// ── 为什么必须和 dateValue.js 分开 ────────────────────────────────
// dateValue.js 是「解析任意人写的日期值」—— 宽容、认 1~2 位月日、不保证唯一。
// 这里相反：只产出规范形状、只接受规范形状、并且维护一个进程内的单调水位。
// 混在一起会让「宽容解析」和「严格生成」互相污染。

export const STAMP_LENGTH = 26;
const MICRO_PER_SECOND = 1_000_000;
const MICRO_PER_MILLI = 1000;

// 只认规范形状：定宽 26、固定分隔符、6 位小数。
const SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

const pad2 = value => String(Math.trunc(Math.abs(Number(value) || 0))).padStart(2, '0');

function headOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// 19 字符的秒级段 → Date（用于进位时加秒）。解析失败返回 null。
function parseHead(head) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(head || ''));
  if (!match) return null;
  // 用本地时间构造：stamp 本来就是本地时间语义（nowStamp 一直如此）
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    0
  );
}

/** 是不是一个规范的 26 字符微秒时间戳。 */
export function isMicroStamp(value) {
  return SHAPE.test(String(value ?? ''));
}

// 宽松形状：认用户/外部数据里的各种写法，产出一定规范。月日时分秒都允许 1~2 位。
const LOOSE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,9}))?)?)?$/;

/**
 * 把外部文本尽量变成规范 26 字符时间戳；认不出就返回 null。
 *
 * 用途只有一个：导入时用户指定「哪一列是创建时间」（见 clipboardImport 的
 * `作为创建时间`）。它必须走这条严格出口，原因有两个 ——
 *   ① 这一列有唯一索引，形状不统一就没法比大小，脏值会把整批导入炸掉；
 *   ② 26 字符定宽是「字符串序 = 时间序」的前提，放进来一个 19 字符的值，
 *      它和 26 字符的值比较时行为就是错的（`2026-11-25 10:00:00` > `...10:00:00.5`）。
 *
 * 只认 `YYYY-MM-DD[ HH:MM[:SS[.小数]]]`，**不做自然语言解析**：
 * 「昨天」「11月25日」这类交给 dateValue.js 的宽容解析，那里不保证唯一性。
 */
export function coerceStamp(raw) {
  if (isMicroStamp(raw)) return String(raw);
  const text = String(raw ?? '').trim().replace(/\//g, '-');
  const match = LOOSE.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] == null ? 0 : Number(match[4]);
  const minute = match[5] == null ? 0 : Number(match[5]);
  const second = match[6] == null ? 0 : Number(match[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  // 小数部分：毫秒之后的部分是「序号」，截到 6 位，不足补零
  const frac = String(match[7] ?? '').padEnd(6, '0').slice(0, 6);
  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${frac}`;
}

/**
 * 某个时刻的微秒时间戳。
 * @param {Date} date 时刻（用它的年月日时分秒 + 毫秒）
 * @param {number} offset 在这个毫秒之内再往后推几个微秒（批量导入的递增用）
 */
export function microStampOf(date = new Date(), offset = 0) {
  const micro = date.getMilliseconds() * MICRO_PER_MILLI + Math.max(0, Math.trunc(Number(offset) || 0));
  const carry = Math.floor(micro / MICRO_PER_SECOND);
  const frac = ((micro % MICRO_PER_SECOND) + MICRO_PER_SECOND) % MICRO_PER_SECOND;
  // 进位到秒：序号撑破 999999 时（一个毫秒内超过 1000 条）才发生
  const base = carry ? new Date(date.getTime() + carry * 1000) : date;
  return `${headOf(base)}.${String(frac).padStart(6, '0')}`;
}

/**
 * 把一个微秒时间戳往后推 delta 个微秒。输入不是规范形状时原样返回 ——
 * 宁可不动，也不要把一个例外值改成看起来正常的假时间。
 */
export function bumpStamp(stamp, delta = 1) {
  const raw = String(stamp ?? '');
  if (!isMicroStamp(raw)) return raw;
  const step = Math.trunc(Number(delta) || 0);
  if (!step) return raw;
  const head = raw.slice(0, 19);
  const frac = Number(raw.slice(20)) + step;
  const carry = Math.floor(frac / MICRO_PER_SECOND);
  const rest = ((frac % MICRO_PER_SECOND) + MICRO_PER_SECOND) % MICRO_PER_SECOND;
  if (!carry) return `${head}.${String(rest).padStart(6, '0')}`;
  const at = parseHead(head);
  if (!at) return raw;
  at.setSeconds(at.getSeconds() + carry);
  return `${headOf(at)}.${String(rest).padStart(6, '0')}`;
}

/**
 * 从 base 起连续取 count 个时间戳（含 base）。
 * 批量导入 2000 行只需要一次 Date.now()，不是 2000 次。
 */
export function nextStamps(base, count) {
  const start = String(base ?? '');
  if (!isMicroStamp(start)) return [];
  const total = Math.max(0, Math.trunc(Number(count) || 0));
  const list = new Array(total);
  for (let i = 0; i < total; i += 1) list[i] = bumpStamp(start, i);
  return list;
}

// ==========================================
// 进程内的单调水位
// ==========================================
//
// 「唯一索引」把 created_at 从「展示字段」变成了「硬约束」：
// 同一毫秒里插两行，microStampOf 会给出同一个串，INSERT 直接失败。
//
// 所以所有「现在几点」都必须走这里：记住上一次发出的值，新的必须严格更大。
// 水位只在本进程内有效 —— Tauri 是单实例单窗口写库，没有第二个写者。
// （重新启动后 Date.now() 自然已经往前走，不需要持久化。）
let lastIssued = '';

/** 当前时刻的微秒时间戳，保证本进程内严格递增且唯一。 */
export function currentStamp(date = new Date()) {
  const now = microStampOf(date);
  // 字符串比较就是时间比较（等宽规范形状）
  const next = now > lastIssued ? now : bumpStamp(lastIssued, 1);
  lastIssued = next;
  return next;
}

/**
 * 从「现在」或「库里现有的最大值 + 1μs」取一个起点 —— 取更晚的那个。
 *
 * 为什么需要它：导入 2000 行会占用 [now, now+2000μs] 这段未来时间。
 * 如果库里的时钟已经跑到这段区间里（上一次导入刚写完），直接拿 now 会和
 * 已有的值相撞，唯一索引报错。所以起点必须越过现有最大值。
 *
 * @param {string} existingMax 库里 MAX(created_at)
 */
export function stampBaseAfter(existingMax, date = new Date()) {
  const now = currentStamp(date);
  const max = String(existingMax ?? '');
  if (isMicroStamp(max) && max >= now) {
    const next = bumpStamp(max, 1);
    lastIssued = next;
    return next;
  }
  return now;
}

// 只给测试用：复位水位，避免用例之间互相污染。
export function __resetStampWatermark() {
  lastIssued = '';
}
