// Local executor. The model can only name an intent. Coupons and orders stay behind the store question.
import { money } from './ansi.mjs';
import { decide } from '../core/hub.mjs';
import { rankCandidates, blindboxPick, factReason } from '../core/pick.mjs';
import { RETRY_PHRASE, canRetry, classifyFailure, recordAttempt } from '../core/order.mjs';
import { allOut } from '../core/eligibility.mjs';
import { meatsInName } from '../core/menu.mjs';
import { renderCouponTable } from '../core/coupons.mjs';
import { stripAllergyText } from '../core/memory.mjs';
import { answerMeat, answerParts, answerIngredients, renderInfoAnswer } from './info.mjs';
import { isStoreConfirm, renderBuySummary, renderPayment,
  BUY_NO_PICK, BUY_DEMO, BUY_CANCELLED, PICKUP_ONLY, NO_PENDING, PAY_FOLLOWUP } from './buy.mjs';

const NUMBER = /^(?:([123])|第([一二三])个(?:就好|吧|了)?)$/;
const CN = { 一: 1, 二: 2, 三: 3 };
const GREETING = /^(?:你好|您好|谢谢|谢谢你|多谢|感谢)(?:呀|啊|哦|！|!|。|\.|~|～)*$/;

export function couponPriceLine(plan) {
  const after = ((plan.priceFen || 0) / 100).toFixed(2);
  const save = ((plan.savingFen > 0 ? plan.savingFen : 0) / 100).toFixed(2);
  return `券后 ¥${after}（省 ¥${save}）`;
}

// The receipt at order time, frozen: a later recommendation must not change what "重试" retries.
const snapshotReceipt = (receipt) => {
  if (!receipt) return null;
  try { return structuredClone(receipt); } catch { return { ...receipt }; }
};

export function createExecutor({ session, ui, ask, message }) {
  const P = ui.palette;

  function showNumbered(plans, { local = false, localNote = '', blindbox = false, skips = [], query = '' } = {}) {
    if (!plans.length) {
      ui.panel('没有能点的餐', [skips.map((s) => s.line).filter(Boolean).join('\n') || allOut(skips.length), P.gray('换家店或调预算试试。')], 'yellow');
      session.lastDetails = { query, lines: skips.map((s) => s.line) };
      return;
    }
    session.ranked = plans;
    session.lastOrderAttempt = null; // A new recommendation supersedes any failed order attempt.
    session.recordPick(plans[0]);
    const lines = [];
    if (local) lines.push(P.yellow(localNote || '本地模式：没有 DeepSeek key，按券后价编号。资格门和确认门仍然在。'));
    if (blindbox) lines.push(P.bold('盲盒'));
    plans.forEach((plan, i) => {
      const reason = factReason(plan, { rank: i + 1, taste: session.taste, cheaper: i === 0 ? 0 : 1 });
      lines.push(`${P.bold(`${i + 1}. ${plan.title}`)}  ${couponPriceLine(plan)}${plan.sample || session.demo ? P.gray('（样本价）') : ''}`);
      if (reason) lines.push(`理由：${reason}`);
      lines.push(P.gray(`  ${(plan.parts || []).map((p) => p.name).join('、')}`));
    });
    for (const s of skips) if (s.line) lines.push(P.gray(s.line));
    if (session.couponTable?.length) {
      lines.push(P.bold('券折算'));
      for (const row of renderCouponTable(session.couponTable)) lines.push(P.gray(`  ${row}`));
    }
    lines.push(P.gray(`门店：${session.store?.storeName || '未选门店'} · /why 看挑选过程`));
    ui.result(blindbox ? '盲盒' : '编号推荐', lines);
    session.lastDetails = { query, lines };
  }

  async function ensureQuoted(signal) {
    if (session.report?.candidates?.length && session.fresh()) return session.report;
    if (!session.store && session.demo) return null;
    return session.quote((p) => p?.text && ui.write(P.gray(p.text)), { signal });
  }

  // Budget from the model only ever applies to (re)picking, and only when it actually
  // changes: an unchanged budget must not invalidate the wheel and wipe the pick,
  // or the buy preview loses its context ("缺少下单所需信息").
  function applyBudget(budget) {
    if (budget == null || !Number.isFinite(budget)) return;
    const fen = Math.round(budget * 100);
    if (fen !== session.request.budgetPerPersonFen) session.setProfile({ budgetPerPersonFen: fen });
  }

  async function recommend({ local = false, query = '', budget, signal, localNote = '' } = {}) {
    applyBudget(budget);
    const step = ui.begin(local ? '本地编号（按券后价）' : '为你挑选这一餐');
    try {
      step.progress('核价候选…');
      const report = await ensureQuoted(signal);
      step.done();
      const pool = report?.candidates || [];
      const { ranked, skipped, emptyLine } = rankCandidates(pool, { taste: session.taste, budgetFen: session.request.budgetPerPersonFen });
      if (!ranked.length) {
        ui.panel('没有能点的餐', [emptyLine || allOut(skipped.length), ...skipped.map((s) => s.line)], 'yellow');
        session.lastDetails = { query, lines: [emptyLine, ...skipped.map((s) => s.line)] };
        return;
      }
      showNumbered(ranked, { local, localNote, skips: [...(report?.eligibilitySkipped || []), ...skipped], query });
    } catch (e) { step.fail(message(e)); }
  }

  function selectIndex(index) {
    const plan = session.ranked?.[index] || session.report?.candidates?.[index];
    if (!plan) return null;
    session.recordPick(plan);
    return plan;
  }

  function infoFromCache(kind, { meat = '牛肉' } = {}) {
    const pick = session.lastPick;
    const cache = Object.values(session.detailCache || {});
    // Match the picked meal by orderItems productCode only. pick.id is a template id,
    // not a productCode. Prefer a real detail over an unknown placeholder, and never
    // an unrelated cached entry: answering "有什么料" with another meal is worse than saying so.
    const codes = new Set((pick?.orderItems || []).map((i) => i?.productCode).filter(Boolean));
    const cached = pick ? cache.find((d) => d && codes.has(d.code) && !d.unknown) || cache.find((d) => d && codes.has(d.code)) || null : null;
    const names = [...(pick?.parts || []).map((p) => p.name), ...(cached?.parts || []).map((p) => p.name), pick?.title].filter(Boolean);
    if (!pick && !cached) return ui.info('没查到。这轮上下文里没有这份餐的配料。');
    if (kind === 'info_meat') {
      const answer = answerMeat({ names, meat });
      ui.panel('肉类', renderInfoAnswer(answer, P));
      return;
    }
    if (kind === 'info_parts') {
      const answer = answerParts({ name: pick?.title || cached?.name, parts: pick?.parts || cached?.parts || [] });
      ui.panel('组成', renderInfoAnswer(answer, P, { storeName: session.store?.storeName || '' }));
      return;
    }
    if (!cached) return ui.info(`没查到「${pick?.title || ''}」的配料：接口没有返回这份餐的详情，不编。`);
    const answer = answerIngredients({ name: pick?.title || cached?.name || '', detail: { name: cached.name, extras: cached.removable || [], rounds: [] }, parts: pick?.parts || [], names });
    const lines = renderInfoAnswer(answer, P);
    if (!cached?.complete) lines.push(P.gray('不是完整配料表：接口只给了可去掉的料和组成，没有完整配料表。'));
    if (cached?.unknown) lines.unshift('配料未知');
    ui.panel('配料', lines);
  }

  async function runBuyFlow({ retrying = false } = {}) {
    if (!session.lastReceipt) return ui.info(BUY_NO_PICK);
    const look = ui.begin(session.demo ? '下单前查券（样本）' : '下单前查券（available-coupons · 券包，只读）');
    let preview;
    try { preview = await session.buyPreview({ onProgress: (p) => look.progress(p.text) }); look.ok(''); }
    catch (e) { return look.fail(message(e)); }
    ui.panel(`就吃这个 · 到店自取${preview.demo ? '（演示）' : ''}`, renderBuySummary(preview, P), 'yellow');
    if (!isStoreConfirm(await ask('是这家店吗？> '))) return ui.info(BUY_CANCELLED);
    // Test-only: demo never calls create-order. This records a failed attempt so a PTY can
    // prove「创建」retries that attempt. It does not run unless MCD_TEST_ORDER_FAIL=1.
    if (preview.demo && process.env.MCD_TEST_ORDER_FAIL === '1') {
      const classified = classifyFailure(new Error('测试拒单'));
      const prev = session.lastOrderAttempt;
      const attempt = recordAttempt(prev, { ...classified, storeCode: session.store?.storeCode || null, cartSnapshot: preview.receipt?.title, receiptSnapshot: snapshotReceipt(preview.receipt) });
      if (retrying && classified.status === 'failed' && !classified.ambiguous && !classified.duplicate) attempt.retries = (prev?.retries || 0) + 1;
      session.lastOrderAttempt = attempt;
      return ui.error('测试拒单 没下单。可以说「重试」。');
    }
    if (preview.demo) return ui.error(`${BUY_DEMO}：没有领券，也没有调用 create-order。`);
    const confirmed = true;
    if (preview.claimable.length) {
      const claiming = ui.begin('领券（auto-bind-coupons）');
      try { const r = await session.buyClaim(preview, { confirmed }); claiming.ok(`已领取 ${r.claimed} 张`); }
      catch (e) { return claiming.fail(`${message(e)} 没下单。`); }
    }
    const pricing = ui.begin('重新核价（calculate-price）');
    let priced;
    try { priced = await session.buyReprice(preview, { confirmed, onProgress: (p) => pricing.progress(p.text) }); }
    catch (e) { return pricing.fail(`${message(e)} 没下单。`); }
    const was = preview.receipt.priceFen;
    pricing.ok(`最终合计 ${P.bold(money(priced.priceFen))}${priced.priceFen < was ? `（比刚才 ${money(was)} 少 ${money(was - priced.priceFen)}）` : '（和刚才一样）'}${priced.couponNames.length ? ` · 用券：${priced.couponNames.join('、')}` : ''}`);
    const placing = ui.begin('创建麦当劳订单（create-order · 到店自取）');
    try {
      const result = await session.buyPlace(preview, priced, { confirmed });
      placing.ok('');
      session.lastOrderAttempt = null;
      ui.write('');
      renderPayment(result.order, P, { columns: ui.columns() }).forEach((line) => ui.write(line));
      if (result.order.hashes?.length) ui.info(`已移出购物车：${result.order.title}`);
      ui.write(P.gray('订单已记录。付款在支付链接或麦当劳 App。'));
    } catch (e) {
      const classified = classifyFailure(e);
      const prev = session.lastOrderAttempt;
      const attempt = recordAttempt(prev, { ...classified, storeCode: preview.context?.storeCode, cartSnapshot: preview.receipt?.title, receiptSnapshot: snapshotReceipt(preview.receipt) });
      if (retrying && classified.status === 'failed' && !classified.ambiguous && !classified.duplicate) attempt.retries = (prev?.retries || 0) + 1;
      session.lastOrderAttempt = attempt;
      const extra = classified.ambiguous || classified.status === 'unknown'
        ? '结果不明确，请先在麦当劳 App 核对，本次不自动重试。'
        : classified.duplicate ? '这单可能已经创建，请先查订单，不要重新下单。' : '可以说「重试」。';
      return placing.fail(`${message(e)} 没下单。${extra}`);
    }
  }

  async function retry() {
    const gate = canRetry(session.lastOrderAttempt);
    if (!gate.ok) return ui.info(gate.message);
    // Retry the failed order's own snapshot, not whatever the user picked afterwards.
    const snapshot = session.lastOrderAttempt.receiptSnapshot || session.lastReceipt;
    if (!snapshot) return ui.info(BUY_NO_PICK);
    ui.info('按上次失败的这一单重试，不会重新选餐。');
    session.lastReceipt = snapshot;
    return runBuyFlow({ retrying: true });
  }

  async function runIntent(intent, { query = '', signal } = {}) {
    if (intent?.degraded === 'timeout') {
      ui.panel('这轮超时', ['按本地规则没能问完模型。资格门和确认门没有跳过。', '可以说得再具体一点，或直接说 1、2、3。'], 'yellow');
      return;
    }
    if (intent?.degraded === 'degraded') {
      // Auth/balance/rate/network: the model's problem, not the user's phrasing.
      // Say what actually happened, then fall back to local numbered picks.
      return recommend({ local: true, query, signal, localNote: `${intent.errorMessage || '模型暂不可用'}（本地模式）` });
    }
    switch (intent?.kind) {
      case 'recommend': return recommend({ query, budget: intent.slots?.budget_yuan, signal });
      case 'blindbox': {
        applyBudget(intent.slots?.budget_yuan);
        await ensureQuoted(signal);
        const drawn = blindboxPick(session.report?.candidates || [], { taste: session.taste, budgetFen: session.request.budgetPerPersonFen, random: session.random });
        if (!drawn.plan) return ui.panel('没有能点的餐', [drawn.emptyLine], 'yellow');
        showNumbered([drawn.plan], { blindbox: true, skips: drawn.skipped, query });
        return runBuyFlow();
      }
      case 'select_candidate': {
        const index = intent.candidate_index ?? 0;
        if (!selectIndex(index)) return ui.info('没有这个编号。先看 1、2、3。');
        return runBuyFlow();
      }
      case 'confirm_pick': return runBuyFlow();
      case 'retry_order': return retry();
      case 'info_meat': return infoFromCache('info_meat', { meat: intent.slots?.want && meatsInName(intent.slots.want)[0] || '牛肉' });
      case 'info_parts': return infoFromCache('info_parts');
      case 'info_ingredients': return infoFromCache('info_ingredients');
      case 'price_ask': {
        const plan = session.lastPick || session.ranked?.[0];
        if (!plan) return ui.info('不知道，这轮还没有核过价。');
        return ui.info(`${plan.title} ${couponPriceLine(plan)}`);
      }
      case 'register_allergy': return ui.info('要记录过敏请用 /allergy 加名称，例如 /allergy 花生。忌口只记在本机。');
      case 'chitchat': return ui.info(intent.answer || '你好。说预算或直接说 1、2、3 就行。');
      case 'help': return ui.info(intent.answer || '说一句话选餐，或者说 1、2、3。下单前会问是这家店吗。');
      default: return ui.info('没理解，能再说一遍吗');
    }
  }

  async function handleText(text, { signal } = {}) {
    const stripped = stripAllergyText(text, session.allergies);
    session.noteTurn(stripped);
    if (!stripped) return;
    if (GREETING.test(stripped)) return ui.info('你好。想吃的话直接说预算，或者说 1、2、3。');
    const num = NUMBER.exec(stripped.replace(/\s/g, ''));
    if (num && (session.ranked?.length || session.lastPick)) {
      const index = (num[1] ? Number(num[1]) : CN[num[2]]) - 1;
      if (!selectIndex(index)) return ui.info('没有这个编号。');
      return runBuyFlow();
    }
    if (RETRY_PHRASE.test(stripped) && session.lastOrderAttempt && session.lastOrderAttempt.status !== 'success') return retry();
    const llm = session.llmClient;
    if (!llm) return recommend({ local: true, query: stripped, signal });
    const step = ui.begin('理解这句话');
    let intent;
    try {
      step.progress('问模型…');
      intent = await decide({ session, text: stripped, llm, signal, runTool: (name, args, opts) => session.runTool(name, args, opts) });
      step.done();
    } catch (e) { step.fail(message(e)); return; }
    return runIntent(intent, { query: stripped, signal });
  }

  return { handleText, runIntent, runBuyFlow, retry, recommend, infoFromCache, showNumbered };
}

export { PICKUP_ONLY, NO_PENDING, PAY_FOLLOWUP };
