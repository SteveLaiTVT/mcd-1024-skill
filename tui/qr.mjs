// Compact QR Code encoder (ISO/IEC 18004): byte mode, error-correction level M,
// versions 1–4 only (≤ 62 bytes). Zero dependencies. Used for the receipt QR,
// which encodes receipt text only; it is never a payment code.
const EC_M = { 1: { ec: 10, blocks: [16] }, 2: { ec: 16, blocks: [28] }, 3: { ec: 26, blocks: [44] }, 4: { ec: 18, blocks: [32, 32] } };
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26] };
const dataCapacity = (version) => EC_M[version].blocks.reduce((a, b) => a + b, 0);
// Byte mode header is 4 mode bits + 8 count bits for versions 1–9.
export const byteCapacity = (version) => Math.floor((dataCapacity(version) * 8 - 12) / 8);
export const QR_MAX_BYTES = byteCapacity(4);
export const utf8 = (text) => new TextEncoder().encode(String(text));

export function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
// Generator polynomial with roots α^0 … α^(degree-1), leading 1 omitted.
function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { r[j] = gfMul(r[j], root); if (j + 1 < degree) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, divisor) {
  const r = divisor.map(() => 0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); divisor.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
  return r;
}

// 15-bit format word: EC level M (00) + 3 mask bits, BCH(15,5), XOR 0x5412.
export function formatBits(mask) {
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function dataCodewords(bytes, version) {
  const capacity = dataCapacity(version), bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4); push(bytes.length, 8); bytes.forEach((b) => push(b, 8));
  push(0, Math.min(4, capacity * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data, version) {
  const { ec, blocks } = EC_M[version], divisor = rsDivisor(ec), dataBlocks = [], ecBlocks = [];
  let k = 0;
  for (const length of blocks) { const block = data.slice(k, k + length); k += length; dataBlocks.push(block); ecBlocks.push(rsRemainder(block, divisor)); }
  const out = [];
  for (let i = 0; i < Math.max(...blocks); i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

function drawFormat(modules, fixed, mask) {
  const size = modules.length, bits = formatBits(mask), bit = (i) => ((bits >>> i) & 1) === 1;
  const set = (x, y, dark) => { modules[y][x] = dark; if (fixed) fixed[y][x] = true; };
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // Always-dark module.
}

function functionPatterns(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const align = ALIGN[version], last = align.length - 1;
  align.forEach((cx, i) => align.forEach((cy, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  drawFormat(modules, fixed, 0); // Reserve format areas; redrawn once the mask is chosen.
  return { size, modules, fixed };
}

function placeCodewords(modules, fixed, codewords) {
  const size = modules.length, total = codewords.length * 8;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fixed[y][x]) continue;
        if (i < total) { modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
  }
}

export const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m) {
  const n = m.length; let score = 0, dark = 0;
  const lines = [...m, ...m[0].map((_, x) => m.map((row) => row[x]))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    const s = line.map((v) => (v ? '1' : '0')).join('');
    for (const p of ['10111010000', '00001011101']) for (let k = s.indexOf(p); k !== -1; k = s.indexOf(p, k + 1)) score += 40;
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  for (const row of m) for (const v of row) if (v) dark++;
  return score + 10 * Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n));
}

// Returns { version, size, mask, ecLevel, modules } where modules[y][x] === true is a dark module.
export function encodeQR(text, { mask: forcedMask } = {}) {
  const bytes = [...utf8(text)];
  const version = [1, 2, 3, 4].find((v) => bytes.length <= byteCapacity(v));
  if (!version) throw new Error(`二维码内容过长：${bytes.length} 字节，最多 ${QR_MAX_BYTES} 字节。`);
  const codewords = interleave(dataCodewords(bytes, version), version);
  const { size, modules, fixed } = functionPatterns(version);
  placeCodewords(modules, fixed, codewords);
  const masked = (mask) => {
    const m = modules.map((row, y) => row.map((v, x) => (fixed[y][x] ? v : v !== MASKS[mask](x, y))));
    drawFormat(m, null, mask); return m;
  };
  let best = null;
  for (const mask of forcedMask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask]) {
    const m = masked(mask), score = penalty(m);
    if (!best || score < best.score) best = { mask, modules: m, score };
  }
  return { version, size, mask: best.mask, ecLevel: 'M', modules: best.modules };
}

// Half-block terminal rendering, two module rows per line. With colour: black on an
// explicit white background (works on any terminal theme). Without colour: light
// modules are drawn as blocks, which assumes a dark terminal background.
export function renderQR(qr, { quiet = 2, color = false } = {}) {
  const n = qr.size + quiet * 2;
  const dark = (x, y) => {
    const mx = x - quiet, my = y - quiet;
    return mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my][mx];
  };
  const ink = (x, y) => y < n && (color ? dark(x, y) : !dark(x, y));
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    for (let x = 0; x < n; x++) {
      const top = ink(x, y), bottom = ink(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(color ? `\x1b[30;107m${line}\x1b[0m` : line);
  }
  return lines;
}
