// Regression tests for the 2026-10-14 '牛肉汉堡 → 鸡肉' incident and the receipt-QR space:
// (1) a generic meat word ('牛肉汉堡') must map to every main of that meat, not match
// nothing and silently substitute chicken; (2) when no wanted main is in the pool the
// answer must name the wanted main instead of substituting; (3) the card URL must
// contain no literal space (some scanners/browsers truncate at it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalIntent } from '../tui/intent.mjs';
import { applyUpgrades } from '../tui/pricing.mjs';
import { emptyCause, renderEmpty } from '../tui/menu.mjs';
import { createPalette } from '../tui/ansi.mjs';
import { cardUrl, decodeCard } from '../tui/card.mjs';

const P = createPalette(false);
const mainNames = new Map([
  ['B1', '巨无霸'], ['B2', '双层吉士汉堡'], ['B3', '安格斯厚牛堡'],
  ['B4', '大堡口福'], ['B5', '德克萨斯风味三层肉霸堡'],
  ['C1', '麦辣鸡腿汉堡'], ['C2', '板烧鸡腿堡'], ['F1', '麦香鱼'],
]);

test('generic meat words map to every main of that meat; negated meat avoids it', () => {
  const beef = parseLocalIntent('我今天想吃牛肉汉堡，有没有适合的推荐', mainNames).wantMainCodes;
  assert.deepEqual([...beef].sort(), ['B1', 'B2', 'B3', 'B4', 'B5'], '牛肉汉堡 → all beef mains, no chicken (incl. 大堡口福/肉霸, whose names carry no 牛)');
  assert.deepEqual(parseLocalIntent('不要牛肉', mainNames).avoidMainCodes?.sort(), ['B1', 'B2', 'B3', 'B4', 'B5']);
  assert.equal(parseLocalIntent('不要牛肉', mainNames).wantMainCodes, undefined, 'negated meat is never wanted');
  const mixed = parseLocalIntent('不要牛肉，想吃鸡', mainNames);
  assert.deepEqual(mixed.avoidMainCodes?.sort(), ['B1', 'B2', 'B3', 'B4', 'B5']);
  assert.deepEqual(mixed.wantMainCodes?.sort(), ['C1', 'C2']);
  assert.equal(parseLocalIntent('不要牛奶', mainNames).avoidMainCodes, undefined, '牛奶 is milk, not beef');
  assert.deepEqual(parseLocalIntent('我想吃巨无霸', mainNames).wantMainCodes, ['B1'], 'literal product names still match');
  assert.deepEqual(parseLocalIntent('想吃鱼', mainNames).wantMainCodes, ['F1']);
  // Negating one specific product must not avoid the whole meat class.
  assert.deepEqual(parseLocalIntent('不要麦辣鸡腿汉堡', mainNames).avoidMainCodes, ['C1']);
  assert.equal(parseLocalIntent('不要麦辣鸡腿汉堡', mainNames).wantMainCodes, undefined);
});

test('no wanted main in the pool → no silent substitution; the empty card names the wanted main', () => {
  const beef = ['B1', 'B2', 'B3'];
  const report = {
    quotedPlans: [
      { id: 'chicken', kind: 'set', title: '酥脆无双套餐', mainCodes: ['C1'], priceFen: 2050, parts: [] },
      { id: 'beef', kind: 'set', title: '双层吉士汉堡套餐', mainCodes: ['B2'], priceFen: 3200, parts: [] },
    ],
    candidates: [
      { id: 'chicken', kind: 'set', title: '酥脆无双套餐', mainCodes: ['C1'], priceFen: 2050, parts: [] },
    ],
    excludedPlans: [],
    request: { people: 1, budgetPerPersonFen: 2500, wantMainCodes: beef },
  };
  applyUpgrades(report, mainNames);
  assert.deepEqual(report.candidates, [], 'the pool is cleared, not silently substituted with chicken');
  assert(report.wantMissed, 'the miss is recorded');
  const cause = emptyCause(report);
  assert.equal(cause.cause, 'want');
  assert.equal(cause.cheapest.title, '双层吉士汉堡套餐', 'the cheapest wanted plan, even over budget');
  const card = renderEmpty(report, P);
  assert.equal(card.title, '预算内没有你点的');
  assert(card.lines.join('').includes('双层吉士汉堡套餐'), 'the card names the wanted main');
  assert(card.lines.join('').includes('把人均预算提到'), 'over-budget for the wanted main may suggest raising it');
  assert(!card.lines.join('').includes('酥脆无双'), 'the card must not substitute chicken');
});

test('wanted main only as a portion-blocked single → the card says portion, never budget', () => {
  const report = {
    quotedPlans: [
      { id: 'chicken', kind: 'set', title: '酥脆无双套餐', mainCodes: ['C1'], priceFen: 2050, withinBudget: true, fitsPortion: true, parts: [] },
      { id: 'beef-single', kind: 'alacarte', title: '单点 · 双层吉士汉堡', mainCodes: ['B2'], priceFen: 2300, withinBudget: true, fitsPortion: false, parts: [] },
    ],
    candidates: [{ id: 'chicken', kind: 'set', title: '酥脆无双套餐', mainCodes: ['C1'], priceFen: 2050, withinBudget: true, fitsPortion: true, parts: [] }],
    excludedPlans: [], request: { people: 1, portion: 7, budgetPerPersonFen: 2500, wantMainCodes: ['B2'] },
  };
  applyUpgrades(report, mainNames);
  assert.deepEqual(report.candidates, []);
  const cause = emptyCause(report);
  assert.equal(cause.cause, 'want');
  assert.equal(cause.portionBlocked, true, 'the blocker is portion (7 分饱), not budget (¥23 ≤ ¥25)');
  const card = renderEmpty(report, P);
  assert.equal(card.title, '你点的只有单点，不够分饱');
  assert(!card.lines.join('').includes('把人均预算提到'), 'budget is already enough — never suggest raising it');
  assert(card.lines.join('').includes('5分饱'), 'the card says 5 分饱 singles fit');
});
test('wanted main nowhere in the quotes → the card says the store does not have it', () => {
  const report = {
    quotedPlans: [{ id: 'chicken', kind: 'set', title: '酥脆无双套餐', mainCodes: ['C1'], priceFen: 2050, parts: [] }],
    candidates: [{ id: 'chicken', kind: 'set', title: '酥脆无双套餐', mainCodes: ['C1'], priceFen: 2050, parts: [] }],
    excludedPlans: [], wantMissed: { names: '巨无霸、双层吉士汉堡、安格斯厚牛堡', codes: ['B1', 'B2', 'B3'] },
    request: { people: 1, budgetPerPersonFen: 2500, wantMainCodes: ['B1', 'B2', 'B3'] },
  };
  report.candidates = [];
  assert.equal(emptyCause(report).cause, 'want');
  assert.equal(emptyCause(report).cheapest, null);
  assert.equal(renderEmpty(report, P).title, '这家店没有你点的');
});

test('card URL has no literal space; the time round-trips with its space', () => {
  const r = { title: '酥脆无双套餐', priceFen: 2050, storeName: '麦当劳深圳黄贝岭餐厅',
    at: '2026-10-14T11:03:00+08:00', parts: [{ name: '麦麦脆汁鸡-琵琶腿', quantity: 1 }], sample: false };
  const { url } = cardUrl(r);
  assert(!url.includes(' '), 'a literal space is invalid in a URL and truncates some scanners');
  assert(url.includes('%20'), 'the space is percent-encoded');
  const back = decodeCard(url.split('#')[1]);
  assert.equal(back.at, '10-14 11:03', 'the card page decodes the space back');
  assert.equal(back.t, '酥脆无双套餐');
});
