// Renders the extension icons as PNGs with no dependencies.
// Usage: node scripts/make-icons.mjs
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

const BG = [27, 31, 36];
const ORANGE = [255, 161, 22];
const GREEN = [63, 185, 80];

function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x - 0.5) - half + r;
  const qy = Math.abs(y - 0.5) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

/** Returns [r,g,b,a] in 0..1 for a point in unit space. */
function shade(x, y) {
  if (sdRoundRect(x, y, 0.5, 0.22) > 0) return [0, 0, 0, 0];
  const w = 0.075;
  const trunk = sdSegment(x, y, 0.36, 0.26, 0.36, 0.74) - w / 2;
  const branch = Math.min(
    sdSegment(x, y, 0.66, 0.34, 0.66, 0.46) - w / 2,
    sdSegment(x, y, 0.66, 0.46, 0.38, 0.62) - w / 2,
  );
  const nodes = Math.min(sdCircle(x, y, 0.36, 0.26, 0.1), sdCircle(x, y, 0.36, 0.74, 0.1));
  const tip = sdCircle(x, y, 0.66, 0.3, 0.11);
  if (tip <= 0) return [...GREEN.map((c) => c / 255), 1];
  if (Math.min(trunk, branch, nodes) <= 0) return [...ORANGE.map((c) => c / 255), 1];
  return [...BG.map((c) => c / 255), 1];
}

function render(size) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const [cr, cg, cb, ca] = shade((i + (si + 0.5) / ss) / size, (j + (sj + 0.5) / ss) / size);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const n = ss * ss;
      const o = (j * size + i) * 4;
      px[o] = a ? Math.round((r / a) * 255) : 0;
      px[o + 1] = a ? Math.round((g / a) * 255) : 0;
      px[o + 2] = a ? Math.round((b / a) * 255) : 0;
      px[o + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, px);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  await writeFile(join(out, `icon-${size}.png`), render(size));
}
console.log("Icons written to", out);
