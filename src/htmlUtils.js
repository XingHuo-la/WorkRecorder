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
