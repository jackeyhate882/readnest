// 给真实扩展里的某个阅读页截图（用于文档）
import { writeFileSync } from 'node:fs';
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
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return null;
    return r.result.value;
  }
}

const titleRe = new RegExp(process.argv[2] || 'invented transformers', 'i');
const outFile = process.argv[3] || 'docs/readnest-charts.png';
const list = await (await fetch(CDP + '/json/list')).json();
const cands = list.filter((t) => t.url.includes('reader.html'));
let chosen = null;
for (const c of cands) {
  const cl = new Client(c.webSocketDebuggerUrl);
  await cl.ready;
  await cl.send('Runtime.enable');
  const title = await cl.eval("document.getElementById('title') ? document.getElementById('title').textContent : ''");
  if (typeof title === 'string' && titleRe.test(title)) {
    chosen = { cl, target: c, title };
    break;
  }
  cl.ws.close();
}
if (!chosen) {
  console.log('reader not found');
  process.exit(1);
}
await chosen.cl.eval(`(() => {
  const fig = document.querySelector('#content figure');
  if (fig) window.scrollTo({ top: fig.getBoundingClientRect().top + window.scrollY - 120 });
  return 'ok';
})()`);
await sleep(2500);
const shot = await chosen.cl.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
console.log('saved', outFile, chosen.title);
chosen.cl.ws.close();
