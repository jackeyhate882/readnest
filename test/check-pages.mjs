// 针对用户反馈的三类页面，在真实 Edge 扩展里验证抓取结果
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res) => this.ws.addEventListener('open', () => res()));
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout ' + method));
        }
      }, 180000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text, detail: r.exceptionDetails.exception && r.exceptionDetails.exception.description };
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

async function targets() {
  return await (await fetch(CDP + '/json/list')).json();
}

async function openTab(url) {
  const before = new Set((await targets()).map((t) => t.id));
  await fetch(CDP + '/json/new?' + encodeURIComponent(url), { method: 'PUT' }).catch(() => {});
  const started = Date.now();
  while (Date.now() - started < 40000) {
    const t = (await targets()).find((x) => x.url && x.url.startsWith(url.split('#')[0]) && !before.has(x.id));
    if (t) return t;
    await sleep(400);
  }
  return null;
}

async function findReader(beforeUrls, titleRe) {
  const started = Date.now();
  while (Date.now() - started < 40000) {
    const list = await targets();
    const cands = list.filter((t) => t.url.includes('reader.html') && !beforeUrls.has(t.url));
    for (const c of cands) {
      const cl = new Client(c.webSocketDebuggerUrl);
      await cl.ready;
      await cl.send('Runtime.enable');
      const title = await cl.eval("document.getElementById('title') ? document.getElementById('title').textContent : ''");
      if (typeof title === 'string' && titleRe.test(title)) {
        return { client: cl, target: c, title };
      }
      cl.close();
    }
    await sleep(600);
  }
  return null;
}

const libTarget = (await targets()).find((t) => t.url.includes('library.html'));
const lib = new Client(libTarget.webSocketDebuggerUrl);
await lib.ready;
await lib.send('Runtime.enable');

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra });

// 1) 交互式图表 + 公式页（tab 抓取）
{
  const URL = 'https://alexwang.ai/posts/associative-memory/';
  const tab = await openTab(URL);
  check('打开 alexwang 页面', !!tab);
  await sleep(4000);
  const tabId = await lib.eval(`(async()=>{const ts=await chrome.tabs.query({});const t=ts.find(x=>(x.url||'').startsWith(${JSON.stringify(URL)}));return t&&t.id})()`);
  const before = new Set((await targets()).map((t) => t.url));
  const cap = await lib.eval(`chrome.runtime.sendMessage({ type:'capture:tab', tabId: ${tabId} })`);
  check('alexwang 抓取成功', cap && cap.ok, cap);
  const r = await findReader(before, /invented transformers/i);
  check('alexwang 阅读页打开', !!r);
  if (r) {
    await sleep(1500);
    const m = await r.client.eval(`(() => {
      const c = document.getElementById('content');
      return {
        imgs: c.querySelectorAll('img').length,
        svg: [...c.querySelectorAll('svg')].filter(s => !s.closest('.katex')).length,
        katex: c.querySelectorAll('.katex').length,
        dollars: (c.textContent.match(/\\$/g) || []).length,
        figs: c.querySelectorAll('figure').length,
        figWithChart: [...c.querySelectorAll('figure')].filter(f => f.querySelector('svg, img, canvas')).length
      };
    })()`);
    check('alexwang 图表保留', m.figWithChart >= 3, m);
    check('alexwang 公式渲染', m.katex > 100 && m.dollars === 0, m);
    r.client.close();
  }
}

// 2) 图片在按钮里的页面（链接抓取）
{
  const URL = 'https://www.sophielwang.com/blog/paper-writing';
  const before = new Set((await targets()).map((t) => t.url));
  const cap = await lib.eval(`chrome.runtime.sendMessage({ type:'capture:url', url: ${JSON.stringify(URL)} })`);
  check('sophie 抓取请求成功', cap && cap.ok, cap);
  const r = await findReader(before, /paper writing/i);
  check('sophie 阅读页打开', !!r);
  if (r) {
    for (let i = 0; i < 30; i++) {
      const n = await r.client.eval("document.querySelectorAll('#content img').length");
      if (n > 5) break;
      await sleep(500);
    }
    const m = await r.client.eval(`(() => ({
      imgs: document.querySelectorAll('#content img').length,
      paras: document.querySelectorAll('#content p').length
    }))()`);
    check('sophie 图片保留', m.imgs >= 10, m);
    r.client.close();
  }
}

// 3) iframe 应用页（tab 抓取）
{
  const URL = 'https://huggingface.co/spaces/dlouapre/nlp-before-llms';
  const tab = await openTab(URL);
  check('打开 HF Space 页面', !!tab);
  await sleep(9000);
  const tabId = await lib.eval(`(async()=>{const ts=await chrome.tabs.query({});const t=ts.find(x=>(x.url||'').includes('dlouapre/nlp-before-llms'));return t&&t.id})()`);
  const before = new Set((await targets()).map((t) => t.url));
  const cap = await lib.eval(`chrome.runtime.sendMessage({ type:'capture:tab', tabId: ${tabId} })`);
  check('HF Space 抓取成功', cap && cap.ok, cap);
  const r = await findReader(before, /Natural Language Processing|NLP/i);
  check('HF Space 阅读页打开', !!r);
  if (r) {
    await sleep(1200);
    const m = await r.client.eval(`(() => ({
      len: document.getElementById('content').textContent.length,
      ps: document.querySelectorAll('#content p').length,
      imgs: document.querySelectorAll('#content img').length,
      sample: document.getElementById('content').textContent.trim().slice(0, 120)
    }))()`);
    check('HF Space 抓到 iframe 里的正文', m.len > 1500 && m.ps > 5, m);
    r.client.close();
  }
}

lib.close();
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '  ' + JSON.stringify(r.extra)));
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
