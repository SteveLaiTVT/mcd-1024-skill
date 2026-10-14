// Entry point for both front ends. On a real terminal (stdin and stdout are TTYs) it runs the
// Ink app (ink-app.mjs): output scrolls above, an input box sits at the bottom with a status line,
// and '/' opens the command palette. Otherwise (piped input, --demo automation, tests) it reads
// lines and prints plain output — no raw mode, no waiting for keys, so it never hangs.
import readline from 'node:readline';
import { createPalette } from './ansi.mjs';
import { TuiSession } from './session.mjs';
import { createUI } from './ui.mjs';
import { createShell } from './shell.mjs';

export { createUI };

export async function runTui({ dataset, input = process.stdin, output = process.stdout, env = process.env, demo = false, color, session: provided, autoConnect = true, random, profilePath = null, ordersPath = null, llm = null }) {
  const palette = createPalette(color ?? (Boolean(output.isTTY) && !env.NO_COLOR));
  const session = provided || new TuiSession({ dataset, env, demo, profilePath, ordersPath, llm, ...(random ? { random } : {}) });
  if (input.isTTY && output.isTTY) {
    // Loaded only on a TTY, so piped runs never pull in React.
    const { runInk } = await import('./ink-app.mjs');
    await runInk({ session, input, output, palette, autoConnect });
    return session;
  }
  await runLines({ session, input, output, palette, autoConnect });
  return session;
}

// Piped mode: each input line is echoed after '› ' so the transcript reads like the TTY log.
async function runLines({ session, input, output, palette: P, autoConnect }) {
  const ui = createUI({ output, palette: P, redact: (t) => session.redact(t) });
  const rl = readline.createInterface({ input, terminal: false });
  const queue = []; let waiting = null, closed = false, quitting = false;
  rl.on('line', (line) => { if (waiting) { const w = waiting; waiting = null; w(line); } else queue.push(line); });
  rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(null); } });
  const echo = (prompt, line) => { if (line !== null) ui.write(`${P.brand(prompt)}${line}`); return line; };
  const nextLine = (prompt) => {
    if (queue.length) return Promise.resolve(echo(prompt, queue.shift()));
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => { waiting = (line) => resolve(echo(prompt, line)); });
  };
  const shell = createShell({ session, ui, ask: nextLine, quit: () => { quitting = true; }, autoConnect });
  try {
    await shell.start();
    while (!quitting) {
      const line = await nextLine('› ');
      if (line === null) break;
      await shell.run(line);
    }
  } finally {
    shell.close(); rl.close();
  }
}
