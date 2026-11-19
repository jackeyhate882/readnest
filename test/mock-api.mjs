// 本地假 OpenAI 接口，用于验证 AI 概述链路（离线）
import { createServer } from 'node:http';

const PORT = 8799;
const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
    res.end();
    return;
  }
  if (req.url.includes('/chat/completions') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let model = 'mock-model';
      try {
        const j = JSON.parse(body);
        model = j.model || model;
      } catch (e) {}
      const content = '模拟 AI 概述：这篇文章讨论扩散模型的无监督训练。\n- 关键点一：用能量分布解释 RL\n- 关键点二：策略梯度与扩散的结合\n- 关键点三：实验设置与结论';
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({
          id: 'mock',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        })
      );
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => console.log('mock api listening on ' + PORT));
