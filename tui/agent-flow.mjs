// Natural-language agent mode. The program owns the step order and only ever
// calls read-only MCP tools; DeepSeek parses intent and picks among verified
// candidates. auto-bind-coupons, ordering and payment are never reachable here.
//
// Presentation: while it runs the user sees one spinner line with the current step; when it
// ends they get ONE answer (pick · price · store · one line of reason). The per-step results and
// the recommend / optimise deliberation are kept in session.lastDetails for /why only.
import { MCPError } from '../web/mcp-client.mjs';
import { DeepSeekError } from '../web/deepseek-client.mjs';
import { calendarContext } from '../web/agent-context.mjs';
import { parseLocalIntent, agentIntent, mergeIntent, DEFAULT_STORE_SEARCH } from './intent.mjs';
import { answerMeat, answerParts, answerIngredients, compositionNames, renderInfoAnswer } from './info.mjs';
import { TuiError } from './session.mjs';
import { renderIntent, renderReport, renderAgentResult, renderPick, renderRecentEats, renderCoupons, renderAnswer, pickReason } from './render.mjs';
import { maybeReceipt } from './receipt.mjs';
import { stripAllergyText } from './allergy.mjs';
import { storeStatus } from '../web/store-search.mjs';
import { renderEmpty, emptyCause, renderPriceAnswer } from './menu.mjs';

const message = (e) => e instanceof TuiError || e instanceof MCPError || e instanceof DeepSeekError ? e.message : (e?.message || '未完成');
const STEPS = 6;

// First store the official search says is open; selects it on the session.
async function selectOpenStore(session, target) {
  const stores = await session.searchStores(target.city, target.keyword);
  const open = stores.find((s) => s.businessStatus === true);
  const where = target.isDefault ? `默认区域 ${target.label}` : `${target.city} · ${target.keyword}`;
  if (!open) throw new TuiError(stores.length ? `${where}找到 ${stores.length} 家门店，但官方未确认营业中。可用 /store ${target.city} ${target.keyword} 查看后手动选择。` : `${where}没有找到门店，在指令里加 @城市 关键词，或用 /store 换个位置。`);
  session.selectStore(open, target.city);
  return { open, stores };
}

// Connect if needed, then search the default area when the sentence names no store and none is selected.
async function ensureStore(session, task, text) {
  if (session.demo) return;
  if (!session.connected) { task.progress('连接麦当劳 MCP …'); await session.connect(); }
  const local = parseLocalIntent(text, session.mainNames);
  const target = local.city && local.keyword ? { city: local.city, keyword: local.keyword } : session.store ? null : { ...DEFAULT_STORE_SEARCH, isDefault: true };
  if (target) { task.progress(`选择门店 · ${target.city} ${target.keyword}`); await selectOpenStore(session, target); }
}

// '牛肉堡多少钱' / '最低预算要多少钱': a direct lookup in the store's menu plus calculate-price — not the pick flow,
// which answers a different question and would report '预算内没有候选'. Read-only: query-meals, query-meal-detail, calculate-price.
export async function runPriceFlow(session, text, query, ui) {
  const P = ui.palette, ask = query.item || '最便宜的餐', task = ui.begin(`查价：${ask}`);
  try {
    await ensureStore(session, task, text);
    const result = await session.priceLookup(query.item, (p) => task.progress(p.text));
    task.done();
    session.lastDetails = { query: text, lines: [
      `查价「${ask}」· ${session.store?.storeName || ''}`,
      `门店菜单 ${result.items.length} 项${session.menu?.shape ? `（${session.menu.shape}）` : ''}，匹配 ${result.matches.length} 项：${result.matches.slice(0, 8).map((m) => m.name).join('、') || '无'}`,
      ...result.quoted.map((q) => `calculate-price · ${q.name} → ${q.priceFen / 100} 元${q.couponNames.length ? `（用券 ${q.couponNames.join('、')}）` : ''}`),
      ...result.failed.map((f) => P.yellow(`calculate-price · ${f.name} 没成功：${f.reason}`))] };
    ui.result(result.matches.length ? `${ask}多少钱` : `没找到${ask}`, renderPriceAnswer(result, P, { storeName: session.store?.storeName }), result.matches.length ? undefined : 'yellow');
    return { status: 'priced', result };
  } catch (e) {
    task.done();
    ui.result('没查到价格', [`${message(e)}`, P.gray('/store 换一家店，或稍后再问。')], 'yellow');
    return { status: 'failed', error: message(e) };
  }
}

const NO_PICK_INFO = '还没有挑出这一餐。先说"预算 30 来一份"，或直接问具体的，比如"巨无霸有牛肉吗"';
const mergeInfoDetails = (details) => {
  if (!details?.length) return null;
  if (details.length === 1) return details[0];
  return { code: details.map((d) => d.code).join('+'), name: details.map((d) => d.name).filter(Boolean).join('、'),
    plain: false, rounds: details.flatMap((d) => d.rounds || []),
    extras: details.flatMap((d) => (d.extras || []).map((n) => ({ where: d.name, names: [n] }))) };
};
const meatNamesOf = (detail, fallback) => [...new Set([fallback, detail?.name, ...compositionNames(detail)].filter(Boolean))];

// '这个有牛肉吗' / '随心配有什么' / '有什么料'. Same skeleton as runPriceFlow, but it never
// writes lastDetails, never prints a receipt, and never records a pick. '这个' reads lastReceipt,
// not lastPick (invalidate() clears lastPick; the receipt survives).
export async function runInfoFlow(session, text, query, ui) {
  const P = ui.palette, storeNameOf = () => session.store?.storeName || '';
  const label = query.kind === 'meat' ? `有没有${query.meat}` : query.kind === 'ingredients' ? '有什么配料' : '套餐里有什么';
  const task = ui.begin(`问询：${label}`);
  const show = (title, answer, tone) => ui.result(title, renderInfoAnswer(answer, P, { storeName: storeNameOf(), allergies: session.allergies }), tone);
  try {
    if (query.target.ref === 'pick') {
      const receipt = session.lastReceipt;
      if (!receipt) {
        if (!query.target.implicit) ui.info(NO_PICK_INFO);
        return { status: 'no-pick' };
      }
      const partNames = (receipt.parts || []).map((p) => p.name).filter(Boolean);
      let detail = null, detailError = null;
      if (!session.demo && receipt.buy && query.kind !== 'meat') {
        try {
          if (!session.connected) { task.progress('连接麦当劳 MCP …'); await session.connect(); }
          const got = await session.pickDetail((p) => task.progress(p.text));
          detail = mergeInfoDetails(got.details); detailError = got.error;
        } catch (e) { detailError = message(e); }
      }
      if (query.kind === 'meat') {
        const answer = answerMeat({ names: partNames, meat: query.meat, confirm: query.confirm });
        show(`有没有${query.meat}`, answer);
        return { status: 'answered', answer };
      }
      if (query.kind === 'parts') {
        const answer = answerParts({ name: receipt.title, parts: receipt.parts, detail, detailError, storeName: receipt.storeName });
        show(receipt.title ? `${receipt.title}里有什么` : '套餐里有什么', answer);
        return { status: 'answered', answer };
      }
      const answer = answerIngredients({ name: receipt.title, detail, parts: receipt.parts, names: partNames, sample: session.demo && !detail, detailError });
      show('配料', answer);
      return { status: 'answered', answer };
    }

    await ensureStore(session, task, text);
    const looked = await session.itemDetail(query.target.item, (p) => task.progress(p.text));
    if (!looked.matches.length) {
      const answer = { kind: 'missing', item: query.target.item, items: looked.items };
      show('菜单里没找到', answer, 'yellow');
      return { status: 'not-found', answer };
    }
    if (looked.error) {
      const answer = { kind: 'error', error: looked.error };
      show('接口出错', answer, 'yellow');
      return { status: 'failed', error: looked.error, answer };
    }
    const detail = looked.detail, hitName = looked.matches[0].name;
    if (looked.sample && !detail && query.kind !== 'meat') {
      const answer = { kind: 'no-sample', name: hitName, names: [hitName] };
      show('没有餐品详情', answer, 'yellow');
      return { status: 'answered', answer };
    }
    const names = meatNamesOf(detail, hitName);
    if (query.kind === 'meat') {
      const answer = answerMeat({ names, meat: query.meat, confirm: query.confirm });
      const lines = renderInfoAnswer(answer, P, { storeName: storeNameOf(), allergies: session.allergies });
      if (looked.sample && !detail) lines.unshift('样本模式没有餐品详情；连接后再问。');
      ui.result(`有没有${query.meat}`, lines);
      return { status: 'answered', answer };
    }
    if (query.kind === 'parts') {
      const answer = answerParts({ name: detail?.name || hitName, detail, storeName: storeNameOf() });
      show(answer.plain ? '配料' : `${answer.name}里有什么`, answer);
      return { status: 'answered', answer };
    }
    const answer = answerIngredients({ name: detail?.name || hitName, detail, names });
    show('配料', answer);
    return { status: 'answered', answer };
  } catch (e) {
    ui.result('没查到', [message(e)], 'yellow');
    return { status: 'failed', error: message(e) };
  } finally {
    task.done();
  }
}

export async function runAgentFlow(session, text, ui, { signal } = {}) {
  const P = ui.palette, details = [], notes = [];
  const task = ui.begin('为你挑选这一餐');
  let current = '', title = '';
  const step = (n, name) => { current = `${n}/${STEPS} ${name}`; title = name; task.progress(current); };
  const log = (summary = '', lines = []) => details.push(`${P.bold(current)}${summary ? ` ${summary}` : ''}`, ...lines.map((l) => `   ${l}`));
  const check = () => { if (signal?.aborted) throw new TuiError('已取消。'); };
  const finish = (result) => { session.lastDetails = { query: text, lines: details }; return { ...result, details }; };

  try {
    // 1. Intent: local parser always; DeepSeek fills gaps when a key is available.
    step(1, '理解需求');
    const local = parseLocalIntent(text, session.mainNames);
    let model = {}, via = '本地规则解析';
    // Allergy clauses and recorded allergen names never leave the process.
    const outbound = stripAllergyText(text, session.allergies);
    if (session.hasDeepSeek && outbound) {
      task.progress(`${current} · 需求理解 Agent`);
      try { model = await agentIntent(session.deepseek, outbound, session.mainNames, { calendar: calendarContext(session.now()), signal }); via = '本地规则 + DeepSeek 需求理解 Agent'; }
      catch (e) { via = `本地规则解析（DeepSeek 未完成：${message(e)}）`; }
    }
    check();
    const intent = mergeIntent(local, model, session.profile);
    const storeText = intent.city ? `${intent.city} · ${intent.keyword}（指令）`
      : session.demo ? `${session.store.storeName}（样本模式不搜索；实时模式默认搜 ${DEFAULT_STORE_SEARCH.label}）`
      : session.store ? `沿用 ${session.store.storeName}` : `默认 ${DEFAULT_STORE_SEARCH.label} 附近`;
    const allergies = session.allergies;
    log(via, [...renderIntent(intent, session.mainNames, P, { store: storeText }),
      ...(allergies.length ? [P.yellow(`过敏：${allergies.join('、')} → 核价后在本地按名称关键词排除，成分不明的也排除（不发送给 DeepSeek / MCP）`)] : [])]);

    // 2. Connection.
    step(2, '连接麦当劳 MCP');
    if (session.demo) log('样本模式：使用 2026-10-10 深圳样本门店的历史报价');
    else if (session.connected) log('已连接');
    else { await session.connect(); log('已连接（Token 来自环境变量，仅在内存）'); }
    check();

    // 3. Store: instruction location > store picked with /store (or a previous run) > default area.
    step(3, '选择门店');
    if (session.demo) log(`样本门店：${session.store.storeName}`);
    else {
      const target = intent.city && intent.keyword ? { city: intent.city, keyword: intent.keyword } : session.store ? null : { ...DEFAULT_STORE_SEARCH, isDefault: true };
      if (!target) log(`沿用 ${session.store.storeName}`);
      else {
        task.progress(`${current} · ${target.city} ${target.keyword}`);
        const { open, stores } = await selectOpenStore(session, target);
        if (target.isDefault) notes.push(`没给位置，按默认区域 ${target.label} 选店`);
        log(`${open.storeName} · ${storeStatus(open)}`, [
          ...(target.isDefault ? [P.yellow(`指令未给位置，默认搜索 ${target.label} 附近；指令里写 @城市 关键词 或 /store 可覆盖。`)] : []),
          P.gray(`按“${target.keyword}”返回的第一家营业中门店；共 ${stores.length} 家，可用 /store 更换。`)]);
      }
    }
    check();

    // 4. Recent eats and drinks from completed orders (order-list only); optionally avoid recent mains.
    step(4, '读历史');
    const avoid = new Set(intent.avoidMainCodes);
    const named = avoid.size ? [P.gray(`按指令避开 ${avoid.size} 种主食：${[...avoid].map((c) => session.mainNames.get(c) || c).join('、')}`)] : [];
    if (session.demo) {
      await session.radar();
      log('样本模式：虚构示例历史', [...renderRecentEats(session.history, P, { limit: 4 }), ...named,
        ...(intent.avoidRecentDays ? [P.yellow('虚构历史不能用于避开主食，本次不按历史避开。')] : [])]);
    } else {
      let history = true;
      try { await session.radar(); }
      catch (e) {
        history = false;
        if (intent.avoidRecentDays) notes.push('历史订单没读到，这次没按历史避开');
        log(`历史订单读取未完成：${message(e)}。${intent.avoidRecentDays ? '本次不按历史避开，' : ''}未返回不等于没吃过。`);
      }
      if (history) {
        const lines = [...renderRecentEats(session.history, P, { limit: 4 }), ...named];
        if (!intent.avoidRecentDays) log(`${session.history.orders.length} 笔已完成订单`, lines);
        else {
          const codes = session.recentMains(intent.avoidRecentDays);
          codes.forEach((c) => avoid.add(c));
          const label = intent.avoidRecentDays === 1 ? '昨天' : '前两天';
          log(codes.length ? `${label}吃过的主食将避开：${codes.map((c) => session.mainNames.get(c) || c).join('、')}` : `${label}没有返回可识别的主食`,
            [...lines, P.gray('接口无分页，覆盖可能不完整；只匹配已知主食编码。')]);
        }
      }
    }
    check();
    session.setRequest({ budgetPerPersonFen: intent.budgetPerPersonFen, avoidMainCodes: [...avoid],
      wantMainCodes: (intent.wantMainCodes || []).filter((c) => !avoid.has(c)) });
    if (intent.goal) session.preferences = { ...session.preferences, goal: intent.goal };

    // 5. Coupons + whole-cart quotes.
    step(5, '查券与官方整单核价');
    const report = await session.quote((p) => task.progress(`${current} · ${p.text}`));
    const singles = report.quotedPlans.filter((p) => p.kind === 'alacarte').length;
    log(`${report.counts.quotedPlans - singles} 份完整套餐${singles ? ` + ${singles} 份单点主食` : ''}已核价，预算内 ${report.candidates.length} 份`,
      [...renderReport(report, P, { remaining: session.remainingSeconds() }), ...renderCoupons(session.couponPicture(), P, { demo: session.demo })]);
    check();
    if (report.allergy?.excluded.length) notes.push(`过敏筛选排除了 ${report.allergy.excluded.length} 份`);
    if (report.menuFallback?.quoted) notes.push('模板套餐这家店用不了，按门店实际菜单挑的');
    if (!report.candidates.length) {
      task.done();
      // The card names the real cause: only a budget shortfall ever suggests raising the budget.
      const empty = renderEmpty(report, P);
      ui.result(empty.title, empty.lines, 'yellow');
      return finish({ status: 'empty', cause: emptyCause(report).cause, report });
    }

    // 6. Final pick: the wheel, or the recommend + optimise agents deciding internally.
    step(6, intent.finish === 'wheel' ? '转盘揭晓' : '饭搭子双 Agent 挑选');
    let plan, reason = '';
    if (intent.finish === 'wheel') {
      const spun = session.spin();
      plan = spun.plan; reason = `转盘从预算内 ${spun.pool.length} 份候选里随机揭晓`;
      log(`从 ${spun.pool.length} 份候选中随机揭晓`, renderPick(plan, P, { report, coupons: session.couponPicture().usable }));
    } else {
      let result;
      try {
        result = await session.buddy({ mood: intent.mood, signal, onStage: (role) => task.progress(`${current} · ${role === 'recommend' ? '挑选中' : '复核中'}`) });
      } catch (e) {
        if (signal?.aborted || !session.hasDeepSeek || (e instanceof DeepSeekError && e.code === 'cancelled')) throw e;
        result = await session.buddy({ mood: intent.mood, local: true });
        result.fallback = message(e);
        notes.push('DeepSeek 没有完成，用本地偏好推荐');
      }
      log(result.source === 'deepseek'
        ? result.stages.map((s) => `${s.role === 'recommend' ? '推荐' : '优化'} Agent → ${report.candidates.find((p) => p.id === s.primaryId)?.title}（${(s.durationMs / 1000).toFixed(1)}s）`).join('；')
        : `本地偏好推荐${result.fallback ? `（DeepSeek 未完成：${result.fallback}）` : ''}`,
      renderAgentResult(result, P, { report, remaining: session.remainingSeconds() }));
      plan = result.plans[0]; reason = pickReason(plan);
    }
    task.done();
    ui.result('这一餐就吃', renderAnswer(plan, P, { storeName: session.store?.storeName, report, remaining: session.remainingSeconds(), reason, notes }));
    maybeReceipt(ui, session);
    return finish({ status: 'picked', plan, report });
  } catch (e) {
    task.done();
    const why = message(e), cancelled = Boolean(signal?.aborted);
    if (current) log(P.red(`没完成：${why}`));
    ui.result(cancelled ? '已取消' : '没挑出来', [cancelled ? '已取消，这次没有挑选。' : `第 ${current.split('/')[0] || 1} 步「${title || '准备'}」没完成：${why}`,
      P.gray('/why 查看已经完成的步骤')], 'yellow');
    return finish({ status: 'failed', error: why });
  }
}
