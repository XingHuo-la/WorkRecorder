import { appData, dbExecute, DEFAULT_TAG } from './data.js';
import { escapeHtml } from './htmlUtils.js';

/**
 * 🌟 通用高阶表单弹窗构造器 (支持多主题与全模块适配)
 * * @param {string} title - 弹窗标题
 * @param {Object} item - 当前要编辑的数据对象 (log 或 todo)
 * @param {Object} options - 核心配置项
 * @param {string} options.type - 'log' | 'todo' (决定是否显示发生时间等特定字段)
 * @param {string} options.dateStr - 所属日期 (仅流水类型需要传入)
 * @param {string} options.themeClass - 🎨 预留主题参数: 如 'theme-cyberpunk', 'theme-ocean'
 * @param {Function} options.onRestore - ⏪ 撤销完成的回调 (仅当是已完成待办的流水时有效)
 * @param {Function} options.onSave - 💾 保存成功后的回调，返回处理后的干净数据
 */
export function openUniversalEditModal(title, item, options) {
    const { type, dateStr, themeClass = '', onRestore, onSave } = options;
    
    // 1. 数据清洗与状态判断
    const isLog = type === 'log';
    const isCompletedTodo = isLog && (!!item.linked_todo || item.text.includes("完成待办"));
    const cleanText = isLog ? 
        (item.text.startsWith("完成待办: ") ? item.text.replace("完成待办: ", "").trim() : item.text) 
        : (item.task || "");

    // 🌟 新增：对清洗后的文本进行安全转义
    const safeText = escapeHtml(cleanText);
    const safeDetail = escapeHtml(item.detail);
    const safeStartAt = escapeHtml(item.start_at || '');
    const safeEndAt = escapeHtml(item.end_at || item.deadline || '');

    // 2. 动态生成特定模块的 HTML 组件
    const restoreBtnHtml = (isCompletedTodo && onRestore) ?
        `<button type="button" id="u-restore-btn" style="width:100%; margin-bottom: 20px; padding: 10px; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; background: rgba(250, 204, 21, 0.15); color: #facc15; border: 1px dashed rgba(250, 204, 21, 0.4); transition: all 0.2s;">⏪ 撤销完成：从流水中移除，并恢复为未完成待办</button>` : "";

    const timeFieldHtml = isLog ? 
        `<div class="field-col"><label class="field-label">🕒 发生时间</label><input type="text" id="u-item-time" class="datetime-input" style="width:100% !important;" value="${escapeHtml(dateStr)} ${escapeHtml(item.time)}"></div>` : "";
    const dateFieldsHtml = isLog
        ? `<div class="field-col"><label class="field-label">📅 截至日期</label><input type="text" id="u-item-deadline" class="datetime-input" style="width:100% !important;" value="${safeEndAt}" placeholder="(点击选择...)"></div>`
        : `<div class="field-col"><label class="field-label">📅 计划开始</label><input type="text" id="u-item-start" class="datetime-input" style="width:100% !important;" value="${safeStartAt}" placeholder="(可选...)"></div>
           <div class="field-col"><label class="field-label">📅 计划结束</label><input type="text" id="u-item-deadline" class="datetime-input" style="width:100% !important;" value="${safeEndAt}" placeholder="(可选...)"></div>`;

    // 3. 构建核心 HTML 模板 (🌟 注意这里的 value="\${safeText}" 和 textarea 里的 \${safeDetail})
    const formHtml = `
        ${restoreBtnHtml}
        <div class="form-group"><label class="field-label">✨ 核心内容</label><input type="text" id="u-item-text" class="hero-input" value="${safeText}"></div>
        <div class="form-row">
            <div class="field-col"><label class="field-label">🏷️ 主分类</label>
                <select id="u-item-tag" class="hero-input select-hero"></select>
                <input type="text" id="u-item-tag-new" class="hero-input" style="display:none; margin-top:8px;" placeholder="输入新主分类...">
            </div>
            <div class="field-col"><label class="field-label">📁 子项目</label>
                <select id="u-item-sub" class="hero-input select-hero"></select>
                <input type="text" id="u-item-sub-new" class="hero-input" style="display:none; margin-top:8px;" placeholder="输入新子项目...">
            </div>
        </div>
        <div class="form-group"><label class="field-label">📝 详细说明</label><textarea id="u-item-detail" class="hero-textarea">${safeDetail}</textarea></div>
        <div class="form-row">
            ${timeFieldHtml}
            ${dateFieldsHtml}
        </div>
    `;

    // 4. 调用全局弹窗并注入逻辑
    window.showModal(title, formHtml, (body) => {
        const tagSel = body.querySelector('#u-item-tag'); const tagNew = body.querySelector('#u-item-tag-new');
        const subSel = body.querySelector('#u-item-sub'); const subNew = body.querySelector('#u-item-sub-new');
        
        // --- 标签联动逻辑提取 ---
        appData.tags.forEach(t => {
            const safeTag = escapeHtml(t);
            tagSel.innerHTML += `<option value="${safeTag}" ${t===item.tag?'selected':''}>${safeTag}</option>`;
        });
        tagSel.innerHTML += `<option value="NEW">➕ 新建主分类...</option>`;
        
        const updateSubs = () => {
            subSel.innerHTML = '<option value="">(无子项目)</option>';
            const mTag = tagSel.value === 'NEW' ? tagNew.value.trim() : tagSel.value;
            if (mTag && appData.sub_tags[mTag]) appData.sub_tags[mTag].forEach(t => {
                const safeSub = escapeHtml(t);
                subSel.innerHTML += `<option value="${safeSub}" ${t===item.sub_tag?'selected':''}>${safeSub}</option>`;
            });
            subSel.innerHTML += `<option value="NEW">➕ 新建子项目...</option>`;
        }; 
        updateSubs();

        tagSel.onchange = () => { tagNew.style.display = tagSel.value === 'NEW' ? 'block' : 'none'; if(tagSel.value === 'NEW') tagNew.focus(); subNew.style.display = 'none'; updateSubs(); };
        tagNew.oninput = updateSubs;
        subSel.onchange = () => { subNew.style.display = subSel.value === 'NEW' ? 'block' : 'none'; if(subSel.value === 'NEW') subNew.focus(); };

        // --- 撤销按钮绑定 ---
        if (isCompletedTodo && onRestore) {
            const restoreBtn = body.querySelector('#u-restore-btn');
            if (restoreBtn) restoreBtn.onclick = () => onRestore(cleanText);
        }

        // --- 日历防遮挡逻辑提取 ---
        const fpOptions = {
            ...window.fpGlobalConfig,
            onOpen: function(selectedDates, dStr, instance) {
                const modal = instance.element.closest('.custom-modal');
                if (modal) { modal.style.paddingBottom = '370px'; setTimeout(() => modal.scrollTo({ top: modal.scrollHeight, behavior: 'smooth' }), 50); }
            },
            onClose: function(selectedDates, dStr, instance) {
                const modal = instance.element.closest('.custom-modal');
                if (modal) modal.style.paddingBottom = '25px'; 
            }
        };
        if (isLog) flatpickr(body.querySelector('#u-item-time'), fpOptions);
        if (!isLog) flatpickr(body.querySelector('#u-item-start'), fpOptions);
        flatpickr(body.querySelector('#u-item-deadline'), fpOptions);

    }, async (body) => {
        // 5. 统一的数据获取与校验层
        const result = {
            text: body.querySelector('#u-item-text').value.trim(),
            detail: body.querySelector('#u-item-detail').value.trim(),
            deadline: body.querySelector('#u-item-deadline').value,
            start_at: isLog ? "" : body.querySelector('#u-item-start').value,
        };

        if (!result.text) { alert("⚠️ 核心内容不能为空"); return false; }
        if (!isLog && result.start_at && result.deadline && new Date(result.start_at) > new Date(result.deadline)) {
            alert("⚠️ 计划开始时间不能晚于结束时间");
            return false;
        }

        let finalTag = body.querySelector('#u-item-tag').value;
        if (finalTag === 'NEW') {
            finalTag = body.querySelector('#u-item-tag-new').value.trim() || DEFAULT_TAG;
            if (finalTag !== DEFAULT_TAG && !appData.tags.includes(finalTag)) {
                await dbExecute("INSERT OR IGNORE INTO tags (name, is_active) VALUES (?, ?)", [finalTag, true]);
                appData.tags.push(finalTag);
            }
        }
        finalTag = finalTag || DEFAULT_TAG;
        result.tag = finalTag;

        let finalSub = body.querySelector('#u-item-sub').value;
        if (finalSub === 'NEW') {
            finalSub = body.querySelector('#u-item-sub-new').value.trim();
            if (finalSub) {
                if (!appData.sub_tags[finalTag]) appData.sub_tags[finalTag] = [];
                if (!appData.sub_tags[finalTag].includes(finalSub)) {
                    await dbExecute("INSERT INTO sub_tags (main_tag, name) VALUES (?, ?)", [finalTag, finalSub]);
                    appData.sub_tags[finalTag].push(finalSub);
                }
            }
        }
        result.sub_tag = finalSub;

        // 如果是流水，单独处理跨天时间逻辑
        if (isLog) {
            const dateTimeVal = body.querySelector('#u-item-time').value;
            const [newDateStr, newTimeStr] = dateTimeVal.includes(' ') ? dateTimeVal.split(' ') : [dateStr, dateTimeVal];
            result.newDateStr = newDateStr;
            result.newTimeStr = newTimeStr;
        }

        // 将干净的数据丢回给业务层保存
        if (onSave) return await onSave(result);
        return true;
    }, { themeClass }); // 传入预留的主题配置
}
