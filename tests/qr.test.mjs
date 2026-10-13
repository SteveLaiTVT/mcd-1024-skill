import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQR, renderQR, formatBits, QR_MAX_BYTES, utf8 } from '../tui/qr.mjs';

// Independent reference pieces (not shared with the encoder): GF(256) log tables,
// the published format-information table for level M, spec mask formulas (i = row, j = column).
const EXP = new Array(512), LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const FORMAT_M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
const MASK = [(i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0, (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0];
const BLOCKS = { 1: [[16], 10], 2: [[28], 16], 3: [[44], 26], 4: [[32, 32], 18] };

function functionMap(version) {
  const size = 17 + 4 * version, f = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y][x] = true; };
  mark(0, 0, 9, 9); mark(size - 8, 0, 8, 9); mark(0, size - 8, 9, 8); // finders, separators, format areas, dark module
  mark(6, 0, 1, size); mark(0, 6, size, 1); // timing
  if (version >= 2) mark(size - 9, size - 9, 5, 5); // single alignment pattern centred at size-7
  return f;
}
// Format strings, most significant bit first, read from both copies.
function readFormat(m) {
  const size = m.length, s = (v) => (v ? '1' : '0');
  const a = [0, 1, 2, 3, 4, 5, 7, 8].map((c) => s(m[8][c])).join('') + [7, 5, 4, 3, 2, 1, 0].map((r) => s(m[r][8])).join('');
  const b = Array.from({ length: 7 }, (_, k) => s(m[size - 1 - k][8])).join('') + Array.from({ length: 8 }, (_, k) => s(m[8][size - 8 + k])).join('');
  return { a, b };
}
function decode(qr) {
  const m = qr.modules, size = m.length, version = (size - 17) / 4, f = functionMap(version);
  const fmt = readFormat(m), mask = FORMAT_M.indexOf(fmt.a), bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < size; k++) {
      const y = upward ? size - 1 - k : k;
      for (const x of [right, right - 1]) if (!f[y][x]) bits.push(m[y][x] !== MASK[mask](y, x) ? 1 : 0);
    }
    upward = !upward;
  }
  const [blocks, ec] = BLOCKS[version], dataTotal = blocks.reduce((a, b) => a + b, 0), total = dataTotal + ec * blocks.length;
  const bytes = Array.from({ length: total }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8).join(''), 2));
  const data = blocks.map(() => []), ecc = blocks.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...blocks); i++) blocks.forEach((len, b) => { if (i < len) data[b].push(bytes[k++]); });
  for (let i = 0; i < ec; i++) blocks.forEach((_, b) => ecc[b].push(bytes[k++]));
  const syndromesZero = blocks.every((_, b) => {
    const cw = [...data[b], ...ecc[b]];
    for (let j = 0; j < ec; j++) { let s = 0; for (const c of cw) s = mul(s, EXP[j]) ^ c; if (s) return false; }
    return true;
  });
  const stream = data.flat().flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >> i) & 1));
  const read = (n) => parseInt(stream.splice(0, n).join(''), 2);
  const mode = read(4), count = read(8), payload = Array.from({ length: count }, () => read(8));
  return { version, mask, fmt, remainderBits: bits.length - total * 8, syndromesZero, mode, count, dataTotal, payload: Buffer.from(payload).toString('utf8'), rest: stream };
}
const finderAt = (m, x0, y0) => {
  for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) if (m[y0 + dy][x0 + dx] !== (Math.max(Math.abs(dx - 3), Math.abs(dy - 3)) !== 2)) return false;
  return true;
};

function assertStructure(qr, text) {
  const m = qr.modules, size = qr.size, n = size - 1;
  assert.equal(size, 17 + 4 * qr.version); assert(m.length === size && m.every((row) => row.length === size));
  // Finder patterns at exactly three corners, with light separators.
  assert(finderAt(m, 0, 0) && finderAt(m, size - 7, 0) && finderAt(m, 0, size - 7), 'three finder patterns');
  assert(!finderAt(m, size - 7, size - 7), 'no finder pattern bottom-right');
  for (let i = 0; i < 8; i++) {
    for (const [y, x] of [[7, i], [i, 7], [7, n - i], [i, size - 8], [size - 8, i], [n - i, 7]]) assert.equal(m[y][x], false, `separator ${y},${x}`);
  }
  // Timing patterns alternate between the finders.
  for (let i = 8; i <= size - 9; i++) { assert.equal(m[6][i], i % 2 === 0, `timing row ${i}`); assert.equal(m[i][6], i % 2 === 0, `timing col ${i}`); }
  assert.equal(m[size - 8][8], true, 'dark module');
  if (qr.version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) assert.equal(m[c + dy][c + dx], Math.max(Math.abs(dx), Math.abs(dy)) !== 1, 'alignment pattern');
  }
  // Format info: both copies agree, BCH-valid (in the published table), level M, mask as reported.
  const fmt = readFormat(m);
  assert.equal(fmt.a, fmt.b); assert.equal(fmt.a, FORMAT_M[qr.mask]); assert.equal(fmt.a.slice(0, 2), '10', 'level M bits 00 after XOR 10');
  assert.equal(formatBits(qr.mask).toString(2).padStart(15, '0'), FORMAT_M[qr.mask]);
  // Version info blocks exist only from version 7; this encoder stops at 4, so none applies.
  assert(qr.version <= 4 && qr.version < 7);
  // Full round trip with the independent reader.
  const d = decode(qr);
  assert.equal(d.mask, qr.mask); assert.equal(d.remainderBits, qr.version === 1 ? 0 : 7);
  assert(d.syndromesZero, 'Reed–Solomon syndromes are zero'); assert.equal(d.mode, 0b0100, 'byte mode');
  assert.equal(d.count, utf8(text).length); assert.equal(d.payload, text);
  const consumed = 12 + 8 * d.count, term = Math.min(4, d.dataTotal * 8 - consumed), aligned = Math.ceil((consumed + term) / 8) * 8;
  assert(d.rest.slice(0, aligned - consumed).every((b) => b === 0), 'terminator and bit padding are zero');
  const pads = d.rest.slice(aligned - consumed);
  for (let i = 0; i * 8 < pads.length; i++) assert.equal(parseInt(pads.slice(i * 8, i * 8 + 8).join(''), 2), i % 2 ? 0x11 : 0xec, 'pad codewords');
}

test('QR versions 1–4 are chosen automatically by byte length and the 62-byte limit is enforced', () => {
  assert.equal(QR_MAX_BYTES, 62);
  for (const [length, version] of [[1, 1], [14, 1], [15, 2], [26, 2], [27, 3], [42, 3], [43, 4], [62, 4]]) {
    const text = 'M'.repeat(length), qr = encodeQR(text);
    assert.equal(qr.version, version, `${length} bytes`); assert.equal(qr.ecLevel, 'M');
    assertStructure(qr, text);
  }
  assert.throws(() => encodeQR('M'.repeat(63)), /过长/);
  assert.throws(() => encodeQR('麦'.repeat(21)), /过长/, 'limit counts UTF-8 bytes, not characters');
});

test('every mask pattern round-trips, including two-block interleaving at version 4', () => {
  const text = '板烧鸡腿堡套餐\n¥23.50\n深圳黄贝岭\n10-13 12:00';
  for (let mask = 0; mask < 8; mask++) { const qr = encodeQR(text, { mask }); assert.equal(qr.mask, mask); assertStructure(qr, text); }
  const v4 = '麦'.repeat(20); // 60 bytes → version 4, two blocks
  assertStructure(encodeQR(v4), v4);
});

test('terminal QR rendering packs two module rows per line inside a quiet zone', () => {
  const qr = encodeQR('hello'), plain = renderQR(qr, { quiet: 2 }), coloured = renderQR(qr, { quiet: 2, color: true });
  const n = qr.size + 4;
  assert.equal(plain.length, Math.ceil(n / 2)); assert(plain.every((l) => [...l].length === n && /^[█▀▄ ]+$/.test(l)));
  assert(plain[0].startsWith('█'), 'without colour, the light quiet zone is drawn as blocks');
  assert(coloured.every((l) => l.startsWith('\x1b[30;107m') && l.endsWith('\x1b[0m')));
});
