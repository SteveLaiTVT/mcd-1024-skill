// Command core shared by the Ink app (TTY) and the piped runner: every command, the
// natural-language buy flow and the agent flow. It never touches the terminal itself — output
// goes through `ui` (ui.mjs) and confirmations through `ask(prompt)`, which resolves to the
// user's next line (or null when input ended).
import { MCPError } from '../web/mcp-client.mjs';
import { DeepSeekError } from '../web/deepseek-client.mjs';
import { budgetFen } from '../web/meal-engine.mjs';
import { padEnd, money } from './ansi.mjs';
import { TuiError } from './session.mjs';
import { runAgentFlow } from './agent-flow.mjs';
import { NOTICE, statusLine, renderStores, renderBenefits, renderReport, renderAgentResult, renderAnswer, renderHeatmap, helpLines, renderClaimable, renderAllergies,
  renderActivities, HELP_COMMANDS } from './render.mjs';
import { GOALS, MOODS, DEFAULT_INTENT, DEFAULT_STORE_SEARCH, isActivityQuery, parseBuyIntent } from './intent.mjs';
import { parseAllergyStatement } from './allergy.mjs';
import { printReceipt, maybeReceipt } from './receipt.mjs';
import { parseCommitNote, renderGraph, renderCart, commitLine, headOf, cartOf, unpushed, CART_USAGE } from './orders.mjs';
import { renderRadar, NO_PICK_RADAR } from './radar-chart.mjs';
import { matchCommands, paletteLines } from './palette.mjs';
import { isStoreConfirm, isPaymentReply, renderBuySummary, renderPayment, renderPlaced, renderOrderStatus,
  BUY_NO_PICK, BUY_DEMO, BUY_CANCELLED, PICKUP_ONLY, NO_PENDING, PENDING, PAY_FOLLOWUP } from './buy.mjs';

export const message = (e) => e instanceof TuiError || e instanceof MCPError || e instanceof DeepSeekError ? e.message : `未完成：${e?.message || e}`;
export const FAREWELL = '再见。凭证只在本次进程内存中，已随退出清除。';

export function createShell({ session, ui, ask, quit = () => {}, autoConnect = true }) {
  const P = ui.palette;
  let pendingStores = null, controller = null, busy = false, interrupted = false;

  const showReport = (report) => ui.panel('核价结果', renderReport(report, P, { remaining: session.remainingSeconds() }));
  const avoidLines = () => {
    const cells = [...session.mainNames].map(([code, name], i) => `${String(i + 1).padStart(2)}. ${session.request.avoidMainCodes.includes(code) ? P.yellow(`[避开]${name}`) : name}`);
    const rows = [];
    for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3).map((c) => padEnd(c, 24)).join(''));
    return [...rows, P.gray('/avoid 名称或序号 切换；/avoid clear 清空。条件变化后需重新 /price。')];
  };
  // A pick from /wheel or /buddy ends like the agent flow: one answer card.
  const answer = (plan, reason, title = '这一餐就吃') => {
    ui.result(title, renderAnswer(plan, P, { storeName: session.store?.storeName, report: session.report, remaining: session.remainingSeconds(), reason }));
    maybeReceipt(ui, session);
  };

  async function quote() {
    const step = ui.begin('查券与官方整单核价');
    try { const report = await session.quote((p) => step.progress(p.text)); step.ok(`预算内 ${report.candidates.length} 份`); showReport(report); }
    catch (e) { step.fail(message(e)); }
  }

  const commands = {
    help: () => ui.panel('命令', helpLines(P)),
    status: () => ui.write(statusLine(session, P)),
    clear: () => ui.clear(),
    async connect() {
      const step = ui.begin('连接麦当劳 MCP');
      try { step.progress('initialize → now-time-info …'); await session.connect(); step.ok('已连接（Token 来自环境变量 MCD_TOKEN，仅在内存）'); }
      catch (e) { step.fail(message(e)); }
    },
    async store(args) {
      const fallback = !args.length, city = fallback ? DEFAULT_STORE_SEARCH.city : args[0].replace(/市$/, ''), keyword = fallback ? DEFAULT_STORE_SEARCH.keyword : args.slice(1).join(' ');
      const step = ui.begin(fallback ? `查询到店门店（默认区域 ${DEFAULT_STORE_SEARCH.label}）` : '查询到店门店');
      try { const stores = await session.searchStores(city, keyword); step.ok(`${stores.length} 家`); pendingStores = { stores: stores.slice(0, 12), city }; ui.panel(`门店 · ${city} ${keyword}`, renderStores(stores, P)); }
      catch (e) { step.fail(message(e)); }
    },
    use(args) { return selectStore(Number(args[0])); },
    async coupons() {
      if (session.demo) return ui.panel('优惠口袋 · 样本', [...renderClaimable(session.couponPicture().claimable, P, { sample: true, limit: 12 }), '',
        P.gray('样本模式不读取券包；连接 MCP 后 /coupons 会在可领券之后列出你持有的券。'), P.gray('活动与参与方式：/activity')]);
      const step = ui.begin('查券（可领 · 持有 · 门店适用 · 活动日历）');
      try { const b = await session.coupons((p) => step.progress(p.text)); step.ok(''); ui.panel('优惠口袋', renderBenefits(b, P, { picture: session.couponPicture() })); }
      catch (e) { step.fail(message(e)); }
    },
    async activity() {
      const step = ui.begin('活动日历（campaign-calendar，只读）');
      try { const r = await session.activities((p) => step.progress(p.text)); step.ok(`${r.rows.length} 项`); ui.panel('活动', renderActivities(r, P)); }
      catch (e) { step.fail(message(e)); }
    },
    allergy(args) {
      if (args.length) {
        try { confirmAllergyAdd(session.addAllergies(args), args); }
        catch (e) { return ui.error(message(e)); }
      }
      ui.panel('过敏记录', renderAllergies(session.allergies, P, { file: session.profilePath || '', error: session.profileError }));
    },
    'allergy-clear'(args) {
      if (!args.length) return ui.error('用法：/allergy-clear 花生（删除一项过敏记录）');
      try {
        const r = session.removeAllergies(args);
        if (!r.removed.length) return ui.error(`过敏记录里没有：${args.join('、')}。当前：${session.allergies.join('、') || '无'}`);
        ui.info(`已删除过敏记录：${r.removed.join('、')}${savedNote(r.saved)}。当前：${session.allergies.join('、') || '无'}。请重新 /price。`);
      } catch (e) { ui.error(message(e)); }
    },
    set(args) {
      try {
        const [people, portion, budget] = args;
        const change = {};
        if (people !== undefined) { if (!['1', '2', '3', '4'].includes(people)) throw new TuiError('人数请填 1–4。'); change.people = Number(people); }
        if (portion !== undefined) { if (!['5', '7', '9'].includes(portion)) throw new TuiError('食量请填 5、7 或 9。'); change.portion = Number(portion); }
        if (budget !== undefined) change.budgetPerPersonFen = budgetFen(budget);
        session.setProfile(change); ui.write(statusLine(session, P));
      } catch (e) { ui.error(e.message); }
    },
    avoid(args) {
      if (args[0] === 'clear') session.setRequest({ avoidMainCodes: [] });
      else if (args.length) {
        const names = [...session.mainNames], current = new Set(session.request.avoidMainCodes);
        for (const arg of args) {
          const hit = /^\d+$/.test(arg) ? names[Number(arg) - 1] : names.find(([, name]) => name === arg);
          if (!hit) { ui.error(`没有找到主食“${arg}”。`); continue; }
          current.has(hit[0]) ? current.delete(hit[0]) : current.add(hit[0]);
        }
        session.setRequest({ avoidMainCodes: [...current] });
      }
      ui.panel('避开的主食', avoidLines());
    },
    price: quote,
    wheel() {
      try {
        const { plan, pool } = session.spin();
        ui.write(P.gray(`转盘：${pool.map((p) => p.wheelTitle || p.title).join(' · ')}`));
        answer(plan, `转盘随机揭晓（本轮还剩 ${session.wheel.remaining().length} 份）`, '转盘揭晓');
      } catch (e) { ui.error(message(e)); }
    },
    receipt() {
      if (!session.lastReceipt) return ui.error('还没有挑出的套餐：先说一句话、/wheel 或 /buddy，再 /receipt。');
      // Once this pick is committed, its card carries the commit note too.
      const head = headOf(session.orders);
      printReceipt(ui, session.lastReceipt, { note: head && head.pickedAt === session.lastReceipt.at ? head.note : '' });
    },
    commit(args, rest) {
      const parsed = parseCommitNote(rest);
      if (parsed.error) return ui.error(parsed.error);
      try {
        const { commit, saved } = session.commitOrder(parsed.note);
        ui.write(`${P.green('✓')} [main ${commitLine(commit, P)}]`);
        ui.write(P.gray(`  本地提交${ordersNote(saved)}；${unpushed(session.orders).length} 个未 push · /push 加入购物车 · /graph 看历史`));
      } catch (e) { ui.error(message(e)); }
    },
    push() {
      try {
        const { pushed, saved } = session.pushOrders();
        if (!pushed.length) ui.info('Everything up-to-date：没有未 push 的提交，购物车不变。');
        else ui.write(`${P.green('✓')} 已加入购物车 ${pushed.length} 单：${pushed.map((c) => P.yellow(c.hash)).join(' ')} → origin/main${ordersNote(saved)}`);
        ui.panel('购物车（本地清单）', renderCart(session.orders, P), 'yellow');
      } catch (e) { ui.error(message(e)); }
    },
    async cart(args) {
      const [sub, ref] = args;
      try {
        if (sub === 'rm') {
          if (!ref) return ui.error(CART_USAGE);
          const { removed, saved } = session.cartRemove(ref);
          ui.info(`已移出购物车：${removed.hash} ${removed.title}（回到未 push，历史保留）${ordersNote(saved)}`);
        } else if (sub === 'clear') {
          const cart = cartOf(session.orders);
          if (!cart.length) return ui.panel('购物车（本地清单）', renderCart(session.orders, P), 'yellow');
          ui.panel('清空购物车', [`购物车里有 ${cart.length} 单，合计 ${money(cart.reduce((s, c) => s + c.priceFen, 0))}。清空后它们回到未 push，提交历史保留。`,
            P.bold('确认清空请输入 yes，其他任何输入都会取消。')], 'yellow');
          const reply = await ask('确认清空？> ');
          if (reply?.trim().toLowerCase() !== 'yes') return ui.info('已取消，购物车没有变化。');
          const { removed, saved } = session.cartClear({ confirmed: true });
          ui.info(`已清空购物车（${removed.length} 单回到未 push）${ordersNote(saved)}`);
        } else if (sub) return ui.error(CART_USAGE);
      } catch (e) { return ui.error(message(e)); }
      ui.panel('购物车（本地清单）', renderCart(session.orders, P), 'yellow');
    },
    graph: () => ui.panel('提交历史 · git log --graph', renderGraph(session.orders, P)),
    async order(args) {
      if (!args.length) return ui.panel('真实订单', renderPlaced(session.orders.placed, P));
      await queryOrder(args[0]);
    },
    async buddy(args) {
      const mood = args.find((a) => MOODS.includes(a)) || 'normal', local = args.includes('local') || !session.hasDeepSeek;
      const step = ui.begin(local ? '本地偏好推荐' : '饭搭子双 Agent（DeepSeek）');
      controller = new AbortController();
      try {
        const result = await session.buddy({ mood, local, signal: controller.signal, onStage: (role) => step.progress(role === 'recommend' ? '挑选中…' : '复核中…') });
        step.done();
        session.lastDetails = { query: `/buddy ${args.join(' ')}`.trim(), lines: renderAgentResult(result, P, { report: session.report, remaining: session.remainingSeconds() }) };
        answer(result.plans[0], '');
        ui.write(P.gray('/like 喜欢这份 · /less 以后少推荐（只在本次会话内存）· /commit -m "备注" 记下这一餐'));
      } catch (e) { step.fail(message(e)); }
      finally { controller = null; }
    },
    why() {
      const d = session.lastDetails;
      if (!d) return ui.info('还没有挑选过程：先说一句话（比如“1人 7分饱 人均30”）或 /buddy。');
      ui.panel(`挑选过程 · ${d.query}`, d.lines, 'cyan');
    },
    prefs(args) {
      const [key, value] = args, options = { goal: GOALS, persona: ['cozy', 'frugal', 'playful'], mode: ['team', 'recommend', 'optimize'] };
      if (key && options[key]?.includes(value)) session.preferences = { ...session.preferences, [key]: value };
      else if (key) ui.error(`可选：${Object.entries(options).map(([k, v]) => `${k}=${v.join('/')}`).join('；')}`);
      const p = session.preferences;
      ui.write(`目标 ${p.goal} · 风格 ${p.persona} · Agent ${p.mode} · 本次会话反馈 ${p.feedback.length} 条`);
    },
    like: () => { try { ui.info(`已记住喜欢：${session.feedback('like').title}（仅本次会话）`); } catch (e) { ui.error(message(e)); } },
    less: () => { try { ui.info(`以后少推荐：${session.feedback('less').title}（仅本次会话）`); } catch (e) { ui.error(message(e)); } },
    async radar(args) {
      if (args[0] === 'apply') {
        if (session.history?.sourceKind !== 'official-history') return ui.error(session.history ? '虚构示例不能导入最近主食。' : '先 /radar 读取历史。');
        const codes = session.recentMains(2);
        if (!codes.length) return ui.info('前两天没有返回可识别的主食，可用 /avoid 手动选择。');
        session.setRequest({ avoidMainCodes: [...new Set([...session.request.avoidMainCodes, ...codes])] });
        return ui.info(`已加入避开：${codes.map((c) => session.mainNames.get(c) || c).join('、')}。请重新 /price。`);
      }
      const mode = args.includes('year') ? 'year' : 'recent', year = Number(args.find((a) => /^\d{4}$/.test(a))) || undefined;
      if (!session.history || args.includes('refresh')) {
        const step = ui.begin('读取历史订单（order-list）');
        try { step.progress('now-time-info → order-list …'); await session.radar(); step.ok(`${session.history.orders.length} 笔已完成订单`); }
        catch (e) { step.fail(message(e)); }
      }
      // Spider chart of the current pick first; without history its novelty axis says so instead of guessing.
      if (session.lastReceipt) ui.panel('本餐雷达图', renderRadar(session.lastReceipt, P, { history: session.history, feedback: session.preferences.feedback, mainNames: session.mainNames }));
      else ui.info(NO_PICK_RADAR);
      if (!session.history) return;
      try { ui.panel(`麦当劳雷达 · ${mode === 'year' ? '全年' : '近 12 周'}`, renderHeatmap(session.history, P, { mode, year })); }
      catch (e) { ui.error(message(e)); }
      const recent = session.recentMains(2);
      if (recent.length) ui.write(P.gray(`前两天可识别主食：${recent.map((c) => session.mainNames.get(c) || c).join('、')} · /radar apply 加入避开`));
    },
    async weather() {
      const step = ui.begin('城市天气（Open-Meteo，仅城市名）');
      try { const w = await session.readWeather(); step.ok(`${w.city} · ${w.description} ${w.temperatureC}°C（体感 ${w.feelsLikeC}°C）`); }
      catch (e) { step.fail(message(e)); }
    },
    async claim() {
      if (session.demo) return ui.error('样本模式不能领券。');
      if (!session.connected) return ui.error('尚未连接麦当劳 MCP，请先 /connect。');
      // Read-only look first, so the user sees what would be claimed before confirming.
      if (!session.benefits && session.store) {
        const step = ui.begin('查看可领券（只读，不领取）');
        try { await session.coupons((p) => step.progress(p.text)); step.ok(''); } catch (e) { step.warn(`可领券列表未查到：${message(e)}`); }
      }
      const claimable = session.benefits ? session.couponPicture().claimable : null;
      const listed = !claimable ? [P.gray('还没选门店，未能先列出可领券（/store 选店后 /coupons 可查看）。')]
        : claimable.length ? renderClaimable(claimable, P, { limit: 12 }).slice(0, -1) : renderClaimable(claimable, P);
      ui.panel('领取全部可领券', [...listed, '', '官方接口一次领取全部当前可领券，不能指定单张。', '领取后旧报价作废，会重新查券与核价；结果不明确时不会自动重试。', P.bold('确认领取请输入 yes，其他任何输入都会取消。')], 'yellow');
      const reply = await ask('确认领取？> ');
      if (reply?.trim().toLowerCase() !== 'yes') return ui.info('已取消，未领取。');
      const step = ui.begin('领取全部可领券（auto-bind-coupons）');
      try {
        const r = await session.claim({ confirmed: true });
        step.ok(r.successCount == null ? '请求已返回，数量待券包验证' : `已领取 ${r.successCount} 张${r.failedCount ? `，${r.failedCount} 张未成功` : ''}`);
      } catch (e) { step.fail(`${message(e)} 本次不自动重试；再次领券前请先 /coupons 核对。`); return; }
      if (session.store) await quote();
    },
    quit: () => quit(),
  };
  Object.assign(commands, { exit: commands.quit, q: commands.quit, h: commands.help, '?': commands.help });
  // /help must list every command the shell handles, and nothing it does not.
  const drift = [...Object.keys(commands).filter((k) => !HELP_COMMANDS.has(k)), ...[...HELP_COMMANDS].filter((k) => !commands[k])];
  if (drift.length) throw new Error(`命令表与 /help 不一致：${drift.join(', ')}`);

  const ordersNote = (ok) => ok ? `（已保存到本机 ${session.ordersPath}）` : session.ordersError ? `（${session.ordersError}，只在本次会话内生效）` : '（只在本次会话内存）';
  const savedNote = (ok) => ok ? `（已保存到本机 ${session.profilePath}）` : session.profileError ? `（${session.profileError}，只在本次会话内生效）` : '（只在本次会话内存）';
  function confirmAllergyAdd(r, tokens) {
    if (r.added.length) ui.info(`已记录过敏：${r.added.join('、')}${savedNote(r.saved)}。之后在本地排除名称含相关关键词或成分不明的餐品；不会发送给 DeepSeek 或 MCP。`);
    if (r.existing.length) ui.info(`已在过敏记录中：${r.existing.join('、')}`);
    if (!r.added.length && !r.existing.length) ui.error(`没有识别出过敏原：${tokens.join(' ')}`);
  }

  async function queryOrder(orderId) {
    if (!/^[\w-]{4,64}$/.test(orderId)) return ui.error('订单号格式不对；/order 查看最近的订单号。');
    const step = ui.begin('查询订单状态（query-order，只读）');
    try {
      const s = await session.queryOrder(orderId);
      step.ok(s.label);
      ui.panel('订单状态', renderOrderStatus(orderId, s, P));
      if (s.code === '1') ui.write(P.gray(`还没支付：扫下单时的支付二维码或打开麦当劳 App。${PAY_FOLLOWUP}`));
    } catch (e) { step.fail(message(e)); }
  }

  // '就吃这个了' on the current pick. The store question is the only gate: '是' claims the listed
  // coupons, re-prices, then creates the order (create-order, pickup) and shows its payment link.
  async function buy(intent) {
    if (intent.delivery) return ui.error(PICKUP_ONLY);
    if (!session.lastReceipt) return ui.info(BUY_NO_PICK);
    const look = ui.begin(session.demo ? '下单前查券（样本）' : '下单前查券（available-coupons · 券包，只读）');
    let preview;
    try { preview = await session.buyPreview({ takeWay: intent.takeWay, onProgress: (p) => look.progress(p.text) }); look.ok(''); }
    catch (e) { return look.fail(message(e)); }
    ui.panel(`就吃这个 · 到店自取${preview.demo ? '（演示）' : ''}`, renderBuySummary(preview, P), 'yellow');
    if (preview.demo) return ui.error(`${BUY_DEMO}：没有领券，也没有调用 create-order。`);
    if (!isStoreConfirm(await ask('是这家店吗？> '))) return ui.info(BUY_CANCELLED);
    const confirmed = true;
    if (preview.claimable.length) {
      const claiming = ui.begin('领券（auto-bind-coupons）');
      try { const r = await session.buyClaim(preview, { confirmed }); claiming.ok(`已领取 ${r.claimed} 张`); }
      catch (e) { return claiming.fail(`${message(e)} 购物车没有变化。`); }
    }
    const pricing = ui.begin('重新核价（calculate-price）');
    let priced;
    try { priced = await session.buyReprice(preview, { confirmed, onProgress: (p) => pricing.progress(p.text) }); }
    catch (e) { return pricing.fail(`${message(e)} 购物车没有变化。`); }
    const was = preview.receipt.priceFen;
    pricing.ok(`最终合计 ${P.bold(money(priced.priceFen))}${priced.priceFen < was ? `（比刚才 ${money(was)} 少 ${money(was - priced.priceFen)}）` : '（和刚才一样）'}${priced.couponNames.length ? ` · 用券：${priced.couponNames.join('、')}` : ''}`);
    const placing = ui.begin('创建麦当劳订单（create-order · 到店自取）');
    let result;
    try { result = await session.buyPlace(preview, priced, { confirmed }); placing.ok(''); }
    catch (e) { return placing.fail(`${message(e)} 购物车没有变化。`); }
    ui.write('');
    renderPayment(result.order, P, { columns: ui.columns() }).forEach((line) => ui.write(line));
    ui.write(P.gray(`订单已记录${ordersNote(result.saved)}${result.order.hashes.length ? `；已移出购物车：${result.order.hashes.join(' ')}` : ''}`));
  }

  function selectStore(n) {
    const item = pendingStores?.stores[n - 1];
    if (!item) return ui.error('没有这个序号，先 /store 搜索门店。');
    session.selectStore(item, pendingStores.city); pendingStores = null;
    ui.info(`已选择 ${item.storeName}（到店自取）。接下来 /coupons、/price，或直接输入一句话。`);
  }

  async function handle(line) {
    const text = line.trim();
    if (!text) return;
    if (/^\d+$/.test(text) && pendingStores) return selectStore(Number(text));
    if (text.startsWith('/')) {
      const [name, ...args] = text.slice(1).split(/\s+/);
      const command = commands[name.toLowerCase()];
      if (!command) {
        // An unfinished '/partial' sent as a line (piped input, or Enter with the palette dismissed): list the matches.
        const matches = args.length ? [] : matchCommands(name);
        if (!matches.length) return ui.error(`未知命令 /${name}，输入 /help 查看。`);
        ui.write(P.gray(name ? `以 /${name} 开头的命令：` : '全部命令：'));
        return paletteLines(matches, P, { width: ui.width() }).forEach((l) => ui.write(l));
      }
      return command(args, text.slice(1 + name.length).trim());
    }
    // '支付完成' / '支付失败' after buying: check the pending order's real status, never assume it.
    if (isPaymentReply(text)) {
      const pending = session.pendingOrder();
      if (!pending) return ui.info(NO_PENDING);
      return queryOrder(pending.orderId);
    }
    // '就吃这个了' and close variants: buy the current pick. Matched locally only, never by a model.
    const buyIntent = parseBuyIntent(text);
    if (buyIntent) return buy(buyIntent);
    // Allergy statements are recorded locally and never reach the intent agent.
    const allergy = parseAllergyStatement(text);
    let rest = text;
    if (allergy) {
      if (allergy.allergens.length) confirmAllergyAdd(session.addAllergies(allergy.allergens), allergy.allergens);
      else ui.info('这句话里没有识别出要记录的过敏原；可以用 /allergy 花生 这样添加。');
      rest = allergy.rest.trim();
      if (!rest) return;
      ui.info(`过敏信息已在本地记录，只把其余内容交给 Agent：${rest}`);
    }
    if (isActivityQuery(rest)) return commands.activity();
    controller = new AbortController();
    try { await runAgentFlow(session, rest, ui, { signal: controller.signal }); }
    finally { controller = null; }
  }

  // Busy wrapper: one line at a time; errors become a message, never a crash.
  async function run(line) {
    busy = true; interrupted = false; ui.busy(true);
    try { await handle(line); } catch (e) { ui.error(message(e)); } finally { busy = false; ui.busy(false); }
  }

  return {
    commands, run,
    get busy() { return busy; },
    // Ctrl+C: cancel a running agent flow; while another request runs, the first press only warns.
    // Returns false when nothing was running (the caller may then exit).
    interrupt() {
      if (controller && !controller.signal.aborted) { controller.abort(); ui.info('已请求取消当前 Agent 流程。'); return true; }
      if (busy && !interrupted) { interrupted = true; ui.info('正在等待当前请求结束；再按一次 Ctrl+C 退出。'); return true; }
      return false;
    },
    async start() {
      ui.panel('麦麦饱饱盘 · 终端版', [
        P.bold('饭点选套餐：说一句话，Agent 在后台查店、查券、核价并挑选，最后给你一个答案。'),
        P.yellow(NOTICE),
        `MCD_TOKEN：${session.demo ? '样本模式未使用' : session.hasMcdToken ? P.green('已从环境变量读取（不显示、不保存）') : P.red('未设置')}`,
        `DEEPSEEK_API_KEY：${session.hasDeepSeek ? P.green('已从环境变量读取（不显示、不保存）') : P.yellow(session.deepseekNote || '未设置，饭搭子使用本地偏好推荐')}`,
        `默认选店区域：${P.bold(DEFAULT_STORE_SEARCH.label)}${session.demo ? P.gray('（样本模式不搜索，用样本门店）') : ''}`,
        `默认餐量：${DEFAULT_INTENT.people} 人 · ${DEFAULT_INTENT.portion} 分饱 · 人均 ¥${DEFAULT_INTENT.budgetPerPersonYuan}`,
        `过敏记录：${session.allergies.length ? P.bold(session.allergies.join('、')) : '无'}${session.profileError ? P.red(`（${session.profileError}，不会覆盖该文件）`) : ''}${P.gray('（只存本机，本地筛选，从不发送；/allergy 管理）')}`,
        `购物车：${cartOf(session.orders).length} 单 · 未 push ${unpushed(session.orders).length} 个提交${session.ordersError ? P.red(`（${session.ordersError}，不会覆盖该文件）`) : ''}${P.gray('（只存本机，不是订单；/cart 查看）')}`,
        ...(session.pendingOrder() ? [P.yellow(`有 ${session.orders.placed.filter((o) => o.status === PENDING).length} 笔真实订单待支付：/order 查看`)] : []),
        P.gray('指令里写明的人数 / 食量 / 预算 / 位置（@城市 关键词）优先；/set、/store 也会覆盖默认。'),
        P.gray('输入 / 打开命令面板；选好一餐后说 就吃这个了 直接下单（到店自取）：先列出要领的券，回答“是这家店”才领券并下单，付款在麦当劳支付链接或 App。'),
      ]);
      if (autoConnect && !session.demo && session.hasMcdToken) { busy = true; ui.busy(true); try { await commands.connect(); } finally { busy = false; ui.busy(false); } }
      else if (!session.demo && !session.hasMcdToken) ui.error('请先 export MCD_TOKEN=… 再启动；也可以用 npm run tui -- --demo 体验历史样本。');
    },
    close({ farewell = true } = {}) {
      session.close();
      if (farewell) ui.write(P.gray(FAREWELL));
    },
  };
}
