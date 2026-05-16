import { appData, dbExecute, loadData, getTodayString } from './data.js';
import { openUniversalEditModal } from './formUtils.js';

// ==========================================
// 📅 全局挂载增强版 Flatpickr (保持你原有的完美配置)
// ==========================================
window.addFpConfirmBtn = function(selectedDates, dateStr, instance) {
  if (!instance.calendarContainer.querySelector('.flatpickr-custom-confirm')) {
    const btn = document.createElement("button");
    btn.className = "flatpickr-custom-confirm"; btn.innerHTML = "✅ 确认选择"; btn.type = "button"; 
    btn.onclick = () => instance.close();
    instance.calendarContainer.appendChild(btn);
  }
  const monthNav = instance.calendarContainer.querySelector('.flatpickr-months');
  if (monthNav && !monthNav.dataset.wheelBound) {
    monthNav.dataset.wheelBound = "true";
    monthNav.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); instance.changeMonth(e.deltaY > 0 ? 1 : -1); }, { passive: false });
  }
  const timeContainer = instance.calendarContainer.querySelector('.flatpickr-time');
  if (timeContainer && !timeContainer.dataset.wheelBound) {
    timeContainer.dataset.wheelBound = "true";
    timeContainer.addEventListener('wheel', (e) => {
      let input = e.target.tagName === 'INPUT' ? e.target : e.target.closest('.numInputWrapper')?.querySelector('input');
      if (input && input.tagName === 'INPUT') {
        e.preventDefault(); e.stopPropagation();
        const step = parseFloat(input.step) || 1; const dir = e.deltaY < 0 ? 1 : -1; 
        let val = parseFloat(input.value) || 0; let max = parseFloat(input.max) || (input.classList.contains('flatpickr-hour') ? 23 : 59); let min = parseFloat(input.min) || 0;
        val += (dir * step); if (val > max) val = min; if (val < min) val = max; 
        input.value = val.toString().padStart(2, '0');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (instance.selectedDates && instance.selectedDates.length > 0) {
            const d = instance.selectedDates[0];
            const yyyy = d.getFullYear(); const mm = String(d.getMonth() + 1).padStart(2, '0'); const dd = String(d.getDate()).padStart(2, '0');
            const hh = instance.hourElement ? instance.hourElement.value.padStart(2, '0') : "00";
            const minStr = instance.minuteElement ? instance.minuteElement.value.padStart(2, '0') : "00";
            const secStr = instance.secondElement ? instance.secondElement.value.padStart(2, '0') : "00";
            instance.input.value = `${yyyy}-${mm}-${dd} ${hh}:${minStr}:${secStr}`;
        }
      }
    }, { passive: false });
  }
  const yearWrapper = instance.calendarContainer.querySelector('.flatpickr-current-month .numInputWrapper');
  if (yearWrapper && !yearWrapper.querySelector('.year-btn-prev')) {
    const prevBtn = document.createElement('span'); prevBtn.className = 'year-btn-prev'; prevBtn.innerHTML = '《';
    prevBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); instance.changeYear(instance.currentYear - 1); };
    const nextBtn = document.createElement('span'); nextBtn.className = 'year-btn-next'; nextBtn.innerHTML = '》';
    nextBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); instance.changeYear(instance.currentYear + 1); };
    yearWrapper.prepend(prevBtn); yearWrapper.appendChild(nextBtn);
  }
};

window.fpGlobalConfig = {
  enableTime: true, enableSeconds: true, time_24hr: true, dateFormat: "Y-m-d H:i:S", locale: "zh", position: "below",          
  onReady: window.addFpConfirmBtn,
  onValueUpdate: function(selectedDates, dateStr, instance) { if (instance.input && dateStr) { instance.input.value = dateStr; } },
  onOpen: function(selectedDates, dateStr, instance) {
    if (!instance.input.value) { const now = new Date(); instance.setDate(now, true); }
    const mainContent = document.querySelector('.main-content');
    if (mainContent && !instance.element.closest('.custom-modal')) {
        mainContent.style.paddingBottom = '400px'; 
        setTimeout(() => {
            const rect = instance.element.getBoundingClientRect(); const spaceBelow = window.innerHeight - rect.bottom;
            if (spaceBelow < 350) { const scrollAmount = 350 - spaceBelow; mainContent.scrollBy({ top: scrollAmount, behavior: 'smooth' }); }
        }, 50);
    }
  },
  onClose: function(selectedDates, dateStr, instance) {
    const mainContent = document.querySelector('.main-content');
    if (mainContent && !instance.element.closest('.custom-modal')) { mainContent.style.paddingBottom = '100px'; }
  }
};

// ==========================================
// 🚀 初始化流水记录模块
// ==========================================
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

    // 🌟 外科手术 1：同步新标签到数据库
    if (tagSelect.value === 'NEW') await dbExecute("INSERT OR IGNORE INTO tags (name, is_active) VALUES (?, ?)", [finalTag, true]);
    if (finalSub && subSelect.value === 'NEW') await dbExecute("INSERT INTO sub_tags (main_tag, name) VALUES (?, ?)", [finalTag, finalSub]);

    let finalDateStr, finalTimeStr;
    if (useCurrentTimeCb.checked) {
      finalDateStr = getTodayString(); const now = new Date();
      finalTimeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    } else {
      const dtValue = manualDatetimeInput.value; if (!dtValue) { alert("⚠️ 请选择明确的时间！"); return; }
      [finalDateStr, finalTimeStr] = dtValue.split(' ');
    }

    const detailInput = document.getElementById('log-detail-input').value.trim();
    const isOverdue = document.querySelector('input[name="log-status"]:checked').value === "overdue";
    const deadlineVal = hasDeadlineCb.checked ? deadlineInput.value : "";

    // 🌟 外科手术 2：向 SQLite 插入一条新流水
    await dbExecute(
        "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [finalDateStr, finalTimeStr, taskInput, finalTag, finalSub, detailInput, "", "", deadlineVal, isOverdue]
    );

    await loadData(); // 从底层刷新
    
    document.getElementById('log-task-input').value = ""; document.getElementById('log-detail-input').value = "";
    tagSelect.value = finalTag; tagNewInput.style.display = 'none'; window.renderLogSubTags(); subSelect.value = finalSub; 
    if(hasDeadlineCb.checked) { hasDeadlineCb.checked = false; deadlineInput.style.display = 'none'; fpDeadline.clear(); }
    renderHistoryList(); 
    if(window.renderTodoTags) window.renderTodoTags();
  });
}

// ==========================================
// 📖 渲染今日流水列表与操作事件
// ==========================================
export function renderHistoryList() {
  const container = document.getElementById('history-list-container'); if(!container) return; container.innerHTML = ""; 
  const todayStr = getTodayString(); const todayLogs = appData.logs[todayStr] || [];

  if (todayLogs.length === 0) { container.innerHTML = "<p style='color: gray; font-size: 0.9em;'>今天还没有记录任何事情哦~ 赶紧在顶部记一笔吧！</p>"; return; }

  todayLogs.forEach((log) => {
    const isCompletedTodo = !!log.linked_todo || log.text.includes("完成待办"); 
    const themeClass = isCompletedTodo ? "border-success" : "border-primary";
    const detailText = log.detail ? log.detail : "(未填写详细说明)";
    
    let displayText = log.text;
    if (displayText.startsWith("完成待办: ")) displayText = displayText.replace("完成待办: ", "").trim();

    let todoBadgeHtml = isCompletedTodo ? `<span style="background: rgba(var(--color-success-rgb), 0.15); color: var(--color-success); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-right: 8px; border: 1px solid rgba(var(--color-success-rgb), 0.3);">待</span>` : "";
    let deadlineHtml = log.deadline ? `<span class="todo-deadline" style="margin-left: 10px; font-weight: normal; font-size: 12px; color: var(--color-danger); background: rgba(var(--color-danger-rgb), 0.15); border: 1px solid rgba(var(--color-danger-rgb), 0.3); padding: 2px 6px; border-radius: 4px;">📅 截至 ${log.deadline}</span>` : "";
    let subTagHtml = log.sub_tag ? `<span style="background: var(--overlay-light); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px;">📁 ${log.sub_tag}</span>` : "";
    let detailBadge = log.detail ? `<span style="background: var(--overlay-light); color: var(--text-muted); border: 1px solid var(--border-medium); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">详</span>` : "";
    let remarkBadge = log.remark ? `<span style="background: rgba(var(--color-warning-rgb), 0.15); color: var(--color-warning); border: 1px solid rgba(var(--color-warning-rgb), 0.3); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">补</span>` : "";

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
                    <div class="dropdown-item add-remark-log-btn" data-id="${log.id}">💬 添加/修改补述</div>
                    <div class="dropdown-item edit-log-btn" data-id="${log.id}">✏️ 编辑</div>
                    <div class="dropdown-item danger del-log-btn" data-id="${log.id}">🗑️ 删除记录</div>
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

  // ✏️ 编辑流水与强大的无感跨天移动
  document.querySelectorAll('.edit-log-btn').forEach(btn => {
      btn.onclick = (e) => {
          closeMenus();
          const id = parseInt(e.target.getAttribute('data-id')); 
          const log = todayLogs.find(l => l.id === id);
          const currentTheme = (appData.settings && appData.settings.theme === 'light') ? 'theme-light-modal' : 'theme-dark-modal';

          openUniversalEditModal("✏️ 编辑流水与标签", log, {
              type: 'log',           
              dateStr: todayStr,     
              themeClass: currentTheme,
              
              // ⏪ 撤销已完成待办
              onRestore: async (cleanText) => {
                  const taskName = log.linked_todo || cleanText;
                  let existingTodo = appData.todos.find(t => t.task === taskName && t.done);
                  
                  if (existingTodo) {
                      await dbExecute("UPDATE todos SET done=?, completed_at=? WHERE id=?", [false, "", existingTodo.id]);
                  } else {
                      await dbExecute("INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [taskName, false, log.tag, log.sub_tag, log.detail, log.remark, log.deadline, ""]);
                  }
                  // 从流水中彻底抹除
                  await dbExecute("DELETE FROM logs WHERE id=?", [log.id]);

                  await loadData();
                  document.getElementById('global-modal-overlay').style.display = 'none';
                  renderHistoryList();
                  import('./todo.js').then(m => m.renderTodoList()); // 同步右侧待办
              },
              
              // 💾 保存流水修改 (极其优雅的 1 句 SQL 解决跨天移动难题)
              onSave: async (updatedData) => {
                  await dbExecute(
                      "UPDATE logs SET date=?, time=?, text=?, detail=?, deadline=?, tag=?, sub_tag=? WHERE id=?",
                      [updatedData.newDateStr, updatedData.newTimeStr, updatedData.text, updatedData.detail, updatedData.deadline, updatedData.tag, updatedData.sub_tag, log.id]
                  );
                  await loadData(); 
                  renderHistoryList();
                  if(window.renderLogTags) window.renderLogTags();
                  return true; 
              }
          });
      };
  });

  // 💬 修改补述
  document.querySelectorAll('.add-remark-log-btn').forEach(btn => {
    btn.onclick = (e) => {
        closeMenus();
        const id = parseInt(e.target.getAttribute('data-id')); 
        const log = todayLogs.find(l => l.id === id);
        
        window.showModal("💬 流水记录补述与复盘", `
            <div class="form-group">
                <label class="field-label" style="color:var(--color-primary);">💡 补充细节、灵感、不完美的地方或复盘：</label>
                <textarea id="m-log-remark" class="hero-textarea" style="margin-top:10px; min-height: 120px;">${log.remark || ''}</textarea>
            </div>
        `, body => body.querySelector('#m-log-remark').focus(), async (body) => {
            const remark = body.querySelector('#m-log-remark').value.trim();
            await dbExecute("UPDATE logs SET remark=? WHERE id=?", [remark, log.id]);
            await loadData(); renderHistoryList();
        });
    };
  });

  // 🗑️ 删除流水
  document.querySelectorAll('.del-log-btn').forEach(btn => {
    btn.onclick = async (e) => {
      closeMenus();
      const id = parseInt(e.target.getAttribute('data-id'));
      
      window.showModal("⚠️ 删除流水记录", `<div style="font-size: 15px; color: var(--text-main);">确定要永久删除这条流水记录吗？操作不可逆。</div>`, null, async () => {
          await dbExecute("DELETE FROM logs WHERE id=?", [id]);
          await loadData(); renderHistoryList();
      }, { danger: true });
    };
  });
}