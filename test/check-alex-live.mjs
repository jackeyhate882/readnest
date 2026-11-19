// 线上验证 alexwang：公式（MathJax 宏）+ 交互图表，两条抓取路径都测
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
const results = [];
const check = (n, ok, extra) => results.push({ n, ok: !!ok, extra });

const libTarget = (await list()).find((t) => t.url.includes('library.html'));
const lib = new C(libTarget.webSocketDebuggerUrl);
await lib.ready;
await lib.send('Runtime.enable');

async function openPage() {
  const before = new Set((await list()).map((t) => t.id));
  await fetch(CDP + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' }).catch(() => {});
  for (let i = 0; i < 80; i++) {
    const t = (await list()).find((x) => x.url === PAGE && !before.has(x.id));
    if (t) return t;
    await sleep(400);
  }
  return null;
}

async function waitReader(beforeIds) {
  for (let i = 0; i < 120; i++) {
    const cands = (await list()).filter((t) => t.url.includes('reader.html') && !beforeIds.has(t.id));
    if (cands.length) return cands[0];
    await sleep(500);
  }
  return null;
}

async function inspect(rd) {
  let info = null;
  for (let i = 0; i < 60; i++) {
    info = await rd.eval(`(() => {
      const c = document.getElementById('content');
      if (!c) return null;
      const t = c.textContent;
      const imgs = [...c.querySelectorAll('img')];
      return {
        url: location.href,
        katex: c.querySelectorAll('.katex').length,
        display: c.querySelectorAll('.rn-math-display').length,
        red: [...c.querySelectorAll('.katex span')].filter(s => /#cc0000/i.test(s.getAttribute('style') || '')).length,
        dollars: t.split('$').length - 1,
        backslash: (t.match(/\\[A-Za-z]{2,}/g) || []).slice(0, 4),
        charts: imgs.filter(i => (i.getAttribute('src') || '').startsWith('data:image')).length,
        chartCss: imgs.filter(i => (i.getAttribute('src') || '').startsWith('data:image/svg')).filter(i => {
          try { return atob(i.getAttribute('src').split(',')[1]).includes('<style'); } catch (e) { return false; }
        }).length,
        figs: c.querySelectorAll('figure').length,
        figsWithMedia: [...c.querySelectorAll('figure')].filter(f => f.querySelector('img, svg, canvas')).length,
        mjx: c.querySelectorAll('mjx-container').length
      };
    })()`);
    if (info && info.katex > 20 && info.charts >= 1) break;
    await sleep(700);
  }
  return info;
}

// 1) 点扩展图标（标签页抓取）
{
  const page = await openPage();
  check('打开 alexwang 线上页面', !!page, page && page.url);
  await sleep(7000);
  const pc = new C(page.webSocketDebuggerUrl);
  await pc.ready;
  await pc.send('Runtime.enable');
  const live = await pc.eval(`({ mjx: document.querySelectorAll('mjx-container').length, svg: document.querySelectorAll('figure svg').length, canvas: document.querySelectorAll('figure canvas').length })`);
  check('线上页面确实是已排版 MathJax', live && live.mjx > 0, live);
  const tabId = await lib.eval(`(async()=>{const ts=await chrome.tabs.query({});const t=ts.find(x=>(x.url||'').startsWith(${JSON.stringify(PAGE)}));return t&&t.id})()`);
  const beforeReaders = new Set((await list()).map((t) => t.id));
  const cap = await lib.eval(`chrome.runtime.sendMessage({ type: 'capture:tab', tabId: ${tabId} })`);
  check('capture:tab 走合并路径', cap && cap.ok, cap);
  const reader = await waitReader(beforeReaders);
  check('打开阅读页（标签页抓取）', !!reader, reader && reader.url);
  if (reader) {
    const rd = new C(reader.webSocketDebuggerUrl);
    await rd.ready;
    await rd.send('Runtime.enable');
    const info = await inspect(rd);
    console.log('tab capture ->', JSON.stringify(info));
    check('公式渲染（>150 个）', info && info.katex > 150, info && info.katex);
    check('没有红色未定义命令', info && info.red === 0, info && info.red);
    check('没有残留 $ / \\命令', info && info.dollars === 0 && (!info.backslash || !info.backslash.length), info && [info.dollars, info.backslash]);
    check('图表被合并（>=2 张）', info && info.charts >= 2, info && info.charts);
    check('所有图表都有内容（7/7）', info && info.figsWithMedia === 7, info && info.figsWithMedia);
    check('图表内嵌站点 CSS（>=3 张）', info && info.chartCss >= 3, info && info.chartCss);
    check('没有 mjx 残留', info && info.mjx === 0, info && info.mjx);
    rd.close();
  }
  pc.close();
}

// 2) 粘贴链接（静态正文 + 自动补图表）
{
  const beforeReaders = new Set((await list()).map((t) => t.id));
  const cap = await lib.eval(`chrome.runtime.sendMessage({ type: 'capture:url', url: ${JSON.stringify(PAGE)} })`);
  check('capture:url 请求成功', cap && cap.ok, cap);
  const reader = await waitReader(beforeReaders);
  check('打开阅读页（粘贴链接）', !!reader, reader && reader.url);
  if (reader) {
    const rd = new C(reader.webSocketDebuggerUrl);
    await rd.ready;
    await rd.send('Runtime.enable');
    const info = await inspect(rd);
    console.log('url capture ->', JSON.stringify(info));
    check('粘贴路径也有公式', info && info.katex > 150, info && info.katex);
    check('粘贴路径无残留 $', info && info.dollars === 0, info && info.dollars);
    check('粘贴路径有图表', info && info.charts >= 2, info && info.charts);
    check('粘贴路径所有图表都有内容', info && info.figsWithMedia === 7, info && info.figsWithMedia);
    check('粘贴路径图表内嵌 CSS', info && info.chartCss >= 3, info && info.chartCss);
    await rd.eval(`(() => { const b = document.querySelector('#content .rn-math-display'); if (b) window.scrollTo({ top: b.getBoundingClientRect().top + window.scrollY - 80 }); return 'ok'; })()`);
    await sleep(1200);
    const shot = await rd.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync('docs/readnest-alex-live.png', Buffer.from(shot.data, 'base64'));
    rd.close();
  }
}

lib.close();
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.n + (r.ok ? '' : '  ' + JSON.stringify(r.extra)));
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
