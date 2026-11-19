// 用 Node 模拟 MV3 Service Worker 环境，跑一遍 background.js 的抓取流程
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..') + '/';
const store = new Map();
const created = [];
const removed = [];
let tabSeq = 100;
const listeners = [];

const payload = {
  url: 'https://example.com/a',
  canonicalUrl: 'https://example.com/a',
  title: 'Test Article',
  byline: 'Someone',
  siteName: 'example.com',
  excerpt: 'An excerpt',
  lang: 'en',
  favicon: '',
  contentHTML:
    '<p>Hello world, this is a test article body with enough text to pass the low-content guard. ' +
    'It talks about agent memory, retrieval, evaluation and other things a reader might highlight.</p>' +
    '<p>Second paragraph keeps the fixture realistic so word counts and reading time look sane.</p>' +
    '<figure><img src="https://example.com/a.png" alt="demo"><figcaption>Figure 1 · A demo figure.</figcaption></figure>',
  textLength: 420,
  wordCount: 70,
  extractor: 'readability',
};

const chromeMock = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
        for (const k of list) if (store.has(k)) out[k] = JSON.parse(store.get(k));
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, JSON.stringify(v));
      },
      async remove(keys) {
        for (const k of typeof keys === 'string' ? [keys] : keys) store.delete(k);
      },
    },
  },
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    getURL: (p) => 'chrome-extension://readnest/' + p,
  },
  tabs: {
    async create(opts) {
      created.push(opts);
      return { id: ++tabSeq };
    },
    async get(id) {
      return { id, status: 'complete', url: 'https://example.com/a' };
    },
    async remove(id) {
      removed.push(id);
    },
    async query() {
      return [{ id: 1, url: 'https://example.com/a', active: true }];
    },
  },
  scripting: {
    async executeScript(opts) {
      if (opts.files) return [];
      return [{ result: payload }];
    },
  },
  contextMenus: {
    removeAll(cb) {
      if (cb) cb();
    },
    create() {},
    onClicked: { addListener: () => {} },
  },
  commands: { onCommand: { addListener: () => {} } },
};

const longHtml = '<html><body><article><h1>Fetched</h1><p>fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. fetched body text. </p></article></body></html>';

const ctx = createContext({
  chrome: chromeMock,
  console,
  setTimeout,
  clearTimeout,
  URL,
  fetch: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => longHtml,
  }),
  importScripts(...paths) {
    for (const p of paths) {
      runInContext(readFileSync(ROOT + p, 'utf8'), ctx, { filename: p });
    }
  },
});
ctx.globalThis = ctx;
ctx.self = ctx;

runInContext(readFileSync(ROOT + 'background.js', 'utf8'), ctx, { filename: 'background.js' });

function send(msg) {
  return new Promise((resolve) => {
    const fn = listeners[0];
    const keep = fn(msg, {}, resolve);
    if (!keep) resolve(undefined);
  });
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
}

// 1) 抓当前标签页
const r1 = await send({ type: 'capture:tab', tabId: 1 });
check('capture:tab 返回 ok', r1 && r1.ok, r1);
check('capture:tab 打开阅读页', created.some((c) => c.url.includes('reader.html?id=')), created.map((c) => c.url));
const idx1 = JSON.parse(store.get('rn_articles') || '[]');
check('书库索引有一条', idx1.length === 1, idx1);
const art1 = JSON.parse(store.get('rn_article:' + r1.id) || 'null');
check('文章已保存', art1 && art1.title === 'Test Article', art1 && art1.title);
check('保存了高亮/笔记容器', art1 && Array.isArray(art1.highlights) && Array.isArray(art1.notes));
check('索引含字数与阅读时长', idx1[0] && idx1[0].wordCount === 70 && idx1[0].readingTime >= 1, idx1[0]);

// 2) 同一篇再抓一次：应复用同一条记录，不重复
const r2 = await send({ type: 'capture:tab', tabId: 1 });
const idx2 = JSON.parse(store.get('rn_articles') || '[]');
check('重复抓取不产生重复记录', idx2.length === 1 && r2.id === r1.id, { n: idx2.length, same: r2.id === r1.id });

// 3) 按链接抓取（fetch 路径，应先存 raw 再开阅读页）
const r3 = await send({ type: 'capture:url', url: 'https://example.com/other' });
const rawKeys = [...store.keys()].filter((k) => k.startsWith('rn_raw:'));
check('链接抓取成功', r3 && r3.ok, r3);
check('存了原始 HTML 待阅读页解析', rawKeys.length === 1, rawKeys);
check('打开了 raw 阅读页', created.some((c) => c.url.includes('reader.html?raw=')), created.map((c) => c.url));

// 4) 只更新正文（open:false）走后台标签页，不再新开阅读页
const before = created.length;
const r4 = await send({ type: 'capture:url', url: 'https://example.com/a', open: false });
check('open:false 返回文章 id', r4 && r4.id === r1.id, r4);
check('open:false 不再新开阅读页', created.slice(before).every((c) => !String(c.url).includes('reader.html')), created.slice(before).map((c) => c.url));
check('后台标签页被关闭', removed.length > 0, removed.length);

// 5) 错误分支：受限 URL
const r5 = await send({ type: 'capture:url', url: 'edge://settings' });
check('受限 URL 返回友好错误', r5 && r5.ok === false && !!r5.error, r5);

// 6) 未知消息不报错
const r6 = await send({ type: 'nope' });
check('未知消息被忽略', r6 === undefined, r6);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '  ' + JSON.stringify(r.extra)));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
