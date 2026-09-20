// ==========================================
// 笔记存储层（文件优先）
//
// 笔记正文的唯一真相源是磁盘上的 .md 文件：
//   <数据目录>/notes/<主分类>/<子项目>/YYYY-MM-DD-标题.md
//
// SQLite 里的 note_index 表只做元数据索引，用于快速列表与搜索。
// 这里统一封装 Rust 侧命令，其它模块不要直接调 invoke。
// ==========================================

import { logToFile } from './logger.js';

/**
 * 惰性获取 Tauri invoke。
 *
 * 不在模块顶层解构 window.__TAURI__：模块求值时机与 Tauri 注入时机
 * 一旦错开，顶层解构会直接把整个模块加载搞崩，且错误难以定位。
 */
function getInvoke() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    throw new Error('Tauri API 不可用（window.__TAURI__.core.invoke 缺失）');
  }
  return invoke;
}

/** 缓存的笔记根目录绝对路径。 */
let notesRootCache = null;

/** 从 data.js 注入的「当前数据文件路径」提供者，避免循环依赖。 */
let dataPathProvider = null;

/**
 * 由 data.js 调用注入数据路径获取函数。
 * notes 模块需要知道数据目录位置才能定位 notes/ 子目录。
 */
export function setNotesDataPathProvider(provider) {
  dataPathProvider = provider;
  notesRootCache = null;
}

async function currentDataPath() {
  if (dataPathProvider) {
    const value = await dataPathProvider();
    if (value) return value;
  }
  // 兜底：直接问后端要
  try {
    return await getInvoke()('get_current_path');
  } catch (error) {
    console.error('获取数据路径失败:', error);
    return '';
  }
}

/**
 * 确保笔记目录存在，并返回其绝对路径。
 */
export async function ensureNotesRoot() {
  if (notesRootCache) return notesRootCache;
  const dataPath = await currentDataPath();
  if (!dataPath) {
    console.warn('数据路径为空，无法初始化笔记目录');
    return '';
  }
  try {
    notesRootCache = await getInvoke()('notes_ensure_root', { dataFilePath: dataPath });
    return notesRootCache;
  } catch (error) {
    console.error('初始化笔记目录失败:', error);
    return '';
  }
}

/** 拿到笔记根目录路径（不创建目录）。 */
export async function getNotesRoot() {
  if (notesRootCache) return notesRootCache;
  const dataPath = await currentDataPath();
  if (!dataPath) return '';
  try {
    notesRootCache = await getInvoke()('notes_root_path', { dataFilePath: dataPath });
    return notesRootCache;
  } catch (error) {
    console.error('获取笔记目录失败:', error);
    return '';
  }
}

/**
 * 扫描磁盘，列出全部笔记（含元数据与正文）。
 *
 * @returns {Promise<Array>} 笔记数组，按更新时间倒序
 */
export async function listNotes() {
  const dataPath = await currentDataPath();
  if (!dataPath) return [];
  try {
    return await getInvoke()('notes_list', { dataFilePath: dataPath });
  } catch (error) {
    console.error('读取笔记列表失败:', error);
    return [];
  }
}

/** 读取单篇笔记。 */
export async function readNote(relPath) {
  const dataPath = await currentDataPath();
  if (!dataPath || !relPath) return null;
  try {
    return await getInvoke()('notes_read', { dataFilePath: dataPath, relPath });
  } catch (error) {
    console.error('读取笔记失败:', error);
    return null;
  }
}

/**
 * 保存笔记（新建或覆盖）。
 *
 * @param {object} doc 笔记对象；relPath 为空表示新建
 * @returns {Promise<object|null>} 保存后的文档（含最终 rel_path / abs_path）
 */
export async function writeNote(doc) {
  const dataPath = await currentDataPath();
  if (!dataPath) return null;

  const payload = {
    id: doc.id ?? null,
    title: doc.title ?? '',
    content: doc.content ?? '',
    noteType: doc.note_type ?? doc.noteType ?? 'idea',
    status: doc.status ?? 'usable',
    tag: doc.tag ?? '',
    subTag: doc.sub_tag ?? doc.subTag ?? '',
    createdAt: doc.created_at ?? doc.createdAt ?? '',
    updatedAt: doc.updated_at ?? doc.updatedAt ?? '',
    relPath: doc.rel_path ?? doc.relPath ?? '',
    absPath: doc.abs_path ?? doc.absPath ?? ''
  };

  try {
    return await getInvoke()('notes_write', { dataFilePath: dataPath, doc: payload });
  } catch (error) {
    console.error('保存笔记失败:', error);
    throw error;
  }
}

/** 只更新元数据，不动正文。 */
export async function updateNoteMeta(relPath, doc) {
  const dataPath = await currentDataPath();
  if (!dataPath || !relPath) return null;

  const payload = {
    id: doc.id ?? null,
    title: doc.title ?? '',
    content: '',
    noteType: doc.note_type ?? doc.noteType ?? '',
    status: doc.status ?? '',
    tag: doc.tag ?? '',
    subTag: doc.sub_tag ?? doc.subTag ?? '',
    createdAt: '',
    updatedAt: doc.updated_at ?? doc.updatedAt ?? '',
    relPath,
    absPath: ''
  };

  try {
    return await getInvoke()('notes_update_meta', {
      dataFilePath: dataPath,
      relPath,
      doc: payload
    });
  } catch (error) {
    console.error('更新笔记元数据失败:', error);
    throw error;
  }
}

/** 删除笔记文件。 */
export async function deleteNote(relPath) {
  const dataPath = await currentDataPath();
  if (!dataPath || !relPath) return false;
  try {
    await getInvoke()('notes_delete', { dataFilePath: dataPath, relPath });
    return true;
  } catch (error) {
    console.error('删除笔记失败:', error);
    return false;
  }
}

/** 在资源管理器中打开笔记根目录。 */
export async function openNotesFolder() {
  const dataPath = await currentDataPath();
  if (!dataPath) return '';
  try {
    return await getInvoke()('notes_open_root', { dataFilePath: dataPath });
  } catch (error) {
    console.error('打开笔记目录失败:', error);
    return '';
  }
}

/**
 * 用外部程序打开笔记文件。
 *
 * @param {string} absPath 文件绝对路径
 * @param {string} [appPath] 指定可执行程序；不传则用系统默认关联程序
 */
export async function openNoteExternally(absPath, appPath) {
  if (!absPath) return false;
  try {
    await getInvoke()('open_path_with_app', {
      path: absPath,
      app: appPath || null
    });
    return true;
  } catch (error) {
    console.error('外部打开失败:', error);
    return false;
  }
}

/**
 * 把索引数据同步到 SQLite 的 note_index 表。
 *
 * 这只是缓存层，失败了也不影响笔记本身的读写，
 * 因此这里吞掉异常、只打日志。
 */
export async function syncNoteIndex(notes, dbExecute) {
  if (!Array.isArray(notes) || typeof dbExecute !== 'function') return;

  try {
    // 索引很小（个人笔记量级），全量重建最简单也最不容易出不一致
    await dbExecute('DELETE FROM note_index', []);

    for (const note of notes) {
      await dbExecute(
        `INSERT OR REPLACE INTO note_index
         (rel_path, title, note_type, status, tag, sub_tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          note.rel_path || '',
          note.title || '',
          note.note_type || 'idea',
          note.status || 'usable',
          note.tag || '',
          note.sub_tag || '',
          note.created_at || '',
          note.updated_at || ''
        ]
      );
    }
  } catch (error) {
    // 索引只是加速列表与搜索，同步失败不影响笔记本身。
    // 但要往日志文件里写一笔：否则「列表有笔记、搜索找不到」没法排查。
    logToFile('warn', `笔记索引同步失败（不影响笔记本身）: ${error?.stack || error}`);
  }
}
