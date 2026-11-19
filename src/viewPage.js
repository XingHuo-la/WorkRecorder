// 视图渲染层：表格以外的形态。
//
// 边界（这是整套分层的地基，别越界）：
//   · 只读 values、只写 values —— 视图能改值，不能加字段、不能改类型；
//   · 不认识 SQL，不知道 record / custom / field_def 这些名字；
//   · 表格形态不在这里 —— 那条路由回 tablePage / sheetPage，复用已经调好的那套。
//
// 一次渲染 = 一个纯函数式的 DOM 重写。没有增量更新，因为一张表的行数是几十到几千，
// 重建比 diff 便宜，也避免上一版状态残留（表格那边踩过大坑）。

import { openRowDrawer } from './rowDrawer.js';
import { escapeHtml } from './htmlUtils.js';
import { showUndoToast } from './undoToast.js';
import { undoStack } from './undoCore.js';
import { saveRowValues, rowTitle, fieldOptionsList } from './sheetStore.js';
import { isDateOnly } from './fieldTypes.js';

const UNGROUPED = '__ungrouped__';

function optionOf(field, value) {
  return fieldOptionsList(field).find(item => String(item.value) === String(value)) || null;
}

// 视图里所有「值 → 可读文本」都走这里。
// 单选要显示 label 而不是 value（'doing' → '进行中'），不然卡片上全是英文键名。
function displayOf(field, value) {
  if (!field || value == null || value === '') return '';
  switch (field.type) {
    case 'checkbox':
      return value === true || value === 'true' ? '是' : '否';
    case 'select': {
      const option = optionOf(field, value);
      return option?.label || String(value);
    }
    case 'multi_select': {
      const list = Array.isArray(value) ? value : [value];
      return list.map(item => optionOf(field, item)?.label || String(item)).filter(Boolean).join('、');
    }
    case 'attachment': {
      const list = Array.isArray(value) ? value : [];
      return list.length ? `${list.length} 个附件` : '';
    }
    case 'date':
      return String(value).slice(0, 10);
    default:
      return String(value);
  }
}

function coverUrlOf(field, value) {
  if (!field || !Array.isArray(value)) return '';
  const image = value.find(item => item && item.path && (item.kind === 'image' || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(item.path)));
  return image ? String(image.path) : '';
}

// 文件路径在 WebView 里不能直接当 src 用，要走 Tauri 的 asset 协议。
function toSrc(path) {
  const text = String(path || '');
  if (!text) return '';
  if (/^(https?:|data:|asset:|blob:)/i.test(text)) return text;
  const normalized = text.replace(/\\/g, '/');
  return `https://asset.localhost/${encodeURIComponent(normalized).replace(/%2F/g, '/')}`;
}

function hexOf(field, value) {
  const option = optionOf(field, value);
  const color = option?.color || option?.tone;
  return /^#[0-9a-f]{3,8}$/i.test(String(color || '')) ? String(color) : '';
}

function fieldByKey(fields, key) {
  if (!key) return null;
  return fields.find(item => item.key === key) || null;
}

function visibleFieldsOf(fields) {
  return fields.filter(field => Number(field.visible) !== 0);
}

function groupFieldOf(fields, config) {
  const picked = fieldByKey(fields, config.groupBy);
  if (picked) return picked;
  // 没配置就自己挑一个：看板必须有分组列，让用户先看到东西，再提供切换入口。
  return (
    fields.find(field => field.type === 'select') ||
    fields.find(field => field.type === 'multi_select') ||
    fields.find(field => field.type === 'checkbox') ||
    null
  );
}

function groupValueOf(field, values) {
  const raw = values[field.key];
  if (field.type === 'multi_select') {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.length ? String(list[0]) : '';
  }
  if (field.type === 'checkbox') return raw === true || raw === 'true' ? 'true' : 'false';
  return raw == null ? '' : String(raw);
}

function groupColumns(field, rows) {
  const columns = [];
  if (field.type === 'select' || field.type === 'multi_select') {
    fieldOptionsList(field).forEach(option => {
      columns.push({ value: String(option.value), label: option.label || String(option.value), color: hexOf(field, option.value) });
    });
  } else if (field.type === 'checkbox') {
    columns.push({ value: 'true', label: '已勾选', color: '' });
    columns.push({ value: 'false', label: '未勾选', color: '' });
  }
  // 数据里出现了选项表里没有的值（老数据、手改过库）：补成列，不能让它凭空消失。
  rows.forEach(row => {
    const value = groupValueOf(field, row.values);
    if (value && !columns.some(column => column.value === value)) {
      columns.push({ value, label: optionOf(field, value)?.label || value, color: hexOf(field, value) });
    }
  });
  columns.push({ value: UNGROUPED, label: '未分组', color: '' });
  return columns;
}

function cardChips(row, fields, { skipKeys = [], limit = 3 } = {}) {
  const chips = [];
  for (const field of visibleFieldsOf(fields)) {
    if (skipKeys.includes(field.key)) continue;
    if (field.type === 'attachment') continue;
    const text = displayOf(field, row.values[field.key]);
    if (!text) continue;
    chips.push(`<span class="vp-chip"><i>${escapeHtml(field.label)}</i>${escapeHtml(text)}</span>`);
    if (chips.length >= limit) break;
  }
  return chips.join('');
}

function openCard(row, fields, table) {
  const list = fields.filter(field => field.key);
  openRowDrawer({
    row,
    fields: list,
    subtitle: table?.name || '',
  });
}

// ==========================================
// 看板
// ==========================================

function renderBoard(root, ctx) {
  const { table, view, fields, rows } = ctx;
  const groupField = groupFieldOf(fields, view.config);
  if (!groupField) {
    root.innerHTML = `<div class="vp-blank">
      <div class="vp-blank-title">这张表还没有能分组的列</div>
      <div class="vp-blank-desc">看板要靠一个「单选」列分栏。去表里加一列单选（比如状态、优先级），再回来切换分组。</div>
    </div>`;
    return;
  }

  const columns = groupColumns(groupField, rows);
  const titleField = fieldByKey(fields, view.config.titleField) || fields.find(field => field.type === 'text') || null;
  const coverField = fieldByKey(fields, view.config.coverField) || null;
  const selectable = fields.filter(field => ['select', 'multi_select', 'checkbox'].includes(field.type));

  root.innerHTML = `<div class="vp-board">
    <div class="vp-board-bar">
      <label class="vp-board-pick">分组
        <select data-vp-group>
          ${selectable
            .map(field => `<option value="${escapeHtml(field.key)}" ${field.key === groupField.key ? 'selected' : ''}>${escapeHtml(field.label)}</option>`)
            .join('')}
        </select>
      </label>
      <span class="vp-board-count">${rows.length} 条</span>
      ${view.config?.lockDrag ? '<span class="vp-lock-hint">已锁定 · 拖动需确认</span>' : ''}
    </div>
    <div class="vp-board-cols" data-vp-cols>
      ${columns
        .map(column => {
          const columnRows = rows.filter(row => {
            const value = groupValueOf(groupField, row.values);
            return column.value === UNGROUPED ? !value : value === column.value;
          });
          return `<section class="vp-col" data-vp-col="${escapeHtml(column.value)}">
            <header class="vp-col-head">
              <span class="vp-col-dot" ${column.color ? `style="background:${escapeHtml(column.color)}"` : ''}></span>
              <span class="vp-col-name">${escapeHtml(column.label)}</span>
              <span class="vp-col-count">${columnRows.length}</span>
            </header>
            <div class="vp-col-body" data-vp-drop="${escapeHtml(column.value)}">
              ${columnRows
                .map(row => {
                  const cover = coverUrlOf(coverField, row.values[coverField?.key]);
                  const title = (titleField && String(row.values[titleField.key] ?? '').trim()) || rowTitle(row.values, fields);
                  return `<article class="vp-card" data-vp-card="${escapeHtml(row.id)}">
                    ${cover ? `<div class="vp-card-cover"><img src="${escapeHtml(toSrc(cover))}" alt="" loading="lazy" /></div>` : ''}
                    <div class="vp-card-title">${escapeHtml(title)}</div>
                    <div class="vp-card-chips">${cardChips(row, fields, { skipKeys: [groupField.key, titleField?.key] })}</div>
                  </article>`;
                })
                .join('')}
              <button type="button" class="vp-col-add" data-vp-add="${escapeHtml(column.value)}">＋ 新建</button>
            </div>
          </section>`;
        })
        .join('')}
    </div>
  </div>`;

  // 事件只绑一次：root 是常驻容器，每次渲染都 addEventListener 会让
  // 一次 drop 触发 N 次写库（拖一次卡片写三遍，撤销栈也跟着乱）。
  // 当前上下文挂在 root 上，处理器每次从那儿取最新的一份。
  root._vpCtx = ctx;
  root._vpGroupField = groupField;
  bindBoardOnce(root);
}

function bindBoardOnce(root) {
  if (root._vpBound) return;
  root._vpBound = true;

  // 切换分组列 = 改视图配置，不动数据。
  root.addEventListener('change', event => {
    if (!event.target.matches?.('[data-vp-group]')) return;
    root._vpCtx?.onConfig?.({ groupBy: event.target.value });
  });

  root.addEventListener('click', event => {
    // 刚拖完的那一下会顺手触发 click，不拦就会「放下卡片 = 打开抽屉」。
    if (Date.now() < (root._vpSuppressClick || 0)) return;
    const ctx = root._vpCtx;
    if (!ctx) return;
    const add = event.target.closest('[data-vp-add]');
    if (add) {
      event.preventDefault();
      ctx.onAddRow?.(root._vpGroupField, add.dataset.vpAdd === UNGROUPED ? '' : add.dataset.vpAdd);
      return;
    }
    const card = event.target.closest('[data-vp-card]');
    if (!card) return;
    const row = ctx.rows.find(item => String(item.id) === String(card.dataset.vpCard));
    if (row) openCard(row, ctx.fields, ctx.table);
  });

  // ---- 拖拽：用 pointer 事件，不用 HTML5 draggable ----
  //
  // 为什么不用 draggable：Tauri 窗口默认开着 dragDropEnabled（用来接外部文件拖放），
  // 它会接管系统级拖放，WebView 里的 HTML5 拖拽只剩一个「禁止」光标 —— 卡片拖不动。
  // 关掉 dragDropEnabled 会牺牲附件拖入，不值得；手势层本来也全是 pointer 事件。
  let press = null;

  const clearDropMark = () =>
    root.querySelectorAll('.vp-col-body.is-over').forEach(el => el.classList.remove('is-over'));

  // 命中测试用 elementFromPoint，而不是 event.target：
  // 指针捕获之后所有事件都指向卡片本身，拿不到「鼠标下面是哪一栏」。
  const bodyUnder = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest?.('[data-vp-drop]') || null;
  };

  const beginDrag = event => {
    const card = press.card;
    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('vp-drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);
    press.ghost = ghost;
    press.moved = true;
    press.ox = event.clientX;
    press.oy = event.clientY;
    card.classList.add('is-dragging');
    document.body.classList.add('is-vp-dragging');
  };

  root.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    // 卡片上的按钮 / 输入控件不参与拖拽（以后加内联操作时不会被误拖）
    if (event.target.closest('button, select, input, textarea')) return;
    const card = event.target.closest('[data-vp-card]');
    if (!card) return;
    press = { card, rowId: card.dataset.vpCard, x: event.clientX, y: event.clientY, moved: false };
    try {
      card.setPointerCapture(event.pointerId);
    } catch (error) {
      /* 不支持捕获时靠 root 冒泡也能收到 move/up */
    }
  });

  root.addEventListener('pointermove', event => {
    if (!press) return;
    if (!press.moved) {
      // 4px 阈值：手抖不该把一次点击变成拖拽
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 4) return;
      beginDrag(event);
    }
    press.ghost.style.transform = `translate(${event.clientX - press.ox}px, ${event.clientY - press.oy}px)`;
    clearDropMark();
    bodyUnder(event.clientX, event.clientY)?.classList.add('is-over');
  });

  const endDrag = event => {
    if (!press) return;
    const state = press;
    press = null;
    clearDropMark();
    state.card.classList.remove('is-dragging');
    document.body.classList.remove('is-vp-dragging');
    state.ghost?.remove();

    if (!state.moved) return; // 只是点了一下，交给 click 打开抽屉
    root._vpSuppressClick = Date.now() + 300;
    const body = bodyUnder(event.clientX, event.clientY);
    if (!body) return;
    void applyDrop(root, state.rowId, body.dataset.vpDrop);
  };

  root.addEventListener('pointerup', event => { endDrag(event); });

  root.addEventListener('pointercancel', () => {
    if (!press) return;
    const state = press;
    press = null;
    clearDropMark();
    state.card.classList.remove('is-dragging');
    document.body.classList.remove('is-vp-dragging');
    state.ghost?.remove();
  });
}

// 落库：把「卡片换栏」翻译成「改 groupBy 那一列的值」。
// 这是视图唯一的写入口 —— 视图能改值，不能改结构。
//
// 两条安全线（一回事的两面）：
//   · 锁开着的看板，每次落卡片都要人点头 —— 挡的是「手一滑改了数据却没察觉」；
//   · 落完登记进全局撤销栈，Ctrl+Z 一步撤回 —— 挡的是「确实滑了，但要能立刻回滚」。
// 两者都必须走，只留一条都会让用户不敢拖。
async function applyDrop(root, rowId, target) {
  const ctx = root._vpCtx;
  const groupField = root._vpGroupField;
  if (!ctx || !groupField) return;
  const row = ctx.rows.find(item => String(item.id) === String(rowId));
  if (!row) return;

  const before = groupValueOf(groupField, row.values);
  const after = target === UNGROUPED ? '' : target;
  if (before === after) return;

  const labelOf = value => optionOf(groupField, value)?.label || value || '未分组';
  const title = rowTitle(row.values, ctx.fields) || '这条记录';

  if (ctx.view?.config?.lockDrag) {
    if (typeof ctx.confirm !== 'function') {
      showUndoToast('看板已锁定，但这里拿不到确认框，这次移动没有执行', null, { duration: 5000 });
      return;
    }
    const ok = await ctx.confirm({
      title: '确认移动这张卡片',
      message: `${title}\n${labelOf(before)} → ${labelOf(after)}`,
      btnText: '移动',
    });
    // 等确认的这几秒里用户可能已经切了视图/表，ctx 过期就别往旧数据上写
    if (!ok || root._vpCtx !== ctx) return;
  }

  const rawOf = value => (groupField.type === 'multi_select' ? (value ? [value] : []) : value);
  const previous = Array.isArray(row.values[groupField.key]) ? [...row.values[groupField.key]] : row.values[groupField.key];

  const apply = raw => {
    row.values[groupField.key] = Array.isArray(raw) ? [...raw] : raw;
  };

  // 写回统一走宿主给的 saveRow：预置表和自建表的物理落点不一样
  // （真列 vs custom JSON），这一层不该知道区别。
  const settle = async () => {
    if (typeof ctx.saveRow === 'function') await ctx.saveRow(row, row.values);
    else await saveRowValues(row.id, row.values);
  };

  // 撤销/重做失败：说清原因，然后把错误抛回去 ——
  // 栈收到异常会把这步放回历史，不然这次操作就凭空消失了。
  const failWith = verb => error => {
    showUndoToast(`${verb}失败：${escapeHtml(String(error?.message || error))}`, null, { duration: 5000 });
    throw error;
  };

  // 重画优先让宿主重新取一次数据（行对象可能已经被换掉），拿不到就自己画一遍。
  const repaint = async () => {
    ctx.onChanged?.();
    if (typeof ctx.refresh === 'function') await ctx.refresh();
    else renderBoard(root, ctx);
  };

  // 「这块看板还在眼前吗」：重画之后 root._vpCtx 会换成新对象，
  // 所以不能比对象身份，只能比「哪张表的哪个视图」。
  const stillLive = () => {
    const live = root._vpCtx;
    if (!live) return false;
    return String(live.table?.id) === String(ctx.table?.id)
      && String(live.view?.id) === String(ctx.view?.id);
  };

  // 一次移动 = 写库 + 重画。前进、撤销、重做都走这一个函数，
  // 保证三条路行为一致（也保证「撤销」不会绕过落库只改界面）。
  const moveTo = async raw => {
    // 只在「这张看板还在眼前」时才写。走开之后再回滚，写的是这份早就过期的
    // 整行数据（适配器按整行保存），会把这期间在抽屉里改的内容盖掉。
    // 宁可这次不撤，也不要在看不见的地方改数据。
    if (!stillLive()) {
      showUndoToast('已经切走了，这次撤回没有执行（数据没动）', null, { duration: 5000 });
      return;
    }
    const next = String(groupValueOf(groupField, row.values));
    const goal = Array.isArray(raw) ? String(raw[0] ?? '') : raw == null ? '' : String(raw);
    if (next === goal) return; // 已经在这个值上：重复撤销/重做不再写库
    const snapshot = row.values[groupField.key];
    apply(raw);
    try {
      await settle();
    } catch (error) {
      // 库没写成，内存里也别留着假象，否则下次重画就是「看起来改了、其实没改」
      apply(snapshot);
      throw error;
    }
    await repaint();
  };

  // 乐观更新：先动界面，写库失败再退回来。拖拽必须跟手，不能等 await。
  apply(rawOf(after));
  renderBoard(root, ctx);

  try {
    await settle();
  } catch (error) {
    apply(previous);
    renderBoard(root, ctx);
    showUndoToast(`改分组失败：${escapeHtml(String(error?.message || error))}`, null, { duration: 5000 });
    return;
  }

  ctx.onChanged?.();

  // 提示条只报「改成了什么 + 怎么撤回」，不再挂撤销按钮：
  // 撤销只有一条路（全局栈），两个入口会让人按完按钮又按 Ctrl+Z，撤两次。
  showUndoToast(`已移到「${escapeHtml(labelOf(after))}」 · Ctrl+Z 撤销`);

  undoStack.push({
    label: `「${title}」移到「${labelOf(after)}」`,
    // 一秒内连拖同一张卡合并成一步：拖三下要按三次 Ctrl+Z，和「简单点」正好相反。
    mergeKey: `vp-move:${row.id}:${groupField.key}`,
    undo: () => moveTo(previous).catch(failWith('撤销')),
    redo: () => moveTo(rawOf(after)).catch(failWith('重做')),
  });
}

// ==========================================
// 画廊
// ==========================================

function renderGallery(root, ctx) {
  const { table, view, fields, rows } = ctx;
  const titleField = fieldByKey(fields, view.config.titleField) || fields.find(field => field.type === 'text') || null;
  const coverField =
    fieldByKey(fields, view.config.coverField) ||
    fields.find(field => field.type === 'attachment' && /(图|封面|截图|image|cover|photo)/i.test(field.label)) ||
    fields.find(field => field.type === 'attachment') ||
    null;

  const imageFields = fields.filter(field => field.type === 'attachment');
  // 摘要取「第一个不是标题的文本列」，而不是硬抠 key='detail' ——
  // 那样只有预置表能用，自建表一律没摘要。
  const descField = fields.find(
    field => field.type === 'text' && field.key !== titleField?.key && Number(field.visible) !== 0
  ) || null;

  if (!rows.length) {
    root.innerHTML = `<div class="vp-blank">
      <div class="vp-blank-title">这张表还没有数据</div>
      <div class="vp-blank-desc">画廊把每条记录排成一张卡片。先建一条，卡片就出来了。</div>
    </div>`;
    return;
  }

  root.innerHTML = `<div class="vp-gallery">
    <div class="vp-gallery-bar">
      ${imageFields.length > 1
        ? `<label class="vp-board-pick">封面
            <select data-vp-cover>
              ${imageFields
                .map(field => `<option value="${escapeHtml(field.key)}" ${field.key === coverField?.key ? 'selected' : ''}>${escapeHtml(field.label)}</option>`)
                .join('')}
            </select>
          </label>`
        : '<span class="vp-gallery-hint">卡片</span>'}
      <span class="vp-board-count">${rows.length} 条</span>
    </div>
    <div class="vp-gallery-grid">
      ${rows
        .map(row => {
          const cover = coverUrlOf(coverField, row.values[coverField?.key]);
          const title = (titleField && String(row.values[titleField.key] ?? '').trim()) || rowTitle(row.values, fields);
          const detail = descField ? displayOf(descField, row.values[descField.key]) : '';
          return `<article class="vp-tile" data-vp-card="${escapeHtml(row.id)}">
            <div class="vp-tile-cover">${cover ? `<img src="${escapeHtml(toSrc(cover))}" alt="" loading="lazy" />` : '<span class="vp-tile-empty">无封面</span>'}</div>
            <div class="vp-tile-body">
              <div class="vp-card-title">${escapeHtml(title)}</div>
              ${detail ? `<div class="vp-tile-desc">${escapeHtml(detail.slice(0, 80))}</div>` : ''}
              <div class="vp-card-chips">${cardChips(row, fields, { skipKeys: [titleField?.key, coverField?.key], limit: 2 })}</div>
            </div>
          </article>`;
        })
        .join('')}
    </div>
  </div>`;

  root.querySelector('[data-vp-cover]')?.addEventListener('change', event => {
    ctx.onConfig?.({ coverField: event.target.value });
  });

  root.querySelector('.vp-gallery-grid')?.addEventListener('click', event => {
    const card = event.target.closest('[data-vp-card]');
    if (!card) return;
    const row = rows.find(item => String(item.id) === String(card.dataset.vpCard));
    if (row) openCard(row, fields, table);
  });
}

// ==========================================
// 日历
// ==========================================
//
// 最小可用：月网格 + 按日期列落点 + 在格子里新建。
// 刻意不做的三件（等真有人用起来再加）：
//   · 拖拽改日期 —— 看板那套 pointer 手势能复用，但「拖错了」的代价比看板大
//     （日期是单值，拖走就没有痕迹），先把只读看明白；
//   · 跨天事件（开始/结束两列）—— 现在一条记录只有一个日期列的值；
//   · 「＋N」展开 —— 一天超过 3 条时点开当日列表，得配一个日视图。

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const CAL_ITEMS_PER_DAY = 3;

// 翻到哪个月是「我眼下在看什么」，不是这张视图的定义 —— 所以不进 view.config
// （写进库会变成「上次停在 3 月，这次打开还是 3 月」），只在本次会话里记着。
const calendarMonth = new Map();

const pad2 = value => String(value).padStart(2, '0');

function dayKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// 只认前 10 位的 YYYY-MM-DD：日期列的值可能带时间（YYYY-MM-DD HH:MM）。
// 手工拆而不走 new Date(str) —— 后者按 UTC 解析，东八区会把 1 号算成上月最后一天。
function parseDayOf(text) {
  const match = String(text ?? '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function calendarDateField(fields, config) {
  return (
    fieldByKey(fields, config.dateField) ||
    fields.find(field => field.type === 'date' && Number(field.visible) !== 0) ||
    fields.find(field => field.type === 'date') ||
    null
  );
}

// 新建时给的值要与列精度一致：只到日的列收 YYYY-MM-DD，
// 带时间的列补 00:00 —— 否则日期渲染里 slice(11,16) 拿到空串，会显示成一个孤零零的日期。
function dayValueFor(field, key) {
  return isDateOnly(field) ? key : `${key} 00:00`;
}

function renderCalendar(root, ctx) {
  const { table, view, fields, rows } = ctx;
  const dateFields = fields.filter(field => field.type === 'date');
  const dateField = calendarDateField(fields, view.config);

  if (!dateField) {
    root.innerHTML = `<div class="vp-blank">
      <div class="vp-blank-title">这张表还没有日期列</div>
      <div class="vp-blank-desc">日历要把每条记录落到某一天上。去表里加一列「日期」类型，再回来。</div>
    </div>`;
    return;
  }

  const todayKey = dayKeyOf(new Date());
  const anchor = calendarMonth.get(String(view.id)) || todayKey.slice(0, 7);
  const [year, month] = anchor.split('-').map(Number);
  const first = new Date(year, month - 1, 1);
  // 周一为一周之始：getDay() 里周日是 0，换算成「距离本周一几天」
  const lead = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month - 1, 1 - lead);

  const byDay = new Map();
  let unscheduled = 0;
  rows.forEach(row => {
    const day = parseDayOf(row.values[dateField.key]);
    if (!day) {
      unscheduled += 1;
      return;
    }
    const key = dayKeyOf(day);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  });

  const titleField =
    fieldByKey(fields, view.config.titleField) || fields.find(field => field.type === 'text') || null;
  const monthCount = rows.filter(row => {
    const day = parseDayOf(row.values[dateField.key]);
    return day && dayKeyOf(day).startsWith(anchor);
  }).length;

  // 固定 42 格（6 周）：月份切换时高度不跳，翻两个月不会看到表格在抖。
  let cells = '';
  for (let index = 0; index < 42; index += 1) {
    const day = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    const key = dayKeyOf(day);
    const out = key.slice(0, 7) !== anchor;
    const dayRows = byDay.get(key) || [];
    const shown = dayRows.slice(0, CAL_ITEMS_PER_DAY);
    const rest = dayRows.length - shown.length;
    cells += `<div class="vp-cal-day${out ? ' is-out' : ''}${key === todayKey ? ' is-today' : ''}" data-vp-day="${key}">
      <div class="vp-cal-head">
        <span class="vp-cal-num">${day.getDate()}</span>
        <button type="button" class="vp-cal-add" data-vp-add="${key}" title="在 ${key} 新建一条" aria-label="在 ${key} 新建一条">＋</button>
      </div>
      <div class="vp-cal-items">
        ${shown
          .map(row => {
            const title =
              (titleField && String(row.values[titleField.key] ?? '').trim()) || rowTitle(row.values, fields);
            return `<button type="button" class="vp-cal-item" data-vp-card="${escapeHtml(row.id)}" title="${escapeHtml(
              title
            )}">${escapeHtml(title)}</button>`;
          })
          .join('')}
        ${rest > 0 ? `<span class="vp-cal-rest">还有 ${rest} 条</span>` : ''}
      </div>
    </div>`;
  }

  root.innerHTML = `<div class="vp-cal">
    <div class="vp-cal-bar">
      <div class="vp-cal-nav">
        <button type="button" class="vp-cal-step" data-vp-step="-1" aria-label="上个月">‹</button>
        <button type="button" class="vp-cal-step is-text" data-vp-today>今天</button>
        <button type="button" class="vp-cal-step" data-vp-step="1" aria-label="下个月">›</button>
        <span class="vp-cal-title">${year} 年 ${month} 月</span>
      </div>
      <div class="vp-cal-meta">
        ${
          dateFields.length > 1
            ? `<label class="vp-board-pick">日期列
                <select data-vp-date>
                  ${dateFields
                    .map(
                      field =>
                        `<option value="${escapeHtml(field.key)}"${
                          field.key === dateField.key ? ' selected' : ''
                        }>${escapeHtml(field.label)}</option>`
                    )
                    .join('')}
                </select>
              </label>`
            : ''
        }
        <span class="vp-board-count">本月 ${monthCount} 条${unscheduled ? ` · 未排期 ${unscheduled} 条` : ''}</span>
      </div>
    </div>
    <div class="vp-cal-week">${WEEK_LABELS.map(label => `<span>${label}</span>`).join('')}</div>
    <div class="vp-cal-grid">${cells}</div>
  </div>`;

  // 翻月只重画自己，不走 ctx.refresh —— 那里会重新查库，翻个月不该发 SQL。
  const move = offset => {
    const next = new Date(year, month - 1 + offset, 1);
    calendarMonth.set(String(view.id), dayKeyOf(next).slice(0, 7));
    renderCalendar(root, ctx);
  };

  root.querySelectorAll('[data-vp-step]').forEach(button => {
    button.addEventListener('click', () => move(Number(button.dataset.vpStep)));
  });
  root.querySelector('[data-vp-today]')?.addEventListener('click', () => {
    calendarMonth.delete(String(view.id));
    renderCalendar(root, ctx);
  });
  root.querySelector('[data-vp-date]')?.addEventListener('change', event => {
    ctx.onConfig?.({ dateField: event.target.value });
  });

  root.querySelector('.vp-cal-grid')?.addEventListener('click', event => {
    const add = event.target.closest('[data-vp-add]');
    if (add) {
      ctx.onAddRow?.(dateField, dayValueFor(dateField, add.dataset.vpAdd));
      return;
    }
    const card = event.target.closest('[data-vp-card]');
    if (!card) return;
    const row = rows.find(item => String(item.id) === String(card.dataset.vpCard));
    if (row) openCard(row, fields, table);
  });
}

// ==========================================
// 入口
// ==========================================

export function renderView(root, ctx) {
  if (!root) return;
  const form = ctx?.view?.form || 'table';
  if (form === 'board') {
    renderBoard(root, ctx);
    return;
  }
  if (form === 'gallery') {
    renderGallery(root, ctx);
    return;
  }
  if (form === 'calendar') {
    renderCalendar(root, ctx);
    return;
  }
  root.innerHTML = `<div class="vp-blank">
    <div class="vp-blank-title">这个形态还在路上</div>
    <div class="vp-blank-desc">先把视图切回「表格」或「看板」，不影响任何数据。</div>
  </div>`;
}
