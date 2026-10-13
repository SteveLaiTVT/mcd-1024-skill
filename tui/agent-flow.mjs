// Natural-language agent mode. The program owns the step order and only ever
// calls read-only MCP tools; DeepSeek parses intent and picks among verified
// candidates. auto-bind-coupons, ordering and payment are never reachable here.
import { MCPError } from '../web/mcp-client.mjs';
import { DeepSeekError } from '../web/deepseek-client.mjs';
import { calendarContext } from '../web/agent-context.mjs';
import { parseLocalIntent, agentIntent, mergeIntent, DEFAULT_STORE_SEARCH } from './intent.mjs';
import { TuiError } from './session.mjs';
import { renderIntent, renderReport, renderAgentResult, renderPick, renderRecentEats, renderCoupons } from './render.mjs';
import { maybeReceipt } from './receipt.mjs';
import { stripAllergyText } from './allergy.mjs';
import { storeStatus } from '../web/store-search.mjs';

const message = (e) => e instanceof TuiError || e instanceof MCPError || e instanceof DeepSeekError ? e.message : (e?.message || '未完成');

export async function runAgentFlow(session, text, ui, { signal } = {}) {
  const P = ui.palette, steps = 6;
  const run = async (n, title, fn) => {
    const step = ui.begin(`${n}/${steps} ${title}`);
    try { return await fn(step); }
    catch (e) { step.fail(message(e)); throw Object.assign(new Error(message(e)), { reported: true }); }
  };
  const check = () => { if (signal?.aborted) throw new TuiError('已取消。'); };

  try {
    // 1. Intent: local parser always; DeepSeek fills gaps when a key is available.
    const intent = await run(1, '理解需求', async (step) => {
      const local = parseLocalIntent(text, session.mainNames);
      let model = {}, via = '本地规则解析';
      // Allergy clauses and recorded allergen names never leave the process.
      const outbound = stripAllergyText(text, session.allergies);
      if (session.hasDeepSeek && outbound) {
        step.progress('需求理解 Agent（DeepSeek）正在整理条件…（只发送这句话和主食名称列表；过敏信息不发送）');
        try { model = await agentIntent(session.deepseek, outbound, session.mainNames, { calendar: calendarContext(session.now()), signal }); via = '本地规则 + DeepSeek 需求理解 Agent'; }
        catch (e) { via = `本地规则解析（DeepSeek 未完成：${message(e)}）`; }
      }
      check();
      const merged = mergeIntent(local, model, session.profile);
      const store = merged.city ? `${merged.city} · ${merged.keyword}（指令）`
        : session.demo ? `${session.store.storeName}（样本模式不搜索；实时模式默认搜 ${DEFAULT_STORE_SEARCH.label}）`
        : session.store ? `沿用 ${session.store.storeName}` : `默认 ${DEFAULT_STORE_SEARCH.label} 附近`;
      const allergies = session.allergies;
      step.ok(via, [...renderIntent(merged, session.mainNames, P, { store }),
        ...(allergies.length ? [P.yellow(`过敏：${allergies.join('、')} → 核价后在本地按名称关键词排除，成分不明的也排除（不发送给 DeepSeek / MCP）`)] : [])]);
      return merged;
    });

    // 2. Connection.
    await run(2, '连接麦当劳 MCP', async (step) => {
      if (session.demo) return step.skip('样本模式：使用 2026-10-10 深圳样本门店的历史报价');
      if (session.connected) return step.ok('已连接');
      step.progress('initialize → now-time-info …');
      await session.connect(); step.ok('已连接（Token 来自环境变量，仅在内存）');
    });
    check();

    // 3. Store.
    await run(3, '选择门店', async (step) => {
      if (session.demo) return step.skip(`样本门店：${session.store.storeName}`);
      // Instruction location > store picked with /store (or a previous run) > default area.
      const target = intent.city && intent.keyword ? { city: intent.city, keyword: intent.keyword } : session.store ? null : { ...DEFAULT_STORE_SEARCH, isDefault: true };
      if (!target) return step.ok(`沿用 ${session.store.storeName}`);
      step.progress(`query-nearby-stores：${target.city} · ${target.keyword}${target.isDefault ? '（默认区域）' : ''} …`);
      const stores = await session.searchStores(target.city, target.keyword);
      const open = stores.find((s) => s.businessStatus === true);
      const where = target.isDefault ? `默认区域 ${target.label}` : `${target.city} · ${target.keyword}`;
      if (!open) throw new TuiError(stores.length ? `${where}找到 ${stores.length} 家门店，但官方未确认营业中。可用 /store ${target.city} ${target.keyword} 查看后手动选择。` : `${where}没有找到门店，在指令里加 @城市 关键词，或用 /store 换个位置。`);
      session.selectStore(open, target.city);
      return step.ok(`${open.storeName} · ${storeStatus(open)}`, [
        ...(target.isDefault ? [P.yellow(`指令未给位置，默认搜索 ${target.label} 附近；指令里写 @城市 关键词 或 /store 可覆盖。`)] : []),
        P.gray(`按“${target.keyword}”返回的第一家营业中门店；共 ${stores.length} 家，可用 /store 更换。`)]);
    });
    check();

    // 4. Recent eats and drinks from completed orders (order-list only); optionally avoid recent mains.
    const avoid = new Set(intent.avoidMainCodes);
    await run(4, '读历史：最近吃了啥 / 喝了啥', async (step) => {
      const named = avoid.size ? [P.gray(`按指令避开 ${avoid.size} 种主食：${[...avoid].map((c) => session.mainNames.get(c) || c).join('、')}`)] : [];
      if (session.demo) {
        await session.radar();
        return step.ok('样本模式：虚构示例历史', [...renderRecentEats(session.history, P, { limit: 4 }), ...named,
          ...(intent.avoidRecentDays ? [P.yellow('虚构历史不能用于避开主食，本次不按历史避开。')] : [])]);
      }
      step.progress('now-time-info → order-list（只计已完成 / 已评价订单）…');
      try { await session.radar(); }
      catch (e) { return step.warn(`历史订单读取未完成：${message(e)}。${intent.avoidRecentDays ? '本次不按历史避开，' : ''}未返回不等于没吃过。`); }
      const lines = [...renderRecentEats(session.history, P, { limit: 4 }), ...named];
      if (!intent.avoidRecentDays) return step.ok(`${session.history.orders.length} 笔已完成订单`, lines);
      const codes = session.recentMains(intent.avoidRecentDays);
      codes.forEach((c) => avoid.add(c));
      const label = intent.avoidRecentDays === 1 ? '昨天' : '前两天';
      step.ok(codes.length ? `${label}吃过的主食将避开：${codes.map((c) => session.mainNames.get(c) || c).join('、')}` : `${label}没有返回可识别的主食`,
        [...lines, P.gray('接口无分页，覆盖可能不完整；只匹配已知主食编码。')]);
    });
    check();
    session.setRequest({ people: intent.people, portion: intent.portion, budgetPerPersonFen: intent.budgetPerPersonFen, avoidMainCodes: [...avoid],
      wantMainCodes: (intent.wantMainCodes || []).filter((c) => !avoid.has(c)) });
    if (intent.goal) session.preferences = { ...session.preferences, goal: intent.goal };

    // 5. Coupons + whole-cart quotes.
    const report = await run(5, '查券与官方整单核价', async (step) => {
      const r = await session.quote((p) => step.progress(p.text));
      const singles = r.quotedPlans.filter((p) => p.kind === 'alacarte').length;
      step.ok(`${r.counts.quotedPlans - singles} 份完整套餐${singles ? ` + ${singles} 份单点主食` : ''}已核价，预算内 ${r.candidates.length} 份`, [...renderReport(r, P, { remaining: session.remainingSeconds() }),
        ...renderCoupons(session.couponPicture(), P, { demo: session.demo })]);
      return r;
    });
    check();
    if (!report.candidates.length) {
      ui.result('没有找到合适的', [P.yellow(`预算内没有候选。可以提高人均预算、调整食量或减少避开项后再试。${report.allergy?.excluded.length ? `过敏筛选排除了 ${report.allergy.excluded.length} 份（见上方），不会为了凑数放宽。` : ''}`)], 'yellow');
      return { status: 'empty', report };
    }

    // 6. Final pick: wheel, or recommend + optimize agents.
    return await run(6, intent.finish === 'wheel' ? '转盘揭晓' : '饭搭子双 Agent 挑选', async (step) => {
      if (intent.finish === 'wheel') {
        const { plan, pool } = session.spin();
        step.ok(`从 ${pool.length} 份候选中随机揭晓`);
        ui.result('这一餐就吃', renderPick(plan, P, { report, remaining: session.remainingSeconds(), coupons: session.couponPicture().usable }));
        maybeReceipt(ui, session);
        return { status: 'picked', plan, report };
      }
      if (session.hasDeepSeek) step.progress('只发送：最近吃过的餐品名、口味反馈、券名称 / 到期 / 可省金额、天气与季节；不发送地址、电话、支付、订单号或 Token');
      let result;
      try {
        result = await session.buddy({ mood: intent.mood, signal, onStage: (role) => step.progress(role === 'recommend' ? '推荐 Agent 正在按最近吃过的、手里的券、口味和节令挑选…' : '优化 Agent 正在复核偏好、快过期的券与候选价格…') });
      } catch (e) {
        if (signal?.aborted || !session.hasDeepSeek || (e instanceof DeepSeekError && e.code === 'cancelled')) throw e;
        step.progress(`DeepSeek 未完成：${message(e)} 改用本地偏好推荐…`);
        result = await session.buddy({ mood: intent.mood, local: true });
        result.fallback = message(e);
      }
      step.ok(result.source === 'deepseek' ? result.stages.map((s) => `${s.role === 'recommend' ? '推荐' : '优化'} Agent → ${report.candidates.find((p) => p.id === s.primaryId)?.title}（${(s.durationMs / 1000).toFixed(1)}s）`).join('；') : `本地偏好推荐${result.fallback ? `（DeepSeek 未完成：${result.fallback}）` : ''}`);
      ui.result('这一餐就吃', renderAgentResult(result, P, { report, remaining: session.remainingSeconds() }));
      maybeReceipt(ui, session);
      return { status: 'picked', plan: result.plans[0], report };
    });
  } catch (e) {
    if (!e.reported) ui.error(message(e));
    return { status: 'failed', error: message(e) };
  }
}
