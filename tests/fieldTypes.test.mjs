// fieldTypes.js 的选项着色断言。
// 只覆盖一件事：用户在图表面板里配的颜色，什么时候该画成实心色块、什么时候不该。
// （实心色块的 CSS 在 styles-v5.css，用探针量计算值，这里只验 HTML 输出。）

import { renderCell } from '../src/fieldTypes.js';

let pass = 0;
let fail = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    return;
  }
  fail += 1;
  console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
}

function selectField(option, type = 'select') {
  return {
    key: 'f',
    label: '处理方',
    type,
    options: JSON.stringify({ source: 'custom', options: [option] }),
  };
}

const pick = (html, re) => (html.match(re) || [])[0] || '';

// ---- 1. 显式配色 + 表格语境 → 实心 ----
// #15803d 白字对比度 5.0:1，稳稳走「白字」这一支。
{
  const field = selectField({ value: 'a', label: '已解决', color: '#15803d' });
  const html = renderCell(field, 'a', { solidPill: true });

  ok('深色：打 is-solid', html.includes('is-solid'), html);
  ok('深色：底色写进 --pill', html.includes('--pill:#15803d'), html);
  ok('深色：浅色字（白）', html.includes('--pill-ink:#ffffff'), html);
  ok('深色：显示 label 不是 value', html.includes('>已解决<'), html);
  ok('只生成一个 pill', (html.match(/class="ft-pill/g) || []).length === 1, html);
}

// ---- 2. 亮底色要自动转深字（否则黄底白字读不出来）----
{
  const field = selectField({ value: 'a', label: '月报', color: '#facc15' });
  const html = renderCell(field, 'a', { solidPill: true });

  ok('亮色：仍打 is-solid', html.includes('is-solid'), html);
  ok('亮色：字改深色', html.includes('--pill-ink:#1f2328'), html);
  ok('亮色：不再给白字', !html.includes('--pill-ink:#ffffff'), html);
}

// ---- 3. 没配色 + 表格语境 → 淡底标签（有颜色但不抢眼）----
{
  const field = selectField({ value: 'a', label: '武大' });
  const html = renderCell(field, 'a', { solidPill: true });

  ok('无配色：不打 is-solid', !html.includes('is-solid'), html);
  ok('无配色：给淡底 is-tinted', html.includes('is-tinted'), html);
  ok('无配色：不塞 ink（淡底自己算字色）', !html.includes('--pill-ink'), html);
  ok('无配色：仍渲染 pill', html.includes('class="ft-pill'), html);
}

// ---- 4. 不在表格语境（详情页 / 看板）→ 既不是实心也不是淡底 ----
{
  const field = selectField({ value: 'a', label: '已解决', color: '#2ab427' });
  const html = renderCell(field, 'a', {});

  ok('详情页：不打 is-solid', !html.includes('is-solid'), html);
  ok('详情页：也不打 is-tinted', !html.includes('is-tinted'), html);
  ok('详情页：不塞 ink', !html.includes('--pill-ink'), html);
}

// ---- 5. 多选：逐个值判定，配色的才实心 ----
{
  const field = {
    key: 'f',
    label: '周期',
    type: 'multi_select',
    options: JSON.stringify({
      source: 'custom',
      options: [
        { value: 'm', label: '月报', color: '#2563eb' },
        { value: 'y', label: '年报' },
      ],
    }),
  };
  const html = renderCell(field, 'm,y', { solidPill: true });

  ok('多选：两个 pill 都在', (html.match(/class="ft-pill(?![-\w])/g) || []).length === 2, html);
  ok('多选：只有配色那个实心', (html.match(/is-solid/g) || []).length === 1, html);
  ok('多选：在 pill-group 里', html.includes('class="ft-pill-group"'), html);
  ok('多选：月报带蓝底', html.includes('--pill:#2563eb'), html);
  ok('多选：蓝底给白字', html.includes('--pill-ink:#ffffff'), html);
}

// ---- 6. 内置 tone（状态类）：表格里上色，详情页仍是圆点 + 文字 ----
{
  const field = selectField({ value: 'done', label: '已完成', tone: 'done' });

  // 表格语境：预置表的「状态」列走这条 —— 要和「配了色的列」长得一样
  const inTable = renderCell(field, 'done', { solidPill: true });
  ok('tone·表格里是 pill', inTable.includes('class="ft-pill'), inTable);
  ok('tone·表格里实心', inTable.includes('is-solid'), inTable);
  ok('tone·底色用主题 token', inTable.includes('--pill:var(--pill-green)'), inTable);
  ok('tone·字色用配对的 ink', inTable.includes('--pill-ink:var(--pill-green-ink)'), inTable);
  ok('tone·表格里不再画圆点', !inTable.includes('ft-status-dot'), inTable);

  // 详情页 / 看板：保持 v4 的圆点 + 文字
  const inDrawer = renderCell(field, 'done', {});
  ok('tone·详情页仍走 ft-status', inDrawer.includes('class="ft-status"'), inDrawer);
  ok('tone·详情页不生成 pill', !inDrawer.includes('class="ft-pill'), inDrawer);
  ok('tone·详情页不实心', !inDrawer.includes('is-solid'), inDrawer);
  ok('tone·详情页保留圆点', inDrawer.includes('ft-status-dot'), inDrawer);
}

// ---- 7. 脏颜色不能进 style（沿用 renderPill 的白名单）----
{
  const field = selectField({ value: 'a', label: '坏数据', color: 'red;background:url(x)' });
  const html = renderCell(field, 'a', { solidPill: true });

  ok('脏色：丢掉原值', !html.includes('url(x)'), html);
  ok('脏色：不当成显式配色', !html.includes('is-solid'), html);
  ok('脏色：回退 hash 色板', /--pill:#[0-9a-f]{6}/.test(html), html);
}

// ---- 8. 空值仍是占位符，不是空色块 ----
{
  const field = selectField({ value: 'a', label: '已解决', color: '#2ab427' });
  const html = renderCell(field, '', { solidPill: true, placeholder: '—' });

  ok('空值：不出 pill', !html.includes('ft-pill'), html);
  ok('空值：出占位符', html.includes('ft-cell-empty'), html);
}

// ---- 9. 字色判据：白字对比度 ≥ 3.0:1 才用白字 ----
// 冻结 v1.1.8 起的新判据。旧版按「相对亮度 > 0.42」一刀切，0.42 只对应
// 白字约 2.2:1，中间亮度那一段（绿/浅蓝/紫/中绿）全被误判成白字，浅色块上发飘。
{
  const cases = [
    ['#2fbf71', '#1f2328', '预设绿 2.39:1'],
    ['#60a5fa', '#1f2328', '浅蓝 2.54:1'],
    ['#2ab427', '#1f2328', '中绿 2.70:1'],
    ['#a78bfa', '#1f2328', '预设紫 2.72:1'],
    ['#facc15', '#1f2328', '黄 1.53:1'],
    ['#22d3ee', '#1f2328', '青 1.81:1'],
    ['#ffffff', '#1f2328', '纯白 1.00:1'],
    ['#3b82f6', '#ffffff', '预设蓝 3.68:1'],
    ['#e5484d', '#ffffff', '预设红 3.92:1'],
    ['#15803d', '#ffffff', '深绿 5.01:1'],
    ['#1f2937', '#ffffff', '近黑 14.7:1'],
  ];
  for (const [hex, ink, note] of cases) {
    const field = selectField({ value: 'a', label: 'x', color: hex });
    const html = renderCell(field, 'a', { solidPill: true });
    ok(`${hex}（${note}）→ ${ink}`, html.includes(`--pill-ink:${ink}`), html);
  }
}

console.log(`\nfieldTypes: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
