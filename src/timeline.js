import { appData, dbExecute, loadData } from './data.js';
import { openUniversalEditModal } from './formUtils.js';
import { appendRemarkEntry, escapeHtml, insertTextareaNewline, textWithLineBreaks } from './htmlUtils.js';

const mainFilter = document.getElementById('timeline-main-filter');
const subFilter = document.getElementById('timeline-sub-filter');
const timelineContainer = document.getElementById('timeline-container');

export function initTimelineModule() {
  mainFilter.innerHTML = '<option value="all">🌐 (全部主分类)</option>';
  appData.tags.forEach(tag => {
    const safeTag = escapeHtml(tag);
    mainFilter.innerHTML += `<option value="${safeTag}">${safeTag}</option>`;
  });

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

  Array.from(subTags).sort().forEach(sub => {
    const safeSub = escapeHtml(sub);
    subFilter.innerHTML += `<option value="${safeSub}">${safeSub}</option>`;
  });
}

function getDateString(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getTodoEnd(todo) {
  return todo.end_at || todo.deadline || "";
}

function matchesFilters(item, selectedMain, selectedSub) {
  const matchMain = selectedMain === "all" || item.tag === selectedMain;
  const matchSub = selectedSub === "all" || item.sub_tag === selectedSub;
  return matchMain && matchSub;
}

function buildTodoMini(todo) {
  const safeTag = escapeHtml(todo.tag);
  const safeTask = escapeHtml(todo.task);
  const safeSub = escapeHtml(todo.sub_tag);
  const safeStart = escapeHtml(todo.start_at || "");
  const safeEnd = escapeHtml(getTodoEnd(todo));
  const subHtml = todo.sub_tag ? `<span class="plan-chip">📁 ${safeSub}</span>` : "";
  const timeHtml = safeStart || safeEnd ? `<span class="plan-time">${safeStart && safeEnd ? `${safeStart} 至 ${safeEnd}` : safeEnd}</span>` : "";

  return `
    <div class="plan-row">
      <span class="plan-dot"></span>
      <div class="plan-main">
        <div><b>[${safeTag}]</b> ${safeTask} ${subHtml}</div>
        ${timeHtml}
      </div>
    </div>
  `;
}

function buildLogMini(log) {
  const safeTag = escapeHtml(log.tag);
  const safeText = escapeHtml((log.text || "").replace("完成待办: ", ""));
  const safeTime = escapeHtml(log.time || "").substring(0, 5);
  const safeSub = escapeHtml(log.sub_tag);
  const subHtml = log.sub_tag ? `<span class="plan-chip">📁 ${safeSub}</span>` : "";

  return `
    <div class="plan-row">
      <span class="plan-time-badge">${safeTime || "--:--"}</span>
      <div class="plan-main"><b>[${safeTag}]</b> ${safeText} ${subHtml}</div>
    </div>
  `;
}

function renderPlanSection(title, subtitle, items, emptyText, type) {
  const content = items.length > 0
    ? items.map(item => type === 'log' ? buildLogMini(item) : buildTodoMini(item)).join('')
    : `<div class="plan-empty">${emptyText}</div>`;

  return `
    <section class="plan-card">
      <div class="plan-card-head">
        <strong>${title}</strong>
        <span>${subtitle}</span>
      </div>
      <div class="plan-list">${content}</div>
    </section>
  `;
}

function renderTimelineFocus(selectedMain, selectedSub) {
  const yesterday = getDateString(-1);
  const today = getDateString(0);
  const tomorrow = getDateString(1);
  const pendingTodos = appData.todos.filter(todo => !todo.done && matchesFilters(todo, selectedMain, selectedSub));

  const isDueOn = (todo, dateStr) => {
    const start = (todo.start_at || "").substring(0, 10);
    const end = getTodoEnd(todo).substring(0, 10);
    return start === dateStr || end === dateStr;
  };

  const todayTodos = pendingTodos.filter(todo => isDueOn(todo, today));
  const tomorrowTodos = pendingTodos.filter(todo => isDueOn(todo, tomorrow));
  const yesterdayLogs = (appData.logs[yesterday] || []).filter(log => matchesFilters(log, selectedMain, selectedSub));

  return `
    <div class="timeline-focus-grid">
      ${renderPlanSection("今天应该做什么", today, todayTodos, "今天没有明确计划的待办。", "todo")}
      ${renderPlanSection("明天提前看一眼", tomorrow, tomorrowTodos, "明天暂时没有安排。", "todo")}
      ${renderPlanSection("昨天做了什么", yesterday, yesterdayLogs, "昨天还没有流水记录。", "log")}
    </div>
  `;
}

async function appendLogRemark(id, dateStr, note, entryType = '') {
  const log = appData.logs[dateStr]?.find(item => item.id === id);
  if (!log || !note.trim()) return;

  await dbExecute("UPDATE logs SET remark=? WHERE id=?", [appendRemarkEntry(log.remark || "", note.trim(), new Date(), entryType), id]);
  await loadData();
  renderTimeline();
  import('./log.js').then(m => m.renderHistoryList());
}

export function renderTimeline() {
  timelineContainer.innerHTML = ""; 
  const selectedMain = mainFilter.value; const selectedSub = subFilter.value;
  const sortedDates = Object.keys(appData.logs).sort((a, b) => b.localeCompare(a));
  
  let totalHtml = `${renderTimelineFocus(selectedMain, selectedSub)}<div class="timeline-container timeline-history">`;
  let hasData = false;

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
      const detailText = log.detail ? textWithLineBreaks(log.detail) : "(未填写详细说明)";
      const safeDate = escapeHtml(dateStr);
      const safeTime = escapeHtml(log.time || "");
      const safeTag = escapeHtml(log.tag);
      const safeSubTag = escapeHtml(log.sub_tag);
      const safeDeadline = escapeHtml(log.deadline);
      
      let subTagHtml = log.sub_tag ? `<span style="background: var(--overlay-light); padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-left: 10px;">📁 ${safeSubTag}</span>` : "";
      let deadlineHtml = log.deadline ? `<span style="margin-left: 10px; font-weight: normal; font-size: 12px; color: var(--color-primary); background: rgba(var(--color-primary-rgb), 0.15); border: 1px solid rgba(var(--color-primary-rgb), 0.5); padding: 2px 6px; border-radius: 4px;">📅 截至 ${safeDeadline}</span>` : "";
      const detailBadge = log.detail ? `<span style="background: var(--overlay-light); color: var(--text-muted); border: 1px solid var(--border-medium); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">📝 详情</span>` : "";
      const remarkBadge = log.remark ? `<span style="background: rgba(var(--color-warning-rgb), 0.15); color: var(--color-warning); border: 1px solid rgba(var(--color-warning-rgb), 0.3); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">💡 有补述</span>` : "";
      let displayText = log.text; if (displayText.startsWith("完成待办: ")) displayText = displayText.replace("完成待办: ", "").trim();
      const safeDisplayText = escapeHtml(displayText);

      logsHtml += `
        <details class="glass-accordion ${themeClass}">
          <summary class="log-summary">
            <span class="log-time">${safeTime.substring(0, 5)}</span>
            <span class="log-text"><b>[${safeTag}]</b> ${safeDisplayText} ${subTagHtml} ${deadlineHtml} ${detailBadge} ${remarkBadge}</span>
          </summary>
          <div class="expanded-content">
            <div style="margin-bottom: 8px; font-size: 12px; color: gray;">⏱️ 记录于: ${safeDate} ${safeTime}</div>
            <div style="margin-bottom: 15px;">${detailText}</div>
            ${log.remark ? `<div class="item-remark">${textWithLineBreaks(log.remark)}</div>` : ""}
            <div class="quick-note" data-kind="timeline-log" data-date="${safeDate}" data-id="${log.id}">
              <select class="quick-note-type">
                <option value="过程">过程</option>
                <option value="问题">问题</option>
                <option value="想法">想法</option>
                <option value="结论">结论</option>
                <option value="复盘">复盘</option>
                <option value="资料">资料</option>
              </select>
              <input type="text" class="quick-note-input" placeholder="追加一条记录，回车保存..." />
              <button class="quick-note-btn" type="button">追加</button>
            </div>
            
            <div style="display: flex; gap: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px; justify-content: flex-end;">
              <div class="dropdown-wrapper" onclick="event.preventDefault(); event.stopPropagation();">
                  <button class="dots-btn icon-btn" style="padding: 4px 10px; margin: 0; font-size: 13px;" onclick="
                      const menu = this.nextElementSibling; const isShow = menu.classList.contains('show');
                      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
                      document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
                      if (!isShow) { menu.classList.add('show'); const card = this.closest('.glass-accordion'); if(card) card.classList.add('elevated-zindex'); }
                  ">⋮ 操作</button>
                  <div class="dropdown-menu">
                      <div class="dropdown-item add-remark-tl-log-btn" data-date="${safeDate}" data-id="${log.id}">💬 添加/修改补述</div>
                      <div class="dropdown-item edit-tl-log-btn" data-date="${safeDate}" data-id="${log.id}">✏️ 编辑记录</div>
                      <div class="dropdown-item danger del-tl-log-btn" data-date="${safeDate}" data-id="${log.id}">🗑️ 删除记录</div>
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
        <details style="margin-left: 10px;">
          <summary class="timeline-date" style="cursor: pointer; list-style: none; outline: none; display: flex; align-items: center; gap: 10px;">
            <span class="date-arrow" style="font-size: 12px; color: var(--text-muted); opacity: 0.7; display: inline-block;">▶</span>
            🗓️ ${escapeHtml(dateStr)} <span style="font-size: 13px; font-weight: normal; color: #94A3B8;">(共 ${filteredLogs.length} 项)</span>
          </summary>
          <div style="margin-top: 15px;">${logsHtml}</div>
        </details>
      </div>
    `;
  });

  totalHtml += '</div>';

  if (!hasData) {
    timelineContainer.innerHTML = `${renderTimelineFocus(selectedMain, selectedSub)}<div class='empty-state'><strong>没有匹配的历史记录</strong><span>调整筛选条件，或先在工作台添加流水记录。</span></div>`;
  } else {
    timelineContainer.innerHTML = totalHtml;
    
    document.querySelectorAll('.timeline-date').forEach(summary => {
      summary.addEventListener('click', function() {
        const arrow = this.querySelector('.date-arrow');
        arrow.style.transform = this.parentElement.hasAttribute('open') ? 'rotate(-90deg)' : 'rotate(0deg)';
        arrow.style.transition = 'transform 0.2s ease';
      });
    });

    document.querySelectorAll('.quick-note').forEach(box => {
      const input = box.querySelector('.quick-note-input');
      const typeSelect = box.querySelector('.quick-note-type');
      const btn = box.querySelector('.quick-note-btn');
      const save = async () => {
        const note = input.value.trim();
        if (!note) return;
        btn.disabled = true;
        await appendLogRemark(parseInt(box.dataset.id), box.dataset.date, note, typeSelect.value);
      };
      btn.addEventListener('click', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.altKey) {
          e.preventDefault();
          insertTextareaNewline(input);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          save();
        }
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
            <textarea id="m-tl-log-remark" class="hero-textarea" style="margin-top:10px; min-height: 120px;">${escapeHtml(log.remark)}</textarea></div>
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
