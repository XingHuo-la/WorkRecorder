# WorkRecorder v15 主线：表 / 字段 / 视图

> 一句话：**表存数据，视图只存看法。**
> 一张表 = `sheet` 里一条记录（`kind` 标「预置／普通」）；字段集中在 `field_def`；
> 视图是绑定某张表的一行配置（形态 + 配置 + 归属）。
>
> 本文是这条主线的唯一进度表。阶段状态以最后一次真实验证为准，不按计划表想当然。

## 阶段表

| 阶段 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| **P1 地基** | 给基础表建一条表记录（带「预置／普通」标记）；建 `table_field` 只读 union 视图；把 log 行的真实列翻成 `values` 的适配抽出来共用 | 基础表页面行为零变化，probe 45/45 仍全部通过 | ✅ 已完成（v15 迁移；`sheet.kind` + `field_def` + `resolveCaptureTable`） |
| **P2 视图对象** | 建视图表（绑定表 + 形态 + 配置 + 归属）；侧栏改「表」；表内页签 | 能给任意表建第二个表格视图，只改列序和筛选，数据一条不加 | ✅ 已完成（`view_def`；表内页签；视图重命名/删除；`lockDrag`） |
| **P2.5 网格合流**（本轮新增） | 把预设表并到 `sheetPage`：去掉 `main.js applyView()` 里 `preset → #rec-table-pane(tablePage.js)` 这条分叉，预设表改走 `#sheet-pane`。迁移清单：工具栏（全部/今天/待整理/字段/筛选/排序/主分类/子项目）、行详情抽屉、字段面板入口、`mountGestures`（填充柄 + 行高）、行高/列宽写库适配器 | ① 工作记录页逐项零回退（行高拖、框选、填充柄、撤销、列菜单、行号、编辑态、行详情）；② 全库只剩一套网格 CSS 在生效，`.wr-*` 不再被任何页面引用；③ `tablePage.js` 可下线 | 🚧 步① ✅ 步② ✅，**默认已切 sheet**，观察一周后删 `tablePage.js` |
| **P3 四种形态** | 表格（复用现有）→ 看板 → 日历 → 画廊 | 看板优先做——它一次验掉「分组靠单选列」「拖卡片 = 改字段值」两条关键约定 | 🚧 看板 ✅ / 画廊 ✅ / **日历 ⬜**（`view_def.forms` 里 `ready:false`） |
| **P4 写回闭环** | 视图内增行（默认值规则）、删行（软删除 + 撤销）、拖拽换组 | 在看板里加一张卡片，切回表格能看到状态和创建时间都在 | 🚧 增行 ✅ / 拖拽换组 ✅（带锁 + Ctrl+Z）/ 删行+撤销待补 |
| **P5 收尾** | `url` 类型、`attachment.accept`、导出可搬移包（库 + assets 一起） | 导出的包换台机器能直接打开 | ⬜ 未开始（`url`/`accept` 已排，导出包未动） |

## P2.5 进度

**步① 数据层（已完成）** —— `sheetPage` 不再只认自建表：

| 能力 | 落点 | 验证 |
|---|---|---|
| 读字段 | `readTableFields(table)`：预置表读 `field_def`，自建表读 `sheet_field` | 7 个字段、key/type 与 `presetValues` 对齐 |
| 读行 | `readTableRows(table)`：预置表读 `kind='log'` 且 `sheet_id` 为空的行，摊成 values | 45 行，`status` 已归一（inbox→unprocessed） |
| 改值 | `saveTableRow(table, row, values)`：预置表落真列 + 合并 custom | 改完 `title/status/happened_date` 三列同时变 |
| 增行 | `insertTableRow` / `insertTableRowsAt` / `duplicateTableRow` | 新行 `kind='log'`、`sheet_id=NULL`、状态归一 |
| 字段增删改 | `createTableField` / `patchTableField` / `deleteTableField` | 只写 `field_def`，**不会**在 `sheet_field` 里留副本（实测 0 行） |

`sheetPage` 侧只做了一件事：把 `loadFields/loadRows/saveRowValues/insertRow/...` 换成上表这几个，
字段三件套用同名分派器（`const patchField = (id, patch) => patchTableField(state.sheet, id, patch)`），
所以 15 处调用点一行没动。预设表「＋新建」补了既定形状（今天 + 未分类 + 待开始），与老基础表一致。

**步② 工具栏（已完成）** —— 预设表表头那排「全部/今天/待整理 + 主分类/子项目」搬进表内：

- 结构：`sheetPage.toolbarHtml()` 末尾输出 `.sh-filterbar`，里面装 `.sh-quick`（三个 `.v4-chip` + 分隔线 + 两个下拉）
  和原有的 `.sh-chips`（手写条件）。两者都是「我在看哪一段」，共用一条横带，省一格行高；非预置表只出 `.sh-chips`。
- 状态：`presetQuick = { mode, tag, sub }` 独立成一份，**不入 `state.filters`** ——
  否则「清除筛选」会把刚点的「今天」一起清掉。
- 合流：`activeFilters()` 是唯一入口，`filterRows()` 只认它；筛选面板仍然读写 `state.filters`，两边互不干扰。
- 候选值：主分类/子项目从现有行的 `values` 里取（`field_def.options` 是 `{"source":"tags"}`，没有静态列表）。
- 切换表 / 重进表：`resetPresetQuick()` 归零，避免「切到另一张表还挂着今天，看着像空表」。
- 「＋新建记录」在预置表下补默认值（今天 / 未分类 / 待开始），与老基础表一致。

同时定了三件合流必须先解决的事：

1. **详情页收起 `sheetPage` 自带的占位 tab**（`.sheet-pane .sh-views` 隐藏）。
   `#view-bar` 已经有真视图页签、同样以「表格」打头；两排并排、一排能切一排点了弹「还没做」，只会让人以为界面坏了。
2. **快捷栏 chip 高度写死 27**（`.sh-quick .v4-chip`）。逐层关样式表实测：`styles-v4` 那条 27 在这条 DOM 路径上算成 32，
   拿掉 `styles-v3` 反而变 38 —— 有别层在抬它。不改 `.v4-chip` 本身，免得页面表头那排跟着变。
3. **进编辑的行为只能有一套**（合流后暴露的真实差异，与「哪张表」无关，只与列设置有关）：
   - 光标一律落在文字末尾、不整段选中（`placeCaretAtEnd`）。以前单行走 `input.select()`、换行列走
     `setSelectionRange(len,len)`，于是基础表双击反白、自建表双击不反白 —— 用户读成「还是两套表格」。
   - 编辑器不许拉满格子：换行列的 `align-self` 从 `stretch` 改成 `auto`，跟随单元格自己的 `align-items`
     （普通行顶对齐 / 拖高过的行居中 / 格式面板的 `is-v-top|middle|bottom`），并把 `height` 交回内容
     （`field-sizing:content`，老内核用 important 的 inline 高度兜底）。原来 `stretch` 在 200px 的行里
     等于「文字从顶上第一行开始写」，一进编辑文字就跳到顶端。
   - 顺带补回合流时漏接的 `opts.char`（`startCellEdit`）：选中一格直接打字，旧表会用它覆盖原值，
     新网格没接 —— 那个字符会被吃掉，什么也不会发生。
   三条都由 `_debug/editstate-probe.html` 用像素断言钉住（同一格的「静态文字 y」与「编辑态第一行 y」差 ≤3px）。

**现在的默认**：`presetGridIsSheet()` 返回 true（走 sheetPage）。
回退老基础表：`localStorage.setItem('wrPresetGrid', 'legacy')` 然后刷新；恢复 `removeItem`。
观察一周零回退后再删 `tablePage.js` 与 `.wr-*` 规则。

## P2.5 为什么插在 P2 和 P3 之间

**决定性取舍：不是为了让 P3/P4 跑得动，而是为了不再维护两套网格。**

- P3/P4 全在视图层（`viewPage.js`），一行都不碰网格 → 合流**不阻塞**它们。
- 但今天同一个产品里有两套表格内核：`preset` 走 `tablePage.js`（`.wr-*`），`kind='table'` 走
  `sheetPage.js`（`.sh-*`）。任何网格级改动（行高、填充柄、撤销、菜单、编辑态）都要写两遍，
  漏一遍就是一次「两张表观感不一致」——本轮修的四条里，**三条**（行号块、网格竖线、`#` 表头）
  都是这类漏项。
- 代价只有一次双跑验证；不做的话，这笔账会在 P5 之前一直按「每改一次 ×2」计息。

若更想先看到日历视图，把 P2.5 顺延到 P4 之后也不影响其他阶段——只是那期间每动一次网格，
记得两边都改。

## P2.5 的风险与拆法

| 风险 | 处理 |
|---|---|
| 预设表是每天都在用的那张（45 条记录 + `全部/今天/待整理` 工具条），回退代价高 | **先双跑**：`applyView` 里留一个开关（`localStorage` 或 `settings`），切过去能用一周再删老路 |
| `tablePage.js` 1800 行，`sheetPage.js` 是另一套事件模型（`bindTableEvents` vs `onHostClick` 委托） | 只迁「入口 + 工具栏 + 抽屉」三处，不逐行搬代码；字段面板两边本来就共用 `fieldTypes.js` |
| 行高/列宽写库用的是不同适配器（`.wr-*` 直接 PATCH，`.sh-*` 走 `setRowHeight`） | 以 `sheetPage` 的为准，老适配器留到删 `tablePage` 时一起删 |
| 两套样式层叠（`styles-v5.css` §11 那批 `.wr-*` 对齐规则） | 合流后 §11 整段作废，删掉即可（它存在只是为了在合流前先对齐观感） |
