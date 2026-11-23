// 附件（图片 / 文件）读写的公共部分。
//
// 为什么单独抽出来：表格页（sheetPage）和基础表（tablePage）都要能插图，
// 而扩展名白名单、图片落盘、系统选择框这些一旦各写一份必然漂移 ——
// 历史 bug 就是 `file.type.split('/')[1]` 把 image/svg+xml 推成 "svg+xml"，
// 后端兜底存成 .png，文件内容却是 SVG，缩略图全裂。
//
// 本模块只做「文件 → 附件项」的转换与选择框，不碰 DOM、不碰表格状态：
// 上层自己决定把返回的 items 写回哪一格。

let notify = () => {};

/** 注入提示函数（宿主有 toast 就接上，没有就静默）。 */
export function setAttachmentNotifier(fn) {
  if (typeof fn === 'function') notify = fn;
}

function invoke(cmd, args) {
  const fn = window.__TAURI__?.core?.invoke;
  if (!fn) throw new Error('Tauri 不可用');
  return fn(cmd, args);
}

export function convertSrc(path) {
  try {
    if (window.__TAURI__?.core?.convertFileSrc) return window.__TAURI__.core.convertFileSrc(path);
  } catch (error) { /* 调试壳直接回退原路径 */ }
  return path || '';
}

// MIME → 落盘扩展名。必须白名单，不能让浏览器给什么就信什么。
export const MIME_IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};
export const IMAGE_EXT_ALLOWED = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
export const IMAGE_EXTS = IMAGE_EXT_ALLOWED;

export function extOfPath(path) {
  const match = String(path).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

export function nameOfPath(path) {
  const text = String(path);
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

// 读图片原始尺寸：行高按比例算，光有路径不够。
// 必须有超时兜底 —— onload/onerror 不是必达的（坏图、被中断的 data URL、
// 极端情况下的解码失败都会让它悬着），而调用方是 await 的：
// 一旦悬住，「添加附件」就永久卡在无反馈的状态，连失败提示都出不来。
// 尺寸只影响行高，拿不到就当 0，绝不能拖住落盘。
export function imageDims(src) {
  return new Promise(resolve => {
    const img = new Image();
    let settled = false;
    const finish = dims => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(dims);
    };
    const timer = setTimeout(() => finish({}), 2500);
    img.onload = () => finish({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => finish({});
    img.src = src;
  });
}

/** 粘贴 / 拖入的 File → 附件项（图片嵌入资源目录，其他存链接）。 */
export async function storeImageFile(file) {
  if (file.type === 'image/svg+xml' || extOfPath(file.name || '') === 'svg') {
    throw new Error('SVG 不支持嵌入，请先另存为 PNG');
  }
  const ext = MIME_IMAGE_EXT[file.type] || extOfPath(file.name || '') || '';
  if (!IMAGE_EXT_ALLOWED.includes(ext)) {
    throw new Error(`不支持的图片格式：${file.type || ext || '未知'}`);
  }
  const dataUrl = await fileToDataUrl(file);
  const dims = await imageDims(dataUrl);
  const path = await invoke('save_sheet_asset', { data: dataUrl, ext });
  return { path, name: file.name || '粘贴的图片', size: file.size || 0, w: dims.w || 0, h: dims.h || 0 };
}

/** 磁盘上已有的图片 → 附件项（复制进资源目录，原文件不动）。 */
export async function imageItemFromPath(path) {
  const saved = await invoke('save_sheet_asset_from_path', { source: path });
  const dims = await imageDims(convertSrc(saved.path));
  return {
    path: saved.path,
    name: saved.name || nameOfPath(path),
    size: saved.size || 0,
    w: dims.w || 0,
    h: dims.h || 0,
  };
}

/**
 * 打开系统选择框。图片自动嵌入，其他文件只存链接。
 * 返回 [] 表示用户取消或环境不支持。
 */
export async function pickAttachmentItems() {
  const dialog = window.__TAURI__?.dialog;
  if (!dialog?.open) { notify('添加附件需要在应用内使用', 'info'); return []; }
  let picked;
  try {
    picked = await dialog.open({ multiple: true, title: '选择图片或文件（图片嵌入，其他只保存链接）' });
  } catch (error) {
    notify(`选择文件失败：${error?.message || error}`, 'danger');
    return [];
  }
  const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
  const items = [];
  for (const path of list) {
    const text = String(path);
    if (IMAGE_EXTS.includes(extOfPath(text))) {
      try {
        items.push(await imageItemFromPath(text));
      } catch (error) {
        notify(`图片处理失败：${error?.message || error}`, 'danger');
      }
    } else {
      items.push({ kind: 'file', path: text, name: nameOfPath(text) });
    }
  }
  return items;
}

/** 从剪贴板/拖拽的 DataTransfer 里取文件与文本。 */
export function filesFromDataTransfer(data) {
  if (!data) return { files: [], text: '' };
  const files = [...(data.files || [])];
  // 有的剪贴板来源只有 items，没有 files（截图粘贴常见）。
  if (!files.length && data.items) {
    for (const item of data.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile?.();
        if (file) files.push(file);
      }
    }
  }
  return { files, text: data.getData ? data.getData('text/plain') || '' : '' };
}

// ==========================================
// 从 HTML 里带回来的图片
//
// 与「用户选文件 / 粘贴截图」不是一回事：这里的图片是**别人文档里的引用**
// （WPS 智能表格复制出来的是 http://www.kdocs.cn/api/v3/office/copy/... ，有时效），
// 存链接等于没存，必须落地成本地文件。
// ==========================================

function base64ToBytes(payload) {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** data:image/png;base64,... → File */
function dataUrlToFile(dataUrl, name) {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(String(dataUrl));
  if (!match) throw new Error('图片数据格式无法识别');
  const mime = String(match[1] || 'image/png').toLowerCase();
  const ext = MIME_IMAGE_EXT[mime] || 'png';
  const bytes = match[2] ? base64ToBytes(match[3] || '') : new TextEncoder().encode(decodeURIComponent(match[3] || ''));
  if (!bytes.length) throw new Error('图片内容为空');
  return new File([bytes], name || `粘贴的图片.${ext}`, { type: mime });
}

/** file:///C:/a.png → C:/a.png */
function fileUrlToPath(url) {
  let text = String(url || '').replace(/^file:\/\//i, '');
  if (/^\/[a-zA-Z]:/.test(text)) text = text.slice(1);
  try { text = decodeURIComponent(text); } catch (error) { /* 保持原样 */ }
  return text;
}

/**
 * 任意来源的图片 → 本地附件项。
 *
 * 四个分支，顺序不能乱：
 *   data:      内嵌（剪贴板里的小图 / 预览壳）
 *   blob:      剪贴板里现生成的 Blob URL
 *   file:      本机文件（用户从资源管理器复制过来）
 *   http(s):   远程引用 —— 必须下载，链接会过期
 * @returns {Promise<{path:string,name:string,size:number,w:number,h:number}>}
 */
export async function importImageSource(src, { name = '' } = {}) {
  const url = String(src || '').trim();
  if (!url) throw new Error('图片地址为空');

  if (/^data:/i.test(url)) {
    return storeImageFile(dataUrlToFile(url, name));
  }
  if (/^blob:/i.test(url)) {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], name || '粘贴的图片', { type: blob.type || 'image/png' });
    return storeImageFile(file);
  }
  if (/^file:\/\//i.test(url)) {
    return imageItemFromPath(fileUrlToPath(url));
  }
  if (/^https?:\/\//i.test(url)) {
    const saved = await invoke('download_sheet_asset', { url });
    const dims = await imageDims(convertSrc(saved.path));
    return {
      path: saved.path,
      name: name || nameOfPath(saved.path),
      size: saved.size || 0,
      w: dims.w || 0,
      h: dims.h || 0,
    };
  }
  // 没有 scheme：按本地绝对路径处理（Excel 有时会把图存成相对路径）
  return imageItemFromPath(url);
}

/**
 * 批量落地，同一个 src 只下一次。
 *
 * 并发 6：58 张图串行要等半分钟，全开又会把对端打限流 /
 * 让主线程的进度回调排队。失败不抛 —— 一张图挂了不该毁掉整批导入，
 * 调用方拿 failures 去提示「N 张没存下来」。
 *
 * @param {string[]} sources
 * @param {{concurrency?:number, onProgress?:(p:{done:number,total:number,src:string})=>void}} options
 * @returns {Promise<{items:Map<string,object>, failures:Array<{src:string,reason:string}>}>}
 */
export async function importImageSources(sources, { concurrency = 6, onProgress } = {}) {
  const unique = [...new Set((Array.isArray(sources) ? sources : []).map(src => String(src || '').trim()).filter(Boolean))];
  const items = new Map();
  const failures = [];
  const total = unique.length;
  let cursor = 0;
  let done = 0;

  if (!total) return { items, failures };

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= unique.length) return;
      const src = unique[index];
      try {
        items.set(src, await importImageSource(src));
      } catch (error) {
        failures.push({ src, reason: String(error?.message || error) });
      }
      done += 1;
      try { onProgress?.({ done, total, src }); } catch (error) { /* 进度回调自己的错不该中断导入 */ }
    }
  };

  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), total) }, worker));
  return { items, failures };
}

