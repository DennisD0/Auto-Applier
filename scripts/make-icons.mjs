#!/usr/bin/env node
// Generate the extension icons with no dependencies — Node's zlib can encode PNG directly.
//
// Design: the same lightning bolt as the popup header, knocked out of a brand-blue rounded
// square. One mark, one meaning, consistent with the in-app icon set. Rendered at 4x and box-
// filtered down so the diagonals stay clean at 16px, which is where most extension icons fall
// apart.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(OUT, { recursive: true });

const SS = 4;                                  // supersample factor
const BG_TOP = [37, 99, 235];                  // #2563EB
const BG_BOT = [29, 64, 175];                  // #1D40AF — subtle vertical shift, not a gradient show
const FG = [255, 255, 255];

// Lucide "zap" path as a polygon, in a 24x24 box.
const BOLT = [[13, 2], [3, 14], [12, 14], [11, 22], [21, 10], [12, 10], [13, 2]];

function inPoly(x, y, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Signed-distance rounded rectangle, used for the tile and its subtle inner edge. */
function inRoundRect(x, y, w, h, r) {
  const dx = Math.max(r - x, 0, x - (w - r));
  const dy = Math.max(r - y, 0, y - (h - r));
  return Math.hypot(dx, dy) <= r;
}

function render(size) {
  const S = size * SS;
  const radius = S * 0.225;                    // squircle-ish, matches Chrome's own tiles
  const acc = new Float64Array(size * size * 4);

  // Bolt transform: fit the 24-unit box to ~58% of the tile, centred.
  const scale = (S * 0.58) / 24;
  const ox = (S - 24 * scale) / 2;
  const oy = (S - 24 * scale) / 2;

  for (let sy = 0; sy < S; sy++) {
    for (let sx = 0; sx < S; sx++) {
      let r = 0, g = 0, b = 0, a = 0;
      if (inRoundRect(sx, sy, S, S, radius)) {
        const t = sy / S;
        r = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t;
        g = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t;
        b = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t;
        a = 255;
        const bx = (sx - ox) / scale;
        const by = (sy - oy) / scale;
        if (inPoly(bx, by, BOLT)) { r = FG[0]; g = FG[1]; b = FG[2]; }
      }
      // accumulate into the destination pixel (box filter)
      const dx = (sx / SS) | 0, dy = (sy / SS) | 0;
      const di = (dy * size + dx) * 4;
      acc[di] += r; acc[di + 1] += g; acc[di + 2] += b; acc[di + 3] += a;
    }
  }

  const n = SS * SS;
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < acc.length; i++) px[i] = Math.round(acc[i] / n);
  return px;
}

// ---- minimal PNG encoder -------------------------------------------------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  // 10,11,12 = deflate / adaptive filter / no interlace, all zero

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;  // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log(`OK  icon-${size}.png`);
}
