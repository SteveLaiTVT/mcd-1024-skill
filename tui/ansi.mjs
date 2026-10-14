// Terminal helpers: ANSI colours, CJK-aware widths and boxes. No dependencies.
const ESC = '\x1b[';
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function createPalette(enabled) {
  const wrap = (open, close = 39) => enabled ? (s) => `${ESC}${open}m${s}${ESC}${close}m` : (s) => String(s);
  return {
    enabled, bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31), green: wrap(32), yellow: wrap(33),
    blue: wrap(34), cyan: wrap(36), gray: wrap(90), brand: wrap('38;5;220'), accent: wrap('38;5;196'),
    level: (n, s) => enabled ? `${ESC}38;5;${[238, 223, 221, 214, 202][n]}m${s}${ESC}39m` : String(s),
  };
}

export const stripAnsi = (s) => String(s).replace(ANSI, '');

export function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200b || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

export function textWidth(s) {
  let width = 0;
  for (const ch of stripAnsi(s)) width += charWidth(ch.codePointAt(0));
  return width;
}

// Truncates to a display width while keeping escape sequences intact.
export function fit(s, max) {
  const text = String(s);
  if (textWidth(text) <= max) return text;
  let out = '', width = 0, styled = false;
  for (let i = 0; i < text.length;) {
    const match = text[i] === '\x1b' ? /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(i)) : null;
    if (match) { out += match[0]; styled = true; i += match[0].length; continue; }
    const ch = String.fromCodePoint(text.codePointAt(i)), w = charWidth(ch.codePointAt(0));
    if (width + w > max - 1) break;
    out += ch; width += w; i += ch.length;
  }
  return `${out}…${styled ? `${ESC}0m` : ''}`;
}

// Splits into chunks of at most `max` display columns; colour is closed and reopened across breaks.
export function wrap(s, max) {
  const text = String(s);
  if (textWidth(text) <= max) return [text];
  const lines = []; let out = '', width = 0, open = '';
  for (let i = 0; i < text.length;) {
    const match = text[i] === '\x1b' ? /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(i)) : null;
    if (match) { out += match[0]; open = /^\x1b\[(?:0|22|39)?m$/.test(match[0]) ? '' : open + match[0]; i += match[0].length; continue; }
    const ch = String.fromCodePoint(text.codePointAt(i)), w = charWidth(ch.codePointAt(0));
    if (width + w > max) { lines.push(`${out}${open ? `${ESC}0m` : ''}`); out = `${open}  `; width = 2; }
    out += ch; width += w; i += ch.length;
  }
  lines.push(out);
  return lines;
}

export const padEnd = (s, width) => `${s}${' '.repeat(Math.max(0, width - textWidth(s)))}`;
export const padStart = (s, width) => `${' '.repeat(Math.max(0, width - textWidth(s)))}${s}`;

export function box(title, lines, { width = 78, palette = createPalette(false), tone = 'brand' } = {}) {
  const inner = Math.max(20, width - 4), paint = palette[tone] || palette.brand;
  const label = title ? ` ${fit(title, inner - 2)} ` : '';
  const top = paint(`╭─${label}${'─'.repeat(Math.max(0, inner - textWidth(label)))}─╮`);
  const body = (lines.length ? lines : ['']).flatMap((line) => wrap(line, inner)).map((line) => `${paint('│')} ${padEnd(line, inner)} ${paint('│')}`);
  return [top, ...body, paint(`╰${'─'.repeat(inner + 2)}╯`)].join('\n');
}

export const money = (fen) => Number.isSafeInteger(fen) ? `¥${(fen / 100).toFixed(2)}` : '—';
