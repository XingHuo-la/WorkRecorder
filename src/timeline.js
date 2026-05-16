import { appData, dbExecute, loadData } from './data.js';
import { openUniversalEditModal } from './formUtils.js';

const mainFilter = document.getElementById('timeline-main-filter');
const subFilter = document.getElementById('timeline-sub-filter');
const timelineContainer = document.getElementById('timeline-container');

export function initTimelineModule() {
  mainFilter.innerHTML = '<option value="all">🌐 (全部主分类)</option>';
  appData.tags.forEach(tag => { mainFilter.innerHTML += `<option value="${tag}">${tag}</option>`; });

  mainFilter.addEventListener('change', () => { updateSubFilters(); renderTimeline(); });
  subFilter.addEventListener('change', renderTimeline);
  updateSubFilters(); renderTimeline();
}

function updateSubFilters() {
  const selectedMain = mainFilter.value;
  subFilter.innerHTML = '<option value="all">📁 (所有子项目)</option>';
  if (selectedMain === "all") return; 

  const subTags = new Set();
  Object.values(appData.logs).forEach(dayLogs => {
    dayLogs.forEach(log => { if (log.tag === selectedMain && log.sub_tag) subTags.add(log.sub_tag); });
  });

  Array.from(subTags).sort().forEach(sub => { subFilter.innerHTML += `<option value="${sub}">${sub}</option>`; });
}

export function renderTimeline() {
  timelineContainer.innerHTML = ""; 
  const selectedMain = mainFilter.value; const selectedSub = subFilter.value;
  const sortedDates = Object.keys(appData.logs).sort((a, b) => b.localeCompare(a));
  
  let totalHtml = '<div class="timeline-container">'; let hasData = false;

  sortedDates.forEach(dateStr => {
    const dayLogs = appData.logs[dateStr];
    const filteredLogs = dayLogs.filter(log => {
      const matchMain = (selectedMain === "all" || log.tag === selectedMain);
      const matchSub = (selectedSub === "all" || log.sub_tag === selectedSub);
      return matchMain && matchSub;
    });

    if (filteredLogs.length === 0) return; 

    hasData = true; let logsHtml = "";

    filteredLogs.forEach(log => {
      const isCompletedTodo = !!log.linked_todo || log.text.includes("完成待办");
      const themeClass = isCompletedTodo ? "border-success" : "border-primary";
      const detailText = log.detail ? log.detail : "(未填写详细说明)";
      
      let subTagHtml = log.sub_tag ? `<span style="background: var(--overlay-light); padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-left: 10px;">📁 ${log.sub_tag}</span>` : "";
      let deadlineHtml = log.deadline ? `<span style="margin-left: 10px; font-weight: normal; font-size: 12px; color: var(--color-primary); background: rgba(var(--color-primary-rgb), 0.15); border: 1px solid rgba(var(--color-primary-rgb), 0.5); padding: 2px 6px; border-radius: 4px;">📅 截至 ${log.deadline}</span>` : "";
      const detailBadge = log.detail ? `<span style="background: var(--overlay-light); color: var(--text-muted); border: 1px solid var(--border-medium); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">📝 详情</span>` : "";
      const remarkBadge = log.remark ? `<span style="background: rgba(var(--color-warning-rgb), 0.15); color: var(--color-warning); border: 1px solid rgba(var(--color-warning-rgb), 0.3); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">💡 有补述</span>` : "";
      let displayText = log.text; if (displayText.startsWith("完成待办: ")) displayText = displayText.replace("完成待办: ", "").trim();

      logsHtml += `
        <details class="glass-accordion ${themeClass}">
          <summary class="log-summary">
            <span class="log-time">${log.time.substring(0, 5)}</span>
            <span class="log-text"><b>[${log.tag}]</b> ${displayText} ${subTagHtml} ${deadlineHtml} ${detailBadge} ${remarkBadge}</span>
          </summary>
          <div class="expanded-content">
            <div style="margin-bottom: 8px; font-size: 12px; color: gray;">⏱️ 记录于: ${dateStr} ${log.time}</div>
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
                      <div class="dropdown-item add-remark-tl-log-btn" data-date="${dateStr}" data-id="${log.id}">💬 添加/修改补述</div>
                      <div class="dropdown-item edit-tl-log-btn" data-date="${dateStr}" data-id="${log.id}">✏️ 编辑记录</div>
                      <div class="dropdown-item danger del-tl-log-btn" data-date="${dateStr}" data-id="${log.id}">🗑️ 删除记录</div>
                  </div>
              </div>
            </div>
          </div>
        </details>
      `;
    });

    totalHtml += `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        <details open style="margin-left: 10px;">
          <summary class="timeline-date" style="cursor: pointer; list-style: none; outline: none; display: flex; align-items: center; gap: 10px;">
            <span class="date-arrow" style="font-size: 12px; color: var(--text-muted); opacity: 0.7; display: inline-block;">▼</span>
            🗓️ ${dateStr} <span style="font-size: 13px; font-weight: normal; color: #94A3B8;">(共 ${filteredLogs.length} 项)</span>
          </summary>
          <div style="margin-top: 15px;">${logsHtml}</div>
        </details>
      </div>
    `;
  });

  totalHtml += '</div>';

  if (!hasData) {
    timelineContainer.innerHTML = "<p style='color: gray;'>📭 当前筛选条件下暂无记录。</p>";
  } else {
    timelineContainer.innerHTML = totalHtml;
    
    document.querySelectorAll('.timeline-date').forEach(summary => {
      summary.addEventListener('click', function() {
        const arrow = this.querySelector('.date-arrow');
        arrow.style.transform = this.parentElement.hasAttribute('open') ? 'rotate(-90deg)' : 'rotate(0deg)';
        arrow.style.transition = 'transform 0.2s ease';
      });
    });

    const closeMenus = () => {
      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
      document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
    };

    // 🌟 外科手术：修改补述
    document.querySelectorAll('.add-remark-tl-log-btn').forEach(btn => {
      btn.onclick = (e) => {
        closeMenus();
        const dateStr = btn.getAttribute('data-date');
        const id = parseInt(btn.getAttribute('data-id'));
        const log = appData.logs[dateStr].find(l => l.id === id);
        
        window.showModal(`💬 时间轴记录补述 (${dateStr})`, `
            <div class="form-group"><label class="field-label" style="color:var(--color-primary);">💡 补充细节、灵感或跨期复盘：</label>
            <textarea id="m-tl-log-remark" class="hero-textarea" style="margin-top:10px; min-height: 120px;">${log.remark || ''}</textarea></div>
        `, body => body.querySelector('#m-tl-log-remark').focus(), async (body) => {
            const remark = body.querySelector('#m-tl-log-remark').value.trim();
            await dbExecute("UPDATE logs SET remark=? WHERE id=?", [remark, id]);
            await loadData(); renderTimeline();
            import('./log.js').then(m => m.renderHistoryList());
        });
      };
    });

    // 🌟 外科手术：编辑时间轴流水
    document.querySelectorAll('.edit-tl-log-btn').forEach(btn => {
        btn.onclick = (e) => {
            closeMenus();
            const dateStr = btn.getAttribute('data-date');
            const id = parseInt(btn.getAttribute('data-id'));
            const log = appData.logs[dateStr].find(l => l.id === id);
            const currentTheme = (appData.settings && appData.settings.theme === 'light') ? 'theme-light-modal' : 'theme-dark-modal';

            openUniversalEditModal(`✏️ 编辑时间轴记录 (${dateStr})`, log, {
                type: 'log', dateStr: dateStr, themeClass: currentTheme,
                onRestore: async (cleanText) => {
                    const taskName = log.linked_todo || cleanText;
                    let existingTodo = appData.todos.find(t => t.task === taskName && t.done);
                    if (existingTodo) {
                        await dbExecute("UPDATE todos SET done=?, completed_at=? WHERE id=?", [false, "", existingTodo.id]);
                    } else {
                        await dbExecute("INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [taskName, false, log.tag, log.sub_tag, log.detail, log.remark, log.deadline, ""]);
                    }
                    await dbExecute("DELETE FROM logs WHERE id=?", [id]);
                    await loadData(); document.getElementById('global-modal-overlay').style.display = 'none';
                    renderTimeline();
                    import('./log.js').then(m => m.renderHistoryList());
                    import('./todo.js').then(m => m.renderTodoList());
                },
                onSave: async (updatedData) => {
                    await dbExecute(
                        "UPDATE logs SET date=?, time=?, text=?, detail=?, deadline=?, tag=?, sub_tag=? WHERE id=?",
                        [updatedData.newDateStr, updatedData.newTimeStr, updatedData.text, updatedData.detail, updatedData.deadline, updatedData.tag, updatedData.sub_tag, id]
                    );
                    await loadData(); renderTimeline();
                    import('./log.js').then(m => m.renderHistoryList());
                    if(window.renderLogTags) window.renderLogTags();
                    return true;
                }
            });
        };
    });

    // 🌟 外科手术：删除记录
    document.querySelectorAll('.del-tl-log-btn').forEach(btn => {
      btn.onclick = async (e) => {
        closeMenus();
        const id = parseInt(btn.getAttribute('data-id'));
        window.showModal("⚠️ 删除时间轴记录", `<div style="font-size: 15px; color: var(--text-main);">确定要永久删除这条时间轴记录吗？操作不可逆。</div>`, null, async () => {
            await dbExecute("DELETE FROM logs WHERE id=?", [id]);
            await loadData(); renderTimeline(); 
            import('./log.js').then(m => m.renderHistoryList());
        }, { danger: true });
      };
    });
  }
}