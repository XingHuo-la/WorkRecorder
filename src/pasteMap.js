/**
 * 内部剪贴板 → 目标列的「落点决策」。
 *
 * 单独成模块的理由：这段规则**没有一行 DOM**，全是「哪个值该写进哪一列」的判断，
 * 而它恰好是跨表粘贴最容易出错的地方（列错位、类型不兼容、一格写进两列）。
 * 放在 sheetPage 里只能靠开真窗口手点，抽出来就能在 node 里逐条断言。
 *
 * 两条语义，别混：
 *   · 同一张表内 → 按**位置**（Excel 语义：复制 A1:B2 粘到 D5 就是 D5:E6）
 *   · 跨表       → 按**列名优先**（两张表的列顺序往往不同，按位置会整块错位）
 */

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  try { return JSON.parse(JSON.stringify(value)); } catch (error) { return value; }
}

/**
 * 把源值转成目标列吃得下的形状。返回 null = 这一列吃不下，调用方应跳过。
 *
 * 跨表时两边列类型常常不同（A 表「处理方」是单选、B 表同名列是文本）。
 * 「类型兜底」就是这里：能无损转过去的就转，转不了的返回 null 让调用方跳过并提示，
 * 而不是把 `[object Object]` 写进库里。
 *
 * @param {object} field 目标字段
 * @param {string} sourceType 源字段类型
 * @param {*} value 源值
 * @returns {*} 目标值；null = 不兼容
 */
export function adaptClipValue(field, sourceType, value) {
  if (!field) return null;
  if (field.type === sourceType) return cloneValue(value);
  if (field.type === 'text') {
    if (Array.isArray(value)) {
      return value
        .map(item => (item && typeof item === 'object' ? item.name || item.path || '' : String(item ?? '')))
        .filter(Boolean)
        .join('、');
    }
    if (value == null) return '';
    if (typeof value === 'object') return '';
    return String(value);
  }
  if (field.type === 'multi_select' && (sourceType === 'select' || sourceType === 'text')) {
    const text = String(value ?? '').trim();
    return text ? [text] : [];
  }
  if (field.type === 'select' && sourceType === 'multi_select') {
    return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return null;
}

/** 跨表时按「key → 列名」找同名列；已被本次粘贴占用的列不再参与。 */
function findByName(cols, item, used) {
  const key = String(item.fieldKey || '').trim();
  if (key) {
    const hit = cols.find(field => field.key === key && !used.has(field.key));
    if (hit) return { field: hit, by: 'key' };
  }
  const label = String(item.fieldLabel || '').trim().toLowerCase();
  if (!label) return null;
  const hit = cols.find(
    field => !used.has(field.key) && String(field.label || field.key).trim().toLowerCase() === label
  );
  return hit ? { field: hit, by: 'label' } : null;
}

/**
 * 决定一「块」多格粘贴每一格落到哪一列。
 *
 * @param {object} input
 * @param {object[]} input.cols 目标表的可见列（顺序 = 屏幕顺序）
 * @param {object[]} input.items 来自剪贴板的格：`{dr, dc, fieldKey, fieldLabel, fieldType, value}`
 * @param {number} input.anchorCol 目标锚点列下标
 * @param {boolean} input.sameTable 是否同一张表
 * @returns {{targets: object[], skipped: object[], byName: number, byType: number}}
 */
export function resolveBlockTargets({ cols, items, anchorCol, sameTable }) {
  const list = Array.isArray(cols) ? cols : [];
  const used = new Set();
  const targets = [];
  const skipped = [];
  let byName = 0;
  let byType = 0;

  for (const item of items || []) {
    if (sameTable) {
      const field = list[anchorCol + item.dc] || null;
      if (!field) {
        skipped.push({ label: item.fieldLabel || '超出行范围', reason: 'edge' });
        continue;
      }
      if (field.type !== item.fieldType) {
        skipped.push({ label: field.label || field.key, reason: 'type' });
        continue;
      }
      targets.push({ dr: item.dr, dc: item.dc, field, value: cloneValue(item.value), by: 'position' });
      continue;
    }

    // ---- 跨表：列名 → 位置 → 同类型 ----
    let field = null;
    let value = null;
    let by = '';

    const named = findByName(list, item, used);
    if (named) {
      const adapted = adaptClipValue(named.field, item.fieldType, item.value);
      if (adapted !== null) {
        field = named.field;
        value = adapted;
        by = named.by;
      }
    }
    if (!field) {
      const positional = list[anchorCol + item.dc] || null;
      const candidates = [
        positional,
        ...list.filter(candidate => candidate !== positional && candidate.type === item.fieldType),
      ].filter(Boolean);
      for (const candidate of candidates) {
        if (used.has(candidate.key)) continue;
        const adapted = adaptClipValue(candidate, item.fieldType, item.value);
        if (adapted === null) continue;
        field = candidate;
        value = adapted;
        by = candidate === positional ? 'position' : 'type';
        break;
      }
    }
    if (!field) {
      skipped.push({ label: item.fieldLabel || item.fieldKey || '未知列', reason: 'type' });
      continue;
    }

    used.add(field.key);
    if (by === 'type') byType += 1;
    if (by === 'key' || by === 'label') byName += 1;
    targets.push({ dr: item.dr, dc: item.dc, field, value, by });
  }

  return { targets, skipped, byName, byType };
}

/**
 * 决定「整行粘贴」每一列取哪个值。
 *
 * key 优先（同表 / 两张表用同名 key 时最准），key 对不上再按列名找 ——
 * 跨表时两张表的同名字段往往各有各的 key（一个 status、一个 state），只认 key 会整行粘空。
 *
 * @param {object} input
 * @param {object[]} input.fields 目标表的可见列
 * @param {object} input.values 源行的 `{key: 值}`
 * @param {object|null} input.labels 源行的 `{列名: 值}`
 * @param {object|null} input.types 源行的 `{key: 类型}`
 * @param {object|null} input.labelTypes 源行的 `{列名: 类型}`
 * @param {boolean} input.crossTable 是否跨表
 * @returns {{targets: object[], skipped: string[]}}
 */
export function resolveRowTargets({ fields, values, labels, types, labelTypes, crossTable }) {
  const targets = [];
  const skipped = [];
  const has = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

  for (const field of fields || []) {
    let raw = null;
    let from = '';
    if (has(values, field.key)) {
      raw = values[field.key];
      from = field.key;
    } else if (crossTable && has(labels, String(field.label || field.key).trim())) {
      from = String(field.label || field.key).trim();
      raw = labels[from];
    }
    if (!from) {
      skipped.push(field.label || field.key);
      continue;
    }
    const sourceType = (has(types, from) ? types[from] : null)
      || (has(labelTypes, from) ? labelTypes[from] : null)
      || field.type;
    const adapted = adaptClipValue(field, sourceType, raw);
    if (adapted === null) {
      skipped.push(field.label || field.key);
      continue;
    }
    targets.push({ field, value: adapted });
  }
  return { targets, skipped };
}
