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
 * 把笔记对象整理成 Rust 侧 `NoteDoc` 认得的形状。
 *
 * ★ 键名必须是 **snake_case** ★
 * Rust 的 `NoteDoc` 是 `#[derive(Deserialize)]` 且**没有** `#[serde(rename_all)]`，
 * serde 对不认识的键**直接忽略**：写成 camelCase 不报错、不抛异常、日志里也没有痕迹，
 * 只是值静默变成默认值。之前这份 payload 用的是 noteType / subTag / createdAt /
 * updatedAt / relPath，后果是：
 *   ① note_type 永远退回默认的 'idea'（用户选的「问题 / 复核」全丢）；
 *   ② sub_tag 永远空串 —— `notes_write` 的目标目录由 relative_dir(tag, sub_tag) 算，
 *      文件会从 `notes/<主分类>/<子项目>/` 掉到 `notes/<主分类>/`；
 *   ③ rel_path 永远空串 —— 保存已有笔记时被当成新建，**每次保存多出一个文件**，
 *      旧文件还留在原地（`notes_write` 只在 rel_path 有值时才清理旧路径）；
 *   ④ created_at 空串 —— 文件名里的日期前缀消失。
 * 入参这侧保留 `doc.note_type ?? doc.noteType` 的兼容：调用方写哪种都能用，
 * 但**发出去的**只有一种形状。
 *
 * @param {object} doc 任意形状的笔记对象
 * @returns {object} Rust NoteDoc 形状的 payload
 */
function toNoteDoc(doc = {}) {
  return {
    id: doc.id ?? null,
    title: doc.title ?? '',
    content: doc.content ?? '',
    note_type: doc.note_type ?? doc.noteType ?? 'idea',
    status: doc.status ?? 'usable',
    tag: doc.tag ?? '',
    sub_tag: doc.sub_tag ?? doc.subTag ?? '',
    // 可空：null = 独立笔记。Rust 侧是 Option<i64>，显式 null 比「不传」更不容易被误读。
    record_id: doc.record_id ?? doc.recordId ?? null,
    created_at: doc.created_at ?? doc.createdAt ?? '',
    updated_at: doc.updated_at ?? doc.updatedAt ?? '',
    rel_path: doc.rel_path ?? doc.relPath ?? '',
    abs_path: doc.abs_path ?? doc.absPath ?? '',
  };
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

  const payload = toNoteDoc(doc);

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
    ...toNoteDoc({ ...doc, content: '', created_at: '', abs_path: '' }),
    // 这三个在 Rust 侧是「非空才覆盖 / Some 才覆盖」：缺省值必须还原成空串 / null，
    // 否则一个默认值（'idea' / 'usable'）就会把文件里的真实值打回去。
    note_type: doc.note_type ?? doc.noteType ?? '',
    status: doc.status ?? '',
    record_id: doc.record_id ?? doc.recordId ?? null,
    rel_path: relPath,
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

/**
 * 设置或解除笔记与 record 的关联。
 *
 * **解除关联必须显式传 null**：Rust 侧的 `notes_set_record` 收到的正是
 * `Option<i64>`，「没传」和「传 null」在语义上都是 None，但前者一旦被序列化层
 * 优化掉就会变成「调用方忘了传」，这里的契约只有一种：要解除就传 null。
 * 注意这只是解挂，**不删文件** —— 笔记始终独立存在于笔记页。
 *
 * @param {string} relPath 笔记相对路径
 * @param {number|string|null} recordId null = 解除关联
 * @returns {Promise<object|null>} 更新后的文档
 */
export async function setNoteRecord(relPath, recordId) {
  const dataPath = await currentDataPath();
  if (!dataPath || !relPath) return null;

  const raw = recordId === null || recordId === undefined || recordId === '' ? null : Number(recordId);
  const id = raw === null || !Number.isFinite(raw) ? null : raw;

  try {
    return await getInvoke()('notes_set_record', {
      dataFilePath: dataPath,
      relPath,
      recordId: id
    });
  } catch (error) {
    console.error('设置笔记关联失败:', error);
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
      // ⚠️ record_id 是可空列，必须走 SQL 字面量 NULL：dbExecute 会把参数统一 String()，
      // 传 null 落库是字符串 'null' —— 那样 `record_id IS NOT NULL` 判定为「已关联」，
      // 而 `record_id = 12` 永远匹配不上，变成查不到也清不掉的幽灵关联。
      const linked = note.record_id == null || String(note.record_id).trim() === '';
      const params = [
        note.rel_path || '',
        note.title || '',
        note.note_type || 'idea',
        note.status || 'usable',
        note.tag || '',
        note.sub_tag || '',
      ];
      if (!linked) params.push(Number(note.record_id));
      params.push(note.created_at || '', note.updated_at || '');

      await dbExecute(
        `INSERT OR REPLACE INTO note_index
         (rel_path, title, note_type, status, tag, sub_tag, record_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ${linked ? 'NULL' : '?'}, ?, ?)`,
        params
      );
    }
  } catch (error) {
    // 索引只是加速列表与搜索，同步失败不影响笔记本身。
    // 但要往日志文件里写一笔：否则「列表有笔记、搜索找不到」没法排查。
    logToFile('warn', `笔记索引同步失败（不影响笔记本身）: ${error?.stack || error}`);
  }
}
