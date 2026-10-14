// '/' command palette, Codex-style: typing '/' in the input box opens it at once; the typed prefix
// filters it; each row shows the command, its description and its keywords. Pure functions only —
// the Ink app (ink-app.mjs) owns the keys, piped mode just prints the list.
import { padEnd, fit } from './ansi.mjs';
import { COMMAND_HELP } from './render.mjs';

// Usage with a required argument ('/use 序号', '/set 人数 …'): Enter fills the input instead of running it.
const needsArgs = (usage) => /^\/\S+\s+[^[·\s]/.test(usage);
export const COMMANDS = COMMAND_HELP.map(([names, usage, text, keywords = []]) => ({ name: names[0], aliases: names.slice(1), usage, text, keywords, needsArgs: needsArgs(usage) }));

// Commands whose name or alias starts with `query`; when none does, commands whose keywords contain it
// ('/券' → /coupons /claim). An empty query lists everything.
export function matchCommands(query = '') {
  const q = query.trim().toLowerCase();
  if (!q) return [...COMMANDS];
  const byName = COMMANDS.filter((c) => [c.name, ...c.aliases].some((n) => n.startsWith(q)))
    .map((c) => ({ ...c, name: [c.name, ...c.aliases].find((n) => n.startsWith(q)) }));
  return byName.length ? byName : COMMANDS.filter((c) => c.keywords.some((k) => k.includes(q)));
}

// The palette is open while the input is a bare '/word' (no space yet), unless Esc dismissed it
// or a confirmation question owns the input.
export function paletteMatches(input, { dismissed = false, asking = false } = {}) {
  if (asking || dismissed || !/^\/\S*$/.test(input)) return null;
  return matchCommands(input.slice(1));
}

export const PALETTE_KEYS = '↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭';

// Rows for the palette. `selected` < 0 renders a plain list (piped mode); otherwise a window of
// `rows` rows scrolls to keep the selection visible, with a footer saying how many there are.
export function paletteLines(matches, P, { selected = -1, rows = matches.length, width = 100 } = {}) {
  if (!matches.length) return [P.gray('没有匹配的命令 · Esc 关闭 · /help 查看全部')];
  const top = selected < 0 ? 0 : Math.min(Math.max(0, selected - Math.floor(rows / 2)), Math.max(0, matches.length - rows));
  const lines = matches.slice(top, top + rows).map((c, i) => {
    const on = top + i === selected;
    const row = `${padEnd(on ? P.bold(P.cyan(c.usage)) : P.cyan(c.usage), 28)} ${on ? P.bold(c.text) : c.text}${c.keywords.length ? P.gray(`  · ${c.keywords.join(' ')}`) : ''}`;
    return fit(`${on ? P.brand('❯') : ' '} ${row}`, width);
  });
  if (selected >= 0) lines.push(P.gray(`${PALETTE_KEYS}${matches.length > rows ? ` · 共 ${matches.length} 条` : ''}`));
  return lines;
}
