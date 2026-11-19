/*
 * 阅巢 ReadNest — 后台服务（MV3 Service Worker）
 * 负责：抓取网页 → 抽取正文 → 保存 → 打开阅读页
 */
importScripts('common/bridge.js');

const RN = globalThis.RN;
const { articles, util } = RN;

const READER = 'reader.html';

function isRestricted(url) {
  return /^(chrome|edge|about|devtools|chrome-extension|view-source|data):/i.test(url || '');
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || '未知错误');
  if (/Cannot access|Cannot access contents|chrome:\/\//i.test(msg)) {
    return { message: '这个页面不允许扩展读取', hint: '浏览器内置页面（edge://、chrome://、扩展商店）无法抓取，换普通网页试试。' };
  }
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(msg)) {
    return { message: '抓取网页失败（网络错误）', hint: '该站点可能禁止脚本抓取或有反爬，已尝试用后台标签页方式；也可以在浏览器里打开该页后用弹窗里的「抓取当前页面」。' };
  }
  if (/HTTP (4\d\d|5\d\d)/i.test(msg)) {
    return { message: '网站返回了 ' + msg.replace(/^HTTP\s*/i, ''), hint: '可能需要登录或有反爬限制，试试先在本机浏览器里打开该页面，再点「抓取当前页面」。' };
  }
  return { message: msg, hint: '' };
}

/* ---------------- 保存 ---------------- */

async function persistExtracted(data) {
  if (!data || !data.contentHTML || !String(data.contentHTML).trim()) {
    throw new Error('没有解析到正文内容');
  }
  // 应用嵌入页 / 登录墙常常只能抓到几行占位文字，别把垃圾存进书库
  const plainLen = data.textLength || 0;
  if (plainLen < 100 && (data.wordCount || 0) < 15) {
    throw new Error('页面正文太少（可能是应用嵌入页、登录墙或反爬），没有保存');
  }
  const url = data.canonicalUrl || data.url;
  const index = await articles.index();
  const existing = index.find((a) => a.canonicalUrl === url || a.url === url);
  const now = Date.now();
  const wordCount = data.wordCount || (data.textLength ? data.textLength : 0);

  if (existing) {
    const prev = (await articles.get(existing.id)) || {};
    const merged = Object.assign({}, prev, {
      title: data.title || prev.title,
      byline: data.byline || prev.byline,
      siteName: data.siteName || prev.siteName,
      excerpt: data.excerpt || prev.excerpt,
      lang: data.lang || prev.lang,
      favicon: data.favicon || prev.favicon,
      image: data.image || prev.image,
      contentHTML: data.contentHTML,
      wordCount: wordCount || prev.wordCount,
      readingTime: util.readingMinutes(wordCount || prev.wordCount || 0),
      extractor: data.extractor || prev.extractor,
      updatedAt: now,
      savedAt: prev.savedAt || now,
      highlights: prev.highlights || [],
      notes: prev.notes || [],
      scroll: prev.scroll || 0,
      starred: !!prev.starred,
      tags: prev.tags || [],
    });
    await articles.put(merged);
    return merged;
  }

  const rec = {
    id: util.uid(),
    url: data.url || url,
    canonicalUrl: url,
    title: data.title || '（无标题）',
    byline: data.byline || '',
    siteName: data.siteName || util.hostOf(url),
    excerpt: data.excerpt || '',
    lang: data.lang || '',
    favicon: data.favicon || '',
    image: data.image || '',
    publishedTime: data.publishedTime || '',
    contentHTML: data.contentHTML,
    wordCount,
    readingTime: util.readingMinutes(wordCount),
    extractor: data.extractor || '',
    savedAt: now,
    updatedAt: now,
    scroll: 0,
    starred: false,
    tags: [],
    highlights: [],
    notes: [],
  };
  await articles.put(rec);
  return rec;
}

function openReader(id) {
  return chrome.tabs.create({ url: chrome.runtime.getURL(READER + '?id=' + encodeURIComponent(id)) });
}

/* ---------------- 从标签页抽取 ---------------- */

/**
 * 注入所有框架（含跨域 iframe）。像 HuggingFace Space 这种把整个应用放在
 * iframe 里的页面，正文其实在子框架中，取正文最多的那个框架。
 */
async function extractFromTab(tabId) {
  const files = ['vendor/Readability.js', 'common/extract.js'];
  const run = (allFrames) =>
    chrome.scripting
      .executeScript({ target: { tabId, allFrames }, files })
      .then(() =>
        chrome.scripting.executeScript({
          target: { tabId, allFrames },
          func: () => (typeof window.__rnExtract === 'function' ? window.__rnExtract() : null),
        })
      );

  let results = null;
  try {
    results = await run(true);
  } catch (e) {
    // 某些 iframe 可能注入失败（about:blank / 错误页），退回到只看顶层
    results = await run(false);
  }
  const list = (results || []).filter((r) => r && r.result && r.result.contentHTML);
  if (!list.length) throw new Error('页面中没有找到可读正文');
  list.sort((a, b) => (b.result.textLength || 0) - (a.result.textLength || 0));

  let chosen = list[0];
  const top = list.find((r) => r.frameId === 0);
  const topLen = top ? top.result.textLength || 0 : 0;
  // 顶层正文和子框架差不多时，用顶层（通常是正文页），避免抓到广告 iframe
  if (top && chosen.frameId !== 0 && topLen >= (chosen.result.textLength || 0) * 0.75) chosen = top;

  const data = chosen.result;
  if (chosen.frameId !== 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url && /^https?:/i.test(tab.url)) {
        data.url = tab.url;
        data.canonicalUrl = tab.url;
        data.siteName = util.hostOf(tab.url);
      }
      if (tab && tab.title) data.title = tab.title;
    } catch (e) {}
  }
  return data;
}

/* ---------------- 等待标签页加载 ---------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForTabLoad(tabId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < (timeoutMs || 30000)) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      throw new Error('标签页已关闭');
    }
    if (tab.status === 'complete') {
      await sleep(900); // 给前端框架渲染留一点时间
      return tab;
    }
    await sleep(400);
  }
  throw new Error('打开页面超时');
}

/* ---------------- 抓取流程 ---------------- */

async function saveTempHtml(html, url, extra) {
  const token = util.uid();
  await chrome.storage.local.set({
    [RN.K.raw(token)]: Object.assign({ html, url, ts: Date.now() }, extra || {}),
  });
  return token;
}

/**
 * 只把「图表」用标签页画出来存成临时数据，交给阅读页合并进静态正文。
 * 这样公式/文字仍来自静态 HTML（TeX 完整），图表来自渲染后的页面。
 */
async function captureChartsViaTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabLoad(tab.id, 35000);
    const data = await extractFromTab(tab.id);
    const token = await saveTempHtml(data.contentHTML || '', url, { siteStyle: data.siteStyle || null });
    return token;
  } finally {
    try {
      const s = await RN.settings.all();
      if (s.closeSourceTab !== false) await chrome.tabs.remove(tab.id);
    } catch (e) {}
  }
}

async function captureViaNewTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabLoad(tab.id, 35000);
    const data = await extractFromTab(tab.id);
    if (!data.canonicalUrl) data.canonicalUrl = url;
    const rec = await persistExtracted(data);
    return rec;
  } finally {
    try {
      const s = await RN.settings.all();
      if (s.closeSourceTab !== false) await chrome.tabs.remove(tab.id);
    } catch (e) {}
  }
}

async function captureUrl(url, opts) {
  opts = opts || {};
  if (!url) throw new Error('请输入链接');
  url = String(url).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error('链接格式不对');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http/https 网页链接');
  if (isRestricted(url)) throw new Error('这个地址不能抓取');

  // 只更新正文（阅读页的「重新抓取」）：用后台标签页抽取，不再开新的阅读页
  if (opts.open === false) {
    return await captureViaNewTab(url);
  }

  let html = '';
  let fetchErr = null;
  try {
    const resp = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const ct = resp.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml|text\/plain/i.test(ct)) {
      throw new Error('这个链接不是网页（' + (ct || '未知类型') + '）');
    }
    html = await resp.text();
  } catch (e) {
    fetchErr = e;
  }

  const s = await RN.settings.all();

  if (html && html.length > 400) {
    // 应用壳页面（正文在 iframe 里，静态 HTML 只有几行占位文字）改走标签页抽取
    const crudeLen = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim().length;
    if (s.fallbackViaTab !== false && (/<iframe/i.test(html) || /<canvas/i.test(html)) && crudeLen < 900) {
      try {
        const rec = await captureViaNewTab(url);
        await openReader(rec.id);
        return rec;
      } catch (e) {
        // 落回直连解析路径
      }
    }
    const token = util.uid();
    await chrome.storage.local.set({ [RN.K.raw(token)]: { html, url, ts: Date.now() } });
    await chrome.tabs.create({ url: chrome.runtime.getURL(READER + '?raw=' + encodeURIComponent(token)) });
    return { pending: true };
  }

  if (s.fallbackViaTab !== false) {
    try {
      const rec = await captureViaNewTab(url);
      await openReader(rec.id);
      return rec;
    } catch (e2) {
      throw new Error((fetchErr && fetchErr.message ? '直连抓取失败；' : '') + '后台标签页抓取也失败：' + e2.message);
    }
  }
  throw fetchErr || new Error('抓取失败');
}

async function fetchPageHtml(url) {
  const resp = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.text();
}

async function captureActiveTab(tabId) {
  const tab = tabId ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) throw new Error('找不到当前标签页');
  if (isRestricted(tab.url)) throw new Error('这个页面不允许扩展读取');
  const data = await extractFromTab(tab.id);

  // 页面里的公式已经被 MathJax 排版过（DOM 里只剩 mjx-container，TeX 源码没了），
  // 这时用静态 HTML 取正文/公式，再用这次标签页抓取的结果补图表。
  const looksMathJax = !!(data.typesetMath || /mjx-container|mjx-assistive-mml|MJX-TEX|class="MathJax/i.test(data.contentHTML || ''));
  if (looksMathJax && /^https?:/i.test(tab.url || '')) {
    try {
      const html = await fetchPageHtml(tab.url);
      if (html && html.length > 2000) {
        const rawToken = await saveTempHtml(html, tab.url);
        const chartsToken = await saveTempHtml(data.contentHTML || '', tab.url, { siteStyle: data.siteStyle || null });
        await chrome.tabs.create({
          url: chrome.runtime.getURL(READER + '?raw=' + rawToken + '&charts=' + chartsToken),
        });
        return { merged: true, title: tab.title };
      }
    } catch (e) {
      // 静态抓取失败就用标签页结果
    }
  }

  if (data.canonicalUrl) data.url = data.url || tab.url;
  const rec = await persistExtracted(data);
  await openReader(rec.id);
  return rec;
}

/* ---------------- 消息路由 ---------------- */

const handlers = {
  async 'capture:tab'(msg) {
    const rec = await captureActiveTab(msg.tabId);
    if (rec && rec.merged) return { ok: true, merged: true, title: rec.title };
    return { ok: true, id: rec.id, title: rec.title, existed: false };
  },
  async 'capture:charts'(msg) {
    const token = await captureChartsViaTab(msg.url);
    return { ok: true, token };
  },
  async 'capture:url'(msg) {
    const rec = await captureUrl(msg.url, { open: msg.open !== false });
    if (rec && rec.pending) return { ok: true, pending: true };
    return { ok: true, id: rec.id, title: rec.title };
  },
  async 'open:reader'(msg) {
    const tab = await openReader(msg.id);
    return { ok: true, tabId: tab.id };
  },
  async 'open:library'() {
    await chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
    return { ok: true };
  },
  async 'ping'() {
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  (async () => {
    try {
      const res = await fn(msg, sender);
      sendResponse(res);
    } catch (err) {
      const f = friendlyError(err);
      console.warn('[ReadNest]', msg.type, err);
      sendResponse({ ok: false, error: f.message, hint: f.hint });
    }
  })();
  return true;
});

/* ---------------- 右键菜单 / 首次安装 ---------------- */

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'rn-save-page',
      title: '保存当前页面到阅巢',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'rn-save-link',
      title: '保存这个链接到阅巢',
      contexts: ['link'],
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  setupMenus();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('library.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(setupMenus);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-page') return;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) await captureActiveTab(tabs[0].id);
  } catch (err) {
    console.warn('[ReadNest] 快捷键抓取失败', err);
    chrome.tabs.create({
      url: chrome.runtime.getURL('reader.html?error=' + encodeURIComponent(friendlyError(err).message)),
    });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'rn-save-page' && tab) {
      await captureActiveTab(tab.id);
    } else if (info.menuItemId === 'rn-save-link' && info.linkUrl) {
      await captureUrl(info.linkUrl);
    }
  } catch (err) {
    console.warn('[ReadNest] 右键抓取失败', err);
    chrome.tabs.create({
      url: chrome.runtime.getURL('reader.html?error=' + encodeURIComponent(friendlyError(err).message)),
    });
  }
});
