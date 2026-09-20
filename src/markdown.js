// ==========================================
// Markdown 渲染模块
//
// 渲染链路：marked（解析） → DOMPurify（消毒） → KaTeX（公式） → highlight.js（代码高亮）
//
// 依赖全部本地 vendored 在 ./assets/vendor/ 下，不依赖任何外部 CDN，
// 因此断网、离线、内网环境都能正常工作。
// ==========================================

const VENDOR_BASE = './assets/vendor';

let markedReady = null;
let purifyReady = null;
let katexReady = null;
let hljsReady = null;

/**
 * 动态注入一段脚本，返回 Promise。
 * 用动态注入而不是静态 <script>，是为了避免拖慢主界面首屏。
 */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-vendor="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') { resolve(); return; }
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`加载失败: ${src}`)));
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.dataset.vendor = src;
    script.addEventListener('load', () => {
      script.dataset.loaded = '1';
      resolve();
    });
    script.addEventListener('error', () => reject(new Error(`加载失败: ${src}`)));
    document.head.appendChild(script);
  });
}

function loadStyleOnce(href, id) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

/** 加载 marked（Markdown 解析）。 */
function ensureMarked() {
  if (!markedReady) {
    markedReady = loadScript(`${VENDOR_BASE}/marked/marked.min.js`).then(() => {
      if (!window.marked) throw new Error('marked 未正确加载');
    });
  }
  return markedReady;
}

/** 加载 DOMPurify（XSS 消毒）。 */
function ensurePurify() {
  if (!purifyReady) {
    purifyReady = loadScript(`${VENDOR_BASE}/purify/purify.min.js`).then(() => {
      if (!window.DOMPurify) throw new Error('DOMPurify 未正确加载');
    });
  }
  return purifyReady;
}

/** 加载 KaTeX（数学公式）。 */
function ensureKatex() {
  if (!katexReady) {
    loadStyleOnce(`${VENDOR_BASE}/katex/katex.min.css`, 'vendor-katex-css');
    katexReady = loadScript(`${VENDOR_BASE}/katex/katex.min.js`)
      .then(() => loadScript(`${VENDOR_BASE}/katex/auto-render.min.js`))
      .then(() => {
        if (!window.katex) throw new Error('KaTeX 未正确加载');
      });
  }
  return katexReady;
}

/** 加载 highlight.js（代码高亮）。 */
function ensureHljs(theme = 'light') {
  const key = `${theme}`;
  if (!hljsReady) hljsReady = new Map();
  if (hljsReady.has(key)) return hljsReady.get(key);

  const cssFile = theme === 'dark' ? 'github-dark.min.css' : 'github.min.css';
  loadStyleOnce(
    `${VENDOR_BASE}/highlight/${cssFile}`,
    `vendor-hljs-css-${theme}`
  );

  const promise = loadScript(`${VENDOR_BASE}/highlight/hljs.min.js`).then(() => {
    if (!window.hljs) throw new Error('highlight.js 未正确加载');
  });
  hljsReady.set(key, promise);
  return promise;
}

/**
 * 预加载全部渲染依赖。编辑器打开前调用，避免首次渲染时闪烁。
 */
export async function preloadRenderer(theme = 'light') {
  const results = await Promise.allSettled([
    ensureMarked(),
    ensurePurify(),
    ensureKatex(),
    ensureHljs(theme)
  ]);

  const failed = results
    .map((r, i) => (r.status === 'rejected' ? ['marked', 'purify', 'katex', 'hljs'][i] : null))
    .filter(Boolean);

  if (failed.length) {
    console.warn('⚠️ 部分渲染依赖加载失败:', failed.join(', '));
  }

  return { failed };
}

/**
 * 判断当前主题是否为深色。用于给代码块挑配色。
 */
export function detectDarkTheme() {
  const body = document.body;
  if (!body) return false;

  const bg = getComputedStyle(body).backgroundColor || '';
  const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return false;

  const [, r, g, b] = match.map(Number);
  // 用感知亮度公式判断深浅
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}

/**
 * 配置 marked：开启 GFM、软换行，并对代码块做高亮挂载。
 */
function configureMarked() {
  const marked = window.marked;
  if (!marked || marked.__wrConfigured) return marked;

  if (typeof marked.setOptions === 'function') {
    marked.setOptions({
      gfm: true,
      breaks: true,
      pedantic: false
    });
  }

  marked.__wrConfigured = true;
  return marked;
}

/**
 * 把 Markdown 文本渲染为安全的 HTML 字符串。
 *
 * @param {string} markdown 原始 Markdown
 * @param {{ theme?: 'light'|'dark', allowHtml?: boolean }} [options]
 * @returns {Promise<string>} 渲染后的 HTML
 */
export async function renderMarkdown(markdown, options = {}) {
  const text = String(markdown ?? '');
  if (!text.trim()) {
    return '<p class="md-empty">（空笔记）</p>';
  }

  const theme = options.theme || (detectDarkTheme() ? 'dark' : 'light');

  await Promise.allSettled([
    ensureMarked(),
    ensurePurify(),
    ensureKatex(),
    ensureHljs(theme)
  ]);

  let html = '';

  // 第一步：Markdown → HTML
  try {
    const marked = configureMarked();
    if (marked && typeof marked.parse === 'function') {
      html = marked.parse(text);
    } else {
      // 渲染库没加载出来时降级为纯文本，至少不丢内容
      html = `<pre class="md-fallback">${escapeHtmlText(text)}</pre>`;
    }
  } catch (error) {
    console.error('Markdown 解析失败:', error);
    html = `<pre class="md-fallback">${escapeHtmlText(text)}</pre>`;
  }

  // 第二步：消毒。允许 KaTeX 与 highlight.js 需要的标签与属性。
  try {
    if (window.DOMPurify) {
      html = window.DOMPurify.sanitize(html, {
        ADD_TAGS: ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'mspace', 'mstyle', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'mphantom', 'mpadded', 'menclose', 'mglyph', 'svg', 'path', 'line', 'g', 'use', 'defs', 'symbol', 'span'],
        ADD_ATTR: [
          'class', 'style', 'aria-hidden', 'xmlns', 'viewBox', 'preserveAspectRatio',
          'width', 'height', 'd', 'fill', 'stroke', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
          'transform', 'encoding', 'data-*', 'href'
        ],
        ALLOW_DATA_ATTR: true,
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus']
      });
    }
  } catch (error) {
    console.error('HTML 消毒失败:', error);
  }

  // 第三步：KaTeX 渲染公式。让公式脱离 marked 的段落包裹单独成块。
  html = await renderMathInHtml(html);

  // 第四步：代码高亮。
  html = highlightCodeInHtml(html);

  return html;
}

/**
 * 在已生成的 HTML 里查找并渲染公式。
 *
 * marked 会把 `$$...$$` 原样输出（前后可能被 <p> 包住），
 * 这里先把独立公式块从段落里摘出来，再交给 auto-render 处理。
 */
async function renderMathInHtml(html) {
  if (!window.renderMathInElement || !window.katex) return html;

  const container = document.createElement('div');
  container.innerHTML = html;

  // 把「段落里只包含一个独立公式」的情况提升为块级公式
  container.querySelectorAll('p').forEach(p => {
    const raw = p.textContent.trim();
    const isDisplayBlock = /^\$\$[\s\S]+\$\$$/.test(raw);
    if (isDisplayBlock) {
      const div = document.createElement('div');
      div.className = 'md-math-block';
      div.textContent = raw;
      p.replaceWith(div);
    }
  });

  try {
    window.renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false }
      ],
      throwOnError: false,
      errorColor: '#e05252',
      // 忽略代码块内部的 $ 符号，避免把代码当公式解析
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option']
    });
  } catch (error) {
    // 单条公式语法错不该让整篇笔记渲染失败
    console.warn('公式渲染跳过:', error);
  }

  return container.innerHTML;
}

/**
 * 给代码块加高亮，并补上语言标签。
 */
function highlightCodeInHtml(html) {
  if (!window.hljs) return html;

  const container = document.createElement('div');
  container.innerHTML = html;

  container.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;
    if (pre.dataset.hljsDone === '1') return;
    pre.dataset.hljsDone = '1';

    try {
      const result = window.hljs.highlightElement(code);
      void result;

      // 取出语言名做角标（marked 会写成 class="language-xxx"）
      const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
      if (langClass) {
        const lang = langClass.replace('language-', '');
        if (lang && !pre.querySelector('.code-lang-badge')) {
          const badge = document.createElement('span');
          badge.className = 'code-lang-badge';
          badge.textContent = lang;
          pre.appendChild(badge);
        }
      }
    } catch (error) {
      console.warn('代码高亮跳过:', error);
    }
  });

  return container.innerHTML;
}

function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 从 Markdown 正文里抽出一段纯文本摘要，用于列表预览。
 */
export function extractExcerpt(markdown, limit = 120) {
  const text = String(markdown ?? '')
    // 去掉 front-matter（万一误传了整文件内容）
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

/**
 * 统计 Markdown 的字符数与行数，用于列表展示。
 */
export function countMarkdownStats(markdown) {
  const text = String(markdown ?? '');
  const chars = text.replace(/\s/g, '').length;
  const lines = text.split('\n').filter(l => l.trim()).length;
  return { chars, lines };
}
