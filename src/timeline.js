import { appData, saveData } from './data.js';
import { openUniversalEditModal } from './formUtils.js';

// 获取 DOM 元素
const mainFilter = document.getElementById('timeline-main-filter');
const subFilter = document.getElementById('timeline-sub-filter');
const timelineContainer = document.getElementById('timeline-container');

// 初始化时间轴模块
export function initTimelineModule() {
  // 1. 初始化主标签下拉框 (加上一个 "全部" 选项)
  mainFilter.innerHTML = '<option value="all">🌐 (全部主分类)</option>';
  appData.tags.forEach(tag => {
    mainFilter.innerHTML += `<option value="${tag}">${tag}</option>`;
  });

  // 2. 监听主标签的切换：如果主标签变了，动态更新子项目的下拉框
  mainFilter.addEventListener('change', () => {
    updateSubFilters();
    renderTimeline(); // 重新渲染
  });

  // 3. 监听子项目的切换：直接重新渲染
  subFilter.addEventListener('change', renderTimeline);

  // 初始加载一次
  updateSubFilters();
  renderTimeline();
}

// 根据当前选中的主标签，动态提取出用过的“子项目”
function updateSubFilters() {
  const selectedMain = mainFilter.value;
  subFilter.innerHTML = '<option value="all">📁 (所有子项目)</option>';
  
  if (selectedMain === "all") return; // 如果选了全部主标签，就不筛选子项目

  // 遍历所有日志，提取独一无二的 sub_tag
  const subTags = new Set();
  Object.values(appData.logs).forEach(dayLogs => {
    dayLogs.forEach(log => {
      if (log.tag === selectedMain && log.sub_tag) {
        subTags.add(log.sub_tag);
      }
    });
  });

  // 注入到下拉框
  Array.from(subTags).sort().forEach(sub => {
    subFilter.innerHTML += `<option value="${sub}">${sub}</option>`;
  });
}

// 核心渲染引擎：生成带圆点的时间轴 HTML
export function renderTimeline() {
  timelineContainer.innerHTML = ""; // 清空画板

  const selectedMain = mainFilter.value;
  const selectedSub = subFilter.value;

  // 获取所有日期并降序排列 (从新到旧)
  const sortedDates = Object.keys(appData.logs).sort((a, b) => b.localeCompare(a));
  
  let totalHtml = '<div class="timeline-container">';
  let hasData = false;

  // 按日期遍历
  sortedDates.forEach(dateStr => {
    const dayLogs = appData.logs[dateStr];
    
    // 根据筛选条件过滤流水
    const filteredLogs = dayLogs.filter(log => {
      const matchMain = (selectedMain === "all" || log.tag === selectedMain);
      const matchSub = (selectedSub === "all" || log.sub_tag === selectedSub);
      return matchMain && matchSub;
    });

    if (filteredLogs.length === 0) return; // 如果没有符合条件的，跳过

    hasData = true;
    let logsHtml = "";

    // 拼装符合条件的日志手风琴卡片
    filteredLogs.forEach(log => {
      // 获取该项在当天的真实索引，防止删除/编辑时错位
      const logIndex = dayLogs.indexOf(log); 
      
      const isCompletedTodo = !!log.linked_todo || log.text.includes("完成待办");
      const themeClass = isCompletedTodo ? "border-success" : "border-primary";
      const detailText = log.detail ? log.detail : "(未填写详细说明)";
      
      let subTagHtml = log.sub_tag ? `<span style="background: var(--overlay-light); padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-left: 10px;">📁 ${log.sub_tag}</span>` : "";
      let deadlineHtml = log.deadline ? `<span style="margin-left: 10px; font-weight: normal; font-size: 12px; color: var(--color-primary); background: rgba(var(--color-primary-rgb), 0.15); border: 1px solid rgba(var(--color-primary-rgb), 0.5); padding: 2px 6px; border-radius: 4px;">📅 截至 ${log.deadline}</span>` : "";
      const detailBadge = log.detail ? `<span style="background: var(--overlay-light); color: var(--text-muted); border: 1px solid var(--border-medium); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">📝 详情</span>` : "";
      const remarkBadge = log.remark ? `<span style="background: rgba(var(--color-warning-rgb), 0.15); color: var(--color-warning); border: 1px solid rgba(var(--color-warning-rgb), 0.3); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">💡 有补述</span>` : "";
      let displayText = log.text;
      if (displayText.startsWith("完成待办: ")) displayText = displayText.replace("完成待办: ", "").trim();

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
                      <div class="dropdown-item add-remark-tl-log-btn" data-date="${dateStr}" data-index="${logIndex}">💬 添加/修改补述</div>
                      <div class="dropdown-item edit-tl-log-btn" data-date="${dateStr}" data-index="${logIndex}">✏️ 编辑记录</div>
                      <div class="dropdown-item danger del-tl-log-btn" data-date="${dateStr}" data-index="${logIndex}">🗑️ 删除记录</div>
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
            🗓️ ${dateStr} 
            <span style="font-size: 13px; font-weight: normal; color: #94A3B8;">(共 ${filteredLogs.length} 项)</span>
          </summary>
          <div style="margin-top: 15px;">
            ${logsHtml}
          </div>
        </details>
      </div>
    `;
  });

  totalHtml += '</div>';

  if (!hasData) {
    timelineContainer.innerHTML = "<p style='color: gray;'>📭 当前筛选条件下暂无记录。</p>";
  } else {
    timelineContainer.innerHTML = totalHtml;
    
    // 折叠箭头动画绑定
    document.querySelectorAll('.timeline-date').forEach(summary => {
      summary.addEventListener('click', function() {
        const arrow = this.querySelector('.date-arrow');
        const isOpen = this.parentElement.hasAttribute('open');
        arrow.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
        arrow.style.transition = 'transform 0.2s ease';
      });
    });

    // 事件绑定区域
    const closeMenus = () => {
      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
      document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
    };

    // 绑定“时间轴补述”事件
    document.querySelectorAll('.add-remark-tl-log-btn').forEach(btn => {
      btn.onclick = (e) => {
        closeMenus();
        const dateStr = btn.getAttribute('data-date');
        const idx = btn.getAttribute('data-index');
        const dayLogs = appData.logs[dateStr];
        const log = dayLogs[idx];
        
        window.showModal(`💬 时间轴记录补述 (${dateStr})`, `
            <div class="form-group">
                <label class="field-label" style="color:var(--color-primary);">💡 补充细节、灵感或跨期复盘：</label>
                <textarea id="m-tl-log-remark" class="hero-textarea" style="margin-top:10px; min-height: 120px;">${log.remark || ''}</textarea>
            </div>
        `, body => body.querySelector('#m-tl-log-remark').focus(), async (body) => {
            log.remark = body.querySelector('#m-tl-log-remark').value.trim();
            await saveData(); 
            renderTimeline();
            
            // 同步刷新主界面的流水列表，防止两边数据不同步
            import('./log.js').then(m => m.renderHistoryList());
        });
      };
    });

    // ✏️ 绑定编辑事件
    document.querySelectorAll('.edit-tl-log-btn').forEach(btn => {
        btn.onclick = (e) => {
            closeMenus();
            const dateStr = btn.getAttribute('data-date'); // 时间轴上的具体日期
            const idx = btn.getAttribute('data-index');
            const dayLogs = appData.logs[dateStr];         // 取出那一天的数组
            const log = dayLogs[idx];
            
            const currentTheme = (appData.settings && appData.settings.theme === 'light') ? 'theme-light-modal' : 'theme-dark-modal';

            openUniversalEditModal(`✏️ 编辑时间轴记录 (${dateStr})`, log, {
                type: 'log',
                dateStr: dateStr,
                themeClass: currentTheme,
                
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
                    dayLogs.splice(idx, 1);
                    if (dayLogs.length === 0) delete appData.logs[dateStr];

                    await saveData();
                    document.getElementById('global-modal-overlay').style.display = 'none';
                    renderTimeline();
                    // 同步刷新主页视图
                    import('./log.js').then(m => m.renderHistoryList());
                    import('./todo.js').then(m => m.renderTodoList());
                },

                onSave: async (updatedData) => {
                    log.text = updatedData.text;
                    log.detail = updatedData.detail;
                    log.deadline = updatedData.deadline;
                    log.tag = updatedData.tag;
                    log.sub_tag = updatedData.sub_tag;

                    // 处理跨天修改
                    if (updatedData.newDateStr !== dateStr) {
                        log.time = updatedData.newTimeStr;
                        dayLogs.splice(idx, 1);
                        if (dayLogs.length === 0) delete appData.logs[dateStr];
                        
                        if (!appData.logs[updatedData.newDateStr]) appData.logs[updatedData.newDateStr] = [];
                        appData.logs[updatedData.newDateStr].push(log);
                        appData.logs[updatedData.newDateStr].sort((a,b) => b.time.localeCompare(a.time));
                    } else {
                        log.time = updatedData.newTimeStr;
                        dayLogs.sort((a,b) => b.time.localeCompare(a.time));
                    }

                    await saveData(); 
                    renderTimeline();
                    // 强制同步主界面流水列表
                    import('./log.js').then(m => m.renderHistoryList());
                    if(window.renderLogTags) window.renderLogTags();
                    return true;
                }
            });
        };
    });

    // 🗑️ 绑定删除事件
    document.querySelectorAll('.del-tl-log-btn').forEach(btn => {
      btn.onclick = async (e) => {
        closeMenus();
        const dateStr = btn.getAttribute('data-date');
        const idx = btn.getAttribute('data-index');
        const dayLogs = appData.logs[dateStr];
        
        window.showModal("⚠️ 删除时间轴记录", `<div style="font-size: 15px; color: var(--text-main);">确定要永久删除这条时间轴记录吗？操作不可逆。</div>`, null, async () => {
            dayLogs.splice(idx, 1); 
            if (dayLogs.length === 0) delete appData.logs[dateStr];
            
            await saveData(); 
            renderTimeline(); 
            
            // 同步刷新主界面的 Log List
            import('./log.js').then(m => m.renderHistoryList());
        }, { danger: true });
      };
    });

  }
}