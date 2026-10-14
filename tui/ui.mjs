// Output API shared by both front ends. With a `screen` (the Ink app) every write becomes a log
// entry and progress drives the spinner line; without one (piped input, tests) it writes plain
// lines to `output` and progress is silent. Everything passes through `redact` first.
import { box } from './ansi.mjs';

export function createUI({ output, palette, redact = (t) => t, screen = null }) {
  const P = palette;
  const columns = () => (screen ? screen.columns() : output.columns) || 80;
  const width = () => Math.max(40, Math.min(100, columns() - 1));
  const write = (text = '') => { const line = redact(text); if (screen) screen.push(line); else output.write(`${line}\n`); };
  const setProgress = (p) => screen?.setProgress(p ? { ...p, text: redact(p.text) } : null);
  const indent = (lines) => lines.forEach((l) => write(`   ${l}`));
  return {
    palette, write, width, columns,
    clear() { screen?.clear(); },
    busy(flag) { screen?.setBusy(flag); },
    panel(title, lines, tone) { write(box(title, lines, { width: width(), palette, tone })); },
    result(title, lines, tone = 'brand') { write(''); write(box(title, lines, { width: width(), palette, tone })); },
    error(text) { write(`${P.red('✗')} ${text}`); },
    info(text) { write(`${P.cyan('›')} ${text}`); },
    // A step shown as a spinner while it runs; ok / skip / warn / fail print one line and stop it,
    // done() stops it silently (the caller prints its own answer).
    begin(title) {
      const started = Date.now();
      const elapsed = () => P.gray(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
      setProgress({ title, text: '', started });
      const end = () => setProgress(null);
      return {
        progress(text) { setProgress({ title, text, started }); },
        done: end,
        ok(summary, lines = []) { end(); write(`${P.green('✓')} ${P.bold(title)} ${elapsed()} ${summary}`); indent(lines); },
        skip(summary) { end(); write(`${P.gray('○')} ${P.bold(title)} ${P.gray(summary)}`); },
        warn(summary) { end(); write(`${P.yellow('!')} ${P.bold(title)} ${elapsed()} ${P.yellow(summary)}`); },
        fail(text) { end(); write(`${P.red('✗')} ${P.bold(title)} ${elapsed()} ${P.red(text)}`); },
      };
    },
  };
}
