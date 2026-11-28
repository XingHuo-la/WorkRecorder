// 层级树的纯函数集：不碰数据库、不碰 DOM、不 import 任何业务模块。
//
// 为什么必须是纯函数：层级逻辑（建森林 / 环检测 / 缩进降级）是最容易出错、
// 又最难在真应用里复现的部分 —— 要造出 6 层数据、要复现「父被筛掉」、
// 要复现「旧数据有环」。做成纯函数后，调试壳拿一组假数据就能全部跑一遍。
//
// 数据层没有深度限制：parent_id 想指多深就多深。
// 约束只存在于**视觉层** —— 第一列宽约 260px，每级缩进 16px，
// 到第 6 层文字就只剩 180px，读不出区别。所以：
//   前 indentMax 层逐级缩进，之后缩进封顶，改用「⋯ 祖父 / 父」路径前缀表达位置。
// 注意是**封顶**不是**压平**：压平会丢信息且不可逆（建了 6 层只显示 3 层，剩下 3 层永远看不见）。

const DEFAULT_INDENT_STEP = 16;
const DEFAULT_INDENT_MAX = 3;
const MAX_GUARD_STEPS = 4096;

/**
 * 把各种形态的 id 归一成 number|null。
 * DB 取回来是 number，但 URL / dataset / 表单传过来是 string，混用会让 Map 查不到。
 * @param {*} value
 * @returns {number|null}
 */
export function toId(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * 环检测：从 parentId 逐级上溯，遇到 childId 就说明会成环。
 *
 * 不能只看「一层」：A 的父是 B、B 的父是 C、C 的父是 A，三层才成环。
 * 也不能假设数据干净：旧库里可能已经有环（v10 之前的 parent_id 没做过校验），
 * 所以上溯时用一个 seen 集合，撞到走过的节点就停下并返回 false ——
 * 那是历史脏数据，不是这次要建的新环，不该拦住用户当前的操作。
 *
 * @param {number|string} childId  即将成为子项的记录
 * @param {number|string|null} parentId  目标父记录
 * @param {(id:number) => Promise<{id:number, parent_id:number|null}|null>} parentOf  取父函数，由调用方注入
 * @returns {Promise<boolean>} true = 会成环，禁止写入
 */
export async function wouldCreateCycle(childId, parentId, parentOf) {
  const self = toId(childId);
  const target = toId(parentId);
  if (self === null || target === null) return false;
  if (target === self) return true; // 自己是自己的父
  if (typeof parentOf !== 'function') return false;

  const seen = new Set([self]);
  let cursor = target;
  let steps = 0;

  while (cursor !== null && steps < MAX_GUARD_STEPS) {
    if (seen.has(cursor)) return false; // 撞到走过的节点：旧数据里的环，不是新环
    seen.add(cursor);
    steps += 1;

    const node = await parentOf(cursor);
    if (!node) return false; // 父不存在：断链，谈不上环
    const next = toId(node.parent_id);
    if (next === self) return true;
    cursor = next;
  }

  return false;
}

/**
 * 把一批平铺记录折成森林。**O(n)，与深度无关**。
 *
 * 为什么不用递归 CTE：渲染整张表本来就要把所有行读进内存，CTE 等于把已在内存里的
 * 数据再算一遍，还要多一次 IPC；而「折叠某枝」「筛选后重建树」在 JS 里是 Set 过滤，
 * 用 CTE 就得重写 SQL 并重新 round-trip（每次滚动都可能触发）。
 *
 * 父不在本批的行（被筛选掉 / 跨表脏数据）**当根处理**，绝不丢行 ——
 * 丢行的表现是「表格里少了几条」，用户会以为数据损坏。
 *
 * @param {Array<{id:number, parent_id:number|null, title?:string}>} rows 已按 sort,id 排序
 * @returns {{roots: TreeNode[], byId: Map<number, TreeNode>, depthById: Map<number, number>}}
 *          TreeNode = { row, id, parentId, depth, children: TreeNode[] }
 */
export function buildForest(rows) {
  const byId = new Map();

  (Array.isArray(rows) ? rows : []).forEach(row => {
    if (!row) return;
    const id = toId(row.id);
    if (id === null) return;
    byId.set(id, {
      row,
      id,
      parentId: toId(row.parent_id),
      depth: 0,
      children: [],
    });
  });

  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentId === null ? null : byId.get(node.parentId);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  // 深度用队列（BFS）算，不用递归：递归深度 = 数据深度，用户能建多深我们不该猜
  const depthById = new Map();
  const reached = new Set();
  const queue = roots.map(node => ({ node, depth: 1 }));
  let head = 0;
  while (head < queue.length) {
    const { node, depth } = queue[head];
    head += 1;
    if (reached.has(node.id)) continue;
    reached.add(node.id);
    node.depth = depth;
    depthById.set(node.id, depth);
    for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
  }

  // 环兜底：环上的节点互相是对方的父，从任何根都走不到。
  // 不补这一步，这些行会在表格里凭空消失（而且是静默的）。
  // 处理方式：把它从父的 children 里摘掉、当根重新铺开 —— 一行都不丢。
  for (const node of byId.values()) {
    if (reached.has(node.id)) continue;
    const parent = node.parentId === null ? null : byId.get(node.parentId);
    if (parent) {
      const index = parent.children.indexOf(node);
      if (index >= 0) parent.children.splice(index, 1);
    }
    node.parentId = null;
    roots.push(node);

    const sub = [{ node, depth: 1 }];
    let subHead = 0;
    while (subHead < sub.length) {
      const { node: current, depth } = sub[subHead];
      subHead += 1;
      if (reached.has(current.id)) continue;
      reached.add(current.id);
      current.depth = depth;
      depthById.set(current.id, depth);
      for (const child of current.children) sub.push({ node: child, depth: depth + 1 });
    }
  }

  return { roots, byId, depthById };
}

/**
 * 把森林折算成「可见行序列」（DFS 先序）。纯展示层，不改数据。
 * 被折叠节点的**整枝**剔除（含曾孙，不只是直接子项）。
 *
 * @param {Array} rows 平铺记录（同 buildForest 入参）
 * @param {Set<number>|number[]} collapsedIds 折叠的节点 id
 * @param {{indentMax?:number, indentStep?:number, pathPrefix?:boolean}} [opts]
 *        indentMax 默认 3，indentStep 默认 16，pathPrefix 默认 true
 * @returns {Array<{
 *   row: object,
 *   depth: number,       真实深度，从 1 起，**不封顶**
 *   indent: number,      实际缩进 px，超过 indentMax 后恒定
 *   pathPrefix: string,  depth<=indentMax 时为 ''；否则 '⋯ 系统 / 设备'
 *   pathFull: string,    全路径（含自身），给 title 属性用
 *   hasChildren: boolean,
 *   childCount: number,  直接子项数（不含孙）
 *   isCollapsed: boolean
 * }>}
 */
export function flattenVisibleTree(rows, collapsedIds, opts = {}) {
  const indentMax = Math.max(1, Number(opts.indentMax) || DEFAULT_INDENT_MAX);
  const indentStep = Number(opts.indentStep) || DEFAULT_INDENT_STEP;
  const withPathPrefix = opts.pathPrefix !== false;
  const collapsed = collapsedIds instanceof Set
    ? collapsedIds
    : new Set((Array.isArray(collapsedIds) ? collapsedIds : []).map(toId).filter(v => v !== null));

  const { roots } = buildForest(rows);
  const visible = [];
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    stack.push({ node: roots[i], depth: 1, ancestors: [] });
  }

  while (stack.length) {
    const { node, depth, ancestors } = stack.pop();
    const children = node.children || [];
    const isCollapsed = collapsed.has(node.id);

    visible.push(describeVisible(node, depth, ancestors, children.length, isCollapsed, {
      indentMax,
      indentStep,
      withPathPrefix,
      // 标题从哪来由宿主决定：预置表有 record.title，自建表的标题在 values 的某个文本列里，
      // 内核不该知道这件事。不传就退到 row.title / #id。
      titleOf: opts.titleOf,
    }));

    // 折叠了就不再把子项压栈 —— 整枝消失，而不是只隐藏直接子项
    if (isCollapsed) continue;

    const nextAncestors = ancestors.concat([node]);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], depth: depth + 1, ancestors: nextAncestors });
    }
  }

  return visible;
}

function titleOf(node, cfg = {}) {
  if (typeof cfg.titleOf === 'function') {
    const custom = cfg.titleOf(node && node.row);
    if (custom != null && String(custom).trim()) return String(custom).trim();
  }
  const title = node && node.row ? String(node.row.title ?? '').trim() : '';
  return title || `#${node.id}`;
}

function describeVisible(node, depth, ancestors, childCount, isCollapsed, cfg) {
  // 缩进封顶：第 indentMax 层之后不再增加，否则字段名会被挤成「2 号…」
  const cappedDepth = Math.min(depth, cfg.indentMax);
  const indent = (cappedDepth - 1) * cfg.indentStep;

  const labels = ancestors.map(item => titleOf(item, cfg));
  // 路径取祖先链**末两段**：第一列只有 260px，全路径会占满整行反而更糟；
  // 完整链路在行详情抽屉的面包屑里，以及这里的 title 属性（pathFull）。
  const pathPrefix = cfg.withPathPrefix && depth > cfg.indentMax && labels.length
    ? `⋯ ${labels.slice(-2).join(' / ')}`
    : '';

  return {
    row: node.row,
    depth,
    indent,
    pathPrefix,
    pathFull: labels.concat([titleOf(node, cfg)]).join(' / '),
    hasChildren: childCount > 0,
    childCount,
    isCollapsed,
  };
}

/**
 * 在内存里拼祖先链（自根到父，不含自身）。给「同一批数据内部」的面包屑用。
 * 跨表 / 跨批的面包屑走 recordStore.listAncestors（那条要查库）。
 *
 * @param {Map<number, {row?:object, parent_id?:number|null, id?:number}>} byId
 * @param {number|string} id
 * @param {{limit?:number}} [opts] limit 只是防脏数据里的环，不是深度限制
 * @returns {object[]} 自根到父
 */
export function buildAncestorChain(byId, id, opts = {}) {
  if (!(byId instanceof Map)) return [];
  const limit = Math.max(1, Number(opts.limit) || 64);
  const chain = [];
  const seen = new Set([toId(id)]);
  let cursor = toId(id);
  let steps = 0;

  while (cursor !== null && steps < limit) {
    const node = byId.get(cursor);
    if (!node) break;
    const parentId = toId(node.row ? node.row.parent_id : node.parent_id);
    if (parentId === null || seen.has(parentId)) break;
    const parent = byId.get(parentId);
    if (!parent) break;
    seen.add(parentId);
    chain.unshift(parent.row || parent);
    cursor = parentId;
    steps += 1;
  }

  return chain;
}

/**
 * 「移入其他行下」的候选集：排掉自己 + 自己的全部后代，其余整棵树铺开。
 *
 * 为什么必须排掉后代：把 A 挂到 A 的孙子下面会让 A→孙子→A 成环，那几个节点
 * 从任何根都走不到。buildForest 有兜底（摘掉当根重铺，一行不丢），但那是给
 * 历史脏数据用的 —— 不该让用户在一个正常操作里自己造出环来。
 *
 * 为什么不受折叠影响：折叠着的行就选不到，这个功能等于废了。候选一律全铺开，
 * 由调用方负责视觉（缩进封顶到 6 级，再深就只差 16px，看不出层级）。
 *
 * @param {Array} rows 当前表整批记录（含 parent_id）
 * @param {number|string} selfId 被移动的那一行
 * @param {{indentMax?:number, indentStep?:number}} [opts]
 * @returns {{banned: Set<number>, entries: Array, selfId: number|null}}
 *          banned 含自己（所以「排掉几行」= banned.size - 1）
 */
export function moveCandidates(rows, selfId, opts = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const self = toId(selfId);
  const banned = new Set();
  if (self !== null) {
    banned.add(self);
    // 迭代到不动点，不用递归：一行可能比它的父晚被扫到（sort 顺序与父子顺序无关），
    // 扫一轮不够；而递归要带深度上限，反而要猜用户能建多深。
    // 环不会让它死循环 —— banned 只增不减，且有界于行数。
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of list) {
        const id = toId(item.id);
        if (id === null || banned.has(id)) continue;
        const parentId = toId(item.parent_id);
        if (parentId !== null && banned.has(parentId)) {
          banned.add(id);
          grew = true;
        }
      }
    }
  }

  const entries = flattenVisibleTree(list, new Set(), {
    indentMax: opts.indentMax == null ? 6 : opts.indentMax,
    indentStep: opts.indentStep,
    pathPrefix: false,
  }).filter(entry => !banned.has(toId(entry.row.id)));

  return { banned, entries, selfId: self };
}
