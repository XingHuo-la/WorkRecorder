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

function parseDate(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  return {
    date,
    dateKey: `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    hour: pad2(hour),
    minute: pad2(minute),
    second: pad2(second),
    time: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
  };
}

function toDateTime(dateKey, time = '00:00:00') {
  const [hour = '00', minute = '00', second = '00'] = String(time || '').split(':');
  return `${dateKey} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

function formatDateLabel(item, options = {}) {
  if (!item) return '';
  const today = formatDateOnly(new Date());
  const tomorrow = formatDateOnly(addDays(new Date(), 1));
  if (!options.forceYear && item.dateKey === today) return '今天';
  if (!options.forceYear && item.dateKey === tomorrow) return '明天';
  const currentYear = new Date().getFullYear();
  const year = item.date.getFullYear();
  const dateText = `${item.date.getMonth() + 1}月${item.date.getDate()}日`;
  return options.forceYear || year !== currentYear ? `${year}年${dateText}` : dateText;
}

function formatPart(value, options = {}) {
  const item = parseDate(value);
  if (!item) return '';
  return `${formatDateLabel(item, options)} ${item.time}`;
}

export function formatTimeRangeSummary(startValue, endValue) {
  const start = parseDate(startValue);
  const end = parseDate(endValue);
  if (!start && !end) return '无时间';
  if (start && end) {
    if (start.dateKey === end.dateKey) return `${formatDateLabel(start)} ${start.time} - ${end.time}`;
    const forceYear = start.date.getFullYear() !== end.date.getFullYear();
    return `${formatPart(startValue, { forceYear })} - ${formatPart(endValue, { forceYear })}`;
  }
  return formatPart(startValue || endValue);
}

function monthLabel(monthDate) {
  return `${monthDate.getFullYear()} 年 ${monthDate.getMonth() + 1} 月`;
}

function sameDate(a, b) {
  return a && b && a === b;
}

function isInRange(dateKey, startValue, endValue) {
  const start = parseDate(startValue)?.dateKey;
  const end = parseDate(endValue)?.dateKey;
  if (!start || !end) return false;
  return dateKey > start && dateKey < end;
}

function buildMonthDays(monthDate, startValue, endValue) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const gridStart = addDays(first, -startOffset);
  const selectedStart = parseDate(startValue)?.dateKey;
  const selectedEnd = parseDate(endValue)?.dateKey;
  const today = formatDateOnly(new Date());
  const cells = [];

  for (let index = 0; index < 42; index += 1) {
    const current = addDays(gridStart, index);
    const dateKey = formatDateOnly(current);
    const classes = [
      'time-range-day',
      current.getMonth() !== month ? 'is-muted' : '',
      sameDate(dateKey, today) ? 'is-today' : '',
      sameDate(dateKey, selectedStart) ? 'is-start' : '',
      sameDate(dateKey, selectedEnd) ? 'is-end' : '',
      isInRange(dateKey, startValue, endValue) ? 'in-range' : ''
    ].filter(Boolean).join(' ');
    cells.push(`<button type="button" class="${classes}" data-date="${dateKey}">${current.getDate()}</button>`);
  }

  return cells.join('');
}

function buildSelectOptions(max, selected) {
  const value = Number(selected || 0);
  return Array.from({ length: max + 1 }, (_, index) => {
    const text = pad2(index);
    return `<option value="${text}"${index === value ? ' selected' : ''}>${text}</option>`;
  }).join('');
}

const QUICK_TIMES = ['00:00:00', '09:00:00', '12:00:00', '18:00:00', '23:59:59'];

function buildPrecisePanel(kind, value, title) {
  const item = parseDate(value);
  const hour = item?.hour || (kind === 'end' ? '23' : '00');
  const minute = item?.minute || (kind === 'end' ? '59' : '00');
  const second = item?.second || (kind === 'end' ? '59' : '00');
  return `
    <div class="time-precise-panel" data-precise="${kind}">
      <div class="time-precise-title">${title}</div>
      <div class="time-precise-selects">
        <select data-part="hour">${buildSelectOptions(23, hour)}</select>
        <span>:</span>
        <select data-part="minute">${buildSelectOptions(59, minute)}</select>
        <span>:</span>
        <select data-part="second">${buildSelectOptions(59, second)}</select>
      </div>
      <div class="time-quick-points">
        ${QUICK_TIMES.map(time => `<button type="button" data-quick-time="${time}">${time}</button>`).join('')}
      </div>
    </div>
  `;
}

export function createTimeRangePicker(container, options = {}) {
  if (!container) return null;
  const mode = options.mode || 'range';
  const initial = parseDate(options.valueStart || options.valueEnd || '');
  const state = {
    start: options.valueStart || '',
    end: mode === 'single' ? '' : (options.valueEnd || ''),
    phase: options.valueStart && !options.valueEnd ? 'end' : 'start',
    isOpen: Boolean(options.open),
    preciseOpen: false,
    monthDate: initial?.date || new Date(),
    disabled: Boolean(options.disabled)
  };

  const emit = () => {
    if (mode === 'range') {
      options.onChange?.(state.start, state.end);
    } else {
      options.onChange?.(state.start, '');
    }
  };

  const clear = () => {
    state.start = '';
    state.end = '';
    state.phase = 'start';
    emit();
    render();
  };

  const selectDate = (dateKey) => {
    if (mode === 'single') {
      const current = parseDate(state.start);
      state.start = toDateTime(dateKey, current?.time || '00:00:00');
      state.monthDate = parseDate(state.start).date;
      emit();
      render();
      return;
    }

    if (state.phase === 'start' || (state.start && state.end)) {
      state.start = toDateTime(dateKey, '00:00:00');
      state.end = '';
      state.phase = 'end';
    } else {
      const currentStart = parseDate(state.start);
      if (currentStart && dateKey < currentStart.dateKey) {
        const endTime = currentStart.time === '00:00:00' ? '23:59:59' : currentStart.time;
        state.start = toDateTime(dateKey, '00:00:00');
        state.end = toDateTime(currentStart.dateKey, endTime);
      } else {
        state.end = toDateTime(dateKey, '23:59:59');
      }
      state.phase = 'start';
    }
    state.monthDate = parseDate(state.start || state.end).date;
    emit();
    render();
  };

  const setTime = (kind, time) => {
    const target = kind === 'end' ? state.end : state.start;
    const fallbackDate = parseDate(target)?.dateKey || parseDate(state.start)?.dateKey || formatDateOnly(new Date());
    if (kind === 'end' && mode === 'range') state.end = toDateTime(fallbackDate, time);
    else state.start = toDateTime(fallbackDate, time);
    emit();
    render();
  };

  const readPanelTime = (panel) => {
    const hour = panel.querySelector('[data-part="hour"]')?.value || '00';
    const minute = panel.querySelector('[data-part="minute"]')?.value || '00';
    const second = panel.querySelector('[data-part="second"]')?.value || '00';
    return `${hour}:${minute}:${second}`;
  };

  const render = () => {
    const summary = mode === 'single' ? (formatPart(state.start) || '无时间') : formatTimeRangeSummary(state.start, state.end);
    const hint = mode === 'single'
      ? '点击日期设定时间'
      : state.phase === 'end' ? '请选择结束日期' : '请选择开始日期';
    container.classList.add('time-range-picker');
    container.innerHTML = `
      <button type="button" class="time-range-summary" ${state.disabled ? 'disabled' : ''} aria-expanded="${state.isOpen}">
        <span>${summary}</span>
        <span class="time-range-summary-action">${state.isOpen ? '收起' : '选择'}</span>
      </button>
      <div class="time-range-popover${state.isOpen ? ' open' : ''}" ${state.isOpen ? '' : 'hidden'}>
        <div class="time-range-calendar-head">
          <button type="button" class="time-month-btn" data-year="-1" title="上一年">«</button>
          <button type="button" class="time-month-btn" data-month="-1">‹</button>
          <strong>${monthLabel(state.monthDate)}</strong>
          <button type="button" class="time-month-btn" data-month="1">›</button>
          <button type="button" class="time-month-btn" data-year="1" title="下一年">»</button>
        </div>
        <div class="time-range-hint">${hint}</div>
        <div class="time-weekdays"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
        <div class="time-range-calendar">${buildMonthDays(state.monthDate, state.start, mode === 'single' ? '' : state.end)}</div>
        <div class="time-range-toolbar">
          <div class="time-range-mini-actions">
            <button type="button" data-jump="today">今天</button>
            <button type="button" data-jump="tomorrow">明天</button>
            <button type="button" data-clear>清除</button>
          </div>
          <button type="button" class="time-precision-toggle" aria-expanded="${state.preciseOpen}">${state.preciseOpen ? '收起精确时间' : '展开精确时间'}</button>
        </div>
        <div class="time-precise-wrap${state.preciseOpen ? ' open' : ''}">
          ${buildPrecisePanel('start', state.start, mode === 'single' ? '时间' : '开始时间')}
          ${mode === 'range' ? buildPrecisePanel('end', state.end, '结束时间') : ''}
        </div>
        <div class="time-range-footer">
          <button type="button" class="btn btn-primary time-range-close">完成</button>
        </div>
      </div>
    `;

    container.querySelector('.time-range-summary')?.addEventListener('click', () => {
      if (state.disabled) return;
      state.isOpen = !state.isOpen;
      render();
    });

    container.querySelectorAll('[data-month]').forEach(button => {
      button.addEventListener('click', () => {
        state.monthDate = new Date(state.monthDate.getFullYear(), state.monthDate.getMonth() + Number(button.dataset.month), 1);
        render();
      });
    });

    container.querySelectorAll('[data-year]').forEach(button => {
      button.addEventListener('click', () => {
        state.monthDate = new Date(state.monthDate.getFullYear() + Number(button.dataset.year), state.monthDate.getMonth(), 1);
        render();
      });
    });

    container.querySelectorAll('[data-date]').forEach(button => {
      button.addEventListener('click', () => selectDate(button.dataset.date));
    });

    container.querySelectorAll('[data-jump]').forEach(button => {
      button.addEventListener('click', () => {
        const date = button.dataset.jump === 'tomorrow' ? addDays(new Date(), 1) : new Date();
        selectDate(formatDateOnly(date));
      });
    });

    container.querySelector('[data-clear]')?.addEventListener('click', clear);
    container.querySelector('.time-precision-toggle')?.addEventListener('click', () => {
      state.preciseOpen = !state.preciseOpen;
      render();
    });

    container.querySelectorAll('.time-precise-panel').forEach(panel => {
      const kind = panel.dataset.precise;
      panel.querySelectorAll('select').forEach(select => {
        select.addEventListener('change', () => setTime(kind, readPanelTime(panel)));
      });
      panel.querySelectorAll('[data-quick-time]').forEach(button => {
        button.addEventListener('click', () => setTime(kind, button.dataset.quickTime));
      });
    });

    container.querySelector('.time-range-close')?.addEventListener('click', () => {
      state.isOpen = false;
      render();
    });
  };

  render();

  return {
    setValue(start, end = '') {
      state.start = start || '';
      state.end = mode === 'single' ? '' : (end || '');
      state.phase = state.start && !state.end ? 'end' : 'start';
      state.monthDate = parseDate(state.start || state.end)?.date || new Date();
      render();
    },
    getValue() {
      return { startTime: state.start, endTime: state.end };
    },
    clear
  };
}

export function attachDateTimePicker(input, options = {}) {
  if (!input || input.dataset.timeRangeAttached === 'true') return null;
  input.dataset.timeRangeAttached = 'true';
  const wrapper = document.createElement('div');
  wrapper.className = 'time-input-picker';
  input.insertAdjacentElement('afterend', wrapper);
  input.classList.add('time-range-compatible-input');
  input.readOnly = true;
  const picker = createTimeRangePicker(wrapper, {
    mode: 'single',
    valueStart: input.value || options.value || '',
    onChange: (value) => {
      input.value = value || '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      options.onChange?.(value || '');
    }
  });
  input._timeRangePicker = picker;
  return picker;
}
