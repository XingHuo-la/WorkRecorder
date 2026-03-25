import { appData, saveData, getTodayString } from './data.js';
import { openUniversalEditModal } from './formUtils.js';

// 全局挂载增强版 Flatpickr：支持中文、完美滚轮跟随、强制时分秒滚动、年份切换
window.addFpConfirmBtn = function(selectedDates, dateStr, instance) {
  // 1. 添加确认按钮
  if (!instance.calendarContainer.querySelector('.flatpickr-custom-confirm')) {
    const btn = document.createElement("button");
    btn.className = "flatpickr-custom-confirm";
    btn.innerHTML = "✅ 确认选择";
    btn.type = "button"; 
    btn.onclick = () => instance.close();
    instance.calendarContainer.appendChild(btn);
  }

  // 2. 月份的鼠标滚轮切换
  const monthNav = instance.calendarContainer.querySelector('.flatpickr-months');
  if (monthNav && !monthNav.dataset.wheelBound) {
    monthNav.dataset.wheelBound = "true";
    monthNav.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      instance.changeMonth(e.deltaY > 0 ? 1 : -1); 
    }, { passive: false });
  }

// 3. 🚀 穿透级接管：时、分、秒的鼠标滚轮滑动
  const timeContainer = instance.calendarContainer.querySelector('.flatpickr-time');
  if (timeContainer && !timeContainer.dataset.wheelBound) {
    timeContainer.dataset.wheelBound = "true";
    timeContainer.addEventListener('wheel', (e) => {
      // 不管悬浮在数字上还是边框上，精准定位到对应的 input
      let input = e.target.tagName === 'INPUT' ? e.target : e.target.closest('.numInputWrapper')?.querySelector('input');
      if (input && input.tagName === 'INPUT') {
        e.preventDefault(); e.stopPropagation();
        
        const step = parseFloat(input.step) || 1;
        const dir = e.deltaY < 0 ? 1 : -1; // 向上滚增加，向下滚减少
        let val = parseFloat(input.value) || 0;
        let max = parseFloat(input.max) || (input.classList.contains('flatpickr-hour') ? 23 : 59);
        let min = parseFloat(input.min) || 0;
        
        val += (dir * step);
        if (val > max) val = min; // 达到最大值循环回 0
        if (val < min) val = max; // 达到最小值循环回最大
        
        input.value = val.toString().padStart(2, '0');
        // 强制触发原生事件，让日历引擎知道时间改变了
        input.dispatchEvent(new Event('input', { bubbles: true }));

        // 🌟 终极修复：直接从 UI 上抓取最新的数字拼装，彻底绕开引擎的延迟！
        if (instance.selectedDates && instance.selectedDates.length > 0) {
            const d = instance.selectedDates[0];
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            
            // 暴力破解：直接抓取 DOM 里你刚刚滚出来的最新的时、分、秒
            const hh = instance.hourElement ? instance.hourElement.value.padStart(2, '0') : "00";
            const minStr = instance.minuteElement ? instance.minuteElement.value.padStart(2, '0') : "00";
            const secStr = instance.secondElement ? instance.secondElement.value.padStart(2, '0') : "00";
            
            // 强行写回外部输入框
            instance.input.value = `${yyyy}-${mm}-${dd} ${hh}:${minStr}:${secStr}`;
        }
      }
    }, { passive: false });
  }

  // 4. 🚀 动态注入年份的左右切换按钮 《 》
  const yearWrapper = instance.calendarContainer.querySelector('.flatpickr-current-month .numInputWrapper');
  if (yearWrapper && !yearWrapper.querySelector('.year-btn-prev')) {
    const prevBtn = document.createElement('span');
    prevBtn.className = 'year-btn-prev';
    prevBtn.innerHTML = '《';
    prevBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); instance.changeYear(instance.currentYear - 1); };
    
    const nextBtn = document.createElement('span');
    nextBtn.className = 'year-btn-next';
    nextBtn.innerHTML = '》';
    nextBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); instance.changeYear(instance.currentYear + 1); };

    yearWrapper.prepend(prevBtn);
    yearWrapper.appendChild(nextBtn);
  }
};

/// 全局统一的完美配置模板
window.fpGlobalConfig = {
  enableTime: true, 
  enableSeconds: true, 
  time_24hr: true, 
  dateFormat: "Y-m-d H:i:S", 
  locale: "zh",               
  position: "below",          
  onReady: window.addFpConfirmBtn,

  // 只要面板里的值发生任何变化（包括滚轮），立刻同步到外面的输入框！
  onValueUpdate: function(selectedDates, dateStr, instance) {
      if (instance.input && dateStr) {
          instance.input.value = dateStr;
      }
  },
  
  onOpen: function(selectedDates, dateStr, instance) {
    // 🌟 解决“获取不到最新时间”的核心逻辑：
    // 当日历打开时，如果输入框本来是空的，立刻抓取【此刻真实时间】填进去
    if (!instance.input.value) {
        const now = new Date();
        // 如果你喜欢分秒都是 0，可以加上这句：now.setMinutes(0, 0, 0);
        instance.setDate(now, true); // true 代表立刻将此刻时间写回输入框
    }

    const mainContent = document.querySelector('.main-content');
    if (mainContent && !instance.element.closest('.custom-modal')) {
        // 1. 先撑开底部物理空间，保证有地方可以滚
        mainContent.style.paddingBottom = '400px'; 
        
        setTimeout(() => {
            // 2. 获取当前输入框在屏幕上的位置
            const rect = instance.element.getBoundingClientRect();
            // 3. 计算输入框底部距离浏览器底部的可视空间
            const spaceBelow = window.innerHeight - rect.bottom;
            
            // 4. 日历面板高度大概是 350px。如果下方空间不足 350px，才需要滚动
            if (spaceBelow < 350) {
                // 缺多少像素，就精确地往下滚多少像素
                const scrollAmount = 350 - spaceBelow;
                mainContent.scrollBy({ top: scrollAmount, behavior: 'smooth' });
            }
        }, 50);
    }
  },
  
  onClose: function(selectedDates, dateStr, instance) {
    const mainContent = document.querySelector('.main-content');
    if (mainContent && !instance.element.closest('.custom-modal')) {
        mainContent.style.paddingBottom = '100px'; 
    }
  }
};

export function initLogModule() {
  const useCurrentTimeCb = document.getElementById('log-use-current-time'); const manualDatetimeInput = document.getElementById('log-manual-datetime');
  const hasDeadlineCb = document.getElementById('log-has-deadline'); const deadlineInput = document.getElementById('log-deadline-input');
  const tagSelect = document.getElementById('log-tag-select'); const tagNewInput = document.getElementById('log-tag-new');
  const subSelect = document.getElementById('log-sub-tag-select'); const subNewInput = document.getElementById('log-sub-tag-new');

  const fpConfig = { ...window.fpGlobalConfig };
  
  flatpickr(manualDatetimeInput, fpConfig); 
  const fpDeadline = flatpickr(deadlineInput, fpConfig);

  useCurrentTimeCb.onchange = () => manualDatetimeInput.style.display = useCurrentTimeCb.checked ? 'none' : 'block';
  hasDeadlineCb.onchange = () => deadlineInput.style.display = hasDeadlineCb.checked ? 'block' : 'none';

  window.renderLogTags = () => {
    tagSelect.innerHTML = ''; const activeTags = (appData.settings && appData.settings.active_tags) ? appData.settings.active_tags : appData.tags;
    activeTags.forEach(t => tagSelect.innerHTML += `<option value="${t}">${t}</option>`);
    tagSelect.innerHTML += `<option value="NEW">➕ 新建主分类...</option>`; window.renderLogSubTags();
  };
  window.renderLogSubTags = () => {
    const mainTag = tagSelect.value === 'NEW' ? tagNewInput.value.trim() : tagSelect.value;
    subSelect.innerHTML = '<option value="">(无子项目)</option>';
    if (mainTag && appData.sub_tags && appData.sub_tags[mainTag]) appData.sub_tags[mainTag].forEach(t => subSelect.innerHTML += `<option value="${t}">${t}</option>`);
    subSelect.innerHTML += `<option value="NEW">➕ 新建子项目...</option>`;
  };

  tagSelect.addEventListener('change', () => { tagNewInput.style.display = tagSelect.value === 'NEW' ? 'block' : 'none'; if(tagSelect.value === 'NEW') tagNewInput.focus(); subNewInput.style.display = 'none'; window.renderLogSubTags(); });
  tagNewInput.addEventListener('input', window.renderLogSubTags);
  subSelect.addEventListener('change', () => { subNewInput.style.display = subSelect.value === 'NEW' ? 'block' : 'none'; if(subSelect.value === 'NEW') subNewInput.focus(); });
  window.renderLogTags();

  document.getElementById('add-log-btn').addEventListener('click', async () => {
    const taskInput = document.getElementById('log-task-input').value.trim(); if (!taskInput) { alert("⚠️ 核心事件不能为空！"); return; }
    const finalTag = tagSelect.value === 'NEW' ? tagNewInput.value.trim() : tagSelect.value;
    const finalSub = subSelect.value === 'NEW' ? subNewInput.value.trim() : subSelect.value;
    if (!finalTag) { alert("⚠️ 请输入或选择主分类！"); return; }

    if (tagSelect.value === 'NEW' && !appData.tags.includes(finalTag)) {
      appData.tags.push(finalTag);
      if (!appData.settings) appData.settings = {}; if (!appData.settings.active_tags) appData.settings.active_tags = [...appData.tags];
      if (!appData.settings.active_tags.includes(finalTag)) appData.settings.active_tags.push(finalTag);
    }
    if (finalSub && subSelect.value === 'NEW') {
      if (!appData.sub_tags) appData.sub_tags = {}; if (!appData.sub_tags[finalTag]) appData.sub_tags[finalTag] = [];
      if (!appData.sub_tags[finalTag].includes(finalSub)) appData.sub_tags[finalTag].push(finalSub);
    }
    window.renderLogTags(); if(window.renderTodoTags) window.renderTodoTags();

    let finalDateStr, finalTimeStr;
    if (useCurrentTimeCb.checked) {
      finalDateStr = getTodayString(); const now = new Date();
      finalTimeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    } else {
      const dtValue = manualDatetimeInput.value; if (!dtValue) { alert("⚠️ 请选择明确的时间！"); return; }
      [finalDateStr, finalTimeStr] = dtValue.split(' ');
    }

    const newLog = { time: finalTimeStr, text: taskInput, tag: finalTag, sub_tag: finalSub, detail: document.getElementById('log-detail-input').value.trim(), is_overdue: document.querySelector('input[name="log-status"]:checked').value === "overdue", deadline: hasDeadlineCb.checked ? deadlineInput.value : "" };
    if (!appData.logs[finalDateStr]) appData.logs[finalDateStr] = [];
    appData.logs[finalDateStr].unshift(newLog); appData.logs[finalDateStr].sort((a, b) => b.time.localeCompare(a.time));
    await saveData();
    
    document.getElementById('log-task-input').value = ""; document.getElementById('log-detail-input').value = "";
    tagSelect.value = finalTag; 
    tagNewInput.style.display = 'none'; 
    window.renderLogSubTags();
    subSelect.value = finalSub; 

    if(hasDeadlineCb.checked) { hasDeadlineCb.checked = false; deadlineInput.style.display = 'none'; fpDeadline.clear(); }
    renderHistoryList(); 
  });
}

export function renderHistoryList() {
  const container = document.getElementById('history-list-container'); if(!container) return; container.innerHTML = ""; 
  const todayStr = getTodayString(); const todayLogs = appData.logs[todayStr] || [];

  if (todayLogs.length === 0) { container.innerHTML = "<p style='color: gray; font-size: 0.9em;'>今天还没有记录任何事情哦~ 赶紧在顶部记一笔吧！</p>"; return; }

  todayLogs.forEach((log, index) => {
    const isCompletedTodo = !!log.linked_todo || log.text.includes("完成待办"); 
    const themeClass = isCompletedTodo ? "border-success" : "border-primary";
    const detailText = log.detail ? log.detail : "(未填写详细说明)";
    
    let displayText = log.text;
    if (displayText.startsWith("完成待办: ")) displayText = displayText.replace("完成待办: ", "").trim();

    let todoBadgeHtml = isCompletedTodo ? `<span style="background: rgba(74, 222, 128, 0.15); color: #4ade80; padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-right: 8px; border: 1px solid rgba(74, 222, 128, 0.3);">待</span>` : "";
    let deadlineHtml = log.deadline ? `<span class="todo-deadline" style="margin-left: 10px; font-weight: normal; font-size: 12px;">📅 截至 ${log.deadline}</span>` : "";
    let subTagHtml = log.sub_tag ? `<span style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px;">📁 ${log.sub_tag}</span>` : "";
    
    // 👉 新增：流水的徽标
    let detailBadge = log.detail ? `<span style="background: rgba(148, 163, 184, 0.15); color: #94A3B8; border: 1px solid rgba(148, 163, 184, 0.3); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">详</span>` : "";
    let remarkBadge = log.remark ? `<span style="background: rgba(250, 204, 21, 0.15); color: #facc15; border: 1px solid rgba(250, 204, 21, 0.3); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">补</span>` : "";

    const htmlString = `
      <details class="glass-accordion ${themeClass}">
        <summary class="log-summary">
          <span class="log-time">${log.time.substring(0, 5)}</span>
          <span class="log-text"><b>[${log.tag}]</b> ${todoBadgeHtml}${displayText} ${subTagHtml} ${deadlineHtml} ${detailBadge} ${remarkBadge}</span>
        </summary>
        <div class="expanded-content">
          <div style="margin-bottom: 15px;">${detailText}</div>
          ${log.remark ? `<div class="item-remark">${log.remark.replace(/\n/g, '<br>')}</div>` : ""}
          <div style="display: flex; gap: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px; justify-content: flex-end;">
            <div class="dropdown-wrapper" onclick="event.preventDefault(); event.stopPropagation();">
                <button class="dots-btn icon-btn" style="padding: 4px 10px; margin: 0; font-size: 13px;" onclick="
                    const menu = this.nextElementSibling; const isShow = menu.classList.contains('show');
                    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
                    document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
                    if (!isShow) { menu.classList.add('show'); const card = this.closest('.glass-accordion'); if(card) card.classList.add('elevated-zindex'); }
                ">⋮ 操作</button>
                <div class="dropdown-menu">
                    <div class="dropdown-item add-remark-log-btn" data-index="${index}">💬 添加/修改补述</div>
                    <div class="dropdown-item edit-log-btn" data-index="${index}">✏️ 编辑</div>
                    <div class="dropdown-item danger del-log-btn" data-index="${index}">🗑️ 删除记录</div>
                </div>
            </div>
          </div>
        </div>
      </details>
    `;
    container.insertAdjacentHTML('beforeend', htmlString);
  });

  const closeMenus = () => {
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
  };

  document.querySelectorAll('.edit-log-btn').forEach(btn => {
      btn.onclick = (e) => {
          closeMenus();
          const idx = e.target.getAttribute('data-index'); 
          const log = todayLogs[idx];
          
          // 获取当前主题
          const currentTheme = (appData.settings && appData.settings.theme === 'light') ? 'theme-light-modal' : 'theme-dark-modal';

          openUniversalEditModal("✏️ 编辑流水与标签", log, {
              type: 'log',           // 告诉工厂这是流水，需要时间字段
              dateStr: todayStr,     // 传入今天的日期
              themeClass: currentTheme,
              
              // ⏪ 撤销待办逻辑 (完全不用管 HTML，只写业务)
              onRestore: async (cleanText) => {
                  const taskName = log.linked_todo || cleanText;
                  let existingTodo = appData.todos.find(t => t.task === taskName && t.done);
                  if (existingTodo) {
                      existingTodo.done = false; existingTodo.completed_at = "";
                  } else {
                      appData.todos.push({
                          task: taskName, done: false, tag: log.tag, sub_tag: log.sub_tag,
                          detail: log.detail, remark: log.remark, deadline: log.deadline
                      });
                  }
                  // 从今日流水中抹除
                  todayLogs.splice(idx, 1);
                  if (todayLogs.length === 0) delete appData.logs[todayStr];

                  await saveData();
                  document.getElementById('global-modal-overlay').style.display = 'none';
                  renderHistoryList();
                  import('./todo.js').then(m => m.renderTodoList()); // 同步右侧待办
              },
              
              // 💾 保存逻辑 (包含跨天移动数组)
              onSave: async (updatedData) => {
                  log.text = updatedData.text;
                  log.detail = updatedData.detail;
                  log.deadline = updatedData.deadline;
                  log.tag = updatedData.tag;
                  log.sub_tag = updatedData.sub_tag;

                  // 🌟 核心区别：处理跨天逻辑
                  if (updatedData.newDateStr !== todayStr) {
                      log.time = updatedData.newTimeStr;
                      // 1. 从今天删掉
                      todayLogs.splice(idx, 1);
                      if (todayLogs.length === 0) delete appData.logs[todayStr];
                      
                      // 2. 塞入新的一天
                      if (!appData.logs[updatedData.newDateStr]) appData.logs[updatedData.newDateStr] = [];
                      appData.logs[updatedData.newDateStr].push(log);
                      appData.logs[updatedData.newDateStr].sort((a,b) => b.time.localeCompare(a.time));
                  } else {
                      log.time = updatedData.newTimeStr;
                      todayLogs.sort((a,b) => b.time.localeCompare(a.time));
                  }

                  await saveData(); 
                  renderHistoryList();
                  if(window.renderLogTags) window.renderLogTags();
                  return true; // 告诉弹窗操作成功，可以关闭
              }
          });
      };
  });

  document.querySelectorAll('.add-remark-log-btn').forEach(btn => {
    btn.onclick = (e) => {
        closeMenus();
        const idx = e.target.getAttribute('data-index'); 
        const log = todayLogs[idx];
        
        window.showModal("💬 流水记录补述与复盘", `
            <div class="form-group">
                <label class="field-label" style="color:var(--color-primary);">💡 补充细节、灵感、不完美的地方或复盘：</label>
                <textarea id="m-log-remark" class="hero-textarea" style="margin-top:10px; min-height: 120px;">${log.remark || ''}</textarea>
            </div>
        `, body => body.querySelector('#m-log-remark').focus(), async (body) => {
            log.remark = body.querySelector('#m-log-remark').value.trim();
            await saveData(); 
            renderHistoryList();
        });
    };
  });

  document.querySelectorAll('.del-log-btn').forEach(btn => {
    btn.onclick = async (e) => {
      closeMenus();
      const idx = e.target.getAttribute('data-index');
      
      window.showModal("⚠️ 删除流水记录", `<div style="font-size: 15px; color: #e2e8f0;">确定要永久删除这条流水记录吗？操作不可逆。</div>`, null, async () => {
          todayLogs.splice(idx, 1); 
          if (todayLogs.length === 0) delete appData.logs[todayStr];
          await saveData(); renderHistoryList();
      }, { danger: true });
    };
  });
}