# 麦当劳 MCP 实测笔记

> 实测时间：2026-10-10 15:51–15:52（北京时间）
> 实测方式：WorkBuddy 连接器直连 `https://mcp.mcd.cn`（Streamable HTTP）
> 实测范围：**只读接口**。所有写操作（下单、领券、抽奖、取消订单、创建地址）**未执行**。
> 所有涉及个人账户的返回值仅记录**结构**，不记录具体数值。

---

## 一、实测总览

| # | Tool | 调用参数 | 返回格式 | 结果 |
|---|---|---|---|---|
| 1 | `now-time-info` | — | 纯 JSON | ✅ 服务器时间，含 timestamp / timezone / dayOfWeek |
| 2 | `list-nutrition-foods` | — | **Markdown 文本** | ✅ 160 项营养数据 |
| 3 | `campaign-calendar` | — | **Markdown 文本** | ✅ 当月活动（往期/今日/未来） |
| 4 | `query-nearby-stores` | beType=1, searchType=2, city, keyword | 纯 JSON | ✅ 门店列表（含预约时段） |
| 5 | `query-meals` | storeCode, orderType=1, beType=1 | 纯 JSON | ✅ 菜单分类 + 餐品映射表 |
| 6 | `query-meal-detail` | + code | 纯 JSON | ✅ 选配轮次（rounds/choices/modification） |
| 7 | `calculate-price` | + items | 纯 JSON | ✅ 金额（单位分） |
| 8 | `query-my-account` | — | 纯 JSON | ✅ 积分账户 |
| 9 | `available-coupons` | — | **Markdown 文本** | ✅ 可领券列表 |
| 10 | `query-my-coupons` | — | **Markdown 文本** | ✅（无券时返回纯文案） |
| 11 | `query-store-coupons` | storeCode, orderType, beType | **模板文本 + JSON** | ✅（该门店返回空数组） |
| 12 | `mall-points-products` | — | **模板文本 + JSON** | ✅ 积分商城 40+ 商品 |
| 13 | `order-list` | — | 纯 JSON | ✅ 历史订单（含套餐子项拆解） |
| 14 | `mall-order-list` | size | 纯 JSON | ✅ 商城订单 |
| 15 | `query-lottery-info` | — | 纯 JSON | ✅ 抽奖活动 + 26 种奖品 |
| 16 | `delivery-query-addresses` | — | **模板文本 + JSON** | ✅（当前账号无地址，返回空数组） |

**结论**：Token 有效，连接器工作正常，工具描述与实际返回一致。

---

## 二、七个必须知道的工程坑

### 坑 1 ⚠️ 返回格式不统一：一半是 JSON，一半是 Markdown 文本

这是最影响开发效率的一点。同一套 MCP，接口的返回形态分三类：

| 类型 | 接口 | 说明 |
|---|---|---|
| **纯 JSON** | `query-meals`、`query-meal-detail`、`calculate-price`、`query-nearby-stores`、`query-my-account`、`order-list`、`mall-order-list`、`query-lottery-info`、`now-time-info` | 可结构化解析 |
| **Markdown 文本** | `list-nutrition-foods`、`campaign-calendar`、`available-coupons`、`query-my-coupons` | `data` 字段是**一整块人类可读文本**，需要自己写解析器 |
| **模板文本 + 尾部 JSON** | `query-store-coupons`、`mall-points-products`、`delivery-query-addresses` | 前面是给模型看的展示模板，JSON 直接接在模板后面，**没有分隔符** |

**实例**：`list-nutrition-foods` 的 `data` 实际长这样——

```
[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  猪柳麦满分,null,1288,308,16,16,24,781,213
  猪柳蛋麦满分,null,1618,387,23,21,25,846,243
  ...
```

这是一个**类 CSV 的自描述文本格式**：第一行是 `[总数]{字段名}`，后面每行一条记录。要解析必须自己按 `,` 切分并注意末行无换行。

**影响**：任何以这些接口为数据源的项目，都要额外写一层解析适配。**这本身就是一个可做的技术点**——目前榜单上没有项目提到这个问题。

### 坑 2 ⚠️ 数值类型混乱：价格是字符串，积分是字符串，算价结果是整数分

| 接口 | 字段 | 实际类型 | 实际值示例 |
|---|---|---|---|
| `query-meals` | `currentPrice` / `originalPrice` | **string** | `"33.5"` |
| `query-my-account` | `availablePoint` | **string** | 字符串形式的积分数 |
| `order-list` | `realTotalAmount` | **string** | `"22.9"` |
| `calculate-price` | `price` / `discount` 等 | **integer（单位：分）** | `2980` = ¥29.80 |
| `mall-points-products` | `point` / `price` | **string** | `"800"` / `"0"` |

**三个不同的货币口径同时存在**：菜单是"元（字符串）"，算价是"分（整数）"，订单是"元（字符串）"。

**坑**：直接做算术不加转换会出错。`calculate-price` 的返回值**必须除以 100** 才是元（工具描述里明确写了）。

### 坑 3 ⚠️ `query-meal-detail` 的特调 key 规则极其反直觉

套餐详情返回 `rounds`（如「蓝区」「粉区」）→ `choices`（可选项）→ `modification`（特调项）。

特调项的关键陷阱：

```
{ code: "100141", name: "吉士", selectedKey: "0-1", unselectedKey: "0-0" }
```

**规则**：对于**包含 `unselectedKey` 的特调组**，调用 `calculate-price` 时必须把该组**所有**特调项都传进去——
- 用户**选中**的项：`key = selectedKey`
- 用户**未选中**的项：`key = unselectedKey`（也必须传）

也就是说，"不要吉士"不是不传，而是**传 `key="0-0"`**。

另一条：当某特调组 `minValues=1 && maxValues=1` 且只有一个 value 时，该项**必选**，不能向用户提供"不选"选项。

**影响**：这是整个 MCP 里最容易写错的地方。任何做"套餐换品 / 特调"的项目都必须正确处理，否则算价和下单都会失败。

### 坑 4 ⚠️ 门店经纬度返回 0.0

`query-nearby-stores` 返回的门店对象里有 `longitude` 和 `latitude` 字段，但实测值**全部是 `0.0`**：

```json
{"storeCode":"1420762","storeName":"...","address":"...","distance":403,
 "longitude":0.0,"latitude":0.0,"businessStatus":true,...}
```

**影响**：任何想做"门店地图"的项目**拿不到官方坐标**，必须自己按 `address` 做地理编码，或者改用 `distance`（相对距离）做展示。榜单上第 1 名的项目声称"门店位置取自官方经纬度"——这一点需要重新核实。

**可用的替代数据**：`address`（详细街道地址）、`distance`（米）、`businessStatus`（是否营业）、`businessStartTime` / `businessEndTime`（营业时段）、`reservation` + `reservationTimeOptions`（可预约时段，含早餐/午餐/下午茶/夜市/宵夜分档）。

### 坑 5 ⚠️ 数据存在重复项，且过期商品仍标记"上架"

实测发现两类脏数据：

1. **重复**：`list-nutrition-foods` 中「小杯玉米杯」「纯牛奶（盒装）」各出现 **2 次**；`available-coupons` 中同一张券重复出现 **3 次**。
2. **过期未下架**：`mall-points-products` 的 `status` 字段含义是 `1-仓库中 2-上架 3-售罄 4-下架 5-预热`，但多个 `downTime` 早已过去的商品**仍然返回 `status=2`（上架）**。

**影响**：任何涉及"可兑换商品""可用券"的项目，**必须自己按 `upTime` / `downTime` 与当前时间做二次过滤**，不能直接信任 `status`。同时要做去重。

**这是被验证过的真实数据质量问题，也是很好的立项理由。**

### 坑 6 ⚠️ 团餐 / 外送路径前置门槛高

`query-meal-assistance`（团餐助餐服务）的完整调用链需要：

```
delivery-query-addresses        ← 必须先有配送地址
  → delivery-query-stores(addressId, beType=6)
    → query-meals(storeCode, orderType=2, beType=6, beCode)
      → query-meal-assistance(storeCode, beCode)
        → calculate-price(..., gmServiceCode)
```

**实测**：当前账号**没有任何配送地址**，`delivery-query-addresses` 返回空数组，因此团餐/外送链路**无法走通**（创建地址属于写操作）。

**影响**：团餐方向虽然榜单空白，但**前置门槛高**——需要真实的企业配送地址才能完整验证。这很可能正是它没人做的原因。

### 坑 7 ⚠️ `calculate-price` 是"只算不买"，可以安全用于试算

工具描述明确：`calculate-price` 只返回金额明细，**不创建订单**。实测确认它返回：

- `productPrice` / `originalPrice` / `discount` / `price`（单位：分）
- `productList`（逐项小计）
- `takeWayList`（取餐方式：`eat-in` 堂食 / `locker-out` 外带柜）
- `enjoyed` / `enjoyable`（已享受 / 可享受的优惠，含 `amountType`：1 特价、2 折扣、3 立减）

**这是唯一可以零风险做"价格试算"的接口**。做省钱类项目时，可以放心地对任意组合反复调用它来穷举最优解。

---

## 三、未执行的写操作（清单）

以下工具具备**真实业务后果**，本次实测**一律未调用**：

| Tool | 后果 |
|---|---|
| `create-order` | 真实下单、产生费用 |
| `cancel-order` | 取消真实订单 |
| `auto-bind-coupons` | 自动领取全部可领券 |
| `mall-create-order` | 消耗积分兑换商品 |
| `draw-lottery` | 消耗积分抽奖 |
| `party-order-create` | 创建派对订单 |
| `delivery-create-address` | 新增配送地址 |

**开发原则**：任何写操作都必须经过用户**显式确认**后再执行，绝不静默扣费或领券。

---

## 四、数据形态速查（供开发用）

```
now-time-info          → { timestamp, datetime, date, year, month, day, dayOfWeek, timezone, utc }
list-nutrition-foods   → 文本表，160 行 × 9 字段（productName, nutritionDescription,
                          energyKj, energyKcal, protein, fat, carbohydrate, sodium, calcium）
query-nearby-stores    → [{ storeCode, storeName, address, distance, businessStatus,
                            businessStartTime, businessEndTime, longitude(0.0), latitude(0.0),
                            reservation, reservationTimeOptions[] }]
query-meals            → { categories:[{name, meals:[{code, tags}]}],
                           meals:{ code: {name, image, currentPrice, originalPrice,
                                          discountType, canWithOrder, withOrder} },
                           frequent:{code, tags} }
query-meal-detail      → { code, name, image, supportModify,
                           rounds:[{id, name, quantity, minQuantity, maxQuantity,
                                    choices:[{code, name, quantity, maxQuantity, isDefault,
                                              diffPrice, supportModify, modification}] }],
                           modification }
calculate-price        → { productOriginalPrice, productPrice, deliveryPrice, packingPrice,
                           tablewarePrice, originalPrice, discount, price,     ← 全部单位：分
                           productList:[{productCode, productName, quantity,
                                         originalSubtotal, subtotal}],
                           takeWayList:[{code, title, subtitle}],
                           enjoyed{}, enjoyable{} }
order-list             → { list:[{ orderId, orderType, createTime, beType, beCode,
                                   storeCode, storeName, orderStatus,
                                   orderProductList:[{productCode, productName, quantity,
                                                      comboItemList:[{productCode, name, quantity}]}],
                                   realTotalAmount }] }
query-my-account       → { accountId, currency, availablePoint, accumulativePoint,
                           usedPoint, expiredPoint, frozenPoint,
                           currentMouthExpirePoint, lastMouthExpirePoint, nextMouthExpirePoint }
query-lottery-info     → { status{code,message}, activityCode, activityName, activityStatusText,
                           beginTime, endTime, drawPoint, drawTypeText, availableTimes,
                           availablePoint, drawDecision{resourceEligible, reason,
                           nextConsumption{type,points,chances,text}, fallbackConsumption},
                           prizes:[{name, imageUrl, typeText}] }
mall-points-products   → [{ spuName, spuId, point, selling, upTime, downTime,
                            spuImage, shopId, catName, status, price }]
mall-order-list        → [{ hasNext, lastId, list:[{orderId, orderStatus,
                            orderStatusTitle, totalCount, goods[]}] }]
```

---

## 五、可复现的实测命令

通过 WorkBuddy 连接器配置（`mcp-config.example.json`）后，可在对话中直接调用。典型只读探针：

```
1. now-time-info              → 验证连通性（零参数、零副作用）
2. query-nearby-stores        → 取一个 storeCode 供后续调用
3. query-meals(storeCode)     → 取菜单与商品 code
4. query-meal-detail(code)    → 取套餐结构
5. calculate-price(items)     → 试算价格（不产生订单）
```

---

*本笔记为麦当劳程序员创意开发大赛参赛作品《mcd-1024-skill》的开发文档。项目非麦当劳官方产品，所有数据均来自麦当劳官方 MCP 接口的实时返回。*
