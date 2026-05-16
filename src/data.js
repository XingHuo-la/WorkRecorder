const { invoke } = window.__TAURI__.core;

export let appData = null;

// ==========================================
// 🌟 1. 新增：万能数据库查询器 (向 Rust 发送 SQL 拿数据)
// ==========================================
export async function dbQuery(sql, params = []) {
    try {
        const res = await invoke('db_query', { query: sql, params: params.map(String) });
        return JSON.parse(res);
    } catch (e) {
        console.error("❌ 数据库查询失败:", e);
        return [];
    }
}

// ==========================================
// 🌟 2. 新增：万能数据库执行器 (向 Rust 发送 SQL 增、删、改)
// ==========================================
export async function dbExecute(sql, params = []) {
    try {
        return await invoke('db_execute', { query: sql, params: params.map(String) });
    } catch (e) {
        console.error("❌ 数据库执行失败:", e);
        return 0;
    }
}

// ==========================================
// 🌟 3. 核心改造：从 SQLite 极速加载数据，并拼装成兼容旧版的格式
// ==========================================
export async function loadData() {
  try {
    console.log("🚀 正在从 SQLite 极速加载数据...");
    
    // 并发向数据库要数据，速度极快
    const tagsRes = await dbQuery("SELECT name FROM tags");
    const subTagsRes = await dbQuery("SELECT main_tag, name FROM sub_tags");
    const settingsRes = await dbQuery("SELECT key, value FROM settings");
    const todosRes = await dbQuery("SELECT * FROM todos");
    const logsRes = await dbQuery("SELECT * FROM logs ORDER BY date DESC, time DESC");

    // 组装成旧版 UI 认识的 appData 格式（平滑过渡魔法）
    appData = {
        tags: tagsRes.map(t => t.name),
        sub_tags: {},
        settings: { active_tags: tagsRes.map(t => t.name) }, // 兜底
        todos: todosRes.map(t => ({
            id: t.id, // ✨ 重点：现在每条数据都有了真实的数据库 ID！
            task: t.task, 
            done: t.done === 1 || t.done === 'true' || t.done === true,
            tag: t.tag, sub_tag: t.sub_tag, detail: t.detail, remark: t.remark,
            deadline: t.deadline, completed_at: t.completed_at
        })),
        logs: {}
    };

    // 还原：子项目
    subTagsRes.forEach(st => {
        if (!appData.sub_tags[st.main_tag]) appData.sub_tags[st.main_tag] = [];
        appData.sub_tags[st.main_tag].push(st.name);
    });

    // 还原：设置项
    settingsRes.forEach(s => {
        appData.settings[s.key] = s.value;
        if (s.key === 'auto_cleanup_days') appData.settings[s.key] = parseInt(s.value);
        if (s.key === 'active_tags') {
            try { appData.settings.active_tags = JSON.parse(s.value); } catch(e){}
        }
    });

    // 还原：流水记录 (按日期分组)
    logsRes.forEach(l => {
        if (!appData.logs[l.date]) appData.logs[l.date] = [];
        appData.logs[l.date].push({
            id: l.id, // ✨ 真实数据库 ID
            time: l.time, text: l.text, tag: l.tag, sub_tag: l.sub_tag,
            detail: l.detail, remark: l.remark, linked_todo: l.linked_todo,
            deadline: l.deadline, 
            is_overdue: l.is_overdue === 1 || l.is_overdue === 'true' || l.is_overdue === true
        });
    });

    return appData;
  } catch (error) {
    console.error("读取数据失败:", error);
  }
}

// ==========================================
// 💣 4. 核心改造：切断旧版的“全量保存”
// ==========================================
export async function saveData() {
  // 以前这里会覆盖整个 JSON 文件，现在我们把它掏空。
  // 因为真正的保存，将会在接下来的 Step 3 中，直接使用 dbExecute 写入单条数据！
  console.warn("⚠️ 提示：系统已升级为 SQLite，传统的全量 saveData() 已停用。现在是临时只读模式。");
}

// 获取今天的日期 (格式: YYYY-MM-DD)
export function getTodayString() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 获取某个主标签下，历史上使用过的所有子标签
export function getHistoricalSubTags(mainTag) {
  if (!mainTag || mainTag === "➕ 创建新主标签...") return [];
  const subTags = new Set();
  Object.values(appData.logs).forEach(dayLogs => {
    dayLogs.forEach(log => { if (log.tag === mainTag && log.sub_tag) subTags.add(log.sub_tag); });
  });
  appData.todos.forEach(todo => {
    if (todo.tag === mainTag && todo.sub_tag) subTags.add(todo.sub_tag);
  });
  return Array.from(subTags).sort();
}