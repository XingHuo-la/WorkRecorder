// 剪贴板表格导入：预览 → 建列 → 落图 → 写行。
//
// 与「单元格粘贴」的分工：
//   sheetPage 负责「有落点」的粘贴（选中 A1 就原地铺开，Excel 语义）；
//   本模块负责「没有落点」的导入（空表、没有选中格、要新建列）——
//   因为它必须先问一句「这 12 列叫什么、什么类型」，不能靠猜。
//
// 三条硬约束：
//   ① clipboardData 出了 paste 回调就失效 → 调用方必须传快照（snapshotClipboard）。
//   ② 图片链接有时效（WPS 的 kdocs 地址几小时就废）→ 必须落地，失败要如实报数。
//   ③ 建列/建行是**结构改动**，中途失败要能回滚，否则会留下「12 个空列」。

import { escapeHtml } from './htmlUtils.js';
import {
  buildColumnDescriptors,
  cleanColumnName,
  normalizeDateText,
  isNumericText,
} from './clipboardTable.js';
import { filesFromDataTransfer, importImageSources } from './attachmentOps.js';
import {
  createTableField,
  deleteTableField,
  patchTableField,
  touchSheet,
  fieldOptionsList,
  insertRowsBulk,
  deleteRowsBulk,
  ensureCreatedAtField,
  CREATED_AT_KEY,
  CREATED_AT_LABEL,
} from './sheetStore.js';
import { FIELD_TYPE_LABELS } from './fieldTypes.js';

// 一次导入最多多少行。
//
// 时间上根本不必设这个上限：每条 +1 微秒，2000 行只吃掉 2 毫秒，
// 离「向未来借 500ms」的预算差两个数量级。这个数字是**渲染与写库**的上限：
// 再多，表格首屏要画的行数会让界面明显发顿，用户也分不清是导入慢还是应用卡。
export const IMPORT_ROW_LIMIT = 2000;

const TYPE_OPTIONS = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'attachment'];

// ==========================================
// 一、剪贴板快照
// ==========================================

/**
 * 把 DataTransfer 拍成纯数据。
 * ⚠️ 必须在 paste 事件回调里同步调用：回调一结束，getData 就返回空串了，
 * 而导入流程要 await 用户点「导入」。
 */
export function snapshotClipboard(dataTransfer) {
  if (!dataTransfer) return { files: [], text: '', html: '', types: [] };
  const { files } = filesFromDataTransfer(dataTransfer);
  let html = '';
  let text = '';
  try { html = dataTransfer.getData('text/html') || ''; } catch (error) { html = ''; }
  try { text = dataTransfer.getData('text/plain') || ''; } catch (error) { text = ''; }
  return { files, text, html, types: [...(dataTransfer.types || [])] };
}

/** 这块内容是不是「二维表格」（而不是一段文本 / 一张图）。 */
export function looksTabular(snapshot) {
  if (!snapshot) return false;
  if (/<table[\s>]/i.test(String(snapshot.html || ''))) return true;
  return /\t|\n/.test(String(snapshot.text || ''));
}

// ==========================================
// 二、值转换
// ==========================================

/**
 * 单元格 → 字段值。
 * 返回值有三种语义，调用方必须分清：
 *   undefined = 这一格空着，不写（别把 null 写进库）
 *   null      = 这一列收不下这种内容（文本粘不进附件列）
 *   其他      = 真正要写的值
 */
export function coerceImportValue(field, cell, images) {
  if (!field) return null;
  const type = field.type || 'text';
  const text = String(cell?.text ?? '').trim();
  const imageList = (cell?.images || [])
    .map(image => images?.get(image.src))
    .filter(Boolean);

  if (type === 'attachment') {
    if (!imageList.length) return null;
    return imageList;
  }
  if (!text) return undefined;

  if (type === 'number') {
    if (!isNumericText(text)) return text; // 认不出来就原样存，别把「约 3 元」变成 NaN
    return Number(text.replace(/,/g, '').replace(/^[¥$€£]\s*/, ''));
  }
  if (type === 'date') {
    return normalizeDateText(text) || text;
  }
  if (type === 'checkbox') {
    return /^(是|✓|√|☑|true|True|TRUE|1|y|yes)$/.test(text);
  }
  if (type === 'multi_select') {
    return text.split(/[,，、;；]/).map(part => part.trim()).filter(Boolean);
  }
  if (type === 'select') {
    const options = fieldOptionsList(field) || [];
    const hit = options.find(option =>
      String(option.label) === text || String(option.value) === text);
    return hit ? hit.value : text;
  }
  return text;
}

/**
 * 新建列时要带上的字段配置。
 *
 * 单选/多选列光有类型没有选项，等于给用户一个空下拉 —— 导入时把这一列出现过的
 * 值直接变成选项，改完类型就能用。日期列同理：整列都没有时分，就别让选择器
 * 每次多问一句「几点」。
 * @returns {object|null} 交给 createTableField 的 options
 */
export function optionsForColumn(type, cells) {
  const list = Array.isArray(cells) ? cells : [];
  if (type === 'select' || type === 'multi_select') {
    const seen = new Map();
    list.forEach(cell => {
      const text = String(cell?.text || '').trim();
      if (!text) return;
      const parts = type === 'multi_select'
        ? text.split(/[,，、;；]/).map(part => part.trim()).filter(Boolean)
        : [text];
      parts.forEach(part => {
        if (seen.has(part) || seen.size >= 60) return;
        seen.set(part, { value: part, label: part });
      });
    });
    return seen.size ? { source: 'custom', options: [...seen.values()] } : null;
  }
  if (type === 'date') {
    const values = list.map(cell => String(cell?.text || '').trim()).filter(Boolean);
    // 一个带时分的都没有 → 这一列只到日
    if (values.length && values.every(text => !/\d{1,2}:\d{2}/.test(text))) return { dateOnly: true };
  }
  return null;
}

// ==========================================
// 三、就地粘贴：把一块内容算成 changes（不改库、不改 DOM）
// ==========================================

/**
 * 给 sheetPage 的原地粘贴用：算出每一格该写什么，图片在这里落地。
 * 只算不写 —— 写库与撤销登记归 sheetPage（那里才有 rowWriteChains / undoStack）。
 *
 * @returns {Promise<{changes:Array, filled:number, skipped:number, failedImages:number}>}
 */
export async function buildBlockChanges({ model, fields, rows, anchorRow, anchorCol, onProgress }) {
  // 只下「会真正用上」的图：落在文本列上的图收不下，下载 58 张再丢掉纯属白等。
  const sources = [];
  (model.rows || []).forEach((row, i) => row.forEach((cell, j) => {
    if (fields[anchorCol + j]?.type !== 'attachment') return;
    if (!rows[anchorRow + i]) return;
    (cell.images || []).forEach(image => { if (image.src) sources.push(image.src); });
  }));
  const { items: images, failures } = await importImageSources(sources, { onProgress });

  const changes = [];
  let filled = 0;
  let skipped = 0;
  for (let i = 0; i < model.rows.length; i += 1) {
    const row = rows[anchorRow + i];
    for (let j = 0; j < model.rows[i].length; j += 1) {
      const field = fields[anchorCol + j];
      const cell = model.rows[i][j];
      if (!row || !field) { skipped += 1; continue; }
      const value = coerceImportValue(field, cell, images);
      if (value === undefined) continue;
      if (value === null) { skipped += 1; continue; }
      changes.push({ row, field, before: row.values[field.key], after: value });
      filled += 1;
    }
  }
  return { changes, filled, skipped, failedImages: failures.length };
}

// ==========================================
// 四、导入预览
// ==========================================

function buildPlan({ model, fields, mode, header = model.header }) {
  const descriptors = buildColumnDescriptors(model.rows, header);
  return descriptors.map((desc, index) => {
    const field = index < fields.length ? fields[index] : null;
    let action;
    if (mode === 'preset') action = field ? 'reuse' : 'skip';
    else if (mode === 'create') action = 'create';
    else action = field ? 'reuse' : 'create';
    return {
      index,
      action,
      field,
      originField: field,
      desc,
      name: action === 'reuse' && field ? String(field.label || '') : desc.name,
      type: action === 'reuse' && field ? field.type : desc.type,
      nameDirty: false,
      typeDirty: false,
    };
  });
}

function typeSelectHtml(col) {
  const disabled = col.action !== 'create' ? ' disabled' : '';
  // 创建时间是结构列，类型恒为 date（它不建列，这里只是别显示成「文本」误导人）
  const value = col.action === 'created-at'
    ? 'date'
    : (col.action === 'create' ? col.type : (col.field?.type || 'text'));
  const options = TYPE_OPTIONS.map(type =>
    `<option value="${type}" ${type === value ? 'selected' : ''}>${escapeHtml(FIELD_TYPE_LABELS[type] || type)}</option>`
  ).join('');
  // 复用列的类型是既有字段决定的，不让在导入弹层里改 —— 改类型会波及已有数据
  return `<select class="sh-imp-type" data-imp-type="${col.index}"${disabled}>${options}</select>`;
}

// 「作为创建时间」这一项：
//
// 起因：粘贴过来的数据里常常本来就有一列创建时间，而 record.created_at 是
// 结构列（有唯一索引、按微秒定宽），不能当普通字段收。以前只能「自动补」，
// 用户手里那份真实时间就丢了。选中它之后，这一列的值直接写进 record.created_at
// （规范化 + 去重 + 避开库里已有值，见 sheetStore 的 resolveStamps）。
//
// 同一时刻只允许一列认领：两列都写同一个结构列是在制造歧义。
function actionSelectHtml(col, mode, claimedIndex) {
  const reuse = col.field
    ? `<option value="reuse" ${col.action === 'reuse' ? 'selected' : ''}>复用「${escapeHtml(col.field.label || '')}」</option>`
    : '';
  const create = mode === 'preset'
    ? ''
    : `<option value="create" ${col.action === 'create' ? 'selected' : ''}>新建列</option>`;
  const takenByOther = claimedIndex != null && claimedIndex !== col.index;
  const createdAt = takenByOther
    ? ''
    : `<option value="created-at" ${col.action === 'created-at' ? 'selected' : ''}>作为「创建时间」</option>`;
  const skip = `<option value="skip" ${col.action === 'skip' ? 'selected' : ''}>不导入</option>`;
  return `<select class="sh-imp-act" data-imp-act="${col.index}">${reuse}${create}${createdAt}${skip}</select>`;
}

// 这一列在预览里叫什么。创建时间不建列，它的显示名是固定的。
function columnLabel(col) {
  if (col.action === 'created-at') return CREATED_AT_LABEL;
  return col.name || `列${col.index + 1}`;
}

function columnRowHtml(col, mode, claimedIndex) {
  const desc = col.desc || {};
  const sample = desc.samples?.length
    ? desc.samples.join('、')
    : (desc.imageCount ? `${desc.imageCount} 格有图片` : '（空列）');
  const nameDisabled = col.action === 'create' ? '' : ' disabled';
  const nameValue = col.action === 'created-at' ? CREATED_AT_LABEL : (col.name || '');
  return `<div class="sh-imp-col${col.action === 'skip' ? ' is-skip' : ''}" data-imp-col="${col.index}">
    <span class="sh-imp-idx">${col.index + 1}</span>
    <input class="sh-imp-name" data-imp-name="${col.index}" value="${escapeHtml(nameValue)}"${nameDisabled} spellcheck="false" />
    ${typeSelectHtml(col)}
    ${actionSelectHtml(col, mode, claimedIndex)}
    <span class="sh-imp-sample" title="${escapeHtml(sample)}">${escapeHtml(sample)}</span>
  </div>`;
}

function columnsHtml(plan, mode) {
  // 谁已经认领了创建时间 —— 下拉里要把这一项从其它列上摘掉
  const claimed = plan.find(col => col.action === 'created-at');
  return plan.map(col => columnRowHtml(col, mode, claimed ? claimed.index : null)).join('');
}

function dataPreviewHtml(plan, matrix, header) {
  const rows = header ? matrix.slice(1) : matrix;
  const show = rows.slice(0, 6);
  const cells = plan.map(col => col.index);
  const head = `<tr><th class="sh-imp-th-idx"></th>${plan
    .map(col => `<th>${escapeHtml(col.action === 'skip' ? '—' : columnLabel(col))}</th>`)
    .join('')}</tr>`;
  const body = show.map(row => {
    const tds = cells.map(index => {
      const cell = row[index] || { text: '', images: [] };
      const text = String(cell.text || '').replace(/\s+/g, ' ').trim();
      const imgBadge = cell.images?.length ? `<span class="sh-imp-img">图×${cell.images.length}</span>` : '';
      const shown = text.length > 28 ? `${text.slice(0, 28)}…` : text;
      return `<td>${imgBadge}${escapeHtml(shown)}</td>`;
    }).join('');
    return `<tr><td class="sh-imp-td-idx"></td>${tds}</tr>`;
  }).join('');
  const more = rows.length > show.length
    ? `<tr><td class="sh-imp-td-idx"></td><td colspan="${plan.length}" class="sh-imp-more">…还有 ${rows.length - show.length} 行</td></tr>`
    : '';
  return `<table class="sh-imp-table"><thead>${head}</thead><tbody>${body}${more}</tbody></table>`;
}

function noticeOf({ mode, fields, model }) {
  if (mode === 'create') {
    const hidden = fields.length
      ? `，原有的 ${fields.length} 个空列会自动隐藏（可在「字段」里找回，不会删除）`
      : '';
    return `这张表还没有数据：将按源表格新建 ${model.cols} 列${hidden}。`;
  }
  if (mode === 'preset') {
    const extra = Math.max(0, model.cols - fields.length);
    return extra
      ? `预置表只有 ${fields.length} 列：右侧 ${extra} 列会被跳过（预置表不自动建列）。`
      : `将按现有 ${fields.length} 列的顺序写入。`;
  }
  const extra = Math.max(0, model.cols - fields.length);
  return extra
    ? `前 ${fields.length} 列对应现有列，右侧 ${extra} 列将新建。`
    : '内容将按列顺序写入这张表。';
}

/**
 * 打开导入预览。
 *
 * ctx = {
 *   table, fields, rows,          // 当前表（fields/rows 可以是空数组）
 *   model,                        // parseClipboardPayload 的产物
 *   toast,
 *   onDone(result)                // 写完之后由宿主刷新 + 登记撤销
 * }
 */
export function openImportPreview({ table, fields = [], rows = [], model, toast, onDone }) {
  if (typeof window.showModal !== 'function') { toast?.('当前环境不支持导入', 'danger'); return; }
  if (!model?.rows?.length) { toast?.('剪贴板里没有可导入的表格', 'info'); return; }
  // 超限直接拦在预览之前：让用户先看到「要分几次」，而不是等他在这个弹层里
  // 逐列配完 12 列、点了导入才被拒。
  if (Number(model.dataRows) > IMPORT_ROW_LIMIT) {
    const times = Math.ceil(Number(model.dataRows) / IMPORT_ROW_LIMIT);
    toast?.(
      `一次最多导入 ${IMPORT_ROW_LIMIT} 行，这次有 ${model.dataRows} 行 —— 请分 ${times} 次粘贴`,
      'danger'
    );
    return;
  }

  const isPreset = String(table?.kind || '') === 'preset';
  // 空表 + 块比表宽 → 按源结构重建列（新表默认带「名称/备注」两个空壳列，
  // 直接复用它们会把「时间」塞进「名称」里，那比多建两列更糟）
  const mode = isPreset
    ? 'preset'
    : (rows.length === 0 && model.cols > fields.length ? 'create' : 'extend');

  const plan = buildPlan({ model, fields, mode });
  const state = { header: model.header, plan, mode, model };
  activeView = state;

  const shell = () => `<div class="sh-imp">
    <div class="sh-imp-top">
      <div class="sh-imp-sum">
        <strong>${model.dataRows}</strong> 行 × <strong>${model.cols}</strong> 列${
          model.imageCount ? ` · <span class="sh-imp-imgs">${model.imageCount} 张图片</span>` : ''
        }
      </div>
      <label class="sh-imp-check">
        <input type="checkbox" data-imp-header ${state.header ? 'checked' : ''} />
        <span>首行作为列标题</span>
      </label>
    </div>
    <div class="sh-imp-tip">${escapeHtml(noticeOf({ mode, fields, model }))}</div>
    <div class="sh-imp-cols" data-imp-cols>${columnsHtml(state.plan, mode)}</div>
    <div class="sh-imp-data" data-imp-data>${dataPreviewHtml(state.plan, model.rows, state.header)}</div>
    <div class="sh-imp-note" data-imp-note>${
      model.lostImages
        ? `有 ${model.lostImages} 张图片只拿到了占位符：当前剪贴板没有提供图片数据，这部分无法导入。`
        : '图片会保存到本地资源目录（源链接有时效，不能直接引用）'
    }</div>
  </div>`;

  window.showModal('从剪贴板导入', shell(), bodyEl => {
    bodyEl.addEventListener('change', event => {
      const headerBox = event.target.closest('[data-imp-header]');
      if (headerBox) {
        state.header = headerBox.checked;
        // 只重算「没被用户改过」的名字和类型：勾一下表头就抹掉刚敲的列名太气人了
        const next = buildPlan({ model, fields, mode, header: state.header });
        state.plan.forEach((col, index) => {
          const fresh = next[index];
          if (!fresh) return;
          if (!col.nameDirty && col.action !== 'reuse') col.name = fresh.name;
          if (!col.typeDirty && col.action !== 'reuse') col.type = fresh.type;
          col.desc = fresh.desc;
        });
        refresh(bodyEl);
        return;
      }
      const act = event.target.closest('[data-imp-act]');
      if (act) {
        const col = state.plan[Number(act.dataset.impAct)];
        if (!col) return;
        col.action = act.value;
        if (col.action === 'reuse' && col.field) {
          col.name = String(col.field.label || '');
          col.type = col.field.type;
        }
        refresh(bodyEl);
        return;
      }
      const typeBox = event.target.closest('[data-imp-type]');
      if (typeBox) {
        const col = state.plan[Number(typeBox.dataset.impType)];
        if (!col) return;
        col.type = typeBox.value;
        col.typeDirty = true;
      }
    });

    bodyEl.addEventListener('input', event => {
      const nameBox = event.target.closest('[data-imp-name]');
      if (!nameBox) return;
      const col = state.plan[Number(nameBox.dataset.impName)];
      if (!col) return;
      col.name = cleanColumnName(nameBox.value);
      col.nameDirty = true;
    });
  }, async bodyEl => {
    const note = bodyEl.querySelector('[data-imp-note]');
    const setNote = text => { if (note) note.textContent = text; };

    // 写库与刷新必须分开 try：写库失败要回滚，**写库成功之后绝不能再回滚** ——
    // 刷新/重绘出个错就把刚导进来的 44 行删掉，比什么都不做还糟。
    let result;
    try {
      result = await executeImport({
        table, model, plan: state.plan, header: state.header, fields, mode, setNote,
      });
    } catch (error) {
      // 写库层已经把自己建的列/行回滚掉了，这里只负责复位界面上的引用。
      // 弹层不关，用户可以再试一次 —— 但 plan 里指向刚被删掉的列的引用必须复位，
      // 否则第二次会往一个不存在的字段 key 里写值（静默丢数据）。
      state.plan.forEach(col => {
        if (col.action === 'create') col.field = col.originField;
      });
      const message = String(error?.message || error);
      setNote(`导入失败：${message}`);
      toast?.(`导入失败：${message}`, 'danger');
      return false;
    }

    try {
      await onDone?.(result);
    } catch (error) {
      // 数据已经在库里了，这里只能如实报「刷新失败」，让用户手动切一下页面
      toast?.(`已导入 ${result.rowCount} 行，但刷新列表失败：${error?.message || error}`, 'danger');
    }
    const bits = [`已导入 ${result.rowCount} 行`];
    if (result.createdFields.length) bits.push(`新建 ${result.createdFields.length} 列`);
    if (result.failedImages) bits.push(`${result.failedImages} 张图片没能保存`);
    toast?.(bits.join('，'), result.failedImages ? 'info' : 'success');
    return true;
  }, { btnText: '导入', themeClass: 'sh-imp-modal' });
}

// 预览弹层的现场（同一时刻只会开一个）。refresh 只重画列配置与数据预览两段，
// 不整块 innerHTML 重来 —— 那会把用户正在敲的输入框换掉，中文输入法直接断字。
let activeView = null;

function refresh(bodyEl) {
  if (!activeView) return;
  const cols = bodyEl.querySelector('[data-imp-cols]');
  const data = bodyEl.querySelector('[data-imp-data]');
  if (cols) cols.innerHTML = columnsHtml(activeView.plan, activeView.mode);
  if (data) data.innerHTML = dataPreviewHtml(activeView.plan, activeView.model.rows, activeView.header);
}

// ==========================================
// 五、真正写库
// ==========================================

async function executeImport(args) {
  // 谁建谁负责回滚：中途失败时，已经建出来的列/行必须在这里清掉 ——
  // 调用方拿不到「建到第几列」这个中间状态，指望它回滚只会留下一堆空列。
  const { table } = args;
  const createdFields = [];
  const createdRows = [];
  try {
    return await writeImport(args, createdFields, createdRows);
  } catch (error) {
    // 一次回滚一整批：逐条 deleteRow 在 2000 行时本身就要跑几十秒，
    // 而回滚恰恰发生在「已经出错」的时候，不能再拖。
    // 这一批刚插进去的行不可能有子项，不需要 deleteRow 里的 parent_id 交接。
    try { await deleteRowsBulk(createdRows); } catch (rollbackError) { /* 尽力而为 */ }
    for (const field of createdFields.reverse()) {
      try { await deleteTableField(table, field.id); } catch (rollbackError) { /* 尽力而为 */ }
    }
    throw error;
  }
}

async function writeImport({ table, model, plan, header, fields, mode, setNote }, createdFields, createdRows) {
  const dataRows = header ? model.rows.slice(1) : model.rows;
  const active = plan.filter(col => col.action !== 'skip');
  if (!active.length) throw new Error('没有选中要导入的列');

  // ① 图片：先落地，后面拼值才能引用本地路径
  const sources = [];
  dataRows.forEach(row => {
    active.forEach(col => {
      const cell = row[col.index];
      (cell?.images || []).forEach(image => { if (image.src) sources.push(image.src); });
    });
  });
  let images = new Map();
  let failedImages = 0;
  if (sources.length) {
    setNote(`正在保存图片 0/${new Set(sources).size}…`);
    const result = await importImageSources(sources, {
      concurrency: 6,
      onProgress: progress => setNote(`正在保存图片 ${progress.done}/${progress.total}…`),
    });
    images = result.items;
    failedImages = result.failures.length;
  }

  // ② 建列：复用列直接拿 key，新建列写完立刻拿 key（否则行里没处放值）
  //
  // 「作为创建时间」的列跳过建列：它的值走结构列 record.created_at，
  // 由 ③ 里的 insertRowsBulk 统一认领（规范化/去重/避让库里已有值）。
  const keyByIndex = new Map();
  const createdAtIndex = active.find(item => item.action === 'created-at')?.index ?? null;
  const createCount = active.filter(item => item.action === 'create').length;
  for (const col of active) {
    if (col.action === 'created-at') continue;
    if (col.action === 'reuse' && col.field) {
      keyByIndex.set(col.index, col.field.key);
      continue;
    }
    setNote(`正在新建列 ${createdFields.length + 1}/${createCount}…`);
    const label = cleanColumnName(col.name) || `列${col.index + 1}`;
    const options = optionsForColumn(col.type, dataRows.map(row => row[col.index]));
    const field = await createTableField(table, { label, type: col.type, options });
    if (!field?.key) throw new Error(`新建列「${label}」失败`);
    createdFields.push(field);
    col.field = field;
    keyByIndex.set(col.index, field.key);
  }

  // ②b 创建时间：有就沿用，没有就建。
  //
  // 它不在 plan 里（粘贴过来的数据没有「创建时间」这一列），所以不走 keyByIndex：
  // 值由 insertRowsBulk 统一分配 —— 第一条是当前时间，其后每条 +1 微秒。
  // 建失败了不算致命（列不存在而已），导入本身要继续。
  const hasCreatedAt = (fields || []).some(item => String(item?.key) === CREATED_AT_KEY);
  if (!hasCreatedAt) {
    const seedField = await ensureCreatedAtField(table, fields).catch(() => null);
    // 只把自己刚建的那一条记进回滚名单；沿用已有列时不能删别人的列
    if (seedField) createdFields.push(seedField);
  }

  // ③ 写行：先把每行的 values 算好，再一次性批量插入。
  //
  // 以前是一条一次 insertTableRow（查 MAX(sort) + INSERT + 回查 id = 3 次 IPC/行），
  // 2000 行就是 6000 次，界面会假死十几秒。这里拼成一条多值 INSERT，
  // 一次 IPC 拿回全部 id —— 性能是这个功能能不能用的前提。
  setNote(`正在写入 ${dataRows.length} 行…`);
  const rowsValues = dataRows.map(row => {
    const values = {};
    for (const col of active) {
      const key = keyByIndex.get(col.index);
      if (!key) continue;
      const value = coerceImportValue(col.field, row[col.index], images);
      if (value !== undefined && value !== null) values[key] = value;
    }
    // 用户指定的创建时间列：原样带上，规范化/去重交给 insertRowsBulk。
    // 空单元格不带 —— 那一行回落到自动分配，不会因为一格空就把整批拒掉。
    if (createdAtIndex != null) {
      const raw = String(row[createdAtIndex]?.text ?? '').trim();
      if (raw) values[CREATED_AT_KEY] = raw;
    }
    return values;
  });
  const { ids } = await insertRowsBulk(table, rowsValues);
  createdRows.push(...ids);
  if (dataRows.length && !createdRows.length) throw new Error('行写入失败');

  await touchSheet(table.id).catch(() => {});

  // ④ 空表重建：原来的空壳列（名称/备注）隐藏而非删除。
  //    删掉是不可逆的，而用户可能只是先导一张表看看。
  //
  //    ⚠️ 创建时间列绝不参与隐藏：这一批每一行都刚给它写了值，
  //    藏起来等于「导进去了但看不见」—— 曾经的 bug 就是这样：
  //    列建好了、50 行时间戳严格递增，界面上一个像素都没有。
  const hiddenFields = [];
  if (mode === 'create') {
    const reused = new Set(active.filter(col => col.action === 'reuse' && col.field).map(col => String(col.field.id)));
    for (const field of fields) {
      if (String(field?.key) === CREATED_AT_KEY) continue;
      if (reused.has(String(field.id))) continue;
      // 本来就隐藏的列不进「要恢复」名单：撤销时把用户的旧设置翻出来是二次伤害
      if (Number(field.visible) === 0) continue;
      try {
        await patchTableField(table, field.id, { visible: 0 });
        hiddenFields.push(field);
      } catch (error) { /* 隐藏失败不影响导入结果 */ }
    }
  }
  // 之前被藏起来的创建时间列，导入之后必须有值也要看得见。
  // 不进 hiddenFields：撤销该恢复的是「导入藏起来的东西」，不是「导入让人看见的」。
  const createdField = (fields || []).find(item => String(item?.key) === CREATED_AT_KEY);
  if (createdField && Number(createdField.visible) === 0) {
    try { await patchTableField(table, createdField.id, { visible: 1 }); } catch (error) { /* 尽力而为 */ }
  }

  return {
    mode,
    createdFields,
    createdRows,
    hiddenFields,
    failedImages,
    rowCount: createdRows.length,
    cols: active.length,
    label: `导入 ${createdRows.length} 行`,
  };
}

// ==========================================
// 六、「从剪贴板导入」的捕获弹层
// ==========================================

// 弹层开着的时候，sheetPage 的全局 paste 监听必须让路，
// 否则「有活动单元格」时会被就地粘贴抢先处理掉。
let capturing = false;

export function isCapturing() {
  // 只看标志位不够：捕获弹层被别的弹层顶掉时，标志位会一直亮着，
  // 表格的粘贴从此全部失灵。以「页面上还有没有那个粘贴区」为准，能自愈。
  return capturing && !!document.querySelector('[data-imp-zone]');
}

/**
 * 没有可粘的落点时用这个：开一个弹层，让用户在里面按 Ctrl+V。
 * 不直接用 navigator.clipboard.read()：那个要权限，Tauri 的 WebView 里
 * 拿不到 text/html（只能拿到纯文本），图片和结构都会丢。
 */
export function openPasteCapture({ toast, onSnapshot }) {
  if (typeof window.showModal !== 'function') { toast?.('当前环境不支持导入', 'danger'); return; }
  capturing = true;

  const stop = () => {
    capturing = false;
    document.removeEventListener('paste', onPaste, true);
  };
  const onPaste = event => {
    // 弹层已经被别的弹层替换 → 这个监听器是孤儿，收掉自己，别吃用户的粘贴
    if (!document.querySelector('[data-imp-zone]')) { stop(); return; }
    const snapshot = snapshotClipboard(event.clipboardData);
    if (!snapshot.html && !snapshot.text && !snapshot.files.length) return;
    event.preventDefault();
    stop();
    const overlay = document.getElementById('global-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    onSnapshot(snapshot);
  };

  window.showModal('从剪贴板导入', `<div class="sh-imp-capture" data-imp-zone tabindex="0">
      <div class="sh-imp-capture-title">按 <kbd>Ctrl</kbd> + <kbd>V</kbd> 粘贴</div>
      <div class="sh-imp-capture-desc">在 WPS / Excel 里全选表格并复制，然后在这里粘贴。<br />文字、列结构、图片都会一起带过来。</div>
    </div>`, bodyEl => {
    bodyEl.querySelector('[data-imp-zone]')?.focus();
  }, () => {
    stop();
    return true;
  }, { btnText: '关闭', onCancel: stop, themeClass: 'sh-imp-modal is-capture' });

  document.addEventListener('paste', onPaste, true);
}
