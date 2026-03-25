import { loadData, appData } from './data.js';
import { initTodoModule } from './todo.js';
import { initLogModule, renderHistoryList } from './log.js';
import { initTimelineModule, renderTimeline } from './timeline.js';
import { initSettingsModule } from './settings.js';

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
  document.documentElement.className = '';
  if (appData.settings && appData.settings.theme && appData.settings.theme !== 'dark') {
      document.documentElement.classList.add(`theme-${appData.settings.theme}`);
  }
  setupRouting(); setupTabs();
  initTodoModule(); initLogModule(); renderHistoryList(); initTimelineModule(); initSettingsModule();

  // 全局事件 1：点击空白处收起所有三点菜单
  document.addEventListener('click', (e) => {
    if (!e.target.matches('.dots-btn')) {
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
}

function setupTitlebar() {
  const appWindow = getCurrentWindow();

  document.getElementById('titlebar-minimize').addEventListener('click', () => {
    appWindow.minimize();
  });

  document.getElementById('titlebar-maximize').addEventListener('click', () => {
    appWindow.toggleMaximize();
  });

  document.getElementById('titlebar-close').addEventListener('click', () => {
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
  document.getElementById('enter-btn').addEventListener('click', () => { landingView.style.display = 'none'; workspaceView.style.display = 'flex'; });
  document.getElementById('back-btn').addEventListener('click', () => { workspaceView.style.display = 'none'; landingView.style.display = 'flex'; });
  const navBtns = [
    { btn: document.getElementById('nav-dashboard'), view: document.getElementById('subview-dashboard') },
    { btn: document.getElementById('nav-timeline'), view: document.getElementById('subview-timeline') },
    { btn: document.getElementById('nav-settings'), view: document.getElementById('subview-settings') }
  ];
  navBtns.forEach(item => {
    item.btn.addEventListener('click', () => {
      navBtns.forEach(nav => { nav.view.style.display = 'none'; nav.btn.classList.remove('active'); });
      item.view.style.display = 'block'; item.btn.classList.add('active');
      if (item.btn.id === 'nav-timeline') renderTimeline();
    });
  });
}

function setupTabs() {
  const btnLog = document.getElementById('tab-log-btn'); const btnTodo = document.getElementById('tab-todo-btn');
  const panelLog = document.getElementById('panel-log'); const panelTodo = document.getElementById('panel-todo');
  btnLog.addEventListener('click', () => { btnLog.classList.add('active'); btnTodo.classList.remove('active'); panelLog.style.display = 'block'; panelTodo.style.display = 'none'; });
  btnTodo.addEventListener('click', () => { btnTodo.classList.add('active'); btnLog.classList.remove('active'); panelTodo.style.display = 'block'; panelLog.style.display = 'none'; });
}
window.addEventListener("DOMContentLoaded", initApp);