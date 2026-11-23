// 从剪贴板里还原「一块表格」。
//
// 为什么不能只读 text/plain：WPS / 飞书 / Excel 复制表格时，纯文本里图片是
// `=DISPIMG("ID_xxx",1)` 这种占位符，合并格被摊成空串 —— 只读纯文本等于把图和
// 结构一起丢掉。text/html 才是原样结构（WPS 导出的是 Excel 风格 HTML：
// `<meta name=Generator content="Microsoft Excel">` + VML + .et2/.et5 那套类名）。
//
// 本模块的边界：
//   ✅ HTML / TSV → 矩形矩阵；合并格展开；类型推断；表头猜测
//   ❌ 不碰数据库、不碰渲染、不下载图片（那些在 clipboardImport / attachmentOps）
//
// 单元格统一成 { text, images: [{src, alt}] }。合并格按矩形展开 —— 同一份值重复
// 填进它覆盖的每一格。表格数据模型里没有「合并」这个概念，与其装作有，不如摊平：
// 用户要的是「内容完整进来」，重复值比空三格更接近原样。

import { parseTSV } from './gridCore.js';

// ==========================================
// 一、纯文本工具（可在 Node 里单测）
// ==========================================

const ZERO_WIDTH = /[\u200b\u200c\u200d\ufeff]/g;
const NBSP = /\u00a0/g;

/** 数字文本判定。带前导零的一律当文本（000123 是编号，不是 123）。 */
export function isNumericText(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  if (/^0\d/.test(text)) return false;
  const cleaned = text
    .replace(/,/g, '')
    .replace(/^[¥$€£]\s*/, '')
    .trim();
  return /^-?\d+(\.\d+)?$/.test(cleaned) && cleaned.length <= 18;
}

/**
 * 各种「人写的日期」→ 库里的标准形态。
 * 认不出来就返回 ''（宁可当文本，也不要瞎猜一个错的日期）。
 * @returns {string} 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:mm'
 */
export function normalizeDateText(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const pad = value => String(value).padStart(2, '0');
  const build = (y, mo, d, h, mi) => {
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = h == null ? null : Number(h);
    const minute = mi == null ? null : Number(mi);
    if (!year || year < 1900 || year > 2999) return '';
    if (!month || month < 1 || month > 12) return '';
    if (!day || day < 1 || day > 31) return '';
    if (hour != null && (hour > 23 || minute > 59)) return '';
    const date = `${year}-${pad(month)}-${pad(day)}`;
    if (hour == null) return date;
    if (hour === 0 && minute === 0) return date;
    return `${date} ${pad(hour)}:${pad(minute)}`;
  };

  // 2026-11-19 / 2026/11/19 / 2026.11.19 / 2026年11月19日 [+ 14:30[:00]]
  let match = text.match(
    /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[ T]+(\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?)?$/
  );
  if (match) return build(match[1], match[2], match[3], match[4], match[5]);

  // 2026年11月19日 14时30分
  match = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[时点]\s*(\d{1,2})?\s*分?$/);
  if (match) return build(match[1], match[2], match[3], match[4], match[5] || 0);

  // 纯日期 + 上下午：2026/11/19 下午2:30
  match = text.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?\s*(上午|下午|AM|PM|am|pm)\s*(\d{1,2}):(\d{2})$/);
  if (match) {
    let hour = Number(match[5]);
    const pm = /下午|PM|pm/.test(match[4]);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
    return build(match[1], match[2], match[3], hour, match[6]);
  }
  return '';
}

/** 图片占位符：纯文本兜底时会出现，不能当成正文导进去。 */
export function isImagePlaceholder(text) {
  const value = String(text ?? '').trim();
  if (!value) return true;
  return /^=DISPIMG\(/i.test(value) || /^\[图片\]$/.test(value) || /^<img\b/i.test(value);
}

/**
 * 逐列推断类型。只看「这一列的数据行」，不看表头。
 * 顺序有讲究：带图 → 附件；能当日期 → 日期；全是数 → 数字；全是是/否 → 复选。
 * @param {Array<{text:string, images?:Array}>} cells
 */
export function inferColumnType(cells) {
  const list = Array.isArray(cells) ? cells : [];
  if (list.some(cell => cell && Array.isArray(cell.images) && cell.images.length)) return 'attachment';

  const values = list
    .map(cell => String(cell?.text ?? '').trim())
    .filter(text => text && !isImagePlaceholder(text));
  if (!values.length) return 'text';

  const dates = values.filter(text => normalizeDateText(text)).length;
  if (dates === values.length) return 'date';

  const numbers = values.filter(text => isNumericText(text)).length;
  if (numbers === values.length) return 'number';

  const bools = values.filter(text => /^(是|否|✓|√|☑|true|false|True|False|TRUE|FALSE)$/.test(text)).length;
  if (bools === values.length && values.length >= 2) return 'checkbox';

  return 'text';
}

/**
 * 首行是不是表头。
 * 三个信号，从硬到软：th 标签 → 单元格加粗 → 「首行是文本、下面是数字/日期」。
 * 表头识别错了代价很小（预览里有一个勾选框可以改），所以宁可多认一次。
 */
export function detectHeaderRow(matrix, hints = {}) {
  const rows = Array.isArray(matrix) ? matrix : [];
  if (rows.length < 2) return false;
  if (hints.hasTh) return true;

  const first = rows[0] || [];
  const width = first.length;
  if (!width) return false;

  const filled = first.filter(cell => String(cell?.text || '').trim()).length;
  if (filled < Math.ceil(width * 0.6)) return false;
  if (first.some(cell => cell?.images?.length)) return false;
  // 表头短、数据长：首行有超过 24 字的格子，基本是数据行
  if (first.some(cell => String(cell?.text || '').length > 24)) return false;

  let compared = 0;
  let mismatch = 0;
  for (let c = 0; c < width; c += 1) {
    const below = rows.slice(1).map(row => row[c] || { text: '' });
    const belowType = inferColumnType(below);
    if (belowType === 'text' || belowType === 'attachment') continue;
    compared += 1;
    mismatch += 1; // 首行这一格是文本（否则类型会一致），下面却是日期/数字 → 首行是标题
  }
  if (compared && mismatch / compared >= 0.5) return true;
  return hints.boldRow0 === true;
}

function isEmptyCell(cell) {
  return !cell || (!String(cell.text || '').trim() && !(cell.images || []).length);
}

/** 裁掉尾部空行 / 空列（中间的保留：空行也是结构）。 */
export function trimMatrix(matrix) {
  const rows = (Array.isArray(matrix) ? matrix : []).map(row => (Array.isArray(row) ? row : []));
  let height = rows.length;
  while (height > 0 && rows[height - 1].every(isEmptyCell)) height -= 1;
  const width = rows.slice(0, height).reduce((max, row) => Math.max(max, row.length), 0);
  let cut = width;
  while (cut > 0) {
    const empty = rows.slice(0, height).every(row => isEmptyCell(row[cut - 1]));
    if (!empty) break;
    cut -= 1;
  }
  const out = rows.slice(0, height).map(row => {
    const line = row.slice(0, cut);
    while (line.length < cut) line.push({ text: '', images: [] });
    return line;
  });
  return out;
}

// ==========================================
// 二、HTML 解析（浏览器里跑，Node 单测用不到）
// ==========================================

// 单元格内出现的块级元素要把内容分成多行 —— 只处理 <br> 会把
// 「第一行<div>第二行</div>」粘成一整句。
const BLOCK_TAGS = ['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

function cellTextOf(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, template').forEach(el => el.remove());

  // 图片先摘出来，再取文字：不然 alt 会被当成正文重复一遍
  const images = [];
  clone.querySelectorAll('img').forEach(img => {
    const src = String(
      img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || ''
    ).trim();
    if (src) images.push({ src, alt: String(img.getAttribute('alt') || '').trim() });
    img.remove();
  });

  // 背景图（WPS 不用，但别的来源会用 background-image 排版）
  const bgPattern = /background(?:-image)?\s*:[^;]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i;
  clone.querySelectorAll('[style]').forEach(el => {
    const match = bgPattern.exec(String(el.getAttribute('style') || ''));
    if (match && match[1]) images.push({ src: match[1].trim(), alt: '' });
  });

  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  BLOCK_TAGS.forEach(tag => {
    clone.querySelectorAll(tag).forEach(el => el.append('\n'));
  });

  let text = String(clone.textContent || '');
  text = text.replace(ZERO_WIDTH, '').replace(NBSP, ' ');
  text = text
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { text, images };
}

function looksBold(cell) {
  if (cell.querySelector('b, strong')) return true;
  const own = String(cell.getAttribute('style') || '') + ' ' + String(cell.getAttribute('class') || '');
  if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(own)) return true;
  // Excel/WPS 常把样式挂在里面那层 span 上
  const inner = cell.querySelector('[style*="font-weight"]');
  return inner ? /font-weight\s*:\s*(bold|[6-9]00)/i.test(String(inner.getAttribute('style') || '')) : false;
}

function maxColsOf(table) {
  let cols = 0;
  for (const row of table.rows || []) cols = Math.max(cols, row.cells.length);
  return cols;
}

/**
 * 解析 HTML 里的「最大那张表」。
 * 为什么不取第一张：Excel/WPS 导出时常在外面套一层单格表格做样式，
 * 真正的内容表嵌在里面 —— 按「行×列最大」挑，比按顺序挑稳。
 * @returns {{rows:Array<Array<object>>, merges:Array<object>, hasTh:boolean, boldRow0:boolean}|null}
 */
export function parseHtmlTable(html) {
  const source = String(html || '');
  if (!source || typeof DOMParser === 'undefined' || !/<table[\s>]/i.test(source)) return null;

  let doc;
  try {
    doc = new DOMParser().parseFromString(source, 'text/html');
  } catch (error) {
    return null;
  }
  const tables = [...doc.querySelectorAll('table')];
  if (!tables.length) return null;

  let best = null;
  let bestScore = 0;
  for (const table of tables) {
    const rows = table.rows ? table.rows.length : 0;
    const score = rows * Math.max(1, maxColsOf(table));
    if (score > bestScore) { best = table; bestScore = score; }
  }
  if (!best) return null;

  const trs = [...(best.rows || [])];
  const matrix = [];
  const merges = [];
  let hasTh = false;
  let boldCells = 0;
  let firstRowCells = 0;

  for (let r = 0; r < trs.length; r += 1) {
    matrix[r] = matrix[r] || [];
    let c = 0;
    for (const cell of trs[r].cells) {
      // 上一行的 rowspan 已经占了这个位置，往右挪
      while (matrix[r][c] !== undefined) c += 1;

      const rowspan = Math.max(1, Math.min(Number(cell.getAttribute('rowspan')) || 1, 200));
      const colspan = Math.max(1, Math.min(Number(cell.getAttribute('colspan')) || 1, 64));
      const content = cellTextOf(cell);
      const tag = String(cell.tagName || '').toUpperCase();
      if (tag === 'TH') hasTh = true;
      if (r === 0) {
        firstRowCells += 1;
        if (looksBold(cell)) boldCells += 1;
      }

      for (let dr = 0; dr < rowspan; dr += 1) {
        for (let dc = 0; dc < colspan; dc += 1) {
          const rr = r + dr;
          const cc = c + dc;
          matrix[rr] = matrix[rr] || [];
          // 起始格放原文，其余位置放同一份内容的副本（摊平，不是引用）
          matrix[rr][cc] = dr === 0 && dc === 0 ? content : { ...content, merged: true };
        }
      }
      if (rowspan > 1 || colspan > 1) merges.push({ r, c, rowspan, colspan });
      c += colspan;
    }
  }

  return {
    rows: matrix,
    merges,
    hasTh,
    boldRow0: firstRowCells > 0 && boldCells / firstRowCells >= 0.6,
  };
}

/** TSV → 矩阵。图片占位符（=DISPIMG）空掉，但记个数好提示。 */
export function matrixFromTSV(text) {
  const parsed = parseTSV(String(text || ''));
  let placeholders = 0;
  const rows = parsed.map(line =>
    line.map(value => {
      const raw = String(value ?? '');
      if (isImagePlaceholder(raw) && /^=DISPIMG\(/i.test(raw.trim())) placeholders += 1;
      return { text: /^=DISPIMG\(/i.test(raw.trim()) ? '' : raw, images: [] };
    })
  );
  return { rows, placeholders };
}

// ==========================================
// 三、给预览层用的列描述
// ==========================================

export function cleanColumnName(raw) {
  return String(raw ?? '')
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/**
 * 矩阵 + 「首行是否表头」→ 每列的名字/类型/样例。
 * 预览里勾选框一动就重算一次，所以这里不能有副作用。
 */
export function buildColumnDescriptors(matrix, header) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const width = rows.reduce((max, row) => Math.max(max, (row || []).length), 0);
  const dataRows = header ? rows.slice(1) : rows;
  const columns = [];

  for (let c = 0; c < width; c += 1) {
    const cells = dataRows.map(row => (row && row[c]) || { text: '', images: [] });
    const type = inferColumnType(cells);
    const texts = cells.map(cell => String(cell.text || '').trim()).filter(Boolean);
    const images = cells.reduce((sum, cell) => sum + ((cell.images || []).length), 0);
    const headCell = header ? rows[0] && rows[0][c] : null;
    columns.push({
      name: cleanColumnName(headCell?.text) || `列${c + 1}`,
      type,
      imageCount: images,
      samples: texts.filter(text => !isImagePlaceholder(text)).slice(0, 3),
      hasImages: images > 0,
    });
  }
  return columns;
}

/**
 * 剪贴板快照 → 导入用的模型。
 *
 * ⚠️ 调用方必须先把 clipboardData 拍成快照再进来：DataTransfer 在 paste 事件的
 * 回调结束之后就失效了（getData 返回空串），而导入流程要 await 用户确认。
 * @param {{html?:string, text?:string}} payload
 */
export function parseClipboardPayload({ html = '', text = '' } = {}) {
  const htmlTable = parseHtmlTable(html);
  let rows;
  let merges = [];
  let placeholders = 0;
  let source;

  if (htmlTable) {
    rows = trimMatrix(htmlTable.rows);
    merges = htmlTable.merges;
    source = 'html';
  } else {
    const tsv = matrixFromTSV(text);
    rows = trimMatrix(tsv.rows);
    placeholders = tsv.placeholders;
    source = rows.length ? 'tsv' : 'none';
  }

  const header = detectHeaderRow(rows, {
    hasTh: htmlTable?.hasTh,
    boldRow0: htmlTable?.boldRow0,
  });
  const columns = buildColumnDescriptors(rows, header);

  // 去重后的图片源：同一个 logo 在 20 行里重复出现，只该下载一次
  const seen = new Set();
  const imageSources = [];
  rows.forEach(row => row.forEach(cell => {
    (cell.images || []).forEach(image => {
      const src = image.src;
      if (!src || seen.has(src)) return;
      seen.add(src);
      imageSources.push(src);
    });
  }));

  return {
    source,
    rows,
    merges,
    header,
    columns,
    rowCount: rows.length,
    cols: columns.length,
    imageSources,
    imageCount: imageSources.length,
    // 纯文本兜底时图片只剩占位符：如实告诉用户「这些图没进来」
    lostImages: placeholders,
    dataRows: header ? Math.max(0, rows.length - 1) : rows.length,
  };
}
