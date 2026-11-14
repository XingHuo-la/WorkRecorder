import { loadData, appData, dbQueryStrict, dbExecuteStrict } from './data.js';
import { logToFile, markLogReady } from './logger.js';
import { initTodoModule } from './todo.js';
import { initLogModule, renderHistoryList } from './log.js';
import { initTimelineModule, renderTimeline } from './timeline.js';
import { initSettingsModule } from './settings.js';
import { initQuickCapture } from './quickCapture.js';
import { renderTodayTimeline } from './todayTimeline.js';
import { initSearchModule } from './search.js';
import { initFreeCellModule } from './freecell.js';
import { initNotesEditor, flushBeforeLeave, refreshNotesCache, getNotesCache, openNote } from './notesEditor.js';
import { initNotesModule } from './notes.js';
import { setNotesDataPathProvider } from './notesStore.js';
import { initSheetPage } from './sheetPage.js';
import { setSheetAdapter } from './sheetStore.js';
import { setRecordAdapter } from './recordStore.js';
import { initCommandPalette } from './commandPalette.js';
import { flushDrawerBody } from './rowDrawer.js';
import { escapeHtml } from './htmlUtils.js';

// Tauri 全局对象由 withGlobalTauri 同步注入，正常情况可直接取用。
// 这里做一次防御：万一注入时序异常，也不要让整个模块崩溃。
const tauriWindowApi = window.__TAURI__?.window;
const getCurrentWindow = tauriWindowApi?.getCurrentWindow;
if (!getCurrentWindow) {
  console.error('window.__TAURI__.window 不可用，窗口控制按钮将失效');
}

// ==========================================
// 🚀 终极修复：直接在本地注入极简中文包，永不超时！
// ==========================================
if (window.flatpickr) {
  window.flatpickr.l10ns.zh = {
    weekdays: {
      shorthand: ["日", "一", "二", "三", "四", "五", "六"], // 极简星期显示
      longhand: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"],
    },
    months: {
      // 强制使用纯数字月份，告别英文
      shorthand: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
      longhand: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
    },
    rangeSeparator: " 至 ",
    weekAbbreviation: "周",
    scrollTitle: "滚动切换",
    toggleTitle: "点击切换",
    amPM: ["上午", "下午"],
    yearAriaLabel: "年份",
    monthAriaLabel: "月份",
    hourAriaLabel: "小时",
    minuteAriaLabel: "分钟",
    time_24hr: true,
  };
}

async function initApp() {
  logToFile('info', '=== 应用启动 ===');

  // 让笔记模块复用同一套 appData，并提供数据路径给文件层
  setNotesDataPathProvider(async () => {    try {
      return await window.__TAURI__.core.invoke('get_current_path');
    } catch (error) {
      logToFile('error', `获取数据路径失败: ${error}`);
      return '';
    }
  });

  // 一次性把旧笔记从 SQLite 迁到磁盘 .md（已迁移则直接跳过）
  // 迁移整体在后端完成：前端逐条 invoke 一旦中断，恢复逻辑复杂且难排查。
  try {
    const dataPath = await window.__TAURI__.core.invoke('get_current_path');
    const outcome = await window.__TAURI__.core.invoke('notes_migrate_legacy', {
      dataFilePath: dataPath
    });
    logToFile('info', `笔记迁移结果: ${JSON.stringify(outcome)}`);
  } catch (error) {
    logToFile('error', `笔记迁移失败: ${error?.stack || error}`);
  }

  // 日志通道已可用
  markLogReady();

  await loadData();

  // 表格页的数据访问走注入：sheetStore.js 本身零顶层依赖（只认 adapter），
  // 调试壳（_debug/sheet-review.html）可绕过 Tauri 直接复用同一套渲染与交互。
  // 这里用严格版：写库失败必须抛，不能让「保存不动」被静默吞掉。
  setSheetAdapter({ dbQuery: dbQueryStrict, dbExecute: dbExecuteStrict });
  // record 统一读写层用同一套 adapter：新代码（行详情抽屉 / 层级 / 关联字段）
  // 一律走 recordStore，不要在 UI 里自己拼 SQL —— 可空列的 null 陷阱
  // 与「删记录三步」都在那一层兜住了。
  setRecordAdapter({ dbQuery: dbQueryStrict, dbExecute: dbExecuteStrict });

  await import('./settings.js').then(async (m) => {
      await m.applySavedThemeFromDB();
  }).catch(error => {
      logToFile('error', `主题加载失败: ${error?.stack || error}`);
  });

  // 依次初始化各模块。任一个失败都不阻断后续模块，只打印日志。
  // async 模块返回的 Promise 也要接管 rejection，否则会变成未捕获错误。
  const safeRun = (label, fn) => {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') {
        return result.catch(error => {
          logToFile('error', `[${label}] 初始化失败: ${error?.stack || error}`);
          return null;
        });
      }
      return result;
    } catch (error) {
      logToFile('error', `[${label}] 初始化失败: ${error?.stack || error}`);
      return null;
    }
  };

  safeRun('routing', setupRouting);
  safeRun('legacy-tabs', setupTabs);
  safeRun('todo', initTodoModule);
  safeRun('log', initLogModule);
  safeRun('history-render', renderHistoryList);
  safeRun('notes-form', initNotesModule);
  safeRun('notes-editor', initNotesEditor);
  safeRun('today-timeline', renderTodayTimeline);
  safeRun('timeline', initTimelineModule);
  safeRun('settings', initSettingsModule);
  safeRun('quick-capture', initQuickCapture);
  safeRun('search', initSearchModule);
  safeRun('command-palette', initCommandPalette);
  safeRun('freecell', initFreeCellModule);
  safeRun('legacy-tools-toggle', setupLegacyToolsToggle);
  safeRun('dashboard-chrome', setupDashboardChrome);

  // 关窗口前把抽屉里还没落库的正文再刷一次。
  // 抓值是同步的（captureBodyDraft），所以即使 WebView 随后就拆掉了，值也已经取出来；
  // invoke 已发出，主进程的 async 命令会排队写完。
  // 这是 best-effort：进程被强杀时救不回来 —— 真正的保证是「关抽屉即保存」。
  window.addEventListener('beforeunload', () => {
    void flushDrawerBody();
  });

  // 全局事件 1：点击空白处收起所有三点菜单
  document.addEventListener('click', (e) => {
    // 👇 魔法在这里：只要你点击的地方，不在 .dropdown-wrapper 这个包裹盒子里，就统统关掉！
    if (!e.target.closest('.dropdown-wrapper')) {
      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
      document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
    }
  });

  //  全局事件 2：监听全局滚动，让日历实时平滑跟随输入框
  window.addEventListener('scroll', (e) => {
    if (window.scrollY > 0) window.scrollTo(0, 0);
    // 忽略日历内部的滚动（避免调时间时触发）
    if (e.target && e.target.classList && e.target.classList.contains('flatpickr-time')) return;
    
    // 只在页面中存在打开的日历时才去计算，极大地优化性能
    if (document.querySelector('.flatpickr-calendar.open')) {
      document.querySelectorAll('.flatpickr-input').forEach(input => {
        // 调用 Flatpickr 内部私有方法，瞬间刷新定位
        if (input._flatpickr && input._flatpickr.isOpen && typeof input._flatpickr._positionCalendar === 'function') {
          input._flatpickr._positionCalendar(); 
        }
      });
    }
  }, true); // 注意这里的 true，开启捕获阶段监听内部所有 div 的滚动
  setupTitlebar();
  updateWorkspaceSummary();
  renderRecentNotes();
}

// 「完整录入 · 补录历史」的开合。
//
// 入口已从右栏「其他入口」卡片降级成右列底部的一行 quiet 链接（层 11），
// 所以这里不再需要把整块卡片藏起来 —— 旧实现里的 `.advanced-tools-strip`
// 已随首页重排删除，`strip` 恒为 null，保留判空只是让这段在新旧 DOM 下都能跑。
// 文案常量放在函数上方：setOpen(false) 时要把按钮恢复成 HTML 里的初始文案，
// 两处写死字符串迟早会漂（会先闪一下旧字再定住）。
const LEGACY_TOGGLE_OPEN_TEXT = '收起';
const LEGACY_TOGGLE_CLOSED_TEXT = '完整录入 · 补录历史';

function setupLegacyToolsToggle() {
  const toggle = document.getElementById('legacy-tools-toggle');
  const collapse = document.getElementById('legacy-tools-collapse');
  const area = document.getElementById('legacy-capture-area');
  const strip = document.querySelector('.advanced-tools-strip');
  if (!toggle || !area) return;

  const setOpen = (isOpen, shouldScroll = false) => {
    area.classList.toggle('show', isOpen);
    area.setAttribute('aria-hidden', String(!isOpen));
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.innerText = isOpen ? LEGACY_TOGGLE_OPEN_TEXT : LEGACY_TOGGLE_CLOSED_TEXT;
    if (strip) strip.style.display = isOpen ? 'none' : '';
    if (collapse) {
      collapse.setAttribute('aria-expanded', String(isOpen));
      collapse.innerText = '收起';
    }

    if (shouldScroll) {
      // 收起时回到入口本身：卡片没了，closest('.advanced-tools-strip') 会返回 null，
      // 滚回原处会把用户扔到页面顶部。
      const target = isOpen ? area : toggle;
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  toggle.addEventListener('click', () => {
    setOpen(!area.classList.contains('show'), true);
  });

  collapse?.addEventListener('click', () => {
    setOpen(false, true);
  });

  setOpen(area.classList.contains('show'));
}

// 工作台头部：日期、捕获浮层、右栏入口跳转。
// 浮层默认隐藏，「＋ 记一笔」或 Ctrl+Shift+Space 唤起，Esc / 点空白关闭。
// 不用 Ctrl+Space 是因为它会和中文输入法的中英切换抢按键。
function setupDashboardChrome() {
  const popover = document.getElementById('capture-popover');
  const openBtn = document.getElementById('capture-open-btn');
  const input = document.getElementById('quick-capture-input');
  if (!popover || !openBtn) return;

  const dateEl = document.getElementById('wb-date');
  if (dateEl) {
    const now = new Date();
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    dateEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日 · ${week}`;
  }

  const setOpen = open => {
    popover.hidden = !open;
    openBtn.setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(() => input?.focus());
  };

  openBtn.addEventListener('click', () => setOpen(popover.hidden));

  // 顶栏搜索图标：命令面板是全应用唯一搜索入口，这里只是换个位置唤起它。
  document.getElementById('wb-search-btn')?.addEventListener('click', () => {
    window.__wrOpenPalette?.();
  });

  document.addEventListener('click', event => {
    if (popover.hidden) return;
    if (popover.contains(event.target) || openBtn.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !popover.hidden) setOpen(false);
    if (event.ctrlKey && event.shiftKey && event.code === 'Space') {
      event.preventDefault();
      setOpen(popover.hidden);
    }
  });

  document.querySelectorAll('[data-wb-goto]').forEach(btn => {
    btn.addEventListener('click', () => document.getElementById(btn.dataset.wbGoto)?.click());
  });

  // 捕获浮层是全局唯一录入入口，但它挂在工作台 DOM 里 ——
  // 从别的页面唤起时先把工作台切出来，否则浮层会跟着父容器一起 display:none。
  window.__wrOpenCapture = () => {
    const dashboard = document.getElementById('subview-dashboard');
    if (dashboard && dashboard.style.display === 'none') {
      window.__wrRouteTo?.('nav-dashboard');
    }
    setOpen(true);
  };

  // 记录页的「＋ 记一笔」：录入入口只有这一个，这里只是从另一个页面唤起它。
  document.getElementById('rec-add-btn')?.addEventListener('click', () => {
    window.__wrOpenCapture?.();
  });

  const recordCount = document.getElementById('rec-count');
  if (recordCount && appData) {
    const total = Object.values(appData.logs || {}).reduce((sum, list) => sum + list.length, 0);
    recordCount.textContent = total ? `${total} 条` : '';
  }

  // 空当接龙不占导航位，但功能保留在设置里 —— 它是「不想删，但不该和表格并列」的东西。
  document.getElementById('open-freecell-btn')?.addEventListener('click', () => {
    window.__wrRouteTo?.('nav-freecell');
  });
}

// ==========================================
// 右栏「最近笔记」（v2 首页）
// ==========================================

/** 最近笔记条数：设计稿固定 3 条。 */
const RECENT_NOTE_LIMIT = 3;

/**
 * 笔记的一行 meta：`MM-DD · 主分类`。
 *
 * updated_at 是 `YYYY-MM-DD HH:mm:ss`，substring(5, 10) 正好是 MM-DD。
 * 日期缺失时只回分类 —— 不要留下一个孤零零的分隔点。
 *
 * @param {{tag?: string, updated_at?: string, created_at?: string}} note
 * @returns {string} 用于列表第二行的短 meta
 */
function formatRecentNoteMeta(note) {
  const stamp = String(note?.updated_at || note?.created_at || '');
  const day = stamp.length >= 10 ? stamp.substring(5, 10) : '';
  const tag = note?.tag || '未分类';
  return day ? `${day} · ${tag}` : tag;
}

/**
 * 取最近 3 篇笔记。
 *
 * 数据源有两条：notesEditor 的 notesCache（每次刷盘后重扫磁盘，是真相）、
 * 启动时 loadData 灌进 appData.notes 的快照（notesCache 还没初始化时的兜底）。
 * 只认带 rel_path 的条目 —— 没有 rel_path 就打不开。
 *
 * @returns {Array<object>} 按 updated_at 倒序的前 3 篇
 */
function collectRecentNotes() {
  const cached = getNotesCache();
  const source = (Array.isArray(cached) && cached.length) ? cached : (appData?.notes || []);
  return source
    .filter(note => note && note.rel_path)
    .sort((a, b) => String(b.updated_at || b.created_at || '')
      .localeCompare(String(a.updated_at || a.created_at || '')))
    .slice(0, RECENT_NOTE_LIMIT);
}

/**
 * 点「最近笔记」里的一条：先切到笔记页，再把这篇打开。
 *
 * 必须先路由再 openNote —— 笔记编辑器只在自己那一栏可见时渲染才有意义，
 * 而且 openNote 里有 dirty 确认，提前切页会让确认框出现在空白页上。
 *
 * @param {string} relPath 笔记相对路径
 */
async function openRecentNote(relPath) {
  if (!relPath) return;
  try {
    await window.__wrRouteTo?.('nav-notes');
    await openNote(relPath);
  } catch (error) {
    logToFile('error', `打开最近笔记失败 ${relPath}: ${error?.stack || error}`);
  }
}

/**
 * 渲染右栏「最近笔记」三行（v2 首页改版）。
 *
 * 空态也是一行文字 + 一跳（`data-wb-goto`），但这里是 innerHTML 动态插入，
 * 吃不到 setupDashboardChrome 里那次一次性 querySelectorAll 绑定，所以自己绑。
 */
export function renderRecentNotes() {
  const container = document.getElementById('wb-recent-notes');
  if (!container) return;

  const notes = collectRecentNotes();
  if (!notes.length) {
    container.innerHTML = '<button type="button" class="wb-recent-empty" data-wb-goto="nav-notes">还没有笔记 · 写一篇</button>';
    container.querySelector('[data-wb-goto]')?.addEventListener('click', () => {
      document.getElementById('nav-notes')?.click();
    });
    return;
  }

  container.innerHTML = notes.map(note => `
    <button type="button" class="wb-recent-item" data-rel="${escapeHtml(note.rel_path)}">
      <div class="wb-recent-title">${escapeHtml(note.title || '未命名笔记')}</div>
      <div class="wb-recent-meta">${escapeHtml(formatRecentNoteMeta(note))}</div>
    </button>
  `).join('');

  container.querySelectorAll('.wb-recent-item').forEach(item => {
    item.addEventListener('click', () => { void openRecentNote(item.dataset.rel); });
  });
}

function setupTitlebar() {
  if (!getCurrentWindow) return;
  const appWindow = getCurrentWindow();

  document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
    appWindow.minimize();
  });

  document.getElementById('titlebar-maximize')?.addEventListener('click', () => {
    appWindow.toggleMaximize();
  });

  document.getElementById('titlebar-close')?.addEventListener('click', () => {
    appWindow.close();
  });
}

// 🌟 全局高级自定义表单弹窗生成器 
window.showModal = function(title, htmlContent, onReady, onConfirm, options = {}) {
  let overlay = document.getElementById('global-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'global-modal-overlay'; overlay.className = 'custom-modal-overlay';
    overlay.innerHTML = `
      <div class="custom-modal">
        <h3 id="global-modal-title" style="margin-top:0; color:var(--text-main); border-bottom:1px solid var(--border-medium); padding-bottom:15px; margin-bottom:20px;"></h3>
        <div id="global-modal-body"></div>
        <div class="modal-actions" style="display:flex; justify-content:flex-end; gap:12px; margin-top:25px; border-top:1px dashed var(--border-medium); padding-top:15px;">
          <button id="global-modal-cancel" class="btn btn-ghost" style="width:auto; padding:8px 16px; margin:0;">取消</button>
          <button id="global-modal-confirm" class="btn btn-primary" style="width:auto; padding:8px 20px; margin:0;"></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return;
      overlay.style.display = 'none';
      const onCancel = overlay._onCancel;
      overlay._onCancel = null;
      if (onCancel) onCancel();
    });

    const modal = overlay.querySelector('.custom-modal');
    modal.addEventListener('scroll', () => {
      if (document.querySelector('.flatpickr-calendar.open')) {
        document.querySelectorAll('.flatpickr-input').forEach(input => {
          if (input._flatpickr && input._flatpickr.isOpen && typeof input._flatpickr._positionCalendar === 'function') {
            input._flatpickr._positionCalendar();
          }
        });
      }
    });
  }

  const modal = overlay.querySelector('.custom-modal');
  if (modal) modal.className = `custom-modal ${options.themeClass || ''}`.trim(); // 预留主题扩展接口
  document.getElementById('global-modal-title').innerHTML = title;
  document.getElementById('global-modal-body').innerHTML = htmlContent;
  overlay.style.display = 'flex';
  overlay._onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;

  const cancelBtn = document.getElementById('global-modal-cancel');
  const confirmBtn = document.getElementById('global-modal-confirm');

  const isDanger = options.danger || false;
  confirmBtn.innerText = options.btnText || (isDanger ? "🗑️ 确认删除" : "💾 确认保存");
  if (isDanger) {
      confirmBtn.className = "btn btn-danger";
  } else {
      confirmBtn.className = "btn btn-primary";
  }

  const newCancel = cancelBtn.cloneNode(true); cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
  const newConfirm = confirmBtn.cloneNode(true); confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

  newCancel.onclick = () => {
    overlay.style.display = 'none';
    const onCancel = overlay._onCancel;
    overlay._onCancel = null;
    if (onCancel) onCancel();
  };
  const bodyEl = document.getElementById('global-modal-body');
  if (onReady) onReady(bodyEl);
  newConfirm.onclick = async () => {
    if (newConfirm.disabled) return;
    newConfirm.disabled = true;
    newConfirm.dataset.originalText = newConfirm.innerText;
    newConfirm.innerText = '处理中…';
    try {
      const success = await onConfirm(bodyEl);
      if (success !== false) {
        overlay.style.display = 'none';
        overlay._onCancel = null;
      }
    } finally {
      newConfirm.disabled = false;
      newConfirm.innerText = newConfirm.dataset.originalText || '确认';
    }
  };
};

function setupRouting() {
  const landingView = document.getElementById('landing-view'); const workspaceView = document.getElementById('workspace-view');
  if (!landingView || !workspaceView) return;

  // 启动即进工作台：landing 只是历史遗留，不再作为入口。
  landingView.style.display = 'none';
  workspaceView.style.display = 'flex';
  document.getElementById('enter-btn')?.addEventListener('click', () => { landingView.style.display = 'none'; workspaceView.style.display = 'flex'; });

  // 路由表：按钮与视图分开查。空当接龙已移出主导航（入口收在设置页），
  // 它的按钮不存在但视图还在，所以 btn 必须允许为空。
  const routes = [
    { id: 'nav-dashboard', view: 'subview-dashboard' },
    { id: 'nav-timeline', view: 'subview-timeline' },
    { id: 'nav-notes', view: 'subview-notes' },
    { id: 'nav-table', view: 'subview-table' },
    { id: 'nav-settings', view: 'subview-settings' },
    { id: 'nav-freecell', view: 'subview-freecell' }
  ].map(route => ({
    id: route.id,
    btn: document.getElementById(route.id),
    view: document.getElementById(route.view)
  })).filter(route => route.view);

  const show = async (id) => {
    const target = routes.find(route => route.id === id);
    if (!target) return;

    // 离开笔记页前先把未保存的草稿刷到磁盘
    const notesView = document.getElementById('subview-notes');
    const leavingNotes = notesView && notesView.style.display !== 'none' && id !== 'nav-notes';
    if (leavingNotes && typeof window.__wrFlushNotes === 'function') {
      try { await window.__wrFlushNotes(); } catch (error) { console.warn('笔记刷盘失败', error); }
    }

    routes.forEach(route => {
      route.view.style.display = 'none';
      route.btn?.classList.remove('active');
      route.btn?.removeAttribute('aria-current');
    });

    // dashboard 用空字符串恢复样式表默认值（.wb-v2 是 display:grid）；
    // notes 同理（#subview-notes 是 flex 两栏壳，9.7 层的 display 不能带 !important，
    // 否则会压掉上面的行内 none —— 11-13 真机「笔记视图叠在所有页面」事故的另一半）。
    // 其余页面用 block。这里写死 display 会压掉样式表里的布局。
    target.view.style.display = (id === 'nav-dashboard' || id === 'nav-notes') ? '' : 'block';
    target.btn?.classList.add('active');
    target.btn?.setAttribute('aria-current', 'page');
    localStorage.setItem('workRecorder:lastSubview', id);

    if (id === 'nav-timeline') renderTimeline();
    // 最近笔记 = 磁盘真相，从别的页面回到工作台时重扫一次，
    // 否则「刚在笔记页写的那篇」不会出现在右栏。
    if (id === 'nav-dashboard') renderRecentNotes();
    if (id === 'nav-table') {
      try { await initSheetPage(); } catch (error) { logToFile('error', `表格页初始化失败: ${error?.stack || error}`); }
    }
  };

  routes.forEach(route => {
    route.btn?.addEventListener('click', () => { show(route.id); });
  });

  // 命令面板与设置页都靠这个跳转：视图可以没有按钮，但切换必须只有一条路径。
  window.__wrRouteTo = show;

  const lastSubview = localStorage.getItem('workRecorder:lastSubview');
  show(routes.some(route => route.id === lastSubview) ? lastSubview : 'nav-dashboard');
}

function setupTabs() {
  const btnLog = document.getElementById('tab-log-btn'); const btnTodo = document.getElementById('tab-todo-btn');
  const btnNote = document.getElementById('tab-note-btn'); const panelNote = document.getElementById('panel-note');
  const panelLog = document.getElementById('panel-log'); const panelTodo = document.getElementById('panel-todo');
  if (!btnLog || !btnTodo || !panelLog || !panelTodo) return;
  const setActiveTab = (tab) => {
    const isTodo = tab === 'todo';
    const isNote = tab === 'note';
    btnLog.classList.toggle('active', tab === 'log');
    btnTodo.classList.toggle('active', isTodo);
    btnNote.classList.toggle('active', isNote);
    panelLog.style.display = tab === 'log' ? 'flex' : 'none';
    panelTodo.style.display = isTodo ? 'flex' : 'none';
    if (panelNote) panelNote.style.display = isNote ? 'flex' : 'none';
    localStorage.setItem('workRecorder:lastInputTab', tab);
  };

  btnLog.innerText = '流水';
  btnTodo.innerText = '待办';
  if (btnNote) btnNote.innerText = '笔记';

  btnLog.addEventListener('click', () => setActiveTab('log'));
  btnTodo.addEventListener('click', () => setActiveTab('todo'));
  if (btnNote) btnNote.addEventListener('click', () => setActiveTab('note'));
  const savedTab = localStorage.getItem('workRecorder:lastInputTab');
  setActiveTab(savedTab === 'todo' || savedTab === 'note' ? savedTab : 'log');
}

export function updateWorkspaceSummary() {
  if (!appData) return;

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
  };

  const todos = appData.todos || [];
  const pendingCount = todos.filter(todo => !todo.done).length;
  const doneCount = todos.length - pendingCount;
  const todayCount = (appData.logs[todayStr] || []).length;
  const noteCount = (appData.notes || []).length;

  // 首页头那行小字只留 记录 / 待办 / 笔记 三项（v2 设计稿）。
  // 已完成数不再作为独立一格展示，但它是「今日待办」标题右侧 N/M 的分子。
  setText('summary-pending-count', pendingCount);
  setText('summary-today-count', todayCount);
  setText('summary-note-count', noteCount);
  // 「今日待办 1/6」= 已完成/总数（设计稿 01-今天 的写法）。
  // 一条待办都没有时留空 —— 0/0 比不写更像一个坏值。
  setText('wb-todo-ratio', todos.length ? `${doneCount}/${todos.length}` : '');
  setText('wb-record-count', todayCount ? `${todayCount} 条` : '还没有记录');
}
window.updateWorkspaceSummary = updateWorkspaceSummary;
window.renderTodayTimeline = renderTodayTimeline;

// 笔记模块需要读取标签树等共享数据，这里开一个只读访问口
window.__wrAppData = () => appData;
// 其他模块写入笔记后需要刷新笔记列表
window.__wrRefreshNotes = () => refreshNotesCache();
// 路由切走笔记页时把草稿刷盘
window.__wrFlushNotes = () => flushBeforeLeave();

if (document.readyState === 'loading') {
  // 文档还在解析，等 DOM 就绪
  window.addEventListener('DOMContentLoaded', initApp, { once: true });
} else {
  // 文档已就绪（module 脚本求值可能晚于 DOMContentLoaded），直接启动
  initApp();
}
