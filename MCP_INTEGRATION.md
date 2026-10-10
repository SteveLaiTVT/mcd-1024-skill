# MCP 接入说明

官方地址为 `https://mcp.mcd.cn`，Streamable HTTP、Bearer Token。当前前端原型使用 [web/mcp-client.mjs](web/mcp-client.mjs)：用户在本地扩展应用页输入自己的凭证，直接发送给官方；不经过开发者业务服务器。

[mcp-config.example.json](mcp-config.example.json)保留 `${MCD_TOKEN}` 环境变量占位符，供支持展开占位符的 MCP 宿主使用。Python 研究脚本读取进程环境；扩展不读取它，也不把 Token 写入配置文件。真实 WorkBuddy 调研、初始化与发布配套记录见 [workbuddy.md](workbuddy.md)，专项奖励以活动审核为准。

## 工具与用途

| 工具 | 业务用途 | 当前前端 |
|---|---|---|
| `now-time-info` | 官方日期、核价与报价有效时间 | 已实现 |
| `query-nearby-stores` | 按用户填写的城市 / 位置关键词选店，恢复时确认营业情况 | 展示营业状态、时段及全部返回预约时段；没有经纬度入参 |
| `delivery-query-addresses` | 用户主动读取已存地址，选择搜索位置 | 仅保留 `fullAddress` 供本页选择，不展示联系人、电话或 ID |
| `query-meals` | 选择门店当前菜单 | 已实现 |
| `query-meal-detail` | 套餐轮次、子项数量与特调 key | 已实现 |
| `available-coupons` | 当前可领取券展示 | 已实现 |
| `query-my-coupons` | 逐页读取持有券，按资产去重 | 已实现 |
| `query-store-coupons` | 门店/到店渠道范围与商品映射 | 已实现 |
| `campaign-calendar` | 活动表与可关联的券星期/时段限制 | 已实现 |
| `calculate-price` | 完整餐单的无券基准和有券方案核价 | 已实现 |
| `order-list` | 个人历史订单、套餐子项与用餐热力图 | 用户主动读取；无分页参数，覆盖不完整 |
| `auto-bind-coupons` | 领取全部当前可领券 | 仅显式按钮确认；未实际执行 |
| `list-nutrition-foods` | 公开营养表快照 | 仅研究脚本，非当前页面请求 |

只读工具有明确允许列表；领券通过独立方法发送一次。历史只使用 `order-list`，不调用含地址、电话或支付数据的订单详情工具。前端没有创建、支付、取消、配送或企业团餐链路。发现 35 个工具不等于全部使用，公开定义见 [data/tool-catalog.json](data/tool-catalog.json)。

## 前端调用流程

```text
用户填 Token → initialize → notifications/initialized → now-time-info
  或从本机已保存凭证恢复 → initialize → now-time-info
  → query-nearby-stores 重新确认上次门店，不恢复旧报价
用户主动读取地址 → delivery-query-addresses → 选地址填入位置，确认城市
用户按城市/关键词查询门店 → 明确选择到店门店
  → now-time-info + available-coupons + query-my-coupons（分页）
  + query-store-coupons + campaign-calendar → 优惠信息表
用户提交人数、食量、人均预算和确认避开的主食
  → 重查优惠状态 → query-meals + query-meal-detail
  → 构造完整套餐，核实每人主餐数量与合法选项
  → calculate-price（无券基准 + 持有且适用的券方案）
  → 完成全部比较 → 按整顿预算过滤 → 启用圆盘

用户在雷达点击“读取我的历史”（不需要门店）
  → now-time-info → order-list({})
  → 去重、筛选已完成 / 已评价、按中国时区归日
  → 全年或近 12 周热力图、日期餐单、常点餐品
  → 用户主动把前两天可识别主食加入避开项 → 重新核价
```

领券按钮先说明“全部领取”，确认后调用 `auto-bind-coupons({})`，再重新查券与核价；不支持单张参数。超时或响应不明确时不自动重试，也不当作成功，要求先主动刷新券包核对。

当前取餐场景为 `beType=1/orderType=1`，不传 `beCode`。`query-promotions` 的前置条件是企业团餐，普通多人餐的信息表标记其不适用。

## 协议、隐私与计价规则

- 固定官方域名，请求不携带 Cookie，不跟随重定向，不记录原始响应或请求日志。支持 JSON 和 SSE，按 RPC ID 选择结果，优先读取 `structuredContent`。
- Token 默认仅在应用页内存中，提交后清空输入框。2.2.0 提供默认不勾选的本机长期保存选项，仅保存 Token 和上次门店身份到 `chrome.storage.local`，限制为扩展可信上下文，不同步、不上传开发者。取消勾选或主动断开删除记录；页面退出只清除当前客户端和在途请求。MCP session、券资产、地址簿、历史与报价不持久保存。
- 个人资产 ID/规则码只用于官方核价，展示报告不输出这些标识。没有埋点、云端存储或浏览器同步存储。
- 核价金额用整数分；菜单字符串价格只作展示。子项数量按每份套餐提交，展开餐单时乘外层套餐份数；特调的选中与未选中 key 都保留。
- 持有证明与门店可用范围均满足后才尝试用券，同一资产最多使用一次。活动文章的 0 值价格不代表免费；官方整单已有优惠不再扣一次。
- 每份餐单最多比较 64 个券方案，钱包最多读取 5 页 × 200 项。截断、失败或规则读取不完整时显示限制，不宣称全局最低。
- 服务器时间决定剩余有效期，浏览器以单调时钟倒计时。修改条件、换门店、领券、断开或过期后旧圆盘失效。
- 雷达按已返回的完成订单数着色，不推断个人吃了多少餐或全年消费；订单 ID 只在本次响应去重，统计对象和页面不保留它。订单金额单位尚未确认，因此不展示消费额。未返回日期保留未知状态。

## 静态模式与研究数据

2.3.0 的 AI 推荐使用独立 DeepSeek 客户端，不把 MCP Token 交给模型。先按上述流程完成核价，再把限定候选、手写偏好 / prompt、明确反馈摘要和已读城市情境发送到 DeepSeek 官方 API；推荐 / 优化 Agent 最多两轮，不能调用任何 MCP 业务工具。key 和记忆各有独立本机 opt-in，麦当劳和 DeepSeek 可以分别停用 / 清除。官方模型标识为 `deepseek-flash`（V4.1 Flash）。天气使用 Open-Meteo 城市中心，没有 GPS、私人地址或订单发送；数据范围见 [docs/meal-agents.md](docs/meal-agents.md)。

`scripts/serve_wheel.py` 只提供构建后的静态文件，没有业务 API，也不读取 Token。普通网页当前不能通过官方 CORS 预检；静态体验禁用 Token 输入和真实领券，套餐使用标明采样时间的公开样本，雷达示例明确标注虚构且不能导入主食。

Python 模块保留早期研究与样本复核流程：门店/菜单/套餐 → 50 份整单核价 → 营养、可领券与日历 → 脱敏、校验、写入 manifest。数据为深圳样本门店与采样时点绑定的结果，不能替代实时核价。

## 实测边界

2026-10-10 17:42，当前 JavaScript 客户端在 Node 环境完成官方初始化、时间查询与可领券查询，返回 6 条展示。此前 Python 完成单人 5 份、双人 6 份官方整单核价；30 元人均预算分别留下 3 / 4 份候选。券包与样本门店券为空。

当前 JavaScript 历史读取在 Node 环境返回 10 笔完成订单、8 个有记录日期，真实数据按模块生成 53 周年度日历；前两天没有可精确匹配的已知主食。原始订单未保存。这证明官方读取和统计，不证明浏览器热力图已验收。

这些 Node/Python 结果证明协议与部分业务数据可读取，不单独证明浏览器直连。用户安装后发现调用上下文错误，修复后重新加载并明确反馈连接成功、出现门店选择，浏览器初始化获得独立复测证据。当前 48 项 JavaScript 测试通过，包含本机凭证恢复和营业状态、地址选择的模拟验证。真实长期凭证恢复和地址查询需分别核对。新版雷达虚构示例已在 Chrome 检查显示；真实长期凭证恢复、真实历史显示、领取成功、真实持券折扣和后续整单浏览器链路仍需分别验证；领券、下单、支付、公开部署均未执行。证据清单见 [docs/validation.md](docs/validation.md)。

参赛形式与 MCP 服务使用规则是两个边界，现有自动化调用限制如何适用于本地扩展仍待官方确认，见 [docs/frontend-architecture.md](docs/frontend-architecture.md)。

2.3.0 后续 Chrome 实测已完成保存账号 / 门店恢复、官方券查询与单人实时整单核价：4 份报价成功 / 2 份预算内，另 1 份失败未入盘；¥22.90 / ¥28 的候选经真实 DeepSeek 推荐与优化两轮校验显示。未将 MCP 凭证、地址或订单传给模型；没有执行领券、下单或付款。详见最新 [验证记录](docs/validation.md)。
