// 生成扩展图标（纯 Node，无第三方依赖）
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = 'D:/software/readnest/icons';
mkdirSync(OUT, { recursive: true });

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) return 0;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r ? 1 : 0;
}

function render(size) {
  const S = 4; // 超采样
  const W = size * S;
  const H = size * S;
  const buf = Buffer.alloc(W * H * 4);
  const R = Math.round(W * 0.24);
  const pageX = Math.round(W * 0.26);
  const pageY = Math.round(H * 0.2);
  const pageW = Math.round(W * 0.48);
  const pageH = Math.round(H * 0.6);
  const lineH = Math.max(1, Math.round(H * 0.055));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // 圆角矩形背景 + 渐变
      const inBg = insideRoundRect(x, y, 0, 0, W, H, R);
      if (!inBg) {
        buf[i + 3] = 0;
        continue;
      }
      const t = y / H;
      const r0 = Math.round(47 + (26 - 47) * t);
      const g0 = Math.round(111 + (58 - 111) * t);
      const b0 = Math.round(237 + (143 - 237) * t);
      // 右上角高光
      const glow = Math.max(0, 1 - Math.hypot(x - W * 0.85, y - H * 0.12) / (W * 0.75)) * 0.22;
      let r = Math.min(255, r0 + 60 * glow);
      let g = Math.min(255, g0 + 60 * glow);
      let b = Math.min(255, b0 + 40 * glow);
      // 白色书页
      const inPage = insideRoundRect(x, y, pageX, pageY, pageW, pageH, Math.round(W * 0.05));
      if (inPage) {
        const dark = y > pageY + pageH * 0.62;
        r = dark ? 226 : 255;
        g = dark ? 236 : 255;
        b = dark ? 255 : 255;
        // 页面上的三条“文字”
        const lines = [0.24, 0.44, 0.62];
        for (const lf of lines) {
          const ly = pageY + pageH * lf;
          if (y >= ly && y < ly + lineH && x >= pageX + pageW * 0.16 && x < pageX + pageW * 0.84) {
            r = 47;
            g = 111;
            b = 237;
          }
        }
      }
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  const n = S * S;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * W + (x * S + sx)) * 4;
          const alpha = buf[i + 3] / 255;
          r += buf[i] * alpha;
          g += buf[i + 1] * alpha;
          b += buf[i + 2] * alpha;
          a += buf[i + 3];
        }
      }
      const ai = a / n;
      const o = (y * size + x) * 4;
      const wa = ai / 255 || 1;
      out[o] = Math.round(r / n / wa);
      out[o + 1] = Math.round(g / n / wa);
      out[o + 2] = Math.round(b / n / wa);
      out[o + 3] = Math.round(ai);
    }
  }
  return encodePNG(size, size, out);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(`${OUT}/icon${size}.png`, render(size));
  console.log('icon' + size + '.png ok');
}
