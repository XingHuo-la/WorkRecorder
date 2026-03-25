import { appData, saveData, getTodayString } from './data.js';
import { renderHistoryList } from './log.js'; 
import { openUniversalEditModal } from './formUtils.js';

export function initTodoModule() {
  const hasDeadlineCb = document.getElementById('todo-has-deadline'); const deadlineInput = document.getElementById('todo-deadline-input');
  const tagSelect = document.getElementById('todo-tag-select'); const tagNewInput = document.getElementById('todo-tag-new');
  const subSelect = document.getElementById('todo-sub-tag-select'); const subNewInput = document.getElementById('todo-sub-tag-new');

  const fpConfig = { ...window.fpGlobalConfig };
  const fpDeadline = flatpickr(deadlineInput, fpConfig);

  hasDeadlineCb.onchange = () => deadlineInput.style.display = hasDeadlineCb.checked ? 'block' : 'none';

  window.renderTodoTags = () => {
    tagSelect.innerHTML = '';
    const activeTags = (appData.settings && appData.settings.active_tags) ? appData.settings.active_tags : appData.tags;
    activeTags.forEach(t => tagSelect.innerHTML += `<option value="${t}">${t}</option>`);
    tagSelect.innerHTML += `<option value="NEW">➕ 新建主分类...</option>`; window.renderTodoSubTags();
  };

  window.renderTodoSubTags = () => {
    const mainTag = tagSelect.value === 'NEW' ? tagNewInput.value.trim() : tagSelect.value;
    subSelect.innerHTML = '<option value="">(无子项目)</option>';
    if (mainTag && appData.sub_tags && appData.sub_tags[mainTag]) appData.sub_tags[mainTag].forEach(t => subSelect.innerHTML += `<option value="${t}">${t}</option>`);
    subSelect.innerHTML += `<option value="NEW">➕ 新建子项目...</option>`;
  };

  tagSelect.addEventListener('change', () => { tagNewInput.style.display = tagSelect.value === 'NEW' ? 'block' : 'none'; if(tagSelect.value === 'NEW') tagNewInput.focus(); subNewInput.style.display = 'none'; window.renderTodoSubTags(); });
  tagNewInput.addEventListener('input', window.renderTodoSubTags);
  subSelect.addEventListener('change', () => { subNewInput.style.display = subSelect.value === 'NEW' ? 'block' : 'none'; if(subSelect.value === 'NEW') subNewInput.focus(); });
  window.renderTodoTags();

  document.getElementById('add-todo-btn').addEventListener('click', async () => {
    const taskInput = document.getElementById('todo-task-input').value.trim();
    if (!taskInput) { alert("⚠️ 待办内容不能为空！"); return; }
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
    window.renderTodoTags(); if(window.renderLogTags) window.renderLogTags();

    // 🌟 注入 remark 初始字段
    const newTodo = { task: taskInput, done: false, tag: finalTag, sub_tag: finalSub, detail: document.getElementById('todo-detail-input').value.trim(), remark: "", deadline: hasDeadlineCb.checked ? deadlineInput.value : "" };
    appData.todos.push(newTodo); await saveData();
    
    document.getElementById('todo-task-input').value = ""; document.getElementById('todo-detail-input').value = "";
    tagSelect.value = finalTag; 
    tagNewInput.style.display = 'none'; 
    window.renderTodoSubTags();
    subSelect.value = finalSub; 

    if(hasDeadlineCb.checked) { hasDeadlineCb.checked = false; deadlineInput.style.display = 'none'; fpDeadline.clear(); }
    renderTodoList(); 
  });
  autoCleanupTodos();
}

export async function renderTodoList() {
  const container = document.getElementById('todo-list-container'); if(!container) return; container.innerHTML = ""; 
  let pendingTodos = appData.todos.filter(t => !t.done); const completedTodos = appData.todos.filter(t => t.done);

  pendingTodos.sort((a, b) => {
    if (a.deadline && b.deadline) return new Date(a.deadline) - new Date(b.deadline);
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return appData.todos.indexOf(a) - appData.todos.indexOf(b);
  });

  if (pendingTodos.length === 0) {
    container.innerHTML = "<p style='color: #4ade80;'>🎉 太棒了！所有待办都已清空。</p>";
  } else {
    pendingTodos.forEach(todo => {
      let subTagHtml = todo.sub_tag ? `<span style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px;">📁 ${todo.sub_tag}</span>` : "";
      
      let deadlineHtml = "";
      if (todo.deadline) {
          const isOverdue = new Date(todo.deadline) < new Date();
          const bg = isOverdue ? 'rgba(var(--color-danger-rgb), 0.15)' : 'rgba(var(--color-primary-rgb), 0.15)';
          const color = isOverdue ? 'var(--color-danger)' : 'var(--color-primary)';
          const borderColor = isOverdue ? 'rgba(var(--color-danger-rgb), 0.5)' : 'rgba(var(--color-primary-rgb), 0.5)';
          deadlineHtml = `<span style="background: ${bg}; color: ${color}; border: 1px solid ${borderColor}; padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 10px; white-space: nowrap;">📅 截至 ${todo.deadline}</span>`;
      }
      
      const idx = appData.todos.indexOf(todo);
      
      // 🌟 提取并渲染补述 HTML 与折叠状态的徽标
      let remarkHtml = todo.remark ? `<div class="item-remark">${todo.remark.replace(/\n/g, '<br>')}</div>` : "";
      
      // 在折叠状态下显示的徽标
      let detailBadge = todo.detail ? `<span style="background: var(--overlay-light); color: var(--text-muted); border: 1px solid var(--border-medium); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">详</span>` : "";
      let remarkBadge = todo.remark ? `<span style="background: rgba(var(--color-warning-rgb), 0.15); color: var(--color-warning); border: 1px solid rgba(var(--color-warning-rgb), 0.3); padding: 2px 6px; border-radius: 4px; font-size: 12px; margin-left: 8px; white-space: nowrap;">补</span>` : "";

      const htmlString = `
        <details class="glass-accordion border-primary" style="margin-bottom: 8px;">
          <summary class="log-summary" style="display:flex; align-items:center;">
            <input type="checkbox" class="todo-cb" data-index="${idx}" style="margin-right:12px; width:18px; height:18px; cursor:pointer;" onclick="event.stopPropagation();">
            <span class="log-text"><b>[${todo.tag}]</b> ${todo.task} ${subTagHtml} ${deadlineHtml} ${detailBadge} ${remarkBadge}</span>
          </summary>
          <div class="expanded-content">
            <div style="margin-bottom: 15px;">${todo.detail ? todo.detail : '(未填写详细说明)'}</div>
            ${remarkHtml}
            <div style="display: flex; gap: 10px; border-top: 1px dashed var(--border-light); padding-top: 10px; justify-content: flex-end;">
              <div class="dropdown-wrapper" onclick="event.preventDefault(); event.stopPropagation();">
                  <button class="dots-btn icon-btn" style="padding: 4px 10px; margin: 0; font-size: 13px;" onclick="
                      const menu = this.nextElementSibling; const isShow = menu.classList.contains('show');
                      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
                      document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
                      if (!isShow) { menu.classList.add('show'); const card = this.closest('.glass-accordion'); if(card) card.classList.add('elevated-zindex'); }
                  ">⋮ 操作</button>
                  <div class="dropdown-menu">
                      <div class="dropdown-item add-remark-todo-btn" data-index="${idx}">💬 添加/修改补述</div>
                      <div class="dropdown-item edit-todo-btn" data-index="${idx}">✏️ 编辑任务</div>
                      <div class="dropdown-item danger del-todo-btn" data-index="${idx}">🗑️ 删除待办</div>
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

    document.querySelectorAll('.todo-cb').forEach(cb => {
      cb.addEventListener('change', async (e) => {
        const idx = e.target.getAttribute('data-index'); const todo = appData.todos[idx];
        todo.done = true; todo.completed_at = getTodayString(); 
        const todayStr = getTodayString(); if (!appData.logs[todayStr]) appData.logs[todayStr] = [];
        
        appData.logs[todayStr].unshift({ 
            time: new Date().toLocaleTimeString('en-US', {hour12: false}), 
            text: todo.task, 
            tag: todo.tag, 
            sub_tag: todo.sub_tag || "", // 🌟 修复：继承子标签
            detail: todo.detail || "",   // 🌟 修复：继承详细说明
            remark: todo.remark || "",   // 🌟 修复：继承补述记录
            linked_todo: todo.task, 
            deadline: todo.deadline 
        }); 
        await saveData(); renderTodoList(); renderHistoryList(); 
      });
    });

    // 🌟 绑定补述按钮弹窗逻辑
    document.querySelectorAll('.add-remark-todo-btn').forEach(btn => {
        btn.onclick = (e) => {
            closeMenus();
            const idx = e.target.getAttribute('data-index'); const todo = appData.todos[idx];
            window.showModal("💬 待办事项补述与复盘", `
                <div class="form-group">
                    <label class="field-label" style="color:var(--color-primary);">💡 记录执行情况、不完美的地方、遗留问题或注意事项：</label>
                    <textarea id="m-todo-remark" class="hero-textarea" style="margin-top:10px; min-height: 120px;">${todo.remark || ''}</textarea>
                </div>
            `, body => body.querySelector('#m-todo-remark').focus(), async (body) => {
                todo.remark = body.querySelector('#m-todo-remark').value.trim();
                await saveData(); renderTodoList();
            });
        };
    });

    document.querySelectorAll('.edit-todo-btn').forEach(btn => {
      btn.onclick = (e) => {
        closeMenus();
        const idx = e.target.getAttribute('data-index'); 
        const todo = appData.todos[idx];

        // 🎨 这里可以读取用户设置的主题
        const currentTheme = (appData.settings && appData.settings.theme === 'light') ? 'theme-light-modal' : 'theme-dark-modal';

        openUniversalEditModal("✏️ 编辑待办事项", todo, {
            type: 'todo',
            themeClass: currentTheme, // 注入主题！
            onSave: async (updatedData) => {
                // 将工厂清洗好的数据直接覆盖给原本的对象
                todo.task = updatedData.text;
                todo.detail = updatedData.detail;
                todo.deadline = updatedData.deadline;
                todo.tag = updatedData.tag;
                todo.sub_tag = updatedData.sub_tag;
                
                await saveData(); 
                renderTodoList(); 
                return true; // 告诉弹窗可以关闭了
            }
        });
      };
    });

    document.querySelectorAll('.del-todo-btn').forEach(btn => {
      btn.onclick = async (e) => {
        closeMenus();
        const idx = e.target.getAttribute('data-index'); const todo = appData.todos[idx];
        window.showModal("⚠️ 确认删除待办", `<div style="font-size: 15px; color: var(--text-main);">确定要永久删除待办 <b>"${todo.task}"</b> 吗？</div>`, null, async () => {
            appData.todos.splice(idx, 1); await saveData(); renderTodoList(); 
        }, { danger: true });
      };
    });
  }

  if (completedTodos.length > 0) {
    const detailsStr = `<details class="glass-accordion border-success" style="margin-top: 30px;"><summary class="log-summary" style="background: rgba(74, 222, 128, 0.05);"><span class="log-text" style="color: #94A3B8;">✅ 查看与清理已完成待办 (${completedTodos.length} 个)</span></summary><div class="expanded-content" id="completed-todos-drawer" style="padding: 15px;"></div></details>`;
    container.insertAdjacentHTML('beforeend', detailsStr);
    const drawer = document.getElementById('completed-todos-drawer');
    
    completedTodos.forEach(todo => {
      // 🌟 调整已完成待办的布局，变为 Flex Column 以容纳补述
      const itemDiv = document.createElement('div'); 
      itemDiv.className = 'todo-item'; 
      itemDiv.style.opacity = '0.6'; 
      itemDiv.style.border = '1px dashed rgba(255,255,255,0.1)';
      itemDiv.style.alignItems = 'flex-start'; // 顶部对齐

      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.style.accentColor = '#4ade80';
      checkbox.style.marginTop = '4px'; 
      checkbox.addEventListener('change', async () => {
        todo.done = false; const completedDate = todo.completed_at || getTodayString(); todo.completed_at = ""; 
        if (appData.logs[completedDate]) {
          appData.logs[completedDate] = appData.logs[completedDate].filter(log => log.linked_todo !== todo.task);
          if (appData.logs[completedDate].length === 0) delete appData.logs[completedDate];
        }
        await saveData(); renderTodoList(); renderHistoryList(); 
      });
      
      const contentCol = document.createElement('div');
      contentCol.style.flex = "1";
      contentCol.style.display = "flex";
      contentCol.style.flexDirection = "column";

      const textSpan = document.createElement('span'); textSpan.className = 'todo-text';
      let subTagHtml = todo.sub_tag ? `<span style="color: gray; font-size: 12px; margin-left: 5px;">📁 ${todo.sub_tag}</span>` : "";
      textSpan.innerHTML = `<del style="color: gray;"><span class="todo-tag">[${todo.tag}]</span> ${todo.task} ${subTagHtml}</del> <span style="font-size:12px;color:#64748B;margin-left:8px;">(完成于 ${todo.completed_at || '未知'})</span>`;
      contentCol.appendChild(textSpan);

      // 🌟 如果存在补述，显示在已完成的文字下方
      if (todo.remark) {
          const rDiv = document.createElement('div');
          rDiv.className = 'item-remark-completed';
          rDiv.innerHTML = `<b>💡 补述：</b>${todo.remark.replace(/\n/g, '<br>')}`;
          contentCol.appendChild(rDiv);
      }
      
      const actionsDiv = document.createElement('div'); actionsDiv.className = 'item-actions';
      actionsDiv.style.marginTop = '0';
      
      // 🌟 在已完成区域增加快捷写补述的按钮
      const remarkBtn = document.createElement('button'); remarkBtn.className = 'icon-btn'; remarkBtn.innerText = '💬'; remarkBtn.title = "添加/修改补述";
      remarkBtn.onclick = () => {
          window.showModal("💬 待办事项补述与复盘", `
              <div class="form-group">
                  <label class="field-label" style="color:var(--color-primary);">💡 记录执行情况、遗留问题或注意事项：</label>
                  <textarea id="m-todo-remark" class="hero-textarea" style="margin-top:10px; min-height: 120px;">${todo.remark || ''}</textarea>
              </div>
          `, body => body.querySelector('#m-todo-remark').focus(), async (body) => {
              todo.remark = body.querySelector('#m-todo-remark').value.trim();
              await saveData(); renderTodoList();
          });
      };

      const delBtn = document.createElement('button'); delBtn.className = 'icon-btn del-btn'; delBtn.innerText = '🗑️';
      delBtn.onclick = async () => { 
          window.showModal("⚠️ 永久删除", `<div style="font-size: 15px; color: var(--text-main);">确定永久删除已完成的待办 <b>"${todo.task}"</b> 吗？此操作不可恢复。</div>`, null, async () => {
              const idx = appData.todos.indexOf(todo); if (idx > -1) { appData.todos.splice(idx, 1); await saveData(); renderTodoList(); }
          }, { danger: true });
      };
      
      actionsDiv.append(remarkBtn, delBtn); 
      itemDiv.append(checkbox, contentCol, actionsDiv); 
      drawer.appendChild(itemDiv);
    });

    const clearAllBtn = document.createElement('button'); clearAllBtn.className = 'primary-btn'; clearAllBtn.style.width = '100%'; clearAllBtn.style.marginTop = '15px'; clearAllBtn.style.backgroundColor = 'rgba(var(--color-danger-rgb), 0.2)'; clearAllBtn.style.color = 'var(--color-danger)'; clearAllBtn.style.border = '1px solid rgba(var(--color-danger-rgb), 0.4)'; clearAllBtn.innerText = '🧹 一键清理所有已完成待办 (无法恢复)';
    
    clearAllBtn.onclick = async () => { 
        window.showModal("🧹 清理已完成待办", `<div style="font-size: 15px; color: var(--text-main);">确定要永久清理 <b>所有已完成的待办</b> 吗？<br><br><span style="color:#ff6b6b;font-size:13px;">⚠️ 此操作彻底无法撤销。</span></div>`, null, async () => {
            appData.todos = appData.todos.filter(t => !t.done); await saveData(); renderTodoList(); 
        }, { danger: true, btnText: "🧹 立即清理" });
    };
    drawer.appendChild(clearAllBtn);
  }
}

// 自动清理超过设定天数的已完成待办
export async function autoCleanupTodos() {
    if (!appData.settings || appData.settings.auto_cleanup_days === undefined) {
        renderTodoList(); return;
    }
    const days = parseInt(appData.settings.auto_cleanup_days);
    if (days === 0) {
        renderTodoList(); return; // 0代表永不清理
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0); // 将时间抹平到今日零点，方便精确对比天数
    const initialLength = appData.todos.length;

    appData.todos = appData.todos.filter(todo => {
        // 如果未完成，或者没有完成时间，强行保留
        if (!todo.done || !todo.completed_at) return true;
        
        const compDate = new Date(todo.completed_at);
        compDate.setHours(0, 0, 0, 0);
        
        const diffTime = today - compDate;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        // 只有间隔天数 <= 设定天数的才保留；其余丢弃
        return diffDays <= days; 
    });

    // 如果清理前后的数组长度不一样，说明有脏数据被干掉了，保存一次！
    if (appData.todos.length !== initialLength) {
        await saveData();
    }
    
    // 渲染最终结果
    renderTodoList();
}