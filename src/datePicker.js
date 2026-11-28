// 全应用统一的日期选择器。
//
// 为什么不用 flatpickr：它的 DOM 结构固定，样式能改的余地很小，
// 而且「只到日 / 到分 / 到秒」这种业务差异要靠开关拼，视觉上对不齐。
// 这里自己做一套，尺寸、圆角、配色都跟表格一致，深色/浅色主题都能用。
//
// 两件事：
// 1. 弹一个日历，选中后回调。精度是**每一格自己的事** —— 底部「精度 日/分/秒」
//    只改这一格写库的形状，不回流到列配置（列上那个只是空白格的默认值）。
// 2. 年月时分秒都能用滚轮调：鼠标停在「2026 年」上滚 = 换年，停在「11 月」上滚 = 换月，
//    停在 16 / 30 / 22 上滚 = 换时分秒。日仍然是点的 —— 月份格里点日最快。

import { escapeHtml } from './htmlUtils.js';
import {
  PRECISION_LEVELS,
  PRECISION_LABELS,
  MICRO_PRECISION,
  normalizePrecision,
  parseDateValue,
  formatDateValue,
  pad2,
} from './dateValue.js';

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const MONTH_LABELS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];

const UNIT_LABELS = { hour: '小时', minute: '分钟', second: '秒' };
const UNIT_MAX = { hour: 23, minute: 59, second: 59 };

let active = null;

export function closeDatePicker() {
  if (!active) return;
  const { el, onOutside, onKey, onClose } = active;
  active = null;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  el.remove();
  onClose?.();
}

function sameDay(a, b) {
  return Boolean(a && b) && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function openDatePicker(anchorEl, options = {}) {
  closeDatePicker();
  const { value = '', precision: fallbackPrecision = 'minute', onPick, onClear, onClose } = options;
  const parsed = parseDateValue(value, fallbackPrecision);
  const today = new Date();
  let viewYear = parsed.hasValue ? parsed.year : today.getFullYear();
  let viewMonth = parsed.hasValue ? parsed.month - 1 : today.getMonth();
  let viewMode = 'day'; // day | month
  let selected = parsed.hasValue ? new Date(parsed.year, parsed.month - 1, parsed.day) : null;
  // 时/分/秒 三段始终都留着：切精度只改「显示哪几段 / 写几位」，
  // 不把已经填好的秒洗掉 —— 否则「秒→分→秒」来回切一次，秒就没了。
  const draft = { hour: parsed.hour, minute: parsed.minute, second: parsed.second };
  // 微秒值（26 字符，系统生成的时间戳）在选择器里按「秒」编辑 ——
  // 用户能选的只有 日/分/秒 三档，多一个「微秒」按钮是给人找麻烦。
  let precision = parsed.precision === MICRO_PRECISION ? 'second' : normalizePrecision(parsed.precision, fallbackPrecision);
  // 打开时的原值。提交前拿最终串跟它比：一样就不写库，
  // 省掉「打开看一眼再点确定」产生的一次无意义 updated_at。
  const originalRaw = String(value ?? '').trim();
  // 用户到底动过手没有。
  // 只比字符串是不够的：微秒值会被 composed() 拼成到秒的 23 字符，
  // 「打开日历看一眼 → 点确定」就会把微秒抹掉 —— 和当年静默丢秒是同一类 bug。
  // 所以没动过手时直接用原值，一个字都不重拼。
  let dirty = false;

  const el = document.createElement('div');
  el.className = 'sh-dp';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '选择日期与精度');
  document.body.appendChild(el);

  const timeRowHtml = () => {
    if (precision === 'day') return '';
    const units = precision === 'second' ? ['hour', 'minute', 'second'] : ['hour', 'minute'];
    return `<div class="sh-dp-time">
      <span class="sh-dp-time-label">时间</span>
      ${units
        .map(
          (unit, index) => `${index ? '<span class="sh-dp-colon">:</span>' : ''}<span class="sh-dp-spin" data-wheel="${unit}" title="滚轮切换${UNIT_LABELS[unit]}"><input type="text" inputmode="numeric" maxlength="2" data-time="${unit}" value="${pad2(draft[unit])}" aria-label="${UNIT_LABELS[unit]}" /></span>`
        )
        .join('')}
    </div>`;
  };

  const precisionRowHtml = () => `<div class="sh-dp-prec">
      <span class="sh-dp-time-label">精度</span>
      <div class="sh-dp-prec-seg" role="group" aria-label="日期精度">
        ${PRECISION_LEVELS.map(
          level => `<button type="button" class="sh-dp-prec-btn${level === precision ? ' is-on' : ''}" data-prec="${level}">${PRECISION_LABELS[level]}</button>`
        ).join('')}
      </div>
    </div>`;

  const footHtml = () => `<div class="sh-dp-foot">
      <button type="button" class="sh-dp-btn" data-today>今天</button>
      <button type="button" class="sh-dp-btn" data-clear>清除</button>
      <span class="sh-dp-gap"></span>
      <button type="button" class="sh-dp-btn is-primary" data-done>确定</button>
    </div>`;

  const headHtml = () => {
    const navLabel = viewMode === 'month' ? ['上一年', '下一年'] : ['上个月', '下个月'];
    const yearSeg = `<button type="button" class="sh-dp-seg" data-mode="${viewMode === 'month' ? 'day' : 'month'}" data-wheel="year" title="滚轮切换年份">${viewYear} 年</button>`;
    const monthSeg =
      viewMode === 'month'
        ? ''
        : `<button type="button" class="sh-dp-seg" data-mode="month" data-wheel="month" title="滚轮切换月份">${viewMonth + 1} 月</button>`;
    return `<div class="sh-dp-head">
      <button type="button" class="sh-dp-nav" data-nav="-1" aria-label="${navLabel[0]}">‹</button>
      <div class="sh-dp-title">${yearSeg}${monthSeg}</div>
      <button type="button" class="sh-dp-nav" data-nav="1" aria-label="${navLabel[1]}">›</button>
    </div>`;
  };

  const paint = () => {
    if (viewMode === 'month') {
      el.innerHTML = `${headHtml()}
        <div class="sh-dp-months">
          ${MONTH_LABELS.map(
            (label, index) => `<button type="button" class="sh-dp-month${index === viewMonth ? ' is-on' : ''}" data-month="${index}">${label}</button>`
          ).join('')}
        </div>
        ${timeRowHtml()}
        ${precisionRowHtml()}
        ${footHtml()}`;
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

    el.innerHTML = `${headHtml()}
      <div class="sh-dp-week">${WEEK_LABELS.map(label => `<span>${label}</span>`).join('')}</div>
      <div class="sh-dp-grid">${cells.join('')}</div>
      ${timeRowHtml()}
      ${precisionRowHtml()}
      ${footHtml()}`;
    put();
  };

  // 最终写库的串：日取选中（没选就用今天），时分秒取草稿，按当前精度决定写几位。
  const composed = () => {
    const base = selected || new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return formatDateValue(
      { year: base.getFullYear(), month: base.getMonth() + 1, day: base.getDate(), ...draft },
      precision
    );
  };

  const commit = () => {
    // 什么都没动就一个字都不写。空值例外 —— 空值点确定就是要落一个日期，
    // 那本身就是「改了」，不能因为 dirty 还是 false 就吞掉。
    if (!dirty && parsed.hasValue) { closeDatePicker(); return; }
    const next = composed();
    if (next !== originalRaw) onPick?.(next);
    closeDatePicker();
  };

  // 只刷三个输入框的值，不重画整块 —— 滚轮连着滚的时候重画会把焦点和输入状态全丢掉。
  const syncTimeInputs = () => {
    el.querySelectorAll('[data-time]').forEach(input => {
      input.value = pad2(draft[input.dataset.time]);
    });
  };

  const stepUnit = (unit, dir) => {
    if (unit === 'year') {
      viewYear = Math.min(2200, Math.max(1900, viewYear + dir));
      paint();
      return;
    }
    if (unit === 'month') {
      viewMonth += dir;
      if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
      if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
      paint();
      return;
    }
    // 只有时/分/秒会改 draft（真正写进值里的东西）。
    // 年/月滚轮只是「翻日历看」，选中日没动 —— 那不算动手，
    // 否则用户滚两下看看再点确定，微秒时间戳就被重拼没了。
    dirty = true;
    const max = UNIT_MAX[unit] ?? 59;
    // 时/分/秒循环：59 再往下滚回到 0，这是时间控件的常识（不是夹在边界不动）。
    draft[unit] = (draft[unit] + dir + max + 1) % (max + 1);
    syncTimeInputs();
  };

  // 定位：贴锚点下方，放不下就上翻。
  // 写成函数声明（会提升），paint() 每次重绘后都重量一次 ——
  // 切到「年视图」高度会变，不重量就会跑出屏幕。
  function put() {
    const rect = anchorEl.getBoundingClientRect();
    const width = el.offsetWidth || 272;
    const height = el.offsetHeight || 380;
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
    const precBtn = event.target.closest('[data-prec]');
    if (precBtn) {
      precision = normalizePrecision(precBtn.dataset.prec);
      dirty = true;
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
      // 只到日的格子：点一天就是点完了，不用再点确定。
      if (precision === 'day') commit();
      else { paint(); el.querySelector('.sh-dp-day.is-on')?.focus?.(); }
      return;
    }
    if (event.target.closest('[data-today]')) {
      selected = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      viewYear = selected.getFullYear();
      viewMonth = selected.getMonth();
      dirty = true;
      if (precision === 'day') commit();
      else { paint(); el.querySelector('.sh-dp-day.is-on')?.focus?.(); }
      return;
    }
    if (event.target.closest('[data-clear]')) {
      onClear?.();
      closeDatePicker();
      return;
    }
    if (event.target.closest('[data-done]')) commit();
  });

  // 滚轮：年月 + 时分秒。挂在外层做事件委托 —— 每次 paint 都换 DOM，
  // 逐个绑定等于每次重画都要重绑一遍。
  let wheelAt = 0;
  el.addEventListener(
    'wheel',
    event => {
      const target = event.target.closest?.('[data-wheel]');
      if (!target) return;
      event.preventDefault();
      // 触控板惯性会连着发几十个小 delta，放任它就会一路滚飞。
      // 小增量（<12）当抖动丢掉，再叠 60ms 节流；鼠标滚轮一格 ~100 不受影响。
      if (Math.abs(event.deltaY) < 12) return;
      const now = Date.now();
      if (now - wheelAt < 60) return;
      wheelAt = now;
      // 方向统一成「往上滚 = 数值变大」，与 <input type=number> 和系统数字控件一致：
      // 年 +1、月 +1、时/分/秒 +1。混着来（数字往上、日历往下）才是真的难记。
      stepUnit(target.dataset.wheel, event.deltaY < 0 ? 1 : -1);
    },
    { passive: false }
  );

  el.addEventListener('input', event => {
    const input = event.target.closest?.('[data-time]');
    if (!input) return;
    const digits = input.value.replace(/\D/g, '').slice(0, 2);
    input.value = digits;
    draft[input.dataset.time] = Number(digits || 0);
  });

  el.addEventListener('change', event => {
    const input = event.target.closest?.('[data-time]');
    if (!input) return;
    const unit = input.dataset.time;
    const max = UNIT_MAX[unit] ?? 59;
    draft[unit] = Math.min(max, Math.max(0, Number(input.value.replace(/\D/g, '') || 0)));
    input.value = pad2(draft[unit]);
    dirty = true;
  });

  const onOutside = event => {
    if (!el.contains(event.target) && !anchorEl.contains(event.target)) closeDatePicker();
  };
  const onKey = event => {
    if (event.key === 'Escape') { event.stopPropagation(); closeDatePicker(); return; }
    if (event.key === 'Enter') {
      // 输入法还在组词时回车是「选词」，不是「确定日期」
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      commit();
      return;
    }
    // 焦点在时/分/秒里：上下就是滚轮的键盘版，其余按键交给原生（左右移光标）。
    const spinInput = event.target.closest?.('[data-time]');
    if (spinInput) {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        stepUnit(spinInput.dataset.time, event.key === 'ArrowUp' ? 1 : -1);
      }
      return;
    }
    // 方向键直接挪选中日：只在「日」视图下接管
    if (viewMode !== 'day') return;
    const stepDay = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    const stepMonth = event.key === 'PageUp' ? -1 : (event.key === 'PageDown' ? 1 : 0);
    if (stepDay === undefined && !stepMonth) return;
    event.preventDefault();
    const base = selected ? new Date(selected) : new Date(viewYear, viewMonth, 1);
    if (stepMonth) {
      const delta = stepMonth * (event.shiftKey ? 12 : 1);
      base.setDate(1);
      base.setMonth(base.getMonth() + delta);
    } else {
      base.setDate(base.getDate() + stepDay);
    }
    selected = base;
    viewYear = base.getFullYear();
    viewMonth = base.getMonth();
    dirty = true;
    paint();
    el.querySelector('.sh-dp-day.is-on')?.focus?.();
  };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);

  active = { el, anchor: anchorEl, onOutside, onKey, onClose };
  el.querySelector('.sh-dp-day.is-on, .sh-dp-day.is-today')?.focus?.();
  return el;
}
