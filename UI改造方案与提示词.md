# WorkRecorder UI 改造方案与提示词

基线：v1.1.4（`75d0d11`），dark 主题实测截图 8 张（工作台 / 工作台空态 / 笔记 / 时间轴 / 搜索 / 设置 / 表格库 / 表格视图 / 空当接龙）。

---

## 0 结论先说

**不是配色丑，是三个结构性问题：**

1. **没有尺度**。`styles.css` 里 59 种 font-size（含 11 / 11.5 / 12 / 12.5 / 13 / 13.5 六个近邻值并肩使用）、37 种 border-radius、200 种 padding。近邻值之间人眼分不出，只会把页面读成「糊、不齐」。
2. **没有层级**。每张卡片同时用「边框 + 半透明底 + 模糊 + 圆角 + 内嵌卡」，所有区块看起来一样重要，眼睛找不到落点。
3. **没有统一骨架**。侧栏 `.sidebar` 被重定义 5 次（250px → 232px → 208px `!important`），`.main-content` 6 次，`body` 3 次；3869 个 `!important` 在互相打架。任何一次视觉调整都在和旧规则抢胜负，结果就是「哪里都不太对」。

**你其实已经有答案**：`交互重构v2设计稿` 里的「今天」页就是好设计（4 项导航 / 两栏 / 一行头 / 无边框卡片），但代码没落地。现在的界面是「10 月的旧骨架 + 11 月的表格」缝在一起。

---

## 1 实测证据

| 指标 | 实测值 | 健康值 | 影响 |
|---|---|---|---|
| font-size 取值 | 59 种 / 501 处 | 6 档 | 字看起来发虚、不齐 |
| border-radius 取值 | 37 种 / 334 处 | 4 档 | 圆角像随手给的 |
| padding 取值 | 200 种 / 464 处 | 7 档 | 间距无节奏 |
| 硬编码 hex | 69 种 / 209 次 | 0 | 换主题时会漏、会脏 |
| `!important` | 3869 处 | < 50 | 改一处崩一处 |
| `.sidebar` 定义 | 5 份 | 1 份 | 宽度自相矛盾 |
| `.main-content` 定义 | 6 份 | 1 份 | padding 28/34 与 40 并存 |
| `@font-face` | 0 | — | Inter 未内置，中文全走 YaHei UI |

### 逐页看到的问题

- **工作台**：单列纵堆。`1090px` 宽的卡片里放 30 字的输入框和 3 条短记录，横向空间整片浪费；「今日待办」标题下只有一片空槽（数据为空时没有空态样式，直接塌成一块空卡）。
- **笔记 / 时间轴 / 搜索**：三页共用同一副骨架 `kicker(10.5px 全大写) → h1(26px) → 说明段落`，头部吃掉约 100px，然后一张卡 + 居中信封 icon + 一句话，剩下 60% 是纯黑。
- **时间轴**：筛选卡片里「筛选记录 / 聚焦一个分类项目…」占了左半张卡，两个 select 挤右边，卡片高度被文案撑起来。
- **设置**：卡片高度不齐到出现缺口（左上卡 392×82，右上卡 392×62，下方直接空一块）；「数据和存储」卡里再套一张带边框的子卡；每张卡都有图标块 + 标题 + 说明 + 一行控件，四层噪音。
- **表格视图**：`<col style="width:XXXpx">` 固定像素列宽，1360 窗口下横向溢出，「问题」列被裁掉；3 行数据下方是一整块空面板 + 一条悬在中间的横向滚动条。
- **空当接龙**：整块墨绿渐变 + 蓝色按钮，和全站深蓝黑完全不是一套语言，还占着主导航一格。

---

## 2 目标规范（可直接写进 CSS）

### 2.1 字号：6 档，只留 6 档

| 令牌 | 值 | 行高 | 用在哪 | 字重 |
|---|---|---|---|---|
| `--fs-micro` | 11px | 1.4 | 时间戳、计数、角标（中文下限，别再用 10/10.5px） | 400 |
| `--fs-meta` | 12px | 1.5 | 次要说明、列表副行、表头 | 400 |
| `--fs-body` | 13px | 1.6 | 正文、输入框、按钮 | 400 |
| `--fs-title` | 15px | 1.4 | 区块标题（今日计划 / 待整理） | 700 |
| `--fs-page` | 20px | 1.25 | 页面标题（从 26px 降下来） | 700 |
| `--fs-display` | 24px | 1.2 | 只给工作台大标题用 | 700 |

**Windows 中文的关键一点**：微软雅黑只有 Regular / Bold 两套字形，`font-weight: 500 / 600` 是浏览器合成加粗，边缘会发毛。**中文只用 400 和 700**，不要用 500/600。若确实需要中间层级，用颜色（`--text-secondary`）降权，不要用字重。

### 2.2 间距：8pt 网格

`4 / 8 / 12 / 16 / 24 / 32 / 48`。禁止 5 / 7 / 9 / 10 / 13 / 14 / 18 / 20 / 22 / 26 / 34 / 40。

- 卡片内边距：`16px`（紧凑）/ `24px`（宽松）
- 卡片之间：`16px`
- 区块之间：`32px`
- 页面外边距：`24px 32px`
- 行高（列表项）：`40px`（表格行）/ `44px`（计划项）

### 2.3 圆角：4 档

| 令牌 | 值 | 用在哪 |
|---|---|---|
| `--r-sm` | 6px | 输入框、小按钮、pill 的方形变体 |
| `--r-md` | 10px | 卡片、面板、按钮 |
| `--r-lg` | 14px | 浮层、弹窗、命令面板 |
| `--r-pill` | 999px | 标签、状态点、头像 |

### 2.4 层级：只靠「底色差」分层，不靠边框

| 层 | 深色主题取值 | 说明 |
|---|---|---|
| L0 页面底 | `#0a0f19` | body |
| L1 分区 | 无容器 | 靠 32px 间距 + 15px 区块标题分割 |
| L2 卡片 | `#131b28`（比 L0 亮约 6%） | **无边框、无阴影、无 backdrop-filter** |
| L3 浮层 | `#1a2332` + 1px `rgba(255,255,255,.08)` + `0 12px 32px rgba(0,0,0,.45)` | 只有浮层能同时用边框和阴影 |

**硬规则**：
- 卡片不许套卡片（设置页的「数据存储 → 加载中…」那张子卡要去掉，改成一行文字 + 右侧按钮）。
- 同一屏内，边框只出现在「需要独立滚动」的区域（表格容器、浮层）。
- 删掉所有 `backdrop-filter: blur()`（13 处），深色底下它只做一件事：让文字发灰。

### 2.5 颜色

- 主色 1 个（保持 `#60a5fa`），只用于：主按钮、当前导航、输入框聚焦环。
- 语义 3 个：成功 `#34d399` / 警告 `#fbbf24` / 危险 `#f87171`。
- 标签 pill：`background: rgba(色, .12)` + `color: 同色`，**一屏最多 3 个色相**。现在表格一行里有蓝/黄/紫/绿/灰 5 个色相，等于没有重点。
- 所有颜色必须来自变量，禁止再出现新的 hex。

### 2.6 表格

- 列宽改**权重制**（`<col style="width:18%">` 或 `grid-template-columns: 48px minmax(96px,1.4fr) ...`），总和 100%，不用 px。
- 首列（序号）+ 第一数据列 `position: sticky; left: 0`，横向滚动时保持锚点。
- 行高 40px（现 54px），单元格 padding `0 12px`。
- 数据不足一屏时，表格容器**不撑满高度**（`height: auto`），下方留 L0 底色，不要出现「空面板 + 悬空滚动条」。

---

## 3 六批提示词（按顺序执行，一批一编译）

> 用法：每批单独开一次对话，粘一个代码块。不要合并，不要跳批。
> 每批开工前先 `git status` 确认干净，收工后 `git diff --stat` 看改动量。

### 批 0 · 建基线（不改代码）

```
在 D:\MyDesktopApp\work_recorder 下，先把当前 UI 存成基线截图，供后续每批对比。

用系统 Chrome headless，在项目根起 http.server 8899，按 1360x860 截这几页到
_debug/ui-audit/ 下（已存在则覆盖）：
  _debug/ui-review.html?theme=dark&view=dashboard
  _debug/ui-review.html?theme=dark&view=dashboard&demo=0
  _debug/ui-review.html?theme=dark&view=notes
  _debug/ui-review.html?theme=dark&view=timeline
  _debug/ui-review.html?theme=dark&view=settings
  _debug/sheet-review.html?view=library
  _debug/sheet-review.html?view=table

注意：每次截图必须换新的 --user-data-dir，否则会截到缓存的旧版。
截完把文件名列出来，不要改任何源码。
```

### 批 1 · 令牌层（只新增，不改现有规则）

```
目标：给 src/styles.css 建立唯一的设计令牌来源。只允许「新增」，不改任何已有规则的值，
不加新依赖，不动 themes.json 的结构。

在 src/styles.css 的最末尾追加一个块（放在文件最后，保证优先级最高）：

:root {
  --fs-micro: 11px;  --fs-meta: 12px;  --fs-body: 13px;
  --fs-title: 15px;  --fs-page: 20px;  --fs-display: 24px;

  --lh-micro: 1.4; --lh-meta: 1.5; --lh-body: 1.6;
  --lh-title: 1.4; --lh-page: 1.25; --lh-display: 1.2;

  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-7: 48px;

  --r-sm: 6px; --r-md: 10px; --r-lg: 14px; --r-pill: 999px;

  --layer-card: #131b28;
  --layer-float: #1a2332;
  --stroke-hair: rgba(255, 255, 255, 0.08);
  --shadow-float: 0 12px 32px rgba(0, 0, 0, 0.45);

  --row-h: 40px;
  --card-pad: 16px;
}

然后写一段注释说明：
「本块是视觉令牌的唯一来源。新增样式一律引用上面的变量，禁止再写 11.5px / 12.5px /
13.5px 这类半像素字号，禁止新增 hex 颜色。」

验收：这次改完界面必须零变化。跑一遍 cargo build 确认能编译，然后 git diff 只应看到
styles.css 尾部新增。

禁止：不要顺手删旧规则，不要批量替换现有 font-size，不要把 !important 去掉。
这批只立规矩，不动现场。
```

### 批 2 · 页面头部一行化

```
目标：把「笔记 / 时间轴 / 搜索 / 设置 / 表格库 / 表格视图」六个页面的头部从三层压成一行，
省出约 60px 垂直空间。

现状（每个页面都一样，改一处要六个文件都看）：
  <span class="subview-kicker">NOTES</span>   ← 10.5px 全大写英文
  <h1>笔记</h1>                                ← 26px
  <p>以 Markdown 文件保存，可用任意编辑器打开。</p>  ← 说明段落

改成：
  - 保留 h1，字号用 var(--fs-page)（20px），字重 700；
  - 删掉 .subview-kicker 节点和它的 CSS（全站搜 subview-kicker，共 N 处，一次全删）；
  - 删掉说明段落（<p> 在 .dashboard-title-copy / 各 subview 头部里的那句）；
    如果某个信息真的必要（例如表格视图的「10 字段 · 3 条记录」），
    降级成 h1 右边同行的 var(--fs-meta) 灰字，不要单独成行；
  - 头部容器改 flex 单行、align-items: center、justify-content: space-between，
    高度固定 40px，下边距 var(--sp-5)（24px）；
  - 页面外边距统一 padding: 24px 32px（覆盖现有的 28px 34px 与 40px）。

涉及文件：src/index.html（dashboard / notes / timeline / search / settings 各 subview 头部）、
src/styles.css（.subview-kicker、各 .subview h1、副标题段落）、
src/sheetPage.js 与 src/sheetPanels.js 里生成的页面头字符串。

验收：480px 高度内能同时看到标题和第一块内容；六页头部高度一致（截图叠一起对比）；
h1 基线在同一水平线。

禁止：不要改导航、不要碰表格列宽、不要动 themes.json。
```

### 批 3 · 工作台改两栏（对齐 06 号设计稿）

```
目标：把 #subview-dashboard 从单列纵堆改成两栏，消除「1090px 宽的卡片装 30 字内容」的散架感。

结构改成：
  #subview-dashboard {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 24px;
    padding: 24px 32px;
    align-items: start;
  }
  左列（.wb-col-main）：今日计划（原 task-tree-section）+ 今天的记录（原 today 时间线）
  右列（.wb-col-side）：待整理（原 inbox-section）+ 最近笔记（原 wb-recent-notes）

具体动作：
1. index.html 里把现有的 dashboard-hero / composer-card / inbox-section / task-tree-section /
   advanced-tools-strip 重新分组，包两个 div：.wb-col-main、.wb-col-side。
2. 快速记录框（.composer-card）不再常驻，移入顶部一行头右侧的「+ 记一笔」按钮，
   点击后弹出浮层（浮层可先复用现有的 composer-card，套上 L3 浮层样式：
   background var(--layer-float)、border 1px var(--stroke-hair)、radius var(--r-lg)、
   box-shadow var(--shadow-float)）。浮层定位用 absolute 不要 fixed。
3. 「完整录入」（.advanced-tools-strip）整个删掉——它是旧设计的遗留入口，
   内容已能被「+ 记一笔」的浮层覆盖。删之前先确认 quickCapture.js 没有依赖它的 DOM id。
4. 右栏两张卡：标题行 = 15px 标题 + 右侧 var(--fs-meta) 的「全部」链接，行高 40px；
   列表项高 44px，靠 8px 内边距分隔，不要每条加边框。
5. 窄窗口（< 1100px）退化成单列：@media (max-width: 1100px) { grid-template-columns: 1fr; }

验收：1360x860 下两栏同时可见、右栏底部不出现半截卡；窗口拉到 1100 时不出现横向滚动。

禁止：不要改数据层（main.js 的 todo/log/note 渲染函数签名不动），只调 DOM 容器与 CSS。
      不要在 .subview 上用 position: fixed。
```

### 批 4 · 卡片减法与列表密度

```
目标：全站去一层装饰，让层级只由底色差承担。

1. 卡片类（.glass-card / .input-card / .dashboard-card / .inbox-section / .task-tree-section /
   .settings-card / 表格窗口）：删掉 border 和 backdrop-filter 与 box-shadow，
   只留 background: var(--layer-card); border-radius: var(--r-md); padding: var(--card-pad);
   需要分组感时，用 var(--sp-6)（32px）的外边距，不要加边框。
2. 删掉全站 backdrop-filter（共 13 处），逐个确认删除后没有元素变成透明看不见
   （它们大多在 sidebar / 卡片上，底色本来就够）。
3. 空态统一成一个组件：
   左对齐、不居中、不用信封图标。结构 = 一行 var(--fs-body) 主句 + 一行 var(--fs-meta) 补充
   +（可选）一个文字按钮。容器高度取 min-height: 120px，不要撑满父级。
   涉及：#todo-list-container、#inbox-records-container、笔记列表、时间轴、搜索结果、表格库。
4. 列表项密度：行高 44px，padding 0 12px，hover 用 background: rgba(255,255,255,.04)，
   不要用 border-left 高亮条 + 背景色 + 圆角三件套同时上。
5. 设置页：卡片高度不齐的地方用 align-items: start 的 CSS grid 两列，列宽 1fr 1fr；
   「数据存储」里那张子卡拆掉，改成一行「当前数据库 4.8 MB」+ 右侧三个按钮。

验收：截图里同一屏内边框数量从「几乎每块都有」降到「只在表格容器和浮层出现」；
      空态不再出现大面积纯黑 + 居中图标。

禁止：不要改布局列数（上一批刚定），不要动导航，不要引入新颜色。
```

### 批 5 · 表格适配 1360 与列宽权重制

```
目标：1360x860 窗口下表格不横向溢出，右列不再被裁。

1. src/sheetTable.js 第 31~33 行现在是 `<col style="width:${fieldWidth(field)}px">`，
   固定像素 → 改成百分比：按字段类型给权重（长文本 22%、标签 12%、日期 14%、
   人员 12%、状态 12%、附件 14%、序号 48px 固定、新增列 40px 固定），
   总和不足 100% 时把余量补给最长的文本列。列宽计算函数返回字符串百分比如 '22%'。
2. .sheet-table-wrap 加 overflow-x: auto，但外层容器 height: auto（数据不足一屏时不撑满），
   这样不会再出现「空面板 + 悬空横向滚动条」。
3. 首列与第一数据列 sticky：
   td:first-child, th:first-child { position: sticky; left: 0; z-index: 2; background: var(--layer-card); }
4. 行高从 54px 降到 var(--row-h)（40px），单元格 padding 0 12px，列头 12px / 400 / 灰。
5. pill 收敛：一屏最多 3 个色相。标签(pill)用单一主色淡底，状态(圆点)只有
   绿/黄/灰三种，人员列不要给紫色底，改成纯文字 + 灰色。

验收：1360 宽下「问题」「备注」列完整可见，不出现横向滚动条；把窗口拉到 1280 仍然不裁列；
     数据 3 行时表格高度贴着第 3 行结束，下方是页面底色不是面板。

禁止：不要改表结构（field_def / custom 字段），不要动 sheetStore.js 的读写逻辑。
```

### 批 6 · 清理战场（最后做，低优先）

```
目标：把 3869 个 !important 收敛到一个可维护的量。

1. 只处理重复定义：.sidebar（5 处）、.main-content（6 处）、body（3 处）。
   每处保留「最后生效的那一份」，把它前面的 4 份删掉，保留的这份里去掉 !important。
   改完必须逐页截图对比，任何一页有位移就回退这一处。
2. 把 font-size 收敛成 6 档：全站把 10/10.5/11.5/12.5/13.5/14/17/18 映射到
   --fs-micro / --fs-meta / --fs-body / --fs-title（就近）。一次只做一档，
   做完截图确认，再下一档。
3. 硬编码 hex 收敛：69 种里，凡是和主题变量同义的值（如 #60a5fa、#0a0f19）替换成 var()，
   剩下的用一个脚本列出「出现次数 ≥ 2 且不在 :root 里」的，逐个判断。

验收：styles.css 行数下降 ≥ 800；页面在 5 套主题（dark / light / sakura / lavender-calendar /
aurora）下都不出现白底白字或黑底黑字。

禁止：不要为了「好看」在这一批里改任何视觉值，这批只做等价重构。
```

---

## 4 不要做的事

- **不要一次改完**。368KB CSS + 3869 `!important`，一次改完必然回归到「更乱」。
- **不要动 themes.json 的字段结构**（`settings.js applyTheme` 的形参名是反的，动它会连带崩掉 5 套主题）。
- **不要重画空当接龙**。它跟工作软件不是一套语言，建议直接从主导航移除（保留入口在设置页），而不是给它配色。
- **不要在没有截图对照的情况下调间距**。这类改动「看起来只差 2px」，实际会让三处对齐同时崩。
- **不要新增图标集 / 字体文件**。Inter 未内置（0 个 @font-face），中文全走微软雅黑；引入 web font 会让冷启动变慢，收益是负的。

---

## 5 验收清单（每批都过一遍）

- [ ] 1360×860 下无横向滚动条
- [ ] 同一页面内字号 ≤ 4 种、圆角 ≤ 3 种
- [ ] 屏幕截图缩放 50% 后，仍能一眼分出「标题 / 区块 / 内容」三层
- [ ] 5 套主题切换后无白底白字、无对比度低于 4.5:1 的正文
- [ ] 空态不再出现居中信封图标 + 大面积纯黑
- [ ] 键盘 Tab 能走完当前页所有可交互元素，聚焦环可见

---

生成时间：2026-11-12　基线版本：v1.1.4
