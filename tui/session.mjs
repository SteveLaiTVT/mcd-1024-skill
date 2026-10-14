// TUI state around the existing web modules. Credentials come from process env
// only, live in private fields, and are never printed or written anywhere.
// Allergies are health data: kept here and in the local profile file only (see allergy.mjs).
import { MCPClient, MCPError } from '../core/mcp.mjs';
import { inspectBenefits, prepareWheel, prepareDemo, WheelSession, publicOffers, dateValue, quoteBest, menuIndex, menuShape, detailOf } from '../core/pricing.mjs';
import { fallbackPicks, liveMenuPlans, snapshotMenu } from './menu.mjs';
import { readHistory, demoHistory, shiftDay } from '../core/history.mjs';
import { storeResults } from '../core/store.mjs';
import { DeepSeekClient, DeepSeekError } from '../core/llm.mjs';
import { calendarContext } from '../core/context.mjs';
import { defaultPreferences, learnFeedback } from '../core/pick.mjs';
import { couponPicture, claimableList, valueCoupons } from '../core/coupons.mjs';
import { applyGate } from '../core/eligibility.mjs';
import { reRank, profileSummary, emptyTaste, pushTurn, rememberFeedback, stripAllergyText } from '../core/memory.mjs';
import { meatsInName, prefetchCandidateDetails } from '../core/menu.mjs';
import { receiptFrom } from './receipt.mjs';
import { alaCarteMains, demoAlaCarte, liveAlaCarte, mergeAlaCarte, applyUpgrades } from './pricing.mjs';
import { applyAllergyFilter, normalizeAllergens, loadProfile, saveProfile } from './allergy.mjs';
import { activitiesFromCalendar, activitiesFromSnapshot, classifyActivities } from './activity.mjs';
import { emptyOrders, loadOrders, saveOrders, createCommit, headOf, unpushed, cartOf, findCommit, NO_PICK, EMPTY_GRAPH } from './orders.mjs';
import { money } from './ansi.mjs';
import { buyContext, validBuyContext, baseItems, chooseTakeWay, createOrderArgs, claimFailures, orderResult, orderStatus,
  BUY_NO_PICK, BUY_DEMO, BUY_NO_CONTEXT, BUY_CONFIRM_NEEDED, PENDING } from './buy.mjs';

export class TuiError extends Error {}

const DEFAULT_BUDGET_YUAN = 25;

export class TuiSession {
  #mcdToken; #deepseekKey; #mcp = null; #deepseek = null; #allergies = [];
  // profilePath: local JSON for allergy memory; null keeps it in memory only (tests, or no home directory).
  constructor({ dataset, env = process.env, demo = false, mcpFactory = (t) => new MCPClient(t), deepseekFactory = (k) => new DeepSeekClient(k),
    llm = null, now = () => new Date(), wheel = new WheelSession(), random = Math.random, profilePath = null, ordersPath = null }) {
    this.profilePath = profilePath; this.profileError = '';
    if (profilePath) {
      const loaded = loadProfile(profilePath);
      this.#allergies = loaded.allergies;
      // A file we could not read is never overwritten: the user must fix or remove it first.
      if (loaded.error) this.profileError = loaded.error;
    }
    // Local order commits and cart (/commit, /push, /cart, /graph); same rules as the allergy file. null keeps them in memory.
    this.ordersPath = ordersPath; this.ordersError = ''; this.orders = emptyOrders();
    if (ordersPath) {
      const loaded = loadOrders(ordersPath);
      this.orders = loaded.state;
      if (loaded.error) this.ordersError = loaded.error;
    }
    this.#mcdToken = String(env.MCD_TOKEN || '').trim();
    this.#deepseekKey = String(env.DEEPSEEK_API_KEY || '').trim();
    this.dataset = dataset; this.demo = demo; this.mcpFactory = mcpFactory; this.now = now; this.wheel = wheel; this.random = random; this.llm = llm;
    this.store = null; this.history = null; this.benefits = null; this.lastPick = null;
    this.recentTurns = []; this.taste = emptyTaste(); this.detailCache = {}; this.couponTable = []; this.menuSnapshot = [];
    this.lastOrderAttempt = null; this.dataIncomplete = false; this.ranked = []; this.profileLine = '';
    this.lastReceipt = null; // Survives invalidate(): it is a record of a past pick, timestamped.
    this.lastDetails = null; // { query, lines }: the last pick's full process, shown only by /why. Local only.
    this.request = { people: 1, budgetPerPersonFen: Math.round(DEFAULT_BUDGET_YUAN * 100), avoidMainCodes: [] };
    this.profile = {}; // Only values set explicitly with /set; instructions without numbers fall back to these, then DEFAULT_INTENT.
    // Cheapest effective price (after coupons) wins unless the user asks for another goal.
    this.preferences = { ...defaultPreferences(), goal: 'cheapest' };
    this.#refreshProfileLine();
    this.deepseekNote = '';
    if (this.#deepseekKey) {
      try { this.#deepseek = deepseekFactory(this.#deepseekKey); }
      catch (e) { this.deepseekNote = e instanceof DeepSeekError ? e.message : 'DeepSeek key 格式未通过校验。'; }
    }
    this.mainNames = new Map(dataset.plans.plans.flatMap((p) => p.parts.filter((part) => dataset.templates.mainProductCodes.includes(part.code)).map((part) => [part.code, part.name])));
    // Template package code → name (sample menu + sample plans): lets a store that lists the same package under its own code still price it.
    this.packageNames = new Map([...(dataset.menu?.items || []).map((i) => [i.productCode, i.name]), ...dataset.plans.plans.flatMap((p) => (p.packages || []).map((k) => [k.productCode, k.name]))]);
    this.menu = null; // { storeCode, items, shape }: the last query-meals result for the selected store.
    if (demo) this.store = { ...dataset.templates.sampleStore, businessStatus: null, sample: true };
  }

  get hasMcdToken() { return Boolean(this.#mcdToken); }
  get hasDeepSeek() { return Boolean(this.#deepseek); }
  get deepseek() { return this.#deepseek; }
  get connected() { return Boolean(this.#mcp); }
  get context() { return this.store ? { storeCode: this.store.storeCode, orderType: 1, beType: 1 } : null; }

  // Defence in depth: any accidental echo of a credential is masked before output.
  redact(text) {
    let out = String(text);
    for (const secret of [this.#mcdToken, this.#deepseekKey]) if (secret.length >= 8) out = out.split(secret).join('[已隐藏]');
    return out;
  }

  async connect() {
    if (this.demo) throw new TuiError('当前是样本模式（--demo），不连接麦当劳。');
    if (!this.#mcdToken) throw new TuiError('未检测到环境变量 MCD_TOKEN。请在启动前 export MCD_TOKEN=…（终端版不会询问或保存 Token）。');
    this.#mcp?.close(); this.#mcp = null;
    let client;
    try { client = this.mcpFactory(this.#mcdToken); } catch (e) { throw new TuiError(e instanceof MCPError ? e.message : 'MCD_TOKEN 格式无效。'); }
    try { await client.initialize(); await client.call('now-time-info'); }
    catch (e) { client.close(); throw new TuiError(e instanceof MCPError ? e.message : '麦当劳 MCP 连接未完成。'); }
    this.#mcp = client; this.invalidate(); return this;
  }
  requireClient() {
    if (!this.#mcp) throw new TuiError(this.demo ? '样本模式不读取实时账户数据。' : '尚未连接麦当劳 MCP，请先 /connect。');
    return this.#mcp;
  }
  requireStore() { if (!this.context) throw new TuiError('还没选门店：先用 /store 城市 关键词 搜索并选择。'); return this.context; }

  async searchStores(city, keyword) {
    if (!city || !keyword) throw new TuiError('用法：/store 城市 位置关键词，例如 /store 深圳 华强北');
    return storeResults((await this.requireClient().call('query-nearby-stores', { beType: 1, searchType: 2, city, keyword })).data);
  }
  selectStore(store, city) { this.store = { ...store, city }; this.benefits = null; this.menu = null; this.detailCache = {}; this.menuSnapshot = []; this.couponTable = []; this.invalidate(); }
  #refreshProfileLine() { this.profileLine = profileSummary({ taste: this.taste, hasAllergy: this.#allergies.length > 0 }); }
  noteTurn(text) {
    const clean = stripAllergyText(text, this.#allergies);
    this.recentTurns = pushTurn(this.recentTurns, { text: clean, summary: clean });
  }
  get llmClient() { return this.llm || this.#deepseek; }

  setRequest(change) { this.request = { ...this.request, ...change }; this.invalidate(); }
  setProfile(change) {
    const { budgetPerPersonFen, ...rest } = change;
    this.profile = { ...this.profile, ...rest, ...(budgetPerPersonFen != null ? { budgetPerPersonYuan: budgetPerPersonFen / 100 } : {}) };
    this.setRequest(change);
  }
  invalidate() { this.wheel.invalidate(); this.lastPick = null; }

  async coupons(onProgress) {
    const client = this.requireClient(), context = this.requireStore();
    this.benefits = await inspectBenefits(client, context, onProgress); return this.benefits;
  }

  get allergies() { return [...this.#allergies]; }
  // Returns { added, existing, saved }; `saved` is false when only this session remembers them.
  addAllergies(tokens) {
    const wanted = normalizeAllergens(tokens), added = wanted.filter((a) => !this.#allergies.includes(a));
    if (!added.length) return { added, existing: wanted, saved: Boolean(this.profilePath) && !this.profileError };
    this.#allergies = [...this.#allergies, ...added]; this.#refreshProfileLine(); this.invalidate();
    return { added, existing: wanted.filter((a) => !added.includes(a)), saved: this.#saveProfile() };
  }
  removeAllergies(tokens) {
    const names = normalizeAllergens(tokens), removed = this.#allergies.filter((a) => names.includes(a) || tokens.includes(a));
    if (!removed.length) return { removed, saved: false };
    this.#allergies = this.#allergies.filter((a) => !removed.includes(a)); this.#refreshProfileLine(); this.invalidate();
    return { removed, saved: this.#saveProfile() };
  }
  #saveProfile() {
    if (!this.profilePath || this.profileError) return false;
    try { saveProfile(this.profilePath, { allergies: this.#allergies }); return true; }
    catch { throw new TuiError('过敏记录没能写入本地文件，本次会话内仍然生效；请检查 ~/.config/mcd-tui 的权限。'); }
  }

  // Records the current pick (the last '这一餐就吃') as a local commit. Never an order or a payment.
  commitOrder(note = '') {
    if (!this.lastReceipt) throw new TuiError(NO_PICK);
    const commit = createCommit(this.lastReceipt, { note, at: this.now(), parent: headOf(this.orders)?.hash || null, taken: new Set(this.orders.commits.map((c) => c.hash)) });
    this.#setOrders([...this.orders.commits, commit]);
    return { commit, saved: this.#saveOrders() };
  }
  // Adds every unpushed commit to the local cart (origin/main catches up to HEAD). Returns { pushed, saved }; pushed is [] when up to date.
  pushOrders() {
    if (!this.orders.commits.length) throw new TuiError(EMPTY_GRAPH);
    const pending = new Set(unpushed(this.orders).map((c) => c.hash)), at = new Date(this.now()).toISOString();
    if (!pending.size) return { pushed: [], saved: this.#ordersPersisted() };
    this.#setOrders(this.orders.commits.map((c) => pending.has(c.hash) ? { ...c, pushedAt: at } : c));
    return { pushed: this.orders.commits.filter((c) => pending.has(c.hash)), saved: this.#saveOrders() };
  }
  // Takes one order out of the cart: it goes back to unpushed and stays in the history.
  cartRemove(ref) {
    const hit = findCommit(this.orders, ref);
    if (!hit) throw new TuiError(`没有找到这一单 ${ref || ''}。用 /cart 查看。`);
    if (!hit.pushedAt) throw new TuiError(`${hit.hash} 不在购物车里。`);
    this.#setOrders(this.orders.commits.map((c) => c === hit ? (({ pushedAt, ...rest }) => rest)(c) : c));
    return { removed: hit, saved: this.#saveOrders() };
  }
  // Empties the cart; every order goes back to unpushed. The caller must have a typed 'yes'.
  cartClear({ confirmed = false } = {}) {
    if (confirmed !== true) throw new TuiError('清空购物车需要明确确认。');
    const removed = cartOf(this.orders);
    this.#setOrders(this.orders.commits.map(({ pushedAt, ...rest }) => rest));
    return { removed, saved: removed.length ? this.#saveOrders() : this.#ordersPersisted() };
  }
  #setOrders(commits, placed = this.orders.placed) { this.orders = { commits, placed }; }
  #ordersPersisted() { return Boolean(this.ordersPath) && !this.ordersError; }
  #saveOrders() {
    if (!this.ordersPath || this.ordersError) return false;
    try { saveOrders(this.ordersPath, this.orders); return true; }
    catch { throw new TuiError('订单记录没能写入本地文件，本次会话内仍然生效；请检查 ~/.config/mcd-tui 的权限。'); }
  }
  // After a real order exists, a failed local write must not look like a failed order.
  #trySaveOrders() { try { return this.#saveOrders(); } catch { return false; } }

  // Buy flow ('就吃这个了') on the CURRENT pick. Step 1, read-only: the pick, its create-order inputs,
  // and a fresh coupon check (available-coupons / query-my-coupons) for the pick's store, so the store
  // question shows exactly which coupons a '是' will claim. Demo mode shows the sample picture only.
  async buyPreview({ takeWay = null, onProgress } = {}) {
    const receipt = this.lastReceipt;
    if (!receipt) throw new TuiError(BUY_NO_PICK);
    const base = { receipt, storeName: receipt.storeName, used: [...receipt.couponNames], takeWayTitle: takeWay };
    if (this.demo) return { ...base, demo: true, context: null, claimable: this.couponPicture().claimable, takeWay: null };
    const context = receipt.buy;
    if (!validBuyContext(context)) throw new TuiError(BUY_NO_CONTEXT);
    const client = this.requireClient();
    this.benefits = await inspectBenefits(client, { storeCode: context.storeCode, orderType: 1, beType: 1 }, onProgress);
    return { ...base, demo: false, context, claimable: claimableList(this.benefits.offers, this.benefits.entries),
      takeWay: chooseTakeWay(context.takeWays, { title: takeWay, code: context.takeWayCode }) };
  }
  #buyClient(confirmed) {
    if (confirmed !== true) throw new TuiError(BUY_CONFIRM_NEEDED);
    if (this.demo) throw new TuiError(BUY_DEMO);
    return this.requireClient();
  }
  // Step 2 (after '是'): claim the coupons the preview listed. auto-bind-coupons is never retried;
  // any failed coupon aborts the buy before an order exists. Old quotes are stale afterwards.
  async buyClaim(preview, { confirmed = false } = {}) {
    const client = this.#buyClient(confirmed);
    if (!preview.claimable.length) return { claimed: 0 };
    this.invalidate(); this.benefits = null;
    const data = (await client.claimAll()).data, failed = claimFailures(data);
    if (failed.length) throw new TuiError(`这些券没领到：${failed.join('、')}。没下单。`);
    if (!Number.isSafeInteger(data?.successCount)) throw new TuiError('领券结果未确认（官方没有返回领取数量），没下单；请先 /coupons 核对券包。');
    return { claimed: data.successCount };
  }
  // Step 3: re-price the pick's items with the coupons held now (calculate-price via quoteBest).
  // The final total may stay the same or go down; a failed or higher quote aborts.
  async buyReprice(preview, { confirmed = false, onProgress } = {}) {
    const client = this.#buyClient(confirmed), ctx = preview.context, common = { storeCode: ctx.storeCode, orderType: 1, beType: 1 };
    let quote;
    try {
      if (!this.benefits) this.benefits = await inspectBenefits(client, common, onProgress);
      quote = await quoteBest(client, common, baseItems(ctx.items), this.benefits.usable);
    } catch (e) { throw new TuiError(`重新核价没有完成（${e instanceof MCPError || e instanceof TuiError ? e.message : '官方核价失败'}），没下单。`); }
    if (!(quote.priceFen > 0)) throw new TuiError(`「${preview.receipt.title}」价格异常（¥0），没下单。`);
    if (quote.priceFen > preview.receipt.priceFen) throw new TuiError(`重新核价是 ${money(quote.priceFen)}，比刚才的 ${money(preview.receipt.priceFen)} 贵，没下单；请重新选一餐。`);
    const takeWay = chooseTakeWay(quote.takeWays, { title: preview.takeWayTitle, code: preview.takeWay?.code });
    if (!takeWay) throw new TuiError('官方核价没有返回取餐方式（takeWayList），没下单。');
    return { priceFen: quote.priceFen, items: quote.orderItems, couponNames: quote.couponNames, takeWay };
  }
  // Step 4, the single real-order path: MCP create-order (pickup), never retried. On success the
  // order is recorded as 待支付 with its payment link; a cart commit of this pick leaves the cart.
  async buyPlace(preview, priced, { confirmed = false } = {}) {
    const client = this.#buyClient(confirmed);
    const args = createOrderArgs({ storeCode: preview.context.storeCode, takeWayCode: priced.takeWay.code, items: priced.items });
    const result = orderResult((await client.createOrder(args)).data);
    if (!result.orderId) throw new TuiError('下单结果未确认：官方响应里没有订单号。请先在麦当劳 App 的订单列表核对，避免重复下单。');
    const fromCart = new Set(cartOf(this.orders).filter((c) => c.pickedAt === preview.receipt.at).map((c) => c.hash));
    const order = { orderId: result.orderId, payUrl: result.payUrl, payId: result.payId, title: preview.receipt.title, storeName: preview.storeName, storeCode: preview.context.storeCode,
      takeWay: priced.takeWay.title || priced.takeWay.code, priceFen: result.paidFen ?? priced.priceFen, hashes: [...fromCart],
      status: PENDING, statusCode: '1', createdAt: new Date(this.now()).toISOString() };
    this.#setOrders(this.orders.commits.map((c) => fromCart.has(c.hash) ? { ...c, orderId: order.orderId } : c), [...this.orders.placed, order]);
    return { order, saved: this.#trySaveOrders() };
  }
  // The newest order still waiting for payment, as far as the local record knows.
  pendingOrder() { return [...this.orders.placed].reverse().find((o) => o.status === PENDING) || null; }
  // Live status via query-order (read-only); updates the local record when the order is ours.
  async queryOrder(orderId) {
    const data = (await this.requireClient().call('query-order', { orderId })).data;
    const status = orderStatus(data), known = this.orders.placed.some((o) => o.orderId === orderId);
    if (known && status.reported) {
      const at = new Date(this.now()).toISOString();
      this.#setOrders(this.orders.commits, this.orders.placed.map((o) => o.orderId === orderId ? { ...o, status: status.label, statusCode: status.code, checkedAt: at } : o));
      this.#trySaveOrders();
    }
    return { orderId, known, ...status };
  }

  async quote(onProgress = () => {}, { signal } = {}) {
    const context = this.requireStore(), request = { ...this.request, avoidMainCodes: [...this.request.avoidMainCodes], wantMainCodes: [...(this.request.wantMainCodes || [])] };
    this.invalidate();
    if (!this.demo) this.benefits = null;
    // prepareWheel reports the coupon check it ran through onProgress; keep it for the coupon picture.
    const capture = (p) => { if (p?.benefits) this.benefits = p.benefits; onProgress(p); };
    const report = this.demo
      ? prepareDemo({ plans: this.dataset.plans, offers: this.dataset.offers, campaigns: this.dataset.campaigns }, { ...context, storeName: this.store.storeName }, request)
      : await prepareWheel(this.requireClient(), this.dataset.templates, context, request, capture, { names: this.packageNames });
    if (report.menu?.ok) this.menu = { storeCode: context.storeCode, items: report.menu.items, shape: report.menu.shape };
    const setsQuoted = report.quotedPlans.length;
    // À la carte mains join the pool; allergy screening runs locally before anything is ranked or shown to an agent.
    const mains = alaCarteMains(this.mainNames, request, new Set(this.dataset.templates.mainProductCodes));
    const singles = this.demo ? { plans: demoAlaCarte(this.dataset.menu, mains, request) }
      : mains.length ? await liveAlaCarte(this.requireClient(), context, mains, request, this.benefits?.usable || [], onProgress) : {};
    mergeAlaCarte(report, singles);
    // No template priced at this store (not a budget problem): price what the store's own menu offers instead.
    if (!this.demo && !setsQuoted && !report.candidates.length && report.menu?.ok) {
      const picks = fallbackPicks(report.menu.items, request);
      if (picks.length) {
        const extra = await liveMenuPlans(this.requireClient(), context, picks, request, this.benefits?.usable || [], new Set(this.dataset.templates.mainProductCodes), onProgress);
        mergeAlaCarte(report, extra);
        report.excludedPlans = [...report.excludedPlans, ...extra.excluded];
        report.menuFallback = { tried: picks.length, quoted: extra.plans.length };
      }
    }
    applyAllergyFilter(report, this.#allergies);
    applyUpgrades(report, this.mainNames);
    if (process.env.MCD_TEST_ZERO === '1') {
      report.candidates.push({ id: 'zero-injected', title: '零元鸡腿', priceFen: 0, parts: [{ name: '鸡腿', quantity: 1 }], savingFen: 0, couponNames: [], sample: true });
    }
    const gated = applyGate(report.candidates);
    report.eligibilitySkipped = gated.skipped;
    report.candidates = reRank(gated.kept, { taste: this.taste, meatOf: meatsInName });
    report.counts = { ...report.counts, quotedPlans: report.quotedPlans.length, wheelCandidates: report.candidates.length };
    this.menuSnapshot = (this.menu?.items || report.menu?.items || []).slice(0, 40).map((m) => ({ code: m.code || m.productCode, name: m.name, priceFen: m.priceFen ?? null }));
    for (const p of report.candidates.slice(0, 8)) {
      if (!this.detailCache[p.id]) this.detailCache[p.id] = { code: p.id, name: p.title, parts: (p.parts || []).map((x) => ({ name: x.name, qty: x.quantity })), removable: [], meatKind: meatsInName(`${p.title} ${(p.parts || []).map((x) => x.name).join(' ')}`), complete: false, unknown: false };
    }
    // Ingredient prefetch targets the ranked candidates' own product codes, not the
    // menu at large: the old menu-wide prefetch answered "有什么料" with unrelated meals.
    if (!this.demo && this.#mcp) {
      try { Object.assign(this.detailCache, await prefetchCandidateDetails(this.#mcp, context, report.candidates, { signal })); }
      catch { this.dataIncomplete = true; }
    }
    try {
      if (this.demo) {
        const top = report.candidates[0];
        this.couponTable = top ? [{ name: top.couponNames?.[0] || '样本券', applicable: (top.savingFen || 0) > 0, saveYuan: (top.savingFen || 0) / 100, ratio: null, afterYuan: (top.priceFen || 0) / 100, note: top.couponNames?.length ? '' : '估算' }] : [];
      } else if (this.#mcp && this.benefits?.usable?.length) {
        const priced = report.candidates.slice(0, 3).map((p) => ({ ...p, items: p.orderItems || p.items || [] })).filter((p) => p.items.length);
        this.couponTable = await valueCoupons(this.#mcp, context, this.benefits.usable, priced, { signal });
      }
    } catch { this.dataIncomplete = true; }
    if (report.candidates.length && ['empty', 'unavailable'].includes(report.status)) report.status = 'ready';
    if (report.status === 'ready' && !report.candidates.length) report.status = 'empty';
    this.wheel.accept(report); return report;
  }
  // The selected store's menu (query-meals, read-only), reused until the store changes.
  async storeMenu(onProgress = () => {}) {
    const context = this.requireStore();
    if (this.demo) return snapshotMenu(this.dataset.menu);
    if (this.menu?.storeCode === context.storeCode) return this.menu.items;
    onProgress({ text: 'query-meals（门店菜单，只读）…' });
    const raw = (await this.requireClient().call('query-meals', context)).data, items = [...menuIndex(raw).values()];
    if (!items.length) throw new TuiError(`这家店的菜单接口（query-meals）没有返回可识别的餐品（${menuShape(raw)}），不是预算问题。`);
    this.menu = { storeCode: context.storeCode, items, shape: menuShape(raw) };
    return items;
  }
  couponPicture() {
    const claimable = this.demo ? claimableList(this.dataset.offers?.offers, this.dataset.campaigns?.events) : claimableList(this.benefits?.offers, this.benefits?.entries);
    return { ...couponPicture(this.demo ? null : this.benefits, this.wheel.report), claimable };
  }

  async runTool(name, args, { signal } = {}) {
    if (this.demo) { this.dataIncomplete = true; return { error: '样本模式没有实时接口' }; }
    const body = await this.requireClient().call(name, args, { signal });
    if (name === 'query-meals') {
      const items = [...menuIndex(body.data).values()];
      this.menu = { storeCode: args.storeCode, items, shape: menuShape(body.data) };
      this.menuSnapshot = items.slice(0, 40);
    }
    if (name === 'query-meal-detail') {
      const raw = detailOf(body.data, args.code);
      if (raw) this.detailCache[args.code] = { code: args.code, name: raw.name || args.code, parts: (raw.rounds || []).flatMap((r) => (r.choices || []).filter((c) => c.quantity > 0 || c.isDefault).map((c) => ({ name: c.name, qty: c.quantity || 1 }))), removable: [], meatKind: meatsInName(raw.name), complete: Array.isArray(raw.ingredients) && raw.ingredients.length > 0, unknown: false };
    }
    return { data: body.data ?? body };
  }

  // Activities with their participation route. Read-only: campaign-calendar and available-coupons.
  async activities(onProgress = () => {}) {
    if (this.demo) {
      const now = Date.parse(this.dataset.campaigns?.capturedAt || this.now());
      return { sample: true, offersComplete: true, rows: classifyActivities(activitiesFromSnapshot(this.dataset.campaigns?.events), { offers: this.dataset.offers?.offers || [], now }) };
    }
    const client = this.requireClient();
    onProgress({ text: 'now-time-info → campaign-calendar …' });
    const now = dateValue((await client.call('now-time-info')).data.datetime);
    const calendar = (await client.call('campaign-calendar', {})).data;
    onProgress({ text: 'available-coupons（只读，不领取）…' });
    let offers = [], offersComplete = true;
    try { offers = publicOffers((await client.call('available-coupons')).data); } catch { offersComplete = false; }
    const heldNames = (this.benefits?.rows || []).filter((r) => r.kind === 'owned-coupon').map((r) => r.name);
    return { sample: false, offersComplete, rows: classifyActivities(activitiesFromCalendar(calendar, now), { offers, heldNames, now }) };
  }
  recordPick(plan) {
    this.lastPick = plan;
    // Live picks also keep their create-order inputs for the buy flow ('就吃这个了').
    const buy = buyContext(plan, this.wheel.report);
    this.lastReceipt = { ...receiptFrom(plan, { storeName: this.store?.storeName, at: this.now(), report: this.wheel.report }), ...(buy ? { buy } : {}) };
  }
  get report() { return this.wheel.report; }
  fresh() { return this.wheel.fresh(); }
  remainingSeconds() {
    if (!this.wheel.report || this.wheel.report.sourceKind === 'demo-snapshot') return null;
    return Math.max(0, Math.floor((this.wheel.validUntil - this.wheel.now()) / 1000));
  }
  requireFresh() {
    if (!this.wheel.report) throw new TuiError('还没有核价结果，先 /price。');
    if (!this.wheel.fresh()) throw new TuiError('报价已超过 5 分钟有效期或已失效，请重新 /price。');
    if (!this.wheel.report.candidates.length) throw new TuiError('这次没有预算内的完整套餐候选，可调高预算或减少避开项后重新 /price。');
    return this.wheel.report;
  }

  spin() { this.requireFresh(); const result = this.wheel.choose(); this.recordPick(result.plan); return result; }

  feedback(vote) {
    if (!this.lastPick) throw new TuiError('先选出一份，再给反馈。');
    this.preferences = learnFeedback(this.preferences, this.lastPick, vote, this.dataset.templates.mainProductCodes, calendarContext(this.now()).date);
    this.taste = rememberFeedback(this.taste, this.lastPick, vote);
    const meats = meatsInName(this.lastPick.title);
    if (vote === 'like' && meats.length) this.taste = { ...this.taste, meats: [...new Set([...(this.taste.meats || []), ...meats])] };
    this.#refreshProfileLine();
    return this.lastPick;
  }

  async radar() {
    this.history = this.demo ? demoHistory() : await readHistory(this.requireClient(), this.dataset.templates.mainProductCodes);
    return this.history;
  }
  // Main codes from completed orders on the previous `days` days. Fictional history never feeds requests.
  recentMains(days = 2) {
    if (this.history?.sourceKind !== 'official-history') return [];
    const wanted = new Set(Array.from({ length: days }, (_, i) => shiftDay(this.history.anchorDay, -(i + 1))));
    return [...new Set(this.history.orders.filter((o) => wanted.has(o.day)).flatMap((o) => o.mainCodes))];
  }

  async claim({ confirmed = false } = {}) {
    if (confirmed !== true) throw new TuiError('领券需要明确确认。');
    const client = this.requireClient();
    this.invalidate(); this.benefits = null;
    const data = (await client.claimAll()).data;
    const ok = Number.isSafeInteger(data?.successCount) && data.successCount >= 0 ? data.successCount : null;
    const failed = Number.isSafeInteger(data?.failedCount) && data.failedCount >= 0 ? data.failedCount : null;
    return { successCount: ok, failedCount: failed };
  }

  close() { this.#mcp?.close(); this.#mcp = null; this.#deepseek?.close(); this.llm?.close?.(); }
}
