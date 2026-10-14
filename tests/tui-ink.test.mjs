// The Ink TUI: the '/' palette, the single-answer view, confirmations and exit, rendered with
// ink-testing-library; then the same flows in a REAL pseudo-terminal (tests/pty_palette.py).
// Demo mode only: no network, no MCP, no order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { render } from 'ink-testing-library';
import { inkShell, PLACEHOLDER } from '../tui/ink-app.mjs';
import { runTui } from '../tui/app.mjs';
import { TuiSession } from '../tui/session.mjs';
import { createPalette, stripAnsi } from '../tui/ansi.mjs';
import { COMMAND_HELP } from '../tui/render.mjs';
import { matchCommands, paletteMatches, paletteLines, COMMANDS } from '../tui/palette.mjs';

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [templates, plans, offers, campaigns] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns'].map(json));
const dataset = { templates, plans, offers, campaigns };
const P = createPalette(false);
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount({ session = new TuiSession({ dataset, env: {}, demo: true, random: () => 0.99 }) } = {}) {
  let exited = false;
  // ink-testing-library's stdout is 100 columns wide.
  const app = inkShell({ session, palette: P, color: false, columns: () => 100, rows: () => 40, onExit: () => { exited = true; } });
  const r = render(app.element);
  await app.shell.start();
  const frame = () => stripAnsi(r.lastFrame() ?? '');
  const until = async (pred, what, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred(frame())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; frame:\n${frame()}`);
      await tick(15);
    }
    return frame();
  };
  const has = (...needles) => until((f) => needles.every((n) => f.includes(n)), needles.join(' + '));
  // Each key is its own chunk, as a terminal sends it.
  const press = async (...keys) => { for (const k of keys) { r.stdin.write(k); await tick(); } };
  await has(PLACEHOLDER);
  return { session, app, r, frame, until, has, press, exited: () => exited };
}
const KEYS = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', tab: '\t', backspace: '\x7f', ctrlC: '\x03' };

test('palette data: prefix filters names, Chinese keywords are a fallback, every command has a description and keywords', () => {
  assert.equal(matchCommands('').length, COMMAND_HELP.length);
  assert.deepEqual(matchCommands('ca').map((c) => c.name), ['cart']);
  assert.deepEqual(matchCommands('cou').map((c) => c.name), ['coupons']);
  assert.deepEqual(matchCommands('c').map((c) => c.name), ['connect', 'coupons', 'claim', 'commit', 'cart', 'clear']);
  assert.deepEqual(matchCommands('券').map((c) => c.name), ['coupons', 'claim'], 'keywords when no name matches');
  assert.deepEqual(matchCommands('zzz'), []);
  assert(COMMANDS.every((c) => c.text && c.keywords.length), 'description + keywords for every row');
  assert.deepEqual(COMMANDS.filter((c) => c.needsArgs).map((c) => c.name), ['use', 'set', 'allergy-clear', 'prefs', 'commit']);
  assert.equal(paletteMatches('/ca rm x'), null, 'closed once arguments start');
  assert.equal(paletteMatches('/ca', { dismissed: true }), null);
  assert.equal(paletteMatches('/ca', { asking: true }), null);
  assert.equal(paletteMatches('hello'), null);
  const lines = paletteLines(matchCommands(''), P, { selected: 0, rows: 5, width: 120 });
  assert.equal(lines.length, 6); assert.match(lines[0], /^❯ \/connect/); assert.match(lines.at(-1), /↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭 · 共 \d+ 条/);
});

test("Ink: typing '/' opens the palette at once; the prefix narrows it; ↑↓ move; Esc dismisses; Enter runs; Tab completes", async () => {
  const t = await mount();
  try {
    await t.press('/');
    await t.has('/connect', '用环境变量 MCD_TOKEN 连接麦当劳 MCP', '连接 登录 令牌', '/coupons', '先列可领券', '↑↓ 选择');
    await t.press('c', 'a');
    let f = await t.has('/cart [rm <hash>|clear]', '查看购物车', '购物车 清单');
    assert(!f.includes('先列可领券') && !f.includes('/connect'), "'/ca' is exactly /cart");
    await t.press(KEYS.esc);
    f = await t.until((x) => !x.includes('查看购物车'), 'Esc to dismiss');
    assert(f.includes('› /ca'), 'Esc keeps the typed text');
    await t.press(KEYS.backspace, KEYS.backspace, KEYS.backspace);
    await t.has(PLACEHOLDER);

    // '/c': ↓ ↓ ↑ ↓ lands on the third row (/claim); Tab completes it into the input.
    await t.press('/', 'c', KEYS.down, KEYS.down, KEYS.up, KEYS.down);
    await t.until((x) => /❯ \/claim/.test(x), 'selection on /claim');
    await t.press(KEYS.tab);
    await t.until((x) => x.includes('› /claim ') && !x.includes('↑↓ 选择'), 'Tab completion closes the palette');
    await t.press('\x15'); // Ctrl+U

    // Enter on '/he' runs /help, which lists every command.
    await t.press('/', 'h', 'e', KEYS.enter);
    f = await t.has('显示这份命令表');
    for (const [, usage] of COMMAND_HELP) assert(f.includes(usage), usage);
    // A command that needs an argument is filled in, not run.
    await t.press('/', 's', 'e', KEYS.enter);
    await t.until((x) => x.includes('› /set '), '/set filled in');
  } finally { t.r.unmount(); }
});

test('Ink: a question shows a spinner with the current step while running, then ONE answer; the process stays behind /why', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true, random: () => 0.99 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const quote = session.quote.bind(session);
  session.quote = async (...args) => { await gate; return quote(...args); };
  const t = await mount({ session });
  try {
    await t.press(...'1人 7分饱 人均30', KEYS.enter);
    let f = await t.has('为你挑选这一餐', '5/6 查券与官方整单核价', 'Ctrl+C 取消');
    assert(!f.includes('这一餐就吃'), 'no answer while it is still running');
    for (const noise of ['1/6 理解需求 本地规则', '最近吃了啥 / 喝了啥', '按用券后的实际价格从低到高排']) assert(!f.includes(noise), `no step log while running: ${noise}`);
    release();
    f = await t.has('这一餐就吃', '理由：', '门店：', '/why 看挑选过程');
    assert(!f.includes('为你挑选这一餐'), 'the spinner is gone');
    for (const noise of ['推荐 Agent →', '优化 Agent →', '也可以考虑', '最近吃了啥 / 喝了啥', '按用券后的实际价格从低到高排']) assert(!f.includes(noise), `answer view has no process noise: ${noise}`);
    await t.press(...'/why', KEYS.enter);
    await t.has('挑选过程 · 1人 7分饱 人均30', '1/6 理解需求', '4/6 读历史', '5/6 查券与官方整单核价', '6/6 饭搭子双 Agent 挑选', '最近吃了啥 / 喝了啥');
  } finally { t.r.unmount(); }
});

test('Ink: a confirmation question takes over the input box; /cart clear needs a typed yes; Ctrl+C on an empty idle box exits', async () => {
  const t = await mount();
  try {
    await t.press(...'1人 7分饱 人均30', KEYS.enter);
    await t.has('这一餐就吃');
    await t.press('/', 'c', 'o', 'm', KEYS.enter);
    await t.until((x) => x.includes('› /commit '), '/commit filled in');
    await t.press(KEYS.enter);
    await t.has('[main ');
    await t.press(...'/push', KEYS.enter);
    await t.has('已加入购物车 1 单');
    await t.press(...'/cart clear', KEYS.enter);
    let f = await t.has('确认清空？', '在这里回答');
    assert(!f.includes('↑↓ 选择'));
    await t.press(...'yes', KEYS.enter);
    f = await t.has('已清空购物车（1 单回到未 push）');
    assert(f.includes('确认清空？> yes'), 'the answer is echoed into the log');
    assert.equal(t.exited(), false);
    await t.press(KEYS.ctrlC);
    await t.until(() => t.exited(), 'exit on Ctrl+C');
  } finally { t.r.unmount(); }
});

test('Ink: /quit from the palette exits; demo buy intent is refused without an order', async () => {
  const t = await mount();
  try {
    await t.press(...'1人 7分饱 人均30', KEYS.enter);
    await t.has('这一餐就吃');
    await t.press(...'就吃这个了', KEYS.enter);
    await t.has('演示模式不下真实订单', '没有调用 create-order');
    await t.press('/', 'q', 'u', KEYS.enter);
    await t.until(() => t.exited(), 'exit on /quit');
  } finally { t.r.unmount(); }
});

test('no TTY on either side → plain line mode: finishes without raw mode or hanging', async () => {
  const sink = (tty) => { const chunks = []; return { isTTY: tty, columns: 100, write(s) { chunks.push(s); return true; }, text: () => stripAnsi(chunks.join('')) }; };
  for (const [inTTY, outTTY] of [[false, false], [false, true], [true, false]]) {
    const input = new PassThrough(), out = sink(outTTY);
    input.isTTY = inTTY;
    input.end('/\n1人 7分饱 人均30\n/quit\n');
    await runTui({ dataset, input, output: out, env: {}, demo: true, color: false, random: () => 0.99 });
    const text = out.text();
    for (const s of ['全部命令：', '/cart [rm <hash>|clear]', '这一餐就吃', '再见']) assert(text.includes(s), `${inTTY}/${outTTY}: ${s}`);
  }
});

// The proof that matters for a real terminal: the same keys through a pseudo-terminal.
const script = fileURLToPath(new URL('./pty_palette.py', import.meta.url));
const python = spawnSync('python3', ['--version']);
test("real PTY: '/' palette, filtering, arrows, Esc, Backspace, Enter, one-answer view and /quit in a pseudo-terminal",
  { skip: process.platform === 'win32' ? 'no POSIX pty on Windows' : python.error ? 'python3 not found' : false, timeout: 150000 }, (t) => {
    const r = spawnSync('python3', ['-I', script, process.execPath], { encoding: 'utf8', timeout: 140000 });
    if (r.status === 77) return t.skip(r.stdout.trim());
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /ok - '\/' opens the palette immediately/);
    assert.match(r.stdout, /PASS: \d+ checks in a real PTY/);
  });
