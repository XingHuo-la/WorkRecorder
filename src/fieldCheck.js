// 字段值与「这一列声明的类型」是否对得上。
//
// 起因：一列早先是纯文本，里面已经写满了「主设备诊断」「未分类」这样的值；
// 后来把列改成单选，选项表是空的 —— 于是这些值既不在选项里、也没有地方能看出一致性，
// 打开「编辑字段」只看到两个凭空捏造的「选项 A / B」，用户以为自己的内容没了。
//
// 这一层只做判断，不碰 DOM、不写库、不读库：
//   ① 一列里出现过哪些值（按次数排序）—— 面板用它来「把已有的值补成选项」；
//   ② 某个值里有哪些记号对不上选项 —— 渲染层用它画红角标，粘贴后用它在写入前提条件。
//
// 「对不上」的判定只有一条：**按 value 匹配，其次按 label 匹配（忽略大小写与首尾空格）**。
// 用 label 兜底是因为从别处粘进来的往往是人看的文字，而选项的 value 可能是 a/b/v1 这种代号；
// 只看 value 会让一整列肉眼可见的「已完成」全被标成脏数据。

/** 选项 → 查找表：value 精确命中优先，其次 label（忽略大小写）。 */
export function optionLookup(options) {
  const byValue = new Map();
  const byLabel = new Map();
  (Array.isArray(options) ? options : []).forEach(option => {
    if (!option) return;
    const value = String(option.value ?? '');
    const label = String(option.label ?? value).trim().toLowerCase();
    if (value) byValue.set(value, option);
    if (label) byLabel.set(label, option);
  });
  return { byValue, byLabel };
}

/** 这个值命中选项了没。命中返回那个选项，没命返回 null。 */
export function matchOption(options, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const { byValue, byLabel } = optionLookup(options);
  return byValue.get(text) || byLabel.get(text.toLowerCase()) || null;
}

/** 多选值切成记号：与 fieldTypes 的 normalizeMulti 同一套分隔符。 */
export function splitTokens(value) {
  if (Array.isArray(value)) return value.map(item => String(item ?? '').trim()).filter(Boolean);
  return String(value ?? '')
    .split(/[,，、;；]/)
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * 一个单元格里对不上选项的记号。
 * 非选项类字段（文本 / 日期 / 数字…）一律返回空数组 —— 它们没有「选项」这个概念。
 * @returns {string[]} 去重后的原始字样
 */
export function unmatchedTokens(field, value, options) {
  const type = field?.type;
  if (type !== 'select' && type !== 'multi_select') return [];
  const tokens = type === 'multi_select' ? splitTokens(value) : (String(value ?? '').trim() ? [String(value).trim()] : []);
  if (!tokens.length) return [];
  // 一次渲染里可能调用几十上百次，查找表建一次就够（按格子建表是纯浪费）
  const { byValue, byLabel } = optionLookup(options);
  const hit = token => byValue.has(token) || byLabel.has(token.toLowerCase());
  const bad = [];
  const seen = new Set();
  tokens.forEach(token => {
    if (hit(token)) return;
    if (seen.has(token)) return;
    seen.add(token);
    bad.push(token);
  });
  return bad;
}

/**
 * 一列里实际出现过的值，按出现次数从多到少。
 * 只统计非空值；多选列拆成单个记号（否则「A,B」和「B,A」会被算成两个值）。
 * @param {Array<{values: object}>} rows
 * @returns {Array<{value: string, count: number}>}
 */
export function columnValueStats(rows, field) {
  const type = field?.type;
  if (!field?.key || (type !== 'select' && type !== 'multi_select')) return [];
  const counter = new Map();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const raw = row?.values?.[field.key];
    const tokens = type === 'multi_select' ? splitTokens(raw) : [String(raw ?? '').trim()];
    tokens.filter(Boolean).forEach(token => counter.set(token, (counter.get(token) || 0) + 1));
  });
  return [...counter.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN'));
}

/** 一列里对不上选项的值（同样按次数排序）。 */
export function unmatchedColumnValues(rows, field, options) {
  return filterUnmatchedStats(columnValueStats(rows, field), options);
}

/** 同上，但入参已经是统计结果 —— 面板里选项会被删删加加，得反复过滤这份统计。 */
export function filterUnmatchedStats(stats, options) {
  const list = Array.isArray(options) ? options : [];
  return (Array.isArray(stats) ? stats : []).filter(item => !matchOption(list, item.value));
}

/**
 * 把一列里已有的值补成选项。
 *
 * 产出的 value **就是那段文字本身**，不是 v1/a/b 这种代号 —— 这是让「已经写在格子里的
 * 那些值」立刻命中的唯一办法：匹配是按 value 来的，生成一个不相干的代号等于刚加完
 * 选项、格子上还是红角标。
 */
export function optionsFromValues(values, existing = [], palette = []) {
  const base = Array.isArray(existing) ? existing.map(option => ({ ...option })) : [];
  const { byLabel } = optionLookup(base);
  const next = [...base];
  const colors = Array.isArray(palette) && palette.length ? palette : ['#60a5fa'];
  (Array.isArray(values) ? values : []).forEach(raw => {
    const label = String(raw ?? '').trim();
    if (!label) return;
    if (byLabel.has(label.toLowerCase())) return;
    next.push({ value: label, label, color: colors[next.length % colors.length] });
    byLabel.set(label.toLowerCase(), next[next.length - 1]);
  });
  return next;
}
