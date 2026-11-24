// 下拉面板的「贴到单元格上」定位。
//
// 抽出来的原因：多选下拉（选项）和记录选择器（关联字段）都要这一套，
// 而这里的几个判断都是踩出来的 —— 复制一份必然漂移：
//   · 宽度 = 单元格宽，但不小于 minWidth，也不超出窗口；
//   · 下面放得下就永远朝下，只有下面真放不下、上面更宽裕时才上翻；
//   · 必须先把 max-height 放开再量，否则上一轮算出的限高会把这一轮算小；
//   · 量之前先 visibility:hidden —— 面板宽度未定前的高度是按「折行」算的假值。
//
// 这里只碰 DOM 样式，不读业务状态，所以不依赖任何模块（fieldTypes / relationField 共用）。

const GAP = 4; // 与单元格留 4px，鼠标不用横跳
const PAD = 8; // 离窗口边缘至少 8px

/**
 * 把 panel 摆到 anchorEl 旁边（优先下方）。
 * @param {HTMLElement} panel  已挂进 document 的面板
 * @param {HTMLElement} anchorEl  单元格
 * @param {{minWidth?:number, maxWidth?:number}} [opts]
 */
export function placeDropdown(panel, anchorEl, opts = {}) {
  if (!panel || !anchorEl || !panel.isConnected) return;
  const minWidth = Number(opts.minWidth) > 0 ? Number(opts.minWidth) : 200;
  const maxWidth = Number(opts.maxWidth) > 0 ? Number(opts.maxWidth) : window.innerWidth - 16;

  // 先藏起来：宽度定下来之前量到的高度不作数
  panel.style.visibility = 'hidden';
  panel.style.top = '0px';

  const anchor = anchorEl.getBoundingClientRect(); // 每次现取：面板开着时窗口可能被拉大
  const panelWidth = Math.min(Math.max(anchor.width, minWidth), maxWidth);
  panel.style.width = `${panelWidth}px`;
  panel.style.left = `${Math.max(PAD, Math.min(anchor.left, window.innerWidth - panelWidth - PAD))}px`;

  const below = window.innerHeight - PAD - (anchor.bottom + GAP);
  const above = anchor.top - GAP - PAD;
  // 量之前先放开限高，否则上一次算出的 maxHeight 会把这次的结果算小
  panel.style.maxHeight = '';
  const natural = panel.offsetHeight;
  const openUp = natural > below && above > below;
  const room = Math.max(120, openUp ? above : below);
  if (natural > room) panel.style.maxHeight = `${room}px`;
  const height = Math.min(natural, room);
  const top = openUp
    ? Math.max(PAD, anchor.top - GAP - height)
    : Math.min(anchor.bottom + GAP, window.innerHeight - PAD - height);
  panel.style.top = `${Math.round(top)}px`;
  panel.style.visibility = '';
}
