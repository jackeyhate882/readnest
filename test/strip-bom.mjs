// 去掉文件开头的 BOM，保证 JSON/CSS/JS 干净
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTS = new Set(['.js', '.css', '.html', '.json', '.md', '.mjs']);
let fixed = 0;
const touched = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'fonts' || name === 'samples' || name.startsWith('edge-profile')) continue;
      walk(p);
    } else if (EXTS.has(extname(name))) {
      const buf = readFileSync(p);
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        writeFileSync(p, buf.subarray(3));
        fixed++;
        touched.push(p.replace(ROOT + '\\', ''));
      }
    }
  }
}

walk(ROOT);
console.log('removed BOM from ' + fixed + ' files');
if (touched.length) console.log(touched.join('\n'));
