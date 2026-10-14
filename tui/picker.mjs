// '/' command picker. Typing '/' alone or an unfinished '/partial' lists the matching
// commands with one-line descriptions. On a TTY it is an arrow-key menu (hand-rolled on
// readline keypress events, no dependency); the chosen command is pre-filled at the next
// prompt rather than run, so nothing fires by accident. Without a TTY (piped input, demo,
// tests) the list is printed and the shell carries on — it never waits for keys.
import { padEnd } from './ansi.mjs';
import { COMMAND_HELP } from './render.mjs';

// [{ name, usage, text }] for every command whose name or alias starts with `prefix`.
export function matchCommands(prefix = '') {
  const p = prefix.toLowerCase();
  return COMMAND_HELP.filter(([names]) => names.some((n) => n.startsWith(p)))
    .map(([names, usage, text]) => ({ name: names.find((n) => n.startsWith(p)) || names[0], usage, text }));
}

export function pickerLines(items, P, index = -1) {
  return items.map((c, i) => {
    const row = `${padEnd(c.usage, 28)}${c.text}`;
    return i === index ? `${P.brand('❯')} ${P.bold(row)}` : `  ${i < 0 || index < 0 ? row : P.gray(row)}`;
  });
}

// Arrow-key menu. Resolves to the chosen item, or null on Esc / Ctrl+C / q. Readline's own
// keypress listener is detached while the menu owns the keys and restored afterwards.
export function runPicker({ input, output, items, P, maxRows = 12 }) {
  return new Promise((resolve) => {
    const saved = input.listeners('keypress');
    input.removeAllListeners('keypress');
    let index = 0, drawn = 0;
    const draw = () => {
      if (drawn) output.write(`\x1b[${drawn}A`);
      const top = Math.max(0, Math.min(index - Math.floor(maxRows / 2), items.length - maxRows));
      const lines = [...pickerLines(items.slice(top, top + maxRows), P, index - top),
        P.gray(`↑↓ 选择 · Enter 填入命令 · Esc 取消${items.length > maxRows ? ` · 共 ${items.length} 条` : ''}`)];
      for (const line of lines) output.write(`\r\x1b[2K${line}\n`);
      drawn = lines.length;
    };
    const done = (choice) => {
      input.removeListener('keypress', onKey);
      for (const l of saved) input.on('keypress', l);
      resolve(choice);
    };
    const onKey = (_, key = {}) => {
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) { index = (index - 1 + items.length) % items.length; draw(); }
      else if (key.name === 'down' || key.name === 'tab' || (key.ctrl && key.name === 'n')) { index = (index + 1) % items.length; draw(); }
      else if (key.name === 'return' || key.name === 'enter') done(items[index]);
      else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) done(null);
    };
    input.on('keypress', onKey);
    draw();
  });
}
