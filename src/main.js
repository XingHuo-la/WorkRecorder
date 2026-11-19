import { loadData, appData, dbQueryStrict, dbExecuteStrict } from './data.js';
import { logToFile, markLogReady } from './logger.js';
import { initTodoModule } from './todo.js';
import { initLogModule, renderHistoryList } from './log.js';
import { initTimelineModule, renderTimeline } from './timeline.js';
import { initSettingsModule } from './settings.js';
import { initQuickCapture } from './quickCapture.js';
import { countTodayItems, renderTodayTimeline } from './todayTimeline.js';
import { initSearchModule } from './search.js';
import { initFreeCellModule } from './freecell.js';
import { initNotesEditor, flushBeforeLeave, refreshNotesCache, getNotesCache, openNote } from './notesEditor.js';
import { initNotesModule } from './notes.js';
import { setNotesDataPathProvider } from './notesStore.js';
import { initSheetPage, openSheetTab, getSheetList, onSheetListChange, openNewSheet, currentSheetId, openCurrentSheetMenu, openSheetMenuFor, refreshSheetList, toast, openPopoverSimple, closeAllPanels } from './sheetPage.js';
// 表 / 视图分层：列表与视图页签都在这一层拼装。
// sheetPage 只管「表格形态怎么画」，不负责「这张表有几种看法」。
import {
  listViews,
  createView,
  patchView,
  deleteView,
  readTableFields,
  readTableRows,
  saveTableRow,
  insertTableRow,
  getDefaultTableId,
  VIEW_FORMS,
  viewFormLabel,
} from './sheetStore.js';
import { renderView } from './viewPage.js';
import { setSheetAdapter } from './sheetStore.js';
import { setTableAdapter, initTablePage, setTableFilter } from './tablePage.js';
import { setRecordAdapter } from './recordStore.js';
import { initCommandPalette } from './commandPalette.js';
import { flushDrawerBody, openRowDrawer } from './rowDrawer.js';
import { escapeHtml } from './htmlUtils.js';
import { initBoardPage, flushBoard, setBoardAdapter } from './board.js';
import { bindUndoShortcuts } from './undoCore.js';

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

  // 全局撤销：表格、笔记、白板共用一条历史线。
  // 输入框内的 Ctrl+Z 由 bindUndoShortcuts 放行给原生，不抢浏览器/系统行为。
  bindUndoShortcuts({
    onAfter: (entry, kind) => {
      const verb = kind === 'undo' ? '撤销' : '重做';
      logToFile('info', `${verb}: ${entry?.label || '操作'}`);
    },
  });

  await loadData();

  // 表格页的数据访问走注入：sheetStore.js 本身零顶层依赖（只认 adapter），
  // 调试壳（_debug/sheet-review.html）可绕过 Tauri 直接复用同一套渲染与交互。
  // 这里用严格版：写库失败必须抛，不能让「保存不动」被静默吞掉。
  setSheetAdapter({ dbQuery: dbQueryStrict, dbExecute: dbExecuteStrict });
  // record 统一读写层用同一套 adapter：新代码（行详情抽屉 / 层级 / 关联字段）
  // 一律走 recordStore，不要在 UI 里自己拼 SQL —— 可空列的 null 陷阱
  // 与「删记录三步」都在那一层兜住了。
  setRecordAdapter({ dbQuery: dbQueryStrict, dbExecute: dbExecuteStrict });
  // 记录页的表格视图（tablePage.js）同样走注入式 adapter，理由同上：
  // 写库失败必须抛，让表格把「保存失败」弹出来，而不是当成已保存。
  setTableAdapter({ dbQuery: dbQueryStrict, dbExecute: dbExecuteStrict });
  // 白板的读取走注入；写入统一走 recordStore.patchRecord（同一个 adapter），
  // 所以这里的 dbExecute 实际不会被 board.js 直接用到，仍然一起传是为了
  // 将来需要批量写时不必再改签名。
  setBoardAdapter({ dbQuery: dbQueryStrict, dbExecute: dbExecuteStrict });

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

  // 记录页视图切换必须先于路由：v4 启动就落到「表格」，
  // show('nav-table') 依赖 __wrRefreshRecordTable 已经挂好。
  safeRun('records-view', setupRecordsView);
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

  // v4：捕获浮层从「工作台内部的一块」升级成全局浮层。
  // 工作台页面已下线，浮层如果还挂在 #subview-dashboard 里，
  // 父容器 display:none 会把它一起藏掉（Ctrl+Shift+Space 看着像没反应）。
  // 直接挂到 body 下，位置交给 styles-v4.css 的 .wb-popover。
  if (popover.parentElement !== document.body) document.body.appendChild(popover);

  const dateEl = document.getElementById('wb-date');
  if (dateEl) {
    const now = new Date();
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    dateEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日 · ${week}`;
  }

  const setOpen = open => {
    popover.hidden = !open;
    // 同时写行内 display：旧层给 .wb-popover 写过 display:block !important，
    // 只切 hidden 属性在部分主题下会压不掉。
    popover.style.display = open ? 'block' : 'none';
    openBtn.setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(() => input?.focus());
  };
  setOpen(false);

  openBtn.addEventListener('click', () => setOpen(popover.hidden));

  // 顶栏搜索图标：命令面板是全应用唯一搜索入口，这里只是换个位置唤起它。
  document.getElementById('wb-search-btn')?.addEventListener('click', () => {
    window.__wrOpenPalette?.();
  });

  // 唤起它的那次点击与「点空白关闭」是同一个事件链：触发按钮上的 click 会继续冒泡到
  // document，那时浮层已经打开，于是被判定成「点了外部」立刻关掉 —— 表现为闪一下就没。
  // 所以把这三个入口的点击排除在关闭判断之外。
  const OPEN_TRIGGER_SELECTOR = '#rec-add-btn, #capture-open-btn, #cmdk-overlay';

  document.addEventListener('click', event => {
    if (popover.hidden) return;
    if (event.target.closest?.(OPEN_TRIGGER_SELECTOR)) return;
    if (popover.contains(event.target)) return;
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

  // 捕获浮层是全局唯一录入入口，已挂到 body 下，任何页面都能直接唤起，
  // 不再需要先切到工作台（工作台视图在 v4 已下线）。
  window.__wrOpenCapture = () => setOpen(true);

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

// 回调式的 showModal 包成 Promise。
// 拖拽确认要的不是「弹个框」，而是「等一个答案再决定要不要写库」——
// 回调式拿不到那个答案，只能把 resolve 挂到确认/取消两个出口上。
function confirmAction({ title = '确认操作', message = '', btnText = '确认', danger = false } = {}) {
  return new Promise(resolve => {
    if (typeof window.showModal !== 'function') { resolve(false); return; }
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    window.showModal(
      escapeHtml(title),
      `<div class="vp-confirm">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`,
      null,
      async () => { done(true); return true; },
      { btnText, danger, onCancel: () => done(false) }
    );
  });
}

function setupRouting() {
  const landingView = document.getElementById('landing-view'); const workspaceView = document.getElementById('workspace-view');
  if (!landingView || !workspaceView) return;

  // 启动即进工作台：landing 只是历史遗留，不再作为入口。
  landingView.style.display = 'none';
  workspaceView.style.display = 'flex';
  document.getElementById('enter-btn')?.addEventListener('click', () => { landingView.style.display = 'none'; workspaceView.style.display = 'flex'; });

  // 路由表（v4）：主导航只留 表格 / 白板 / 笔记。
  //  - 表格 = subview-timeline：基础表 + 用户自建表，用页内的表 tab 条并列切换
  //  - 今天 / 工作台不再作为页面；「今天」变成表格上的筛选 chip
  //  - freecell 保留视图，无按钮
  const routes = [
    { id: 'nav-table', view: 'subview-timeline' },
    { id: 'nav-board', view: 'subview-board' },
    { id: 'nav-notes', view: 'subview-notes' },
    { id: 'nav-settings', view: 'subview-settings' },
    { id: 'nav-freecell', view: 'subview-freecell' }
  ].map(route => ({
    id: route.id,
    btn: document.getElementById(route.id),
    view: document.getElementById(route.view)
  })).filter(route => route.view);

  // 各视图自己的默认 display。写死 display 会压掉样式表里的布局，所以
  // 「用样式表默认值」的视图一律给空字符串。
  //   notes     → #subview-notes 是 flex 两栏壳（9.7 层，不能带 !important）
  //   board     → .bd-view 是 fixed + flex
  const VIEW_DISPLAY = { 'nav-notes': '', 'nav-board': 'flex' };

  const show = async (id) => {
    const target = routes.find(route => route.id === id);
    if (!target) return;

    // 离开笔记页前先把未保存的草稿刷到磁盘
    const notesView = document.getElementById('subview-notes');
    const leavingNotes = notesView && notesView.style.display !== 'none' && id !== 'nav-notes';
    if (leavingNotes && typeof window.__wrFlushNotes === 'function') {
      try { await window.__wrFlushNotes(); } catch (error) { console.warn('笔记刷盘失败', error); }
    }

    // 离开白板前把还没落库的位置刷下去：拖完立刻切页是最常见的丢位置场景
    const boardView = document.getElementById('subview-board');
    const leavingBoard = boardView && boardView.style.display !== 'none' && id !== 'nav-board';
    if (leavingBoard) {
      try { await flushBoard(); } catch (error) { logToFile('error', `白板落库失败: ${error?.stack || error}`); }
    }

    // 先无条件收起所有 subview，再显示目标。
    // 不能只遍历 routes：路由表里只有 6 个可导航的视图，已经下线的
    // #subview-dashboard 不在表里 —— 不主动收就会一直留在页面上，
    // 表现为「表格页上面还压着一整块工作台」（boot-probe 实测 dashboard 仍是 grid）。
    document.querySelectorAll('.subview').forEach(view => {
      view.style.display = 'none';
    });

    routes.forEach(route => {
      route.view.style.display = 'none';
      route.btn?.classList.remove('active');
      route.btn?.removeAttribute('aria-current');
    });

    // dashboard 用空字符串恢复样式表默认值（.wb-v2 是 display:grid）；
    // notes 同理（#subview-notes 是 flex 两栏壳，9.7 层的 display 不能带 !important，
    // 否则会压掉上面的行内 none —— 11-13 真机「笔记视图叠在所有页面」事故的另一半）。
    // 其余页面用 block。这里写死 display 会压掉样式表里的布局。
    target.view.style.display = VIEW_DISPLAY[id] ?? 'block';
    target.btn?.classList.add('active');
    target.btn?.setAttribute('aria-current', 'page');
    localStorage.setItem('workRecorder:lastSubview', id);

    if (id === 'nav-table') {
      // 表格页自己维护 rows（行内编辑只改它自己的缓存），每次切回都重读一次，
      // 否则从白板/笔记回来会看到改之前的值。
      try { await window.__wrRefreshRecordTable?.(); } catch (error) { logToFile('error', `表格刷新失败: ${error?.stack || error}`); }
    }
    if (id === 'nav-board') {
      try { await initBoardPage(); } catch (error) { logToFile('error', `白板初始化失败: ${error?.stack || error}`); }
    }
  };

  routes.forEach(route => {
    route.btn?.addEventListener('click', () => { show(route.id); });
  });

  // 命令面板与设置页都靠这个跳转：视图可以没有按钮，但切换必须只有一条路径。
  window.__wrRouteTo = show;

  const lastSubview = localStorage.getItem('workRecorder:lastSubview');
  show(routes.some(route => route.id === lastSubview) ? lastSubview : 'nav-table');
}

// 表格页 = 两层：表库（列表）→ 表内。
//
// 为什么不再用一排 tab 把所有表摊在顶上：表一多，顶上全是名字，
// 层级消失，跟"打开文件夹再进文件"的心智对不上。改成先看列表、点进去才是表，
// 返回键回列表。表内一切照旧（基础表走 tablePage，自建表走 sheetPage）。
//
// 基础表是固定项：第一行、没有 ⋯ 菜单、因此删不掉。
function setupRecordsView() {
  const library = document.getElementById('table-library');
  const detail = document.getElementById('table-detail');
  const listEl = document.getElementById('lib-list');
  const listCount = document.getElementById('lib-count');
  const listEmpty = document.getElementById('lib-empty');
  const newBtn = document.getElementById('lib-new-sheet');
  const backBtn = document.getElementById('rec-back-btn');
  const titleEl = document.getElementById('rec-title');
  const basePane = document.getElementById('rec-table-pane');
  const sheetPane = document.getElementById('sheet-pane');
  const toolsEl = document.getElementById('base-table-tools');
  const moreBtn = document.getElementById('sheet-more-btn');
  const viewBar = document.getElementById('view-bar');
  const viewTabsEl = document.getElementById('view-tabs');
  const viewAddBtn = document.getElementById('view-add-btn');
  const viewLock = document.getElementById('view-lock');
  const viewMore = document.getElementById('view-more');
  const viewPane = document.getElementById('view-pane');
  const viewApp = document.getElementById('view-app');
  if (!library || !detail || !listEl) return;

  const icon = id => `<svg class="wr-icon" aria-hidden="true"><use href="#${id}"/></svg>`;

  let sheetList = [];
  let sheetReady = false;
  let defaultTableId = null;  // 快速记录的落点，列表上用「默认」徽标标出来
  let mode = 'list';         // list | detail
  let current = '';          // table:<id>
  let currentTable = null;   // 正在看的那张表（预置表也是普通一行）
  let currentViews = [];     // 这张表的视图（第一个是默认「表格」，删不掉）
  let currentViewId = null;  // 当前激活的视图
  let currentView = null;    // 激活的视图对象（改配置时直接改它，避免多处各存一份）
  // 非表格形态要一次性拿全字段+行（看板要按列分组、画廊要挑封面）。
  // 切表就作废，避免把 A 表的行画进 B 表。
  let viewData = { tableId: null, fields: [], rows: [] };

  const isPreset = table => String(table?.kind || '') === 'preset';

  // P2.5 网格合流 · 双跑开关
  //
  // 预设表（工作记录）也走 sheetPage —— 至此两张表只剩一套网格。
  // 快捷筛选（全部/今天/待整理 + 主分类/子项目）已经搬进表内的 .sh-quick 行。
  //
  // 回退到老的基础表（tablePage.js 还在，只是没人走了）：
  //   localStorage.setItem('wrPresetGrid', 'legacy')   然后刷新
  // 恢复：
  //   localStorage.removeItem('wrPresetGrid')
  const presetGridIsSheet = () => {
    try {
      return localStorage.getItem('wrPresetGrid') !== 'legacy';
    } catch (error) {
      return true;
    }
  };
  // 这张表的「表格形态」该用哪套网格：自建表永远是 sheetPage。
  const usesSheetGrid = table => !isPreset(table) || presetGridIsSheet();

  // 默认表决定「快速记录写哪儿」。取它要 await，所以列表重画前先刷一次，
  // 否则删表 / 改默认之后列表上的徽标会停在上一个状态。
  const refreshDefaultTableId = async () => {
    try {
      defaultTableId = await getDefaultTableId();
    } catch (error) {
      defaultTableId = null;
    }
  };

  const renderLibrary = () => {
    // 基础表以前是硬编码的第一行（is-fixed，没有 ⋯ 菜单）。
    // v15 起它只是 sheet 里 kind='preset' 的一行，所以这里不再特判位置，
    // 只多一个「预置」徽标 —— 排序值 -1 让它在最上面，但那是排序，不是特权。
    const rows = sheetList.map(item => {
      const preset = isPreset(item);
      // 默认表才是「这类表」的身份：可以没有预置表，但一定有一张默认表。
      const isDefault = String(item.id) === String(defaultTableId);
      const key = `table:${item.id}`;
      const fieldCount = Number(item.field_count ?? item.fieldCount ?? 0);
      const rowCount = Number(item.row_count ?? item.rowCount ?? 0);
      const viewCount = Number(item.view_count ?? item.viewCount ?? 0);
      return `
      <div class="lib-row${preset ? ' is-preset' : ''}" role="listitem" tabindex="0" data-key="${escapeHtml(key)}">
        <span class="lib-icon">${icon('ic-table')}</span>
        <span class="lib-main">
          <span class="lib-name">${escapeHtml(item.name)}${preset ? '<i class="lib-badge">预置</i>' : ''}${isDefault ? '<i class="lib-badge is-default">默认</i>' : ''}</span>
          <span class="lib-meta">${fieldCount} 字段 · ${rowCount} 条记录${viewCount > 1 ? ` · ${viewCount} 个视图` : ''}</span>
        </span>
        <button type="button" class="lib-more" data-more="${escapeHtml(key)}" aria-label="重命名或删除" title="重命名 / 删除">${icon('ic-dots')}</button>
        <span class="lib-chevron">${icon('ic-chevron-right')}</span>
      </div>`;
    });

    listEl.innerHTML = rows.join('');
    if (listCount) listCount.textContent = `${sheetList.length} 张表`;
    if (listEmpty) listEmpty.style.display = sheetList.length ? 'none' : '';
  };

  const setMode = next => {
    mode = next;
    const isList = next === 'list';
    library.style.display = isList ? '' : 'none';
    detail.style.display = isList ? 'none' : 'flex';
  };

  const openDetail = async key => {
    const table = sheetList.find(item => `table:${item.id}` === String(key)) || null;
    if (!table) return;
    current = `table:${table.id}`;
    currentTable = table;

    if (titleEl) titleEl.textContent = table.name;
    // 空字符串 = 回到样式表默认值，不写死 display（早期层有 !important，硬写会被压）
    const sheetGrid = usesSheetGrid(table);
    basePane.style.display = sheetGrid ? 'none' : '';
    sheetPane.style.display = sheetGrid ? '' : 'none';
    if (toolsEl) toolsEl.style.display = sheetGrid ? 'none' : 'flex';
    if (moreBtn) moreBtn.style.display = 'inline-flex';
    const countBadge = document.getElementById('rec-count');
    if (countBadge) countBadge.style.display = sheetGrid ? 'none' : '';
    if (viewBar) viewBar.style.display = '';
    if (viewPane) viewPane.style.display = 'none';
    setMode('detail');

    try {
      // 表格形态只有一套网格（P2.5）：预设表也走 sheetPage 之后，
      // tablePage 就只剩「双跑开关回退」这一条用途。
      if (!sheetGrid) await initTablePage();
      else {
        if (!sheetReady) { await initSheetPage(); sheetReady = true; }
        await openSheetTab(String(table.id));
      }
      await openTableView(table);
    } catch (error) {
      logToFile('error', `[records-view] 打开表格失败: ${error?.stack || error}`);
    }
  };

  // ==========================================
  // 视图：表存数据，视图只存看法
  // ==========================================

  const formIcon = form =>
    form === 'board' ? 'ic-board' : form === 'gallery' ? 'ic-image' : form === 'calendar' ? 'ic-clock' : 'ic-table';

  // 页签 + 锁定按钮一起重画：锁只对「有拖拽行为的形态」有意义，
  // 表格视图里显示一个锁只会让人以为表格能锁。
  const renderViewChrome = () => {
    if (viewTabsEl) {
      viewTabsEl.innerHTML = currentViews
        .map(view => {
          const on = String(view.id) === String(currentViewId);
          return `<button type="button" class="view-tab${on ? ' is-on' : ''}"
            role="tab" aria-selected="${on ? 'true' : 'false'}"
            title="${escapeHtml(view.name)} · ${escapeHtml(viewFormLabel(view.form))}"
            data-view="${escapeHtml(String(view.id))}" data-form="${escapeHtml(view.form)}">
            <span class="view-tab-icon">${icon(formIcon(view.form))}</span>
            <span class="view-tab-name">${escapeHtml(view.name)}</span>
          </button>`;
        })
        .join('');
    }

    if (!viewLock) return;
    const draggable = currentView && currentView.form === 'board';
    viewLock.style.display = draggable ? 'inline-flex' : 'none';
    const locked = !!currentView?.config?.lockDrag;
    viewLock.classList.toggle('is-locked', locked);
    viewLock.setAttribute('aria-pressed', locked ? 'true' : 'false');
    viewLock.title = locked ? '拖拽已锁定：每次拖动都要确认' : '拖拽未锁定：拖动立刻生效';
    viewLock.querySelector('use')?.setAttribute('href', locked ? '#ic-lock' : '#ic-unlock');
    const label = viewLock.querySelector('span');
    if (label) label.textContent = locked ? '已锁定' : '可拖动';
  };

  // 非表格形态要全量字段 + 全量行：看板要先知道有哪些分组列，画廊要挑封面列。
  // 按表缓存，切视图不重复查；切表或写完数据就把缓存作废。
  const loadViewData = async table => {
    if (viewData.tableId === String(table.id)) return viewData;
    const fields = await readTableFields(table);
    const rows = await readTableRows(table);
    viewData = { tableId: String(table.id), fields, rows };
    return viewData;
  };

  const openRowDrawerFor = (table, row) => {
    openRowDrawer({ row, fields: viewData.fields, subtitle: table?.name || '' });
  };

  const applyView = async view => {
    if (!currentTable || !view) return;
    // 这一帧认死一张表：下面交给视图层的回调绑定它，而不是「当前表」这个还会变的状态。
    // 不这么做，一次跨表之后的撤销会把旧行的值写进新表。
    const table = currentTable;
    currentViewId = view.id;
    currentView = view;
    try {
      localStorage.setItem(`workRecorder:view:${table.id}`, String(view.id));
    } catch (error) {
      /* 隐私模式写不进去，不影响功能 */
    }

    const preset = isPreset(table);
    const tableForm = view.form === 'table';
    // 表格形态用哪套网格（预设表可被双跑开关切到 sheetPage，见 usesSheetGrid）
    const sheetGrid = usesSheetGrid(table);

    if (viewPane) viewPane.style.display = tableForm ? 'none' : '';
    if (tableForm) {
      basePane.style.display = sheetGrid ? 'none' : '';
      sheetPane.style.display = sheetGrid ? '' : 'none';
    } else {
      basePane.style.display = 'none';
      sheetPane.style.display = 'none';
    }
    // 表头那排「全部 / 今天 / 字段 / 筛选 / 排序 / 主分类」是基础表专用：
    // 自建表（以及合流后的预设表）由 sheetPage 自带一整套工具栏。
    // 「＋ 新建」也一起收：它唤起的是全局录入浮层，写完只刷新表格，视图这边不会变。
    // 看板每栏自带「＋ 新建」（还能顺手带上分组值），顶栏不需要再来一个。
    if (toolsEl) toolsEl.style.display = preset && !sheetGrid && tableForm ? 'flex' : 'none';

    if (!tableForm) {
      const data = await loadViewData(table);
      renderView(viewApp, {
        table,
        view,
        fields: data.fields,
        rows: data.rows,
        // 写回：预置表落真列、自建表落 custom JSON。这一层只在 sheetStore 里分叉，
        // 视图自己永远不知道 record 长什么样。
        saveRow: (row, values) => saveTableRow(table, row, values),
        // 锁定看板落卡片前的确认框：视图层只管「问一句」，怎么问由宿主决定。
        confirm: confirmAction,
        // 撤销 / 重做写完库要重画：重新取一遍行（行对象会换新），
        // 但只在用户还停在这张表这个视图上时才动界面 —— 否则会把界面拽回旧视图。
        refresh: async () => {
          if (currentTable !== table || String(currentViewId) !== String(view.id)) return;
          viewData = { tableId: null, fields: [], rows: [] };
          await applyView(view);
        },
        onConfig: async patch => {
          const nextConfig = { ...view.config, ...patch };
          await patchView(view.id, { config: nextConfig });
          view.config = nextConfig;
          await applyView(view);
        },
        onAddRow: async (field, value) => {
          const values = {};
          if (field && value !== '' && value != null) {
            values[field.key] = field.type === 'multi_select' ? [value] : value;
          }
          const id = await insertTableRow(table, values);
          viewData = { tableId: null, fields: [], rows: [] };
          await applyView(view);
          const fresh = (await readTableRows(table)).find(item => String(item.id) === String(id));
          if (fresh) openRowDrawerFor(table, fresh);
        },
        onChanged: () => {
          viewData = { tableId: null, fields: [], rows: [] };
        },
      });
    }

    renderViewChrome();
  };

  const openTableView = async table => {
    currentViews = await listViews(table.id);
    // 兜底：理论上迁移和 createSheet 都会建默认视图，但历史库可能被手工改过。
    // 没有视图 = 这张表没有默认读法，宁可当场补一个，也不要让页签是空的。
    if (!currentViews.length) {
      await createView(table.id, { name: '表格', form: 'table' });
      currentViews = await listViews(table.id);
    }
    let remembered = null;
    try {
      remembered = localStorage.getItem(`workRecorder:view:${table.id}`);
    } catch (error) {
      remembered = null;
    }
    const target = currentViews.find(view => String(view.id) === String(remembered)) || currentViews[0];
    viewData = { tableId: null, fields: [], rows: [] };
    await applyView(target);
  };

  const defaultViewConfig = (table, fields, form) => {
    if (form === 'board') {
      // 默认分组优先「状态 / 阶段 / 进度」这类有终点的列，而不是「主分类」——
      // 分类可以有很多值（看板会横向铺满），状态通常只有 3~5 个，才是看板该有的样子。
      // 命名不符合也无所谓：视图页签上随时能换分组列，这里只是第一眼的合理猜测。
      const groupable = fields.filter(field => ['select', 'multi_select'].includes(field.type));
      const preferred = groupable.find(field => /状态|阶段|进度|status|stage|state|phase/i.test(`${field.key} ${field.label}`));
      const group = preferred || groupable[0];
      return group ? { groupBy: group.key } : {};
    }
    if (form === 'gallery') {
      const cover = fields.find(field => field.type === 'attachment');
      return cover ? { coverField: cover.key } : {};
    }
    return {};
  };

  const backToList = async () => {
    setMode('list');
    current = '';
    currentTable = null;
    currentViews = [];
    currentViewId = null;
    viewData = { tableId: null, fields: [], rows: [] };
    if (viewBar) viewBar.style.display = 'none';
    if (viewPane) viewPane.style.display = 'none';
    try { sheetList = await refreshSheetList(); } catch (error) {
      logToFile('error', `[records-view] 刷新表格列表失败: ${error?.stack || error}`);
    }
    await refreshDefaultTableId();
    renderLibrary();
  };

  newBtn?.addEventListener('click', () => openNewSheet());
  backBtn?.addEventListener('click', () => { backToList(); });

  listEl.addEventListener('click', event => {
    const more = event.target.closest('.lib-more');
    if (more) {
      event.stopPropagation();
      // 列表层没有「正打开的表」，按 id 取菜单目标
      openSheetMenuFor(String(more.dataset.more || '').replace(/^table:/, ''), more);
      return;
    }
    const row = event.target.closest('.lib-row');
    if (row) openDetail(row.dataset.key);
  });

  // 视图页签：只换看法，不搬家数据。
  viewTabsEl?.addEventListener('click', event => {
    const tab = event.target.closest('[data-view]');
    if (!tab) return;
    const view = currentViews.find(item => String(item.id) === String(tab.dataset.view));
    if (view) applyView(view);
  });

  viewAddBtn?.addEventListener('click', async () => {
    if (!currentTable) return;
    let fields = viewData.fields;
    if (!fields.length) fields = await readTableFields(currentTable);

    const ready = VIEW_FORMS.filter(item => item.ready);
    // 没有单选列时先说明白，别让用户建完一个空看板再来问为什么是空的。
    const grouped = fields.some(field => ['select', 'multi_select', 'checkbox'].includes(field.type));
    window.showModal?.(
      '新建视图',
      `<div class="sh-modal">
        <label class="sh-label">形态</label>
        <select class="sh-select" data-view-form>
          ${ready
            .map(item => `<option value="${item.form}"${item.form === 'board' ? (grouped ? '' : ' disabled') : ''}>${escapeHtml(item.label)} · ${escapeHtml(item.desc)}${item.form === 'board' && !grouped ? '（缺单选列）' : ''}</option>`)
            .join('')}
        </select>
        <label class="sh-label" style="margin-top:12px;">名称</label>
        <input class="sh-input" data-view-name placeholder="留空就用形态名" />
      </div>`,
      null,
      async body => {
        const form = body.querySelector('[data-view-form]')?.value || 'table';
        const name = String(body.querySelector('[data-view-name]')?.value || '').trim() || viewFormLabel(form);
        const config = defaultViewConfig(currentTable, fields, form);
        const id = await createView(currentTable.id, { name, form, config });
        currentViews = await listViews(currentTable.id);
        const created = currentViews.find(item => String(item.id) === String(id)) || currentViews[currentViews.length - 1];
        if (created) await applyView(created);
        return true;
      },
      { btnText: '创建' }
    );
  });

  // 锁定拖拽：状态存进视图配置（lockDrag），不是全局开关 ——
  // 「这张看板很要紧」是逐个视图的判断。锁上之后每次拖动都要确认，
  // 防的是「手一滑把卡片拖到别的栏、还没意识到自己改了数据」。
  viewLock?.addEventListener('click', async () => {
    const view = currentView;
    const table = currentTable;
    if (!view || !table) return;
    const nextConfig = { ...view.config, lockDrag: !view.config.lockDrag };
    try {
      await patchView(view.id, { config: nextConfig });
    } catch (error) {
      logToFile('error', `[records-view] 切换拖拽锁失败: ${error?.stack || error}`);
      return;
    }
    view.config = nextConfig;
    // 写库是异步的，这中间用户可能已经换了表：换了就只记住状态，不拿旧视图去重画新表。
    if (currentTable !== table) {
      renderViewChrome();
      return;
    }
    // 锁是有外观的状态（看板顶部会多一行「已锁定」提示），所以连板子一起重画，
    // 只重画页签条会让人怀疑「我到底锁上了没有」。loadViewData 有缓存，不重查库。
    try {
      await applyView(view);
    } catch (error) {
      logToFile('error', `[records-view] 锁状态重画失败: ${error?.stack || error}`);
      renderViewChrome();
    }
  });

  // 视图自己的 ⋯：重命名 / 删除。
  // 作用对象是「正在看的那一个视图」，不是整张表 —— 表级的重命名/删除在表库的 ⋯ 里。
  // 不放页签右键菜单：右键没人会发现，还会和页签的点击手势打架。
  const renameView = view => {
    window.showModal?.(
      '重命名视图',
      `<div class="sh-modal">
        <label class="sh-label">视图名称</label>
        <input type="text" class="sh-input" data-view-name value="${escapeHtml(view.name)}" />
      </div>`,
      body => {
        const input = body.querySelector('[data-view-name]');
        input?.focus();
        input?.select();
      },
      async body => {
        const name = String(body.querySelector('[data-view-name]')?.value || '').trim();
        if (!name) return false;
        if (name === view.name) return true;
        try {
          await patchView(view.id, { name });
        } catch (error) {
          toast(`重命名失败：${error?.message || error}`, 'danger');
          return false;
        }
        view.name = name;
        renderViewChrome();
        return true;
      },
      { btnText: '保存' }
    );
  };

  const removeView = async view => {
    const table = currentTable;
    if (!table) return;
    // 说清楚「删的是看法不是数据」：视图很容易被当成表，不写明白没人敢点。
    const ok = await confirmAction({
      title: '删除视图',
      message: `删除视图「${view.name}」？\n只删这一种看法，表里的记录一条都不会少。`,
      btnText: '删除',
      danger: true,
    });
    // 确认框开着的时候可能已经换了表：换了就别拿旧表去删视图、重画界面
    if (!ok || currentTable !== table) return;

    let removed = true;
    try {
      removed = await deleteView(view.id);
    } catch (error) {
      toast(`删除失败：${error?.message || error}`, 'danger');
      return;
    }
    if (removed === false) {
      toast('默认视图不能删：每张表都要留一个「表格」读法', 'info');
      return;
    }

    currentViews = await listViews(table.id);
    // 删的可能正是正在看的那个：认 id 找下一个，找不到就回默认视图
    const next = currentViews.find(item => String(item.id) === String(currentViewId)) || currentViews[0];
    if (next) await applyView(next);
    toast('视图已删除');
  };

  viewMore?.addEventListener('click', event => {
    event.stopPropagation();
    const view = currentView;
    if (!view || !currentTable) return;
    const isDefault = String(currentViews[0]?.id) === String(view.id);
    const menu = openPopoverSimple(viewMore, `
      <button type="button" class="sh-menu-item" data-view-act="rename">
        <svg class="wr-icon" aria-hidden="true"><use href="#ic-pencil"/></svg>重命名视图
      </button>
      ${isDefault
        ? '<div class="sh-menu-note">默认视图不能删：每张表都要留一个「表格」读法</div>'
        : `<button type="button" class="sh-menu-item is-danger" data-view-act="delete">
            <svg class="wr-icon" aria-hidden="true"><use href="#ic-trash"/></svg>删除视图
          </button>`}
    `);
    menu.classList.add('sh-rowmenu');
    menu.addEventListener('click', async clickEvent => {
      const action = clickEvent.target.closest('[data-view-act]')?.dataset.viewAct;
      if (!action) return;
      // 先收菜单再动手：重命名会弹 modal，两层浮层叠在一起既挡视线也关不干净
      closeAllPanels();
      if (action === 'rename') renameView(view);
      if (action === 'delete') await removeView(view);
    });
  });

  listEl.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('.lib-row');
    if (!row || event.target !== row) return;
    event.preventDefault();
    openDetail(row.dataset.key);
  });

  moreBtn?.addEventListener('click', event => {
    event.stopPropagation();
    // 预置表没有走 sheetPage 的 openSheetTab，state.sheet 是空的，
    // 用 id 打开菜单才不会「点了没反应」。
    if (currentTable && isPreset(currentTable)) openSheetMenuFor(String(currentTable.id), moreBtn);
    else openCurrentSheetMenu(moreBtn);
  });

  // 表列表变了（新建 / 重命名 / 删除）就重画列表。
  //
  // 「自动进表」只给新建用：新建后 currentSheetId 指向一张**上一版列表里没有**的表。
  // 以前这里只看 currentSheetId 有没有值 —— 于是「打开过某张表 → 返回列表 → 改名 / 删别人」
  // 都会被拽回那张表里，用户只是想改个名字却被弹进表内。
  onSheetListChange(async (list, meta) => {
    sheetList = Array.isArray(list) ? list : [];
    // 默认表存在 settings 里：改默认 / 删掉默认表之后，徽标和菜单状态都要跟着换，
    // 所以在重画之前先取一次（一次 settings 查询，代价可以忽略）。
    await refreshDefaultTableId();
    if (mode === 'list') renderLibrary();

    // 改名后表头要跟着变：列表重画了，但详情页标题是 openDetail 时写死的那一份。
    if (mode === 'detail' && currentTable) {
      const fresh = sheetList.find(item => String(item.id) === String(currentTable.id));
      if (fresh) {
        currentTable = fresh;
        if (titleEl) titleEl.textContent = fresh.name;
      }
    }

    const currentId = currentSheetId();
    // 只有「刚建好」才自动进表：靠 sheetPage 显式给的 meta，而不是猜 currentSheetId
    // 变化 —— 猜的话，「返回列表后改名 / 删表」也会把人拽进上次看的那张表。
    if (meta && meta.autoOpen && currentId != null && current !== `table:${currentId}`) {
      openDetail(`table:${currentId}`);
      return;
    }
    if (mode === 'detail' && String(current).startsWith('table:') &&
        !sheetList.some(item => `table:${item.id}` === current)) {
      // 正在看的表被删了 → 回列表，别停在一片空白
      backToList();
    }
  });

  // 快速筛选 chips（全部 / 今天 / 待整理）：状态只存在 tablePage 里。
  // P2.5 起默认走 sheetPage，这排 chip 随 #base-table-tools 一起隐藏，筛选由表内 .sh-quick 负责；
  // 这段只在 `wrPresetGrid = 'legacy'` 回退时才有活路，别当它是现役入口。
  const chips = Array.from(document.querySelectorAll('[data-rec-filter]'));
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(item => {
        const on = item === chip;
        item.classList.toggle('is-on', on);
        item.setAttribute('aria-pressed', String(on));
      });
      setTableFilter({ mode: chip.dataset.recFilter || 'all' });
    });
  });

  const mainFilter = document.getElementById('timeline-main-filter');
  const subFilter = document.getElementById('timeline-sub-filter');
  mainFilter?.addEventListener('change', () => {
    setTableFilter({ tag: mainFilter.value && mainFilter.value !== 'all' ? mainFilter.value : '' });
  });
  subFilter?.addEventListener('change', () => {
    setTableFilter({ subTag: subFilter.value && subFilter.value !== 'all' ? subFilter.value : '' });
  });

  // 从别的页切回表格页：回到表库并刷新（别处可能新建/删过表）。
  window.__wrRefreshRecordTable = () => backToList();

  // 快速记录写完之后的刷新口：记录可能写进了「默认表」，
  // 而当前正看着的看板 / 画廊不会自己知道。只刷非表格形态 ——
  // 表格形态各有自己的重载路径（重载会丢掉滚动位置和选区），别在这儿插手。
  window.__wrRefreshOpenView = async () => {
    if (!currentTable || !currentView || currentView.form === 'table') return;
    viewData = { tableId: null, fields: [], rows: [] };
    await applyView(currentView);
  };
  // 命令面板「新建表格」：先回表格页，再拉起工作表原有的新建弹层
  window.__wrNewSheet = () => {
    window.__wrRouteTo?.('nav-table');
    setTimeout(() => {
      setMode('list');
      renderLibrary();
      openNewSheet();
    }, 80);
  };

  const boot = async () => {
    try {
      sheetList = await refreshSheetList();
    } catch (error) {
      logToFile('error', `[records-view] 读取表格列表失败: ${error?.stack || error}`);
      sheetList = getSheetList();
    }
    await refreshDefaultTableId();
    renderLibrary();
    setMode('list');
  };

  boot().catch(error => {
    logToFile('error', `[records-view] 初始化失败: ${error?.stack || error}`);
  });
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

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
  };

  const todos = appData.todos || [];
  const pendingCount = todos.filter(todo => !todo.done).length;
  const doneCount = todos.length - pendingCount;
  // 今日条数必须和时间线列表同口径（logs + 待办 + 笔记），否则会出现
  // 「今天的记录 1 条」下面排着 4 行。过滤条件只在 todayTimeline 里写一次。
  const todayCount = countTodayItems();
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
