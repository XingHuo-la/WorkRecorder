import { loadData, appData, dbQuery, dbExecute } from './data.js';
import { logToFile, markLogReady } from './logger.js';
import { initTodoModule } from './todo.js';
import { initLogModule, renderHistoryList } from './log.js';
import { initTimelineModule, renderTimeline } from './timeline.js';
import { initSettingsModule } from './settings.js';
import { initQuickCapture } from './quickCapture.js';
import { renderTodayTimeline } from './todayTimeline.js';
import { initSearchModule } from './search.js';
import { initFreeCellModule } from './freecell.js';
import { initNotesEditor, flushBeforeLeave, refreshNotesCache } from './notesEditor.js';
import { initNotesModule } from './notes.js';
import { setNotesDataPathProvider } from './notesStore.js';
import { initTablePage, setTableAdapter } from './tablePage.js';

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

  // 表格页的数据访问走注入：tablePage.js 本身零顶层依赖，
  // 调试壳（_debug/ui-review.html）可绕过 Tauri 直接复用其渲染函数。
  setTableAdapter({ dbQuery, dbExecute });

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
  safeRun('record-reader', setupRecordReader);
  safeRun('search', initSearchModule);
  safeRun('freecell', initFreeCellModule);
  safeRun('legacy-tools-toggle', setupLegacyToolsToggle);

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
}

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
    toggle.innerText = isOpen ? '收起' : '打开完整录入';
    if (strip) strip.style.display = isOpen ? 'none' : '';
    if (collapse) {
      collapse.setAttribute('aria-expanded', String(isOpen));
      collapse.innerText = '收起';
    }

    if (shouldScroll) {
      const target = isOpen ? area : toggle.closest('.advanced-tools-strip');
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

function setupRecordReader() {
  const overlay = document.getElementById('record-reader-overlay');
  const closeButton = document.getElementById('record-reader-close');
  if (!overlay || !closeButton || overlay.dataset.bound === '1') return;

  const close = () => {
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
  };

  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && overlay.classList.contains('show')) close();
  });
  overlay.dataset.bound = '1';
  window.closeRecordReader = close;
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
  landingView.style.display = 'none';
  workspaceView.style.display = 'flex';
  document.getElementById('enter-btn')?.addEventListener('click', () => { landingView.style.display = 'none'; workspaceView.style.display = 'flex'; });
  document.getElementById('back-btn')?.addEventListener('click', () => { workspaceView.style.display = 'none'; landingView.style.display = 'flex'; });
  const navBtns = [
    { btn: document.getElementById('nav-dashboard'), view: document.getElementById('subview-dashboard') },
    { btn: document.getElementById('nav-notes'), view: document.getElementById('subview-notes') },
    { btn: document.getElementById('nav-table'), view: document.getElementById('subview-table') },
    { btn: document.getElementById('nav-timeline'), view: document.getElementById('subview-timeline') },
    { btn: document.getElementById('nav-freecell'), view: document.getElementById('subview-freecell') },
    { btn: document.getElementById('nav-search'), view: document.getElementById('subview-search') },
    { btn: document.getElementById('nav-settings'), view: document.getElementById('subview-settings') }
  ].filter(item => item.btn && item.view);
  navBtns.forEach(item => {
    item.btn.addEventListener('click', async () => {
    // 离开笔记页前先把未保存的草稿刷到磁盘
    const leavingNotes = document.getElementById('subview-notes')?.style.display !== 'none'
      && item.btn.id !== 'nav-notes';
    if (leavingNotes && typeof window.__wrFlushNotes === 'function') {
      try { await window.__wrFlushNotes(); } catch (error) { console.warn('笔记刷盘失败', error); }
    }

    navBtns.forEach(nav => { nav.view.style.display = 'none'; nav.btn.classList.remove('active'); });
       item.view.style.display = item.btn.id === 'nav-dashboard' ? '' : 'block'; item.btn.classList.add('active');
       navBtns.forEach(nav => nav.btn.removeAttribute('aria-current'));
       item.btn.setAttribute('aria-current', 'page');
      localStorage.setItem('workRecorder:lastSubview', item.btn.id);
      if (item.btn.id === 'nav-timeline') renderTimeline();
      if (item.btn.id === 'nav-table') {
        try { await initTablePage(); } catch (error) { logToFile('error', `表格页初始化失败: ${error?.stack || error}`); }
      }
      if (item.btn.id === 'nav-search') document.getElementById('global-search-input')?.focus();
    });
  });

  const lastSubview = localStorage.getItem('workRecorder:lastSubview');
  const targetNav = navBtns.find(item => item.btn.id === lastSubview);
  if (targetNav) targetNav.btn.click();
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

  const pendingCount = appData.todos.filter(todo => !todo.done).length;
  const completedCount = appData.todos.filter(todo => todo.done).length;
  const todayCount = (appData.logs[todayStr] || []).length;
  const noteCount = (appData.notes || []).length;

  setText('summary-pending-count', pendingCount);
  setText('summary-completed-count', completedCount);
  setText('summary-today-count', todayCount);
  setText('summary-note-count', noteCount);
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
