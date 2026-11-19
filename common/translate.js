/*
 * 阅巢 ReadNest — 翻译引擎层
 * 三种引擎：google（免费 gtx 接口）/ mymemory（免费接口）/ api（OpenAI 兼容，如 DeepSeek）
 */
(function () {
  const RN = window.RN;
  const { util } = RN;

  const LANGS = {
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어',
  };

  const cache = new Map();
  const MAX_CHUNK = 900; // google 单次请求较稳的长度

  function langName(code) {
    return LANGS[code] || code;
  }

  function hasCjk(text) {
    return /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text || '');
  }

  function isTargetLang(text, target) {
    if (!text) return true;
    const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    if (target.indexOf('zh') === 0) return text.length > 10 && cjk / text.length > 0.5;
    if (target === 'en') return !hasCjk(text) && /[A-Za-z]/.test(text);
    return false;
  }

  class TranslateError extends Error {
    constructor(msg, hint) {
      super(msg);
      this.hint = hint || '';
    }
  }

  function normalizeError(err) {
    if (err instanceof TranslateError) return err;
    const msg = String((err && err.message) || err);
    if (/Failed to fetch|NetworkError|Load failed|ENOTFOUND|fetch failed/i.test(msg)) {
      return new TranslateError(
        '网络请求被拦截或失败',
        '检查代理/网络；国内网络可直接在设置里把引擎换成「OpenAI 兼容 API」并填入 DeepSeek Key。'
      );
    }
    if (/401|403|invalid api key|unauthorized/i.test(msg)) {
      return new TranslateError('API Key 无效或没有权限', '到设置里检查 Base URL、模型名和 API Key。');
    }
    if (/429|too many requests|rate limit/i.test(msg)) {
      return new TranslateError('请求太频繁被限流', '稍等几秒再试，或换一个翻译引擎。');
    }
    if (/timeout|aborted/i.test(msg)) {
      return new TranslateError('请求超时', '网络较慢，稍后再试。');
    }
    return new TranslateError(msg);
  }

  async function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 20000);
    try {
      return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- 各引擎实现 ---------------- */

  async function googleTranslate(text, target) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' +
      encodeURIComponent(target) +
      '&q=' +
      encodeURIComponent(text);
    const resp = await fetchWithTimeout(url, { method: 'GET', credentials: 'omit' }, 20000);
    if (!resp.ok) throw new TranslateError('Google 接口返回 ' + resp.status);
    const data = await resp.json();
    const parts = (data && data[0]) || [];
    const out = parts.map((p) => (p && p[0]) || '').join('');
    if (!out) throw new TranslateError('Google 接口没有返回译文');
    return out;
  }

  async function myMemoryTranslate(text, target) {
    let src = hasCjk(text) ? 'zh-CN' : 'en';
    if (src === target) src = 'en';
    const url =
      'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(text) +
      '&langpair=' +
      encodeURIComponent(src + '|' + target);
    const resp = await fetchWithTimeout(url, { method: 'GET', credentials: 'omit' }, 20000);
    if (!resp.ok) throw new TranslateError('MyMemory 接口返回 ' + resp.status);
    const data = await resp.json();
    const out = data && data.responseData && data.responseData.translatedText;
    if (!out) throw new TranslateError('MyMemory 接口没有返回译文');
    if (/MYMEMORY WARNING/i.test(out)) throw new TranslateError('MyMemory 免费额度已用完', '换用其他引擎。');
    return out.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }

  /** 通用的 OpenAI 兼容 chat 调用（翻译、摘要共用） */
  async function chat(messages, opts) {
    opts = opts || {};
    const s = Object.assign({}, await RN.settings.all(), opts.settings || {});
    if (!s.apiKey) throw new TranslateError('还没有填写 API Key', '打开设置页填写 OpenAI 兼容服务的 Key（如 DeepSeek），摘要会用模型生成。');
    const base = (s.apiBase || '').replace(/\/+$/, '');
    if (!base) throw new TranslateError('还没有填写 API Base URL', '例如 https://api.deepseek.com/v1');
    const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    const body = {
      model: s.apiModel || 'deepseek-chat',
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      stream: false,
      messages,
    };
    let resp;
    try {
      resp = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
          body: JSON.stringify(body),
        },
        opts.timeout || 60000
      );
    } catch (err) {
      throw normalizeError(err);
    }
    if (!resp.ok) {
      let detail = '';
      try {
        const j = await resp.json();
        detail = (j.error && (j.error.message || j.error.code)) || '';
      } catch (e) {}
      throw new TranslateError('API 返回 ' + resp.status + (detail ? '：' + detail : ''));
    }
    const data = await resp.json();
    const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!out || !String(out).trim()) throw new TranslateError('API 没有返回内容');
    return { text: String(out).trim(), model: body.model };
  }

  async function apiTranslate(text, s) {
    if (!s.apiKey) throw new TranslateError('还没有填写 API Key', '打开设置页填写 OpenAI 兼容服务的 Key（如 DeepSeek）。');
    const res = await chat(
      [
        {
          role: 'system',
          content:
            '你是专业翻译。把用户提供的文本准确、通顺地翻译成' +
            langName(s.targetLang) +
            '。保留原文的段落结构与术语，只输出译文，不要解释、不要添加前后缀。',
        },
        { role: 'user', content: text },
      ],
      { settings: s, temperature: 0.2 }
    );
    return res.text;
  }

  /* ---------------- 分块 ---------------- */

  function chunkText(text, max) {
    const out = [];
    let rest = text.trim();
    while (rest.length > max) {
      let cut = -1;
      const window = rest.slice(0, max);
      const m = window.match(/[\s\S]*[。！？.!?；;：:\n]/g);
      if (m && m[0] && m[0].length > max * 0.4) {
        cut = m[0].length;
      } else {
        const sp = window.lastIndexOf(' ');
        cut = sp > max * 0.4 ? sp : max;
      }
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(Boolean);
  }

  async function translateChunk(text, s) {
    const p = s.provider || 'google';
    if (p === 'google') return await googleTranslate(text, s.targetLang);
    if (p === 'mymemory') return await myMemoryTranslate(text, s.targetLang);
    if (p === 'api') return await apiTranslate(text, s);
    throw new TranslateError('未知的翻译引擎：' + p);
  }

  /**
   * 翻译任意长度文本
   * @param {string} text
   * @param {object} [opts] { provider, targetLang, force }
   * @returns {Promise<{text:string, provider:string, chunks:number, skipped?:boolean}>}
   */
  async function translate(text, opts) {
    const s = Object.assign({}, await RN.settings.all(), opts || {});
    const plain = String(text || '').replace(/\s+/g, ' ').trim();
    if (!plain) return { text: '', provider: s.provider, chunks: 0 };
    if (!opts || !opts.force) {
      if (isTargetLang(plain, s.targetLang)) {
        return { text: plain, provider: s.provider, chunks: 0, skipped: true };
      }
    }
    const providerKey = s.provider === 'api' ? 'api:' + (s.apiModel || '') : s.provider;
    const key = providerKey + '|' + s.targetLang + '|' + plain;
    if (cache.has(key)) return Object.assign({ cached: true }, cache.get(key));

    const chunks = chunkText(plain, s.provider === 'api' ? 2200 : MAX_CHUNK);
    try {
      const results = [];
      for (const c of chunks) {
        results.push(await translateChunk(c, s));
      }
      const result = { text: results.join(s.targetLang.indexOf('zh') === 0 ? '' : '\n'), provider: s.provider, chunks: chunks.length };
      cache.set(key, result);
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      return result;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /** 设置页的连通性测试 */
  async function test(text) {
    const t0 = performance.now();
    const res = await translate(text || 'Agents need memory that persists across sessions.', {
      force: true,
      provider: (await RN.settings.get('provider')) || 'google',
    });
    return { ok: true, ms: Math.round(performance.now() - t0), out: res.text };
  }

  RN.translate = { translate, test, chat, langName, isTargetLang, hasCjk, LANGS, TranslateError };
})();
