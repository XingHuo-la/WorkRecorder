import { appData, loadData, dbExecute, dbQuery } from './data.js'; // 🌟 引入数据库查询工具
const check = window.__TAURI__.updater?.check;
const relaunch = window.__TAURI__.process?.relaunch;
const { invoke } = window.__TAURI__.core || window.__TAURI__;
const dialog = window.__TAURI__.dialog;
let showAllInactive = false;

export function initSettingsModule() {
  if (!appData.settings) appData.settings = {};
  if (!appData.settings.active_tags) appData.settings.active_tags = [...appData.tags]; 

  // ==========================================
  // 🎨 主题切换逻辑
  // ==========================================
  const themeSelect = document.getElementById('theme-select');
  themeSelect.value = appData.settings.theme || 'dark';
  themeSelect.addEventListener('change', async (e) => {
      const selectedTheme = e.target.value;
      appData.settings.theme = selectedTheme;
      document.documentElement.className = ''; 
      if (selectedTheme !== 'dark') document.documentElement.classList.add(`theme-${selectedTheme}`);
      await dbExecute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ["theme", selectedTheme]);
  });

  // ==========================================
  // 🧹 自动清理天数的交互逻辑
  // ==========================================
  const displayMode = document.getElementById('cleanup-display-mode');
  const editMode = document.getElementById('cleanup-edit-mode');
  const textVal = document.getElementById('cleanup-text-val');
  const inputEl = document.getElementById('auto-cleanup-input');

  const updateCleanupDisplay = () => { textVal.innerText = appData.settings.auto_cleanup_days ?? 7; displayMode.style.display = 'flex'; editMode.style.display = 'none'; };
  updateCleanupDisplay();

  document.getElementById('cleanup-edit-btn').onclick = () => { inputEl.value = appData.settings.auto_cleanup_days ?? 7; displayMode.style.display = 'none'; editMode.style.display = 'flex'; inputEl.focus(); };
  document.getElementById('cleanup-cancel-btn').onclick = updateCleanupDisplay;

  document.getElementById('cleanup-save-btn').onclick = async () => {
      let val = parseInt(inputEl.value); if (isNaN(val) || val < 0) val = 0;
      appData.settings.auto_cleanup_days = val;
      await dbExecute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ["auto_cleanup_days", val]);
      updateCleanupDisplay();
      import('./todo.js').then(m => m.autoCleanupTodos()); 
  };

  // ==========================================
  // 📂 数据路径 (保留不变，走 Rust 逻辑)
  // ==========================================
  const pathTextEl = document.getElementById('data-path-text');
  invoke('get_current_path').then(path => {
      // 抹除旧时代的痕迹，在 UI 上显示真实的 .db 后缀
      const dbPath = path.replace(/\.json$/, '.db');
      pathTextEl.innerText = dbPath;
  });

  document.getElementById('change-path-btn').onclick = () => {
      window.showModal("📁 更改数据存储位置", `
          <div style="color:var(--text-main); font-size: 14px; margin-bottom: 20px;">系统已升级为高性能本地数据库版本，请直接在底部查看您的 my_data.db 文件位置。如有备份需求，请直接拷贝该文件夹下的所有文件即可。</div>
      `, null, async () => { return true; }); 
  };

  // ==========================================
  // 🏷️ 标签搜索与新建逻辑
  // ==========================================
  document.getElementById('search-tag-input').addEventListener('input', () => { showAllInactive = false; renderSettingsTags(); });
  document.getElementById('add-tag-btn').addEventListener('click', async () => {
    const val = document.getElementById('new-tag-input').value.trim();
    if(!val) return;
    if(!appData.tags.includes(val)) {
        await dbExecute("INSERT OR IGNORE INTO tags (name, is_active) VALUES (?, ?)", [val, true]);
        await loadData(); document.getElementById('new-tag-input').value = "";
        renderSettingsTags(); updateAllDropdowns();
    } else alert("⚠️ 标签已存在！");
  });

  // 更新逻辑保留...
  const updateBtn = document.getElementById('check-update-btn');
  if (updateBtn) {
      updateBtn.onclick = async () => {
          try {
              updateBtn.innerText = "🔄 正在检查..."; updateBtn.disabled = true;
              const update = await check();
              if (update) {
                  window.showModal("🎉 发现新版本！", `<div style="font-size: 14px; color: var(--text-main);">最新版本：<b style="color: var(--color-primary);">${update.version}</b><br><br><b>更新内容：</b><br><div style="background: var(--overlay-light); padding: 10px; border-radius: 6px; margin-top: 5px; font-size: 13px;">${update.body || '优化体验。'}</div></div>`, null, async () => {
                      const confirmBtn = document.getElementById('global-modal-confirm'); confirmBtn.innerText = "⬇️ 正在下载 (请稍候)..."; confirmBtn.disabled = true;
                      await update.downloadAndInstall(() => {}); await relaunch();
                  }, { btnText: "🚀 立即升级并重启" });
              } else alert("✨ 当前已经是最新版本啦！");
          } catch (error) { alert("❌ 检查更新失败"); } finally { updateBtn.innerText = "🔍 检查更新"; updateBtn.disabled = false; }
      };
  }

  renderSettingsTags();
}

// ==========================================
// 🎨 标签库 UI 渲染核心逻辑
// ==========================================
async function renderSettingsTags() {
  const container = document.getElementById('tags-library-container'); container.innerHTML = "";
  const searchTerm = document.getElementById('search-tag-input').value.trim().toLowerCase();
  
  // 🌟 从数据库查询真实的活跃状态，并自动修复前端状态！
  const dbTags = await dbQuery("SELECT name, is_active FROM tags");
  appData.settings.active_tags = []; // 热修复：重置活跃数组
  let activeTags = []; let inactiveTags = [];

  dbTags.forEach(tagObj => {
    const mainTag = tagObj.name;
    const isActive = tagObj.is_active === 1 || tagObj.is_active === 'true' || tagObj.is_active === true;
    
    let isMatch = !searchTerm || mainTag.toLowerCase().includes(searchTerm);
    if (!isMatch && appData.sub_tags && appData.sub_tags[mainTag]) isMatch = appData.sub_tags[mainTag].some(subTag => subTag.toLowerCase().includes(searchTerm));
    if (!isMatch) return;
    
    if (isActive) { activeTags.push(mainTag); appData.settings.active_tags.push(mainTag); } 
    else inactiveTags.push(mainTag);
  });

  const createTagCard = (mainTag, isActive) => {
    const details = document.createElement('details'); details.className = 'glass-accordion'; details.style.marginBottom = '8px';
    if (searchTerm) details.open = true;
    
    const summary = document.createElement('summary'); summary.className = 'log-summary'; summary.style.display = 'flex'; summary.style.justifyContent = 'space-between';
    summary.innerHTML = `
      <div style="display:flex; align-items:center;"><span class="log-text" style="font-size: 15px; font-weight: bold;">🏷️ ${mainTag}</span></div>
      <div style="display:flex; align-items:center; gap: 15px;" onclick="event.stopPropagation();">
         <label style="display:flex; align-items:center; gap:5px; cursor:pointer; color: ${isActive ? '#4ade80' : '#94A3B8'};">
            <input type="checkbox" class="active-tag-checkbox" data-tag="${mainTag}" ${isActive ? 'checked' : ''}>
            ${isActive ? '已活跃' : '设为活跃'}
         </label>
         <div class="dropdown-wrapper" onclick="event.preventDefault(); event.stopPropagation();">
            <button class="dots-btn">⋮</button>
            <div class="dropdown-menu">
                <div class="dropdown-item" data-action="add-sub">➕ 添加子项目</div>
                <div class="dropdown-item" data-action="edit-main">✏️ 编辑名称</div>
                <div class="dropdown-item danger" data-action="del-main">🗑️ 删除主分类</div>
            </div>
         </div>
      </div>
    `;

    // 绑定下拉菜单显示逻辑
    summary.querySelector('.dots-btn').onclick = function() {
        const menu = this.nextElementSibling; const isShow = menu.classList.contains('show');
        document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
        document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
        if (!isShow) { menu.classList.add('show'); const card = this.closest('.glass-accordion'); if(card) card.classList.add('elevated-zindex'); }
    };

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
            <span class="dots-btn" style="padding: 0 4px; font-size: 14px;">⋮</span>
            <div class="dropdown-menu" style="min-width: 90px; right: auto; left: 0;">
                <div class="dropdown-item" data-action="edit-sub" data-subidx="${subIdx}">✏️ 编辑</div>
                <div class="dropdown-item danger" data-action="del-sub" data-subidx="${subIdx}">🗑️ 删除</div>
            </div>
        </div>`;
      
      // 绑定下拉逻辑
      subBadge.querySelector('.dots-btn').onclick = function() {
          const menu = this.nextElementSibling; const isShow = menu.classList.contains('show');
          document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
          document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
          if (!isShow) { menu.classList.add('show'); const card = this.closest('.glass-accordion'); if(card) card.classList.add('elevated-zindex'); }
      };
      subPool.appendChild(subBadge);
    });

    const closeMenus = () => {
        document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
        document.querySelectorAll('.elevated-zindex').forEach(el => el.classList.remove('elevated-zindex'));
    };

    // 🌟 活跃状态存入数据库
    summary.querySelector('.active-tag-checkbox').onchange = async (e) => {
        await dbExecute("UPDATE tags SET is_active=? WHERE name=?", [e.target.checked, mainTag]);
        await loadData(); renderSettingsTags(); updateAllDropdowns();
    };

    summary.querySelector('[data-action="add-sub"]').onclick = () => {
        closeMenus();
        window.showModal(`➕ 为 "${mainTag}" 添加子项目`, `
            <div class="form-group"><label class="field-label">新子项目名称</label><input type="text" id="m-sub-name" class="hero-input" placeholder="输入名称..."></div>
        `, body => body.querySelector('#m-sub-name').focus(), async (body) => {
            const val = body.querySelector('#m-sub-name').value.trim();
            if (!val) { alert("不能为空"); return false; }
            const exists = appData.sub_tags[mainTag] && appData.sub_tags[mainTag].includes(val);
            if (!exists) {
                await dbExecute("INSERT INTO sub_tags (main_tag, name) VALUES (?, ?)", [mainTag, val]);
                await loadData(); renderSettingsTags(); updateAllDropdowns();
            } else { alert("已存在"); return false; }
        });
    };

    // 🌟 外科手术：修改主标签名称，利用 SQLite 同步更新全局！
    summary.querySelector('[data-action="edit-main"]').onclick = () => {
      closeMenus();
      window.showModal("✏️ 修改主分类", `
          <div class="form-group"><label class="field-label">主分类名称</label><input type="text" id="m-main-name" class="hero-input" value="${mainTag}"></div>
      `, body => body.querySelector('#m-main-name').focus(), async (body) => {
          const newName = body.querySelector('#m-main-name').value.trim();
          if (!newName || newName === mainTag) return true;
          if (appData.tags.includes(newName)) { alert("⚠️ 该标签名已存在！"); return false; }
          
          // 连环技：同时修改标签、子项目关联、待办、流水记录
          await dbExecute("UPDATE tags SET name=? WHERE name=?", [newName, mainTag]);
          await dbExecute("UPDATE sub_tags SET main_tag=? WHERE main_tag=?", [newName, mainTag]);
          await dbExecute("UPDATE todos SET tag=? WHERE tag=?", [newName, mainTag]);
          await dbExecute("UPDATE logs SET tag=? WHERE tag=?", [newName, mainTag]);

          await loadData(); renderSettingsTags(); updateAllDropdowns();
      });
    };

    summary.querySelector('[data-action="del-main"]').onclick = async () => {
      closeMenus();
      if (appData.tags.length <= 1) return alert("⚠️ 至少保留一个主分类！");
      window.showModal("⚠️ 确认删除主分类", `<div style="font-size:15px;color:var(--text-main);">确定要删除主分类 <b>"${mainTag}"</b> 吗？<br><br><span style="color:#94A3B8;font-size:13px;">⚠️ 注意：此操作将同时解绑其下方所有的子项目。但已经产生的历史流水记录不受影响。</span></div>`, null, async () => {
          await dbExecute("DELETE FROM tags WHERE name=?", [mainTag]);
          await dbExecute("DELETE FROM sub_tags WHERE main_tag=?", [mainTag]);
          await loadData(); renderSettingsTags(); updateAllDropdowns();
      }, { danger: true });
    };

    // 🌟 外科手术：修改子项目，同步更新全局
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
            
            // 连环技同步
            await dbExecute("UPDATE sub_tags SET name=? WHERE main_tag=? AND name=?", [newName, mainTag, oldSub]);
            await dbExecute("UPDATE todos SET sub_tag=? WHERE tag=? AND sub_tag=?", [newName, mainTag, oldSub]);
            await dbExecute("UPDATE logs SET sub_tag=? WHERE tag=? AND sub_tag=?", [newName, mainTag, oldSub]);

            await loadData(); renderSettingsTags(); updateAllDropdowns();
        });
      }
    });

    subPool.querySelectorAll('[data-action="del-sub"]').forEach(btn => {
      btn.onclick = async () => { 
        closeMenus(); 
        const subIdx = btn.getAttribute('data-subidx'); const subName = appData.sub_tags[mainTag][subIdx];
        window.showModal("⚠️ 删除子项目", `<div style="font-size:15px;color:var(--text-main);">确定要删除子项目 <b>"${subName}"</b> 吗？</div>`, null, async () => {
            await dbExecute("DELETE FROM sub_tags WHERE main_tag=? AND name=?", [mainTag, subName]);
            await loadData(); renderSettingsTags(); updateAllDropdowns(); 
        }, { danger: true });
      };
    });

    content.append(subPool); details.append(summary, content); return details;
  };

  const activeWrapper = document.createElement('details'); activeWrapper.open = true; activeWrapper.className = 'glass-accordion border-success';
  activeWrapper.innerHTML = `<summary class="log-summary" style="background: rgba(74, 222, 128, 0.05);"><span class="log-text" style="font-size: 16px; font-weight: bold;">🌟 活跃标签 (${activeTags.length})</span></summary><div class="expanded-content" style="padding: 15px;" id="active-list"></div>`;
  container.appendChild(activeWrapper); const activeList = activeWrapper.querySelector('#active-list');
  if (activeTags.length === 0) activeList.innerHTML = searchTerm ? "<p style='color:gray; font-size:13px;'>未搜到相关活跃标签。</p>" : "<p style='color:gray; font-size:13px;'>暂无活跃标签。</p>";
  activeTags.forEach(tag => activeList.appendChild(createTagCard(tag, true)));

  if (inactiveTags.length > 0 || searchTerm) {
    const inactiveWrapper = document.createElement('details'); inactiveWrapper.open = searchTerm !== ""; inactiveWrapper.className = 'glass-accordion border-muted';
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