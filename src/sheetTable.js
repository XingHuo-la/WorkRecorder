// 表格的 DOM 渲染层（纯字符串拼装，不含状态）。
//
// 只做三件事：算列宽、拼表头、拼一行。
// 数据、事件、分块加载都由 sheetPage.js 管，这样渲染函数可以被复用
// （调试壳直接拿它渲染演示数据，不用起 Tauri）。

import { escapeHtml } from './htmlUtils.js';
import { renderFieldIcon, renderCell, isDateOnly } from './fieldTypes.js';

const INDEX_WIDTH = 52;
const ADD_COL_WIDTH = 44;
// 每列的最小可用宽度：列多到装不下时才允许横向滚动，而不是一上来就溢出。
// 96px 是"十列硬塞进 1360"的极限，表头会被截成"业…""解…"；130px 才能让
// 四字字段名完整显示，代价是横向滚动 —— 宁可滚动也不要读不懂的列。
const MIN_COL_WIDTH = 130;

export function visibleOf(fields) {
  return fields.filter(field => Number(field.visible) !== 0);
}

export function fieldWidth(field) {
  return Number(field.width) || 160;
}

// 注意：这里返回的是「允许的最小宽度」，不是列宽之和。
// 列宽本身改成百分比（见 buildColgroup），表格永远铺满容器、不横向溢出；
// 只有当列多到每列不足 MIN_COL_WIDTH 时，才需要横向滚动。
export function tableWidth(fields) {
  return visibleOf(fields).length * MIN_COL_WIDTH + INDEX_WIDTH + ADD_COL_WIDTH;
}

export function buildColgroup(fields) {
  const visible = visibleOf(fields);
  // field.width 从「像素」变成「权重」：渲染时归一化成百分比。
  // 好处是无论窗口多宽、有多少列，表格都正好等于容器宽度；
  // 用户拖过的相对宽度仍然保留（权重比例不变）。
  const total = visible.reduce((sum, field) => sum + fieldWidth(field), 0) || 1;
  const cols = visible.map(field => {
    const pct = (fieldWidth(field) / total) * 100;
    return `<col style="width:${pct.toFixed(4)}%" />`;
  });
  return `<colgroup><col style="width:${INDEX_WIDTH}px" />${cols.join('')}<col style="width:${ADD_COL_WIDTH}px" /></colgroup>`;
}

// 表头：文字在左、类型图标在右。
// 图标放右边是有原因的 —— 放左边会把字段名整体右推近 20px，
// 下面数据没有图标，两者永远差半个字，看着就是「歪」的。
export function buildHead(fields) {
  const visible = visibleOf(fields);
  const cells = visible
    .map(
      field => `<th class="sh-th${field.type === 'number' ? ' sh-th-num' : ''}" data-key="${escapeHtml(field.key)}">
        <button type="button" class="sh-th-btn" data-key="${escapeHtml(field.key)}" aria-haspopup="true" aria-expanded="false">
          <span class="sh-th-label">${escapeHtml(field.label)}</span>
          <span class="sh-th-type" aria-hidden="true">${renderFieldIcon(field.type)}</span>
        </button>
        <span class="sh-col-resizer" data-resize="${escapeHtml(field.key)}" title="拖动调整列宽，双击自适应"></span>
      </th>`
    )
    .join('');
  return `<tr>
    <th class="sh-th sh-th-index"><span aria-hidden="true">#</span></th>
    ${cells}
    <th class="sh-th sh-th-add"><button type="button" class="sh-th-add-btn" title="添加字段" aria-label="添加字段">＋</button></th>
  </tr>`;
}

export function isWrap(field) {
  try {
    const parsed = field?.options ? (typeof field.options === 'string' ? JSON.parse(field.options) : field.options) : null;
    return Boolean(parsed && parsed.wrap);
  } catch (error) {
    return false;
  }
}

// 单元格格式：列默认存在 field.options.format，单格覆盖存在 row.values.__fmt[字段key]。
// 两层合并，单格优先。存 JSON，不需要数据库迁移。
export function fieldFormat(field) {
  try {
    const parsed = field?.options ? (typeof field.options === 'string' ? JSON.parse(field.options) : field.options) : null;
    return parsed && parsed.format && typeof parsed.format === 'object' ? parsed.format : {};
  } catch (error) {
    return {};
  }
}

export function cellFormat(row, field) {
  const override = row?.values?.__fmt?.[field.key];
  return { ...fieldFormat(field), ...(override && typeof override === 'object' ? override : {}) };
}

const HEX = /^#[0-9a-f]{6}$/i;
export function isHexColor(value) {
  return typeof value === 'string' && HEX.test(value);
}

export function buildCell(field, row, ctx = {}) {
  const value = row.values ? row.values[field.key] : undefined;
  const fmt = ctx.format || cellFormat(row, field);
  // 单格换行设置优先；没设过才回落到列开关
  const wrap = fmt.wrap === undefined ? field.type === 'text' && isWrap(field) : fmt.wrap === true;
  const col = ctx.colIndex == null ? '' : ` data-col="${ctx.colIndex}"`;
  const rowIndex = ctx.rowIndex == null ? '' : ` data-rowindex="${ctx.rowIndex}"`;
  // 行高被用户固定时，换行文字按可用高度算能放几行，剩下的用省略号收尾
  const fixedHeight = Number(ctx.rowHeight) || 0;
  const clamp = wrap && fixedHeight > 0 ? Math.max(1, Math.floor((fixedHeight - 18) / 21)) : 0;
  const styles = [];
  if (clamp) styles.push(`--clamp:${clamp}`);
  // 底色走 CSS 变量：选区高亮用 background-image 叠加，不会把用户底色盖掉
  if (isHexColor(fmt.bg)) styles.push(`--cell-bg:${fmt.bg}`);
  const classes = ['sh-cell', wrap ? 'is-wrap' : '', clamp ? 'is-clamped' : '', fmt.h ? `is-h-${fmt.h}` : '', fmt.v ? `is-v-${fmt.v}` : '']
    .filter(Boolean)
    .join(' ');
  const style = styles.length ? ` style="${styles.join(';')}"` : '';
  return `<div class="${classes}" data-key="${escapeHtml(field.key)}" data-row="${escapeHtml(
    row.id
  )}"${col}${rowIndex}${style} tabindex="-1">${renderCell(field, value, ctx)}</div>`;
}

export function buildRow(row, fields, index) {
  const visible = visibleOf(fields);
  const rowHeight = Number(row.height) || 0;
  const cells = visible
    .map(
      (field, colIndex) =>
        `<td class="sh-td" data-key="${escapeHtml(field.key)}">${buildCell(field, row, {
          colIndex,
          rowIndex: index - 1,
          rowHeight,
        })}</td>`
    )
    .join('');
  const trStyle = rowHeight ? ` style="height:${rowHeight}px"` : '';
  return `<tr class="sh-row" data-id="${escapeHtml(row.id)}"${trStyle}>
    <td class="sh-td sh-td-index">
      <div class="sh-index-cell">
        <button type="button" class="sh-rownum" data-row="${escapeHtml(row.id)}" title="单击选中行，右键行菜单，双击打开详情">${index}</button>
      </div>
    </td>
    ${cells}
    <td class="sh-td sh-td-add"></td>
  </tr>`;
}

// 自适应列宽：按内容量一遍，返回建议宽度。
// 用 canvas 量文字比插临时 DOM 快，也不触发重排。
let measureCtx = null;

function measure(text, font) {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    measureCtx = canvas.getContext('2d');
  }
  measureCtx.font = font || '13.5px system-ui, sans-serif';
  return measureCtx.measureText(text).width;
}

export function autoFitWidth(field, rows, options = []) {
  let widest = measure(String(field.label || ''), '600 11.5px system-ui, sans-serif') + 54; // 标签 + 类型图标 + 内边距
  const labelOf = value => {
    const hit = options.find(item => String(item.value) === String(value));
    return hit ? hit.label : value;
  };

  rows.slice(0, 200).forEach(row => {
    const value = row.values?.[field.key];
    if (value == null || value === '') return;
    let text = '';
    if (field.type === 'select') text = String(labelOf(value));
    else if (field.type === 'multi_select') {
      text = (Array.isArray(value) ? value : String(value).split(',')).map(labelOf).join('、');
    } else if (field.type === 'checkbox') text = value ? '已勾选' : '';
    else if (field.type === 'attachment') text = Array.isArray(value) && value.length ? '图片'.repeat(Math.min(value.length, 3)) : '';
    else if (field.type === 'date') {
      const raw = String(value);
      text = isDateOnly(field) ? raw.slice(5, 10) : `${raw.slice(5, 10)} ${raw.slice(11, 16)}`.trim();
    } else text = String(value);

    const width = measure(text) + (field.type === 'attachment' ? 130 : 26);
    if (width > widest) widest = width;
  });

  return Math.max(84, Math.min(520, Math.round(widest)));
}
