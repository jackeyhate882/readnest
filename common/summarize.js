/*
 * 阅巢 ReadNest — 文章概述
 * 配了 OpenAI 兼容 API：用模型写结构化摘要；没配：本地摘录式摘要
 */
(function () {
  const RN = window.RN;

  const STOP = new Set(
    ('the and that with this from have were which their there about would could these those into than then also such ' +
      'been being does doing more most other some what when where while your you’re it’s they’re we’re can’t don’t ' +
      '但是 因为 所以 如果 而且 或者 以及 一个 我们 他们 可以 这个 那个 这样 不是 就是 没有 进行 通过 对于 其中 这些 那些 已经 还是 什么 怎么')
      .split(/\s+/)
  );

  function plainText(html) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    div.querySelectorAll('pre,code,table,script,style').forEach((n) => n.remove());
    let text = (div.textContent || '').replace(/\u00a0/g, ' ');
    // 公式源码对摘要没帮助，去掉行间/行内公式和残留命令
    text = text
      .replace(/\\\[[\s\S]*?\\\]/g, ' ')
      .replace(/\\\([\s\S]*?\\\)/g, ' ')
      .replace(/\$\$[\s\S]*?\$\$/g, ' ')
      .replace(/\$[^$\n]{1,240}\$/g, ' ')
      .replace(/\\[A-Za-z]{2,}/g, ' ');
    return text.replace(/\s+/g, ' ').trim();
  }

  function splitSentences(text) {
    return String(text || '')
      .split(/(?<=[。！？!?；;])\s*|(?<=[.!?])\s+(?=[A-Z0-9“"'(])/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function tokens(text) {
    const out = [];
    const lower = String(text || '').toLowerCase();
    (lower.match(/[a-z][a-z0-9'-]{2,}/g) || []).forEach((w) => {
      if (!STOP.has(w)) out.push(w);
    });
    const runs = lower.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) || [];
    for (const run of runs) {
      if (run.length === 1) out.push(run);
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    }
    return out;
  }

  function termFreq(text, limit) {
    const freq = new Map();
    for (const t of tokens(text)) freq.set(t, (freq.get(t) || 0) + 1);
    return new Map(
      Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit || 80)
    );
  }

  function scoreSentence(sentence, freq) {
    const toks = tokens(sentence);
    if (!toks.length) return 0;
    let score = 0;
    for (const t of toks) if (freq.has(t)) score += Math.log(1 + freq.get(t));
    return score / Math.sqrt(toks.length);
  }

  /** 本地摘录：按词频 + 位置挑几句，做成要点 */
  function localSummary(article, length) {
    const text = plainText((article && article.contentHTML) || '');
    const sents = splitSentences(text).filter((s) => s.length >= 24 && s.length <= 300 && s.indexOf('\\') < 0);
    if (sents.length < 2) return text.slice(0, 220) || '（正文太短，无法生成摘要）';
    const freq = termFreq(text);
    const want = length === 'short' ? 3 : length === 'long' ? 6 : 4;
    const scored = sents.map((s, i) => ({
      s,
      i,
      score: scoreSentence(s, freq) + (i === 0 ? 1.2 : 0) - i * 0.03,
    }));
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, want)
      .sort((a, b) => a.i - b.i)
      .map((x) => '· ' + x.s)
      .join('\n');
  }

  function sysPrompt(length, lang) {
    const size =
      length === 'short' ? '120 字左右，最多 3 条要点' : length === 'long' ? '350 字左右，5-6 条要点' : '200 字左右，3-4 条要点';
    return [
      '你是一位严谨的科技编辑，为读者写一篇文章概述。',
      '用' + lang + '写作，总长' + size + '。',
      '格式：先 1-2 句概括这篇文章在讲什么、核心结论是什么；换行后用「- 」列出关键结论 / 方法 / 数据 / 值得注意的局限。',
      '只依据给定正文，不要编造，不要复述全文，不要加“本文”“这篇文章”之类的套话。',
      '直接输出概述，不要输出标题。',
    ].join('\n');
  }

  /**
   * @returns {Promise<{ok:boolean, source:'ai'|'extract', text?:string, model?:string, note?:string, error?:string, hint?:string, fallback?:string}>}
   */
  async function summarize(article, opts) {
    const s = await RN.settings.all();
    const length = (opts && opts.length) || s.summaryLength || 'medium';
    if (!s.apiKey || !s.apiBase) {
      return {
        ok: true,
        source: 'extract',
        text: localSummary(article, length),
        note: '未配置 AI 模型，以下是从原文摘出的要点',
      };
    }
    const text = plainText(article.contentHTML || '');
    const body = text.length > 16000 ? text.slice(0, 16000) + '…' : text;
    const lang = s.targetLang === 'en' ? 'English' : '简体中文';
    try {
      const res = await RN.translate.chat(
        [
          { role: 'system', content: sysPrompt(length, lang) },
          {
            role: 'user',
            content:
              '标题：' + (article.title || '') + '\n链接：' + (article.canonicalUrl || article.url || '') + '\n\n正文：\n' + body,
          },
        ],
        { temperature: 0.25, timeout: 90000 }
      );
      return { ok: true, source: 'ai', text: res.text, model: res.model };
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) || '生成失败',
        hint: (err && err.hint) || '',
        fallback: localSummary(article, length),
      };
    }
  }

  RN.summarize = { summarize, localSummary, plainText };
})();
