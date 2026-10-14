# 实现笔记（相对 PLAN §1–§14）

按 PLAN 字面实现。下面每一条都是和 PLAN 原文不完全一样、但选了最贴近字面的做法。

1. `web/` 整目录，以及 `tui/intent.mjs`、`tui/agent-flow.mjs`、`tui/assistant.mjs`、`tui/radar-chart.mjs`，环境拒绝了不可逆删除。四个 TUI 文件已改成一行说明，不再导出旧符号，也不再含意图正则或 `from '../web/'`。`grep -rEn "from '../web/" tui/` 与意图正则 grep 均为空。卡片页在 `static/receipt-card.html`。`scripts/build_frontend.mjs` 把它拷到 `output/.../receipt/index.html`；扩展资源缺失时按 ENOENT 跳过。`.github/workflows/` 未改。

2. `WheelSession` 留在 `core/pricing.mjs`（`QuoteWindow` 的子类）。`core/coupons.mjs`、`core/menu.mjs`、`core/money.mjs` 独立存在。`hub` / `llm` / `tools` / `memory` / `order` 各自一个文件。

3. 购物车磁盘格式仍是 `commits` + `placed` + 7 位 hash，这样已有的 `loadOrders` 和购买记录还能读。用户命令不再出现 `/commit`、`/push`、`/graph`、`Everything up-to-date`、`购物车没有变化`。`renderGraph` 还在文件里，没有挂到命令上。清空取消文案是「已取消，没清空」。下单失败文案是「没下单」。麦当劳原因里含「购物车」时前缀是「麦当劳说：」，其余仍是「麦当劳未创建订单：」。

4. 配料和组成由 `tui/info.mjs` 只读 `detailCache`，不采用模型 `answer` 字段。没有缓存时说「没查到」。`complete !== true` 时必须带「不是完整配料表」。不再用正则按品名去菜单里现查。

5. JSON 的 `candidate_index` 是 0、1、2。界面编号是 1、2、3。给出推荐时 `lastPick` 记第 1 个。

6. 生成的链接只有 `#b64.<base64url>`。卡片页仍能解开旧的裸 `#v1~`。

7. `--fake-llm` 只在传入该参数时动态加载 `tests/fake-llm.mjs`。`MCD_TEST_ZERO=1` 在资格门之前塞入 ¥0 候选。`MCD_TEST_ORDER_FAIL=1` 让演示模式在答「是」之后记一笔失败，这样真 PTY 能看到「创建」走重试。演示模式本身不调用 `create-order`。幂等（原因含「已存在」或「重复」）不自动再下单，也不调用 `query-order`，只提示先查订单。

8. `calculate_price` 的 schema 有 `couponIds`，`toolToMcp` 不把它们传给 MCP。核价参数只有 `storeCode`、`orderType`、`beType`、`items`。

9. 口味只在本次会话（`session.taste`）。档案文件只有过敏原。`profileSummary` 只写「有忌口（详情本地）」。系统提示里有「过敏」这个类别词，没有具体过敏原。单测审计的是具体过敏词。

10. `session.random` 保留给用户主动触发的盲盒。随机小票（`maybeReceipt` / `shouldPrintReceipt` / 「随手掉落」）已去掉。

11. 没有本地正则解析「预算」「有什么活动」「外送」。预算来自模型 `slots.budget_yuan` 或 `/set`。没 key 时整句走本地编号，不从句子里抽预算。「有什么活动」交给模型；没 key 时就是一次本地推荐。`/activity` 仍是只读命令。外送不创建订单，流程固定到店自取。

12. `quoteBest` 仍把 `amount >= 0` 当作一次核验过的券后价（原有「0 元是合法核价」测试保留）。资格门单独要求 `amount > 0`，不折进 `quoteBest`。

13. 本地只保留：候选编号（`^[123]$`、`第[一二三]个`）、斜杠命令、`stripAllergyText`（定义在 `core/memory.mjs`，`tui/allergy.mjs` 再导出）、以及 `lastOrderAttempt` 存在且状态不是 `success` 时的 `RETRY_PHRASE`（`重试|再试一次|创建`）。没 key 时「吃这个」不会下单，只出「本地模式」编号卡。「吃这个」要变成 `confirm_pick` 只能走模型（测试用 `tests/fake-llm.mjs`）。

14. 超时面板写「按本地规则没能问完模型」，不再补一屏本地编号卡。校验失败是「没理解，能再说一遍吗」。

15. 演示模式也先问「是这家店吗？」，答「是」才回 `BUY_DEMO`。

16. 「你好 / 谢谢」等寒暄在进 hub 之前本地回复。这不是选餐正则。

17. 执行器里的重试再次进入 `runBuyFlow`（再问一次确认门），不直接调用 `core/order.mjs` 的 `retryOrder()`。`retryOrder` 仍要求 `confirmed === true`。失败重试次数只在「这次是重试，且新的失败明确、不是重复单」时 +1。不明失败记成 `unknown`，不自动重试。

18. MCP：拒绝未列入只读工具的调用，文案含「不支持」。fetch 不再带浏览器的 `credentials` / `referrerPolicy`。`clientInfo` 是 `mcd-tui` `2.3.0`。

19. `tests/account-storage.test.mjs` 和 `tests/ui-flow.test.mjs` 改成占位测试，不再 import `web/`。`scripts/package_release.py` 的卡片页源从 `web/receipt-card.html` 改为 `static/receipt-card.html`。README 对应的一行已改。

20. `validateRequest` 不再因为人数不在 1–4 或饱腹不在 5/7/9 而抛错。TUI 固定 `people: 1`。`portion` 为空表示不按饱腹过滤。

21. 门店选定后的预取最多 8 个主食，失败记 `unknown: true`、`complete: false`。`session.quote` 还会用候选组成填一份 `complete: false` 的缓存。
