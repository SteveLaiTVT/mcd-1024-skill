// The terminal UI on a real TTY, built with Ink (React for the terminal), laid out like Codex's TUI:
//
//   … output log (Ink <Static>: written once, scrolls in the terminal's own scrollback) …
//   ⠹ 为你挑选这一餐 · 5/6 查券与官方整单核价   3.2s       ← only while something runs
//   ╭──────────────────────────────────────────────╮
//   │ › 1人 人均30█                                  │    ← input box
//   ╰──────────────────────────────────────────────╯
//     ❯ /cart [rm <hash>|clear]  查看购物车…  · 购物车 清单   ← '/' palette, only while typing '/…'
//   样本模式 · 门店 · 1人 人均¥25 · 未核价 · 本地偏好    ← status line
//
// Keys are read by Ink's useInput in raw mode, so '/' opens the palette on the keystroke itself.
// Command logic lives in shell.mjs; this file only owns the screen and the keys.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { render, Box, Text, Static, useInput } from 'ink';
import { createUI } from './ui.mjs';
import { createShell, FAREWELL } from './shell.mjs';
import { paletteMatches, paletteLines } from './palette.mjs';
import { statusLine } from './render.mjs';

const h = React.createElement;
export const SPINNER = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'];
export const PLACEHOLDER = '说一句话，比如“1人 人均30”；输入 / 打开命令面板';
export const STATUS_KEYS = '  · / 命令 · /why 过程 · Ctrl+C 退出';
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

// External store between the shell (plain async code) and React: the output log, the running
// step, a pending confirmation question and the busy flag.
export function createScreen({ columns = () => 80, rows = () => 24, onClear = () => {} } = {}) {
  let state = { entries: [], progress: null, ask: null, busy: false, epoch: 0 }, seq = 0;
  const listeners = new Set();
  const set = (patch) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
  return {
    columns, rows,
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    push(text) { set({ entries: [...state.entries, { id: ++seq, text }] }); },
    setProgress(progress) { set({ progress }); },
    setBusy(busy) { set({ busy }); },
    ask(prompt) { return new Promise((resolve) => set({ ask: { prompt, resolve } })); },
    answer(text) { const pending = state.ask; if (!pending) return; set({ ask: null }); pending.resolve(text); },
    // A new <Static> key drops what was printed; the terminal itself is cleared by onClear.
    clear() { onClear(); set({ entries: [], epoch: state.epoch + 1 }); },
  };
}

function Progress({ progress, color }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => { const timer = setInterval(() => setFrame((n) => n + 1), 100); return () => clearInterval(timer); }, []);
  const seconds = ((Date.now() - progress.started) / 1000).toFixed(1);
  return h(Box, { paddingX: 1 }, h(Text, { wrap: 'truncate-end' },
    h(Text, { color: color ? 'cyan' : undefined }, SPINNER[frame % SPINNER.length]), ' ',
    h(Text, { bold: true }, progress.title), progress.text ? ` · ${progress.text}` : '',
    h(Text, { dimColor: true }, `   ${seconds}s · Ctrl+C 取消`)));
}

export function App({ screen, palette: P, color, status, onSubmit, onInterrupt, onQuit }) {
  const state = useSyncExternalStore(screen.subscribe, screen.get);
  // Editing state lives in a ref so several keys arriving before a re-render never see stale input.
  const edit = useRef({ input: '', selected: 0, dismissed: false, history: [], back: -1 });
  const [, repaint] = useState(0);
  const set = (patch) => { Object.assign(edit.current, patch); repaint((n) => n + 1); };
  const type = (input) => set({ input, selected: 0, dismissed: false, back: -1 });
  const matchesNow = () => paletteMatches(edit.current.input, { dismissed: edit.current.dismissed, asking: Boolean(screen.get().ask) });

  const submit = (line) => {
    const s = screen.get();
    if (s.ask) { type(''); return screen.answer(line); }
    if (s.busy) return; // one request at a time; the text stays in the box
    type('');
    if (line.trim()) set({ history: [...edit.current.history, line].slice(-100) });
    onSubmit(line);
  };

  useInput((ch, key) => {
    const e = edit.current, s = screen.get();
    if (key.ctrl && ch === 'c') {
      if (s.ask) return screen.answer(null);
      if (onInterrupt()) return;
      if (e.input) return type('');
      return onQuit();
    }
    if (key.ctrl && ch === 'd') { if (!e.input && !s.busy && !s.ask) onQuit(); return; }
    if (key.ctrl && ch === 'u') return type('');
    const matches = matchesNow();
    if (matches?.length) {
      const n = matches.length;
      if (key.upArrow) return set({ selected: (e.selected - 1 + n) % n });
      if (key.downArrow) return set({ selected: (e.selected + 1) % n });
      if (key.tab) return type(`/${matches[e.selected].name} `);
      // Enter runs the highlighted command; one that needs an argument is filled in instead.
      if (key.return) { const c = matches[e.selected]; return c.needsArgs ? type(`/${c.name} `) : submit(`/${c.name}`); }
    }
    if (key.escape) { if (matches) set({ dismissed: true }); else if (e.input) type(''); return; }
    if (key.return) return submit(e.input);
    // macOS Terminal / iTerm send DEL (0x7f) for Backspace, which Ink reports as `delete`.
    if (key.backspace || key.delete) return type([...e.input].slice(0, -1).join(''));
    if (key.upArrow && !s.ask && e.history.length) {
      const back = e.back < 0 ? e.history.length - 1 : Math.max(0, e.back - 1);
      return set({ input: e.history[back], back, dismissed: true });
    }
    if (key.downArrow && e.back >= 0) {
      const back = e.back + 1;
      return back >= e.history.length ? type('') : set({ input: e.history[back], back, dismissed: true });
    }
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown) return;
    const text = ch.replace(/\r\n?|\n/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
    if (text) type(e.input + text);
  });

  const e = edit.current, matches = matchesNow();
  const width = Math.max(30, screen.columns() - 1), rows = Math.max(4, Math.min(12, screen.rows() - 12));
  const cursor = h(Text, { inverse: true }, ' ');
  return h(Box, { flexDirection: 'column' },
    h(Static, { key: state.epoch, items: state.entries }, (entry) => h(Text, { key: entry.id }, entry.text || ' ')),
    state.progress ? h(Progress, { progress: state.progress, color }) : null,
    state.ask ? h(Box, { paddingX: 1 }, h(Text, { wrap: 'truncate-end' }, P.yellow(P.bold(state.ask.prompt.replace(/>\s*$/, '').trim())), P.gray('  回答后按 Enter · Ctrl+C 取消'))) : null,
    h(Box, { borderStyle: 'round', borderColor: color ? (state.ask ? 'yellow' : 'gray') : undefined, paddingX: 1, width },
      h(Text, { wrap: 'wrap' }, P.brand('› '), ...(e.input ? [e.input, cursor] : [cursor, P.gray(state.ask ? '在这里回答' : PLACEHOLDER)]))),
    matches ? h(Box, { flexDirection: 'column', paddingX: 1 },
      paletteLines(matches, P, { selected: e.selected, rows, width: width - 2 }).map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, line))) : null,
    h(Box, { paddingX: 1 }, h(Text, { wrap: 'truncate-end' }, status(), P.gray(STATUS_KEYS))));
}

// Wires a session to the App. Returns the element (for ink.render or ink-testing-library),
// the shell and the screen store.
export function inkShell({ session, palette, color = palette.enabled, autoConnect = true, columns = () => 80, rows = () => 24, onClear = () => {}, onExit = () => {} }) {
  const screen = createScreen({ columns, rows, onClear });
  const ui = createUI({ palette, redact: (t) => session.redact(t), screen });
  let exited = false;
  const exit = () => { if (!exited) { exited = true; onExit(); } };
  // Confirmation questions take over the input box; the answer is echoed into the log.
  const ask = async (prompt) => {
    const reply = await screen.ask(prompt);
    ui.write(`${palette.brand(prompt)}${reply ?? palette.gray('（已取消）')}`);
    return reply;
  };
  const shell = createShell({ session, ui, ask, quit: exit, autoConnect });
  const onSubmit = (line) => { if (line.trim()) ui.write(`${palette.brand('› ')}${line}`); return shell.run(line); };
  const element = h(App, { screen, palette, color, status: () => statusLine(session, palette), onSubmit, onInterrupt: () => shell.interrupt(), onQuit: exit });
  return { element, shell, screen, ui };
}

export async function runInk({ session, input, output, palette, autoConnect = true }) {
  output.write(CLEAR_SCREEN);
  let instance = null;
  const app = inkShell({ session, palette, autoConnect, columns: () => output.columns || 80, rows: () => output.rows || 24,
    onClear: () => { instance?.clear(); output.write(CLEAR_SCREEN); }, onExit: () => instance?.unmount() });
  instance = render(app.element, { stdin: input, stdout: output, exitOnCtrlC: false, patchConsole: false });
  try {
    await app.shell.start();
    await instance.waitUntilExit();
  } finally {
    app.shell.close({ farewell: false });
    output.write(`${palette.gray(FAREWELL)}\n`);
  }
}
