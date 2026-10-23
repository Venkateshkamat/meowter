// Generates media/icon.png (128x128) from the extension's own cat sprite (src/catArt.ts).
//
// Run on demand, it is NOT part of `npm run compile`:
//   npm run compile && node scripts/make-icon.js
//
// It reads the compiled sprite module (out/catArt.js), draws the orange tabby sitting on a warm
// rounded-square background (cat scaled up with nearest-neighbour so the pixels stay crisp), and
// writes the PNG with Node's built-in zlib. No dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SCALE = 5; // sprite pixel -> 5x5 icon pixels
const RADIUS = 28; // corner radius of the background
const COAT = 'orange';
const FRAME = 'sitA';

const BG_TOP = [0xff, 0xe3, 0xa8]; // butter cream
const BG_BOTTOM = [0xff, 0xc9, 0x7e]; // warm apricot
const SHADOW = [0xd9, 0x8f, 0x4a];

const root = path.resolve(__dirname, '..');
const catArt = require(path.join(root, 'out', 'catArt.js'));

const img = new Uint8Array(SIZE * SIZE * 4);

// Background: vertical gradient in two flat bands per row group (keeps a pixel-art feel), rounded corners
// with antialiased edges (4x4 supersampling).
function insideRoundedSquare(x, y) {
  const cx = Math.min(Math.max(x, RADIUS), SIZE - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), SIZE - RADIUS);
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS * RADIUS;
}
for (let y = 0; y < SIZE; y++) {
  const t = Math.floor((y / SIZE) * 6) / 5; // 6 flat bands
  const col = BG_TOP.map((v, i) => Math.round(v + (BG_BOTTOM[i] - v) * t));
  for (let x = 0; x < SIZE; x++) {
    let hit = 0;
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        if (insideRoundedSquare(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++;
      }
    }
    const o = (y * SIZE + x) * 4;
    img[o] = col[0];
    img[o + 1] = col[1];
    img[o + 2] = col[2];
    img[o + 3] = Math.round((hit / 16) * 255);
  }
}

const sprite = catArt.frameRgba(COAT, FRAME);
const fs32 = sprite.width;
// Bounding box of the painted sprite pixels.
let minX = fs32, minY = fs32, maxX = -1, maxY = -1;
for (let y = 0; y < fs32; y++) {
  for (let x = 0; x < fs32; x++) {
    if (sprite.data[(y * fs32 + x) * 4 + 3] > 0) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
}
const w = (maxX - minX + 1) * SCALE;
const h = (maxY - minY + 1) * SCALE;
const offX = Math.round((SIZE - w) / 2);
const offY = Math.round((SIZE - h) / 2) - 2; // a little above centre, leaving room for the shadow

function put(x, y, rgb) {
  const o = (y * SIZE + x) * 4;
  if (img[o + 3] === 0) return;
  img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2];
}

// Flat floor shadow under the cat.
const shadowCx = SIZE / 2 + 3;
const shadowCy = offY + h + 1;
for (let y = shadowCy - 5; y <= shadowCy + 5; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = (x - shadowCx) / (w / 2 + 2);
    const dy = (y - shadowCy) / 5;
    if (dx * dx + dy * dy <= 1) put(x, y, SHADOW);
  }
}

// The cat, nearest-neighbour scaled.
for (let sy = minY; sy <= maxY; sy++) {
  for (let sx = minX; sx <= maxX; sx++) {
    const o = (sy * fs32 + sx) * 4;
    if (sprite.data[o + 3] === 0) continue;
    const rgb = [sprite.data[o], sprite.data[o + 1], sprite.data[o + 2]];
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        put(offX + (sx - minX) * SCALE + dx, offY + (sy - minY) * SCALE + dy, rgb);
      }
    }
  }
}

// --- PNG encoder (RGBA, 8 bit, no interlace) ---
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
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
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(img.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
const outFile = path.join(root, 'media', 'icon.png');
fs.writeFileSync(outFile, png);
console.log(`wrote ${path.relative(root, outFile)} (${SIZE}x${SIZE}, ${png.length} bytes)`);
