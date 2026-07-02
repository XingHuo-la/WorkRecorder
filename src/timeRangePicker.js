function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDateOnly(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getThisWeekEnd(date = new Date()) {
  const day = date.getDay();
  return addDays(date, day === 0 ? 0 : 7 - day);
}

function parseDateTime(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  const hasTime = hour !== undefined && minute !== undefined;
  return {
    date,
    dateKey: `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    time: hasTime ? `${hour.padStart(2, '0')}:${minute}` : '',
    hasTime
  };
}

function toMinutes(item) {
  if (!item?.hasTime) return null;
  const [hour, minute] = item.time.split(':').map(Number);
  return hour * 60 + minute;
}

function addMinutes(value, minutes) {
  const item = parseDateTime(value);
  if (!item?.hasTime) return '';
  const next = new Date(item.date);
  const currentMinutes = toMinutes(item);
  next.setHours(0, currentMinutes + minutes, 0, 0);
  return `${formatDateOnly(next)} ${pad2(next.getHours())}:${pad2(next.getMinutes())}`;
}

function normalizeRange(start, end) {
  if (!start || !end) return { start, end };
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime()) && endDate < startDate) {
    return { start: end, end: start };
  }
  return { start, end };
}

function formatDateLabel(item) {
  if (!item) return '';
  const today = formatDateOnly(new Date());
  const tomorrow = formatDateOnly(addDays(new Date(), 1));
  if (item.dateKey === today) return '今天';
  if (item.dateKey === tomorrow) return '明天';
  return `${item.date.getMonth() + 1}月${item.date.getDate()}日`;
}

function formatDateTimePart(item) {
  if (!item) return '';
  const label = formatDateLabel(item);
  return item.hasTime ? `${label} ${item.time}` : label;
}

export function formatTimeRangeSummary(startValue, endValue) {
  const start = parseDateTime(startValue);
  const end = parseDateTime(endValue);
  if (!start && !end) return '无时间';
  if (start && end) {
    if (start.dateKey === end.dateKey && start.hasTime && end.hasTime) {
      return `${formatDateLabel(start)} ${start.time} - ${end.time}`;
    }
    return `${formatDateTimePart(start)} - ${formatDateTimePart(end)}`;
  }
  return formatDateTimePart(end || start);
}

function buildTimePoints(step) {
  const interval = Number(step) > 0 ? Number(step) : 30;
  const points = [];
  for (let minutes = 8 * 60; minutes <= 22 * 60; minutes += interval) {
    points.push(`${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`);
  }
  return points;
}

function getSelectedDateKey(start, end) {
  return parseDateTime(start)?.dateKey || parseDateTime(end)?.dateKey || formatDateOnly(new Date());
}

function isBetweenTime(point, start, end, selectedDate) {
  const startItem = parseDateTime(start);
  const endItem = parseDateTime(end);
  if (!startItem?.hasTime || !endItem?.hasTime || startItem.dateKey !== selectedDate || endItem.dateKey !== selectedDate) return false;
  const pointMinutes = toMinutes({ time: point, hasTime: true });
  return pointMinutes > toMinutes(startItem) && pointMinutes < toMinutes(endItem);
}

export function createTimeRangePicker(container, options = {}) {
  if (!container) return null;

  const state = {
    start: options.valueStart || '',
    end: options.valueEnd || '',
    selectedDate: getSelectedDateKey(options.valueStart, options.valueEnd),
    minuteStep: options.minuteStep || 30,
    allowDateOnly: options.allowDateOnly !== false,
    disabled: Boolean(options.disabled),
    isOpen: false,
    phase: 'start',
    preciseTime: ''
  };

  const emit = () => {
    const normalized = normalizeRange(state.start, state.end);
    state.start = normalized.start || '';
    state.end = normalized.end || '';
    options.onChange?.(state.start, state.end);
  };

  const setDateOnly = (dateKey) => {
    state.selectedDate = dateKey;
    state.start = '';
    state.end = dateKey;
    state.phase = 'start';
    emit();
    render();
  };

  const clear = () => {
    state.start = '';
    state.end = '';
    state.phase = 'start';
    emit();
    render();
  };

  const setTimePoint = (time) => {
    const value = `${state.selectedDate} ${time}`;
    if (state.phase === 'start' || (state.start && state.end)) {
      state.start = value;
      state.end = '';
      state.phase = 'end';
    } else {
      state.end = value;
      state.phase = 'start';
    }
    emit();
    render();
  };

  const applyDuration = (minutes) => {
    if (minutes === 1439) {
      state.start = `${state.selectedDate} 00:00`;
      state.end = `${state.selectedDate} 23:59`;
      state.phase = 'start';
      emit();
      render();
      return;
    }
    if (!state.start || !parseDateTime(state.start)?.hasTime) {
      state.phase = 'end';
      render();
      return;
    }
    state.end = addMinutes(state.start, minutes);
    state.phase = 'start';
    emit();
    render();
  };

  const renderTimeGrid = () => {
    const startItem = parseDateTime(state.start);
    const endItem = parseDateTime(state.end);
    return buildTimePoints(state.minuteStep).map(point => {
      const isStart = startItem?.dateKey === state.selectedDate && startItem.time === point;
      const isEnd = endItem?.dateKey === state.selectedDate && endItem.time === point;
      const inRange = isBetweenTime(point, state.start, state.end, state.selectedDate);
      const className = ['time-range-time-btn', isStart ? 'is-start' : '', isEnd ? 'is-end' : '', inRange ? 'in-range' : ''].filter(Boolean).join(' ');
      return `<button type="button" class="${className}" data-time="${point}">${point}</button>`;
    }).join('');
  };

  const render = () => {
    const summary = formatTimeRangeSummary(state.start, state.end);
    const isPrecise = String(state.minuteStep) === 'minute';
    container.classList.add('time-range-picker');
    container.innerHTML = `
      <button type="button" class="time-range-summary" ${state.disabled ? 'disabled' : ''} aria-expanded="${state.isOpen}">
        <span>${summary}</span>
        <span class="time-range-summary-action">修改</span>
      </button>
      <div class="time-range-popover${state.isOpen ? ' open' : ''}" ${state.isOpen ? '' : 'hidden'}>
        <div class="time-range-section">
          <div class="time-range-label">日期</div>
          <div class="time-range-date-actions">
            <button type="button" data-date-action="today">今天</button>
            <button type="button" data-date-action="tomorrow">明天</button>
            <button type="button" data-date-action="week">本周</button>
            <label class="time-range-custom-date">自定义日期 <input type="date" value="${state.selectedDate}" /></label>
            <button type="button" data-date-action="none">无时间</button>
          </div>
        </div>
        <div class="time-range-section">
          <div class="time-range-toolbar">
            <div>
              <div class="time-range-label">时间点</div>
              <div class="time-range-hint">${state.phase === 'end' ? '请选择结束时间' : '请选择开始时间'}</div>
            </div>
            <select class="time-range-step-select" aria-label="时间精度">
              <option value="15"${state.minuteStep === 15 ? ' selected' : ''}>15 分钟</option>
              <option value="30"${state.minuteStep === 30 ? ' selected' : ''}>30 分钟</option>
              <option value="60"${state.minuteStep === 60 ? ' selected' : ''}>60 分钟</option>
              <option value="minute"${isPrecise ? ' selected' : ''}>精确到分钟</option>
            </select>
          </div>
          <div class="time-range-time-grid">${renderTimeGrid()}</div>
          <div class="time-range-precise-row${isPrecise ? ' open' : ''}">
            <input type="time" class="time-range-precise-input" value="${state.preciseTime}" />
            <button type="button" class="btn btn-secondary time-range-precise-add">使用此时间</button>
          </div>
        </div>
        <div class="time-range-section">
          <div class="time-range-label">快捷时长</div>
          <div class="time-range-duration-actions">
            <button type="button" data-duration="30">30分钟</button>
            <button type="button" data-duration="60">1小时</button>
            <button type="button" data-duration="120">2小时</button>
            <button type="button" data-duration="240">半天</button>
            <button type="button" data-duration="1439">全天</button>
          </div>
        </div>
        <div class="time-range-footer">
          <button type="button" class="btn btn-ghost time-range-clear">清除时间</button>
          <button type="button" class="btn btn-primary time-range-close">完成</button>
        </div>
      </div>
    `;

    container.querySelector('.time-range-summary')?.addEventListener('click', () => {
      if (state.disabled) return;
      state.isOpen = !state.isOpen;
      render();
    });

    container.querySelectorAll('[data-date-action]').forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.dateAction;
        if (action === 'today') setDateOnly(formatDateOnly(new Date()));
        if (action === 'tomorrow') setDateOnly(formatDateOnly(addDays(new Date(), 1)));
        if (action === 'week') setDateOnly(formatDateOnly(getThisWeekEnd(new Date())));
        if (action === 'none') clear();
      });
    });

    container.querySelector('.time-range-custom-date input')?.addEventListener('change', event => {
      const dateKey = event.target.value;
      if (!dateKey) return;
      if (state.allowDateOnly) setDateOnly(dateKey);
      else {
        state.selectedDate = dateKey;
        render();
      }
    });

    container.querySelectorAll('[data-time]').forEach(button => {
      button.addEventListener('click', () => setTimePoint(button.dataset.time));
    });

    container.querySelector('.time-range-step-select')?.addEventListener('change', event => {
      state.minuteStep = event.target.value === 'minute' ? 'minute' : Number(event.target.value);
      render();
    });

    container.querySelector('.time-range-precise-input')?.addEventListener('input', event => {
      state.preciseTime = event.target.value;
    });

    container.querySelector('.time-range-precise-add')?.addEventListener('click', () => {
      const value = container.querySelector('.time-range-precise-input')?.value;
      if (value) setTimePoint(value);
    });

    container.querySelectorAll('[data-duration]').forEach(button => {
      button.addEventListener('click', () => applyDuration(Number(button.dataset.duration)));
    });

    container.querySelector('.time-range-clear')?.addEventListener('click', clear);
    container.querySelector('.time-range-close')?.addEventListener('click', () => {
      state.isOpen = false;
      render();
    });
  };

  render();

  return {
    setValue(start, end) {
      state.start = start || '';
      state.end = end || '';
      state.selectedDate = getSelectedDateKey(state.start, state.end);
      state.phase = 'start';
      render();
    },
    getValue() {
      return { startTime: state.start, endTime: state.end };
    },
    clear
  };
}
