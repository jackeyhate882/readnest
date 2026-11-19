// 用「纸感」主题给几张功能截图（图表 / 配图 / 公式）
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs') + '/';

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
      }, 60000);
    });
  }
  async eval(expression) {
    try {
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) return { err: r.exceptionDetails.text };
      return r.result.value;
    } catch (e) {
      return { err: e.message };
    }
  }
}

const list = async () => await (await fetch(CDP + '/json/list')).json();
const lib = new C((await list()).find((t) => t.url.includes('library.html')).webSocketDebuggerUrl);
await lib.ready;
await lib.send('Runtime.enable');
await lib.eval(`(async () => {
  const s = (await chrome.storage.local.get('rn_settings'))['rn_settings'] || {};
  s.theme = 'paper';
  s.autoSummary = false;
  s.fontSize = 19;
  s.lineWidth = 700;
  await chrome.storage.local.set({ rn_settings: s });
  return true;
})()`);

async function openArticle(url) {
  const before = new Set((await list()).map((t) => t.id));
  await lib.eval(`chrome.runtime.sendMessage({ type: 'capture:url', url: ${JSON.stringify(url)} })`);
  for (let i = 0; i < 120; i++) {
    const r = (await list()).find((t) => t.url.includes('reader.html') && !before.has(t.id));
    if (r) {
      const rd = new C(r.webSocketDebuggerUrl);
      await rd.ready;
      await rd.send('Runtime.enable');
      await rd.send('Page.enable');
      return rd;
    }
    await sleep(500);
  }
  return null;
}

/** 等阅读页加载完（loading 消失、正文出来、图表图片就位） */
async function waitReady(rd) {
  const ok = await rd.eval(`(async () => {
    for (let i = 0; i < 160; i++) {
      const loading = document.getElementById('loading');
      const hidden = !loading || loading.hidden || getComputedStyle(loading).display === 'none';
      const paras = document.querySelectorAll('#content p').length;
      const figs = [...document.querySelectorAll('#content figure')];
      const figsReady = figs.length === 0 || figs.every((f) => f.querySelector('img, svg, canvas'));
      if (hidden && paras > 3 && figsReady) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  })()`);
  if (!ok) console.log('reader not ready');
  return ok === true;
}

async function shot(rd, expr, name) {
  const res = await rd.eval(`(async () => {
    ${expr}
    await new Promise((r) => setTimeout(r, 900));
    return 'ok';
  })()`);
  if (!res || res.err) {
    console.log('scroll failed', name, JSON.stringify(res));
    return;
  }
  await sleep(2400); // 等图片解码完成
  await rd.eval("(() => { const el = document.getElementById('rn-toast'); if (el) el.style.setProperty('display', 'none', 'important'); })()");
  await sleep(300);
  const snap = await rd.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + name, Buffer.from(snap.data, 'base64'));
  console.log('saved', name);
}

// 1) alexwang：图表
{
  const rd = await openArticle('https://alexwang.ai/posts/associative-memory/');
  if (rd) {
    await waitReady(rd);
    await shot(rd, "const f = document.querySelectorAll('#content figure')[2]; if (f) f.scrollIntoView({ block: 'center' });", 'readnest-charts.png');
    await shot(rd, "const f = document.querySelectorAll('#content figure')[1]; if (f) f.scrollIntoView({ block: 'center' });", 'readnest-chart-css.png');
    rd.ws.close();
  }
}
// 2) anthropic：配图与图注
{
  const rd = await openArticle('https://www.anthropic.com/research/components-of-agent-memory');
  if (rd) {
    await waitReady(rd);
    await shot(rd, "const f = document.querySelectorAll('#content figure')[0]; if (f) f.scrollIntoView({ block: 'center' });", 'readnest-img.png');
    await shot(rd, "const f = document.querySelectorAll('#content figure')[1]; if (f) f.scrollIntoView({ block: 'center' });", 'readnest-figlabel.png');
    rd.ws.close();
  }
}
// 3) beyond-RL：公式
{
  const rd = await openArticle('https://shengyu-feng.github.io/blog/2026/10/13/beyond-RL/');
  if (rd) {
    await waitReady(rd);
    await shot(rd, "const d = document.querySelector('#content .rn-math-display'); if (d) d.scrollIntoView({ block: 'center' });", 'readnest-math.png');
    rd.ws.close();
  }
}
lib.ws.close();
