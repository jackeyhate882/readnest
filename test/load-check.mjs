// 快速确认扩展能被 Edge 正常加载（service worker 起来了 + 书库页打开）
const CDP = 'http://127.0.0.1:9222';
const targets = await (await fetch(CDP + '/json/list')).json();
const sw = targets.find((t) => t.type === 'service_worker' && /background\.js$/.test(t.url || ''));
const lib = targets.find((t) => (t.url || '').includes('/library.html'));
const reader = targets.find((t) => (t.url || '').includes('/reader.html'));

const results = [
  ['扩展已加载，service worker 在运行', !!sw, sw && sw.url],
  ['首次安装打开了书库页', !!lib, lib && lib.url],
];
let failed = 0;
for (const [name, ok, extra] of results) {
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : '  ' + extra));
}
console.log(failed ? '加载检查失败' : '加载检查通过');
process.exit(failed ? 1 : 0);
