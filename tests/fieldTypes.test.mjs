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
{
  const field = selectField({ value: 'a', label: '已解决', color: '#2ab427' });
  const html = renderCell(field, 'a', { solidPill: true });

  ok('深色：打 is-solid', html.includes('is-solid'), html);
  ok('深色：底色写进 --pill', html.includes('--pill:#2ab427'), html);
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

// ---- 3. 没配色 + 表格语境 → 保持安静（hash 兜底色，不画色块）----
{
  const field = selectField({ value: 'a', label: '武大' });
  const html = renderCell(field, 'a', { solidPill: true });

  ok('无配色：不打 is-solid', !html.includes('is-solid'), html);
  ok('无配色：不塞 ink', !html.includes('--pill-ink'), html);
  ok('无配色：仍渲染 pill', html.includes('class="ft-pill"'), html);
}

// ---- 4. 不在表格语境（详情页 / 看板）→ 即使配了色也不实心 ----
{
  const field = selectField({ value: 'a', label: '已解决', color: '#2ab427' });
  const html = renderCell(field, 'a', {});

  ok('详情页：不打 is-solid', !html.includes('is-solid'), html);
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
        { value: 'm', label: '月报', color: '#60a5fa' },
        { value: 'y', label: '年报' },
      ],
    }),
  };
  const html = renderCell(field, 'm,y', { solidPill: true });

  ok('多选：两个 pill 都在', (html.match(/class="ft-pill(?![-\w])/g) || []).length === 2, html);
  ok('多选：只有配色那个实心', (html.match(/is-solid/g) || []).length === 1, html);
  ok('多选：在 pill-group 里', html.includes('class="ft-pill-group"'), html);
  ok('多选：月报带蓝底', html.includes('--pill:#60a5fa'), html);
  ok('多选：蓝底给白字', html.includes('--pill-ink:#ffffff'), html);
}

// ---- 6. 内置 tone（状态类）不受影响：仍是圆点 + 粉彩 ----
{
  const field = selectField({ value: 'done', label: '已完成', tone: 'done' });
  const html = renderCell(field, 'done', { solidPill: true });

  ok('tone：走 ft-status', html.includes('class="ft-status"'), html);
  ok('tone：不生成 pill', !html.includes('class="ft-pill'), html);
  ok('tone：不实心', !html.includes('is-solid'), html);
  ok('tone：用主题 token', html.includes('--pill:var(--pill-green)'), html);
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

console.log(`\nfieldTypes: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
