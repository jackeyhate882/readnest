// 线上抓取后：确认记录了原站样式，并给「纸感 / 跟随站点 / 深色」三种主题截图
import { writeFileSync } from 'node:fs';
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = 'https://alexwang.ai/posts/associative-memory/';

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
      }, 150000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) return { err: r.exceptionDetails.text };
    return r.result.value;
  }
}

const list = async () => await (await fetch(CDP + '/json/list')).json();
const lib = new C((await list()).find((t) => t.url.includes('library.html')).webSocketDebuggerUrl);
await lib.ready;
await lib.send('Runtime.enable');
await lib.send('Page.enable');

// 打开线上页面并抓取
const before = new Set((await list()).map((t) => t.id));
await lib.eval(`chrome.tabs.create({ url: ${JSON.stringify(PAGE)}, active: false })`);
await sleep(9000);
const tabId = await lib.eval(`(async()=>{const ts=await chrome.tabs.query({});const t=ts.find(x=>(x.url||'').startsWith('https://alexwang.ai/posts/associative-memory'));return t&&t.id})()`);
const cap = await lib.eval(`chrome.runtime.sendMessage({ type: 'capture:tab', tabId: ${tabId} })`);
console.log('capture:', JSON.stringify(cap));
let reader = null;
for (let i = 0; i < 90; i++) {
  reader = (await list()).find((t) => t.url.includes('reader.html') && !before.has(t.id));
  if (reader) break;
  await sleep(500);
}
if (!reader) {
  console.log('no reader');
  process.exit(1);
}
const rd = new C(reader.webSocketDebuggerUrl);
await rd.ready;
await rd.send('Runtime.enable');
await rd.send('Page.enable');

const info = await rd.eval(`(async () => {
  const find = async () => {
    const idx = (await chrome.storage.local.get('rn_articles'))['rn_articles'] || [];
    const rec = idx.find((a) => a.url.includes('associative-memory'));
    if (!rec) return null;
    const art = (await chrome.storage.local.get('rn_article:' + rec.id))['rn_article:' + rec.id];
    return art ? { id: rec.id, siteStyle: art.siteStyle || null } : null;
  };
  for (let i = 0; i < 60; i++) {
    const got = await find();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
})()`);
console.log('article:', JSON.stringify(info));

const id = info && info.id;
const shoot = async (theme, name) => {
  await rd.eval(`(async () => {
    const s = (await chrome.storage.local.get('rn_settings'))['rn_settings'] || {};
    s.theme = ${JSON.stringify(theme)};
    s.autoSummary = false;
    await chrome.storage.local.set({ rn_settings: s });
    location.href = 'reader.html?id=' + ${JSON.stringify(id)} + '&cb=' + Date.now();
  })()`);
  await sleep(2500);
  await rd.eval(`window.scrollTo({ top: 0 })`);
  await sleep(500);
  const shot = await rd.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`docs/${name}`, Buffer.from(shot.data, 'base64'));
  const got = await rd.eval(`({ theme: document.documentElement.getAttribute('data-theme'), body: getComputedStyle(document.querySelector('.content')).fontFamily.slice(0, 60), bg: getComputedStyle(document.body).backgroundColor })`);
  console.log(name, JSON.stringify(got));
};

await shoot('paper', 'readnest-paper.png');
await shoot('site', 'readnest-site.png');
await shoot('dark', 'readnest-dark2.png');
rd.ws.close();
lib.ws.close();
