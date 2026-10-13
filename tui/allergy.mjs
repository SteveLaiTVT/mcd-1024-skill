// Allergy memory. Health data: it lives only in this process and in the local
// profile file (~/.config/mcd-tui/profile.json). It is never sent to DeepSeek or
// MCP and never logged; screening happens here, on item names, before any agent sees
// the candidates.
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Visible, deliberately conservative keyword map: allergen → name keywords. A name
// without a keyword is not proof the item is free of that allergen.
export const ALLERGEN_KEYWORDS = Object.freeze({
  花生: ['花生', '花生酱', '花生碎'],
  坚果: ['坚果', '杏仁', '核桃', '腰果', '榛子', '开心果', '花生'],
  虾: ['虾', '虾仁', '虾球', '虾饼'],
  蟹: ['蟹'],
  鱼: ['鱼', '鳕鱼', '鱼柳', '鱼排'],
  奶: ['奶', '牛奶', '奶油', '芝士', '奶酪', '黄油', '吉士', '拿铁', '奶昔', '麦旋风', '圣代', '冰淇淋', '甜筒'],
  蛋: ['蛋', '鸡蛋', '蛋黄酱'],
  小麦: ['面', '包', '堡胚', '堡', '卷', '派', '饼', '吐司', '麦满分', '麦乐鸡', '鸡块', '鸡翅', '鸡排', '鸡柳', '脆汁鸡', 'V翅'],
  大豆: ['大豆', '豆', '酱油'],
  芝麻: ['芝麻'],
});
// What people type → the canonical allergen(s) above.
const ALIASES = { 花生酱: ['花生'], 牛奶: ['奶'], 乳: ['奶'], 乳制品: ['奶'], 奶制品: ['奶'], 乳糖: ['奶'], 芝士: ['奶'], 奶酪: ['奶'],
  鸡蛋: ['蛋'], 蛋类: ['蛋'], 麸质: ['小麦'], 面筋: ['小麦'], 麦麸: ['小麦'], 虾仁: ['虾'], 海鲜: ['虾', '蟹', '鱼'], 鱼类: ['鱼'], 坚果类: ['坚果'], 黄豆: ['大豆'] };
// Leaf names that hide their contents: composition unknown, so excluded once any allergy is recorded.
const OPAQUE = /随心配|任选|随心选|盲盒|神秘|拼盘|小食盘|单品精选|^(?:饮品|甜品|小食|套餐|餐品|商品)$/;
const STOP = new Set(['点', '有点', '一点', '什么', '啥', '东西', '食物', '这个', '那个', '不', '没']);
export const SCREEN_NOTE = '过敏筛选只看餐品名称关键词：名称里没有关键词不代表不含该过敏原（酱料、裹粉、交叉接触都看不到）。请以麦当劳官方过敏原信息和门店确认为准。';

export const keywordsFor = (allergen) => ALLERGEN_KEYWORDS[allergen] || [allergen];
export const isKnownAllergen = (allergen) => Object.hasOwn(ALLERGEN_KEYWORDS, allergen);

// One user token → canonical allergen names; [] when it is not a plausible allergen.
export function normalizeAllergen(token) {
  const raw = String(token || '').normalize('NFKC').trim();
  if (ALIASES[raw]) return ALIASES[raw];
  const t = raw.replace(/类$/, '');
  if (!t || STOP.has(t) || !/^[一-鿿A-Za-z]{1,8}$/.test(t)) return [];
  return ALIASES[t] || [t];
}
export const normalizeAllergens = (tokens) => [...new Set(tokens.flatMap(normalizeAllergen))];

// '我对花生过敏' / '我花生和虾过敏，来份午饭' → { allergens, rest }. Returns null when no allergy is stated.
export function parseAllergyStatement(text) {
  const clauses = String(text || '').normalize('NFKC').split(/[，,。；;！!？?\n]+/).map((c) => c.trim()).filter(Boolean);
  const allergens = [], rest = [];
  let found = false;
  for (const clause of clauses) {
    if (!/过敏/.test(clause)) { rest.push(clause); continue; }
    found = true;
    if (/不过敏|没有?过敏|无过敏|过敏吗/.test(clause)) continue;
    const m = /^(?:我|本人)?(?:对|有)?(.+?)(?:都|也)?过敏/.exec(clause);
    if (m) allergens.push(...normalizeAllergens(m[1].replace(/^(?:我|本人)/, '').replace(/^(?:对|有)/, '').split(/以及|[、和与及跟\s/]+/)));
  }
  return found ? { allergens: [...new Set(allergens)], rest: rest.join('，') } : null;
}

// Text that may go to the DeepSeek intent agent: allergy clauses and recorded allergen names removed.
export function stripAllergyText(text, allergies = []) {
  let out = String(text || '').normalize('NFKC').split(/[，,。；;！!？?\n]+/).map((c) => c.trim()).filter((c) => c && !/过敏|忌口|不耐受/.test(c)).join('，');
  for (const a of allergies) out = out.split(a).join('');
  return out;
}

// Item names one plan exposes: title plus every package and part name.
const namesOf = (plan) => [plan.title, ...(plan.packages || []).map((p) => p.name), ...(plan.parts || []).map((p) => p.name)];

// { ok } | { ok: false, unknown: true } | { ok: false, hits: [{ allergen, keyword, item }] }
export function screenPlan(plan, allergies) {
  if (!allergies.length) return { ok: true };
  const hits = [];
  for (const allergen of allergies) for (const item of namesOf(plan)) {
    const keyword = typeof item === 'string' ? keywordsFor(allergen).find((k) => item.includes(k)) : null;
    if (keyword) { hits.push({ allergen, keyword, item }); break; }
  }
  if (hits.length) return { ok: false, hits };
  const parts = plan.parts || [];
  if (!parts.length || parts.some((p) => typeof p.name !== 'string' || !p.name.trim() || OPAQUE.test(p.name.trim()))) return { ok: false, unknown: true };
  return { ok: true };
}

// Removes allergenic and unknown-composition plans from the report, recording why.
export function applyAllergyFilter(report, allergies) {
  if (!allergies.length) { report.allergy = null; return report; }
  const excluded = [];
  const keep = (plan) => {
    const r = screenPlan(plan, allergies);
    if (!r.ok) excluded.push({ id: plan.id, title: plan.title, ...r });
    return r.ok;
  };
  report.quotedPlans = report.quotedPlans.filter(keep);
  const kept = new Set(report.quotedPlans.map((p) => p.id));
  report.candidates = report.candidates.filter((p) => kept.has(p.id));
  report.excludedPlans = [...report.excludedPlans, ...excluded.map((e) => ({ id: e.id, title: e.title,
    reason: e.unknown ? '成分不明，已排除' : `含过敏原 ${e.hits.map((h) => `${h.allergen}（${h.keyword}）`).join('、')}，已排除` }))];
  report.allergy = { allergies: [...allergies], excluded };
  return report;
}

// Local profile file. Only { schemaVersion, allergies } is stored; nothing else, never credentials.
export const defaultProfilePath = (home = homedir()) => join(home, '.config', 'mcd-tui', 'profile.json');

export function loadProfile(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? { allergies: [], error: null } : { allergies: [], error: '本地过敏记录文件无法读取' }; }
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.allergies) || !data.allergies.every((a) => typeof a === 'string')) throw new Error('shape');
    return { allergies: normalizeAllergens(data.allergies), error: null };
  } catch { return { allergies: [], error: '本地过敏记录文件格式无效' }; }
}

export function saveProfile(file, { allergies }) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, allergies: [...allergies] }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* best effort on filesystems without modes */ }
}
