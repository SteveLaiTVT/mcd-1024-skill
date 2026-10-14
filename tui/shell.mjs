// Slash commands and local gates. Natural language goes to the executor.
// This file does not call MCP itself.
import { MCPError } from '../core/mcp.mjs';
import { DeepSeekError } from '../core/llm.mjs';
import { budgetFen } from '../core/money.mjs';
import { padEnd, money } from './ansi.mjs';
import { TuiError } from './session.mjs';
import { NOTICE, statusLine, renderStores, renderBenefits, renderReport, renderAnswer, renderHeatmap, helpLines, renderClaimable, renderAllergies,
  renderActivities, HELP_COMMANDS } from './render.mjs';
import { DEFAULT_INTENT, DEFAULT_STORE_SEARCH } from './defaults.mjs';
import { parseAllergyStatement } from './allergy.mjs';
import { printReceipt } from './receipt.mjs';
import { renderCart, headOf, cartOf, CART_USAGE } from './orders.mjs';
import { matchCommands, paletteLines } from './palette.mjs';
import { isPaymentReply, renderOrderStatus, renderPlaced, PAY_FOLLOWUP, PENDING, NO_PENDING } from './buy.mjs';
import { createExecutor } from './executor.mjs';

export const message = (e) => e instanceof TuiError || e instanceof MCPError || e instanceof DeepSeekError ? e.message : `未完成：${e?.message || e}`;
export const FAREWELL = '再见。凭证只在本次进程内存中，已随退出清除。';

export function createShell({ session, ui, ask, quit = () => {}, autoConnect = true }) {
  const P = ui.palette;
  let pendingStores = null, controller = null, busy = false, interrupted = false;
  const executor = createExecutor({ session, ui, ask, message });

  const showReport = (report) => ui.panel('核价结果', renderReport(report, P, { remaining: session.remainingSeconds() }));
  const avoidLines = () => {
    const cells = [...session.mainNames].map(([code, name], i) => `${String(i + 1).padStart(2)}. ${session.request.avoidMainCodes.includes(code) ? P.yellow(`[避开]${name}`) : name}`);
    const rows = [];
    for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3).map((c) => padEnd(c, 24)).join(''));
    return [...rows, P.gray('/avoid 名称或序号 切换；/avoid clear 清空。条件变化后需重新 /price。')];
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
        const [budget] = args;
        const change = {};
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
        const reason = `转盘随机揭晓（本轮还剩 ${session.wheel.remaining().length} 份）`;
        const lines = renderAnswer(plan, P, { storeName: session.store?.storeName, report: session.report, remaining: session.remainingSeconds(), reason });
        ui.result('转盘揭晓', lines);
        session.lastDetails = { query: '/wheel', lines };
      } catch (e) { ui.error(message(e)); }
    },
    receipt() {
      if (!session.lastReceipt) return ui.error('还没有挑出的套餐：先说一句话或 /wheel，再 /receipt。');
      const head = headOf(session.orders);
      printReceipt(ui, session.lastReceipt, { note: head && head.pickedAt === session.lastReceipt.at ? head.note : '' });
    },
    async cart(args) {
      const [sub, ref] = args;
      try {
        if (sub === 'add') {
          const { commit, saved } = session.commitOrder('');
          session.pushOrders();
          ui.info(`已放入购物车：${commit.title}${ordersNote(saved)}`);
        } else if (sub === 'rm') {
          const n = Number(ref);
          const hit = cartOf(session.orders)[n - 1];
          if (!hit) return ui.error(CART_USAGE);
          const { removed, saved } = session.cartRemove(hit.hash);
          ui.info(`已移出购物车：${removed.title}${ordersNote(saved)}`);
        } else if (sub === 'clear') {
          const cart = cartOf(session.orders);
          if (!cart.length) return ui.panel('购物车（本地暂存）', renderCart(session.orders, P), 'yellow');
          ui.panel('清空购物车', [`购物车里有 ${cart.length} 单，合计 ${money(cart.reduce((s, c) => s + c.priceFen, 0))}。`,
            P.bold('确认清空请输入 yes，其他任何输入都会取消。')], 'yellow');
          const reply = await ask('确认清空？> ');
          if (reply?.trim().toLowerCase() !== 'yes') return ui.info('已取消，没清空');
          const { removed, saved } = session.cartClear({ confirmed: true });
          ui.info(`已清空购物车（${removed.length} 单）${ordersNote(saved)}`);
        } else if (sub) return ui.error(CART_USAGE);
      } catch (e) { return ui.error(message(e)); }
      ui.panel('购物车（本地暂存）', renderCart(session.orders, P), 'yellow');
    },
    async order(args) {
      if (!args.length) return ui.panel('真实订单', renderPlaced(session.orders.placed, P));
      await queryOrder(args[0]);
    },
    why() {
      const d = session.lastDetails;
      if (!d) return ui.info('还没有挑选过程：先说一句话（比如“预算30”）。');
      ui.panel(`挑选过程 · ${d.query}`, d.lines, 'cyan');
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
      if (!session.history) return;
      try { ui.panel(`麦当劳雷达 · ${mode === 'year' ? '全年' : '近 12 周'}`, renderHeatmap(session.history, P, { mode, year })); }
      catch (e) { ui.error(message(e)); }
      const recent = session.recentMains(2);
      if (recent.length) ui.write(P.gray(`前两天可识别主食：${recent.map((c) => session.mainNames.get(c) || c).join('、')} · /radar apply 加入避开`));
    },
    async claim() {
      if (session.demo) return ui.error('样本模式不能领券。');
      if (!session.connected) return ui.error('尚未连接麦当劳 MCP，请先 /connect。');
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
        const matches = args.length ? [] : matchCommands(name);
        if (!matches.length) return ui.error(`未知命令 /${name}，输入 /help 查看。`);
        ui.write(P.gray(name ? `以 /${name} 开头的命令：` : '全部命令：'));
        return paletteLines(matches, P, { width: ui.width() }).forEach((l) => ui.write(l));
      }
      return command(args, text.slice(1 + name.length).trim());
    }
    if (isPaymentReply(text)) {
      const pending = session.pendingOrder();
      if (!pending) return ui.info(NO_PENDING);
      return queryOrder(pending.orderId);
    }
    const allergy = parseAllergyStatement(text);
    let rest = text;
    if (allergy) {
      if (allergy.allergens.length) confirmAllergyAdd(session.addAllergies(allergy.allergens), allergy.allergens);
      else ui.info('这句话里没有识别出要记录的过敏原；可以用 /allergy 花生 这样添加。');
      rest = allergy.rest.trim();
      if (!rest) return;
      ui.info('过敏信息已在本地记录，其余内容不含过敏原。');
    }
    const timeout = AbortSignal.timeout(10000);
    controller = new AbortController();
    const signal = AbortSignal.any([timeout, controller.signal]);
    try { await executor.handleText(rest, { signal }); }
    finally { controller = null; }
  }

  async function run(line) {
    busy = true; interrupted = false; ui.busy(true);
    try { await handle(line); } catch (e) { ui.error(message(e)); } finally { busy = false; ui.busy(false); }
  }

  return {
    commands, run, executor,
    get busy() { return busy; },
    interrupt() {
      if (controller && !controller.signal.aborted) { controller.abort(); ui.info('已请求取消当前这一轮。'); return true; }
      if (busy && !interrupted) { interrupted = true; ui.info('正在等待当前请求结束；再按一次 Ctrl+C 退出。'); return true; }
      return false;
    },
    async start() {
      ui.panel('麦麦饱饱盘 · 终端版', [
        P.bold('说一句话选餐。有 DeepSeek key 时由模型理解；没有 key 时按券后价编号，并标明本地模式。'),
        P.yellow(NOTICE),
        `MCD_TOKEN：${session.demo ? '样本模式未使用' : session.hasMcdToken ? P.green('已从环境变量读取（不显示、不保存）') : P.red('未设置')}`,
        `DEEPSEEK_API_KEY：${session.hasDeepSeek ? P.green('已从环境变量读取（不显示、不保存）') : P.yellow(session.deepseekNote || '未设置，使用本地模式')}`,
        `默认选店区域：${P.bold(DEFAULT_STORE_SEARCH.label)}${session.demo ? P.gray('（样本模式不搜索，用样本门店）') : ''}`,
        `默认预算：¥${DEFAULT_INTENT.budgetPerPersonYuan}`,
        `过敏记录：${session.allergies.length ? P.bold(session.allergies.join('、')) : '无'}${session.profileError ? P.red(`（${session.profileError}，不会覆盖该文件）`) : ''}${P.gray('（只存本机，本地筛选，从不发送；/allergy 管理）')}`,
        `购物车：${cartOf(session.orders).length} 单${session.ordersError ? P.red(`（${session.ordersError}，不会覆盖该文件）`) : ''}${P.gray('（只存本机，不是订单；/cart 查看）')}`,
        ...(session.pendingOrder() ? [P.yellow(`有 ${session.orders.placed.filter((o) => o.status === PENDING).length} 笔真实订单待支付：/order 查看`)] : []),
        P.gray('输入 / 打开命令面板。选好一餐后说 就吃这个了：先列出要领的券，回答“是这家店吗”才领券并下单。'),
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

