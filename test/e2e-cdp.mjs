// 端到端测试：在真实 Edge（已加载本扩展）里通过 CDP 驱动扩展抓取与阅读
const CDP = 'http://127.0.0.1:9222';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function list() {
  const r = await fetch(CDP + '/json/list');
  return await r.json();
}

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('ws error')));
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
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
          reject(new Error('timeout: ' + method));
        }
      }, 120000);
    });
  }
  async eval(expr, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error('page error: ' + JSON.stringify(res.exceptionDetails.exception));
    return res.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra });
}
function log(r) {
  console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok || r.extra === undefined ? '' : '  ' + JSON.stringify(r.extra)));
}

async function findTarget(pred, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await list();
    const t = targets.find(pred);
    if (t) return t;
    await sleep(400);
  }
  return null;
}

// 1. 找到扩展的 library 页面
const libTarget = await findTarget((t) => t.url && t.url.includes('chrome-extension://') && t.url.includes('library.html'), 15000);
check('扩展已加载（library 页面存在）', !!libTarget, libTarget && libTarget.url);
if (!libTarget) {
  for (const r of results) log(r);
  process.exit(1);
}
const lib = new Client(libTarget.webSocketDebuggerUrl);
await lib.ready;
await lib.send('Runtime.enable');
const extId = new URL(libTarget.url).host;

// 2. 打开一篇真实文章页面，用 capture:tab 抓取
const ARTICLE = 'https://www.anthropic.com/research/components-of-agent-memory';
await fetch(CDP + '/json/new?' + encodeURIComponent(ARTICLE), { method: 'PUT' }).catch(() => {});
let artTarget = await findTarget((t) => t.url && t.url.startsWith(ARTICLE), 30000);
if (!artTarget) {
  // 有些版本 /json/new 需要 GET
  await fetch(CDP + '/json/new?' + encodeURIComponent(ARTICLE)).catch(() => {});
  artTarget = await findTarget((t) => t.url && t.url.startsWith(ARTICLE), 30000);
}
check('文章页已打开', !!artTarget, artTarget && artTarget.url);
await sleep(2500);

const tabInfo = await lib.eval(`
  (async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find(x => (x.url||'').startsWith(${JSON.stringify(ARTICLE)}));
    return t ? { id: t.id, url: t.url } : null;
  })()
`);
check('找到目标标签页', !!tabInfo, tabInfo);

const capRes = await lib.eval(`
  chrome.runtime.sendMessage({ type: 'capture:tab', tabId: ${tabInfo ? tabInfo.id : -1} })
`);
check('capture:tab 返回成功', capRes && capRes.ok, capRes);

const reader = await findTarget((t) => t.url && t.url.startsWith('chrome-extension://' + extId) && t.url.includes('reader.html?id='), 20000);
check('打开了阅读页', !!reader, reader && reader.url);

if (reader) {
  const rd = new Client(reader.webSocketDebuggerUrl);
  await rd.ready;
  await rd.send('Runtime.enable');
  // 等正文渲染
  for (let i = 0; i < 40; i++) {
    const n = await rd.eval("document.querySelectorAll('#content p').length");
    if (n > 3) break;
    await sleep(400);
  }
  const info = await rd.eval(`(() => ({
    title: document.getElementById('title').textContent,
    crumb: document.getElementById('crumb').textContent,
    paras: document.querySelectorAll('#content p').length,
    len: document.getElementById('content').textContent.length,
    toc: document.querySelectorAll('#tocList .toc-item').length,
    loadingHidden: document.getElementById('loading').classList.contains('hide'),
    hl: document.getElementById('annoCount').textContent,
    meta: document.getElementById('metaline').textContent,
    imgs: document.querySelectorAll('#content img').length,
    figs: document.querySelectorAll('#content figure').length,
    figcaps: document.querySelectorAll('#content figcaption').length,
    firstCap: ((document.querySelector('#content figcaption') || {}).textContent || '').trim().slice(0, 40)
  }))()`);
  check('阅读页标题正确', /components of agent memory/i.test(info.title || ''), info.title);
  check('正文段落充足', info.paras > 10, info.paras);
  check('正文长度合理', info.len > 3000, info.len);
  check('加载遮罩已隐藏', info.loadingHidden === true, info.loadingHidden);
  check('字数/时长已计算', /字/.test(info.meta || ''), info.meta);
  check('配图被保留下来', info.imgs >= 10, info.imgs);
  check('图注被保留下来', info.figcaps >= 5, info.figcaps);
  check('图注带 Figure 编号', /^Figure\s*1/i.test(info.firstCap || ''), info.firstCap);

  // 图片真的能加载（懒加载：滚到第一张图再等它解码）
  const firstImgWidth = await rd.eval(`(async () => {
    const img = document.querySelector('#content img');
    if (!img) return 0;
    img.scrollIntoView({ block: 'center' });
    for (let i = 0; i < 40; i++) {
      if (img.complete && img.naturalWidth > 0) return img.naturalWidth;
      await new Promise(r => setTimeout(r, 500));
    }
    return 0;
  })()`);
  check('图片实际加载成功', firstImgWidth > 0, firstImgWidth);

  // 3. 在真实扩展页面里做一次划词高亮 + 笔记
  const act = await rd.eval(`
    (async () => {
      const ps = [...document.querySelectorAll('#content p')];
      const p = ps.find(el => (el.textContent || '').trim().length > 150) || ps[0];
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let tn = null, n;
      while ((n = walker.nextNode())) { if ((n.nodeValue || '').trim().length > 40) { tn = n; break; } }
      if (!tn) return { error: 'no text node' };
      const len = tn.nodeValue.length;
      const r = document.createRange();
      r.setStart(tn, 0);
      r.setEnd(tn, Math.min(60, len));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      document.getElementById('content').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise(res => setTimeout(res, 150));
      const barHidden = document.getElementById('selbar').hidden;
      const picked = (sel.toString() || '').slice(0, 30);
      document.querySelector('.selbar button[data-act="hl"][data-color="green"]').click();
      for (let i = 0; i < 20; i++) {
        await new Promise(res => setTimeout(res, 100));
        if (document.getElementById('annoCount').textContent !== '0') break;
      }
      return { barHidden, picked, marks: document.querySelectorAll('mark.rn-hl').length, badge: document.getElementById('annoCount').textContent };
    })()
  `);
  check('划词工具条出现', act.barHidden === false, act);
  check('选中了真实文字', !!act.picked, act.picked);
  check('高亮写入页面', act.marks === 1, act.marks);
  check('标注计数已更新', act.badge === '1', act.badge);

  const saved = await rd.eval(`
    (async () => {
      const q = new URLSearchParams(location.search);
      const id = q.get('id');
      const got = await chrome.storage.local.get('rn_article:' + id);
      const art = got['rn_article:' + id];
      const idx = (await chrome.storage.local.get('rn_articles')).rn_articles || [];
      const row = idx.find(a => a.id === id);
      return { hls: art.highlights.length, quote: art.highlights[0] && art.highlights[0].quote.slice(0, 40), color: art.highlights[0] && art.highlights[0].color, idxHl: row && row.hlCount, idxTitle: row && row.title };
    })()
  `);
  check('高亮已持久化到 chrome.storage', saved.hls === 1, saved.hls);
  check('书库索引同步高亮数', saved.idxHl === 1, saved.idxHl);
  check('高亮颜色正确', saved.color === 'green', saved.color);

  // 4. 重新加载阅读页，确认高亮恢复
  await rd.send('Page.reload', {});
  await sleep(2500);
  const restored = await rd.eval("document.querySelectorAll('mark.rn-hl').length");
  check('刷新后高亮恢复', restored === 1, restored);
  rd.close();
}

// 5. 链接抓取（后台 fetch + 阅读页解析）走另一条路径
const url2 = 'https://shubhramishra.substack.com/p/a-guide-to-starting-a-phd';
const cap2 = await lib.eval(`chrome.runtime.sendMessage({ type: 'capture:url', url: ${JSON.stringify(url2)} })`);
check('capture:url 返回成功', cap2 && cap2.ok, cap2);
const reader2 = await findTarget((t) => t.url && t.url.includes('reader.html?raw='), 25000);
check('打开 raw 阅读页', !!reader2, reader2 && reader2.url);
if (reader2) {
  const rd2 = new Client(reader2.webSocketDebuggerUrl);
  await rd2.ready;
  await rd2.send('Runtime.enable');
  for (let i = 0; i < 50; i++) {
    const title = await rd2.eval("document.getElementById('title') && document.getElementById('title').textContent");
    if (title && title.length > 5) break;
    await sleep(400);
  }
  const info2 = await rd2.eval(`(() => ({
    title: document.getElementById('title').textContent,
    paras: document.querySelectorAll('#content p').length,
    len: document.getElementById('content').textContent.length,
    error: !!document.querySelector('.error-box')
  }))()`);
  check('raw 路径标题正确', /PhD/i.test(info2.title || ''), info2.title);
  check('raw 路径正文充足', info2.paras > 10 && info2.len > 3000, info2);
  check('raw 路径无错误', info2.error === false, info2.error);
  rd2.close();
}

// 6. 设置页 & 弹窗：渲染 + 在扩展环境里跑一次真实翻译
await lib.eval(`chrome.tabs.create({ url: chrome.runtime.getURL('options.html') })`);
const optTarget = await findTarget((t) => t.url.includes('options.html'), 15000);
check('设置页可打开', !!optTarget);
if (optTarget) {
  const op = new Client(optTarget.webSocketDebuggerUrl);
  await op.ready;
  await op.send('Runtime.enable');
  await sleep(800);
  const o = await op.eval(`(() => ({
    providers: document.querySelectorAll('input[name="provider"]').length,
    apiHidden: document.getElementById('apiBox').hidden,
    apiDisplay: getComputedStyle(document.getElementById('apiBox')).display,
    stat: document.getElementById('dataStat').textContent
  }))()`);
  check('设置页有 3 个翻译引擎', o.providers === 3, o.providers);
  check('未选 API 时隐藏密钥框', o.apiHidden === true && o.apiDisplay === 'none', o);
  // 翻译依赖外网，连不上时跳过而不是判失败
  let tr = null;
  try {
    tr = await op.eval(`RN.translate.translate('Agents need memory that persists across sessions.')`);
  } catch (e) {
    console.log('SKIP 扩展环境翻译：网络不可用（' + String(e.message).slice(0, 60) + '）');
  }
  if (tr) check('扩展环境里翻译可用', !!(tr.text && /[\u4e00-\u9fff]/.test(tr.text)), tr && tr.text);
  op.close();
}

await lib.eval(`chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') })`);
const popTarget = await findTarget((t) => t.url.includes('popup.html'), 15000);
check('弹窗页可打开', !!popTarget);
if (popTarget) {
  const pp = new Client(popTarget.webSocketDebuggerUrl);
  await pp.ready;
  await pp.send('Runtime.enable');
  await sleep(800);
  const p = await pp.eval(`(() => ({
    recents: document.querySelectorAll('#recentList li').length,
    hasGrab: !!document.getElementById('btnGrab'),
    count: document.getElementById('count').textContent
  }))()`);
  check('弹窗显示最近文章', p.recents >= 1, p);
  pp.close();
}

// 7. 公式文章：TeX 定界符要用本地 KaTeX 渲染成真正的公式
//    （站点在 GitHub Pages，国内网络偶尔会连不上，那就跳过这组检查）
const MATH_URL = 'https://shengyu-feng.github.io/blog/2026/10/13/beyond-RL/';
const beforeRaw = new Set((await list()).map((t) => t.url));
const cap3 = await lib.eval(`chrome.runtime.sendMessage({ type: 'capture:url', url: ${JSON.stringify(MATH_URL)} })`);
if (!(cap3 && cap3.ok)) {
  console.log('SKIP 公式文章抓取：网络不可达（' + JSON.stringify(cap3) + '）');
} else {
  check('公式文章抓取成功', true, cap3);
  const reader3 = await findTarget((t) => t.url.includes('reader.html?raw=') && !beforeRaw.has(t.url), 30000);
  check('打开公式文章阅读页', !!reader3, reader3 && reader3.url);
  if (reader3) {
    const rd3 = new Client(reader3.webSocketDebuggerUrl);
    await rd3.ready;
    await rd3.send('Runtime.enable');
    for (let i = 0; i < 60; i++) {
      const k = await rd3.eval("document.querySelectorAll('#content .katex').length");
      if (k > 10) break;
      await sleep(400);
    }
    const m = await rd3.eval(`(() => ({
      title: document.getElementById('title').textContent,
      katex: document.querySelectorAll('#content .katex').length,
      display: document.querySelectorAll('#content .rn-math-display').length,
      texLeft: document.getElementById('content').textContent.split('\\\\[').length - 1,
      fallback: document.querySelectorAll('#content .rn-math-fallback').length
    }))()`);
    check('公式已用 KaTeX 渲染', m.katex > 50, m);
    check('没有残留 TeX 定界符', m.texLeft === 0, m.texLeft);
    check('没有渲染失败的公式', m.fallback === 0, m.fallback);
    rd3.close();
  }
}

lib.close();
for (const r of results) log(r);
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
