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
import { TuiError } from './session.mjs';
import { renderIntent, renderReport, renderAgentResult, renderPick, renderRecentEats, renderCoupons, renderAnswer, pickReason } from './render.mjs';
import { maybeReceipt } from './receipt.mjs';
import { stripAllergyText } from './allergy.mjs';
import { storeStatus } from '../web/store-search.mjs';

const message = (e) => e instanceof TuiError || e instanceof MCPError || e instanceof DeepSeekError ? e.message : (e?.message || '未完成');
const STEPS = 6;

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
        const stores = await session.searchStores(target.city, target.keyword);
        const open = stores.find((s) => s.businessStatus === true);
        const where = target.isDefault ? `默认区域 ${target.label}` : `${target.city} · ${target.keyword}`;
        if (!open) throw new TuiError(stores.length ? `${where}找到 ${stores.length} 家门店，但官方未确认营业中。可用 /store ${target.city} ${target.keyword} 查看后手动选择。` : `${where}没有找到门店，在指令里加 @城市 关键词，或用 /store 换个位置。`);
        session.selectStore(open, target.city);
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
    session.setRequest({ people: intent.people, portion: intent.portion, budgetPerPersonFen: intent.budgetPerPersonFen, avoidMainCodes: [...avoid],
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
    if (!report.candidates.length) {
      task.done();
      ui.result('没有找到合适的', [P.yellow('预算内没有候选。'), `可以提高人均预算、调整食量或减少避开项后再试。${report.allergy?.excluded.length ? `过敏筛选排除了 ${report.allergy.excluded.length} 份，不会为了凑数放宽。` : ''}`,
        P.gray('/why 查看核价明细')], 'yellow');
      return finish({ status: 'empty', report });
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
