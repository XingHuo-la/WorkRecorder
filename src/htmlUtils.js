export function escapeHtml(value) {
  if (value === null || value === undefined) return '';

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function textWithLineBreaks(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

/**
 * 把截止时间压成窄容器里读得下去的短文案：去掉年份、去掉秒，区间用 `→` 连接。
 *
 * 数据里 end_at / start_at 有两种形态：单值 `2026-07-08 00:00:00` 与区间
 * `2026-07-01 ~ 2026-07-31`。原样渲染会变成比任务标题还长的一条时间戳，
 * 在「今日待办」的 chip 和「今天的记录」的说明行里都是最吵的一处。
 * 这里只保留 `MM-DD` 与 `HH:MM`。
 *
 * 放在 htmlUtils 里是因为 todo.js（截止时间 chip）和 todayTimeline.js
 * （记录行的说明文字）两处都要用，不能各写一份。
 *
 * @param {string|null|undefined} raw 原始时间字符串
 * @return {string} 形如 `07-08 00:00` / `07-01 → 07-31` 的短文案；空值返回 ''
 */
export function shortDeadline(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  const points = text.split(/\s*(?:~|至|到|—|–)\s*/).filter(Boolean);
  return points.map(shortDeadlinePoint).join(' → ');
}

/**
 * 单个时间点 → `MM-DD HH:MM` / `MM-DD`；解析不了就原样返回。
 *
 * @param {string} raw 单个时间点字符串
 * @return {string} 短文案
 */
function shortDeadlinePoint(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  const dateMatch = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  const timeMatch = /(\d{1,2}):(\d{2})/.exec(text);
  const datePart = dateMatch
    ? `${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
    : '';
  const timePart = timeMatch
    ? `${String(Number(timeMatch[1])).padStart(2, '0')}:${timeMatch[2]}`
    : '';

  if (datePart && timePart) return `${datePart} ${timePart}`;
  if (datePart) return datePart;
  return text;
}

export function insertTextareaNewline(textarea) {
  if (!textarea) return;
  const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
  const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
  const value = textarea.value || '';
  textarea.value = `${value.slice(0, start)}\n${value.slice(end)}`;
  const cursor = start + 1;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

export function escapeInlineJsString(value) {
  const jsEscaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return escapeHtml(jsEscaped);
}

export function formatLocalTimestamp(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function appendRemarkEntry(existingRemark, note, date = new Date(), entryType = '') {
  const typePrefix = entryType ? `${entryType}：` : '';
  const entry = `[${formatLocalTimestamp(date)}] ${typePrefix}${note}`;
  return existingRemark ? `${existingRemark}\n${entry}` : entry;
}
