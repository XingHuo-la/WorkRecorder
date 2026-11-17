// record 的统一读写层。新代码一律走这里，不要各自拼 SQL。
//
// 为什么必须存在这一层（不是「为了好看封一层」）：
//  ① 可空列陷阱：dbExecute 会把参数 map(String)，传 null 会落成字符串 'null'。
//     INTEGER 列里存 'null' 之后，WHERE parent_id IS NULL 与 = 3 都匹配不到 ——
//     表现是「提升一级 / 移出表格 / 解绑笔记」看起来成功了，实际行凭空消失，全程零报错。
//     所以所有 null 都由这里改写为 SQL 字面量 NULL，调用方不必也不该操心。
//  ② 删记录不是一条 DELETE：要先把子项提到祖父、清理同表引用、释放挂载的表。
//     散落在各个 UI 里必然会漏一个，漏掉的表现同样是静默的。
//  ③ 环检测只有在这里才拦得住：setParent 是唯一写 parent_id 的入口。
//
// 依赖注入 adapter（与 sheetStore 一致），好处是调试壳能换假数据。

import { wouldCreateCycle, toId } from './recordTree.js';

let adapter = null;

export function setRecordAdapter(next) {
  adapter = next;
}

export function isRecordStoreReady() {
  return Boolean(adapter);
}

function db() {
  if (!adapter) throw new Error('记录数据通道未就绪');
  return adapter;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function nowStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function todayStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// 取整条记录用。列名写全，避免 SELECT * 把以后新增的大字段（比如未来的附件 JSON）拖进来。
const RECORD_COLUMNS = [
  'id', 'kind', 'title', 'body', 'remark', 'status',
  'happened_date', 'happened_time', 'deadline', 'tag', 'sub_tag',
  'parent_id', 'linked_todo', 'is_overdue', 'record_type',
  'sheet_id', 'sort', 'height', 'start_at', 'end_at', 'completed_at',
  'custom', 'legacy_id', 'created_at', 'updated_at', 'deleted_at',
].join(', ');

// 允许 patch 的列。kind / legacy_id / id / created_at 是结构列，不在名单里 ——
// kind 是「出生地」，一旦能被改，「删表时哪些行随表销毁」的语义就崩了。
const PATCHABLE = new Set([
  'title', 'body', 'remark', 'status', 'happened_date', 'happened_time',
  'deadline', 'tag', 'sub_tag', 'parent_id', 'linked_todo', 'is_overdue',
  'record_type', 'sheet_id', 'sort', 'height', 'start_at', 'end_at',
  'completed_at', 'custom',
]);

function safeParse(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function normalizeRow(row) {
  if (!row) return null;
  return { ...row, custom: safeParse(row.custom, {}) };
}

/**
 * 取单条记录，custom 已 JSON.parse。
 * @param {number|string} id
 * @returns {Promise<object|null>}
 */
export async function getRecord(id) {
  const recordId = toId(id);
  if (recordId === null) return null;
  const rows = await db().dbQuery(`SELECT ${RECORD_COLUMNS} FROM record WHERE id = ?`, [recordId]);
  return normalizeRow(rows?.[0]);
}

/**
 * 一次取多条（抽屉里点关联 chip、hydrateRelations 都用到）。
 * @param {Array<number|string>} ids
 * @returns {Promise<object[]>}
 */
export async function getRecords(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(toId).filter(v => v !== null);
  if (!list.length) return [];
  const marks = list.map(() => '?').join(', ');
  const rows = await db().dbQuery(`SELECT ${RECORD_COLUMNS} FROM record WHERE id IN (${marks})`, list);
  return (rows || []).map(normalizeRow);
}

/**
 * 取直接子项（一层，不含孙）。
 * @param {number|string} parentId
 * @returns {Promise<object[]>} 按 sort, id
 */
export async function listChildren(parentId) {
  const id = toId(parentId);
  if (id === null) return [];
  const rows = await db().dbQuery(
    `SELECT ${RECORD_COLUMNS} FROM record WHERE parent_id = ? AND deleted_at = '' ORDER BY sort, id`,
    [id]
  );
  return (rows || []).map(normalizeRow);
}

/**
 * 取祖先链，**自根到父**（面包屑直接用），自身不含在内。
 *
 * 不设深度上限：一直上溯到 parent_id 为 null。
 * guardSteps 只是防旧数据里的环（死循环保护），不是深度限制 ——
 * 这两件事必须分开，否则「数据层无限制」就成了空话。
 *
 * @param {number|string} recordId
 * @param {{guardSteps?: number}} [opts] 默认 64，远超任何合理深度，只在成环时命中
 * @returns {Promise<Array<{id:number, title:string, kind:string, sheet_id:number|null}>>}
 */
export async function listAncestors(recordId, opts = {}) {
  const start = toId(recordId);
  if (start === null) return [];
  const guard = Math.max(1, Number(opts.guardSteps) || 64);

  const chain = [];
  const seen = new Set([start]);
  let step = 0;

  const first = await db().dbQuery('SELECT parent_id FROM record WHERE id = ?', [start]);
  let parentId = toId(first?.[0]?.parent_id);

  while (parentId !== null && step < guard && !seen.has(parentId)) {
    seen.add(parentId);
    const rows = await db().dbQuery(
      'SELECT id, parent_id, title, kind, sheet_id FROM record WHERE id = ?',
      [parentId]
    );
    const row = rows?.[0];
    if (!row) break;
    chain.unshift({
      id: row.id,
      title: row.title,
      kind: row.kind,
      sheet_id: row.sheet_id == null ? null : Number(row.sheet_id),
    });
    parentId = toId(row.parent_id);
    step += 1;
  }

  return chain;
}

/**
 * 挂载在某一行上的表。
 * @param {number|string} recordId 挂载点 record id
 * @returns {Promise<Array<{id:number, name:string, anchor_record_id:number, row_count:number, field_count:number}>>}
 */
export async function listChildSheets(recordId) {
  const id = toId(recordId);
  if (id === null) return [];
  const rows = await db().dbQuery(
    `SELECT s.id, s.name, s.task_id AS anchor_record_id,
            (SELECT COUNT(*) FROM sheet_field f WHERE f.sheet_id = s.id) AS field_count,
            (SELECT COUNT(*) FROM record r WHERE r.sheet_id = s.id) AS row_count
       FROM sheet s
      WHERE s.task_id = ?
      ORDER BY s.sort, s.id`,
    [id]
  );
  return rows || [];
}

/**
 * 白名单列更新。**nullable 列传 null 会写成 SQL 字面量 NULL**，
 * 不走参数（dbExecute 会 params.map(String)，null 会落成 'null'）。
 *
 * @param {number|string} id
 * @param {object} patch 只认 PATCHABLE 里的列；undefined = 不修改，null = 置空
 * @returns {Promise<void>}
 */
export async function patchRecord(id, patch = {}) {
  const recordId = toId(id);
  if (recordId === null) return;

  const sets = [];
  const params = [];

  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE.has(key)) continue;
    if (value === undefined) continue;
    if (value === null) {
      sets.push(`${key} = NULL`);
      continue;
    }
    if (key === 'custom') {
      sets.push('custom = ?');
      params.push(JSON.stringify(value || {}));
      continue;
    }
    sets.push(`${key} = ?`);
    params.push(value);
  }

  if (!sets.length) return;
  sets.push('updated_at = ?');
  params.push(nowStamp());

  await db().dbExecute(`UPDATE record SET ${sets.join(', ')} WHERE id = ?`, [...params, recordId]);
}

/**
 * 新建。kind 由调用方决定；写 record 表，不经视图
 * （走视图会被触发器强制成 'sheet_row'，等于「新记录也没有出生地」）。
 *
 * 用 INSERT ... RETURNING id 拿新 id，不用 MAX(id)：
 * MAX(id) 在插入失败时会返回「上一条记录的 id」，调用方拿去打开就是错的记录。
 * RETURNING 在插入失败时抛错，这正是我们想要的。
 *
 * @param {{kind?:string, title?:string, body?:string, sheetId?:number|null,
 *          parentId?:number|null, status?:string, tag?:string, subTag?:string,
 *          custom?:object, happenedDate?:string, happenedTime?:string,
 *          deadline?:string, recordType?:string}} fields
 * @returns {Promise<number>} 新 id
 */
export async function createRecord(fields = {}) {
  const kind = String(fields.kind || 'log');
  const stamp = nowStamp();

  const defaults = {
    kind,
    title: fields.title ?? '',
    body: fields.body ?? '',
    remark: '',
    status: fields.status ?? (kind === 'todo' ? 'pending' : kind === 'log' ? 'inbox' : 'done'),
    happened_date: fields.happenedDate ?? (kind === 'log' ? todayStamp() : ''),
    happened_time: fields.happenedTime ?? '',
    deadline: fields.deadline ?? '',
    tag: fields.tag ?? '',
    sub_tag: fields.subTag ?? '',
    record_type: fields.recordType ?? (kind === 'log' ? 'log' : ''),
    custom: JSON.stringify(fields.custom || {}),
    created_at: stamp,
    updated_at: stamp,
  };

  // 这两列可空，且必须落成 SQL NULL，不能走参数
  const nullable = {
    sheet_id: fields.sheetId == null ? null : Number(fields.sheetId),
    parent_id: fields.parentId == null ? null : Number(fields.parentId),
  };

  const entries = [...Object.entries(defaults), ...Object.entries(nullable)];
  const columns = entries.map(([key]) => key);
  const marks = entries.map(([, value]) => (value === null ? 'NULL' : '?'));
  const params = entries.filter(([, value]) => value !== null).map(([, value]) => value);

  const rows = await db().dbQuery(
    `INSERT INTO record (${columns.join(', ')}) VALUES (${marks.join(', ')}) RETURNING id`,
    params
  );
  const newId = toId(rows?.[0]?.id);
  if (newId === null) throw new Error('新建记录失败：没有拿到新 id');
  return newId;
}

/**
 * 设父。内部先跑环检测，成环则**不写**并返回原因（不抛错，UI 要弹提示而不是崩）。
 * @param {number|string} childId
 * @param {number|string|null} parentId null = 提到顶层
 * @returns {Promise<{ok:boolean, reason?:'cycle'|'self'|'missing'}>}
 */
export async function setParent(childId, parentId) {
  const child = toId(childId);
  const parent = toId(parentId);
  if (child === null) return { ok: false, reason: 'missing' };
  if (parent !== null && parent === child) return { ok: false, reason: 'self' };

  if (parent !== null) {
    const childRow = await getRecord(child);
    if (!childRow) return { ok: false, reason: 'missing' };
    const cycle = await wouldCreateCycle(child, parent, async id => {
      const rows = await db().dbQuery('SELECT id, parent_id FROM record WHERE id = ?', [id]);
      return rows?.[0] || null;
    });
    if (cycle) return { ok: false, reason: 'cycle' };
  }

  await patchRecord(child, { parent_id: parent });
  return { ok: true };
}

/**
 * 按关键字搜记录，供「把笔记挂到记录上」的搜索框（R03）使用。
 *
 * 两条匹配规则刻意不对称：
 *  - **标题**用 `LIKE '%kw%'`（模糊，用户记得半个词）
 *  - **id** 用等值 `id = ?`（精确，不能写 `'%12%'` —— 那会把 #123、#120 一起命中
 *    并且看起来「搜 12 出现了三条」，用户选哪条都可能挂错）
 *
 * LIKE 里的 `%` / `_` / `\` 会被转义（`ESCAPE '\'`）：标题里带「50%」时
 * 不加转义搜不到；而 `%` 当通配符会让「搜 %」返回全部记录。
 *
 * limit 直接拼进 SQL（不参数化）：它是本函数夹紧后的整数，不是外部字符串，
 * 参数化反而要过一遍 params.map(String)，LIMIT '20' 的类型转换没必要赌。
 *
 * @param {string} keyword 关键字（标题片段或记录 id）
 * @param {{limit?: number, excludeIds?: Array<number|string>}} [opts]
 *        limit 默认 20、上限 50；excludeIds 里的 id 不返回（「已挂的」不用再列）
 * @returns {Promise<Array<{id:number, title:string, kind:string}>>} 按 updated_at 倒序
 */
export async function searchRecords(keyword, opts = {}) {
  const raw = String(keyword ?? '').trim();
  const limit = Math.min(50, Math.max(1, Math.trunc(Number(opts.limit)) || 20));
  const exclude = (Array.isArray(opts.excludeIds) ? opts.excludeIds : [])
    .map(toId)
    .filter(v => v !== null);

  const params = [];
  const where = [];

  if (raw) {
    // 「标题模糊」与「id 精确」是**并列的两个 OR 分支**，不能 join 成 AND ——
    // 写成 AND 的话 `id = 15` 会要求标题里也含 "15"，搜 id 永远返回空。
    const orParts = [];
    // 转义后再套 %：顺序不能反（先套 % 会把用户输入里的 % 当通配符）
    const escaped = raw.replace(/[\\%_]/g, ch => `\\${ch}`);
    orParts.push("title LIKE ? ESCAPE '\\'");
    params.push(`%${escaped}%`);

    // 纯数字才追加 id 等值匹配；'12abc' / '2 号机组' 不该被当成 id
    if (/^\d+$/.test(raw)) {
      const id = toId(raw);
      if (id !== null && id > 0) {
        orParts.push('id = ?');
        params.push(id);
      }
    }
    where.push(`(${orParts.join(' OR ')})`);
  }

  if (exclude.length) {
    where.push(`id NOT IN (${exclude.map(() => '?').join(', ')})`);
    params.push(...exclude);
  }

  // 软删除的记录不参与搜索。这里必须显式写：searchRecords 直读 record，
  // 不走三个视图，视图的 kind 过滤救不了它。
  where.push("deleted_at = ''");

  // 关键字为空且没有排除项时，where 为空 —— 返回最近的 N 条（等价于「随便挑」）
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await db().dbQuery(
    `SELECT id, title, kind FROM record ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ${limit}`,
    params
  );
  return rows || [];
}

/**
 * 删除一条记录。三件事，顺序固定：
 *   1) 子项 parent_id 提到祖父 —— 父子是「拆步骤」，不是「依附」，不级联删
 *      （用户建的是「第 1 步 / 第 2 步」，删掉第 2 步不等于第 3 步作废）
 *   2) 释放挂载在本行上的表 —— 表保留，只解除挂载（表本身是独立的）
 *   3) 清理同表 relation 引用 —— 只扫「目标表 = 本条所属表」的字段，范围确定
 *   4) DELETE
 * 跨表引用**不在这里清理**，靠渲染容错（灰色占位）+ 设置页手动清理。
 * 理由：跨表清理要扫全库所有 relation 字段的所有行，失败后没有好的恢复路径，
 * 不值得为一条悬空引用付这个风险。
 *
 * @param {number|string} id
 * @returns {Promise<{reparented:number, releasedSheets:number, clearedRefs:number, childCount:number}>}
 */
export async function deleteRecord(id) {
  const recordId = toId(id);
  const record = await getRecord(recordId);
  if (!record) return { reparented: 0, releasedSheets: 0, clearedRefs: 0, childCount: 0 };

  // 1) 子项提到祖父
  const children = await listChildren(recordId);
  for (const child of children) {
    await patchRecord(child.id, { parent_id: record.parent_id ?? null });
  }

  // 2) 释放挂载点：表保留
  let releasedSheets = 0;
  const mounted = await listChildSheets(recordId);
  if (mounted.length) {
    await db().dbExecute('UPDATE sheet SET task_id = NULL, updated_at = ? WHERE task_id = ?', [
      nowStamp(),
      recordId,
    ]);
    releasedSheets = mounted.length;
  }

  // 3) 同表引用清理
  let clearedRefs = 0;
  if (record.sheet_id !== null && record.sheet_id !== undefined) {
    const sheetId = Number(record.sheet_id);
    const fields = await db().dbQuery(
      "SELECT id, key, options FROM sheet_field WHERE sheet_id = ? AND type = 'relation'",
      [sheetId]
    );
    const selfReferencing = (fields || []).filter(field => {
      const options = safeParse(field.options, {});
      return Number(options.targetSheetId) === sheetId;
    });

    if (selfReferencing.length) {
      const rows = await db().dbQuery('SELECT id, custom FROM record WHERE sheet_id = ?', [sheetId]);
      for (const row of rows || []) {
        const custom = safeParse(row.custom, {});
        let dirty = false;
        for (const field of selfReferencing) {
          const value = custom[field.key];
          if (!Array.isArray(value)) continue;
          const next = value.filter(item => Number(item) !== recordId);
          if (next.length === value.length) continue;
          custom[field.key] = next;
          dirty = true;
        }
        if (!dirty) continue;
        await db().dbExecute('UPDATE record SET custom = ?, updated_at = ? WHERE id = ?', [
          JSON.stringify(custom),
          nowStamp(),
          Number(row.id),
        ]);
        clearedRefs += 1;
      }
    }
  }

  // 4) 软删除（v13）。不再真删：记录留在库里，只打标记，Ctrl+Z 才恢复得回来。
  //    级联三步（提子项 / 释放表 / 清引用）照旧执行 —— 界面语义仍是一次「删除」，
  //    子项不能挂在一条看不见的记录下面。代价是撤销只回滚记录本体，不回滚这三步。
  await db().dbExecute(
    "UPDATE record SET deleted_at = ?, kind = kind || '#deleted' WHERE id = ? AND kind NOT LIKE '%#deleted'",
    [nowStamp(), recordId]
  );

  return {
    reparented: children.length,
    releasedSheets,
    clearedRefs,
    childCount: children.length,
  };
}

/**
 * 撤销删除：把 kind 上的 '#deleted' 摘掉、清空 deleted_at。
 *
 * 为什么 kind 后缀是「删除标记」而不是加一列 `is_deleted`：
 * 三个视图的 WHERE 是 `kind='log'` 这类等值判断，kind 一变它们自动过滤，
 * 前端 90 余处 SQL 零改动、零遗漏。加列则要给每个读路径补条件，漏一个就是
 * 「删掉的记录还在界面上」这种静默 bug。
 *
 * @param {number|string} id
 * @returns {Promise<object|null>} 恢复后的记录；记录不存在时 null
 */
export async function restoreRecord(id) {
  const recordId = toId(id);
  if (recordId === null) return null;
  await db().dbExecute(
    "UPDATE record SET deleted_at = '', kind = REPLACE(kind, '#deleted', '') WHERE id = ?",
    [recordId]
  );
  return getRecord(recordId);
}

/**
 * 回收站列表。按删除时间倒序，默认最近 100 条。
 * @param {{limit?: number}} [opts]
 */
export async function listDeletedRecords(opts = {}) {
  const limit = Math.min(500, Math.max(1, Math.trunc(Number(opts.limit)) || 100));
  const rows = await db().dbQuery(
    `SELECT ${RECORD_COLUMNS} FROM record WHERE deleted_at != '' ORDER BY deleted_at DESC, id DESC LIMIT ${limit}`,
    []
  );
  return (rows || []).map(normalizeRow);
}

/**
 * 真删（清空回收站 / 定时清理）。
 *
 * 默认只清 30 天前的，手工点「清空回收站」时传 `olderThanDays: 0`。
 * 附件文件不在这里删：路径存在 custom.attachments 里，删记录前要先收集再删文件，
 * 这一步留给调用方，否则回收站里恢复出来的记录会全是死链。
 *
 * @param {{olderThanDays?: number}} [opts]
 * @returns {Promise<number>} 删掉的行数
 */
export async function purgeDeletedRecords(opts = {}) {
  const days = Number.isFinite(Number(opts.olderThanDays)) ? Math.max(0, Number(opts.olderThanDays)) : 30;
  if (days === 0) {
    const rows = await db().dbQuery("SELECT id FROM record WHERE deleted_at != ''", []);
    await db().dbExecute("DELETE FROM record WHERE deleted_at != ''", []);
    return (rows || []).length;
  }
  const rows = await db().dbQuery(
    `SELECT id FROM record WHERE deleted_at != '' AND deleted_at < datetime('now','localtime', ?)`,
    [`-${days} days`]
  );
  await db().dbExecute(
    `DELETE FROM record WHERE deleted_at != '' AND deleted_at < datetime('now','localtime', ?)`,
    [`-${days} days`]
  );
  return (rows || []).length;
}

/**
 * 移入表格。**kind 不变**，只写 sheet_id —— 这就是「保留出生地」：
 * 一条随手记进了表格，它仍然是随手记，删表时会退回记录页而不是被销毁。
 * @param {number|string} recordId
 * @param {number|string} sheetId
 */
export async function moveRecordToSheet(recordId, sheetId) {
  const sheet = toId(sheetId);
  if (sheet === null) throw new Error('目标表格无效');
  await patchRecord(recordId, { sheet_id: sheet });
}

/**
 * 移出表格：sheet_id 置 NULL，kind 不变，回到「记录」页。
 * @param {number|string} recordId
 */
export async function removeRecordFromSheet(recordId) {
  await patchRecord(recordId, { sheet_id: null });
}
