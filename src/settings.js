import { appData, loadData, dbExecute, dbQuery } from './data.js'; 
const check = window.__TAURI__.updater?.check;
const relaunch = window.__TAURI__.process?.relaunch;
const { invoke } = window.__TAURI__.core || window.__TAURI__;

let showAllInactive = false;
// ==========================================
// 🛠️ 核心引擎：注入色彩与背景到 DOM
// ==========================================
export function applyTheme(themeObj) {
  if (!themeObj) return;
  const rootStyle = document.documentElement.style;

  if (themeObj.colors) {
    Object.entries(themeObj.colors).forEach(([variable, val]) => {
      rootStyle.setProperty(`--${variable}`, val);
    });
  }

  if (themeObj.background) {
    const rawUrl = themeObj.background["image-url"] || "none";
    const finalUrl = (rawUrl !== "none" && !rawUrl.startsWith("url(")) ? `url('${rawUrl}')` : rawUrl;
    rootStyle.setProperty('--bg-image-url', finalUrl);
    rootStyle.setProperty('--bg-overlay-color', themeObj.background["overlay-color"] || "transparent");
    rootStyle.setProperty('--bg-global-blur', themeObj.background["global-blur"] || "0px");
  }

  rootStyle.colorScheme = themeObj.isDark ? 'dark' : 'light';
}

// ==========================================
// 🛠️ 核心引擎：从打包的本地 JSON 异步读取并同步到数据库
// ==========================================
export async function applySavedThemeFromDB() {
    // 1. 初始化 SQLite 的 themes 主题表 (保持原样)
    await dbExecute(`CREATE TABLE IF NOT EXISTS themes (
        id TEXT PRIMARY KEY,
        name TEXT,
        is_builtin BOOLEAN,
        theme_data TEXT
    )`);
    
    try {
        // 2. 🌟 核心魔法：异步读取发版时自带的静态配置（极速且不占 js 代码行数）
        // 打包后这个 themes.json 会变成同目录下的静态资源，100% 离线可读
        const response = await fetch('./themes.json?t=' + new Date().getTime());
        const builtinThemes = await response.json();
        
        // 3. 将最新的系统默认主题安全地同步进 SQLite themes 表中
        for (const t of builtinThemes) {
            await dbExecute(
                "INSERT OR REPLACE INTO themes (id, name, is_builtin, theme_data) VALUES (?, ?, ?, ?)", 
                [t.id, t.name, true, JSON.stringify({ isDark: t.isDark, colors: t.colors, background: t.background })]
            );
        }
    } catch (fetchErr) {
        console.error("⚠️ 读取系统内置 themes.json 失败:", fetchErr);
    }

    // 4. 读取用户保存在 settings 里的激活主题 ID 并渲染应用 (保持原样)
    const savedThemeKey = (appData.settings && appData.settings.theme) || 'dark';
    const row = await dbQuery("SELECT theme_data FROM themes WHERE id=?", [savedThemeKey]);
    if (row && row.length > 0) {
        applyTheme(JSON.parse(row[0].theme_data));
    }
}

export function initSettingsModule() {
  if (!appData.settings) appData.settings = {};
  if (!appData.settings.active_tags) appData.settings.active_tags = [...appData.tags]; 

  // ==========================================
  // 🎨 全新主题与管理中心 (左右并列布局)
  // ==========================================
  
  // 渲染外部当前显示的主题名称
  window.renderCurrentThemeName = async () => {
      const currentId = appData.settings.theme || 'dark';
      const row = await dbQuery("SELECT name FROM themes WHERE id=?", [currentId]);
      const nameEl = document.getElementById('current-theme-name');
      if (nameEl) {
          nameEl.innerText = (row && row.length > 0) ? row[0].name : "🌙 标准深色";
      }
  };
  window.renderCurrentThemeName();

  // 呼出左右分栏的主题库面板
  document.getElementById('theme-manage-btn').onclick = async () => {
      let tempThemeObj = { colors: {}, background: {"image-url": "none", "overlay-color": "rgba(10, 15, 25, 0.65)", "global-blur": "0px"} };
      
      // 加载右侧的主题列表
      const loadAllThemesList = async (listContainer) => {
          const allThemes = await dbQuery("SELECT id, name, is_builtin FROM themes ORDER BY is_builtin DESC, id ASC");
          listContainer.innerHTML = '';
          const currentId = appData.settings.theme || 'dark';

          allThemes.forEach(t => {
              const isBuiltin = t.is_builtin === 1 || t.is_builtin === 'true' || t.is_builtin === true;
              const isActive = t.id === currentId;
              
              const activeBadge = isActive ? `<span style="font-size:12px; background:var(--color-success); color:#fff; padding:2px 6px; border-radius:4px; margin-left:8px;">当前使用</span>` : '';
              const delBtn = !isBuiltin ? `<button class="icon-btn danger" style="margin:0; padding:4px 8px; font-size:12px;" onclick="event.stopPropagation(); window.deleteCustomTheme('${t.id}')">🗑️ 删除</button>` : '';
              
              const cardStyle = isActive ? `border: 1px solid var(--color-primary); background: rgba(var(--color-primary-rgb), 0.05);` : `border: 1px solid var(--border-light); background: var(--overlay-light); cursor:pointer;`;

              listContainer.innerHTML += `
                  <div class="theme-list-item" style="display:flex; justify-content:space-between; align-items:center; padding:12px 15px; border-radius:8px; margin-bottom:10px; transition:all 0.2s; ${cardStyle}" onclick="window.applySelectedTheme('${t.id}')">
                      <div style="display:flex; align-items:center;">
                          <span style="font-size:14px; color:var(--text-main); font-weight:bold;">${isBuiltin ? '📦' : '🎨'} ${t.name}</span>
                          ${activeBadge}
                      </div>
                      <div>
                          ${!isActive ? `<span style="font-size: 12px; color: var(--text-muted); margin-right: 10px;">点击应用</span>` : ''}
                          ${delBtn}
                      </div>
                  </div>
              `;
          });
      };

      // 切换主题逻辑
      window.applySelectedTheme = async (id) => {
          appData.settings.theme = id;
          await dbExecute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ["theme", id]);
          const row = await dbQuery("SELECT theme_data FROM themes WHERE id=?", [id]);
          if (row && row.length > 0) applyTheme(JSON.parse(row[0].theme_data));
          
          await loadAllThemesList(document.getElementById('m-all-themes-list'));
          await window.renderCurrentThemeName();
      };

      // 删除主题逻辑
      window.deleteCustomTheme = async (id) => {
          if(!confirm("确定要删除这个自定义主题吗？")) return;
          await dbExecute("DELETE FROM themes WHERE id=?", [id]);
          if (appData.settings.theme === id) await window.applySelectedTheme('dark'); // 删了当前使用的就退回深色
          else await loadAllThemesList(document.getElementById('m-all-themes-list'));
      };

      window.showModal("工作台视觉与主题", `
          <style>
              .theme-list-item:hover { border-color: var(--color-primary) !important; background: rgba(var(--color-primary-rgb), 0.08) !important; }
          </style>
          
          <div style="display: flex; gap: 30px;">
              <div style="flex: 1; padding-right: 30px; border-right: 1px dashed var(--border-medium);">
                  <div style="font-size: 16px; font-weight: bold; margin-bottom: 20px; color: var(--color-primary);">调配新主题</div>
                  
                  <div class="form-group">
                      <label class="field-label">1. 主题基底 (选填)</label>
                      <div style="display: flex; gap: 10px; margin-top: 8px;">
                          <button id="m-import-json-btn" class="icon-btn" style="flex:1; padding: 10px; margin:0;">导入 JSON 配色</button>
                          <button id="m-import-img-btn" class="icon-btn" style="flex:1; padding: 10px; margin:0;">本地壁纸</button>
                      </div>
                  </div>

                  <div class="form-group" style="margin-top: 25px;">
                      <label class="field-label">2. 画面微调 (仅壁纸生效)</label>
                      <div style="display: flex; gap: 15px; margin-top: 8px;">
                          <div style="flex: 1;">
                              <span style="font-size: 12px; color: var(--text-muted);">遮罩颜色 (RGBA)</span>
                              <input type="text" id="m-bg-overlay" class="hero-input" style="padding: 8px 10px; font-size: 13px; margin-top: 4px;" value="rgba(10, 15, 25, 0.65)">
                          </div>
                          <div style="flex: 1;">
                              <span style="font-size: 12px; color: var(--text-muted);">模糊度</span>
                              <input type="text" id="m-bg-blur" class="hero-input" style="padding: 8px 10px; font-size: 13px; margin-top: 4px;" value="0px">
                          </div>
                      </div>
                  </div>

                  <div class="form-group" style="margin-top: 25px;">
                      <label class="field-label">3. 预览与入库</label>
                      <div style="display: flex; gap: 10px; margin-top: 8px;">
                          <button id="m-preview-btn" class="icon-btn" style="margin:0; padding: 10px;">预览效果</button>
                          <input type="text" id="m-save-name" class="hero-input" style="flex:1; padding: 8px 12px; font-size: 13px; margin:0;" placeholder="名字...">
                      </div>
                      <button id="m-save-btn" class="primary-btn" style="width: 100%; margin-top: 15px; padding: 10px;">保存入库</button>
                  </div>
              </div>

              <div style="flex: 1; display: flex; flex-direction: column;">
                  <div style="font-size: 16px; font-weight: bold; margin-bottom: 20px; color: var(--text-main);">我的主题库</div>
                  <div id="m-all-themes-list" style="overflow-y: auto; max-height: 400px; display: flex; flex-direction: column; padding-right: 5px;">
                      </div>
              </div>
          </div>
      `, async (body) => {
          // 🚀 核心：强行拉宽弹窗，适配左右双栏
          const modalWrapper = body.closest('.custom-modal');
          if (modalWrapper) {
              modalWrapper.style.width = '850px';
              modalWrapper.style.maxWidth = '95vw';
          }

          // 初始化加载右侧列表
          await loadAllThemesList(body.querySelector('#m-all-themes-list'));

          // 左侧功能绑定：JSON
          body.querySelector('#m-import-json-btn').onclick = () => {
              const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
              input.onchange = (e) => {
                  const file = e.target.files[0]; if(!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                      try {
                          const parsed = JSON.parse(ev.target.result);
                          if(parsed.colors) tempThemeObj.colors = { ...tempThemeObj.colors, ...parsed.colors };
                          if(parsed.background) tempThemeObj.background = { ...tempThemeObj.background, ...parsed.background };
                          tempThemeObj.isDark = parsed.isDark ?? true;
                          alert("✅ 调色板 JSON 已加载，点击「预览」查看效果！");
                      } catch(err) { alert("❌ JSON 格式错误"); }
                  };
                  reader.readAsText(file);
              };
              input.click();
          };

          // 左侧功能绑定：图片
          body.querySelector('#m-import-img-btn').onclick = async () => {
              const { open } = window.__TAURI__.dialog;
              const { convertFileSrc } = window.__TAURI__.core || window.__TAURI__.tauri;
              const path = await open({ title: "选择图片", filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
              if(path) {
                  tempThemeObj.background["image-url"] = convertFileSrc(path);
                  alert("✅ 壁纸已加载，点击「预览效果」查看！");
              }
          };

          // 左侧功能绑定：预览
          body.querySelector('#m-preview-btn').onclick = () => {
              tempThemeObj.background["overlay-color"] = body.querySelector('#m-bg-overlay').value;
              tempThemeObj.background["global-blur"] = body.querySelector('#m-bg-blur').value;
              applyTheme(tempThemeObj);
          };

          // 左侧功能绑定：保存入库
          body.querySelector('#m-save-btn').onclick = async () => {
              const name = body.querySelector('#m-save-name').value.trim();
              if(!name) return alert("⚠️ 请输入主题名称");
              
              tempThemeObj.background["overlay-color"] = body.querySelector('#m-bg-overlay').value;
              tempThemeObj.background["global-blur"] = body.querySelector('#m-bg-blur').value;
              
              const newId = 'custom_' + Date.now();
              await dbExecute("INSERT INTO themes (id, name, is_builtin, theme_data) VALUES (?, ?, ?, ?)", 
                  [newId, name, false, JSON.stringify(tempThemeObj)]);
              
              await window.applySelectedTheme(newId);
              body.querySelector('#m-save-name').value = ''; // 清空输入框
          };

      }, async () => { return true; }, { btnText: "完成并关闭" });
  };
  // ==========================================
  // 其他模块代码 (保持不变即可)
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

  const pathTextEl = document.getElementById('data-path-text');
  invoke('get_current_path').then(path => { pathTextEl.innerText = path.replace(/\.json$/, '.db'); });
  document.getElementById('change-path-btn').onclick = () => {
      window.showModal("📁 更改数据存储位置", `<div style="color:var(--text-main); font-size: 14px;">请直接在底部查看您的 my_data.db 文件位置。备份时拷贝该文件即可。</div>`, null, async () => { return true; }); 
  };

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

  const updateBtn = document.getElementById('check-update-btn');
  if (updateBtn) {
      updateBtn.onclick = async () => {
          try {
              updateBtn.innerText = "🔄 正在检查..."; updateBtn.disabled = true;
              const update = await check();
              if (update) {
                  window.showModal("🎉 发现新版本！", `<div style="font-size: 14px; color: var(--text-main);">最新版本：<b style="color: var(--color-primary);">${update.version}</b><br><br><b>更新内容：</b><br><div style="background: var(--overlay-light); padding: 10px; border-radius: 6px; margin-top: 5px; font-size: 13px;">${update.body || '优化体验。'}</div></div>`, null, async () => {
                      const confirmBtn = document.getElementById('global-modal-confirm'); confirmBtn.innerText = "⬇️ 正在下载..."; confirmBtn.disabled = true;
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
  
  const dbTags = await dbQuery("SELECT name, is_active FROM tags");
  appData.settings.active_tags = []; 
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
         <label style="display:flex; align-items:center; gap:5px; cursor:pointer; color: ${isActive ? 'var(--color-success)' : 'var(--text-muted)'};">
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
      let displaySub = sub; if (searchTerm && sub.toLowerCase().includes(searchTerm)) displaySub = `<span style="color:var(--color-primary); font-weight:bold;">${sub}</span>`; 
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

    summary.querySelector('[data-action="edit-main"]').onclick = () => {
      closeMenus();
      window.showModal("✏️ 修改主分类", `
          <div class="form-group"><label class="field-label">主分类名称</label><input type="text" id="m-main-name" class="hero-input" value="${mainTag}"></div>
      `, body => body.querySelector('#m-main-name').focus(), async (body) => {
          const newName = body.querySelector('#m-main-name').value.trim();
          if (!newName || newName === mainTag) return true;
          if (appData.tags.includes(newName)) { alert("⚠️ 该标签名已存在！"); return false; }
          
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
      window.showModal("⚠️ 确认删除主分类", `<div style="font-size:15px;color:var(--text-main);">确定要删除主分类 <b>"${mainTag}"</b> 吗？<br><br><span style="color:var(--text-muted);font-size:13px;">⚠️ 注意：此操作将同时解绑其下方所有的子项目。但已经产生的历史流水记录不受影响。</span></div>`, null, async () => {
          await dbExecute("DELETE FROM tags WHERE name=?", [mainTag]);
          await dbExecute("DELETE FROM sub_tags WHERE main_tag=?", [mainTag]);
          await loadData(); renderSettingsTags(); updateAllDropdowns();
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
    inactiveWrapper.innerHTML = `<summary class="log-summary" style="background: rgba(255, 255, 255, 0.02);"><span class="log-text" style="font-size: 16px; font-weight: bold; color: var(--text-muted);">📦 非活跃标签 (${inactiveTags.length})</span></summary><div class="expanded-content" style="padding: 15px;" id="inactive-list"></div>`;
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