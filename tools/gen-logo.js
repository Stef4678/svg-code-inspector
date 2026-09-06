// Generates SVG-Code-Inspector/logo.png (128×128) without any dependencies.
// Pure Node: RGBA raster + hand-rolled PNG encoder (zlib is built in).
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 128;
const px = new Float64Array(S * S * 4); // RGBA

// ---------- tiny raster helpers ----------
function setPx(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
    const i = (y * S + x) * 4;
    const na = Math.max(0, Math.min(1, a));
    // alpha over (bg handled later)
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = na;
}

// anti-aliased coverage for a rounded-rect mask
function roundedCoverage(x, y, r) {
    const x0 = r, x1 = S - 1 - r, y0 = r, y1 = S - 1 - r;
    const qx = Math.max(x0 - x, x - x1, 0);
    const qy = Math.max(y0 - y, y - y1, 0);
    const d = Math.sqrt(qx * qx + qy * qy) - r; // <0 inside
    return Math.max(0, Math.min(1, 0.5 - d));
}

function segDist(px_, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const apx = px_ - ax, apy = py - ay;
    const len2 = abx * abx + aby * aby;
    let t = len2 ? (apx * abx + apy * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = apx - abx * t, dy = apy - aby * t;
    return Math.sqrt(dx * dx + dy * dy);
}

// ---------- draw ----------
const R = 26;
const c1 = [0x38, 0x6f, 0xe6]; // top-left blue
const c2 = [0x8b, 0x3d, 0xf2]; // bottom-right violet

for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
        const cov = roundedCoverage(x, y, R);
        if (cov <= 0) continue;
        const t = Math.min(1, Math.max(0, (x + y) / (2 * (S - 1))));
        const r = c1[0] + (c2[0] - c1[0]) * t;
        const g = c1[1] + (c2[1] - c1[1]) * t;
        const b = c1[2] + (c2[2] - c1[2]) * t;
        setPx(x, y, r, g, b, cov);
    }
}

// "</>" glyph strokes
const HALF_W = 5.0;
const strokes = [
    [34, 44, 56, 64],   // <  upper
    [56, 64, 34, 84],   // <  lower
    [94, 44, 72, 64],   // >  upper
    [72, 64, 94, 84],   // >  lower
    [56, 92, 74, 36],   // /  slash
];

for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
        let best = Infinity;
        for (const s of strokes) {
            const d = segDist(x + 0.5, y + 0.5, s[0], s[1], s[2], s[3]);
            if (d < best) best = d;
        }
        const cov = Math.max(0, Math.min(1, HALF_W - best + 0.5));
        if (cov > 0) setPx(x, y, 255, 255, 255, cov);
    }
}

// ---------- PNG encode ----------
function crc32(buf) {
    let c, table = crc32.table;
    if (!table) {
        table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
    }
    c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
    return out;
}

// raw scanlines with filter byte 0
const raw = Buffer.alloc(S * (1 + S * 4));
for (let y = 0; y < S; y++) {
    const row = y * (1 + S * 4);
    raw[row] = 0;
    for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const o = row + 1 + x * 4;
        raw[o] = Math.round(px[i]);
        raw[o + 1] = Math.round(px[i + 1]);
        raw[o + 2] = Math.round(px[i + 2]);
        raw[o + 3] = Math.round(px[i + 3] * 255);
    }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type RGBA
// compression/filter/interlace = 0

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
]);

const outFile = path.join(__dirname, '..', 'logo.png');
fs.writeFileSync(outFile, png);
console.log('wrote', outFile, png.length, 'bytes');
