// Pure renderers: data in, terminal lines out. No I/O here.
import { historyCalendar } from '../web/order-history.mjs';
import { storeStatus } from '../web/store-search.mjs';
import { SIGNAL_LABELS, PERSONAS } from '../web/agent-prompts.mjs';
import { money, padEnd, textWidth } from './ansi.mjs';
import { DEFAULT_INTENT, DEFAULT_STORE_SEARCH } from './intent.mjs';
import { SCREEN_NOTE, keywordsFor, isKnownAllergen } from './allergy.mjs';
import { upgradeText } from './pricing.mjs';
import { NO_REGISTER_NOTE } from './activity.mjs';

export const NOTICE = '参赛者独立开发，非麦当劳官方产品；餐品、价格与供应以麦当劳官方结果为准。';
const MOOD_LABELS = { normal: '日常', comfort: '有点累，想被照顾', surprise: '想要惊喜', gathering: '一起吃，热闹一点' };
const GOAL_LABELS = { balanced: '均衡', cheapest: '省钱', variety: '换口味' };
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const partsText = (plan) => (plan.parts || []).map((p) => `${p.name}×${p.quantity}`).join('、');
const LABELS = { ...SIGNAL_LABELS, coupon: '用上手里的券' };
const signalText = (signals) => signals.map((s) => LABELS[s] || s).join(' · ');
const left = (hours) => hours < 24 ? `还剩约 ${hours} 小时` : `还剩约 ${Math.floor(hours / 24)} 天`;
const couponNote = (name, coupons = []) => {
  const c = coupons.find((x) => x.name === name);
  return c ? `${name}（${c.expires} 到期${c.soon ? '，快过期' : ''}）` : name;
};

// Claimable (not yet claimed) coupons: name, what it saves and until when — only as far as the API says.
export function renderClaimable(claimable = [], P, { sample = false, limit = 8 } = {}) {
  if (!claimable.length) return [P.gray(`可领券：${sample ? '样本里没有' : '当前没有'}可领取的券。`)];
  const lines = [P.bold(`可领券 ${claimable.length} 张`) + P.gray(`（${sample ? '2026-10-10 样本，' : ''}未领取，不计入价格）`)];
  for (const c of claimable.slice(0, limit)) {
    const saving = c.price ? `活动标价 ${c.price}（仅展示，不当折扣）` : '领取前接口不返回，领取后由官方核价确定';
    lines.push(`· ${P.cyan(c.name)} · 可省：${saving} · 有效期：${c.expires || '接口未返回'}`);
  }
  if (claimable.length > limit) lines.push(P.gray(`……另有 ${claimable.length - limit} 张`));
  lines.push(P.gray(sample ? '样本模式不能领券。' : '领取：/claim，然后输入 yes 明确确认（官方一次领取全部可领券，不能单选）。不会自动领取。'));
  return lines;
}

// Coupon picture from the step-5 coupon check: claimable first, then used in pricing, expiring soon, not counted.
export function renderCoupons(picture, P, { demo = false } = {}) {
  if (demo) return [...renderClaimable(picture.claimable, P, { sample: true, limit: 4 }), P.gray('券：样本模式不读取券包，样本价没有用券。')];
  if (!picture.live) return [P.gray('券：本次没有拿到券包结果。')];
  const lines = [...renderClaimable(picture.claimable, P, { limit: 4 }),
    P.bold('手里的券') + P.gray(`（持有 ${picture.heldCount} 张 · 本店可用于核价 ${picture.usable.length} 张${picture.claimableCount ? ` · 可领未领 ${picture.claimableCount} 张，未领取，不计入价格` : ''}）`)];
  lines.push(picture.used.length
    ? `核价用上的券：${picture.used.map((u) => `${u.name}${u.savingFen > 0 ? `（最多省 ${money(u.savingFen)}，${u.plans} 份候选用到）` : ''}`).join('；')}`
    : P.gray(picture.usable.length ? '核价没有用上券：本店可用券不适用这些套餐，或用券后不比原价便宜。' : '没有本店可用于核价的持有券。'));
  for (const c of picture.soon.slice(0, 5)) lines.push(P.yellow(`⏰ 快过期：${c.name} · ${c.expires} 到期（${left(c.hoursLeft)}）${c.used ? ' · 已用于核价' : ''}`));
  const later = picture.usable.filter((c) => !c.soon);
  if (later.length) lines.push(P.gray(`其他可用券：${later.slice(0, 4).map((c) => `${c.name} ${c.expires} 到期`).join('；')}${later.length > 4 ? ` 等 ${later.length} 张` : ''}`));
  if (picture.unavailableCount) lines.push(P.gray(`另有 ${picture.unavailableCount} 张持有券本店不可用，接口未返回本店有效期。`));
  return lines;
}

// One-line status (mode · store · budget · quote · agent), like the model line under Codex's input box.
export function statusLine(session, P) {
  const s = session, r = s.request, remaining = s.remainingSeconds();
  const mcp = s.demo ? P.yellow('样本模式') : s.connected ? P.green('MCP 已连接') : s.hasMcdToken ? P.yellow('MCP 未连接') : P.red('缺 MCD_TOKEN');
  const quote = !s.report ? '未核价' : s.report.sourceKind === 'demo-snapshot' ? '历史样本价' : s.fresh() ? `报价剩 ${clock(remaining)}` : P.red('报价已失效');
  const avoid = r.avoidMainCodes.length ? ` · 避开 ${r.avoidMainCodes.length} 种主食` : '';
  return `${mcp}${P.gray(` · ${s.store ? s.store.storeName : `未选门店（默认搜 ${DEFAULT_STORE_SEARCH.keyword}）`} · ${r.people}人 人均${money(r.budgetPerPersonFen)}${avoid} · ${quote} · ${s.hasDeepSeek ? 'DeepSeek 就绪' : '本地偏好推荐'}`)}`;
}

// The single line of "why" an answer carries: the assistant's one-liner, else the reason signals.
export function pickReason(plan) {
  if (plan.thought) return plan.thought;
  const signals = plan.signals || [], usesCoupon = plan.couponNames?.length > 0;
  const reasons = usesCoupon && !signals.includes('coupon') ? ['coupon', ...signals] : signals;
  if (reasons.length) return `${signalText(reasons)}${usesCoupon && plan.savingFen > 0 ? `（省了 ${money(plan.savingFen)}）` : ''}`;
  return plan.upgrade ? upgradeText(plan.upgrade) : '预算内用券后最便宜的一份';
}

// The one answer a question ends with: the pick, its price, the store and one line of reason.
// How the agents got there lives in /why, never here.
export function renderAnswer(plan, P, { storeName = '', report = null, remaining = null, reason = '', notes = [] } = {}) {
  const people = report?.request?.people || 1;
  const coupon = plan.couponNames?.length ? P.cyan(` · 已用券 ${plan.couponNames.join('、')}${plan.savingFen > 0 ? `，省 ${money(plan.savingFen)}` : ''}`) : '';
  const lines = [`${P.brand(P.bold(plan.title))}  ${P.bold(money(plan.priceFen))}${people > 1 ? P.gray(`（人均约 ${money(Math.ceil(plan.priceFen / people))}）`) : ''}${coupon}`,
    `门店：${storeName || '未选门店'} · 到店自取`, `理由：${reason || pickReason(plan)}`];
  if (notes.length) lines.push(P.gray(`注：${notes.join('；')}`));
  if (report?.sourceKind === 'demo-snapshot') lines.push(P.yellow('样本价，仅供体验；实时价格请连接后重新核价。'));
  else if (remaining != null) lines.push(P.gray(`报价 ${clock(remaining)} 后失效。`));
  lines.push(P.gray('说“就吃这个了”下单（到店自取）· /why 看挑选过程 · /receipt 小票'));
  return lines;
}

export function renderStores(stores, P) {
  if (!stores.length) return ['没有找到门店，换个城市或关键词试试。'];
  return [...stores.slice(0, 12).map((s, i) => `${P.bold(String(i + 1).padStart(2))}. ${s.storeName}  ${s.businessStatus === true ? P.green(storeStatus(s)) : P.yellow(storeStatus(s))}${s.address ? P.gray(`  ${s.address}`) : ''}`),
    P.gray('输入序号选择门店（只能到店自取）。')];
}

// /coupons: claimable first (name · savings · expiry), then held coupons with store scope, expiry and quoted savings.
export function renderBenefits(b, P, { picture = null } = {}) {
  const lines = [...renderClaimable(picture?.claimable || [], P, { limit: 12 }), ''];
  const held = b.rows.filter((r) => r.kind === 'owned-coupon');
  lines.push(P.bold(`持有券 ${b.ownedCount} 张`) + P.gray(` · 门店券 ${b.storeCount} 条 · 可用于核价 ${b.usable.length} 张`)
    + `${b.walletComplete ? '' : P.yellow(' · 券包未查全')}${b.calendarComplete ? '' : P.yellow(' · 活动日历未查全')}`);
  if (!held.length) lines.push(P.gray('券包里没有券。'));
  const expiry = new Map((picture?.usable || []).map((c) => [c.name, c.expires])), used = new Map((picture?.used || []).map((u) => [u.name, u.savingFen]));
  for (const row of held.slice(0, 16)) {
    const facts = row.status === 'eligible'
      ? [P.green('本店可用'), `可省：${used.get(row.name) > 0 ? `最多 ${money(used.get(row.name))}（本次核价）` : '以官方核价为准，/price 后显示'}`, `有效期：${expiry.has(row.name) ? `${expiry.get(row.name)} 到期` : '接口未返回'}`, P.gray(row.scope)]
      : [P.yellow(`本店不可用：${row.condition}`)];
    lines.push(`· ${row.name}${row.assetCount > 1 ? ` ×${row.assetCount}` : ''} · ${facts.join(' · ')}`);
  }
  if (held.length > 16) lines.push(P.gray(`……另有 ${held.length - 16} 条未显示`));
  for (const row of b.rows.filter((r) => r.kind === 'source-error')) lines.push(P.yellow(`${row.name}${row.scope}：${row.condition}`));
  lines.push(P.gray('活动与参与方式：/activity'));
  return lines;
}

// Local allergy screening summary: which allergen excluded which items, and what had unknown composition.
export function renderAllergyScreen(allergy, P) {
  if (!allergy) return [];
  const lines = [P.bold(`过敏筛选（本地，按名称关键词）：${allergy.allergies.join('、')}`)];
  for (const allergen of allergy.allergies) {
    const hits = allergy.excluded.filter((e) => e.hits?.some((h) => h.allergen === allergen));
    if (hits.length) lines.push(P.yellow(`· ${allergen} → 已排除：${hits.map((e) => `${e.title}（${e.hits.find((h) => h.allergen === allergen).keyword}）`).join('、')}`));
  }
  const unknown = allergy.excluded.filter((e) => e.unknown);
  if (unknown.length) lines.push(P.yellow(`· 成分不明，已排除：${unknown.map((e) => e.title).join('、')}`));
  if (!allergy.excluded.length) lines.push(P.gray('· 名称里没有匹配到关键词，没有排除。'));
  lines.push(P.gray(SCREEN_NOTE));
  return lines;
}

export function renderAllergies(allergies, P, { file = '', error = '' } = {}) {
  const lines = allergies.length
    ? allergies.map((a) => `· ${P.bold(a)} → 关键词：${keywordsFor(a).join('、')}${isKnownAllergen(a) ? '' : P.gray('（未收录，只按名称本身匹配）')}`)
    : [P.gray('还没有记录过敏。用 /allergy 花生 虾 添加，或直接说“我对花生过敏”。')];
  if (error) lines.push(P.red(`${error}：为避免覆盖，本次不会写入该文件；修好或删除后重启。`));
  lines.push(P.gray(`只保存在本机${file ? ` ${file}` : '（本次会话内存）'}；只用于本地筛选，从不发送给 DeepSeek 或麦当劳 MCP。`));
  lines.push(P.gray('/allergy-clear 名称 删除一项。'), P.gray(SCREEN_NOTE));
  return lines;
}

const STATUS_LABELS = { ongoing: '进行中', upcoming: '即将开始', past: '已结束', unknown: '日期未返回' };
const MODE_LABELS = { mcp: '可通过 MCP 参与（领券）', held: '已持有对应券', info: '仅展示' };
const span = (dates) => !dates.length ? '日期未返回' : dates.length === 1 ? dates[0] : `${dates[0]} 至 ${dates.at(-1)}`;
export function renderActivities(result, P) {
  const rows = result.rows, mcp = rows.filter((a) => a.participation.mode !== 'info').length;
  const lines = [`${rows.length} 项活动 · 可通过 MCP 参与 ${mcp} 项 · 仅展示 ${rows.length - mcp} 项${result.sample ? P.yellow(' · 2026-10-10 样本，不是实时') : ''}${result.offersComplete ? '' : P.yellow(' · 可领券未查到，参与方式可能不全')}`,
    P.yellow(NO_REGISTER_NOTE), ''];
  if (!rows.length) lines.push(P.gray('活动日历没有返回活动。'));
  for (const a of rows.slice(0, 20)) {
    const tone = a.participation.mode === 'info' ? P.gray : P.green;
    lines.push(`${tone(`[${MODE_LABELS[a.participation.mode]}]`)} ${P.bold(a.name)} · ${a.typeName} · ${span(a.dates)}（${STATUS_LABELS[a.status]}）${a.subscribed ? P.cyan(' · 已订阅') : ''}`);
    lines.push(`  规则：${a.rules.join('；') || '接口未返回规则'}${a.couponWindow ? `；券有效期 ${a.couponWindow.start || '?'} 至 ${a.couponWindow.end || '?'}` : ''}${a.priceDisplay ? `；标价 ${a.priceDisplay}（仅展示，不当折扣）` : ''}`);
    lines.push(`  参与：${a.participation.how}`);
  }
  if (rows.length > 20) lines.push(P.gray(`……另有 ${rows.length - 20} 项未显示`));
  lines.push('', P.gray('不会自动报名或领券；领券只在你输入 /claim 并确认 yes 后进行。'));
  return lines;
}

export function renderReport(report, P, { remaining = null } = {}) {
  const r = report.request, lines = [];
  const source = report.sourceKind === 'demo-snapshot' ? P.yellow('历史样本价（2026-10-10 深圳样本门店），不是实时报价') : `官方整单核价 · ${remaining == null ? '' : `${clock(remaining)} 后失效（最长 5 分钟）`}`;
  lines.push(`${r.people} 人 · 整顿预算 ${money(r.totalBudgetFen)} · ${source}`);
  if (!report.quotedPlans.length) lines.push(P.yellow('这次没有可用的套餐或单点报价。'));
  lines.push(P.gray('按用券后的实际价格从低到高排（单点主食和套餐一起比，同价优先套餐）：'));
  const pool = new Set(report.candidates.map((p) => p.id));
  for (const p of report.quotedPlans.slice(0, 14)) {
    const mark = pool.has(p.id) ? P.green('✓') : P.gray('×');
    const saving = p.savingFen > 0 ? P.green(` 省${money(p.savingFen)}`) : '';
    const coupons = p.couponNames?.length ? P.cyan(` 用券：${p.couponNames.join('、')}`) : '';
    lines.push(`${mark} ${padEnd(p.title, 26)} ${padEnd(p.wheelKind || '', 12)} ${P.bold(money(p.priceFen))}${saving}${coupons}`);
  }
  for (const p of [...report.excludedPlans, ...report.failedPlans].filter((p) => !/过敏原|成分不明/.test(p.reason)).slice(0, 6)) lines.push(P.gray(`- ${p.title}：${p.reason}`));
  // What the store's menu interface actually returned, and what each template code did with it.
  if (report.menu) lines.push(P.gray(`门店菜单（query-meals）：${report.menu.ok ? `识别 ${report.menu.items.length} 项` : P.yellow(report.menu.error)} · ${report.menu.shape}`));
  const HOW = { menu: '菜单里有', name: '菜单里按名称对应到', absent: '菜单里没有' }, DETAIL = { ok: '已取到', empty: '为空' };
  for (const t of (report.templateCodes || []).filter((t) => t.detail !== 'ok' || t.how !== 'menu').slice(0, 6)) {
    lines.push(P.gray(`  模板 ${t.code}${t.name ? `（${t.name}）` : ''}：${HOW[t.how]}${t.how === 'name' ? ` ${t.storeCode}` : ''} · 详情 ${DETAIL[t.detail] || `出错：${t.error}`}`));
  }
  if (report.menuFallback) lines.push(P.cyan(`模板套餐这家店用不了，按门店实际菜单补充核价 ${report.menuFallback.tried} 样，成功 ${report.menuFallback.quoted} 样。`));
  for (const p of report.quotedPlans.filter((p) => p.upgrade && p.kind !== 'alacarte' && pool.has(p.id)).slice(0, 3)) lines.push(P.cyan(`升级算账：${upgradeText(p.upgrade)}`));
  for (const note of report.pricingNotes || []) lines.push(P.cyan(note));
  lines.push(...renderAllergyScreen(report.allergy, P));
  lines.push(P.gray(`预算内候选 ${report.candidates.length} 份 · ${report.quotedPlans[0]?.priceLabel || '最低已核验价'}只覆盖当前模板、单点主食与实际比较成功的券方案，不代表全菜单最低。`));
  return lines;
}

export function renderPick(plan, P, { report, remaining = null, signals = [], source = '', heading = '', coupons = [], thought = '', thoughtSource = '' } = {}) {
  const lines = [], usesCoupon = plan.couponNames?.length > 0;
  if (heading) lines.push(P.bold(heading));
  lines.push(`${P.brand(P.bold(plan.title))}  ${plan.wheelKind ? P.gray(plan.wheelKind) : ''}`);
  lines.push(`内容：${partsText(plan)}`);
  lines.push(`整单：${P.bold(money(plan.priceFen))}${report?.request?.people > 1 ? `（人均约 ${money(Math.ceil(plan.priceFen / report.request.people))}）` : ''} · ${plan.priceLabel || ''}`);
  if (usesCoupon) lines.push(`官方报价已用券：${plan.couponNames.map((n) => couponNote(n, coupons)).join('、')}${plan.savingFen > 0 ? `，比无券基准少 ${money(plan.savingFen)}` : ''}`);
  if (plan.upgrade) lines.push(`${P.cyan('单点 vs 套餐')}：${upgradeText(plan.upgrade)}`);
  // A pick that uses a coupon always says so in its reason, with the saving against the no-coupon baseline.
  const reasons = usesCoupon && !signals.includes('coupon') ? ['coupon', ...signals] : signals;
  if (reasons.length) lines.push(`理由：${signalText(reasons)}${usesCoupon && plan.savingFen > 0 ? `（省了 ${money(plan.savingFen)}）` : ''}`);
  if (thought) lines.push(`${P.cyan('助理想法')}${thoughtSource === 'local' ? P.gray('（本地）') : ''}：${thought}`);
  if (source) lines.push(P.gray(source));
  if (report?.sourceKind === 'demo-snapshot') lines.push(P.yellow('样本价，仅供体验；实时价格请连接后重新核价。'));
  else if (remaining != null) lines.push(P.gray(`报价 ${clock(remaining)} 后失效。想吃就说“就吃这个了”：先领券再下单（到店自取），付款在麦当劳支付链接或 App。`));
  return lines;
}

export function renderAgentResult(result, P, { report, remaining }) {
  const [first, ...rest] = result.plans;
  const via = result.source === 'deepseek'
    ? `DeepSeek V4.1 Flash · ${result.rounds} 轮（${result.stages.map((s) => s.role === 'recommend' ? '推荐 Agent' : '优化 Agent').join(' → ')}）${result.stages.length === 2 && result.stages[0].primaryId !== result.stages[1].primaryId ? ' · 优化 Agent 调整了首选' : ''}`
    : '本地偏好推荐（未调用 DeepSeek）';
  const coupons = result.coupons || [];
  const lines = renderPick(first, P, { report, remaining, signals: first.signals, coupons, thought: first.thought, thoughtSource: first.thoughtSource, source: `${PERSONAS[result.vibe]?.name || ''} · ${via}` });
  if (rest.length) {
    lines.push('', P.bold('也可以考虑：'));
    for (const p of rest) {
      const reasons = p.couponNames?.length && !p.signals.includes('coupon') ? ['coupon', ...p.signals] : p.signals;
      lines.push(`· ${p.title}  ${money(p.priceFen)}  ${P.gray(signalText(reasons))}${p.couponNames?.length ? P.cyan(` 用券：${p.couponNames.map((n) => couponNote(n, coupons)).join('、')}${p.savingFen > 0 ? `，省了 ${money(p.savingFen)}` : ''}`) : ''}`);
      if (p.thought) lines.push(`  ${P.gray(`助理想法：${p.thought}`)}`);
    }
  }
  return lines;
}

export function renderIntent(intent, mainNames, P, { store = '' } = {}) {
  const avoid = intent.avoidMainCodes.map((c) => mainNames.get(c) || c), want = (intent.wantMainCodes || []).map((c) => mainNames.get(c) || c);
  const d = (key) => intent.defaulted?.includes(key) ? P.gray('（默认）') : '';
  return [
    `${intent.people} 人${d('people')} · 人均 ${money(intent.budgetPerPersonFen)}${d('budgetPerPersonYuan')}`,
    ...(want.length ? [`想吃：${want.join('、')}（单点和含它的套餐一起比价）`] : []),
    `避开：${[intent.avoidRecentDays ? `${intent.avoidRecentDays === 1 ? '昨天' : '前两天'}吃过的主食（读历史订单）` : '', avoid.join('、')].filter(Boolean).join('；') || '无'}`,
    `门店：${store || (intent.city ? `${intent.city} · ${intent.keyword}` : '沿用当前门店')} · 目标：${GOAL_LABELS[intent.goal] || '沿用设置'} · 心情：${MOOD_LABELS[intent.mood] || intent.mood} · 揭晓：${intent.finish === 'wheel' ? '转盘' : '饭搭子双 Agent'}`,
  ];
}

const GLYPHS = ['·', '░', '▒', '▓', '█'];
export function renderHeatmap(history, P, { mode = 'recent', year = Number(history.anchorDay.slice(0, 4)) } = {}) {
  const cal = historyCalendar(history, { year, mode }), cw = mode === 'recent' ? 2 : 1;
  let header = '   ';
  for (const m of cal.months) {
    const at = 3 + m.column * cw;
    if (textWidth(header) <= at) header = padEnd(header, at) + m.name;
  }
  const rows = ['日', '一', '二', '三', '四', '五', '六'].map((label, weekday) => `${label} ${cal.weeks.map((week) => {
    const cell = week[weekday];
    const glyph = !cell || cell.future ? ' ' : cell.count ? P.level(cell.level, GLYPHS[cell.level]) : cell.unknown ? P.gray('·') : P.level(0, '·');
    return glyph + ' '.repeat(cw - 1);
  }).join('')}`);
  const fiction = history.sourceKind === 'demo-history';
  return [
    fiction ? P.yellow('虚构示例数据，仅演示热力图，不能导入最近主食。') : `截至 ${history.anchorDay} · 接口返回 ${history.returnedCount} 笔，计入已完成 / 已评价 ${history.orders.length} 笔（跳过未完成 ${history.skipped.unfinished} 笔）`,
    `${cal.start} 至 ${cal.end} · ${cal.orderCount} 笔订单 · ${cal.recordedDays} 个有记录日期`,
    '', P.gray(header), ...rows,
    P.gray(`   少 ${GLYPHS.map((g, i) => P.level(i, g)).join(' ')} 多 · 灰点＝接口未返回，不等于没吃过`),
    '', P.bold('常点餐品：') + (cal.ranking.map((f) => `${f.name}×${f.count}`).join('、') || '无'),
    '', ...renderRecentEats(history, P),
  ];
}

// Name-based guess: the order list has no category field. Packages / burgers / pies are never drinks.
const DRINK = /可乐|雪碧|芬达|咖啡|拿铁|美式|卡布奇诺|奶铁|红茶|奶茶|果汁|美汁源|牛奶|燕麦奶|豆浆|奶昔|怡泉|纯悦|矿泉水|饮品|冰咖|鲜萃|（冰\/热）|\(冰\/热\)|柠檬茶/;
export const isDrink = (name) => DRINK.test(name) && !/套餐|堡|派|件套|餐$/.test(name);
const WEEKDAYS = '日一二三四五六';

// Specific dishes and drinks from the most recent completed orders, newest first.
export function renderRecentEats(history, P, { limit = 6 } = {}) {
  const fiction = history.sourceKind === 'demo-history', orders = history.orders.slice(0, limit);
  const lines = [P.bold('最近吃了啥 / 喝了啥') + (fiction ? P.yellow('（虚构示例，仅演示，不是你的订单）') : P.gray(`（最近 ${orders.length} 笔已完成 / 已评价订单）`))];
  if (!orders.length) return [...lines, P.gray('接口没有返回已完成订单；未返回不等于没吃过。')];
  // Display-only dedupe: identical day + time + items collapse to one line; header counts stay untouched.
  const seen = new Set();
  for (const order of orders) {
    const signature = JSON.stringify([order.day, order.time, order.items.map((i) => [i.name, i.quantity, i.parts.map((p) => [p.name, p.quantity])])]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    const eat = [], drink = [], packages = [];
    for (const item of order.items) {
      if (item.parts.length) packages.push(item.name);
      for (const part of item.parts.length ? item.parts : [item]) {
        const label = `${part.name}${part.quantity > 1 ? `×${part.quantity}` : ''}`;
        (isDrink(part.name) ? drink : eat).push(label);
      }
    }
    const when = `${order.day.slice(5)} 周${WEEKDAYS[new Date(`${order.day}T00:00:00Z`).getUTCDay()]} ${order.time}`;
    const body = order.items.length ? `吃：${eat.join('、') || '—'}  喝：${drink.join('、') || '—'}` : P.gray('接口未返回餐品明细');
    lines.push(`${P.cyan(when)}  ${body}${packages.length ? P.gray(`（${packages.join('、')}）`) : ''}`);
  }
  return lines;
}

// Every command the shell handles: [names (first is primary, rest are aliases), usage, description, palette keywords].
// shell.mjs refuses to start if a handler is missing here. Keywords are Chinese on purpose: an ASCII query
// filters by command-name prefix only, so '/ca' is exactly /cart.
export const COMMAND_HELP = [
  [['connect'], '/connect', '用环境变量 MCD_TOKEN 连接麦当劳 MCP', ['连接', '登录', '令牌']],
  [['store'], '/store [城市 关键词]', `搜索到店门店；不带参数搜默认区域 ${DEFAULT_STORE_SEARCH.label}`, ['门店', '选店', '位置', '附近']],
  [['use'], '/use 序号', '选择 /store 列出的门店（也可以直接输入序号）', ['选择', '序号', '门店']],
  [['coupons'], '/coupons', '先列可领券（名称 · 可省 · 有效期），再列持有券；只查看，不领取', ['券', '优惠', '券包', '可领']],
  [['claim'], '/claim', '领取全部可领券（先列出可领券，需输入 yes 明确确认）', ['领券', '领取', '券']],
  [['activity'], '/activity', '活动日历：规则、日期、能否通过 MCP 参与；也可以说“有什么活动”', ['活动', '日历', '报名']],
  [['set'], '/set 人数 人均预算', '例：/set 2 35', ['人数', '预算']],
  [['avoid'], '/avoid [主食名…|clear]', '查看或切换要避开的主食', ['避开', '不吃', '主食']],
  [['allergy'], '/allergy [过敏原…]', '不带参数列出，带参数添加（如 /allergy 花生 虾）；也可以说“我对花生过敏”', ['过敏', '忌口']],
  [['allergy-clear'], '/allergy-clear 过敏原', '删除一项过敏记录', ['过敏', '删除']],
  [['price'], '/price', '官方整单核价：单点主食和套餐按用券后价格一起比（5 分钟内有效）', ['核价', '价格', '报价']],
  [['wheel'], '/wheel', '转盘随机揭晓一份（同轮不重复）', ['转盘', '随机']],
  [['buddy'], '/buddy [心情] [local]', 'DeepSeek 推荐 + 优化双 Agent；心情 normal/comfort/surprise/gathering', ['推荐', '饭搭子', '挑选']],
  [['why'], '/why', '上一次挑选的详细过程：需求、门店、历史、核价、两个 Agent 的讨论与备选', ['过程', '详情', '理由', '备选']],
  [['prefs'], '/prefs goal|persona|mode 值', '目标 cheapest（默认）/balanced/variety；风格 cozy/frugal/playful', ['偏好', '目标', '风格']],
  [['like'], '/like', '喜欢上一份（仅本次会话内存）', ['喜欢', '反馈']],
  [['less'], '/less', '以后少推荐上一份（仅本次会话内存）', ['少推荐', '反馈']],
  [['receipt'], '/receipt', '打印最近一份的小票；扫二维码打开套餐卡片（静态页，不是付款码）', ['小票', '二维码', '卡片']],
  [['commit'], '/commit -m "备注"', '把当前这一餐记成本地提交（7 位 hash），不下单', ['记下', '提交', '备注']],
  [['push'], '/push', '把未 push 的提交全部加入购物车（本地清单，还不是订单）', ['购物车', '加入']],
  [['cart'], '/cart [rm <hash>|clear]', '查看购物车；rm 移出一单，clear 清空（需输入 yes）', ['购物车', '清单']],
  [['order'], '/order [订单号]', '列出真实订单（订单号 · 餐 · 金额 · 状态 · 时间）；带订单号查实时状态（也可以回复“支付完成”）', ['订单', '支付', '状态']],
  [['graph'], '/graph', '像 git log --graph 一样看提交历史和 origin/main', ['历史', '提交']],
  [['radar'], '/radar [recent|year] [年] · /radar apply', '本餐雷达图 + 历史订单热力图 + 最近吃了啥；apply 把前两天的主食加入避开', ['雷达', '热力图', '历史']],
  [['weather'], '/weather', '查询门店所在城市天气，供饭搭子参考', ['天气']],
  [['help', 'h', '?'], '/help · /h · /?', '显示这份命令表', ['帮助', '命令']],
  [['status'], '/status', '当前连接、门店、餐量和报价状态', ['状态', '连接']],
  [['clear'], '/clear', '清屏', ['清屏']],
  [['quit', 'exit', 'q'], '/quit · /exit · /q', '退出', ['退出']],
];
export const HELP_COMMANDS = new Set(COMMAND_HELP.flatMap(([names]) => names));

export function helpLines(P) {
  const c = (cmd, text) => `${P.cyan(padEnd(cmd, 26))}${text}`;
  return [
    P.bold('直接输入一句话 → Agent 在后台走完：理解需求 → 连接 → 选店 → 读历史避开 → 查券核价 → 双 Agent 挑选，最后只给一个答案'),
    P.gray('  例：1人、人均30元、避开昨天吃过的主食 @深圳 华强北；想吃麦香鱼；我对花生过敏；有什么活动'),
    P.gray(`  没写的默认：${DEFAULT_INTENT.people} 人 · 人均 ¥${DEFAULT_INTENT.budgetPerPersonYuan}；门店搜 ${DEFAULT_STORE_SEARCH.label}`),
    P.gray('  /why 查看上一次的完整过程（每一步的结果、两个 Agent 的选择与备选）'),
    P.gray('  输入 / 立即弹出命令面板（按前缀过滤，带说明和关键词）：↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭'),
    `${P.bold('选好一餐后，说 就吃这个了 直接下单')}${P.gray('（也可以说 就这个 / 要这个 / 下单；到店自取，不支持外送）')}`,
    P.gray('  先列出这单能用、要领的券，再问“是这家店吗？”；回 是 才领券、重新核价（只会持平或更便宜）并在麦当劳创建订单，'),
    P.gray('  然后给支付链接和支付二维码，扫码或在麦当劳 App 付款；回 不是 就取消。付完说 支付完成 查订单状态。'),
    '',
    ...COMMAND_HELP.map(([, cmd, text]) => c(cmd, text)),
  ];
}
