// 离线验证：交互式图表页（SVG + Canvas 运行时绘制）经粘贴链接抓取后应变成图片
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'http://127.0.0.1:8765/test/chart-page.html';

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
  console.log('library page not found');
  process.exit(1);
}
const lib = new Client(libTarget.webSocketDebuggerUrl);
await lib.ready;
await lib.send('Runtime.enable');

const before = new Set((await list()).map((t) => t.id));
const cap = await lib.eval(`chrome.runtime.sendMessage({ type: 'capture:url', url: ${JSON.stringify(URL)} })`);
console.log('capture:', JSON.stringify(cap));

let reader = null;
for (let i = 0; i < 60; i++) {
  const cands = (await list()).filter((t) => t.url.includes('reader.html') && !before.has(t.id));
  if (cands.length) {
    reader = cands[0];
    break;
  }
  await sleep(500);
}
if (!reader) {
  console.log('reader not opened');
  process.exit(1);
}
const rd = new Client(reader.webSocketDebuggerUrl);
await rd.ready;
await rd.send('Runtime.enable');

// 等自动升级（raw → 后台标签页重抓 → 跳到 ?id=）
let info = null;
for (let i = 0; i < 60; i++) {
  const url = await rd.eval('location.href');
  if (typeof url === 'string' && url.includes('?id=')) break;
  await sleep(500);
}
for (let i = 0; i < 30; i++) {
  info = await rd.eval(`(() => {
    const c = document.getElementById('content');
    const imgs = [...c.querySelectorAll('img')];
    return {
      url: location.href,
      figs: c.querySelectorAll('figure').length,
      imgs: imgs.length,
      chartImgs: imgs.filter(i => (i.getAttribute('src') || '').startsWith('data:image')).length,
      sizes: imgs.map(i => [i.naturalWidth, i.naturalHeight]).slice(0, 4),
      figsWithMedia: [...c.querySelectorAll('figure')].filter(f => f.querySelector('img, svg, canvas')).length,
      katex: c.querySelectorAll('.katex').length,
      hasDollars: c.textContent.split('$').length - 1,
      dollarCtx: (() => { const tt = c.textContent; const ii = tt.indexOf('\$'); return ii >= 0 ? tt.slice(Math.max(0, ii - 60), ii + 60) : null; })(),
      theme: document.documentElement.getAttribute('data-theme')
    };
  })()`);
  if (info && info.chartImgs >= 2 && info.katex >= 4 && info.hasDollars === 0) break;
  await sleep(700);
}
console.log('reader:', JSON.stringify(info, null, 2));

await rd.eval(`(() => { const f = document.querySelector('#content figure'); if (f) window.scrollTo({ top: f.getBoundingClientRect().top + window.scrollY - 90 }); return 'ok'; })()`);
await sleep(1200);
const shot = await rd.send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync('docs/_chart-check.png', Buffer.from(shot.data, 'base64'));

const ok = info && info.chartImgs >= 2 && info.figsWithMedia >= 2 && info.katex >= 4 && info.hasDollars === 0;
console.log(ok ? 'PASS 图表转图片 + 公式渲染' : 'FAIL 图表或公式不正确');
process.exit(ok ? 0 : 1);
