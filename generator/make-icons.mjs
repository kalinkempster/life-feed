#!/usr/bin/env node
// Draw the app icons.
//
//   npm run icons
//
// The manifest needs PNGs at 192 and 512, and iOS will not take an SVG for a
// home-screen icon. Rather than add an image library to a project that has
// deliberately stayed close to zero dependencies, this rasterises the K² mark
// directly and encodes the PNG with node's own zlib.
//
// The mark is drawn as thick line segments — a capsule test per pixel, antialiased
// on the distance — which is enough for a letterform this simple and avoids
// needing font rendering.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { SITE } from "./lib/config.mjs";

const BG = [0x0e, 0x0d, 0x0c]; // --bg
const FG = [0xf5, 0xef, 0xe2]; // --bright
const ACCENT = [0xd9, 0xa4, 0x5b]; // --accent

// ----------------------------------------------------------------- geometry
/** Distance from point p to segment ab. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** The K, and the small 2, in a 0–1 square. */
function strokes() {
  const k = [];
  // Vertical stem, upper arm, lower leg. The joint sits above centre, which is
  // where a Bodoni K puts it.
  const stemX = 0.30;
  const top = 0.26;
  const bottom = 0.78;
  const joint = 0.545;
  const armX = 0.60;
  k.push([stemX, top, stemX, bottom]);
  k.push([stemX, joint, armX, top]);
  k.push([stemX, joint, armX + 0.02, bottom]);

  // The superscript two: an arc, a diagonal, a base bar.
  const two = [];
  const cx = 0.755;
  const cy = 0.335;
  const r = 0.072;
  const steps = 7;
  for (let i = 0; i < steps; i += 1) {
    // Sweep the top of a 2 from about 200° round to 20°.
    const a0 = Math.PI * (1.12 - (i / steps) * 1.0);
    const a1 = Math.PI * (1.12 - ((i + 1) / steps) * 1.0);
    two.push([
      cx + r * Math.cos(a0), cy - r * Math.sin(a0),
      cx + r * Math.cos(a1), cy - r * Math.sin(a1),
    ]);
  }
  two.push([cx + r * Math.cos(Math.PI * 0.12), cy - r * Math.sin(Math.PI * 0.12),
            cx - r * 0.95, cy + r * 1.15]);
  two.push([cx - r * 0.95, cy + r * 1.15, cx + r * 1.05, cy + r * 1.15]);

  return { k, two };
}

function render(size) {
  const px = new Uint8Array(size * size * 3);
  const { k, two } = strokes();

  const kWidth = size * 0.086;
  const twoWidth = size * 0.030;
  const aa = Math.max(1, size / 220); // antialias band, in pixels

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const fx = (x + 0.5) / size;
      const fy = (y + 0.5) / size;

      let dK = Infinity;
      for (const [ax, ay, bx, by] of k) {
        dK = Math.min(dK, distToSegment(fx, fy, ax, ay, bx, by) * size);
      }
      let dTwo = Infinity;
      for (const [ax, ay, bx, by] of two) {
        dTwo = Math.min(dTwo, distToSegment(fx, fy, ax, ay, bx, by) * size);
      }

      // Coverage: 1 inside the stroke, fading to 0 across the antialias band.
      const covK = Math.max(0, Math.min(1, (kWidth / 2 - dK) / aa + 0.5));
      const covTwo = Math.max(0, Math.min(1, (twoWidth / 2 - dTwo) / aa + 0.5));

      let r = BG[0], g = BG[1], b = BG[2];
      if (covK > 0) {
        r = r + (FG[0] - r) * covK;
        g = g + (FG[1] - g) * covK;
        b = b + (FG[2] - b) * covK;
      }
      if (covTwo > 0) {
        r = r + (ACCENT[0] - r) * covTwo;
        g = g + (ACCENT[1] - g) * covTwo;
        b = b + (ACCENT[2] - b) * covTwo;
      }

      const o = (y * size + x) * 3;
      px[o] = Math.round(r);
      px[o + 1] = Math.round(g);
      px[o + 2] = Math.round(b);
    }
  }
  return px;
}

// ---------------------------------------------------------------- PNG output
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter byte; 0 = none, which compresses
  // perfectly well for flat art like this.
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = path.join(SITE, `icon-${size}.png`);
  fs.writeFileSync(file, encodePng(render(size), size));
  console.log(`  wrote ${path.basename(file)}  ${(fs.statSync(file).size / 1024).toFixed(1)}KB`);
}
console.log("");
