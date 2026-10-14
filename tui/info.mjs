// Straight answers to "这个有牛肉吗 / 套餐里有什么 / 有什么料". Pure: no session, no MCP.
// Meat is judged from product names only. Ingredients come only from modification options
// that can be removed (selectedQuantity > 0 and an unselectedKey); that list is not a recipe.
import { money } from './ansi.mjs';
import { MEAT_KINDS, meatsInName } from './intent.mjs';
import { matchMenu } from './menu.mjs';

const norm = (s) => String(s || '').normalize('NFKC').replace(/[\s™®·()（）\n]/g, '');
const MEAT_NOTE = '只按产品名判定，酱料/裹粉/交叉接触看不出来';
const KNOWN = new Set([...MEAT_KINDS.map((k) => k.label), '肉']);

// A group that is exactly one choice among several (ice level: min=max=1) is a preparation
// option, not an ingredient. Removable defaults are values already selected that have an unselectedKey.
function removableExtras(modification) {
  const extras = [];
  for (const group of modification?.items || []) {
    const values = Array.isArray(group?.values) ? group.values : [];
    if (Number(group?.minValues) === 1 && Number(group?.maxValues) === 1 && values.length > 1) continue;
    for (const v of values) if (Number(v?.selectedQuantity) > 0 && v.unselectedKey) extras.push(String(v.name));
  }
  return extras;
}

export function describeDetail(detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const rounds = Array.isArray(d.rounds) ? d.rounds : [];
  return {
    code: String(d.code ?? d.productCode ?? ''),
    name: typeof d.name === 'string' ? d.name : '',
    plain: rounds.length === 0,
    rounds: rounds.map((r) => ({
      name: typeof r?.name === 'string' ? r.name : '',
      quantity: Number(r?.quantity) || 0,
      choices: (Array.isArray(r?.choices) ? r.choices : []).map((c) => ({
        name: typeof c?.name === 'string' ? c.name : '',
        isDefault: Boolean(c?.isDefault),
        quantity: Number(c?.quantity) || 0,
        diffPrice: c?.diffPrice == null ? '' : String(c.diffPrice),
        extras: removableExtras(c?.modification),
      })),
    })),
    extras: removableExtras(d.modification),
  };
}

// Demo has no live query-meal-detail. A package in data/packages.json answers composition;
// a single that only appears as a choice answers with that choice's removable extras.
export function demoDetail(packagesDoc, code, name) {
  const list = Array.isArray(packagesDoc?.packages) ? packagesDoc.packages : Array.isArray(packagesDoc) ? packagesDoc : [];
  const codeStr = String(code ?? ''), wanted = norm(name);
  const pkg = list.find((p) => String(p.productCode) === codeStr || (wanted && norm(p.name) === wanted));
  if (pkg) return { code: String(pkg.productCode), name: pkg.name, rounds: pkg.rounds || [], modification: pkg.modification };
  for (const p of list) for (const r of p.rounds || []) for (const c of r.choices || []) {
    if (String(c.code) === codeStr || (wanted && norm(c.name) === wanted)) return { code: String(c.code), name: c.name, rounds: [], modification: c.modification };
  }
  return null;
}

// Longest menu name that is an exact suffix of the phrase. Null when nothing matches,
// so the caller can fall back to matchMenu (牛肉堡 → beef burgers, not the word 汉堡).
export function resolveInfoItem(items, phrase) {
  const key = norm(phrase);
  let best = null, bestLen = 0;
  for (const m of items || []) {
    const n = norm(m?.name);
    if (!n || !key.endsWith(n) || n.length <= bestLen) continue;
    best = m; bestLen = n.length;
  }
  return best;
}

const selectedChoices = (detail) => (detail?.rounds || []).flatMap((r) => (r.choices || []).filter((c) => c.quantity > 0 || c.isDefault));

export function compositionNames(detail) {
  return [...new Set(selectedChoices(detail).map((c) => c.name).filter(Boolean))];
}

function scanNames(names) {
  const seen = new Set(), rows = [];
  for (const name of names || []) {
    const text = String(name || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    rows.push({ name: text, meats: meatsInName(text) });
  }
  return rows;
}

export function answerMeat({ names = [], meat, confirm = null }) {
  const scanned = scanNames(names);
  return { kind: 'meat', meat, confirm, unknown: !KNOWN.has(meat), scanned,
    hit: meat === '肉' ? scanned.filter((s) => s.meats.length) : scanned.filter((s) => s.meats.includes(meat)) };
}

function diffNote(diffPrice) {
  const s = String(diffPrice ?? '').trim();
  if (!s) return '';
  const n = s.replace(/[^\d.]/g, '');
  if (!n || Number(n) === 0) return '';
  const num = s.match(/(\d+(?:\.\d+)?)/)?.[1] || n;
  return ` +¥${num}`;
}

function roundLine(round) {
  const choices = (round.choices || []).map((c) => `${c.name}${c.isDefault ? '〔默认〕' : ''}${diffNote(c.diffPrice)}`).filter((s) => s && s !== '〔默认〕');
  return `${round.name || '这一轮'}（选 ${round.quantity || 1}）：${choices.join(' / ') || '（没有选项）'}`;
}

function partLines(parts) {
  return (parts || []).map((p) => (typeof p === 'string' ? p : `${p.name}${p.quantity ? ` ×${p.quantity}` : ''}`)).filter(Boolean);
}

export function answerParts({ name = '', parts = [], detail = null, detailError = null, storeName = '' }) {
  // The caller passes the receipt title. The detail name is only a fallback when that is empty.
  const title = name || detail?.name || '';
  if (detail?.plain) return { kind: 'parts', plain: true, name: title, storeName, parts, detail, detailError };
  return { kind: 'parts', plain: false, name: title, storeName, parts, rounds: detail?.rounds || [], detailError };
}

function extraRows(detail) {
  if (!detail) return [];
  const grouped = new Map();
  const add = (where, names) => {
    for (const raw of names) {
      const name = String(raw);
      if (!name) continue;
      const list = grouped.get(where) || [];
      if (!list.includes(name)) list.push(name);
      grouped.set(where, list);
    }
  };
  const loose = [];
  for (const extra of detail.extras || []) {
    // Merged picks annotate each removable name with the item it came from.
    if (extra && typeof extra === 'object' && Array.isArray(extra.names)) add(extra.where ?? detail.name, extra.names);
    else if (extra) loose.push(String(extra));
  }
  if (loose.length) add(detail.name, loose);
  for (const c of selectedChoices(detail)) if (c.extras?.length) add(c.name, c.extras);
  return [...grouped.entries()].map(([where, names]) => ({ where, names }));
}

export function answerIngredients({ name = '', detail = null, parts = [], names = [], sample = false, plainLead = false, detailError = null }) {
  const who = [...new Set([name, detail?.name, ...(names || []), ...compositionNames(detail)].filter(Boolean))];
  return { kind: 'ingredients', name: detail?.name || name, detail, parts, names: who, extras: extraRows(detail), sample, plainLead, detailError };
}

function meatClause(names, { colon = false } = {}) {
  const labels = [...new Set(scanNames(names).flatMap((s) => s.meats))];
  if (!labels.length) return '按产品名没看到牛、鸡、鱼、猪、虾';
  return colon ? `按产品名判定：${labels.join('、')}` : `按产品名判定含${labels.join('、')}`;
}

// Map one allergy record onto a MEAT_KINDS label. Split on 、，, so '鸡蛋、鸡肉' still
// reports 鸡肉. A piece that contains 蛋 is skipped (鸡蛋 must not count as 鸡肉).
// 牛奶 misses /牛(?!奶)/. The warning quotes the original record, not the label.
function allergyLabel(record) {
  const text = String(record ?? '');
  if (!text) return '';
  for (const item of text.split(/[、，,]/)) {
    const piece = item.trim();
    if (!piece || piece.includes('蛋')) continue;
    const hit = MEAT_KINDS.find((k) => k.ask.test(piece));
    if (hit) return hit.label;
  }
  return '';
}

function allergyLine(meat, allergies, P) {
  if (!allergies?.length || !meat) return '';
  const hit = allergies.find((a) => {
    const label = allergyLabel(a);
    return label && (meat === '肉' || label === meat);
  });
  return hit ? P.yellow(`你记录了对${hit}过敏，名称判定只是参考，请以门店确认为准`) : '';
}

function renderMeat(answer, P, allergies) {
  const lines = [];
  if (answer.unknown) lines.push(`本程序只能按名称识别牛/鸡/鱼/猪/虾；名称里没看到"${answer.meat}"。`);
  else if (answer.hit.length) {
    const where = answer.hit.map((s) => s.name).join('、');
    const sentence = `含${answer.meat}（按产品名判定：${where}）`;
    lines.push(answer.confirm === 'not' ? `不对，${sentence}` : sentence);
  } else {
    const tagged = answer.scanned.filter((s) => s.meats.length);
    const mains = tagged.length ? tagged.map((s) => `${s.name}〔${s.meats.join('、')}〕`).join('、') : answer.scanned.map((s) => s.name).join('、');
    const sentence = `按产品名没看到${answer.meat}${mains ? `（主食：${mains}）` : ''}`;
    lines.push(answer.confirm === 'not' ? `对，${sentence}` : sentence);
  }
  const warn = allergyLine(answer.meat, allergies, P);
  if (warn) lines.push(warn);
  lines.push(P.gray(MEAT_NOTE));
  return lines;
}

function renderParts(answer, P, opts) {
  if (answer.plain) {
    const ing = answerIngredients({ name: answer.name, detail: answer.detail, parts: answer.parts, plainLead: true, detailError: answer.detailError });
    return renderIngredients(ing, P, opts);
  }
  const store = opts.storeName || answer.storeName || '';
  const lines = [`${answer.name || '这一餐'}${store ? ` · ${store}` : ''}`];
  if (answer.parts?.length) lines.push(...partLines(answer.parts));
  if (answer.rounds?.length) {
    if (answer.parts?.length) lines.push('可换选项：');
    lines.push(...answer.rounds.map(roundLine));
  }
  if (!answer.parts?.length && !answer.rounds?.length) lines.push('没有查到组成。');
  if (answer.detailError) lines.push(P.gray(`可换选项这次没查到（${answer.detailError}）。上面仍是这一餐里的餐品。`));
  return lines;
}

function renderIngredients(answer, P) {
  const lines = [];
  if (answer.plainLead) lines.push('这是单品，不是套餐。');
  if (answer.sample && !answer.detail) {
    lines.push('样本模式没有餐品详情；连接后再问。');
    lines.push(`能确定的：${meatClause(answer.names)}。`);
    return lines;
  }
  const comp = partLines(answer.parts);
  const fromDetail = compositionNames(answer.detail);
  const composed = comp.length ? comp : fromDetail;
  if (answer.extras.length) {
    const bits = answer.extras.map((r) => `${r.where} · 默认可去掉的料：${r.names.join('、')}（来自特调选项）`);
    lines.push('接口没有给完整配料表，下面不是完整配料表。');
    lines.push(bits.join('；'));
    lines.push(`${meatClause(answer.names, { colon: true })}。`);
  } else {
    lines.push('接口没给单品配料明细。');
    if (composed.length) lines.push(`所在套餐组成：${composed.join('、')}`);
    lines.push(`${meatClause(answer.names)}。`);
  }
  if (answer.detailError) lines.push(`接口出错：餐品详情接口（query-meal-detail）这次出错：${answer.detailError}，不是菜单里没有。`);
  return lines;
}

function renderMissing(answer, P, storeName) {
  const ask = answer.item || '这个';
  const where = storeName ? `这家店（${storeName}）` : '这家店';
  const lines = [P.yellow(`${where}的菜单里没找到「${ask}」。`)];
  const cheapest = matchMenu(answer.items || [], null).slice(0, 5);
  if (cheapest.length) lines.push(`这家店能点的最便宜的（菜单价）：${cheapest.map((m) => `${m.name} ${m.priceFen != null ? money(m.priceFen) : '价格未返回'}`).join('、')}`);
  return lines;
}

export function renderInfoAnswer(answer, P, { storeName = '', allergies = [] } = {}) {
  if (!answer) return [];
  if (answer.kind === 'meat') return renderMeat(answer, P, allergies);
  if (answer.kind === 'parts') return renderParts(answer, P, { storeName, allergies });
  if (answer.kind === 'ingredients') return renderIngredients(answer, P);
  if (answer.kind === 'missing') return renderMissing(answer, P, storeName);
  if (answer.kind === 'error') return [`餐品详情接口（query-meal-detail）这次出错：${answer.error || '未返回'}，不是菜单里没有。`, '这是接口出错，不是菜单里没有这一项。'];
  if (answer.kind === 'no-sample') return ['样本模式没有餐品详情；连接后再问。', `能确定的：${meatClause(answer.names || [answer.name])}。`];
  return [];
}
