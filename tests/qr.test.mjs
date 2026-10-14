import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQR, renderQR, qrWidth, formatBits, versionBits, byteCapacity, QR_MAX_BYTES, utf8 } from '../tui/qr.mjs';
import { cardUrl, decodeCard } from '../tui/card.mjs';

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
// Level M: [data codewords per block], EC codewords per block (ISO/IEC 18004 table 9).
const BLOCKS = { 1: [[16], 10], 2: [[28], 16], 3: [[44], 26], 4: [[32, 32], 18], 5: [[43, 43], 24], 6: [[27, 27, 27, 27], 16],
  7: [[31, 31, 31, 31], 18], 8: [[38, 38, 39, 39], 22], 9: [[36, 36, 36, 37, 37], 22], 10: [[43, 43, 43, 43, 44], 26] };
// Alignment pattern centres (annex E) and the published 18-bit version information (annex D).
const ALIGN_CENTRES = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const VERSION_INFO = { 7: '000111110010010100', 8: '001000010110111100', 9: '001001101010011001', 10: '001010010011010011' };
// Every alignment pattern centre that does not collide with a finder pattern.
const alignCentres = (version) => {
  const c = ALIGN_CENTRES[version], last = c.length - 1;
  return c.flatMap((x, i) => c.map((y, j) => [x, y, i, j])).filter(([, , i, j]) => !((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0))).map(([x, y]) => [x, y]);
};

function functionMap(version) {
  const size = 17 + 4 * version, f = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y][x] = true; };
  mark(0, 0, 9, 9); mark(size - 8, 0, 8, 9); mark(0, size - 8, 9, 8); // finders, separators, format areas, dark module
  mark(6, 0, 1, size); mark(0, 6, size, 1); // timing
  for (const [x, y] of alignCentres(version)) mark(x - 2, y - 2, 5, 5);
  if (version >= 7) { mark(size - 11, 0, 3, 6); mark(0, size - 11, 6, 3); } // version information blocks
  return f;
}
// Version information, most significant bit first, from the bottom-left and top-right copies.
function readVersion(m) {
  const size = m.length, s = (v) => (v ? '1' : '0'), bl = [], tr = [];
  for (let i = 17; i >= 0; i--) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); bl.push(s(m[a][b])); tr.push(s(m[b][a])); }
  return { bl: bl.join(''), tr: tr.join('') };
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
  // Optional ECI segment: mode 0111, then a designator whose leading 0 bit means one byte.
  // The byte-mode character count is 8 bits for versions 1–9 and 16 bits for versions 10–26.
  const countBits = version <= 9 ? 8 : 16;
  let mode = read(4), eci = null, headerBits = 4 + countBits;
  if (mode === 0b0111) {
    assert.equal(stream[0], 0, 'single-byte ECI designator');
    eci = read(8); mode = read(4); headerBits += 12;
  }
  const count = read(countBits), payload = Array.from({ length: count }, () => read(8));
  return { version, mask, fmt, remainderBits: bits.length - total * 8, syndromesZero, eci, headerBits, mode, count, dataTotal, payload: Buffer.from(payload).toString('utf8'), rest: stream };
}
// Reads module colours back from renderQR text (no colour: a block means a light module).
function sampleRender(lines, size, { quiet = 2, square = false, color = false } = {}) {
  const rows = lines.map((l) => [...l.replace(/\x1b\[[0-9;]*m/g, '')]);
  const n = size + quiet * 2, inked = (x, y) => {
    if (square) {
      const pair = rows[y].slice(x * 2, x * 2 + 2).join('');
      assert(pair === '██' || pair === '  ', `module ${x},${y} is two equal columns`);
      return pair === '██';
    }
    const ch = rows[y >> 1][x];
    return y % 2 ? ch === '█' || ch === '▄' : ch === '█' || ch === '▀';
  };
  assert.equal(rows.length, square ? n : Math.ceil(n / 2));
  assert(rows.every((r) => r.length === (square ? n * 2 : n)));
  for (let i = 0; i < n; i++) for (const [x, y] of [[i, 0], [0, i], [i, n - 1], [n - 1, i]]) assert.equal(inked(x, y), !color, 'quiet zone is light');
  return Array.from({ length: size }, (_, my) => Array.from({ length: size }, (_, mx) => inked(mx + quiet, my + quiet) === color));
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
  const centres = alignCentres(qr.version);
  assert.equal(centres.length, qr.version === 1 ? 0 : qr.version < 7 ? 1 : 6, 'alignment pattern count');
  for (const [cx, cy] of centres) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) assert.equal(m[cy + dy][cx + dx], Math.max(Math.abs(dx), Math.abs(dy)) !== 1, `alignment pattern at ${cx},${cy}`);
  }
  // Format info: both copies agree, BCH-valid (in the published table), level M, mask as reported.
  const fmt = readFormat(m);
  assert.equal(fmt.a, fmt.b); assert.equal(fmt.a, FORMAT_M[qr.mask]); assert.equal(fmt.a.slice(0, 2), '10', 'level M bits 00 after XOR 10');
  assert.equal(formatBits(qr.mask).toString(2).padStart(15, '0'), FORMAT_M[qr.mask]);
  // Version info blocks exist from version 7: both copies match the published table.
  if (qr.version >= 7) {
    const v = readVersion(m);
    assert.equal(v.bl, VERSION_INFO[qr.version], 'bottom-left version info'); assert.equal(v.tr, VERSION_INFO[qr.version], 'top-right version info');
    assert.equal(versionBits(qr.version).toString(2).padStart(18, '0'), VERSION_INFO[qr.version]);
  }
  // Full round trip with the independent reader (which takes the version from the size).
  const d = decode(qr);
  assert.equal(d.version, qr.version);
  assert.equal(d.mask, qr.mask); assert.equal(d.remainderBits, qr.version >= 2 && qr.version <= 6 ? 7 : 0, 'remainder bits');
  assert(d.syndromesZero, 'Reed–Solomon syndromes are zero');
  assert.equal(d.eci, 26, 'UTF-8 ECI (assignment 26) precedes the data'); assert.equal(d.mode, 0b0100, 'byte mode');
  assert.equal(d.count, utf8(text).length); assert.equal(d.payload, text);
  const consumed = d.headerBits + 8 * d.count, term = Math.min(4, d.dataTotal * 8 - consumed), aligned = Math.ceil((consumed + term) / 8) * 8;
  assert(d.rest.slice(0, aligned - consumed).every((b) => b === 0), 'terminator and bit padding are zero');
  const pads = d.rest.slice(aligned - consumed);
  for (let i = 0; i * 8 < pads.length; i++) assert.equal(parseInt(pads.slice(i * 8, i * 8 + 8).join(''), 2), i % 2 ? 0x11 : 0xec, 'pad codewords');
}

test('QR versions 1–10 are chosen automatically by byte length (ECI header; 16-bit count from v10) and the 212-byte limit is enforced', () => {
  assert.equal(QR_MAX_BYTES, 212); assert.equal(byteCapacity(4), 61); assert.equal(byteCapacity(9), 179);
  for (const [length, version] of [[1, 1], [13, 1], [14, 2], [25, 2], [26, 3], [41, 3], [42, 4], [61, 4], [62, 5], [83, 5], [84, 6], [105, 6],
    [106, 7], [121, 7], [122, 8], [151, 8], [152, 9], [179, 9], [180, 10], [212, 10]]) {
    const text = 'M'.repeat(length), qr = encodeQR(text);
    assert.equal(qr.version, version, `${length} bytes`); assert.equal(qr.ecLevel, 'M');
    assertStructure(qr, text);
  }
  assert.throws(() => encodeQR('M'.repeat(213)), /过长/);
  assert.throws(() => encodeQR('麦'.repeat(71)), /过长/, 'limit counts UTF-8 bytes, not characters');
});

test('every mask pattern round-trips, including multi-block interleaving at versions 4–10', () => {
  const text = '板烧鸡腿堡套餐\n¥23.50\n深圳黄贝岭\n10-13 12:00';
  for (let mask = 0; mask < 8; mask++) { const qr = encodeQR(text, { mask }); assert.equal(qr.mask, mask); assertStructure(qr, text); }
  // 60 / 81 / 105 / 120 / 150 / 177 / 210 bytes → 2 / 2 / 4 / 4 / 4 / 5 / 5 blocks (v8–v10 mix two block lengths).
  for (const [chars, version] of [[20, 4], [27, 5], [35, 6], [40, 7], [50, 8], [59, 9], [70, 10]]) {
    const t = '麦'.repeat(chars), qr = encodeQR(t);
    assert.equal(qr.version, version); assertStructure(qr, t);
  }
  const v10 = 'x'.repeat(200);
  for (let mask = 0; mask < 8; mask++) assertStructure(encodeQR(v10, { mask }), v10);
});

test('a ~180-byte meal-card URL round-trips through a version 7–10 QR with the UTF-8 ECI prefix', () => {
  const card = cardUrl({ title: '酥脆无双套餐', priceFen: 2050, storeName: '麦当劳深圳怡景餐厅', at: '2026-10-14T01:41:00.000Z',
    parts: [{ name: '麦麦脆汁鸡-琵琶腿', quantity: 1 }, { name: '迷你薯条', quantity: 1 }, { name: '无糖可口可乐中杯', quantity: 1 }] }, { note: '少冰' });
  const url = card.url, bytes = utf8(url).length;
  assert.match(url, /#b64\.[A-Za-z0-9_-]+$/);
  assert(bytes <= 212, `card url is ${bytes} bytes`);
  const back = decodeCard(url.split('#')[1]);
  assert.equal(back.t, '酥脆无双套餐'); assert.equal(back.p, 2050);
  const qr = encodeQR(url);
  assert(qr.version >= 1 && qr.version <= 10, `version ${qr.version}`);
  assertStructure(qr, url);
  const d = decode({ modules: sampleRender(renderQR(qr, { square: true }), qr.size, { square: true }) });
  assert.equal(d.eci, 26); assert.equal(d.payload, url);
});

test('card fragment escaping: ~ , * and \\ inside names and notes round-trip', () => {
  const card = cardUrl({ title: '套餐~A', priceFen: 1990, storeName: '麦当劳测试餐厅', at: '2026-10-14T04:30:00.000Z',
    parts: [{ name: '薯条,大\\*份', quantity: 2 }] }, { note: '少冰~多糖 100%' });
  const back = decodeCard(card.url.split('#')[1]);
  assert.equal(back.t, '套餐~A'); assert.deepEqual(back.items, [{ n: '薯条,大\\*份', q: 2 }]); assert.equal(back.note, '少冰~多糖 100%');
  assert.deepEqual(back, card.data);
});

test('the phone-reported receipt payload carries the UTF-8 ECI prefix and still round-trips', () => {
  const text = '酥脆无双套餐\n¥20.50\n深圳怡景\n10-14 01:41', qr = encodeQR(text, { mask: 1 });
  assert.equal(qr.version, 4);
  assertStructure(qr, text);
  // First data codewords, de-interleaved from block 1: 0111 00011010 0100 <count> …
  const d = decode(qr);
  assert.equal(d.eci, 26); assert.equal(d.headerBits, 24); assert.equal(d.payload, text);
});

test('terminal QR rendering: half blocks pack two module rows per line inside a quiet zone', () => {
  const qr = encodeQR('hello'), plain = renderQR(qr, { quiet: 2 }), coloured = renderQR(qr, { quiet: 2, color: true });
  const n = qr.size + 4;
  assert.equal(plain.length, Math.ceil(n / 2)); assert(plain.every((l) => [...l].length === n && /^[█▀▄ ]+$/.test(l)));
  assert.equal(qrWidth(qr), n);
  assert(plain[0].startsWith('█'), 'without colour, the light quiet zone is drawn as blocks');
  assert(coloured.every((l) => l.startsWith('\x1b[30;107m') && l.endsWith('\x1b[0m')));
});

test('square rendering is two columns × one line per module, and every rendering decodes back to the payload', () => {
  const text = '酥脆无双套餐\n¥20.50\n深圳怡景\n10-14 01:41', qr = encodeQR(text);
  const square = renderQR(qr, { square: true }), n = qr.size + 4;
  assert.equal(square.length, n); assert.equal(qrWidth(qr, { square: true }), n * 2);
  assert(square.every((l) => [...l].length === n * 2 && /^[█ ]+$/.test(l)));
  assert.equal(qrWidth(encodeQR('M'.repeat(61)), { square: true }), 74, 'version 4 is 74 columns wide');
  for (const options of [{ square: true }, { square: true, color: true }, {}, { color: true }]) {
    const modules = sampleRender(renderQR(qr, options), qr.size, options);
    assert.deepEqual(modules, qr.modules, JSON.stringify(options));
    const d = decode({ modules });
    assert(d.syndromesZero); assert.equal(d.eci, 26); assert.equal(d.payload, text, JSON.stringify(options));
  }
  const big = encodeQR('x'.repeat(212));
  assert.equal(big.version, 10); assert.equal(qrWidth(big, { square: true }), 122, 'version 10 is 61 modules incl. quiet zone → 122 columns');
  for (const options of [{ square: true }, {}]) assert.equal(decode({ modules: sampleRender(renderQR(big, options), big.size, options) }).payload, 'x'.repeat(212));
});
