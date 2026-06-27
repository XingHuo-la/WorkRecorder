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
