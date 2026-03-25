const { invoke } = window.__TAURI__.core;

// 这是一个全局的数据仓库，供所有模块读取
export let appData = null;

// 从底层读取数据
export async function loadData() {
  try {
    const dataString = await invoke('load_data');
    appData = JSON.parse(dataString);
    
    // 🌟 自动修复器：从历史流水和待办中提取所有的子标签，合并到 sub_tags 注册表
    if (!appData.sub_tags) appData.sub_tags = {};
    
    const scanItem = (tag, sub_tag) => {
        if (tag && sub_tag) {
            if (!appData.sub_tags[tag]) appData.sub_tags[tag] = [];
            if (!appData.sub_tags[tag].includes(sub_tag)) {
                appData.sub_tags[tag].push(sub_tag);
            }
        }
    };

    // 扫描流水中的子项目
    Object.values(appData.logs).forEach(dayLogs => {
        dayLogs.forEach(log => scanItem(log.tag, log.sub_tag));
    });
    // 扫描待办中的子项目
    appData.todos.forEach(todo => scanItem(todo.tag, todo.sub_tag));

    // （静默将修复后的数据保存回本地）
    saveData(); 

    return appData;
  } catch (error) {
    console.error("读取数据失败:", error);
  }
}

// 把修改后的数据保存到底层
export async function saveData() {
  try {
    await invoke('save_data', { data: JSON.stringify(appData) });
    console.log("💾 数据已成功保存到本地!");
  } catch (error) {
    console.error("保存数据失败:", error);
  }
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
  
  // 遍历历史流水
  Object.values(appData.logs).forEach(dayLogs => {
    dayLogs.forEach(log => {
      if (log.tag === mainTag && log.sub_tag) subTags.add(log.sub_tag);
    });
  });
  
  // 遍历待办事项
  appData.todos.forEach(todo => {
    if (todo.tag === mainTag && todo.sub_tag) subTags.add(todo.sub_tag);
  });
  
  return Array.from(subTags).sort();
}