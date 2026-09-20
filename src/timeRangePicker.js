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
  const match = String(value || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  const date = new Date(yearNumber, monthNumber - 1, dayNumber);
  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== yearNumber
    || date.getMonth() !== monthNumber - 1
    || date.getDate() !== dayNumber
    || hourNumber > 23
    || minuteNumber > 59
    || secondNumber > 59
  ) return null;
  return {
    date,
    dateKey: `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    hour: pad2(hour),
    minute: pad2(minute),
    second: pad2(second),
    time: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
    hasTime: match[4] !== undefined
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
  return item.hasTime ? `${formatDateLabel(item, options)} ${item.time}` : formatDateLabel(item, options);
}

export function formatTimeRangeSummary(startValue, endValue) {
  const start = parseDate(startValue);
  const end = parseDate(endValue);
  if (!start && !end) return '无时间';
  if (start && end) {
    if (start.dateKey === end.dateKey) {
      if (!start.hasTime && !end.hasTime) return formatDateLabel(start);
      if (start.hasTime && end.hasTime) return `${formatDateLabel(start)} ${start.time} - ${end.time}`;
      return `${formatPart(startValue)} - ${formatPart(endValue)}`;
    }
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

function buildSelectOptions(max, selected, step = 1) {
  const value = Number(selected || 0);
  const values = [];
  for (let index = 0; index <= max; index += Math.max(1, step)) values.push(index);
  if (!values.includes(value) && value >= 0 && value <= max) values.push(value);
  values.sort((a, b) => a - b);
  return values.map(index => {
    const text = pad2(index);
    return `<option value="${text}"${index === value ? ' selected' : ''}>${text}</option>`;
  }).join('');
}

const QUICK_TIMES = ['00:00:00', '09:00:00', '12:00:00', '18:00:00', '23:00:00'];

function roundedWholeHour(reference = new Date()) {
  const rounded = new Date(reference);
  if (rounded.getMinutes() || rounded.getSeconds() || rounded.getMilliseconds()) {
    rounded.setHours(rounded.getHours() + 1);
  }
  rounded.setMinutes(0, 0, 0);
  return rounded;
}

function defaultWholeHour(kind = 'start') {
  if (kind === 'end') return '01:00:00';
  return `${pad2(roundedWholeHour().getHours())}:00:00`;
}

function defaultStartDateTime(dateKey = formatDateOnly(new Date())) {
  const rounded = roundedWholeHour();
  const today = formatDateOnly(new Date());
  if (dateKey === today) {
    return toDateTime(formatDateOnly(rounded), `${pad2(rounded.getHours())}:00:00`);
  }
  return toDateTime(dateKey, `${pad2(rounded.getHours())}:00:00`);
}

function addHours(value, hours = 1) {
  const related = parseDate(value);
  if (!related) return '';
  const dateTime = new Date(
    related.date.getFullYear(), related.date.getMonth(), related.date.getDate(),
    Number(related.hour), Number(related.minute), Number(related.second)
  );
  dateTime.setHours(dateTime.getHours() + hours);
  return toDateTime(formatDateOnly(dateTime), `${pad2(dateTime.getHours())}:${pad2(dateTime.getMinutes())}:${pad2(dateTime.getSeconds())}`);
}

function buildPrecisePanel(kind, value, title, options = {}) {
  const item = parseDate(value);
  const hour = item?.hour || (kind === 'end' ? '23' : '00');
  const minute = item?.minute || (kind === 'end' ? '59' : '00');
  const second = item?.second || (kind === 'end' ? '59' : '00');
  const dateOnly = Boolean(item && !item.hasTime);
  return `
    <div class="time-precise-panel${dateOnly ? ' is-date-only' : ''}" data-precise="${kind}">
      <div class="time-precise-title">
        <span>${title}</span>
        ${options.allowDateOnly ? `<button type="button" class="time-date-only-toggle${dateOnly ? ' active' : ''}" data-date-only="${kind}">${dateOnly ? '使用时间' : '仅日期'}</button>` : ''}
      </div>
      <div class="time-precise-selects">
        <select data-part="hour" ${dateOnly ? 'disabled' : ''}>${buildSelectOptions(23, hour)}</select>
        <span>:</span>
        <select data-part="minute" ${dateOnly ? 'disabled' : ''}>${buildSelectOptions(59, minute, options.minuteStep || 1)}</select>
        <span>:</span>
        <select data-part="second" ${dateOnly ? 'disabled' : ''}>${buildSelectOptions(59, second, options.secondStep || 1)}</select>
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
  const allowDateOnly = Boolean(options.allowDateOnly);
  const initial = parseDate(options.valueStart || options.valueEnd || '');
  const state = {
    start: options.valueStart || '',
    end: mode === 'single' ? '' : (options.valueEnd || ''),
    committedStart: options.valueStart || '',
    committedEnd: mode === 'single' ? '' : (options.valueEnd || ''),
    phase: options.valueStart && !options.valueEnd ? 'end' : 'start',
    isOpen: Boolean(options.open),
    preciseOpen: false,
    monthDate: initial?.date || new Date(),
    disabled: Boolean(options.disabled),
    error: ''
  };
  let globalListenersBound = false;

  const emit = () => {
    if (mode === 'range') {
      options.onChange?.(state.start, state.end);
    } else {
      options.onChange?.(state.start, '');
    }
  };

  const commit = () => {
    if (mode === 'range' && state.start && state.end) {
      const start = parseDate(state.start);
      const end = parseDate(state.end);
      const startComparable = start?.hasTime ? state.start : `${state.start} 00:00:00`;
      const endComparable = end?.hasTime ? state.end : `${state.end} 23:59:59`;
      if (start && end && new Date(startComparable.replace(' ', 'T')) > new Date(endComparable.replace(' ', 'T'))) {
        state.error = '结束时间不能早于开始时间。';
        render();
        return false;
      }
    }
    state.error = '';
    state.committedStart = state.start;
    state.committedEnd = state.end;
    emit();
    return true;
  };

  const cancel = () => {
    state.start = state.committedStart;
    state.end = state.committedEnd;
    state.phase = state.start && !state.end && mode === 'range' ? 'end' : 'start';
    state.isOpen = false;
    state.error = '';
    render();
  };

  const clear = () => {
    state.start = '';
    state.end = '';
    state.phase = 'start';
    state.error = '';
    render();
  };

  const selectDate = (dateKey) => {
    if (mode === 'single') {
      const current = parseDate(state.start);
      state.start = current && !current.hasTime && allowDateOnly
        ? dateKey
        : current?.time ? toDateTime(dateKey, current.time) : defaultStartDateTime(dateKey);
      state.monthDate = parseDate(state.start).date;
      render();
      return;
    }

    if (state.phase === 'start') {
      const currentStart = parseDate(state.start);
      state.start = currentStart && !currentStart.hasTime && allowDateOnly
        ? dateKey
        : currentStart?.time ? toDateTime(dateKey, currentStart.time) : defaultStartDateTime(dateKey);
      state.end = addHours(state.start, 1);
      state.phase = 'end';
    } else {
      const currentStart = parseDate(state.start);
      if (currentStart && dateKey < currentStart.dateKey) {
        const previousStart = state.start;
        state.start = currentStart.hasTime ? toDateTime(dateKey, currentStart.time) : dateKey;
        state.end = previousStart;
      } else {
        const suggestedEnd = parseDate(addHours(state.start, 1));
        const currentEnd = parseDate(state.end);
        state.end = currentEnd && !currentEnd.hasTime && allowDateOnly
          ? dateKey
          : toDateTime(dateKey, currentEnd?.time || suggestedEnd?.time || defaultWholeHour('end'));
      }
      state.phase = 'start';
    }
    state.error = '';
    state.monthDate = parseDate(dateKey)?.date || parseDate(state.start || state.end).date;
    render();
  };

  const setTime = (kind, time) => {
    if (kind === 'end' && mode === 'range' && !state.start) {
      state.start = defaultStartDateTime();
    }
    const target = kind === 'end' ? state.end : state.start;
    const suggestedEnd = kind === 'end' ? parseDate(addHours(state.start, 1)) : null;
    const fallbackDate = parseDate(target)?.dateKey || suggestedEnd?.dateKey || parseDate(state.start)?.dateKey || formatDateOnly(new Date());
    if (kind === 'end' && mode === 'range') state.end = toDateTime(fallbackDate, time);
    else state.start = toDateTime(fallbackDate, time);
    if (kind === 'start' && mode === 'range' && state.end) {
      const end = parseDate(state.end);
      const nextEnd = parseDate(addHours(state.start, 1));
      if (end && nextEnd && new Date(state.end.replace(' ', 'T')) <= new Date(state.start.replace(' ', 'T'))) state.end = addHours(state.start, 1);
    }
    state.error = '';
    render();
  };

  const toggleDateOnly = (kind) => {
    if (!allowDateOnly) return;
    if (kind === 'end' && mode === 'range' && !state.start) {
      state.start = defaultStartDateTime();
    }
    const target = kind === 'end' ? state.end : state.start;
    const suggested = kind === 'end' ? addHours(state.start, 1) : '';
    const item = parseDate(target || suggested);
    const dateKey = item?.dateKey || formatDateOnly(new Date());
    if (item && !item.hasTime) {
      const time = kind === 'end'
        ? (parseDate(addHours(state.start, 1))?.time || defaultWholeHour('end'))
        : defaultWholeHour('start');
      if (kind === 'end' && mode === 'range') state.end = toDateTime(dateKey, time);
      else state.start = toDateTime(dateKey, time);
    } else if (kind === 'end' && mode === 'range') {
      state.end = dateKey;
    } else {
      state.start = dateKey;
    }
    state.error = '';
    render();
  };

  const readPanelTime = (panel) => {
    const hour = panel.querySelector('[data-part="hour"]')?.value || '00';
    const minute = panel.querySelector('[data-part="minute"]')?.value || '00';
    const second = panel.querySelector('[data-part="second"]')?.value || '00';
    return `${hour}:${minute}:${second}`;
  };

  const handleOutsidePointer = (event) => {
    if (state.isOpen && !container.contains(event.target)) cancel();
  };

  const handleGlobalKeydown = (event) => {
    if (state.isOpen && event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  };

  const syncGlobalListeners = () => {
    if (state.isOpen && !globalListenersBound) {
      document.addEventListener('pointerdown', handleOutsidePointer);
      document.addEventListener('keydown', handleGlobalKeydown);
      globalListenersBound = true;
    } else if (!state.isOpen && globalListenersBound) {
      document.removeEventListener('pointerdown', handleOutsidePointer);
      document.removeEventListener('keydown', handleGlobalKeydown);
      globalListenersBound = false;
    }
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
      <div class="time-range-popover${state.isOpen ? ' open' : ''}" ${state.isOpen ? '' : 'hidden'} role="dialog" aria-label="选择日期和时间">
        <div class="time-picker-main">
          <div class="time-calendar-pane">
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
          </div>
          <div class="time-clock-pane">
            <div class="time-clock-heading">精确时间 <span>时 : 分 : 秒</span></div>
            <div class="time-precise-wrap open">
              ${buildPrecisePanel('start', state.start, mode === 'single' ? '时间' : '开始时间', { allowDateOnly, minuteStep: options.minuteStep, secondStep: options.secondStep })}
              ${mode === 'range' ? buildPrecisePanel('end', state.end, '结束时间', { allowDateOnly, minuteStep: options.minuteStep, secondStep: options.secondStep }) : ''}
            </div>
          </div>
        </div>
        <div class="time-range-toolbar">
          <div class="time-range-mini-actions">
            <button type="button" data-jump="today">今天</button>
            <button type="button" data-jump="tomorrow">明天</button>
            <button type="button" data-clear>清空草稿</button>
          </div>
          <span class="time-range-selection-preview"><small>待确认</small>${summary}</span>
        </div>
        ${state.error ? `<div class="time-range-error" role="alert">${state.error}</div>` : ''}
        <div class="time-range-footer">
          <button type="button" class="btn btn-secondary time-range-cancel">取消</button>
          <button type="button" class="btn btn-primary time-range-confirm">确定</button>
        </div>
      </div>
    `;

    const popover = container.querySelector('.time-range-popover');
    if (state.isOpen && popover && !container.closest('.custom-modal')) {
      requestAnimationFrame(() => {
        if (!state.isOpen || !popover.isConnected) return;
        popover.classList.toggle('align-end', popover.getBoundingClientRect().right > window.innerWidth - 12);
      });
    }

    container.querySelector('.time-range-summary')?.addEventListener('click', () => {
      if (state.disabled) return;
      if (state.isOpen) {
        cancel();
        return;
      }
      state.start = state.committedStart;
      state.end = state.committedEnd;
      if (!state.start && !state.end) {
        state.start = defaultStartDateTime();
        if (mode === 'range') state.end = addHours(state.start, 1);
        state.monthDate = parseDate(state.start)?.date || new Date();
      }
      state.phase = state.start && !state.end && mode === 'range' ? 'end' : 'start';
      state.error = '';
      state.isOpen = true;
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
    container.querySelectorAll('[data-date-only]').forEach(button => {
      button.addEventListener('click', () => toggleDateOnly(button.dataset.dateOnly));
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

    container.querySelector('.time-range-cancel')?.addEventListener('click', cancel);
    container.querySelector('.time-range-confirm')?.addEventListener('click', () => {
      if (!commit()) return;
      state.isOpen = false;
      render();
    });
    syncGlobalListeners();
  };

  render();

  return {
    setValue(start, end = '') {
      state.start = start || '';
      state.end = mode === 'single' ? '' : (end || '');
      state.committedStart = state.start;
      state.committedEnd = state.end;
      state.phase = state.start && !state.end ? 'end' : 'start';
      state.monthDate = parseDate(state.start || state.end)?.date || new Date();
      state.error = '';
      render();
    },
    getValue() {
      return { startTime: state.committedStart, endTime: state.committedEnd };
    },
    clear() {
      state.start = '';
      state.end = '';
      state.committedStart = '';
      state.committedEnd = '';
      state.phase = 'start';
      state.error = '';
      emit();
      render();
    },
    destroy() {
      state.isOpen = false;
      syncGlobalListeners();
      container.innerHTML = '';
    }
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
    allowDateOnly: Boolean(options.allowDateOnly),
    minuteStep: options.minuteStep,
    secondStep: options.secondStep,
    disabled: Boolean(options.disabled),
    onChange: (value) => {
      input.value = value || '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      options.onChange?.(value || '');
    }
  });
  input._timeRangePicker = picker;
  return picker;
}
