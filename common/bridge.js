/*
 * 阅巢 ReadNest — 共用基础层
 * 存储（chrome.storage.local，测试环境退回 localStorage）、设置、工具函数
 */
(function () {
  const G = typeof window !== 'undefined' ? window : globalThis;
  const RN = (G.RN = G.RN || {});

  const KEY = {
    INDEX: 'rn_articles',
    SETTINGS: 'rn_settings',
    article: (id) => 'rn_article:' + id,
    raw: (token) => 'rn_raw:' + token,
  };
  RN.K = KEY;

  const hasChromeStorage = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);

  function lsGet(key) {
    if (typeof localStorage === 'undefined') return undefined;
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : undefined;
    } catch (e) {
      return undefined;
    }
  }
  function lsSet(key, val) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn('[ReadNest] localStorage 写入失败', e);
    }
  }

  /** 统一存储：key -> value */
  const store = {
    async get(key, fallback) {
      if (hasChromeStorage) {
        const res = await chrome.storage.local.get(key);
        return res && res[key] !== undefined ? res[key] : fallback;
      }
      const v = lsGet(key);
      return v === undefined ? fallback : v;
    },
    async set(key, value) {
      if (hasChromeStorage) {
        await chrome.storage.local.set({ [key]: value });
        return;
      }
      lsSet(key, value);
    },
    async remove(key) {
      if (hasChromeStorage) {
        await chrome.storage.local.remove(key);
        return;
      }
      try {
        localStorage.removeItem(key);
      } catch (e) {}
    },
    async getMany(keys) {
      if (hasChromeStorage) return await chrome.storage.local.get(keys);
      const out = {};
      for (const k of keys) out[k] = lsGet(k);
      return out;
    },
  };
  RN.store = store;

  /* ---------------- 设置 ---------------- */
  const DEFAULT_SETTINGS = {
    provider: 'google', // google | mymemory | api
    targetLang: 'zh-CN',
    apiBase: 'https://api.deepseek.com/v1',
    apiModel: 'deepseek-chat',
    apiKey: '',
    theme: 'paper', // paper | site | light | sepia | dark
    fontSize: 19,
    lineHeight: 1.85,
    lineWidth: 700,
    openReaderInNewTab: true,
    closeSourceTab: true,
    fallbackViaTab: true,
    autoSummary: false,
    summaryLength: 'medium', // short | medium | long
  };

  let settingsCache = null;
  let settingsPromise = null;

  async function loadSettings() {
    if (settingsCache) return settingsCache;
    if (!settingsPromise) {
      settingsPromise = store
        .get(KEY.SETTINGS, {})
        .then((saved) => {
          settingsCache = Object.assign({}, DEFAULT_SETTINGS, saved || {});
          return settingsCache;
        })
        .catch(() => {
          settingsCache = Object.assign({}, DEFAULT_SETTINGS);
          return settingsCache;
        });
    }
    return settingsPromise;
  }

  RN.settings = {
    defaults: DEFAULT_SETTINGS,
    async all() {
      return Object.assign({}, await loadSettings());
    },
    async get(name) {
      const s = await loadSettings();
      return s[name];
    },
    async set(patch) {
      const s = await loadSettings();
      Object.assign(s, patch);
      await store.set(KEY.SETTINGS, s);
      return s;
    },
  };

  /* ---------------- 文章索引 ---------------- */
  RN.articles = {
    async index() {
      return (await store.get(KEY.INDEX, [])) || [];
    },
    async saveIndex(list) {
      await store.set(KEY.INDEX, list);
    },
    async put(article) {
      await store.set(KEY.article(article.id), article);
      const list = await RN.articles.index();
      const meta = RN.articles.meta(article);
      const i = list.findIndex((a) => a.id === article.id);
      if (i >= 0) list[i] = Object.assign({}, list[i], meta);
      else list.unshift(meta);
      list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      await RN.articles.saveIndex(list);
      return meta;
    },
    async updateMeta(id, patch) {
      const list = await RN.articles.index();
      const i = list.findIndex((a) => a.id === id);
      if (i >= 0) {
        list[i] = Object.assign({}, list[i], patch, { updatedAt: Date.now() });
        await RN.articles.saveIndex(list);
      }
    },
    async get(id) {
      return await store.get(KEY.article(id), null);
    },
    async remove(id) {
      await store.remove(KEY.article(id));
      const list = (await RN.articles.index()).filter((a) => a.id !== id);
      await RN.articles.saveIndex(list);
    },
    meta(a) {
      return {
        id: a.id,
        url: a.url,
        canonicalUrl: a.canonicalUrl || a.url,
        title: a.title || '（无标题）',
        byline: a.byline || '',
        siteName: a.siteName || hostOf(a.url),
        excerpt: (a.excerpt || '').slice(0, 280),
        lang: a.lang || '',
        favicon: a.favicon || '',
        savedAt: a.savedAt || Date.now(),
        updatedAt: a.updatedAt || Date.now(),
        wordCount: a.wordCount || 0,
        readingTime: a.readingTime || 0,
        starred: !!a.starred,
        tags: a.tags || [],
        scroll: a.scroll || 0,
        hlCount: (a.highlights || []).length,
        noteCount: (a.notes || []).length + (a.highlights || []).filter((h) => h.note && h.note.trim()).length,
        hasNotes: (a.notes || []).length > 0,
      };
    },
  };

  /* ---------------- 工具 ---------------- */
  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtDay(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function countWords(text) {
    if (!text) return 0;
    const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const latin = (text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
    return cjk + latin;
  }
  function readingMinutes(words) {
    return Math.max(1, Math.round(words / 380));
  }
  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }
  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    return function (...args) {
      const now = Date.now();
      const wait = ms - (now - last);
      if (wait <= 0) {
        last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn.apply(this, args);
        }, wait);
      }
    };
  }
  function pageUrl(path) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL(path);
    // 本地测试环境：相对路径
    return path.indexOf(window.__RN_BASE__ || '') === 0 ? path : (window.__RN_BASE__ || '') + path;
  }
  function openPage(path, newTab) {
    const url = pageUrl(path);
    if (newTab) window.open(url, '_blank');
    else location.href = url;
  }
  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  let toastTimer = null;
  function toast(msg, type) {
    let el = document.getElementById('rn-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rn-toast';
      document.body.appendChild(el);
    }
    el.className = 'rn-toast show' + (type ? ' ' + type : '');
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = 'rn-toast';
    }, type === 'error' ? 4200 : 2200);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);
  }

  RN.util = {
    uid,
    hostOf,
    esc,
    fmtDate,
    fmtDay,
    countWords,
    readingMinutes,
    debounce,
    throttle,
    pageUrl,
    openPage,
    truncate,
    stripHtml,
    toast,
    download,
  };

  RN.hasChromeStorage = hasChromeStorage;
  RN.runtime = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime : null;
})();
