// ==========================================
// 外部 Markdown 编辑器探测
//
// 设计原则：这只是一个「可选增强」，不是依赖。
// 探测不到任何外部编辑器时，应用内的编辑器与预览完全可用，
// 上层只需要把「在 xx 中打开」的按钮隐藏掉即可。
// ==========================================

/**
 * 惰性获取 Tauri invoke。
 * 不在模块顶层解构，避免注入时机差异导致模块加载失败。
 */
function getInvoke() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('Tauri API 不可用');
  return invoke;
}

/** 已知的编辑器定义。路径是 Windows 上的常见安装位置。 */
const KNOWN_EDITORS = [
  {
    id: 'typora',
    name: 'Typora',
    exeName: 'Typora.exe',
    candidates: [
      'C:\\Program Files\\Typora\\Typora.exe',
      'C:\\Program Files (x86)\\Typora\\Typora.exe',
      '%LOCALAPPDATA%\\Programs\\Typora\\Typora.exe',
      '%APPDATA%\\Typora\\Typora.exe',
      'D:\\Program Files\\Typora\\Typora.exe',
      'D:\\Typora\\Typora.exe',
      'E:\\Program Files\\Typora\\Typora.exe'
    ]
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    exeName: 'Obsidian.exe',
    candidates: [
      '%LOCALAPPDATA%\\Obsidian\\Obsidian.exe',
      'C:\\Program Files\\Obsidian\\Obsidian.exe'
    ]
  },
  {
    id: 'vscode',
    name: 'VS Code',
    exeName: 'Code.exe',
    candidates: [
      '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      'D:\\Program Files\\Microsoft VS Code\\Code.exe'
    ]
  }
];

/** 探测结果缓存。 */
let probeCache = null;
let probePromise = null;

/**
 * 展开路径里的 %VAR% 环境变量。
 *
 * Tauri 2 不再向前端暴露 window.__TAURI__.env（那是 1.x 的 API），
 * 所以这里带 % 的路径无法在前端解析，需要整体交给后端展开。
 */
function needsEnvExpansion(raw) {
  return raw.includes('%');
}

/**
 * 批量判断若干路径是否存在。
 *
 * 早先的实现用 convertFileSrc + fetch 探测，实际会去下载整个可执行文件
 * （几十 MB），导致初始化长时间阻塞。改为交给后端一次性检查。
 *
 * 含环境变量的候选路径也交给后端：后端能读到进程环境变量，
 * 前端在 Tauri 2 下拿不到 __TAURI__.env。
 *
 * @returns {Promise<Map<string,string>>} 原始候选路径 -> 展开后的真实路径
 */
async function listExistingPaths(paths) {
  const candidates = paths.filter(p => p && p.trim());
  if (!candidates.length) return new Map();
  try {
    const invoke = getInvoke();
    const pairs = await invoke('paths_exist', { paths: candidates });
    const map = new Map();
    for (const entry of Array.isArray(pairs) ? pairs : []) {
      // 后端返回 [原始候选路径, 展开后的绝对路径]
      if (Array.isArray(entry) && entry.length === 2) map.set(entry[0], entry[1]);
    }
    return map;
  } catch (error) {
    // 探测失败只是拿不到「在 xx 中打开」按钮，不影响笔记功能
    return new Map();
  }
}

/**
 * 探测系统里已安装的外部 Markdown 编辑器。
 *
 * @returns {Promise<Array<{id:string,name:string,path:string}>>}
 */
export async function detectExternalEditors() {
  if (probeCache) return probeCache;
  if (probePromise) return probePromise;

  probePromise = (async () => {
    // 所有候选路径一次性交给后端检查（后端顺带展开环境变量），避免逐个往返
    const allPaths = [];
    for (const editor of KNOWN_EDITORS) {
      for (const rawPath of editor.candidates) allPaths.push(rawPath);
    }

    const existing = await listExistingPaths(allPaths);

    const found = [];
    for (const editor of KNOWN_EDITORS) {
      for (const rawPath of editor.candidates) {
        const absPath = existing.get(rawPath);
        if (!absPath) continue;
        found.push({ id: editor.id, name: editor.name, path: absPath });
        break;
      }
    }

    probeCache = found;
    return found;
  })();

  try {
    return await probePromise;
  } finally {
    probePromise = null;
  }
}

/** 取首选的 Markdown 编辑器（优先 Typora）。 */
export async function getPreferredEditor() {
  const editors = await detectExternalEditors();
  if (!editors.length) return null;
  const priority = ['typora', 'obsidian', 'vscode'];
  for (const id of priority) {
    const hit = editors.find(e => e.id === id);
    if (hit) return hit;
  }
  return editors[0];
}

/** 清掉探测缓存，下次重新探测。 */
export function resetEditorProbe() {
  probeCache = null;
}

/**
 * 用外部编辑器打开一个文件。
 *
 * @param {string} absPath 文件绝对路径
 * @param {{path?: string}} [editor] 目标编辑器；不传则用系统默认关联
 */
export async function openInExternalEditor(absPath, editor) {
  if (!absPath) return false;
  try {
    await getInvoke()('open_path_with_app', {
      path: absPath,
      app: editor?.path || null
    });
    return true;
  } catch (error) {
    console.error('外部编辑器打开失败:', error);
    return false;
  }
}
