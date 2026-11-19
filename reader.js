/* 阅巢 ReadNest — 阅读页逻辑 */
(function () {
  const { util, articles, store, K } = RN;
  const $ = (s) => document.querySelector(s);
  const html = document.documentElement;
  const contentEl = $('#content');

  const state = {
    article: null,
    prefs: null,
    sel: null,
    editingHlId: null,
    editingNoteId: null,
    lastTrans: null,
    transSource: '',
    toc: [],
    scrollRatio: 0,
    summaryCollapsed: false,
  };

  /* ================= 启动 ================= */

  async function boot() {
    state.prefs = await RN.settings.all();
    applyPrefs();
    bindEvents();
    const q = new URLSearchParams(location.search);
    const err = q.get('error');
    if (err) {
      hideLoading();
      return showError(err);
    }
    try {
      if (q.get('raw')) {
        await loadRaw(q.get('raw'), q.get('charts'));
        return;
      }
      const id = q.get('id');
      if (!id) {
        hideLoading();
        return showError('没有指定要打开的文章');
      }
      const art = await articles.get(id);
      if (!art) {
        hideLoading();
        return showError('这篇文章不在书库里，可能已被删除');
      }
      startReading(art);
    } catch (e) {
      console.error('[ReadNest]', e);
      hideLoading();
      showError('打开失败：' + (e && e.message ? e.message : e));
    }
  }

  function absUrl(u, base) {
    try {
      return new URL(String(u).trim(), base).href;
    } catch (e) {
      return u;
    }
  }

  /** 后台 fetch 回来的 HTML：清理脚本、把相对地址变绝对，再交给 Readability */
  function prepareDoc(rawHtml, url) {
    const probe = new DOMParser().parseFromString(rawHtml || '', 'text/html');
    probe
      .querySelectorAll('script,iframe,object,embed,noscript,link,base,meta[http-equiv="refresh"]')
      .forEach((n) => n.remove());
    probe.querySelectorAll('*').forEach((el) => {
      for (const at of Array.from(el.attributes)) {
        const name = at.name.toLowerCase();
        if (/^on/.test(name)) el.removeAttribute(at.name);
        else if (name === 'href' || name === 'src' || name === 'poster' || name === 'data-src') {
          const v = el.getAttribute(at.name);
          if (v && !/^(data:|mailto:|tel:|javascript:|#)/i.test(v)) el.setAttribute(at.name, absUrl(v, url));
        } else if (name === 'srcset') {
          el.setAttribute(
            'srcset',
            (at.value || '')
              .split(',')
              .map((p) => {
                const seg = p.trim().split(/\s+/);
                if (seg[0]) seg[0] = absUrl(seg[0], url);
                return seg.join(' ');
              })
              .join(', ')
          );
        }
      }
    });
    return new DOMParser().parseFromString('<!doctype html><html>' + probe.documentElement.innerHTML + '</html>', 'text/html');
  }

  /** 页面自带的 CSS（外链 + 内联），静态图表要靠它上色 */
  async function collectPageCss(rawHtml, baseUrl) {
    let css = '';
    try {
      const doc = new DOMParser().parseFromString(rawHtml || '', 'text/html');
      doc.querySelectorAll('style').forEach((s) => {
        if (s.textContent) css += s.textContent + '\n';
      });
      const links = Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'))
        .map((l) => absUrl(l.getAttribute('href'), baseUrl))
        .filter((u) => /^https?:/i.test(u))
        .slice(0, 3);
      for (const u of links) {
        try {
          const r = await fetch(u, { credentials: 'omit' });
          if (r.ok) css += (await r.text()) + '\n';
        } catch (e) {}
      }
    } catch (e) {}
    return css;
  }

  async function loadRaw(token, chartsToken) {
    const raw = await store.get(K.raw(token), null);
    if (!raw) throw new Error('临时数据已失效，请重新抓取这个链接');
    await store.remove(K.raw(token));
    $('#loadingText').textContent = '正在提取正文…';
    const pageCss = await collectPageCss(raw.html, raw.url);
    const doc = prepareDoc(raw.html, raw.url);
    let macros = {};
    try {
      const macroDoc = new DOMParser().parseFromString(raw.html, 'text/html');
      macros = (window.__rnCollectMacros && window.__rnCollectMacros(macroDoc)) || {};
    } catch (e) {}
    const data = window.__rnExtractFromDoc(doc, { url: raw.url, base: raw.url, macros, css: pageCss });
    if (!data || !data.contentHTML || data.contentHTML.length < 80) {
      throw new Error('这个页面没有提取到正文（可能是列表页、需要登录或站点有反爬）');
    }
    if ((data.textLength || 0) < 200) {
      throw new Error('这个页面正文太少，可能是应用嵌入页（正文在 iframe 里）。请先在本机浏览器打开该页面，再点扩展图标「抓取当前页面」');
    }
    // 标签页抓取时把图表另外存成临时数据，这里合并进来（公式/文字用静态版本）
    if (chartsToken) {
      const charts = await store.get(K.raw(chartsToken), null);
      await store.remove(K.raw(chartsToken));
      if (charts && charts.html) data.contentHTML = mergeFigures(data.contentHTML, charts.html);
      if (charts && charts.siteStyle && !data.siteStyle) data.siteStyle = charts.siteStyle;
    }
    data.url = raw.url;
    data.canonicalUrl = data.canonicalUrl && data.canonicalUrl !== 'about:blank' ? data.canonicalUrl : raw.url;
    const now = Date.now();
    const canonical = data.canonicalUrl || raw.url;

    // 同一篇文章重复抓取：更新正文，保留已有关注点（高亮/笔记/进度）
    const index = await articles.index();
    const existing = index.find((a) => a.canonicalUrl === canonical || a.canonicalUrl === raw.url || a.url === canonical || a.url === raw.url);
    let rec;
    if (existing) {
      const prev = (await articles.get(existing.id)) || {};
      rec = Object.assign({}, prev, data, {
        id: prev.id || existing.id,
        savedAt: prev.savedAt || now,
        updatedAt: now,
        scroll: prev.scroll || 0,
        starred: !!prev.starred,
        tags: prev.tags || [],
        highlights: prev.highlights || [],
        notes: prev.notes || [],
      });
    } else {
      rec = Object.assign(
        {
          id: util.uid(),
          savedAt: now,
          updatedAt: now,
          scroll: 0,
          starred: false,
          tags: [],
        },
        data,
        { highlights: [], notes: [] }
      );
    }
    await articles.put(rec);

    // 正文里有「空图表」（交互式图表靠 JS 画在 canvas/svg 里，静态 HTML 抓不到）时，
    // 让后台用标签页把图表画出来，再把图合并进静态正文 —— 公式仍用静态 HTML 里的 TeX，
    // 这样图表和公式都不会丢。
    if (hasEmptyFigures(rec.contentHTML) && !sessionStorage.getItem('rn-autotab:' + raw.url)) {
      sessionStorage.setItem('rn-autotab:' + raw.url, '1');
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          $('#loadingText').textContent = '正文里有交互式图表，正在用浏览器重新渲染图表…';
          const res = await chrome.runtime.sendMessage({ type: 'capture:charts', url: raw.url });
          if (res && res.ok && res.token) {
            const charts = await store.get(K.raw(res.token), null);
            await store.remove(K.raw(res.token));
            if (charts && charts.html) {
              rec.contentHTML = mergeFigures(rec.contentHTML, charts.html);
              rec.wordCount = util.countWords(util.stripHtml(rec.contentHTML));
              if (charts.siteStyle && !rec.siteStyle) rec.siteStyle = charts.siteStyle;
              await articles.put(rec);
            }
          }
        } catch (e) {}
      }
    }

    startReading(rec);
    util.toast('已存入书库');
  }

  /** 把「标签页里画好的图表」搬到静态正文的对应空 figure 里，文字/公式保持静态版本 */
  function mergeFigures(baseHtml, chartsHtml) {
    try {
      const base = document.createElement('div');
      base.innerHTML = baseHtml || '';
      const charts = document.createElement('div');
      charts.innerHTML = chartsHtml || '';
      const MEDIA = 'img, svg, canvas, picture';
      const hasMedia = (f) => !!f.querySelector('img, svg, canvas, picture, video, iframe');
      const baseFigs = Array.from(base.querySelectorAll('figure'));
      const chartFigs = Array.from(charts.querySelectorAll('figure'));
      const withMedia = chartFigs.filter(hasMedia);
      if (!withMedia.length) return baseHtml;

      const fill = (fig, srcFigure) => {
        const media = srcFigure.querySelector(MEDIA);
        if (!fig || !media || hasMedia(fig)) return false;
        const node = media.cloneNode(true);
        // 图表放在图注前面
        const cap = fig.querySelector('figcaption');
        if (cap) fig.insertBefore(node, cap);
        else fig.insertBefore(node, fig.firstChild);
        return true;
      };

      let added = 0;
      if (chartFigs.length === baseFigs.length) {
        // 同一页面抓的两次结果，figure 顺序一致：按序号一一对应最可靠
        baseFigs.forEach((fig, i) => {
          if (fill(fig, chartFigs[i])) added++;
        });
      } else {
        // 数量对不上时退回顺序匹配
        baseFigs
          .filter((f) => !hasMedia(f))
          .forEach((fig, i) => {
            if (fill(fig, withMedia[i] || withMedia[withMedia.length - 1])) added++;
          });
      }
      return added ? base.innerHTML : baseHtml;
    } catch (e) {
      return baseHtml;
    }
  }

  /** figure 里既没有图片也没有图表，说明是运行时才画出来的交互图表 */
  function hasEmptyFigures(html) {
    if (!html || html.indexOf('<figure') < 0) return false;
    const box = document.createElement('div');
    box.innerHTML = html;
    const figs = Array.from(box.querySelectorAll('figure'));
    if (!figs.length) return false;
    // 有些站点的 SVG 是运行时注入的（静态 HTML 里是空 <svg>），所以只要有一张空图就值得重抓
    return figs.some((f) => !f.querySelector('img, svg, canvas, video, iframe'));
  }

  /* ================= 渲染 ================= */

  function startReading(art) {
    state.article = art;
    applyPrefs();
    document.title = art.title + ' · 阅巢';
    $('#crumb').textContent = art.title;
    $('#crumb').title = art.title;
    $('#srcLine').innerHTML =
      '<b>' + util.esc(art.siteName || util.hostOf(art.url)) + '</b>' +
      (art.byline ? ' · ' + util.esc(art.byline) : '');
    $('#title').textContent = art.title;

    const words = art.wordCount || util.countWords(util.stripHtml(art.contentHTML));
    const meta = [];
    if (art.savedAt) meta.push('保存于 ' + util.fmtDay(art.savedAt));
    meta.push(words.toLocaleString('en-US') + ' 字');
    meta.push('约 ' + util.readingMinutes(words) + ' 分钟');
    const srcLink =
      '<a href="' + util.esc(art.canonicalUrl || art.url) + '" target="_blank" rel="noopener">原文 ↗</a>';
    $('#metaline').innerHTML = meta.map((m) => '<span>' + util.esc(m) + '</span>').join('') + srcLink;
    if (!art.wordCount) {
      art.wordCount = words;
      articles.put(art).catch(() => {});
    }

    contentEl.innerHTML = art.contentHTML || '<p>（没有抓到正文）</p>';
    postProcess();
    renderMath(contentEl);
    buildToc();
    applyHighlights();
    renderAnnotations();
    renderTags();
    renderSummary();
    updateCounts();
    hideLoading();
    restoreScroll();

    if (!art.highlights) art.highlights = [];
    if (!art.notes) art.notes = [];
    if (!art.summary && state.prefs && state.prefs.autoSummary) {
      setTimeout(() => generateSummary(), 400);
    }
  }

  function postProcess() {
    // Readability 会包一层 <div id="readability-page-1" class="page">，拆掉它
    let guard = 0;
    while (guard++ < 4) {
      const kids = Array.from(contentEl.children);
      if (kids.length !== 1) break;
      const only = kids[0];
      if (only.tagName !== 'DIV') break;
      if (!(only.id === 'readability-page-1' || only.classList.contains('page'))) break;
      while (only.firstChild) contentEl.insertBefore(only.firstChild, only);
      only.remove();
    }
    const h1 = contentEl.querySelector('h1');
    if (h1 && state.article && h1.textContent.trim() === state.article.title.trim() && contentEl.children.length > 1) {
      h1.remove();
    }
    contentEl.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        img.style.display = 'none';
      });
    });
    contentEl.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', (e) => {
        const href = a.getAttribute('href') || '';
        if (!/^https?:/i.test(href)) e.preventDefault();
      });
    });
    // 图片加载完成后校正进度条
    contentEl.querySelectorAll('img').forEach((img) => {
      img.addEventListener('load', () => updateProgress());
    });
  }

  /* ================= 数学公式（本地 KaTeX 渲染） ================= */

  const MATH_PATTERNS = [
    { re: /\\\[([\s\S]+?)\\\]/g, display: true },
    { re: /\$\$([\s\S]+?)\$\$/g, display: true },
    { re: /\\\(([\s\S]+?)\\\)/g, display: false },
    { re: /\$([^$\n]+?)\$/g, display: false },
  ];

  function acceptTex(tex, display) {
    if (!tex) return false;
    if (display) return tex.length < 6000;
    if (tex.length > 220) return false;
    if (/^\s|\s$/.test(tex)) return false;
    return true;
  }

  function splitMath(text) {
    const out = [];
    let pos = 0;
    while (pos < text.length) {
      let best = null;
      for (const p of MATH_PATTERNS) {
        p.re.lastIndex = pos;
        const m = p.re.exec(text);
        if (!m) continue;
        if (!best || m.index < best.index) {
          best = { index: m.index, end: m.index + m[0].length, tex: m[1], display: p.display };
        }
      }
      if (!best) break;
      if (!acceptTex(best.tex, best.display)) {
        out.push({ text: text.slice(pos, best.end) });
        pos = best.end;
        continue;
      }
      if (best.index > pos) out.push({ text: text.slice(pos, best.index) });
      out.push({ tex: best.tex, display: best.display });
      pos = best.end;
    }
    if (pos < text.length) out.push({ text: text.slice(pos) });
    return out;
  }

  /** 把正文里的 TeX（$…$、$$…$$、\(…\)、\[…\]）用本地 KaTeX 渲染出来 */
  function renderMath(root) {
    if (!window.katex || !root) return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = node.nodeValue;
        if (!t || (t.indexOf('$') < 0 && t.indexOf('\\(') < 0 && t.indexOf('\\[') < 0)) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || p.closest('pre,code,.katex,script,style,textarea')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    let count = 0;
    for (const node of nodes) {
      const segs = splitMath(node.nodeValue);
      if (!segs.some((s) => s.tex)) continue;
      const frag = document.createDocumentFragment();
      for (const seg of segs) {
        if (seg.text) {
          frag.appendChild(document.createTextNode(seg.text));
          continue;
        }
        const el = document.createElement('span');
        el.className = 'rn-math' + (seg.display ? ' rn-math-display' : '');
        const macros = (state.article && state.article.macros) || {};
        let tex = seg.tex;
        // mathtools 的 \norm*{x}：星号表示自动尺寸，我们的宏定义已经是自适应的
        if (Object.keys(macros).length) {
          tex = tex.replace(/\\([A-Za-z@]{2,})\*/g, (all, name) => (macros['\\' + name] ? '\\' + name : all));
        }
        const merged = resolveUnknownMacros(tex, macros, !!seg.display);
        try {
          window.katex.render(tex, el, {
            displayMode: !!seg.display,
            throwOnError: false,
            strict: false,
            trust: false,
            output: 'html',
            macros: merged,
          });
          count++;
        } catch (err) {
          el.textContent = seg.display ? '\\[' + seg.tex + '\\]' : '$' + seg.tex + '$';
          el.className = 'rn-math-fallback';
        }
        frag.appendChild(el);
      }
      node.parentNode.replaceChild(frag, node);
    }
    return count;
  }

  /** 站点用了没定义的宏（比如 MathJax 宏文件没抓到 \ev）时，用直立文字兜底，避免红色报错 */
  function resolveUnknownMacros(tex, macros, displayMode) {
    const merged = Object.assign({}, macros || {});
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        window.katex.renderToString(tex, {
          displayMode,
          throwOnError: true,
          strict: false,
          output: 'html',
          macros: merged,
        });
        return merged;
      } catch (err) {
        const msg = String((err && err.message) || '');
        const m = msg.match(/Undefined control sequence:?\s*\\([A-Za-z@]+)/i) || msg.match(/\\\\([A-Za-z@]+)/);
        if (!m) return merged;
        const name = '\\' + m[1];
        if (merged[name]) return merged;
        const at = tex.indexOf(name);
        const takesArg = at >= 0 && /^\s*\{/.test(tex.slice(at + name.length));
        merged[name] = '\\operatorname{' + m[1] + '}' + (takesArg ? '\\left(#1\\right)' : '');
      }
    }
    return merged;
  }

  function buildToc() {
    const heads = Array.from(contentEl.querySelectorAll('h2,h3'));
    let list = heads;
    if (heads.length < 4) {
      // Substack / 公众号等常见排版：小标题其实是加粗的段落
      list = Array.from(contentEl.querySelectorAll('h2,h3,p')).filter((el) => {
        if (/^H[23]$/.test(el.tagName)) return true;
        const t = el.textContent.trim();
        if (!t || t.length < 4 || t.length > 90) return false;
        if (/[。.!?？：:]$/.test(t)) return false;
        const strong = el.querySelector('strong,b');
        return !!strong && strong.textContent.trim().length >= t.length * 0.7;
      });
    }
    state.toc = list.map((el, i) => {
      if (!el.id) el.id = 'rn-h-' + i;
      return { id: el.id, level: el.tagName === 'H3' || el.tagName === 'P' ? 3 : 2, text: el.textContent.trim() };
    });
    const box = $('#tocList');
    box.textContent = '';
    if (!state.toc.length) {
      box.innerHTML = '<div class="side-empty">这篇文章没有小标题。</div>';
      return;
    }
    for (const h of state.toc) {
      const b = document.createElement('button');
      b.className = 'toc-item' + (h.level === 3 ? ' lv3' : '');
      b.textContent = h.text;
      b.addEventListener('click', () => scrollToId(h.id));
      box.appendChild(b);
    }
  }

  function scrollToId(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 68;
    window.scrollTo({ top, behavior: 'smooth' });
  }

  /* ================= 设置 / 主题 ================= */

  function applyPrefs() {
    const p = state.prefs || {};
    const theme = p.theme || 'paper';
    html.setAttribute('data-theme', theme);
    html.style.setProperty('--font-size', (p.fontSize || 19) + 'px');
    html.style.setProperty('--line-height', String(p.lineHeight || 1.85));
    html.style.setProperty('--readw', (p.lineWidth || 700) + 'px');
    applySiteStyle(theme);
  }

  /** 「跟随站点」主题：把原站文章区域算出来的字体/配色搬到阅读页 */
  function applySiteStyle(theme) {
    const root = document.documentElement;
    const vars = ['--font-body', '--font-heading', '--fg', '--fg-soft', '--bg', '--brand'];
    const s = state.article && state.article.siteStyle;
    if (theme !== 'site' || !s) {
      vars.forEach((v) => root.style.removeProperty(v));
      if (theme === 'site') html.setAttribute('data-theme', 'paper');
      return;
    }
    const set = (name, value) => {
      if (value && typeof value === 'string' && value.trim() && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') {
        root.style.setProperty(name, value);
      } else {
        root.style.removeProperty(name);
      }
    };
    set('--font-body', s.fontBody);
    set('--font-heading', s.fontHeading);
    set('--fg', s.color);
    if (s.color) set('--fg-soft', s.color);
    set('--bg', s.bg);
    set('--brand', s.brand);
  }

  function hasSiteStyle() {
    return !!(state.article && state.article.siteStyle && (state.article.siteStyle.fontBody || state.article.siteStyle.color));
  }

  async function changeTheme() {
    const order = ['paper', 'site', 'light', 'sepia', 'dark'];
    const cur = html.getAttribute('data-theme') || 'paper';
    let idx = order.indexOf(cur);
    for (let i = 1; i <= order.length; i++) {
      const next = order[(idx + i) % order.length];
      if (next === 'site' && !hasSiteStyle()) continue;
      html.setAttribute('data-theme', next);
      state.prefs = await RN.settings.set({ theme: next });
      applySiteStyle(next);
      util.toast({ paper: '纸感', site: '跟随站点', light: '浅色', sepia: '米色', dark: '深色' }[next]);
      return;
    }
  }

  async function changeFont(delta) {
    const cur = Number(state.prefs.fontSize) || 18;
    const next = Math.min(28, Math.max(14, cur + delta));
    state.prefs = await RN.settings.set({ fontSize: next });
    applyPrefs();
  }

  /* ================= 进度 / 滚动位置 ================= */

  function updateProgress() {
    const docH = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = docH > 0 ? Math.min(1, Math.max(0, window.scrollY / docH)) : 0;
    state.scrollRatio = ratio;
    $('#progBar').style.width = (ratio * 100).toFixed(2) + '%';
  }

  const saveScroll = util.debounce(async () => {
    if (!state.article) return;
    state.article.scroll = state.scrollRatio;
    try {
      await store.set(K.article(state.article.id), state.article);
    } catch (e) {}
  }, 2500);

  function restoreScroll() {
    const target = (state.article && state.article.scroll) || 0;
    if (!target || target < 0.02) return;
    const apply = () => {
      const docH = document.documentElement.scrollHeight - window.innerHeight;
      if (docH > 100) window.scrollTo({ top: docH * target });
      updateProgress();
    };
    setTimeout(apply, 120);
    setTimeout(apply, 600);
  }

  window.addEventListener(
    'scroll',
    util.throttle(() => {
      updateProgress();
      saveScroll();
      hideSelbar();
    }, 100),
    { passive: true }
  );

  /* ================= 错误 / 加载 ================= */

  function hideLoading() {
    const el = $('#loading');
    if (el) el.classList.add('hide');
  }

  function showError(msg) {
    hideLoading();
    contentEl.innerHTML =
      '<div class="error-box"><h2>打不开这篇文章</h2><p>' +
      util.esc(msg) +
      '</p><div class="row"><button class="primary" id="errRetry">重新抓取链接</button>' +
      '<a class="ghost" style="text-decoration:none;padding:7px 14px;border:1px solid var(--line);border-radius:8px;color:var(--fg-soft)" href="' +
      util.pageUrl('library.html') +
      '">回到书库</a></div></div>';
    const retry = document.getElementById('errRetry');
    if (!retry) return;
    retry.addEventListener('click', async () => {
      const url = prompt('输入要抓取的文章链接：', '');
      if (!url) return;
      retry.disabled = true;
      retry.textContent = '抓取中…';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'capture:url', url });
        if (res && res.ok) {
          util.toast('抓取成功');
          setTimeout(() => location.reload(), 500);
        } else {
          util.toast((res && res.error) || '仍然失败', 'error');
        }
      } catch (e) {
        util.toast('抓取失败：' + e.message, 'error');
      }
      retry.disabled = false;
      retry.textContent = '重新抓取链接';
    });
  }

  /* ================= 文章概述 ================= */

  function renderSummary() {
    const art = state.article;
    const card = $('#summaryCard');
    if (!art || !card) return;
    const sum = art.summary;
    const badge = $('#sumBadge');
    const source = $('#sumSource');
    const body = $('#sumBody');
    const copy = $('#sumCopy');
    const toggle = $('#sumToggle');
    const gen = $('#sumGen');
    card.hidden = false;

    if (!sum || !sum.text) {
      badge.textContent = '概述';
      source.textContent = 'AI 或本地摘录';
      body.className = 'summary-body muted';
      body.textContent = '还没有概述。点「生成概述」让 AI 概括这篇文章（需要 API Key）；没配 Key 会用本地摘录。';
      copy.hidden = true;
      toggle.hidden = true;
      gen.hidden = false;
      gen.textContent = '生成概述';
      gen.disabled = false;
      return;
    }

    badge.textContent = sum.source === 'ai' ? 'AI 概述' : '摘录概述';
    source.textContent = sum.model ? sum.model + ' · ' + util.fmtDay(sum.createdAt) : util.fmtDay(sum.createdAt);
    body.className = 'summary-body';
    body.textContent = sum.text;
    body.hidden = !!state.summaryCollapsed;
    copy.hidden = false;
    toggle.hidden = false;
    toggle.textContent = state.summaryCollapsed ? '展开' : '收起';
    gen.hidden = false;
    gen.textContent = '重新生成';
    gen.disabled = false;
  }

  function renderSummaryError(res) {
    const body = $('#sumBody');
    const gen = $('#sumGen');
    const source = $('#sumSource');
    if (!body) return;
    body.className = 'summary-body';
    body.hidden = false;
    body.textContent = '生成失败：' + ((res && res.error) || '未知错误');
    if (res && res.hint) {
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.style.marginTop = '6px';
      hint.textContent = res.hint;
      body.appendChild(hint);
    }
    if (res && res.fallback) {
      const row = document.createElement('div');
      row.style.marginTop = '10px';
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.textContent = '用本地摘录代替';
      btn.addEventListener('click', async () => {
        state.article.summary = {
          text: res.fallback,
          source: 'extract',
          model: '',
          createdAt: Date.now(),
        };
        await articles.put(state.article);
        renderSummary();
      });
      row.appendChild(btn);
      body.appendChild(row);
    }
    if (source) source.textContent = '需要可用的 AI 模型';
    if (gen) {
      gen.textContent = '重试';
      gen.disabled = false;
    }
  }

  async function generateSummary() {
    const art = state.article;
    if (!art) return;
    const gen = $('#sumGen');
    const source = $('#sumSource');
    if (gen) {
      gen.disabled = true;
      gen.textContent = '生成中…';
    }
    if (source) source.textContent = '正在请求模型…（通常几秒）';
    try {
      const res = await RN.summarize.summarize(art);
      if (res.ok) {
        art.summary = {
          text: res.text,
          source: res.source,
          model: res.model || '',
          createdAt: Date.now(),
        };
        state.summaryCollapsed = false;
        await articles.put(art);
        renderSummary();
        util.toast(res.source === 'ai' ? 'AI 概述已生成' : '已生成摘录概述');
      } else {
        renderSummaryError(res);
      }
    } catch (err) {
      renderSummaryError({ error: err.message || String(err) });
    }
  }

  /* ================= 标签 ================= */

  function renderTags() {
    const row = $('#tagRow');
    row.textContent = '';
    for (const t of state.article.tags || []) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = t;
      chip.title = '点击删除标签';
      chip.addEventListener('click', () => {
        state.article.tags = state.article.tags.filter((x) => x !== t);
        persist();
        renderTags();
      });
      row.appendChild(chip);
    }
    const add = document.createElement('button');
    add.className = 'tag';
    add.style.border = '0';
    add.style.cursor = 'pointer';
    add.textContent = '＋ 标签';
    add.addEventListener('click', () => {
      const t = prompt('新标签（用逗号分隔可加多个）');
      if (!t) return;
      const list = t.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      state.article.tags = Array.from(new Set([...(state.article.tags || []), ...list]));
      persist();
      renderTags();
    });
    row.appendChild(add);
  }

  /* ================= 文本映射与选区 ================= */

  function buildTextMap(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (p && p.closest('script,style,button')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let pos = 0;
    let text = '';
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      nodes.push({ node: n, start: pos, end: pos + len });
      text += n.nodeValue;
      pos += len;
    }
    return { nodes, text };
  }

  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.commonAncestorContainer)) return null;
    const map = buildTextMap(contentEl);
    const segs = [];
    for (const n of map.nodes) {
      if (!range.intersectsNode(n.node)) continue;
      let s = 0;
      let e = n.node.nodeValue.length;
      if (range.startContainer === n.node) s = range.startOffset;
      if (range.endContainer === n.node) e = range.endOffset;
      if (e > s) segs.push({ start: n.start + s, end: n.start + e });
    }
    if (!segs.length) return null;
    const start = segs[0].start;
    const end = segs[segs.length - 1].end;
    const raw = map.text.slice(start, end);
    if (!raw.trim()) return null;
    return {
      start,
      end,
      raw,
      text: raw.replace(/\s+/g, ' ').trim(),
      prefix: map.text.slice(Math.max(0, start - 30), start),
      suffix: map.text.slice(end, end + 30),
      rect: range.getBoundingClientRect(),
    };
  }

  function showSelbar(rect) {
    const bar = $('#selbar');
    bar.hidden = false;
    const bw = 330;
    const bh = 36;
    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(8, Math.min(window.innerWidth - bw - 8, left));
    let top = rect.top - bh - 8;
    if (top < 58) top = Math.min(window.innerHeight - bh - 8, rect.bottom + 8);
    bar.style.left = Math.round(left) + 'px';
    bar.style.top = Math.round(top) + 'px';
  }

  function hideSelbar() {
    const bar = $('#selbar');
    if (bar) bar.hidden = true;
  }

  function clearMarks() {
    contentEl.querySelectorAll('mark.rn-hl').forEach((m) => {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    });
    contentEl.normalize();
  }

  function locate(text, hl) {
    const raw = hl.raw || hl.quote || '';
    if (!raw) return -1;
    const approx = typeof hl.start === 'number' ? hl.start : 0;
    const from = Math.max(0, approx - 60);
    const near = text.slice(from, approx + raw.length + 60);
    const i = near.indexOf(raw);
    if (i >= 0) return from + i;
    if (hl.prefix) {
      const j = text.indexOf(hl.prefix + raw);
      if (j >= 0) return j + hl.prefix.length;
    }
    return text.indexOf(raw);
  }

  function wrapRange(start, end, hl) {
    const map = buildTextMap(contentEl);
    for (const seg of map.nodes) {
      if (seg.end <= start || seg.start >= end) continue;
      const s = Math.max(start, seg.start) - seg.start;
      const e = Math.min(end, seg.end) - seg.start;
      if (e <= s) continue;
      const range = document.createRange();
      range.setStart(seg.node, s);
      range.setEnd(seg.node, e);
      const mark = document.createElement('mark');
      mark.className = 'rn-hl' + (hl.note ? ' has-note' : '');
      mark.dataset.id = hl.id;
      mark.dataset.color = hl.color || 'yellow';
      if (hl.note) mark.title = '笔记：' + hl.note;
      try {
        range.surroundContents(mark);
      } catch (err) {
        continue;
      }
    }
  }

  function applyHighlights() {
    if (!state.article) return;
    clearMarks();
    const text = buildTextMap(contentEl).text;
    for (const hl of state.article.highlights || []) {
      const start = locate(text, hl);
      if (start < 0) {
        hl.lost = true;
        continue;
      }
      hl.lost = false;
      hl.start = start;
      hl.end = start + (hl.raw || hl.quote || '').length;
      wrapRange(hl.start, hl.end, hl);
    }
  }

  /* ================= 持久化 ================= */

  async function persist() {
    if (!state.article) return;
    state.article.updatedAt = Date.now();
    try {
      await articles.put(state.article);
    } catch (e) {
      util.toast('保存失败：' + (e.message || e), 'error');
      return;
    }
    updateCounts();
  }

  function updateCounts() {
    const a = state.article || {};
    const n = (a.highlights || []).length + (a.notes || []).length;
    const badge = $('#annoCount');
    if (badge) {
      badge.textContent = n;
      badge.classList.toggle('zero', n === 0);
    }
    const tab = $('#tabCount');
    if (tab) tab.textContent = n;
  }

  /* ================= 高亮操作 ================= */

  function colorHex(c) {
    return { yellow: '#ffd633', green: '#56d28c', blue: '#5ea9ff', pink: '#ff8ab2' }[c] || '#ffd633';
  }

  async function createHighlight(color, note) {
    const s = state.sel;
    if (!s) {
      util.toast('先选中正文里的文字');
      return null;
    }
    const hl = {
      id: util.uid(),
      raw: s.raw,
      quote: s.text,
      prefix: s.prefix,
      suffix: s.suffix,
      start: s.start,
      end: s.end,
      color: color || 'yellow',
      note: note || '',
      createdAt: Date.now(),
    };
    state.article.highlights = state.article.highlights || [];
    state.article.highlights.push(hl);
    await persist();
    applyHighlights();
    renderAnnotations();
    hideSelbar();
    window.getSelection().removeAllRanges();
    return hl;
  }

  async function removeHighlight(id) {
    state.article.highlights = (state.article.highlights || []).filter((h) => h.id !== id);
    await persist();
    applyHighlights();
    renderAnnotations();
  }

  async function onContentClick(e) {
    const mark = e.target.closest('mark.rn-hl');
    if (!mark) return;
    const id = mark.dataset.id;
    const hl = (state.article.highlights || []).find((h) => h.id === id);
    if (!hl) return;
    openDialog({
      title: hl.note ? '编辑笔记' : '给这段高亮加笔记',
      quote: hl.quote || hl.raw,
      text: hl.note || '',
      deletable: true,
      onSave: async (text) => {
        hl.note = text;
        await persist();
        applyHighlights();
        renderAnnotations();
        closeDialog();
      },
      onDelete: async () => {
        await removeHighlight(id);
        closeDialog();
      },
    });
  }

  /* ================= 标注侧栏 ================= */

  function renderSideTabs(active) {
    document.querySelectorAll('.side-tabs button[data-tab]').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === active);
    });
    $('#tocList').hidden = active !== 'toc';
    $('#annoList').hidden = active !== 'anno';
  }

  function syncSide() {
    document.body.classList.toggle('side-open', !$('#side').hidden);
  }

  function toggleSide(tab) {
    const side = $('#side');
    const same = !side.hidden && document.querySelector('.side-tabs button.on').dataset.tab === tab;
    if (same) {
      side.hidden = true;
      syncSide();
      return;
    }
    side.hidden = false;
    renderSideTabs(tab);
    syncSide();
    if (tab === 'anno') renderAnnotations();
  }

  function renderAnnotations() {
    const box = $('#annoList');
    if (!box) return;
    box.textContent = '';
    const a = state.article || {};
    const notes = a.notes || [];
    const hls = (a.highlights || []).slice().sort((x, y) => (x.lost ? 1 : 0) - (y.lost ? 1 : 0) || (x.start || 0) - (y.start || 0));

    const add = document.createElement('button');
    add.className = 'ghost side-add';
    add.textContent = '＋ 随手笔记（不绑定原文）';
    add.addEventListener('click', () => {
      openDialog({
        title: '随手笔记',
        quote: '',
        text: '',
        onSave: async (text) => {
          if (!text) return closeDialog();
          a.notes = a.notes || [];
          a.notes.push({ id: util.uid(), text, createdAt: Date.now() });
          await persist();
          renderAnnotations();
          closeDialog();
        },
      });
    });
    box.appendChild(add);

    if (notes.length) {
      const h = document.createElement('div');
      h.className = 'side-empty';
      h.style.padding = '4px 2px';
      h.textContent = '随手笔记';
      box.appendChild(h);
      for (const n of notes) {
        const item = document.createElement('div');
        item.className = 'anno-item';
        const body = document.createElement('div');
        body.className = 'anno-note';
        body.style.marginTop = '0';
        body.textContent = n.text;
        const foot = document.createElement('div');
        foot.className = 'anno-foot';
        const time = document.createElement('span');
        time.textContent = util.fmtDay(n.createdAt);
        const edit = document.createElement('a');
        edit.textContent = '编辑';
        edit.addEventListener('click', () =>
          openDialog({
            title: '编辑笔记',
            quote: '',
            text: n.text,
            deletable: true,
            onSave: async (text) => {
              n.text = text;
              await persist();
              renderAnnotations();
              closeDialog();
            },
            onDelete: async () => {
              a.notes = a.notes.filter((x) => x.id !== n.id);
              await persist();
              renderAnnotations();
              closeDialog();
            },
          })
        );
        const del = document.createElement('a');
        del.textContent = '删除';
        del.addEventListener('click', async () => {
          a.notes = a.notes.filter((x) => x.id !== n.id);
          await persist();
          renderAnnotations();
        });
        foot.append(time, edit, del);
        item.append(body, foot);
        box.appendChild(item);
      }
    }

    if (!hls.length) {
      const empty = document.createElement('div');
      empty.className = 'side-empty';
      empty.textContent = '还没有高亮。选中正文里的一段文字，工具条上点颜色就能标记，点「笔记」可以顺便写下想法。';
      box.appendChild(empty);
      return;
    }

    const h2 = document.createElement('div');
    h2.className = 'side-empty';
    h2.style.padding = '4px 2px';
    h2.textContent = '高亮与摘录（' + hls.length + '）';
    box.appendChild(h2);

    for (const hl of hls) {
      const item = document.createElement('div');
      item.className = 'anno-item';
      const q = document.createElement('div');
      q.className = 'anno-quote';
      q.style.setProperty('--hlc', colorHex(hl.color));
      q.textContent = hl.quote || hl.raw || '';
      if (hl.note) {
        const n = document.createElement('div');
        n.className = 'anno-note';
        n.textContent = hl.note;
        item.append(q, n);
      } else {
        item.appendChild(q);
      }
      const foot = document.createElement('div');
      foot.className = 'anno-foot';
      const time = document.createElement('span');
      time.textContent = util.fmtDay(hl.createdAt);
      foot.appendChild(time);
      if (hl.lost) {
        const lost = document.createElement('span');
        lost.className = 'loss';
        lost.textContent = '找不到原文位置';
        foot.appendChild(lost);
      } else {
        const jump = document.createElement('a');
        jump.textContent = '定位';
        jump.addEventListener('click', () => {
          const el = contentEl.querySelector('mark.rn-hl[data-id="' + hl.id + '"]');
          if (!el) return;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.remove('flash');
          void el.offsetWidth;
          el.classList.add('flash');
        });
        foot.appendChild(jump);
      }
      const edit = document.createElement('a');
      edit.textContent = hl.note ? '改笔记' : '加笔记';
      edit.addEventListener('click', () =>
        openDialog({
          title: '笔记',
          quote: hl.quote || hl.raw,
          text: hl.note || '',
          deletable: true,
          onSave: async (text) => {
            hl.note = text;
            await persist();
            applyHighlights();
            renderAnnotations();
            closeDialog();
          },
          onDelete: async () => {
            await removeHighlight(hl.id);
            closeDialog();
          },
        })
      );
      const del = document.createElement('a');
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        await removeHighlight(hl.id);
      });
      foot.append(edit, del);
      item.appendChild(foot);
      box.appendChild(item);
    }
  }

  /* ================= 笔记对话框 ================= */

  function openDialog(opts) {
    state.dlg = opts;
    $('#dlg').hidden = false;
    $('#dlgTitle').textContent = opts.title || '笔记';
    const q = $('#dlgQuote');
    if (opts.quote) {
      q.hidden = false;
      q.textContent = opts.quote;
    } else {
      q.hidden = true;
      q.textContent = '';
    }
    $('#dlgText').value = opts.text || '';
    $('#dlgDel').hidden = !(opts.deletable && opts.onDelete);
    setTimeout(() => $('#dlgText').focus(), 40);
  }

  function closeDialog() {
    $('#dlg').hidden = true;
    state.dlg = null;
  }

  async function submitDialog() {
    const o = state.dlg;
    if (!o) return;
    if (o.onSave) await o.onSave($('#dlgText').value.trim());
    else closeDialog();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      util.toast('已复制');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        util.toast('已复制');
      } catch (e2) {
        util.toast('复制失败', 'error');
      }
      ta.remove();
    }
  }

  /* ================= 翻译 ================= */

  function providerLabel(p) {
    return { google: 'Google 翻译', mymemory: 'MyMemory 翻译', api: 'API 模型' }[p] || p;
  }

  async function doTranslate(text) {
    const plain = String(text || '').trim();
    if (!plain) return;
    $('#tcard').hidden = false;
    $('#tcLabel').textContent = '翻译中…';
    const body = $('#tcBody');
    body.className = 'tc-body';
    body.textContent = '正在请求翻译…';
    try {
      const res = await RN.translate.translate(plain);
      state.lastTrans = res.text;
      body.className = 'tc-body';
      body.textContent = res.text;
      $('#tcLabel').textContent =
        (res.skipped ? '原文已是目标语言' : providerLabel(res.provider)) + (res.cached ? ' · 缓存' : '');
    } catch (err) {
      body.className = 'tc-body err';
      body.textContent = (err.message || '翻译失败') + '';
      if (err.hint) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = err.hint;
        body.appendChild(hint);
      }
      $('#tcLabel').textContent = '翻译失败';
    }
  }

  /* ================= 导出 / 菜单 ================= */

  function slug(name) {
    return (
      String(name || 'article')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || 'article'
    );
  }

  function buildMarkdown(art) {
    const lines = ['# ' + art.title, ''];
    lines.push('> 来源：' + (art.canonicalUrl || art.url));
    lines.push('> 保存：' + util.fmtDate(art.savedAt) + ' · ' + (art.wordCount || 0) + ' 字');
    if (art.byline) lines.push('> 作者：' + art.byline);
    lines.push('');
    const notes = art.notes || [];
    if (notes.length) {
      lines.push('## 随手笔记', '');
      notes.forEach((n, i) => lines.push(i + 1 + '. ' + n.text.replace(/\n/g, '\n   ')));
      lines.push('');
    }
    const hls = (art.highlights || []).slice().sort((a, b) => (a.start || 0) - (b.start || 0));
    if (hls.length) {
      lines.push('## 高亮与摘录', '');
      for (const h of hls) {
        lines.push('- 「' + (h.quote || h.raw || '') + '」');
        if (h.note) lines.push('  - 笔记：' + h.note.replace(/\n/g, '\n    '));
      }
      lines.push('');
    }
    lines.push('---', '', '由 阅巢 ReadNest 导出');
    return lines.join('\n');
  }

  async function refetch() {
    const url = state.article.canonicalUrl || state.article.url;
    util.toast('正在重新抓取…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'capture:url', url, open: false });
      if (res && res.ok) {
        const id = res.id || state.article.id;
        util.toast('正文已更新');
        setTimeout(() => location.replace(util.pageUrl('reader.html?id=' + id)), 500);
      } else {
        util.toast((res && res.error) || '重新抓取失败', 'error');
      }
    } catch (e) {
      util.toast('重新抓取失败：' + e.message, 'error');
    }
  }

  async function onMenuClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    $('#moreMenu').hidden = true;
    const art = state.article;
    if (!art) return;
    const act = btn.dataset.act;
    if (act === 'export') {
      util.download(slug(art.title) + '.md', buildMarkdown(art), 'text/markdown');
      util.toast('已导出 Markdown');
    } else if (act === 'source') {
      window.open(art.canonicalUrl || art.url, '_blank');
    } else if (act === 'copyurl') {
      copyText(art.canonicalUrl || art.url);
    } else if (act === 'refetch') {
      await refetch();
    } else if (act === 'delete') {
      if (!confirm('从书库删除《' + art.title + '》？高亮和笔记会一并删除。')) return;
      await articles.remove(art.id);
      location.href = util.pageUrl('library.html');
    } else if (act === 'settings') {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    }
  }

  /* ================= 划词工具条 ================= */

  async function onSelbarClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'copy') {
      const s = state.sel;
      hideSelbar();
      if (s) await copyText(s.raw.trim());
    } else if (act === 'hl') {
      const hl = await createHighlight(btn.dataset.color || 'yellow', '');
      if (hl) util.toast('已高亮');
    } else if (act === 'note') {
      const s = state.sel;
      hideSelbar();
      if (!s) return;
      openDialog({
        title: '写笔记',
        quote: s.text,
        text: '',
        onSave: async (text) => {
          await createHighlight('yellow', text);
          renderAnnotations();
          closeDialog();
        },
      });
    } else if (act === 'trans') {
      const s = state.sel;
      hideSelbar();
      if (s) await doTranslate(s.raw);
    }
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    $('#btnBack').addEventListener('click', () => {
      location.href = util.pageUrl('library.html');
    });
    $('#btnFontDown').addEventListener('click', () => changeFont(-1));
    $('#btnFontUp').addEventListener('click', () => changeFont(1));
    $('#btnTheme').addEventListener('click', changeTheme);
    $('#btnToc').addEventListener('click', () => toggleSide('toc'));
    $('#btnAnno').addEventListener('click', () => toggleSide('anno'));
    $('#btnMore').addEventListener('click', (e) => {
      e.stopPropagation();
      $('#moreMenu').hidden = !$('#moreMenu').hidden;
    });
    $('#moreMenu').addEventListener('click', (e) => {
      onMenuClick(e).catch((err) => util.toast(err.message, 'error'));
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#moreMenu') && !e.target.closest('#btnMore')) $('#moreMenu').hidden = true;
    });
    $('#sideClose').addEventListener('click', () => {
      $('#side').hidden = true;
      syncSide();
    });
    document.querySelectorAll('.side-tabs button[data-tab]').forEach((b) => {
      b.addEventListener('click', () => {
        renderSideTabs(b.dataset.tab);
        if (b.dataset.tab === 'anno') renderAnnotations();
      });
    });

    contentEl.addEventListener('mouseup', (e) => {
      if (e.target.closest('#selbar')) return;
      setTimeout(() => {
        const info = captureSelection();
        if (!info) {
          hideSelbar();
          return;
        }
        state.sel = info;
        showSelbar(info.rect);
      }, 10);
    });
    contentEl.addEventListener('click', (e) => {
      onContentClick(e).catch((err) => console.warn(err));
    });
    contentEl.addEventListener('mousedown', (e) => {
      if (!e.target.closest('mark.rn-hl')) hideSelbar();
    });
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#selbar')) hideSelbar();
    });
    $('#selbar').addEventListener('mousedown', (e) => e.preventDefault());
    $('#selbar').addEventListener('click', (e) => {
      onSelbarClick(e).catch((err) => util.toast(err.message, 'error'));
    });

    $('#btnAddNote').addEventListener('click', () => {
      openDialog({
        title: '随手笔记',
        quote: '',
        text: '',
        onSave: async (text) => {
          if (!text) return closeDialog();
          state.article.notes = state.article.notes || [];
          state.article.notes.push({ id: util.uid(), text, createdAt: Date.now() });
          await persist();
          renderAnnotations();
          closeDialog();
          if (!$('#side').hidden) renderSideTabs('anno');
        },
      });
    });

    const sumGen = $('#sumGen');
    if (sumGen) sumGen.addEventListener('click', () => generateSummary().catch((e) => util.toast(e.message, 'error')));
    const sumCopy = $('#sumCopy');
    if (sumCopy)
      sumCopy.addEventListener('click', () => {
        if (state.article && state.article.summary && state.article.summary.text) copyText(state.article.summary.text);
      });
    const sumToggle = $('#sumToggle');
    if (sumToggle)
      sumToggle.addEventListener('click', () => {
        state.summaryCollapsed = !state.summaryCollapsed;
        renderSummary();
      });

    $('#dlgCancel').addEventListener('click', closeDialog);
    $('#dlgSave').addEventListener('click', () => submitDialog().catch((e) => util.toast(e.message, 'error')));
    $('#dlgDel').addEventListener('click', async () => {
      const o = state.dlg;
      if (o && o.onDelete) await o.onDelete();
    });
    $('#dlgText').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submitDialog().catch((err) => util.toast(err.message, 'error'));
      }
    });
    $('#dlg').addEventListener('mousedown', (e) => {
      if (e.target.id === 'dlg') closeDialog();
    });

    $('#tcClose').addEventListener('click', () => {
      $('#tcard').hidden = true;
    });
    $('#tcCopy').addEventListener('click', () => {
      if (state.lastTrans) copyText(state.lastTrans);
    });
    $('#tcNote').addEventListener('click', () => {
      if (!state.lastTrans) return;
      const quote = state.sel ? state.sel.text : '';
      openDialog({
        title: quote ? '把译文存成笔记' : '新建笔记',
        quote,
        text: state.lastTrans,
        onSave: async (text) => {
          if (quote) {
            await createHighlight('blue', text);
          } else {
            state.article.notes = state.article.notes || [];
            state.article.notes.push({ id: util.uid(), text, createdAt: Date.now() });
            await persist();
          }
          renderAnnotations();
          closeDialog();
        },
      });
    });
    $('#tcSwap').addEventListener('click', () => {
      if (state.sel) doTranslate(state.sel.raw);
      else util.toast('先选中一段文字');
    });
    $('#tcSettings').addEventListener('click', (e) => {
      e.preventDefault();
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', () => {
      if (!state.article) return;
      state.article.scroll = state.scrollRatio;
      try {
        store.set(K.article(state.article.id), state.article);
      } catch (e) {}
    });
  }

  function onKeyDown(e) {
    const tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable);
    if (e.key === 'Escape') {
      if (!$('#dlg').hidden) return closeDialog();
      if (!$('#tcard').hidden) {
        $('#tcard').hidden = true;
        return;
      }
      if (!$('#selbar').hidden) return hideSelbar();
      if (!$('#moreMenu').hidden) {
        $('#moreMenu').hidden = true;
        return;
      }
      if (!$('#side').hidden) {
        $('#side').hidden = true;
        syncSide();
        return;
      }
      return;
    }
    if (typing) return;
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) toggleSide('anno');
    else if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey) toggleSide('toc');
    else if (e.key === '+' || e.key === '=') changeFont(1);
    else if (e.key === '-') changeFont(-1);
  }

  boot();

  window.__rnReader = { state, boot, buildMarkdown, applyHighlights, renderAnnotations };
})();


