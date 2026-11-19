// 抓取几篇真实文章 HTML，作为抽取/阅读的测试样本
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'samples');
mkdirSync(OUT, { recursive: true });

const targets = [
  { name: 'anthropic', url: 'https://www.anthropic.com/research/components-of-agent-memory' },
  { name: 'substack-phd', url: 'https://shubhramishra.substack.com/p/a-guide-to-starting-a-phd' },
  { name: 'hf-agents', url: 'https://huggingface.co/blog/huggingface/train-agents' },
  { name: 'reilabs', url: 'https://reilabs.org/blog/coupled-learning-and-planning' },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

for (const t of targets) {
  try {
    const resp = await fetch(t.url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    const html = await resp.text();
    writeFileSync(`${OUT}/${t.name}.html`, html);
    console.log(t.name, resp.status, html.length);
  } catch (e) {
    console.log(t.name, 'ERR', e.message);
  }
}
