# TUI 核心重写 PLAN（v2：一次性重写 · deepseek-flash 为魂）

> 基线：`main @ a2352f0`。v1 PLAN（渐进替换）已作废——用户 2026-10-14 拍板：**一次性重写**。
> 总纲（用户原话整理）：① tui/ 不再 import web/；② deepseek-flash 是灵魂 LLM，禁用正则暴力匹配意图，所有意图走 LLM TypeSafe JSON + tool-calling；③ 富上下文 prompt（本轮+最近 N 轮+lastPick/lastReceipt+一次拉全的菜单/详情/配料+券折算+用户记忆摘要）；④ 券折算（每张券价值+折后价，写入上下文且用户可见）；⑤ 配料预处理（首轮 MCP 顺手拿 detail，问"有什么料"直接从上下文答）；⑥ 用户记忆 + re-rank，推荐编号 1/2/3；⑦ 产品形态：个人麦当劳助手，编号选择或盲盒模式；⑧ 不变量：领券/下单永远本地确认门、过敏永不外发、正确性>速度（10s/4turn 熔断）。
> 标 **** 的点不要在实现中自行决定。

---

## 0. 新架构分层图（文字）

```
┌─ tui/ ──────────────────────────────┐ 终端 UI 层：只做输入输出
│ shell.mjs 命令行分发（/ 开头） │ 无业务逻辑，无 MCP 直调
│ ink-app.mjs Ink 渲染壳 │
│ render.mjs 卡片/面板渲染 │
│ executor.mjs 本地执行器（新建） │ ← 意图 JSON → 本地动作的唯一出口
│ palette.mjs / ansi.mjs / ui.mjs │ 纯展示
└──────────────┬───────────────────────┘
│ 调用（禁止反向依赖）
┌─ core/ ──────▼───────────────────────┐ 领域层：无终端 I/O，无 web/ 依赖
│ hub.mjs 意图中枢 │ 富上下文组装 → LLM tool-calling
│ llm.mjs DeepSeek 客户端 │ deepseek-v4.1-flash，TypeSafe JSON
│ tools.mjs 工具 schema 定义 │ 只读 MCP 工具（见 §1.3）
│ context.mjs 富上下文构建 │ 本轮+N轮+快照+菜单+券折算+记忆摘要
│ memory.mjs 会话记忆+用户画像 │ recentTurns(4)+偏好，re-rank
│ coupons.mjs 券折算 │ 每张券价值/折后价
│ eligibility.mjs 候选资格门 │
│ order.mjs 下单状态机（本地） │ lastOrderAttempt，重试，确认门前置
│ pricing.mjs 核价/候选构建 │ ex-web/meal-engine.mjs
│ menu.mjs 菜单索引/详情解析 │ ex-web/meal-engine.mjs
│ store.mjs 门店搜索/状态 │ ex-web/store-search.mjs
│ mcp.mjs MCP 客户端 │ ex-web/mcp-client.mjs（去 web 文案）
│ history.mjs 订单历史 │ ex-web/order-history.mjs
│ pick.mjs 推荐逻辑 │ ex-web/meal-agent.mjs 重写
└──────────────────────────────────────┘
│ MCP（HTTPS）
mcp.mcd.cn：query-meals / query-meal-detail /
calculate-price / available-coupons / create-order …

删除：tui/intent.mjs（正则意图全删，只留 stripAllergyText 搬进 core/memory.mjs）、
tui/agent-flow.mjs（被 hub.mjs 取代）、tui/assistant.mjs（重写进 core/pick.mjs）、
web/ 整个目录（见 §6）、tui/receipt.mjs 的随机掉落、
tui/orders.mjs 的 git 隐喻部分、tui/radar-chart.mjs 的本餐蜘蛛图。
```

**数据流（一轮）**：
```
用户文本 → stripAllergyText（本地去敏）→ context.mjs 组装富上下文
→ hub.mjs：LLM tool-calling（只读工具，最多 3 轮工具调用+1 轮终答，10s 总预算）
→ TypeSafe JSON intent（exactKeys 校验，失败→诚实降级）
→ tui/executor.mjs 本地执行：
recommend → 渲染编号候选 1/2/3（re-rank 后）
blindbox → 预算内随机一餐 → 按 recommend 渲染（惊喜由用户触发，合法随机）
select_candidate(i)/confirm_pick → 本地确认门（"是这家店吗？"）→ 领券 → 重核 → create-order
retry_order → order.mjs 重试（本地 "重试/再试一次" 也直达此处）
info_meat/parts/ingredients → 从上下文直接答（配料不再现查）
price_ask → 券折算后价格直答
register_allergy → 本地落盘（值从未进过 LLM）
chitchat → 本地礼貌回复（"你好/谢谢"等，不烧 LLM）
```

---
## 1. 意图中枢：LLM + tool-calling（零正则意图）

### 1.1 原则
- **禁用正则做意图判断**：删除 `tui/intent.mjs` 的 `parseBuyIntent`、`parsePriceQuery`、`parseInfoQuery`、`PARTS_HINT`、`DEICTIC`、`MEAT_ASK` 等全部意图正则（issue #2 的正则成果保留思想，删除实现——意图理解收归 LLM）。
- 允许保留的正则（非意图类）：`stripAllergyText`（数据脱敏）、`/命令` 解析（显式命令语法）、候选编号选择（`^[123]$` / `第[一二三]个`——显式 UI 语法，可视为命令）。
- **不再新增任何意图正则**：AC 用 grep 门禁（见 §12）。

### 1.2 `core/llm.mjs`（新建，重写 ex-`web/deepseek-client.mjs`）
- 模型固定 `deepseek-v4.1-flash`（沿用 `DEEPSEEK_MODEL = 'deepseek-flash'`）。
- 新增 `tools` / `tool_choice` 参数（DeepSeek Function Calling）；保留 `response_format: {type:'json_object'}` + `exactKeys` 校验（`validateIntent` 模式，逻辑从 `tui/intent.mjs:255-293` 搬过来）。
- 去掉浏览器专用参数（`credentials/cache/referrerPolicy`）、去掉对 `agent-memory.normalizeDeepSeek` 的依赖。
- 超时：调用方传入一个 `AbortSignal.timeout(10000)`，贯穿整轮 LLM 调用〔总纲⑧〕。

### 1.3 `core/tools.mjs`（新建）：暴露给 LLM 的工具（全部只读）
| 工具名 | 映射 MCP | 说明 |
|---|---|---|
| `search_stores` | query-nearby-stores | `{city, keyword}` |
| `query_meals` | query-meals | `{storeCode}`，结果进上下文菜单快照（按门店缓存） |
| `query_meal_detail` | query-meal-detail | `{storeCode, code}`，候选短名单用 |
| `calculate_price` | calculate-price | `{storeCode, items[], couponIds?}` |
| `available_coupons` | available-coupons | 券包（可领/持有） |
| `campaign_calendar` | campaign-calendar | 活动（只读） |

**不在工具列表里**：`auto-bind-coupons`（领券）、`create-order`（下单）。LLM 永远拿不到这两个工具——这是"只能建议"的机制保证，不是 prompt 约束。

### 1.4 意图 JSON schema（`core/hub.mjs`，exactKeys 校验）
```json
{
  "kind": "recommend|blindbox|select_candidate|confirm_pick|retry_order|info_meat|info_parts|info_ingredients|price_ask|register_allergy|chitchat|help|unknown",
  "candidate_index": "0|1|2|null",
  "ref": "'lastPick'|null",
  "slots": {"budget_yuan": "number|null", "want": "string|null", "store_kw": "string|null"},
  "answer": "string|null"
}
```
- `confirm_pick`：对应"吃这个/这个不错/就要这个/1/第一个"——执行器将其路由到**本地确认门**，LLM 不直接触发任何写操作。
- `retry_order`：对应"重试/再试一次/创建"（当 `lastOrderAttempt.status==='failed'` 时优先匹配）。
- `answer`：info/chitchat 类由 LLM 直接起草答案（基于上下文中的真实数据），执行器只做渲染。LLM 被指示：不确定的写"不知道/接口没给"，禁止编造。
- 校验失败 → 诚实降级：`{kind:'unknown'}` → 回复"没理解，能再说一遍吗"（不进选餐，不崩）。

### 1.5 无 DeepSeek key / 超时 / 校验失败的降级
- 无 key：跳过 hub，走本地最小流程（按券折后价排序的编号候选 + 确认门），明确标注"本地模式"。
- 超时/校验失败：当轮降级为 `{kind:'unknown'}`，**资格门、重核、确认门永不被跳过**。

### 1.6 文件级改动清单
- 新建 `core/llm.mjs`、`core/tools.mjs`、`core/hub.mjs`、`tui/executor.mjs`
- 删除 `tui/intent.mjs`（意图正则；`stripAllergyText` 搬进 `core/memory.mjs`）、删除 `tui/agent-flow.mjs`（逻辑被 hub 取代）
- 重写 `tui/shell.mjs:handle()`：`本地去敏 → hub.mjs → executor.mjs`，原 buy→allergy→activity→price→info→agentFlow 正则链删除
- AC：见 §12（grep 门禁 + 场景回归）

---

## 2. 富上下文 prompt（`core/context.mjs` 新建）

每轮 prompt = 以下 6 块拼装（`buildTurnContext(session, text)`）：

| # | 块 | 来源 | 体积控制 |
|---|---|---|---|
| 1 | 本轮文本（已去过敏化） | 用户输入 | 原样 |
| 2 | 最近 4 轮摘要 | `memory.recentTurns` | 每轮 ≤80 字（用户≤200 字截断） |
| 3 | lastPick/lastReceipt 快照 | session | 标题+组成+价格+多久前；**不带**门店码/券ID/订单号 |
| 4 | 菜单快照 + 配料预处理 | query-meals（按门店缓存）+ 短名单 query-meal-detail（见 §4） | 菜单只给名称/价格/编码；详情只给短名单（≤8） |
| 5 | 券折算表 | `coupons.mjs`（见 §3） | 券名｜适用｜预估可省｜折后价 |
| 6 | 用户记忆摘要 | `memory.profileSummary()` | 如"偏好牛肉、喜辣、预算25内"；**过敏只给"有忌口（详情本地）"占位，不给具体值** |

- 系统 prompt：角色=个人麦当劳助手；硬规则：只用上下文中的真实数据回答，不知道就说不知道；绝不输出领券/下单动作（你没有这两个工具）；过敏相关只字不提具体值。
- 预算：整轮（含 MCP 预取 + LLM）`AbortSignal.timeout(10000)`；MCP 预取菜单/券并行，超时则上下文标记"数据不全"，LLM 据此诚实降级。

---
## 3. 券折算（`core/coupons.mjs` 新建，吸收 ex-`web/meal-engine.mjs` 的 `inspectBenefits`/`publicOffers`）

### 3.1 做什么
对每张券算出**价值**（预估可省金额/比例）+ **折后价**，两处使用：
1. 写入上下文（§2 第 5 块），让 LLM 做决策时知道"这张券值多少"；
2. 用户可见：候选卡片上直接标"券后 ¥X（省 ¥Y）"。

### 3.2 算法（调用次数有界）
- 输入：`available-coupons` 的券列表 + 当前短名单候选（≤3）。
- 对每张"本店可用"的券 × 每个候选：`calculate-price` 带券/不带券各一次，差值 = 可省金额。调用上界：`券数 × 3 × 2`，券数通常 ≤8，即 ≤48 次——并行打，失败的券标记"价值未知"，不阻塞。
- 券面值启发式兜底：接口不返回可省金额时（如"9.9元中杯冰美式"），用券名解析面值 − 菜单价估算，并标注"估算"。
- 输出表：`[{name, applicable: bool, saveYuan|ratio|估算, note}]`，同时缓存进 session（按 storeCode+券列表 hash，券包不变不重算）。

### 3.3 文件级改动
- 新建 `core/coupons.mjs`：`valueCoupons()`、`renderCouponTable()`（用户可见版）
- `tui/render.mjs`：候选卡片/价格卡片接入券折算行
- AC：券折算表与 `calculate-price` 真实差值一致（单测 mock）；用户界面能看到每张券的"省 ¥Y"

---

## 4. 配料预处理（`core/menu.mjs` 内，`prefetchDetails()`）

### 4.1 做什么
候选餐品在**首轮 MCP 调用时**就顺手拿 `query-meal-detail`（含 `modification` 可去掉的配料 + 套餐组成），存进上下文（§2 第 4 块）。用户问"有什么料/这个套餐里有什么"时**直接从上下文答，不再现查**。

### 4.2 规则
- 触发时机：门店选定后第一次 `query-meals` 成功后，对"可推荐池"（牛肉/鸡肉/猪肉等主食 × 套餐形态，≤8 个）并行 prefetch detail。
- 缓存：按 `storeCode` 存 session，换店失效；detail 失败的不阻塞（该候选标记"配料未知"）。
- 数据结构：`{code, name, parts:[{name,qty}], removable:[...], meatKind}` —— `meatKind` 复用 issue #2 的 `MEAT_KINDS` 判定逻辑（按产品名，注明）。
- issue #2 的诚实边界保留：接口没给完整配料表时，回答必须声明"不是完整配料表"，只能列"可去掉的料"+确定的肉类/组成。

### 4.3 文件级改动
- `core/menu.mjs`：`prefetchDetails()`（新建）；`detailOf` 解析逻辑从 ex-web 搬入
- `tui/executor.mjs`：`info_ingredients`/`info_parts` 直接读上下文缓存渲染，不调 MCP
- AC：断网 mock 下（detail 接口抛错），"有什么料"仍能答出来自缓存的答案；缓存未命中时诚实说"没查到"而非现查失败崩

---

## 5. 用户记忆 + re-rank + 编号/盲盒（`core/memory.mjs` 新建 + `core/pick.mjs` 重写）

### 5.1 记忆结构
| 字段 | 位置 | 说明 |
|---|---|---|
| `recentTurns[4]` | 内存（session） | 每轮 {text(去敏), summary, ts}；换会话清空 |
| `allergies[]` | 本地文件（现状 `~/.config/mcd-tui/profile.json`） | **永不进 LLM prompt、永不进 MCP**；`stripAllergyText` 在本地做 |
| `taste` | 本地文件 | 偏好：喜好的肉类/口味、`/like` `/less` 反馈、常点。摘要进上下文（§2 第 6 块） |
| `orderHistory` | 本地文件（现状 orders.json） | 雷达/复盘用 |

### 5.2 re-rank（`core/pick.mjs`）
- 候选先过 `eligibility.mjs`（§7），再按记忆打分：偏好肉类 +2、历史 like +2、过敏冲突直接出局（本地规则，不进 LLM）、券折后价排序。
- 输出**编号候选 1/2/3**：卡片按偏好排序渲染编号，用户说"1"/"第一个"/"就要第一个" → `select_candidate{index}`。
- **盲盒模式**：用户说"盲盒/随便来一餐/惊喜" → `blindbox` kind → 从资格通过的候选里**随机**一餐（用户主动触发的随机，合法），渲染时标注"盲盒"，仍走确认门才下单。

### 5.3 模板理由删除
- 删 `assistant.mjs:117` 的 `${season}天的${timeOfDay}` 填充句（"秋天的下午茶"来源）。推荐理由只陈述可验证事实：券折后价排名、偏好命中（"你常点牛肉"）、避开了什么；凑不够就只给一句。

### 5.4 文件级改动
- 新建 `core/memory.mjs`（`stripAllergyText` 搬入、`profileSummary()`、`reRank()`）、重写 `core/pick.mjs`（ex-`web/meal-agent.mjs` 去掉 people/portion 字段）
- `tui/render.mjs`：编号候选卡片（1/2/3）+ 盲盒卡片
- AC：同一候选集，偏好牛肉的用户牛肉餐排第一（单测）；"盲盒" 10 次都在预算内且资格通过（单测 mock random）

---
## 6. 去 web 化：25 行 import 去向 + web/ 处理

`tui/` 下 `grep -rn "from '../web/"` 共 25 行，涉及 9 个 tui 模块 → 全部改指 `core/`，grep 结果必须为空。

| # | 位置 | 导入内容 | 去向 |
|---|---|---|---|
| 1 | `agent-flow.mjs:8` | `MCPError` | `core/mcp.mjs`（随 agent-flow.mjs 删除而消失） |
| 2 | `agent-flow.mjs:9` | `DeepSeekError` | `core/llm.mjs`（同上） |
| 3 | `agent-flow.mjs:10` | `calendarContext` | `core/context.mjs`（只保留日期节假日） |
| 4 | `agent-flow.mjs:17` | `storeStatus` | `core/store.mjs` |
| 5 | `activity.mjs:5` | `timeCondition, couponTimeStatus` | `core/coupons.mjs` |
| 6 | `intent.mjs:4` | `budgetFen` | `core/money.mjs`（随 intent.mjs 删除而消失） |
| 7 | `menu.mjs:4` | `quoteBest, menuItemCart` | `core/pricing.mjs` / `core/menu.mjs` |
| 8 | `assistant.mjs:5` | `prepareAgentInput, validateAgentChoice, localRecommendation` | 重写进 `core/pick.mjs`（去掉 web 的 people/portion 字段） |
| 9 | `assistant.mjs:6` | `memorySummary` | `core/pick.mjs` |
| 10 | `assistant.mjs:7` | `PERSONAS` | **删**（见 §9） |
| 11 | `assistant.mjs:8` | `shiftDay` | `core/history.mjs` |
| 12 | `session.mjs:4` | `MCPClient, MCPError` | `core/mcp.mjs`（重写：clientInfo、"此页面不支持该操作"等 web 文案改掉） |
| 13 | `session.mjs:5` | `inspectBenefits, publicOffers, dateValue` | `core/coupons.mjs` |
| 〃 | 〃 | `prepareWheel, prepareDemo, quoteBest` | `core/pricing.mjs`（`prepareWheel` 改名 `buildCandidates`，去掉 `validateRequest` 里 1–4 人和 5/7/9 分饱的 web 表单规则） |
| 〃 | 〃 | `WheelSession` | 拆开：报价有效期进 `core/pricing.mjs:QuoteWindow`；`choose()` 收进 `tui/`（跟随 `/wheel`） |
| 〃 | 〃 | `menuIndex, menuShape, detailOf` | `core/menu.mjs` |
| 14 | `session.mjs:8` | `readHistory, demoHistory, shiftDay` | `core/history.mjs` |
| 15 | `session.mjs:9` | `storeResults` | `core/store.mjs` |
| 16 | `session.mjs:10` | `DeepSeekClient, DeepSeekError` | `core/llm.mjs`（去掉浏览器 fetch 参数；模型固定 deepseek-v4.1-flash；10s 预算由调用方传入） |
| 17 | `session.mjs:11` | `calendarContext` | `core/context.mjs` |
| 〃 | 〃 | `WeatherClient` | **删**（随 `/weather` 删除，见 §9） |
| 18 | `session.mjs:12` | `defaultPreferences, learnFeedback` | `core/pick.mjs`（去掉 recommendPrompt/optimizePrompt/persona） |
| 19 | `pricing.mjs:4` | `quoteBest` | `core/pricing.mjs` |
| 20 | `render.mjs:2` | `historyCalendar` | `core/history.mjs` |
| 21 | `render.mjs:3` | `storeStatus` | `core/store.mjs` |
| 22 | `render.mjs:4` | `SIGNAL_LABELS` | 收进 `tui/render.mjs`（本地常量，删 `weather` 项） |
| 〃 | 〃 | `PERSONAS` | **删** |
| 23 | `shell.mjs:5` | `MCPError` | `core/mcp.mjs` |
| 24 | `shell.mjs:6` | `DeepSeekError` | `core/llm.mjs` |
| 25 | `shell.mjs:7` | `budgetFen` | `core/money.mjs` |

**web/ 目录处理（建议删除）**：`core/` 吸收完可用逻辑后，删除整个 `web/` 目录。例外需裁决：`web/receipt-card.html` 是 GitHub Pages 小票卡片页的源码，`tui/card.mjs` 的 `CARD_BASE_URL` 指向它——一并删除（小票只留终端文本）还是保留这一个静态页。`scripts/build_frontend.mjs`、`output/` 构建产物随 web/ 删除而失效，一并清理或标注废弃。

**tests/ 对 web/ 的引用**：约 10 个 `tests/*.test.mjs` 直接 import web/——全部改指 `core/` 对应模块；web 专属逻辑的测试删除。

---
## 7. 候选资格门（`core/eligibility.mjs` 新建）

### 7.1 出局规则（翻车 2 的根因修复）
"最便宜"评选前，候选必须全部通过：
1. **建得出购物车**：`menuItemCart` 不抛错（`tui/pricing.mjs:42` 的 `liveAlaCarte` 绕过 carts 是 bug，统一走 cart 构建）。
2. **核价成功**：`calculate-price` 返回有效 `amount`。
3. **价格有效**：`amount > 0`（原 `>= 0` 让 ¥0 合法排第一，改为 `>`）。
4. **过敏不冲突**：本地规则（过敏值不出本机）。

位置：`session.quote()` 内统一过门（`core/pricing.mjs:buildCandidates` 产出候选 → `eligibility.admit()` 过滤 → `memory.reRank()` 排序）；**下单前重核时再用同一套规则查一次**（防券领取后价格变 0/失效）。

### 7.2 出局文案（人话）
| 原因 | 用户看到的 |
|---|---|
| 建不出购物车 | "「{name}」这家店现在做不出来，已跳过" |
| 核价失败 | "「{name}」问不到价，已跳过" |
| 价格为 0/无效 | "「{name}」价格异常（¥0），已跳过" |
| 全部出局 | "这家店现在没有能点的餐（{n} 个候选都没通过检查），换家店或调预算试试" |

文案出现在 `/why` 和空结果卡，不崩、不抛技术黑话。

### 7.3 文件级改动
- 新建 `core/eligibility.mjs`：`admit(candidate)` → `{ok, reason}`
- `core/pricing.mjs`：`buildCandidates` 统一走 cart 构建；`amount > 0`
- `tui/executor.mjs`：空结果兜底卡
- AC：¥0 琵琶腿类候选永不出现在推荐里（单测 mock 0 元）；全部出局时用户看到兜底文案

---

## 8. 下单失败状态机（`core/order.mjs` 新建，本地）

### 8.1 `lastOrderAttempt`（放 `memory.mjs` 的会话区）
```js
{ status: 'failed'|'unknown', reason: 'human可读原因', cartSnapshot, storeCode, ts, retries: 0 }
```

### 8.2 分发
- 当 `lastOrderAttempt.status==='failed'` 时，"重试/再试一次/创建" → `retry_order`（LLM 在上下文里能看到失败摘要，也会判 `retry_order`；双保险）。
- 重试上限 **3 次**；超限 → "这单一直创不出来（{reason}），建议换个餐或稍后再试"，不再重试。
- **幂等**：`reason` 含"已存在/重复"或 MCP 返回订单号时，一律视为成功路径（查单而非重创）；结果不明确的失败（连接中断、超时）**一律不自动重试**，只给用户"重试"按钮语。
- 撞词修复：本地 git 隐喻购物车删除后（§9），"购物车没有变化"文案改为"没下单"；麦当劳返回的"购物车里没有商品"透传时加前缀"麦当劳说："。

### 8.3 文件级改动
- 新建 `core/order.mjs`：`recordAttempt()`、`retryOrder()`（本地确认门内调用 `create-order`）、`canRetry()`
- `tui/executor.mjs`：`retry_order` 分支 + 确认门复用
- AC：create-order mock 失败 → "创建"走重试不走选餐；第 4 次"重试"被拒；超时失败不自动重试

---

## 9. 小票与删除清单

### 9.1 小票
- 删 `maybeReceipt` 定义（`tui/receipt.mjs:68`）+ 两处调用（`shell.mjs:39`、`agent-flow.mjs:284` 随文件删除而消失）+ `RECEIPT_ODDS`/`shouldPrintReceipt` + `session.random` 注入（只为它服务）+ "随手掉落"文案。
- 保留 `/receipt` 命令 + `renderReceipt` + `card.mjs`/`qr.mjs`（web/ 删除裁决见 §6）。

### 9.2 删除清单（莫名其妙的东西）
| # | 项 | 文件 | 理由 |
|---|---|---|---|
| 1 | 随机小票全套 | 上 §9.1 | 输出不可预测；`/receipt` 按需查看已够 |
| 2 | 模板理由 `${season}天的${timeOfDay}` | `assistant.mjs:117`（随文件重写消失） | "秋天的下午茶"来源；§5.3 改为事实陈述 |
| 3 | git 隐喻购物车 `/commit /push /graph /cart`、7 位 hash、"Everything up-to-date" | `tui/orders.mjs`、`shell.mjs:126–163`、`session.mjs:137–168` | 用户看不懂；与麦当劳购物车撞词；真实下单不经过它 |
| 4 | 本餐四轴蜘蛛图 | `tui/radar-chart.mjs`、`shell.mjs:210` | 装饰性；`/radar` 只留历史热力图 |
| 5 | PERSONAS（cozy/frugal/playful）、`/prefs persona` | `assistant.mjs`、`render.mjs:4`、`shell.mjs:187` | 只改语气；统一简洁中性语气 |
| 6 | `/buddy` 的 team/recommend/optimize 模式 | `shell.mjs:168–187` | 暴露内部 Agent 拓扑；固定程序内决策 |
| 7 | `/weather` + WeatherClient + weather 信号 | `shell.mjs:218`、`session.mjs:430–435` | 只为写氛围句；多一个外发点 |
| 8 | prompt 里的季节时段要求、`timeOfDay`/`season` | `assistant.mjs:85–87` | 诱导写填充句 |
| 9 | web 表单残留：1–4 人、5/7/9 分饱 | ex-`web/meal-engine.mjs:281`（不搬进 core） | TUI 一人一餐 |
| 10 | web 文案/浏览器参数（"此页面""跨域"、fetch credentials 等） | `core/mcp.mjs`、`core/llm.mjs` 重写时改掉 | 终端语境 |

---
## 10. 不变量（红线）

| 不变量 | 落点（改后） | AC |
|---|---|---|
| **领券/下单永远本地确认门** | LLM 的工具列表里没有 `auto-bind-coupons`/`create-order`（§1.3）；`confirm_pick`/`select_candidate` 只把流程带到确认门前；`tui/executor.mjs` 的 `runBuyFlow` 必问"**是这家店吗？**"；`core/order.mjs` 写函数要求本地 `confirmed===true` | mock LLM 对任意输入都返回 `confirm_pick`，10 轮不回答"是"，`claimAll`/`createOrder` 调用次数为 0 |
| **过敏信息永不外发** | `stripAllergyText` 覆盖本轮文本 + `recentTurns` 每条 + `profileSummary`（只留"有忌口（详情本地）"占位）；MCP 参数不出现过敏信息 | mock 审计：LLM 收到的 prompt 全文 + 全部 MCP 请求参数中 grep 过敏词 = 0 命中 |
| **正确性 > 速度** | 每轮 `AbortSignal.timeout(10000)` 贯穿 MCP 预取 + LLM；tool-calling ≤3 轮工具+1 轮终答；超时/校验失败 → `{kind:'unknown'}` 诚实降级；资格门、重核、确认门永不被跳过 | mock DeepSeek 每次 6s → 当轮 LLM 调用 ≤2 次且结果卡出现"按本地规则"降级说明 |

---

## 11. 文件级改动总清单

**新建**（`core/` 13 个 + `tui/` 1 个）：
`core/llm.mjs`、`core/tools.mjs`、`core/hub.mjs`、`core/context.mjs`、`core/memory.mjs`、`core/coupons.mjs`、`core/eligibility.mjs`、`core/order.mjs`、`core/pricing.mjs`、`core/menu.mjs`、`core/store.mjs`、`core/mcp.mjs`、`core/history.mjs`、`core/pick.mjs`、`core/money.mjs`（15 个，含 money）、`tui/executor.mjs`

**删除**：
`tui/intent.mjs`、`tui/agent-flow.mjs`、`tui/assistant.mjs`（逻辑分别进 core/memory、core/hub、core/pick）、`web/` 整个目录（§6 裁决点除外）、`tui/orders.mjs` 的 git 部分、`tui/radar-chart.mjs` 的本餐蜘蛛图、`tui/receipt.mjs` 的随机掉落部分

**重写**：
`tui/shell.mjs`（`handle()` → 去敏→hub→executor）、`tui/render.mjs`（编号候选卡/盲盒卡/券折算行）、`tui/session.mjs`（瘦身为状态容器：store/coupons/memory/conversation，业务逻辑迁 core）

**测试**：`tests/` 中 import web/ 的约 10 个文件改指 core/；删除意图正则测试；新增：tool schema 测试、hub loop（mock LLM+MCP）、eligibility、retry 状态机、券折算、10s 熔断、无 web import grep 测试、零意图正则 grep 测试。

---

## 12. AC（验收标准）

- [ ] `grep -rn "from '../web/" tui/` 结果为空；`web/` 目录不存在（§6 裁决点除外）
- [ ] `grep -rEn "parseBuyIntent|parsePriceQuery|parseInfoQuery|PARTS_HINT|DEICTIC|MEAT_ASK" tui/` 结果为空（零意图正则）
- [ ] issue #8 的 4 个翻车逐条复现通过（真 PTY）："这个看起来不错，吃这个"→确认门不重选；¥0 餐永不获胜；"创建"走重试；无随机小票
- [ ] "这个有牛肉吗/套餐里有什么/有什么料"直接从上下文答（mock 断网仍能答缓存答案）
- [ ] 券折算表与 `calculate-price` 真实差值一致；用户界面可见"券后 ¥X（省 ¥Y）"
- [ ] 编号推荐 1/2/3 按偏好排序；"盲盒" 10 次都在预算内且资格通过
- [ ] 不变量三项 AC（§10）全过
- [ ] 全量单测绿 + 真实 PTY + 真店 example（天河城）

---

## 13. 待用户裁决

1. `web/receipt-card.html`（GitHub Pages 小票卡片页）：随 web/ 一并删除（小票只留终端文本），还是保留这一个静态页？
2. 盲盒模式的随机范围：仅"资格通过且预算内"，还是允许用户指定品类（如"盲盒，来个牛肉的"）？
3. `core/` 13+1 个模块是一次性全建，还是允许 Grok 在实现中合并小模块（如 money 并入 pricing）？默认允许合并，但 hub/llm/tools/memory/order 必须独立。

---

## 14. 用户裁决（2026-10-14，已拍板，实现必须执行）

1. **小票卡片页保留**：`web/receipt-card.html` 在去 web 化时搬到新位置（不留在 web/ 下，实现者定）。**URL payload 改 Base64url 编码**：`#v1~双层吉士汉堡~...` 裸 UTF-8 fragment 易坏，改成 `#b64.<base64url>`，卡片页负责解码渲染；生成 QR/链接的地方同步改编码。Pages 部署挂掉是因为 workflow 缺 `npm install`——**不许碰 `.github/workflows/`**，只确认 `scripts/build_frontend.mjs` 正确拷贝卡片页；workflow 修法已写在 issue #8 评论，由用户手动改。
2. **盲盒 = 预算内 + 资格通过的随机主食**，不用指定品类。
3. **模块可自由合并/删除**，但 PLAN 规定独立的（hub/llm/tools/memory/order）必须保持独立，其余按 PLAN 来。
4. **购物车保留但简化**：可选暂存区，不强制使用；去掉 git 黑话（/commit//push//graph 那套），命令简化；核心下单流程不依赖它。
