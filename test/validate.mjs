// 校验 manifest 与各页面引用的文件是否都存在
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..') + '/';
const problems = [];

const manifest = JSON.parse(readFileSync(ROOT + 'manifest.json', 'utf8'));
const must = ['manifest_version', 'name', 'version', 'background', 'action', 'permissions'];
for (const k of must) if (!manifest[k]) problems.push('manifest 缺少字段 ' + k);
if (manifest.manifest_version !== 3) problems.push('manifest_version 不是 3');

const files = new Set();
files.add(manifest.background.service_worker);
files.add(manifest.action.default_popup);
files.add(manifest.options_page);
for (const p of Object.values(manifest.icons || {})) files.add(p);
for (const p of Object.values(manifest.action.default_icon || {})) files.add(p);

for (const f of files) {
  if (!f) continue;
  if (!existsSync(join(ROOT, f))) problems.push('manifest 引用的文件不存在: ' + f);
}

// 检查 HTML 里的 script/link/img 引用
const pages = ['reader.html', 'library.html', 'popup.html', 'options.html'];
for (const page of pages) {
  const html = readFileSync(ROOT + page, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|data:)/.test(ref)) continue;
    const clean = ref.split('?')[0];
    if (!existsSync(join(ROOT, clean))) problems.push(page + ' 引用了不存在的文件: ' + ref);
  }
}

// 检查 CSS 里是否还有 font-family 以外的外部链接
const css = readFileSync(ROOT + 'reader.css', 'utf8');
if (/url\(\s*['"]?https?:/.test(css)) problems.push('reader.css 里有外链资源（会离线失效）');

// 检查 JS 里没有语法层面的明显遗漏：所有 chrome 用法都在权限内
const perms = new Set(manifest.permissions || []);
const bg = readFileSync(ROOT + 'background.js', 'utf8');
const usedApis = ['scripting', 'tabs', 'contextMenus', 'storage', 'commands'];
for (const api of usedApis) {
  if (bg.includes('chrome.' + api) && api !== 'commands' && !perms.has(api)) {
    problems.push('background.js 用到了 chrome.' + api + ' 但 manifest 未声明权限');
  }
}

console.log(problems.length ? '发现 ' + problems.length + ' 个问题：\n- ' + problems.join('\n- ') : '校验通过：manifest 与页面引用完整');
process.exit(problems.length ? 1 : 0);
