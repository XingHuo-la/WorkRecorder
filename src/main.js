import { loadData, appData } from './data.js';
import { initTodoModule } from './todo.js';
import { initLogModule, renderHistoryList } from './log.js';
import { initTimelineModule, renderTimeline } from './timeline.js';
import { initSettingsModule } from './settings.js';
import { initNotesModule, renderNotesList } from './notes.js';
import { initQuickCapture } from './quickCapture.js';
import { renderTodayTimeline } from './todayTimeline.js';

const { getCurrentWindow } = window.__TAURI__.window;

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
  await loadData();
  await import('./settings.js').then(async (m) => {
      await m.applySavedThemeFromDB();
  });

  const safeRun = (label, fn) => {
    try {
      return fn();
    } catch (error) {
      console.error(`[${label}] 初始化失败`, error);
      return null;
    }
  };

  safeRun('routing', setupRouting);
  safeRun('legacy-tabs', setupTabs);
  safeRun('quick-advanced-options', setupQuickAdvancedOptions);
  safeRun('todo', initTodoModule);
  safeRun('log', initLogModule);
  safeRun('notes', initNotesModule);
  safeRun('history-render', renderHistoryList);
  safeRun('notes-render', renderNotesList);
  safeRun('today-timeline', renderTodayTimeline);
  safeRun('timeline', initTimelineModule);
  safeRun('settings', initSettingsModule);
  safeRun('quick-capture', initQuickCapture);
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

function setupQuickAdvancedOptions() {
  const typeSelect = document.getElementById('quick-type-select');
  const tagSelect = document.getElementById('quick-tag-select');
  const subSelect = document.getElementById('quick-sub-tag-select');
  const tagNewInput = document.getElementById('quick-tag-new');
  const subNewInput = document.getElementById('quick-sub-tag-new');
  const parentSelect = document.getElementById('quick-parent-todo-select');

  if (!typeSelect || !tagSelect || !subSelect) return;

  const buildTodoPath = (todo, byId) => {
    const names = [todo.task];
    let current = todo;
    const seen = new Set([todo.id]);
    while (current.parent_id && byId.has(current.parent_id) && !seen.has(current.parent_id)) {
      current = byId.get(current.parent_id);
      seen.add(current.id);
      names.unshift(current.task);
    }
    return names.join(' / ');
  };

  const renderQuickParentTodos = () => {
    if (!parentSelect) return;
    const currentValue = parentSelect.value;
    const byId = new Map((appData.todos || []).map(todo => [todo.id, todo]));
    parentSelect.innerHTML = '<option value="">无父任务</option>';
    (appData.todos || [])
      .filter(todo => !todo.done)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id)
      .forEach(todo => {
        parentSelect.innerHTML += `<option value="${todo.id}">${buildTodoPath(todo, byId)}</option>`;
      });
    if ([...parentSelect.options].some(option => option.value === currentValue)) parentSelect.value = currentValue;
  };

  const renderQuickSubTags = () => {
    const mainTag = tagSelect.value === 'NEW' ? tagNewInput.value.trim() : tagSelect.value;
    subSelect.innerHTML = '<option value="">无项目</option>';
    if (mainTag && appData.sub_tags?.[mainTag]) {
      appData.sub_tags[mainTag].forEach(sub => {
        subSelect.innerHTML += `<option value="${sub}">${sub}</option>`;
      });
    }
    subSelect.innerHTML += '<option value="NEW">新建子项目...</option>';
  };

  tagSelect.innerHTML = '<option value="未分类">未分类</option>';
  (appData.settings?.active_tags || appData.tags || []).forEach(tag => {
    tagSelect.innerHTML += `<option value="${tag}">${tag}</option>`;
  });
  tagSelect.innerHTML += '<option value="NEW">新建主分类...</option>';
  renderQuickSubTags();
  renderQuickParentTodos();
  window.renderQuickParentTodos = renderQuickParentTodos;

  tagSelect.addEventListener('change', () => {
    tagNewInput.style.display = tagSelect.value === 'NEW' ? 'block' : 'none';
    if (tagSelect.value === 'NEW') tagNewInput.focus();
    subNewInput.style.display = 'none';
    renderQuickSubTags();
  });
  tagNewInput.addEventListener('input', renderQuickSubTags);
  subSelect.addEventListener('change', () => {
    subNewInput.style.display = subSelect.value === 'NEW' ? 'block' : 'none';
    if (subSelect.value === 'NEW') subNewInput.focus();
  });
}

function setupLegacyToolsToggle() {
  const toggle = document.getElementById('legacy-tools-toggle');
  const collapse = document.getElementById('legacy-tools-collapse');
  const area = document.getElementById('legacy-capture-area');
  if (!toggle || !area) return;

  const setOpen = (isOpen, shouldScroll = false) => {
    area.classList.toggle('show', isOpen);
    area.setAttribute('aria-hidden', String(!isOpen));
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.innerText = isOpen ? '收起完整整理工具' : '展开完整整理工具';
    if (collapse) collapse.setAttribute('aria-expanded', String(isOpen));

    if (shouldScroll) {
      const target = isOpen ? area : toggle.closest('.task-tree-section');
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
          <button id="global-modal-cancel" class="primary-btn" style="background:transparent; border:1px solid var(--border-medium); color:var(--text-muted); width:auto; padding:8px 16px; margin:0;">取消</button>
          <button id="global-modal-confirm" class="primary-btn" style="width:auto; padding:8px 20px; margin:0;"></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });

    const modal = overlay.querySelector('.custom-modal');
    modal.className = `custom-modal ${options.themeClass || ''}`; // 预留主题扩展接口
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

  document.getElementById('global-modal-title').innerHTML = title;
  document.getElementById('global-modal-body').innerHTML = htmlContent;
  overlay.style.display = 'flex';

  const cancelBtn = document.getElementById('global-modal-cancel');
  const confirmBtn = document.getElementById('global-modal-confirm');

  const isDanger = options.danger || false;
  confirmBtn.innerText = options.btnText || (isDanger ? "🗑️ 确认删除" : "💾 确认保存");
  if (isDanger) {
      confirmBtn.className = "primary-btn danger-btn"; 
  } else {
      confirmBtn.className = "primary-btn";
  }

  const newCancel = cancelBtn.cloneNode(true); cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
  const newConfirm = confirmBtn.cloneNode(true); confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

  newCancel.onclick = () => overlay.style.display = 'none';
  const bodyEl = document.getElementById('global-modal-body');
  if (onReady) onReady(bodyEl);
  newConfirm.onclick = async () => {
    const success = await onConfirm(bodyEl);
    if (success !== false) overlay.style.display = 'none';
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
    { btn: document.getElementById('nav-timeline'), view: document.getElementById('subview-timeline') },
    { btn: document.getElementById('nav-settings'), view: document.getElementById('subview-settings') }
  ].filter(item => item.btn && item.view);
  navBtns.forEach(item => {
    item.btn.addEventListener('click', () => {
      navBtns.forEach(nav => { nav.view.style.display = 'none'; nav.btn.classList.remove('active'); });
      item.view.style.display = 'block'; item.btn.classList.add('active');
      localStorage.setItem('workRecorder:lastSubview', item.btn.id);
      if (item.btn.id === 'nav-timeline') renderTimeline();
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
    panelLog.style.display = tab === 'log' ? 'block' : 'none';
    panelTodo.style.display = isTodo ? 'block' : 'none';
    if (panelNote) panelNote.style.display = isNote ? 'block' : 'none';
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
window.addEventListener("DOMContentLoaded", initApp);
