// 全应用统一的日期选择器。
//
// 为什么不用 flatpickr：它的 DOM 结构固定，样式能改的余地很小，
// 而且「只到日 / 到分钟」这种业务差异要靠 enableTime 开关拼，视觉上对不齐。
// 这里自己做一套，尺寸、圆角、配色都跟表格一致，深色/浅色主题都能用。
//
// 只做一件事：给一个锚点元素，弹一个日历，选中后回调。

import { escapeHtml } from './htmlUtils.js';

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const MONTH_LABELS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];

let active = null;

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function closeDatePicker() {
  if (!active) return;
  const { el, onOutside, onKey, onClose } = active;
  active = null;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  el.remove();
  onClose?.();
}

// 值 → { date: Date|null, time: 'HH:mm' }
function parseValue(value, dateOnly) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) return { date: null, time: dateOnly ? '' : '' };
  const [, y, m, d, hh, mm] = match;
  return {
    date: new Date(Number(y), Number(m) - 1, Number(d)),
    time: dateOnly ? '' : `${hh || '09'}:${mm || '00'}`,
  };
}

function formatValue(date, time, dateOnly) {
  const base = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  if (dateOnly) return base;
  return `${base} ${time || '00:00'}`;
}

function sameDay(a, b) {
  return Boolean(a && b) && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function openDatePicker(anchorEl, options = {}) {
  closeDatePicker();
  const { value = '', dateOnly = false, onPick, onClear, onClose } = options;
  const parsed = parseValue(value, dateOnly);
  const today = new Date();
  let viewYear = (parsed.date || today).getFullYear();
  let viewMonth = (parsed.date || today).getMonth();
  let viewMode = 'day'; // day | month
  let selected = parsed.date;
  let timeValue = parsed.time || '09:00';
  // 打开后什么都没改就点「确定」= 不该写库。
  // 否则一个只存了日期（没有时间）的旧值会被悄悄补成 09:00。
  const originalRaw = String(value || '').trim();
  const originalTime = parsed.time || '';
  let dirty = false;

  const el = document.createElement('div');
  el.className = 'sh-dp';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '选择日期');
  document.body.appendChild(el);

  const paint = () => {
    if (viewMode === 'month') {
      el.innerHTML = `
        <div class="sh-dp-head">
          <button type="button" class="sh-dp-nav" data-nav="-1" aria-label="上一年">‹</button>
          <button type="button" class="sh-dp-title" data-mode="day">${viewYear} 年</button>
          <button type="button" class="sh-dp-nav" data-nav="1" aria-label="下一年">›</button>
        </div>
        <div class="sh-dp-months">
          ${MONTH_LABELS.map(
            (label, index) => `<button type="button" class="sh-dp-month${index === viewMonth ? ' is-on' : ''}" data-month="${index}">${label}</button>`
          ).join('')}
        </div>
        <div class="sh-dp-foot">
          <button type="button" class="sh-dp-btn" data-today>今天</button>
          <span class="sh-dp-gap"></span>
          <button type="button" class="sh-dp-btn is-primary" data-done>确定</button>
        </div>`;
      put();
      return;
    }

    const first = new Date(viewYear, viewMonth, 1);
    // 周一为一周第一天
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(viewYear, viewMonth, 1 - offset);
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const outside = date.getMonth() !== viewMonth;
      const isToday = sameDay(date, today);
      const isSelected = sameDay(date, selected);
      cells.push(`<button type="button" class="sh-dp-day${outside ? ' is-out' : ''}${isToday ? ' is-today' : ''}${isSelected ? ' is-on' : ''}"
        data-date="${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}">${date.getDate()}</button>`);
    }

    el.innerHTML = `
      <div class="sh-dp-head">
        <button type="button" class="sh-dp-nav" data-nav="-1" aria-label="上个月">‹</button>
        <button type="button" class="sh-dp-title" data-mode="month">${viewYear} 年 ${viewMonth + 1} 月</button>
        <button type="button" class="sh-dp-nav" data-nav="1" aria-label="下个月">›</button>
      </div>
      <div class="sh-dp-week">${WEEK_LABELS.map(label => `<span>${label}</span>`).join('')}</div>
      <div class="sh-dp-grid">${cells.join('')}</div>
      ${dateOnly ? '' : `
      <div class="sh-dp-time">
        <span class="sh-dp-time-label">时间</span>
        <input type="text" inputmode="numeric" class="sh-dp-time-input" data-time maxlength="5" value="${escapeHtml(timeValue)}" aria-label="时间 HH:MM" />
        <span class="sh-dp-time-hint">24 小时制</span>
      </div>`}
      <div class="sh-dp-foot">
        <button type="button" class="sh-dp-btn" data-today>今天</button>
        <button type="button" class="sh-dp-btn" data-clear>清除</button>
        <span class="sh-dp-gap"></span>
        <button type="button" class="sh-dp-btn is-primary" data-done>确定</button>
      </div>`;
    put();
  };

  const commit = (date, time) => {
    if (!date) return;
    onPick?.(formatValue(date, time, dateOnly));
    closeDatePicker();
  };

  // 定位：贴锚点下方，放不下就上翻。
  // 写成函数声明（会提升），paint() 每次重绘后都重量一次 ——
  // 切到「年视图」高度会变，不重量就会跑出屏幕。
  function put() {
    const rect = anchorEl.getBoundingClientRect();
    const width = el.offsetWidth || 268;
    const height = el.offsetHeight || 340;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.bottom - height - rect.height - 6);
    if (top < 8) top = Math.max(8, window.innerHeight - height - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  paint();

  el.addEventListener('click', event => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      const step = Number(nav.dataset.nav);
      if (viewMode === 'month') viewYear += step;
      else {
        viewMonth += step;
        if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
        if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
      }
      paint();
      return;
    }
    if (event.target.closest('[data-mode]')) {
      viewMode = viewMode === 'month' ? 'day' : 'month';
      paint();
      return;
    }
    const monthBtn = event.target.closest('[data-month]');
    if (monthBtn) {
      viewMonth = Number(monthBtn.dataset.month);
      viewMode = 'day';
      paint();
      return;
    }
    const dayBtn = event.target.closest('[data-date]');
    if (dayBtn) {
      const [y, m, d] = dayBtn.dataset.date.split('-').map(Number);
      selected = new Date(y, m - 1, d);
      viewYear = y;
      viewMonth = m - 1;
      dirty = true;
      const timeInput = el.querySelector('[data-time]');
      const time = timeInput ? timeInput.value.trim() : timeValue;
      if (dateOnly) commit(selected, '');
      else { timeValue = time; paint(); }
      return;
    }
    if (event.target.closest('[data-today]')) {
      selected = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      viewYear = selected.getFullYear();
      viewMonth = selected.getMonth();
      dirty = true;
      const timeInput = el.querySelector('[data-time]');
      const time = timeInput ? timeInput.value.trim() : timeValue;
      if (dateOnly) commit(selected, '');
      else { timeValue = time; paint(); }
      return;
    }
    if (event.target.closest('[data-clear]')) {
      onClear?.();
      closeDatePicker();
      return;
    }
    if (event.target.closest('[data-done]')) {
      // 打开后原值没动过：直接关掉，不产生一次无意义的写库
      if (!dirty && originalRaw) { closeDatePicker(); return; }
      const timeInput = el.querySelector('[data-time]');
      commit(selected || new Date(), dateOnly ? '' : (timeInput ? timeInput.value.trim() : timeValue));
    }
  });

  el.addEventListener('input', event => {
    if (!event.target.matches('[data-time]')) return;
    // 只允许 HH:MM，边输边补冒号
    let raw = event.target.value.replace(/[^\d:]/g, '');
    if (raw.length === 2 && !raw.includes(':') && event.inputType !== 'deleteContentBackward') raw = `${raw}:`;
    if (raw.length > 5) raw = raw.slice(0, 5);
    event.target.value = raw;
  });

  el.addEventListener('change', event => {
    if (!event.target.matches('[data-time]')) return;
    const match = event.target.value.match(/^(\d{1,2}):?(\d{0,2})$/);
    if (!match) { event.target.value = timeValue; return; }
    const hh = Math.min(23, Number(match[1] || 0));
    const mm = Math.min(59, Number(match[2] || 0));
    timeValue = `${pad2(hh)}:${pad2(mm)}`;
    if (timeValue !== originalTime) dirty = true;
    event.target.value = timeValue;
  });

  const onOutside = event => {
    if (!el.contains(event.target) && !anchorEl.contains(event.target)) closeDatePicker();
  };
  const onKey = event => {
    if (event.key === 'Escape') { event.stopPropagation(); closeDatePicker(); }
    if (event.key === 'Enter') {
      // 输入法还在组词时回车是「选词」，不是「确定日期」
      if (event.isComposing || event.keyCode === 229) return;
      const timeInput = el.querySelector('[data-time]');
      const timeRaw = timeInput ? timeInput.value.trim() : timeValue;
      const timeChanged = !dateOnly && timeRaw !== originalTime;
      event.preventDefault();
      if (!dirty && !timeChanged && originalRaw) { closeDatePicker(); return; }
      commit(selected || new Date(), dateOnly ? '' : timeRaw);
    }
  };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);

  active = { el, anchor: anchorEl, onOutside, onKey, onClose };
  el.querySelector('.sh-dp-day.is-on, .sh-dp-day.is-today')?.focus?.();
  return el;
}
