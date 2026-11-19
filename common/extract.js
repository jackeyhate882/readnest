/*
 * 阅巢 ReadNest — 页面正文抽取
 * 用法：
 *   - 注入到目标标签页后调用 window.__rnExtract()
 *   - 阅读页里对解析好的 Document 调用 window.__rnExtractFromDoc(doc, {url, base})
 * 依赖 vendor/Readability.js
 */
(function () {
  if (window.__rnExtractFromDoc) return;

  const DROP_TAGS = 'script,style,noscript,link,meta,svg,foreignObject,video,audio,form,input,button,select,textarea';

  function absUrl(u, base) {
    try {
      return new URL(String(u).trim(), base).href;
    } catch (e) {
      return u;
    }
  }

  function metaOf(doc, names) {
    for (const n of names) {
      const el =
        doc.querySelector('meta[property="' + n + '"]') ||
        doc.querySelector('meta[name="' + n + '"]') ||
        doc.querySelector('meta[itemprop="' + n + '"]');
      if (el) {
        const v = el.getAttribute('content');
        if (v && v.trim()) return v.trim();
      }
    }
    return '';
  }

  function faviconOf(doc, base) {
    const sel = ['link[rel="apple-touch-icon"]', 'link[rel="icon"]', 'link[rel="shortcut icon"]', 'link[rel="mask-icon"]'];
    for (const s of sel) {
      const el = doc.querySelector(s);
      if (el && el.getAttribute('href')) return absUrl(el.getAttribute('href'), base);
    }
    return '';
  }

  function countWords(text) {
    if (!text) return 0;
    const cjkRe = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
    const cjk = (text.match(cjkRe) || []).length;
    const latin = (text.replace(cjkRe, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
    return cjk + latin;
  }

  function cleanTitle(t) {
    return String(t || '')
      .replace(/\s*[|\-–—]\s*(Medium|Substack|Hugging Face|知乎|简书|CSDN).*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------------- 图片 / 图表预处理 ---------------- */

  /** 把「点开大图」这类按钮拆开，别把按钮里的图一起扔掉 */
  function unwrapMediaButtons(root) {
    Array.from(root.querySelectorAll('button, [role="button"]')).forEach((btn) => {
      if (!btn.querySelector('img, picture, figure, svg, canvas')) return;
      if ((btn.textContent || '').trim().length > 80) return;
      const parent = btn.parentNode;
      if (!parent) return;
      while (btn.firstChild) parent.insertBefore(btn.firstChild, btn);
      parent.removeChild(btn);
    });
  }

  const SVG_TEXT_PROPS = ['font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'fill', 'stroke', 'opacity', 'letter-spacing'];
  const SVG_SHAPE_PROPS = ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin'];

  /** 把浏览器算出来的样式写进 SVG 副本，保证离开站点 CSS 后图表样子不变 */
  function freezeSvgStyles(cloneSvg, liveSvg, win) {
    const targets = [cloneSvg].concat(Array.from(cloneSvg.querySelectorAll('*')));
    const sources = liveSvg ? [liveSvg].concat(Array.from(liveSvg.querySelectorAll('*'))) : [];
    for (let i = 0; i < targets.length; i++) {
      const el = targets[i];
      const live = sources[i];
      if (!el.tagName || /^(title|desc|style)$/i.test(el.tagName)) continue;
      if (!live) continue;
      let cs = null;
      try {
        cs = win.getComputedStyle(live);
      } catch (e) {
        continue;
      }
      if (!cs) continue;
      const props = /^(text|tspan)$/i.test(el.tagName) ? SVG_TEXT_PROPS : SVG_SHAPE_PROPS;
      const parts = [];
      for (const p of props) {
        const v = cs.getPropertyValue(p);
        if (v && v.trim()) parts.push(p + ':' + v.trim());
      }
      if (!parts.length) continue;
      el.setAttribute('style', ((el.getAttribute('style') || '').replace(/;?$/, ';')) + parts.join(';'));
    }
  }

  function svgLooksRenderable(svg) {
    if (!svg.querySelector('*')) return false;
    if (!svg.getAttribute('viewBox') && !(svg.getAttribute('width') && svg.getAttribute('height'))) return false;
    const texts = Array.from(svg.querySelectorAll('text'));
    if (!texts.length) return true;
    const styled = texts.filter((t) => {
      const style = t.getAttribute('style') || '';
      return t.getAttribute('font-size') || style.indexOf('font-size') >= 0;
    });
    // 文字样式全靠站点 CSS 的图表，单独搬出来会错位，宁可不放
    return styled.length >= texts.length * 0.8;
  }

  /** 从站点 CSS 里筛出能匹配这个 SVG 的规则，供静态图表使用（data URI 是独立文档，不会污染页面） */
  function filterCssFor(cssText, target) {
    if (!cssText || !cssText.trim() || !target) return '';
    const picked = [];
    let styleEl = null;
    try {
      styleEl = document.createElement('style');
      styleEl.textContent = cssText;
      document.head.appendChild(styleEl);
      const sheet = styleEl.sheet;
      if (!sheet) return '';
      const matches = (sel) => {
        try {
          return target.matches(sel) || !!target.querySelector(sel);
        } catch (e) {
          return false;
        }
      };
      const walk = (rules) => {
        for (const rule of Array.from(rules || [])) {
          if (rule.type === 1 && rule.selectorText) {
            // 一个选择器列表里只要有一个能命中就整条保留
            const sels = rule.selectorText.split(',').map((s) => s.trim());
            if (sels.some(matches)) picked.push(rule.cssText);
          } else if (rule.cssRules) {
            walk(rule.cssRules);
          }
        }
      };
      walk(sheet.cssRules);
    } catch (e) {
      return '';
    } finally {
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    }
    return picked.join('\n');
  }

  /** 把 <svg> 图表转成 data:image/svg+xml 的 <img>：Readability 会丢 svg，但不会丢 img */
  function svgToImg(svg, win, liveEl, cssText) {
    const doc = svg.ownerDocument;
    try {
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      // 静态 HTML 里的图表靠站点 CSS 上色，把匹配到的规则一起打进图片里
      if (!liveEl && cssText) {
        const css = filterCssFor(cssText, clone);
        if (css) {
          const styleNode = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
          styleNode.textContent = css;
          clone.insertBefore(styleNode, clone.firstChild);
        }
      }
      const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      let w = 0;
      let h = 0;
      if (win && liveEl && liveEl.getBoundingClientRect) {
        const rect = liveEl.getBoundingClientRect();
        if (rect) {
          w = Math.round(rect.width);
          h = Math.round(rect.height);
        }
      }
      if (!w || !h) {
        w = vb.length === 4 ? vb[2] : Number(svg.getAttribute('width')) || 640;
        h = vb.length === 4 ? vb[3] : Number(svg.getAttribute('height')) || 400;
      }
      if (w < 20 || h < 20) {
        svg.remove();
        return;
      }
      clone.setAttribute('width', String(w));
      clone.setAttribute('height', String(h));
      // 图表通常是透明底黑字，深色主题下会看不见，直接烤一层白底
      const bg = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x', '0');
      bg.setAttribute('y', '0');
      bg.setAttribute('width', '100%');
      bg.setAttribute('height', '100%');
      bg.setAttribute('fill', '#ffffff');
      clone.insertBefore(bg, clone.firstChild);
      const xml = new XMLSerializer().serializeToString(clone);
      if (!xml || xml.length < 40) {
        svg.remove();
        return;
      }
      const bytes = new TextEncoder().encode(xml);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      const url = 'data:image/svg+xml;base64,' + btoa(bin);
      const img = doc.createElement('img');
      img.setAttribute('src', url);
      img.setAttribute('alt', svg.getAttribute('aria-label') || '图表');
      img.setAttribute('loading', 'lazy');
      img.setAttribute('data-rn-chart', '1');
      svg.replaceWith(img);
    } catch (e) {
      svg.remove();
    }
  }

  /** 图表常是运行时画进 <svg>/<canvas> 的：SVG 冻结样式后转成图片，canvas 直接转图片 */
  function prepareCharts(root, originalDoc, cssText) {
    const win = (originalDoc && originalDoc.defaultView) || (root.ownerDocument && root.ownerDocument.defaultView);
    const liveRoot = originalDoc && originalDoc !== root ? originalDoc : null;
    // 克隆节点没有渲染信息：样式要从原文档对应节点读（没有 window 的解析文档不算“活的”）
    const liveSvgs = liveRoot && win ? Array.from(liveRoot.querySelectorAll('svg')) : [];
    Array.from(root.querySelectorAll('svg')).forEach((svg, idx) => {
      if (svg.closest('.katex, .katex-display, math')) return;
      if (!svg.querySelector('*')) {
        svg.remove();
        return;
      }
      const live = liveSvgs[idx] || null;
      if (win && live && win.getComputedStyle) freezeSvgStyles(svg, live, win);
      svgToImg(svg, win, live, cssText);
    });

    const liveCanvases = liveRoot && win ? Array.from(liveRoot.querySelectorAll('canvas')) : [];
    if (!liveCanvases.length) return;
    Array.from(root.querySelectorAll('canvas')).forEach((canvas, idx) => {
      try {
        const source = liveCanvases[idx];
        if (!source) {
          canvas.remove();
          return;
        }
        const w = source.width || 0;
        const h = source.height || 0;
        if (w < 80 || h < 60) {
          canvas.remove();
          return;
        }
        // 先铺白底再拷贝，避免深色主题下透明 PNG 变成一片黑
        const tmp = canvas.ownerDocument.createElement('canvas');
        tmp.width = w;
        tmp.height = h;
        const ctx = tmp.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(source, 0, 0);
        const url = tmp.toDataURL('image/png');
        if (!url || url.length < 400 || url.length > 1600000) {
          canvas.remove();
          return;
        }
        const img = canvas.ownerDocument.createElement('img');
        img.setAttribute('src', url);
        img.setAttribute('alt', source.getAttribute('aria-label') || '图表');
        img.setAttribute('loading', 'lazy');
        img.setAttribute('data-rn-chart', '1');
        canvas.replaceWith(img);
      } catch (e) {
        canvas.remove();
      }
    });
  }

  function sanitize(html, base, doc) {
    const holder = (doc || document).createElement('div');
    holder.innerHTML = html;
    holder.querySelectorAll(DROP_TAGS).forEach((n) => n.remove());
    holder.querySelectorAll('canvas').forEach((n) => n.remove());
    holder.querySelectorAll('svg').forEach((svg) => {
      if (!svgLooksRenderable(svg)) svg.remove();
    });
    holder.querySelectorAll('*').forEach((el) => {
      const isLink = (n) => n === 'href' || n === 'xlink:href';
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value;
        if (name.startsWith('on') || (name === 'style' && /expression|javascript:/i.test(val))) {
          el.removeAttribute(attr.name);
        } else if ((isLink(name) || name === 'src' || name === 'poster') && /^\s*javascript:/i.test(val)) {
          el.removeAttribute(attr.name);
        } else if ((isLink(name) || name === 'src' || name === 'poster') && val) {
          // 同文档内的锚点（如 SVG 的 <use href="#icon">）保持原样，不要拼成绝对地址
          if (val.trim().charAt(0) === '#') continue;
          el.setAttribute(attr.name, absUrl(val, base));
        } else if (name === 'srcset' && val) {
          el.setAttribute(
            'srcset',
            val
              .split(',')
              .map((part) => {
                const seg = part.trim().split(/\s+/);
                if (seg[0]) seg[0] = absUrl(seg[0], base);
                return seg.join(' ');
              })
              .join(', ')
          );
        }
      }
      if (el.tagName === 'IMG') {
        if (!el.getAttribute('src') && el.dataset && el.dataset.src) el.setAttribute('src', absUrl(el.dataset.src, base));
        if (!el.getAttribute('src') && el.getAttribute('srcset')) {
          const first = el.getAttribute('srcset').split(',')[0].trim().split(/\s+/)[0];
          if (first) el.setAttribute('src', first);
        }
        el.setAttribute('loading', 'lazy');
        el.setAttribute('decoding', 'async');
        el.removeAttribute('data-src');
        el.removeAttribute('data-srcset');
      }
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      if (el.tagName === 'USE') {
        const href = (el.getAttribute('href') || el.getAttribute('xlink:href') || '').trim();
        if (href && href.charAt(0) !== '#') el.remove();
      }
    });
    holder.querySelectorAll('p').forEach((p) => {
      if (!p.textContent.trim() && !p.querySelector('img,br')) p.remove();
    });
    holder.querySelectorAll('figure').forEach((f) => {
      const img = f.querySelector('img');
      const cap = f.querySelector('figcaption');
      if (img && cap && cap.textContent.trim() === (img.getAttribute('alt') || '').trim()) cap.remove();
    });
    return holder.innerHTML;
  }

  function heuristicExtract(doc, base) {
    const candidates = Array.from(
      doc.querySelectorAll('article,main,[role="main"],.post,.entry-content,.article-body,.content,.markdown')
    );
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (text.length < 300) continue;
      const links = el.querySelectorAll('a').length;
      const paras = el.querySelectorAll('p').length;
      const score = text.length + paras * 120 - links * 60;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (!best) best = doc.body;
    if (!best) return null;
    const clone = best.cloneNode(true);
    return { html: sanitize(clone.innerHTML, base, doc), text: (best.textContent || '').trim() };
  }

  /** 把已渲染的数学公式（KaTeX / MathML）还原成 TeX 文本，交给阅读页统一重新渲染 */
  function normalizeMath(root) {
    const doc = root.ownerDocument || root;
    const annSel = 'annotation[encoding="application/x-tex"]';

    root.querySelectorAll('.katex').forEach((el) => {
      const ann = el.querySelector(annSel);
      if (!ann || !ann.textContent.trim()) return;
      const tex = ann.textContent.trim();
      const displayWrap = el.closest('.katex-display');
      const host = displayWrap || el;
      const span = doc.createElement(displayWrap ? 'div' : 'span');
      span.className = 'rn-tex';
      span.textContent = displayWrap ? '\\[' + tex + '\\]' : '\\(' + tex + '\\)';
      host.replaceWith(span);
    });

    root.querySelectorAll('.MathJax, .MathJax_Display').forEach((el) => {
      const tex = el.getAttribute('data-latex') || (el.querySelector(annSel) || {}).textContent || '';
      if (!tex.trim()) return;
      const display = el.classList.contains('MathJax_Display') || el.getAttribute('display') === 'block';
      const span = doc.createElement(display ? 'div' : 'span');
      span.className = 'rn-tex';
      span.textContent = display ? '\\[' + tex.trim() + '\\]' : '\\(' + tex.trim() + '\\)';
      el.replaceWith(span);
    });

    root.querySelectorAll('math').forEach((el) => {
      const ann = el.querySelector(annSel);
      if (!ann || !ann.textContent.trim()) return;
      const display = el.getAttribute('display') === 'block';
      const span = doc.createElement(display ? 'div' : 'span');
      span.className = 'rn-tex';
      span.textContent = display ? '\\[' + ann.textContent.trim() + '\\]' : '\\(' + ann.textContent.trim() + '\\)';
      el.replaceWith(span);
    });
  }

  /**
   * 有些站点把配图放在和正文并列的「媒体栏」div 里（例如 Anthropic 的
   * .media-column），Readability 会把这类只有图的 div 当垃圾删掉。
   * 这里把「只包着图/图注」的 div 拆掉，让 figure 回到正文流里。
   */
  function unwrapMediaWrappers(root) {
    const divs = Array.from(root.querySelectorAll('div'));
    for (const div of divs) {
      if (!div.isConnected) continue;
      if (!div.querySelector('img, figure, picture')) continue;
      if ((div.textContent || '').trim().length > 600) continue;
      const prose = Array.from(div.querySelectorAll('p,h1,h2,h3,h4,h5,h6,ul,ol,table,blockquote,pre')).filter(
        (el) => !el.closest('figure, picture')
      );
      if (prose.length) continue;
      const parent = div.parentNode;
      if (!parent) continue;
      while (div.firstChild) parent.insertBefore(div.firstChild, div);
      parent.removeChild(div);
    }
  }

  /* ---------------- 图注编号（Figure 1 / 图 2 / Table 3） ---------------- */

  const LABEL_PROP = /^--(figure|fig|image|img|caption|table)[-_]?(label|number|no|caption|title|prefix)$/i;
  const LABEL_RE = /^(figure|fig\.?|table|图|表)\s*\d+/i;

  function addFigureLabel(cap, label) {
    label = String(label || '').trim();
    if (!cap || !label) return;
    const text = (cap.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && (LABEL_RE.test(text) || text.indexOf(label) === 0)) return;
    const doc = cap.ownerDocument;
    const strong = doc.createElement('strong');
    strong.textContent = label;
    const sep = doc.createTextNode(' · ');
    const frag = doc.createDocumentFragment();
    frag.appendChild(strong);
    frag.appendChild(sep);
    cap.insertBefore(frag, cap.firstChild);
  }

  function captionHost(el) {
    const fig = el.closest ? el.closest('figure') : null;
    if (fig) return fig.querySelector('figcaption') || fig;
    if (el.tagName === 'FIGCAPTION') return el;
    return null;
  }

  /**
   * 站点常把「Figure 1」放在 CSS 变量里由 ::before 伪元素显示
   * （例如 Anthropic：style="--figure-label:&quot;Figure 1&quot;"），
   * 正文抽取时伪元素内容不会被带上，所以这里把它还原成可见文字。
   */
  function restoreFigureLabels(root) {
    const win = root.ownerDocument && root.ownerDocument.defaultView;

    // 1) 内联样式里的自定义属性（不依赖站点 CSS，抓取和本地解析都适用）
    root.querySelectorAll('[style*="--"]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      let label = '';
      style.split(';').forEach((decl) => {
        const idx = decl.indexOf(':');
        if (idx < 0) return;
        const name = decl.slice(0, idx).trim();
        if (!LABEL_PROP.test(name)) return;
        const raw = decl
          .slice(idx + 1)
          .trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\\(["'])/g, '$1');
        if (raw && raw.length < 40) label = raw;
      });
      if (label) addFigureLabel(captionHost(el), label);
    });

    // 2) 浏览器计算出来的 ::before 文本（只在本页抓取时可用）
    if (!win || !win.getComputedStyle) return;
    root.querySelectorAll('figcaption, figure').forEach((node) => {
      let content = '';
      try {
        content = win.getComputedStyle(node, '::before').content || '';
      } catch (e) {
        return;
      }
      const m = content.match(/^["'](.*)["']$/);
      if (!m || !m[1].trim()) return;
      const label = m[1].trim();
      if (!LABEL_RE.test(label)) return;
      addFigureLabel(captionHost(node), label);
    });
  }

  /* ---------------- 站点自定义 TeX 宏（\newcommand） ---------------- */

  function readBalanced(text, start) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return { body: text.slice(start + 1, i), end: i + 1 };
      }
    }
    return null;
  }

  /**
   * 很多技术博客在 MathJax 配置里用 \newcommand 定义自己的宏
   * （alexwang.ai 就有 \transpose、\Sbb 之类）。KaTeX 不认识这些，
   * 会把命令名标红，所以先把定义捞出来交给 KaTeX。
   */
  /** 记录原站正文区域的字体/配色，供阅读页「跟随站点」主题使用（需要活的文档） */
  function collectSiteStyle(doc) {
    const win = doc && doc.defaultView;
    if (!win || !doc.body) return null;
    const cs = (el) => {
      if (!el) return null;
      try {
        return win.getComputedStyle(el);
      } catch (e) {
        return null;
      }
    };
    const content =
      doc.querySelector('.c-article__content, article, [role="main"], main, #content') || doc.body;
    const bodyCs = cs(doc.body);
    const rootCs = cs(content) || bodyCs;
    const h1Cs = cs(doc.querySelector('h1'));
    const h2Cs = cs(content.querySelector('h2, h3'));
    const linkCs = cs(content.querySelector('p a[href], a[href]'));
    const pageBg = cs(doc.documentElement);
    const style = {
      fontBody: rootCs && rootCs.fontFamily,
      fontHeading: (h1Cs && h1Cs.fontFamily) || (h2Cs && h2Cs.fontFamily) || (rootCs && rootCs.fontFamily),
      fontSize: rootCs && rootCs.fontSize,
      lineHeight: rootCs && rootCs.lineHeight,
      color: (rootCs && rootCs.color) || (bodyCs && bodyCs.color),
      bg: pageBg && pageBg.backgroundColor,
      brand: linkCs && linkCs.color,
    };
    return style.fontBody || style.color ? style : null;
  }

  function collectMacros(root) {
    const macros = {};
    if (!root || !root.querySelectorAll) return macros;
    let blocks = '';
    Array.from(root.querySelectorAll('script')).forEach((s) => {
      if (s.textContent) blocks += s.textContent + '\n';
    });
    // 不少主题把宏定义放在隐藏节点里（如 <div id="mathjax-macros">\[\newcommand…\]</div>）
    Array.from(root.querySelectorAll('#mathjax-macros, [id*="macro" i], [class*="macro" i]')).forEach((el) => {
      if (el.textContent) blocks += el.textContent + '\n';
    });
    if (blocks.indexOf('\\newcommand') < 0 && blocks.indexOf('\\renewcommand') < 0) {
      const body = root.body || root.documentElement;
      if (body) blocks += '\n' + (body.textContent || '');
    }
    if (!blocks) return macros;
    const re = /\\(?:re)?newcommand\*?\s*\{?\s*\\([A-Za-z@]{1,30})\s*\}?\s*(?:\[(\d+)\])?\s*\{/g;
    let m;
    while ((m = re.exec(blocks))) {
      const name = m[1];
      const bodyStart = m.index + m[0].length - 1;
      const parsed = readBalanced(blocks, bodyStart);
      if (!parsed || !parsed.body) continue;
      const body = parsed.body.trim();
      if (!body || body.length > 300) continue;
      macros['\\' + name] = body;
    }

    // mathtools 的 \DeclarePairedDelimiters{\norm}{\lVert}{\rVert} 之类
    const delimRe = /\\DeclarePairedDelimiters\s*\{?\s*\\([A-Za-z@]{1,30})\s*\}?\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
    while ((m = delimRe.exec(blocks))) {
      const name = m[1];
      const left = m[2].trim();
      const right = m[3].trim();
      if (!left || !right) continue;
      macros['\\' + name] = '\\left' + left + '#1\\right' + right;
    }

    // \DeclareMathOperator{\img}{img}
    const opRe = /\\DeclareMathOperator\*?\s*\{?\s*\\([A-Za-z@]{1,30})\s*\}?\s*\{([^{}]*)\}/g;
    while ((m = opRe.exec(blocks))) {
      const name = m[1];
      const text = m[2].trim();
      if (!text || text.length > 80) continue;
      macros['\\' + name] = '\\operatorname{' + text + '}';
    }
    return macros;
  }

  function extractFromDoc(doc, opts) {
    opts = opts || {};
    const docUrl = opts.url || (doc.location && doc.location.href) || '';
    const base = opts.base || docUrl || 'about:blank';

    const canonicalEl = doc.querySelector('link[rel="canonical"]');
    const out = {
      url: docUrl,
      canonicalUrl: (canonicalEl && absUrl(canonicalEl.getAttribute('href'), base)) || metaOf(doc, ['og:url']) || docUrl,
      title: '',
      byline: '',
      siteName: metaOf(doc, ['og:site_name']) || '',
      excerpt: metaOf(doc, ['og:description', 'description', 'twitter:description']),
      lang: ((doc.documentElement && doc.documentElement.getAttribute('lang')) || '').slice(0, 12),
      favicon: faviconOf(doc, base),
      publishedTime: metaOf(doc, ['article:published_time', 'datePublished', 'pubdate']),
      image: metaOf(doc, ['og:image']),
      contentHTML: '',
      textLength: 0,
      wordCount: 0,
      extractor: '',
      // 页面里的公式是否已经被 MathJax 排版掉（DOM 里只剩 mjx-container，TeX 源码丢失）
      typesetMath: !!(doc.querySelector && doc.querySelector('mjx-container, mjx-assistive-mml')),
      macros: opts.macros || collectMacros(doc),
      siteStyle: collectSiteStyle(doc),
    };

    // 复制一份再处理，避免改动调用方传入的（可能正在浏览的）页面
    const work = doc.cloneNode(true);
    normalizeMath(work);
    unwrapMediaWrappers(work);
    unwrapMediaButtons(work);
    prepareCharts(work, doc, opts.css);
    restoreFigureLabels(work);

    let parsed = null;
    if (typeof window.Readability === 'function') {
      try {
        work.querySelectorAll('script,noscript,style,iframe').forEach((n) => n.remove());
        const reader = new window.Readability(work, {
          charThreshold: 220,
          keepClasses: false,
          nbTopCandidates: 8,
          maxElemsToParse: 0,
        });
        parsed = reader.parse();
      } catch (e) {
        console.warn('[ReadNest] Readability 解析失败', e);
      }
    }

    if (parsed && parsed.content && parsed.textContent && parsed.textContent.trim().length > 200) {
      out.contentHTML = sanitize(parsed.content, base, doc);
      out.title = cleanTitle(parsed.title) || '';
      out.byline = parsed.byline || '';
      out.excerpt = out.excerpt || parsed.excerpt || '';
      out.siteName = parsed.siteName || out.siteName;
      out.lang = parsed.lang || out.lang;
      out.publishedTime = out.publishedTime || parsed.publishedTime || '';
      out.textLength = parsed.textContent.trim().length;
      out.extractor = 'readability';
    } else {
      const fallback = doc.cloneNode(true);
      normalizeMath(fallback);
      unwrapMediaWrappers(fallback);
      unwrapMediaButtons(fallback);
      prepareCharts(fallback, doc, opts.css);
      restoreFigureLabels(fallback);
      const h = heuristicExtract(fallback, base);
      if (h) {
        out.contentHTML = h.html;
        out.textLength = h.text.length;
        out.extractor = 'heuristic';
      }
    }

    if (!out.siteName) out.siteName = (docUrl ? new URL(docUrl).hostname.replace(/^www\./, '') : '');
    if (!out.title) out.title = metaOf(doc, ['og:title', 'twitter:title']) || doc.title;
    out.title = cleanTitle(out.title);
    if (!out.byline) out.byline = metaOf(doc, ['author', 'article:author']);
    if (out.byline && /^https?:\/\//.test(out.byline)) out.byline = '';

    const tmp = doc.createElement('div');
    tmp.innerHTML = out.contentHTML || '';
    const plain = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
    if (!out.textLength) out.textLength = plain.length;
    out.wordCount = countWords(plain);
    return out;
  }

  window.__rnExtractFromDoc = extractFromDoc;
  window.__rnCollectMacros = collectMacros;

  /** 交互图表多是动画画出来的：等 canvas 内容稳定（且不是空白帧）再抓 */
  async function settleCanvases(timeout) {
    const limit = timeout || 2600;
    const canvases = Array.from(document.querySelectorAll('canvas')).filter((c) => c.width >= 80 && c.height >= 60);
    if (!canvases.length) return false;
    const snapshot = (c) => {
      try {
        return c.toDataURL('image/png');
      } catch (e) {
        return '';
      }
    };
    const ink = (c) => {
      try {
        const ctx = c.getContext('2d');
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        const step = Math.max(4, Math.floor((c.width * c.height) / 5000)) * 4;
        let n = 0;
        for (let k = 0; k < data.length; k += step) {
          if (data[k] < 250 || data[k + 1] < 250 || data[k + 2] < 250) n++;
        }
        return n;
      } catch (e) {
        return 0;
      }
    };
    const t0 = Date.now();
    let prev = canvases.map(snapshot);
    let stable = 0;
    while (Date.now() - t0 < limit) {
      await new Promise((r) => setTimeout(r, 260));
      const cur = canvases.map(snapshot);
      if (cur.some((s, i) => s !== prev[i])) stable = 0;
      else stable++;
      prev = cur;
      const painted = canvases.every((c) => ink(c) > 8);
      if (stable >= 2 && (painted || Date.now() - t0 > 1200)) return true;
    }
    return false;
  }

  window.__rnExtract = async function () {
    try {
      await settleCanvases(2600);
    } catch (e) {}
    return extractFromDoc(document, { url: location.href, base: document.baseURI || location.href });
  };
})();
