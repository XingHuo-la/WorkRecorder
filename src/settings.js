import { appData, saveData, loadData } from './data.js';
const check = window.__TAURI__.updater?.check;
const relaunch = window.__TAURI__.process?.relaunch;
const { invoke } = window.__TAURI__.core || window.__TAURI__;
const dialog = window.__TAURI__.dialog;
let showAllInactive = false;

export function initSettingsModule() {
  if (!appData.settings) appData.settings = {};
  if (!appData.settings.active_tags) appData.settings.active_tags = [...appData.tags]; 

  // ==========================================
  // 🎨 0. 主题切换逻辑
  // ==========================================
  const themeSelect = document.getElementById('theme-select');
  themeSelect.value = appData.settings.theme || 'dark';
  
  themeSelect.addEventListener('change', async (e) => {
      const selectedTheme = e.target.value;
      appData.settings.theme = selectedTheme;
      
      // 核心魔法：先清除所有 theme- 开头的 class，再添加选中的 class
      document.documentElement.className = ''; 
      if (selectedTheme !== 'dark') { // dark 是默认根样式，不需要加 class
          document.documentElement.classList.add(`theme-${selectedTheme}`);
      }
      
      await saveData();
  });

  // ==========================================
  // 🧹 1. 自动清理天数的交互逻辑 (先确认，后保存)
  // ==========================================
  const displayMode = document.getElementById('cleanup-display-mode');
  const editMode = document.getElementById('cleanup-edit-mode');
  const textVal = document.getElementById('cleanup-text-val');
  const inputEl = document.getElementById('auto-cleanup-input');

  const updateCleanupDisplay = () => {
      textVal.innerText = appData.settings.auto_cleanup_days ?? 7;
      displayMode.style.display = 'flex';
      editMode.style.display = 'none';
  };
  updateCleanupDisplay();

  document.getElementById('cleanup-edit-btn').onclick = () => {
      inputEl.value = appData.settings.auto_cleanup_days ?? 7;
      displayMode.style.display = 'none';
      editMode.style.display = 'flex';
      inputEl.focus();
  };

  document.getElementById('cleanup-cancel-btn').onclick = updateCleanupDisplay;

  document.getElementById('cleanup-save-btn').onclick = async () => {
      let val = parseInt(inputEl.value);
      if (isNaN(val) || val < 0) val = 0;
      appData.settings.auto_cleanup_days = val;
      await saveData();
      console.log(`🧹 自动清理周期已更新为: ${val} 天`);
      updateCleanupDisplay();
      import('./todo.js').then(m => m.autoCleanupTodos()); // 触发一次清理校验
  };

  // ==========================================
  // 📂 2. 数据路径的交互与安全防护逻辑
  // ==========================================
  const pathTextEl = document.getElementById('data-path-text');
  
  // 初始获取显示
  invoke('get_current_path').then(path => pathTextEl.innerText = path);

  document.getElementById('change-path-btn').onclick = () => {
      // 弹出自定义菜单，让用户选择模式
      window.showModal("📁 更改数据存储位置", `
          <div style="color:var(--text-main); font-size: 14px; margin-bottom: 20px;">请选择您的操作：您是要指定一个具体的旧数据文件加载，还是选择一个安全的文件夹存放当前数据？</div>
          <div style="display:flex; flex-direction:column; gap:12px;">
              <button id="pick-folder-btn" class="primary-btn" style="width:100%; margin:0;">📁 选择目标文件夹 (系统自动检测或创建数据)</button>
              <button id="pick-file-btn" class="primary-btn" style="width:100%; margin:0; background: transparent; border: 1px solid var(--border-medium); color: var(--text-main);">📄 直接选择具体的 .json 文件</button>
          </div>
      `, (body) => {
          body.querySelector('#pick-folder-btn').onclick = async () => {
              document.getElementById('global-modal-overlay').style.display = 'none';
              const selectedDir = await dialog.open({ directory: true });
              if (selectedDir) processSelectedPath(selectedDir);
          };
          body.querySelector('#pick-file-btn').onclick = async () => {
              document.getElementById('global-modal-overlay').style.display = 'none';
              const selectedFile = await dialog.open({ directory: false, filters: [{ name: 'JSON 数据', extensions: ['json'] }] });
              if (selectedFile) processSelectedPath(selectedFile);
          };
      }, async () => { return true; }); 
      
      // 隐藏底部默认的保存按钮
      setTimeout(() => { document.querySelector('#global-modal-confirm').style.display = 'none'; }, 10);
  };

  async function processSelectedPath(rawPath) {
      try {
          // 1. 调用后端探针，获取处理后的最终路径和文件状态
          const resultStr = await invoke('check_path', { target: rawPath });
          const result = JSON.parse(resultStr);

          // 2. 根据状态进行安全拦截
          if (result.exists && !result.is_empty) {
              // 🚨 危险：目标已有数据，强制用户做抉择，绝不默默覆写！
              window.showModal("⚠️ 发现已有数据", `
                  <div style="font-size: 14px; color: var(--text-main);">
                      在目标位置 <br><br><b style="color:var(--color-primary); word-break: break-all;">${result.final_path}</b><br><br>
                      已经存在一个非空的数据文件。您希望如何处理？
                  </div>
              `, null, async () => { return true; });

              setTimeout(() => {
                  const actionBox = document.querySelector('.modal-actions');
                  actionBox.innerHTML = `
                      <button id="action-cancel" class="icon-btn" style="margin:0;">取消操作</button>
                      <button id="action-load" class="primary-btn" style="margin:0; width:auto; background: #4ade80; color: #000;">📥 读取该已有数据 (放弃当前)</button>
                      <button id="action-overwrite" class="primary-btn" style="margin:0; width:auto; background: rgba(255, 107, 107, 0.2); color: #ff6b6b; border: 1px solid rgba(255,107,107,0.5);">🔥 用当前数据强制覆盖它</button>
                  `;
                  document.getElementById('action-cancel').onclick = () => document.getElementById('global-modal-overlay').style.display = 'none';
                  
                  document.getElementById('action-load').onclick = async () => {
                      document.getElementById('global-modal-overlay').style.display = 'none';
                      await executePathChange(result.final_path, "LOAD");
                  };
                  
                  document.getElementById('action-overwrite').onclick = async () => {
                      document.getElementById('global-modal-overlay').style.display = 'none';
                      await executePathChange(result.final_path, "OVERWRITE");
                  };
              }, 10);

          } else {
              // ✅ 安全：目标不存在或为空文件，直接执行新建/迁移
              window.showModal("✨ 确认迁移位置", `
                  <div style="font-size: 14px; color: var(--text-main);">
                      确认将数据存储路径更改为:<br><br><b style="color:var(--color-primary); word-break: break-all;">${result.final_path}</b><br><br>
                      系统会将您当前的数据自动迁移过去。
                  </div>
              `, null, async () => {
                  await executePathChange(result.final_path, "CREATE");
              });
          }
      } catch (err) {
          alert("路径解析出错: " + err);
      }
  }

  async function executePathChange(finalPath, mode) {
      try {
          await invoke('apply_new_path', { newPath: finalPath, mode: mode });
          pathTextEl.innerText = finalPath; // 更新 UI
          
          if (mode === "LOAD") {
              alert("✅ 路径更新成功，正在加载新数据！");
              await loadData(); // 重新从底层读取刚才指定的旧文件
              location.reload(); // 粗暴但最稳妥的方式：直接刷新软件视图以应用新数据
          } else {
              alert("✅ 数据迁移并保存成功！");
          }
      } catch (e) {
          alert("❌ 路径修改失败: " + e);
      }
  }

  // ==========================================
  // 🏷️ 3. 标签搜索与新建逻辑
  // ==========================================
  document.getElementById('search-tag-input').addEventListener('input', () => { showAllInactive = false; renderSettingsTags(); });
  
  document.getElementById('add-tag-btn').addEventListener('click', async () => {
    const val = document.getElementById('new-tag-input').value.trim();
    if(!val) return;
    if(!appData.tags.includes(val)) {
        appData.tags.push(val); appData.settings.active_tags.push(val); 
        await saveData(); document.getElementById('new-tag-input').value = "";
        renderSettingsTags(); updateAllDropdowns();
    } else alert("⚠️ 标签已存在！");
  });
  // ==========================================
  // 🚀 4. 增量更新逻辑
  // ==========================================
  const updateBtn = document.getElementById('check-update-btn');
  if (updateBtn) {
      updateBtn.onclick = async () => {
          try {
              updateBtn.innerText = "🔄 正在检查...";
              updateBtn.disabled = true;

              const update = await check();

              if (update) {
                  window.showModal("🎉 发现新版本！", `
                      <div style="font-size: 14px; color: var(--text-main);">
                          最新版本：<b style="color: var(--color-primary);">${update.version}</b><br><br>
                          <b>更新内容：</b><br>
                          <div style="background: var(--overlay-light); padding: 10px; border-radius: 6px; margin-top: 5px; font-size: 13px;">
                              ${update.body || '优化了一些体验细节，修复了已知 Bug。'}
                          </div>
                      </div>
                  `, null, async () => {
                      const confirmBtn = document.getElementById('global-modal-confirm');
                      confirmBtn.innerText = "⬇️ 正在下载 (请稍候)...";
                      confirmBtn.disabled = true;
                      
                      let downloaded = 0;
                      let contentLength = 0;
                      
                      // 开始下载并安装增量包
                      await update.downloadAndInstall((event) => {
                          if (event.event === 'Started') {
                              contentLength = event.data.contentLength;
                          } else if (event.event === 'Progress') {
                              downloaded += event.data.chunkLength;
                              if (contentLength > 0) {
                                  const percent = Math.round((downloaded / contentLength) * 100);
                                  confirmBtn.innerText = `⬇️ 正在下载 (${percent}%)`;
                              }
                          } else if (event.event === 'Finished') {
                              confirmBtn.innerText = "✅ 安装完成，正在重启...";
                          }
                      });
                      
                      // 安装完成后自动重启
                      await relaunch();
                  }, { btnText: "🚀 立即升级并重启" });
              } else {
                  alert("✨ 当前已经是最新版本啦！");
              }
          } catch (error) {
              console.error("更新失败:", error);
              alert("❌ 检查更新失败，请检查网络或配置是否正确。");
          } finally {
              updateBtn.innerText = "🔍 检查更新";
              updateBtn.disabled = false;
          }
      };
  }
  // 初始渲染标签库
  renderSettingsTags();
} // ⬅️ 修复点：正确闭合了整个 initSettingsModule 方法

// ==========================================
// 🎨 标签库 UI 渲染核心逻辑
// ==========================================
function renderSettingsTags() {
  const container = document.getElementById('tags-library-container'); container.innerHTML = "";
  const searchTerm = document.getElementById('search-tag-input').value.trim().toLowerCase();
  if (!appData.sub_tags) appData.sub_tags = {};
  let activeTags = []; let inactiveTags = [];

  appData.tags.forEach(mainTag => {
    let isMatch = !searchTerm || mainTag.toLowerCase().includes(searchTerm);
    if (!isMatch && appData.sub_tags && appData.sub_tags[mainTag]) isMatch = appData.sub_tags[mainTag].some(subTag => subTag.toLowerCase().includes(searchTerm));
    if (!isMatch) return;
    if (appData.settings.active_tags.includes(mainTag)) activeTags.push(mainTag); else inactiveTags.push(mainTag);
  });

  const createTagCard = (mainTag, isActive) => {
    const globalIndex = appData.tags.indexOf(mainTag);
    const details = document.createElement('details'); details.className = 'glass-accordion'; details.style.marginBottom = '8px';
    if (searchTerm) details.open = true;
    
    const summary = document.createElement('summary'); summary.className = 'log-summary'; summary.style.display = 'flex'; summary.style.justifyContent = 'space-between';
    
    summary.innerHTML = `
      <div style="display:flex; align-items:center;">
         <span class="log-text" style="font-size: 15px; font-weight: bold;">🏷️ ${mainTag}</span>
      </div>
      <div style="display:flex; align-items:center; gap: 15px;" onclick="event.stopPropagation();">
         <label style="display:flex; align-items:center; gap:5px; cursor:pointer; color: ${isActive ? '#4ade80' : '#94A3B8'};">
            <input type="checkbox" class="active-tag-checkbox" data-tag="${mainTag}" ${isActive ? 'checked' : ''}>
            ${isActive ? '已活跃' : '设为活跃'}
         </label>
         <div class="dropdown-wrapper" onclick="event.preventDefault(); event.stopPropagation();">
            <button class="dots-btn" onclick="
                const menu = this.nextElementSibling; const isShow = menu.classList.contains('show');
                document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
                document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
                if (!isShow) { menu.classList.add('show'); const card = this.closest('.glass-accordion'); if(card) card.classList.add('elevated-zindex'); }
            ">⋮</button>
            <div class="dropdown-menu">
                <div class="dropdown-item" data-action="add-sub">➕ 添加子项目</div>
                <div class="dropdown-item" data-action="edit-main">✏️ 编辑名称</div>
                <div class="dropdown-item danger" data-action="del-main">🗑️ 删除主分类</div>
            </div>
         </div>
      </div>
    `;

    const content = document.createElement('div'); content.className = 'expanded-content'; content.style.paddingTop = '10px';
    const subPool = document.createElement('div'); subPool.style.cssText = "display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 5px;";
    const subs = appData.sub_tags[mainTag] || [];
    if (subs.length === 0) subPool.innerHTML = "<span style='color:gray; font-size:12px;'>(目前暂无专属子项目)</span>";
    
    subs.forEach((sub, subIdx) => {
      let displaySub = sub; if (searchTerm && sub.toLowerCase().includes(searchTerm)) displaySub = `<span style="color:#3b82f6; font-weight:bold;">${sub}</span>`; 
      const subBadge = document.createElement('div');
      subBadge.style.cssText = "background: rgba(255,255,255,0.1); padding: 4px 10px; border-radius: 12px; font-size: 13px; display: flex; align-items: center; gap: 2px;";
      subBadge.innerHTML = `📁 ${displaySub} 
        <div class="dropdown-wrapper" onclick="event.preventDefault(); event.stopPropagation();">
            <span class="dots-btn" style="padding: 0 4px; font-size: 14px;" onclick="
                const menu = this.nextElementSibling; const isShow = menu.classList.contains('show');
                document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
                document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
                if (!isShow) { menu.classList.add('show'); const card = this.closest('.glass-accordion'); if(card) card.classList.add('elevated-zindex'); }
            ">⋮</span>
            <div class="dropdown-menu" style="min-width: 90px; right: auto; left: 0;">
                <div class="dropdown-item" data-action="edit-sub" data-subidx="${subIdx}">✏️ 编辑</div>
                <div class="dropdown-item danger" data-action="del-sub" data-subidx="${subIdx}">🗑️ 删除</div>
            </div>
        </div>`;
      subPool.appendChild(subBadge);
    });

    const closeMenus = () => {
        document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
        document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
    };

    summary.querySelector('.active-tag-checkbox').onchange = async (e) => {
        if (e.target.checked) { if (!appData.settings.active_tags.includes(mainTag)) appData.settings.active_tags.push(mainTag); } 
        else appData.settings.active_tags = appData.settings.active_tags.filter(t => t !== mainTag);
        await saveData(); renderSettingsTags(); updateAllDropdowns();
    };

    summary.querySelector('[data-action="add-sub"]').onclick = () => {
        closeMenus();
        window.showModal(`➕ 为 "${mainTag}" 添加子项目`, `
            <div class="form-group"><label class="field-label">新子项目名称</label><input type="text" id="m-sub-name" class="hero-input" placeholder="输入名称..."></div>
        `, body => body.querySelector('#m-sub-name').focus(), async (body) => {
            const val = body.querySelector('#m-sub-name').value.trim();
            if (!val) { alert("不能为空"); return false; }
            if (!appData.sub_tags[mainTag]) appData.sub_tags[mainTag] = [];
            if (!appData.sub_tags[mainTag].includes(val)) {
                appData.sub_tags[mainTag].push(val); await saveData(); renderSettingsTags(); updateAllDropdowns();
            } else { alert("已存在"); return false; }
        });
    };

    summary.querySelector('[data-action="edit-main"]').onclick = () => {
      closeMenus();
      window.showModal("✏️ 修改主分类", `
          <div class="form-group"><label class="field-label">主分类名称</label><input type="text" id="m-main-name" class="hero-input" value="${mainTag}"></div>
      `, body => body.querySelector('#m-main-name').focus(), async (body) => {
          const newName = body.querySelector('#m-main-name').value.trim();
          if (!newName || newName === mainTag) return true;
          if (appData.tags.includes(newName)) { alert("⚠️ 该标签名已存在！"); return false; }
          appData.tags = appData.tags.map(t => t === mainTag ? newName : t);
          appData.settings.active_tags = appData.settings.active_tags.map(t => t === mainTag ? newName : t);
          if (appData.sub_tags[mainTag]) { appData.sub_tags[newName] = appData.sub_tags[mainTag]; delete appData.sub_tags[mainTag]; }
          Object.values(appData.logs).forEach(dayLogs => dayLogs.forEach(log => { if(log.tag === mainTag) log.tag = newName; }));
          appData.todos.forEach(todo => { if(todo.tag === mainTag) todo.tag = newName; });
          await saveData(); renderSettingsTags(); updateAllDropdowns();
      });
    };

    summary.querySelector('[data-action="del-main"]').onclick = async () => {
      closeMenus();
      if (appData.tags.length <= 1) return alert("⚠️ 至少保留一个主分类！");
      
      window.showModal("⚠️ 确认删除主分类", `<div style="font-size:15px;color:var(--text-main);">确定要删除主分类 <b>"${mainTag}"</b> 吗？<br><br><span style="color:#94A3B8;font-size:13px;">⚠️ 注意：此操作将同时解绑其下方所有的子项目，但已经产生的历史流水记录不受影响。</span></div>`, null, async () => {
          appData.tags.splice(globalIndex, 1);
          appData.settings.active_tags = appData.settings.active_tags.filter(t => t !== mainTag);
          delete appData.sub_tags[mainTag];
          await saveData(); renderSettingsTags(); updateAllDropdowns();
      }, { danger: true });
    };

    subPool.querySelectorAll('[data-action="edit-sub"]').forEach(btn => {
      btn.onclick = () => {
        closeMenus();
        const subIdx = btn.getAttribute('data-subidx'); const oldSub = appData.sub_tags[mainTag][subIdx];
        window.showModal("✏️ 修改子项目", `
            <div class="form-group"><label class="field-label">子项目名称</label><input type="text" id="m-sub-edit" class="hero-input" value="${oldSub}"></div>
        `, body => body.querySelector('#m-sub-edit').focus(), async (body) => {
            const newName = body.querySelector('#m-sub-edit').value.trim();
            if (!newName || newName === oldSub) return true;
            if (appData.sub_tags[mainTag].includes(newName)) { alert("⚠️ 子项目已存在！"); return false; }
            appData.sub_tags[mainTag][subIdx] = newName;
            Object.values(appData.logs).forEach(dayLogs => dayLogs.forEach(log => { if(log.tag === mainTag && log.sub_tag === oldSub) log.sub_tag = newName; }));
            appData.todos.forEach(todo => { if(todo.tag === mainTag && todo.sub_tag === oldSub) todo.sub_tag = newName; });
            await saveData(); renderSettingsTags(); updateAllDropdowns();
        });
      }
    });

    subPool.querySelectorAll('[data-action="del-sub"]').forEach(btn => {
      btn.onclick = async () => { 
        closeMenus(); 
        const subIdx = btn.getAttribute('data-subidx');
        const subName = appData.sub_tags[mainTag][subIdx];
        
        window.showModal("⚠️ 删除子项目", `<div style="font-size:15px;color:var(--text-main);">确定要删除子项目 <b>"${subName}"</b> 吗？</div>`, null, async () => {
            appData.sub_tags[mainTag].splice(subIdx, 1); await saveData(); renderSettingsTags(); updateAllDropdowns(); 
        }, { danger: true });
      };
    });

    content.append(subPool); details.append(summary, content); return details;
  };

  const activeWrapper = document.createElement('details'); activeWrapper.open = true; activeWrapper.className = 'glass-accordion border-success'; /* 直接用成功色积木 */ 
  activeWrapper.innerHTML = `<summary class="log-summary" style="background: rgba(74, 222, 128, 0.05);"><span class="log-text" style="font-size: 16px; font-weight: bold;">🌟 活跃标签 (${activeTags.length})</span></summary><div class="expanded-content" style="padding: 15px;" id="active-list"></div>`;
  container.appendChild(activeWrapper); const activeList = activeWrapper.querySelector('#active-list');
  if (activeTags.length === 0) activeList.innerHTML = searchTerm ? "<p style='color:gray; font-size:13px;'>未搜到相关活跃标签。</p>" : "<p style='color:gray; font-size:13px;'>暂无活跃标签。</p>";
  activeTags.forEach(tag => activeList.appendChild(createTagCard(tag, true)));

  if (inactiveTags.length > 0 || searchTerm) {
    const inactiveWrapper = document.createElement('details'); inactiveWrapper.open = searchTerm !== ""; inactiveWrapper.className = 'glass-accordion border-muted'; /* 用沉寂色积木 */
    inactiveWrapper.innerHTML = `<summary class="log-summary" style="background: rgba(255, 255, 255, 0.02);"><span class="log-text" style="font-size: 16px; font-weight: bold; color: #94A3B8;">📦 非活跃标签 (${inactiveTags.length})</span></summary><div class="expanded-content" style="padding: 15px;" id="inactive-list"></div>`;
    container.appendChild(inactiveWrapper); const inactiveList = inactiveWrapper.querySelector('#inactive-list');
    const limit = 3; const displayTags = (showAllInactive || searchTerm) ? inactiveTags : inactiveTags.slice(0, limit);
    if (displayTags.length === 0 && searchTerm) inactiveList.innerHTML = "<p style='color:gray; font-size:13px;'>未搜到相关非活跃标签。</p>";
    else displayTags.forEach(tag => inactiveList.appendChild(createTagCard(tag, false)));
    if (!showAllInactive && !searchTerm && inactiveTags.length > limit) {
        const moreBtn = document.createElement('button'); moreBtn.className = 'icon-btn'; moreBtn.style.width = '100%';
        moreBtn.innerText = `👇 点击展开其余 ${inactiveTags.length - limit} 个隐藏的标签`;
        moreBtn.onclick = () => { showAllInactive = true; renderSettingsTags(); }; inactiveList.appendChild(moreBtn);
    } else if (showAllInactive && !searchTerm && inactiveTags.length > limit) {
        const lessBtn = document.createElement('button'); lessBtn.className = 'icon-btn'; lessBtn.style.width = '100%';
        lessBtn.innerText = `👆 折叠隐藏非活跃标签`;
        lessBtn.onclick = () => { showAllInactive = false; renderSettingsTags(); }; inactiveList.appendChild(lessBtn);
    }
  }
}

function updateAllDropdowns() { 
  if (typeof window.renderLogTags === 'function') window.renderLogTags(); 
  if (typeof window.renderTodoTags === 'function') window.renderTodoTags(); 
}