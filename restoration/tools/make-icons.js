/**
 * Icon generator.
 *
 * Writes the PWA PNG icons from code so they can be regenerated after a brand
 * change without a design tool in the loop. Node ships zlib and that is all a
 * PNG needs, so there is no dependency here.
 *
 *   node tools/make-icons.js
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const NAVY = [11, 17, 32];
const SKY = [56, 189, 248];
const GRID = [36, 48, 74];
const DEEP = [3, 105, 161];

/* ------------------------------- drawing -------------------------------- */

function renderIcon(size, { maskable = false } = {}) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // Source-over so anti-aliased edges blend with what is already there.
    const sa = a / 255, da = 1 - sa;
    px[i] = px[i] * da + r * sa;
    px[i + 1] = px[i + 1] * da + g * sa;
    px[i + 2] = px[i + 2] * da + b * sa;
    px[i + 3] = 255;
  };

  // Maskable icons get cropped to a circle by the launcher, so they need the
  // background edge to edge and the artwork inside the safe zone.
  const inset = maskable ? 0 : Math.round(size * 0.06);
  const radius = maskable ? 0 : Math.round(size * 0.22);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = roundedRectCoverage(x, y, inset, inset, size - inset * 2, size - inset * 2, radius);
      if (a > 0) set(x, y, NAVY, Math.round(a * 255));
    }
  }

  // Floor-plan grid behind the mark.
  const step = size / 8;
  const gridInset = inset + size * 0.02;
  for (let i = 1; i < 8; i++) {
    const p = Math.round(inset + step * i);
    for (let q = Math.round(gridInset); q < size - gridInset; q++) {
      if (roundedRectCoverage(p, q, inset, inset, size - inset * 2, size - inset * 2, radius) > 0.9) set(p, q, GRID);
      if (roundedRectCoverage(q, p, inset, inset, size - inset * 2, size - inset * 2, radius) > 0.9) set(q, p, GRID);
    }
  }

  // Droplet: circular bulb with a straight taper up to the apex.
  const scale = maskable ? 0.52 : 0.62;
  const cx = size / 2;
  const apexY = size * (0.5 - scale / 2);
  const bulbR = size * scale * 0.34;
  const bulbY = size * (0.5 + scale / 2) - bulbR;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = dropletCoverage(x, y, cx, apexY, bulbY, bulbR);
      if (cov <= 0) continue;
      // Vertical gradient from bright sky at the top to a deeper blue below.
      const k = Math.min(1, Math.max(0, (y - apexY) / (bulbY + bulbR - apexY)));
      const color = SKY.map((c, i) => Math.round(c + (DEEP[i] - c) * k * 0.75));
      set(x, y, color, Math.round(cov * 255));
    }
  }

  return px;
}

/** Anti-aliased coverage of a rounded rectangle, sampled 3x3. */
function roundedRectCoverage(x, y, rx, ry, w, h, r) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3, py = y + (sy + 0.5) / 3;
      if (insideRoundedRect(px, py, rx, ry, w, h, r)) hits++;
    }
  }
  return hits / 9;
}

function insideRoundedRect(px, py, rx, ry, w, h, r) {
  if (px < rx || py < ry || px > rx + w || py > ry + h) return false;
  if (r <= 0) return true;
  const cx = Math.min(Math.max(px, rx + r), rx + w - r);
  const cy = Math.min(Math.max(py, ry + r), ry + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function dropletCoverage(x, y, cx, apexY, bulbY, bulbR) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3, py = y + (sy + 0.5) / 3;
      if (insideDroplet(px, py, cx, apexY, bulbY, bulbR)) hits++;
    }
  }
  return hits / 9;
}

function insideDroplet(px, py, cx, apexY, bulbY, bulbR) {
  if (py >= bulbY) return (px - cx) ** 2 + (py - bulbY) ** 2 <= bulbR * bulbR;
  if (py < apexY) return false;
  const halfWidth = bulbR * ((py - apexY) / (bulbY - apexY));
  return Math.abs(px - cx) <= halfWidth;
}

/* --------------------------------- PNG ---------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput), data.length + 8);
  return out;
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- run ---------------------------------- */

mkdirSync(OUT, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-180.png', size: 180 },
  { file: 'icon-maskable.png', size: 512, maskable: true },
];

for (const t of targets) {
  writeFileSync(join(OUT, t.file), encodePng(renderIcon(t.size, { maskable: t.maskable }), t.size));
  console.log(`wrote icons/${t.file} (${t.size}×${t.size})`);
}

// Vector version for browsers that prefer it.
writeFileSync(join(OUT, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="DryLine">
  <defs>
    <linearGradient id="d" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#0369a1"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="#0b1120"/>
  <g stroke="#24304a" stroke-width="3">
    ${[1, 2, 3, 4, 5, 6, 7].map((i) => `<line x1="${i * 64}" y1="42" x2="${i * 64}" y2="470"/>
    <line x1="42" y1="${i * 64}" x2="470" y2="${i * 64}"/>`).join('\n    ')}
  </g>
  <path fill="url(#d)" d="M256 98c0 0-98 118-98 186a98 98 0 1 0 196 0c0-68-98-186-98-186z"/>
</svg>
`);
console.log('wrote icons/icon.svg');
