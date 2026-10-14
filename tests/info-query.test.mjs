// Info answers come from the prefetched cache, not from intent regexes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { meatsInName } from '../core/menu.mjs';
import { describeDetail, demoDetail, answerIngredients, renderInfoAnswer } from '../tui/info.mjs';
import { TuiSession } from '../tui/session.mjs';
import { createUI } from '../tui/app.mjs';
import { createShell } from '../tui/shell.mjs';
import { createPalette, stripAnsi } from '../tui/ansi.mjs';
import { helpLines } from '../tui/render.mjs';
import { QR_LABEL } from '../tui/receipt.mjs';
import { createFakeLlm } from './fake-llm.mjs';

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [templates, plans, offers, campaigns, packages, menu] = await Promise.all(['plan-recipes', 'meal-plans', 'coupon-offers', 'campaigns', 'packages', 'menu'].map(json));
const dataset = { templates, plans, offers, campaigns, menu, packages };
const P = createPalette(false);

function sink() {
  const chunks = [];
  return { columns: 100, isTTY: false, write(s) { chunks.push(s); return true; }, text: () => stripAnsi(chunks.join('')) };
}

async function ask(session, line, replies = []) {
  const out = sink();
  const ui = createUI({ output: out, palette: P, redact: (t) => session.redact(t) });
  const shell = createShell({ session, ui, ask: async () => replies.shift() ?? null, autoConnect: false });
  await shell.run(line);
  return out.text();
}

test('meatsInName keeps the known 吉士 false positive', () => {
  assert.deepEqual(meatsInName('巨无霸'), ['牛肉']);
  assert.deepEqual(meatsInName('麦辣鸡腿汉堡'), ['鸡肉']);
  assert.deepEqual(meatsInName('吉士猪柳蛋麦满分'), ['牛肉', '猪肉']);
});

test('describeDetail reads rounds and removable extras, and skips mutex prep options', () => {
  const pkg = packages.packages[0];
  const detail = describeDetail(pkg);
  assert.equal(detail.plain, false);
  assert.ok(detail.rounds.length >= 1);
  const single = describeDetail(demoDetail(packages, '1440', '麦辣鸡腿汉堡'));
  assert.equal(single.plain, true);
  const card = renderInfoAnswer(answerIngredients({ name: '麦辣鸡腿汉堡', detail: single }), P).join('\n');
  assert.match(card, /不是完整配料表/);
  assert.match(card, /麦香鸡酱/);
  const bare = renderInfoAnswer(answerIngredients({ name: '巨无霸', detail: describeDetail({ code: 'x', name: '巨无霸', rounds: [] }) }), P).join('\n');
  assert.match(bare, /接口没给单品配料明细/);
  assert.match(bare, /按产品名判定含牛肉/);
});

test('help still mentions an info example and has no info slash command', () => {
  const help = helpLines(P).join('\n');
  assert.match(help, /这个有牛肉吗/);
  assert.doesNotMatch(help, /\/info\b|\/checkout|\/buddy|\/weather/);
});

test('after a pick, info questions read the cache and do not reprint a card or drop a receipt', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true, llm: createFakeLlm(), random: () => 0.99 });
  const picked = await ask(session, '人均30');
  assert.match(picked, /编号推荐/);
  const beef = await ask(session, '这个有牛肉吗');
  assert.match(beef, /牛肉/);
  assert.match(beef, /按产品名/);
  assert.doesNotMatch(beef, /编号推荐/);
  assert(!beef.includes(QR_LABEL));
  const parts = await ask(session, '这个套餐里有什么');
  assert.match(parts, /麦香鸡/);
  assert.doesNotMatch(parts, /编号推荐/);
  const ing = await ask(session, '这个有什么料');
  assert.match(ing, /不是完整配料表/);
  assert(!ing.includes(QR_LABEL));
});

test('a cache miss says so, and a complete:false cache is never called a full ingredient list', async () => {
  const session = new TuiSession({ dataset, env: {}, demo: true, llm: createFakeLlm() });
  const miss = await ask(session, '有什么料');
  assert.match(miss, /没查到/);
  session.recordPick({ id: 'p', title: '麦香鸡', priceFen: 1390, parts: [{ name: '麦香鸡', quantity: 1 }], savingFen: 0, couponNames: [] });
  session.detailCache = { p: { code: 'p', name: '麦香鸡', parts: [{ name: '麦香鸡' }], removable: [], complete: false, unknown: true } };
  const text = await ask(session, '有什么料');
  assert.match(text, /不是完整配料表/);
  assert.match(text, /配料未知/);
});
