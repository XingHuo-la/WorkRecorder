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
 * 把任意来源的关联值收成一个干净的正整数数组（去重、升序）。
 *
 * 必须收口的原因：'null' / 空串 / 0 / NaN / '12abc' 这几种脏值都能从
 * 旧数据、手写 front-matter、上一版的 `params.map(String)` 里漏下来。任何一处
 * 漏过滤，就会出现「笔记上显示挂了 #37，记录 #37 的抽屉里看不到」这种
 * 单侧可见的幽灵关联（R08 最后一条判据专门验收它）。
 *
 * 这是**前端唯一收口函数**：笔记页 chips、抽屉笔记区、索引同步都用它，
 * 不许各处 `String(id)` 自己比（`String(' 12') !== String(12)` 会假阴性）。
 *
 * @param {*} value 单个 id / id 数组 / null / 脏字符串
 * @returns {number[]} 升序去重的正整数数组
 */
export function normalizeRecordIds(value) {
  const raw = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
  const out = [];
  for (const item of raw) {
    const num = Number(item); // Number('null') = NaN → 被下面挡掉
    if (!Number.isFinite(num)) continue;
    const id = Math.trunc(num);
    if (id <= 0) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out.sort((a, b) => a - b);
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
 * record_id / record_ids 的关系（v1.2）：
 *  - `record_ids` 是唯一真相，Rust 侧 `Vec<i64>`，序列化成 JSON number 数组。
 *  - `record_id` 是**只读兼容字段**，Rust 侧永不写进文件；这里仍然发出去，
 *    值取 record_ids 的第一条（最小 id），让 v1.1 前端（回滚场景）还能看到一条。
 *  - `record_ids` 一旦出现（哪怕是空数组）就是权威值；只有完全没提这个键时，
 *    才用旧的单值 `record_id` 兜底 —— v1.1 的「从抽屉新建笔记」还在传它。
 *
 * @param {object} doc 任意形状的笔记对象
 * @returns {object} Rust NoteDoc 形状的 payload
 */
function toNoteDoc(doc = {}) {
  const explicitIds = doc.record_ids ?? doc.recordIds;
  const legacyId = doc.record_id ?? doc.recordId ?? null;
  const ids = explicitIds === undefined || explicitIds === null
    ? normalizeRecordIds(legacyId)
    : normalizeRecordIds(explicitIds);

  return {
    id: doc.id ?? null,
    title: doc.title ?? '',
    content: doc.content ?? '',
    note_type: doc.note_type ?? doc.noteType ?? 'idea',
    status: doc.status ?? 'usable',
    tag: doc.tag ?? '',
    sub_tag: doc.sub_tag ?? doc.subTag ?? '',
    // 关联的多值真相。Rust 侧 render_markdown 只认它。
    record_ids: ids,
    // 兼容投影：可空，null = 独立笔记（v1.1 前端只读这个字段）。
    record_id: ids.length ? ids[0] : null,
    created_at: doc.created_at ?? doc.createdAt ?? '',
    updated_at: doc.updated_at ?? doc.updatedAt ?? '',
    rel_path: doc.rel_path ?? doc.relPath ?? '',
    abs_path: doc.abs_path ?? doc.absPath ?? '',
  };
}

/** 调用方是否显式提到了 record_ids（空数组也算提了）。 */
function hasRecordIdsKey(doc) {
  if (!doc || typeof doc !== 'object') return false;
  return 'record_ids' in doc || 'recordIds' in doc;
}

/**
 * 从磁盘读一篇笔记当前的关联 id，读不到就返回空数组（不抛）。
 * 只给 writeNote 的过渡保护用。
 */
async function readRecordIdsFromDisk(dataPath, relPath) {
  try {
    const doc = await getInvoke()('notes_read', { dataFilePath: dataPath, relPath });
    return normalizeRecordIds(doc?.record_ids);
  } catch (error) {
    logToFile('warn', `读取笔记关联失败（写盘前保护跳过）: ${relPath}`);
    return [];
  }
}

/**
 * 保存笔记（新建或覆盖）。
 *
 * ⚠️ **整份覆盖**：`notes_write` → `render_markdown` 从 doc 重建全部 front-matter。
 * 所以本函数的 payload 里必须带 `record_ids`，漏传等于每次保存都把关联清空，
 * 而且零报错（文件看起来完全正常）。
 * 需要「清空关联」时显式传 `record_ids: []`，或走 `setNoteRecords(rel, [])`。
 *
 * @param {object} doc 笔记对象；relPath 为空表示新建
 * @returns {Promise<object|null>} 保存后的文档（含最终 rel_path / abs_path）
 */
export async function writeNote(doc) {
  const dataPath = await currentDataPath();
  if (!dataPath) return null;

  const payload = toNoteDoc(doc);

  // 过渡保护（不变式 1）：v1.1 的 notesEditor.saveCurrentNote 手工拼 payload，
  // 里面没有 record_ids —— 不补这一手，1.2s 一次的自动保存会把关联清空。
  // 只在「调用方完全没提 record_ids」且是改已有文件时，把磁盘上的关联原样带回去；
  // 同时打一条 warn，让「谁没传 record_ids」在日志里可查，而不是静默半成功。
  // T04 把 saveCurrentNote 的 payload 补上 record_ids 之后，这条分支不会再命中。
  if (!hasRecordIdsKey(doc) && payload.rel_path) {
    const kept = await readRecordIdsFromDisk(dataPath, payload.rel_path);
    if (kept.length) {
      payload.record_ids = kept;
      payload.record_id = kept[0];
      logToFile('warn', `writeNote 未收到 record_ids，已从磁盘保留关联: ${payload.rel_path} (${kept.length} 条)`);
    }
  }

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
    // 关联走的是「非空才覆盖」：这里传空数组 = 「不动关联」，不是清空。
    // （改标题 / 分类时调用方通常不传 record_ids，落到这里就是 []，安全。）
    // 真要清空只能走 setNoteRecords(relPath, [])。两条语义不能混：
    // 整份覆盖的 writeNote 必须带全，增量覆盖的 updateNoteMeta 不带。
    record_ids: normalizeRecordIds(doc.record_ids ?? doc.recordIds),
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
 * 设置或解除笔记与 record 的**单值**关联。
 *
 * @deprecated v1.2 起关联是多值的，请按动作改用 `addNoteRecord` / `removeNoteRecord` /
 * `setNoteRecords`。这个函数把关联整组替换成「一条或零条」，会**顺带清掉其它关联**，
 * 那正是 R01 要消灭的语义。保留它只为 v1.1 的两个调用点（抽屉的挂上 / 解除）不立刻崩。
 *
 * **解除关联必须显式传 null**：Rust 侧收到的正是 `Option<i64>`，「没传」和「传 null」
 * 在语义上都是 None，但前者一旦被序列化层优化掉就会变成「调用方忘了传」，
 * 这里的契约只有一种：要解除就传 null。
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

/**
 * 给笔记追加一条关联（并集里加一个）。**幂等**：已挂上则原样返回。
 *
 * 失败必须 throw（不吞）：吞掉的后果是「界面显示已挂着，文件里没有」。
 *
 * @param {string} relPath 笔记相对路径
 * @param {number|string} recordId 要挂上的记录 id
 * @returns {Promise<object|null>} 更新后的文档（record_ids 已是最新）
 */
export async function addNoteRecord(relPath, recordId) {
  const dataPath = await currentDataPath();
  if (!dataPath || !relPath) return null;

  const [id] = normalizeRecordIds(recordId);
  if (id === undefined) throw new Error(`record_id 非法: ${recordId}`);

  try {
    return await getInvoke()('notes_add_record', {
      dataFilePath: dataPath,
      relPath,
      recordId: id
    });
  } catch (error) {
    console.error('挂上笔记关联失败:', error);
    logToFile('error', `挂上笔记关联失败: ${relPath} -> #${id}`);
    throw error;
  }
}

/**
 * 解除一条关联（并集里减一个）。**幂等**：本来没挂则原样返回。
 * 只改 front-matter，**不删笔记文件**。
 *
 * @param {string} relPath 笔记相对路径
 * @param {number|string} recordId 要解开的记录 id
 * @returns {Promise<object|null>} 更新后的文档
 */
export async function removeNoteRecord(relPath, recordId) {
  const dataPath = await currentDataPath();
  if (!dataPath || !relPath) return null;

  const [id] = normalizeRecordIds(recordId);
  if (id === undefined) throw new Error(`record_id 非法: ${recordId}`);

  try {
    return await getInvoke()('notes_remove_record', {
      dataFilePath: dataPath,
      relPath,
      recordId: id
    });
  } catch (error) {
    console.error('解除笔记关联失败:', error);
    logToFile('error', `解除笔记关联失败: ${relPath} -> #${id}`);
    throw error;
  }
}

/**
 * 整组替换笔记的关联。**空数组 = 显式清空**（这是唯一能把关联清成 0 的入口）。
 *
 * @param {string} relPath 笔记相对路径
 * @param {Array<number|string>} recordIds 目标 id 集合（会去重升序）
 * @returns {Promise<object|null>} 更新后的文档
 */
export async function setNoteRecords(relPath, recordIds) {
  const dataPath = await currentDataPath();
  if (!dataPath || !relPath) return null;

  const ids = normalizeRecordIds(recordIds);

  try {
    return await getInvoke()('notes_set_records', {
      dataFilePath: dataPath,
      relPath,
      recordIds: ids
    });
  } catch (error) {
    console.error('设置笔记关联失败:', error);
    logToFile('error', `设置笔记关联失败: ${relPath} -> [${ids.join(',')}]`);
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
 * 把索引数据同步到 SQLite：`note_index`（元数据）+ `note_record`（多值关联）。
 *
 * 这两张都是**派生表**，真相在 `.md` 的 front-matter 里。所以：
 *  - 全量重建（DELETE + 从 notes 重插），中途半截也无害：下次同步从文件自愈；
 *  - 失败只打 warn、不抛（§8.4：索引类操作失败必须吞）。
 *
 * ⚠️ 一条笔记挂 N 条记录时，`note_index.record_id` 只写**第一条**（最小 id），
 *    它是给 v1.1 前端（回滚场景）看的兼容投影，不是真相；多值全在 `note_record`。
 *
 * ⚠️ 可空列必须走 SQL 字面量 NULL：dbExecute 会把参数统一 String()，
 *    传 null 落库是字符串 'null' —— 那样「已关联但查不到」的幽灵值永远清不掉。
 *
 * 笔记数 > 800 时可改走「查 note_record 拿 rel_path → notes_read_many 批量读」，
 * 本期不实现（一次扫盘单次 IPC 仍快于 N+1）。
 */
export async function syncNoteIndex(notes, dbExecute) {
  if (!Array.isArray(notes) || typeof dbExecute !== 'function') return;

  try {
    // 索引很小（个人笔记量级），全量重建最简单也最不容易出不一致
    await dbExecute('DELETE FROM note_index', []);
    await dbExecute('DELETE FROM note_record', []);

    for (const note of notes) {
      const rel = String(note?.rel_path || '');
      if (!rel) continue;

      const ids = normalizeRecordIds(note?.record_ids ?? note?.record_id);
      const linked = ids.length > 0;

      const params = [
        rel,
        note.title || '',
        note.note_type || 'idea',
        note.status || 'usable',
        note.tag || '',
        note.sub_tag || '',
      ];
      if (linked) params.push(ids[0]);
      params.push(note.created_at || '', note.updated_at || '');

      await dbExecute(
        `INSERT OR REPLACE INTO note_index
         (rel_path, title, note_type, status, tag, sub_tag, record_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ${linked ? '?' : 'NULL'}, ?, ?)`,
        params
      );

      if (linked) {
        // 一篇一次多值 INSERT：把 IPC 次数压到「1 + 篇数」而不是「1 + 关联数」。
        // 主键 (rel_path, record_id) + INSERT OR IGNORE 让重复行在数据库层就不可能存在。
        const placeholders = ids.map(() => '(?, ?)').join(', ');
        const values = ids.flatMap(id => [rel, id]);
        await dbExecute(
          `INSERT OR IGNORE INTO note_record (rel_path, record_id) VALUES ${placeholders}`,
          values
        );
      }
    }
  } catch (error) {
    // 索引只是加速列表与搜索，同步失败不影响笔记本身。
    // 但要往日志文件里写一笔：否则「列表有笔记、搜索找不到」没法排查。
    logToFile('warn', `笔记索引同步失败（不影响笔记本身）: ${error?.stack || error}`);
  }
}
