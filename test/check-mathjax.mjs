// 离线验证：页面公式已被 MathJax 换成 mjx-container 时，标签页抓取应回退到静态 HTML 取 TeX，
// 同时把标签页里画好的图表合并进来。
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = 'http://127.0.0.1:8765/test/mathjax-page.html';

class C {
  constructor(u) {
    this.ws = new WebSocket(u);
    this.id = 0;
    this.p = new Map();
    this.ready = new Promise((r) => this.ws.addEventListener('open', () => r()));
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) {
        const x = this.p.get(m.id);
        this.p.delete(m.id);
        m.error ? x.reject(new Error(JSON.stringify(m.error))) : x.resolve(m.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.p.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.p.has(id)) {
          this.p.delete(id);
          rej(new Error('timeout ' + method));
        }
      }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

const list = async () => await (await fetch(CDP + '/json/list')).json();
const targets = await list();
const libTarget = targets.find((t) => t.url.includes('library.html'));
if (!libTarget) {
  console.log('no library page');
  process.exit(1);
}
const lib = new C(libTarget.webSocketDebuggerUrl);
await lib.ready;
await lib.send('Runtime.enable');

// 打开目标页并等脚本把它排版成 mjx-container
const before = new Set((await list()).map((t) => t.id));
await fetch(CDP + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' }).catch(() => {});
let page = null;
for (let i = 0; i < 40; i++) {
  page = (await list()).find((t) => t.url === PAGE && !before.has(t.id));
  if (page) break;
  await sleep(400);
}
if (!page) {
  console.log('page not opened');
  process.exit(1);
}
const pc = new C(page.webSocketDebuggerUrl);
await pc.ready;
await pc.send('Runtime.enable');
await sleep(1500);
const mjx = await pc.eval("document.querySelectorAll('mjx-container').length");
console.log('live mjx-container:', mjx);

const tabId = await lib.eval(`(async()=>{const ts=await chrome.tabs.query({});const t=ts.find(x=>x.url===${JSON.stringify(PAGE)});return t&&t.id})()`);
const beforeReaders = new Set((await list()).map((t) => t.url));
const cap = await lib.eval(`chrome.runtime.sendMessage({ type: 'capture:tab', tabId: ${tabId} })`);
console.log('capture:tab ->', JSON.stringify(cap));

let reader = null;
for (let i = 0; i < 60; i++) {
  reader = (await list()).find((t) => t.url.includes('reader.html') && !beforeReaders.has(t.url));
  if (reader) break;
  await sleep(400);
}
if (!reader) {
  console.log('reader not opened');
  process.exit(1);
}
const rd = new C(reader.webSocketDebuggerUrl);
await rd.ready;
await rd.send('Runtime.enable');

let info = null;
for (let i = 0; i < 40; i++) {
  info = await rd.eval(`(() => {
    const c = document.getElementById('content');
    const imgs = [...c.querySelectorAll('img')];
    return {
      url: location.href,
      katex: c.querySelectorAll('.katex').length,
      dollars: (c.textContent.match(/\\$/g) || []).length,
      charts: imgs.filter(i => (i.getAttribute('src') || '').startsWith('data:image')).length,
      mjx: c.querySelectorAll('mjx-container').length,
      text: c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 140)
    };
  })()`);
  if (info && info.katex >= 1 && info.charts >= 1) break;
  await sleep(600);
}
console.log(JSON.stringify(info, null, 2));

const ok = info && info.katex >= 2 && info.charts >= 1 && info.mjx === 0 && info.dollars === 0;
console.log(ok ? 'PASS MathJax 页面：公式从静态 HTML 还原 + 图表合并' : 'FAIL MathJax 页面处理不正确');
process.exit(ok ? 0 : 1);
