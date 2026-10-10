# MCP 接入说明

> 本文档说明本项目实际使用的麦当劳 MCP Server、Tool、调用流程与业务价值。
> 实测时间：2026-10-10 · 实测环境：WorkBuddy 连接器直连

---

## 1. 使用的 MCP Server

| 项 | 值 |
|---|---|
| 名称 | 麦当劳中国 MCP Server（`mcd-mcp`） |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | **Streamable HTTP** |
| 认证方式 | 请求头 `Authorization: Bearer <MCD_MCP_TOKEN>` |
| Token 申请 | <https://open.mcd.cn/mcp>（手机号登录 → 控制台 → 激活） |
| 限流 | 600 次/分钟（超出返回 429） |
| 工具总数 | 35 个 |
| 官方文档 | <https://github.com/M-China/mcd-mcp-server> |

配置示例见 [`mcp-config.example.json`](mcp-config.example.json)。**本仓库不含任何真实 Token。**

---

## 2. 实际调用的 Tool

> 下表为**实测已调用**的 16 个接口（均已完成真实请求并记录返回）。

### 2.1 基础设施类

| Tool | 调用参数 | 用途 | 实测返回 |
|---|---|---|---|
| `now-time-info` | 无 | 获取服务器时间，用于时段判断与活动日历锚定 | JSON：`timestamp` / `datetime` / `dayOfWeek` / `timezone` |

### 2.2 门店与菜单类

| Tool | 调用参数 | 用途 | 实测返回 |
|---|---|---|---|
| `query-nearby-stores` | `beType=1`、`searchType=2`、`city`、`keyword` | 定位可点餐门店 | JSON 数组：`storeCode` / `storeName` / `address` / `distance` / `businessStatus` / 营业时段 / 可预约时段 |
| `query-meals` | `storeCode`、`orderType=1`、`beType=1` | 拉取门店在售菜单与价格 | JSON：`categories` 分类 + `meals` 商品映射（名称/图片/现价/原价/优惠类型/随单购） |
| `query-meal-detail` | `storeCode`、`orderType`、`beType`、`code` | 查看套餐组成与可换选项 | JSON：`rounds` 选配轮次 + `choices` 选项 + `modification` 特调项 |
| `list-nutrition-foods` | 无 | 获取官方营养数据 | **文本表**：160 条 × 9 字段（能量/蛋白/脂肪/碳水/钠/钙） |

### 2.3 价格类

| Tool | 调用参数 | 用途 | 实测返回 |
|---|---|---|---|
| `calculate-price` | `storeCode`、`orderType`、`beType`、`items[]` | **只算价，不创建订单** | JSON：`price` / `discount` / `originalPrice`（**单位：分**）、逐项小计、取餐方式、已享受/可享受优惠 |

### 2.4 会员资产类

| Tool | 调用参数 | 用途 | 实测返回 |
|---|---|---|---|
| `query-my-account` | 无 | 查询积分账户 | JSON：可用/累计/已用/已过期/冻结/本月将过期/下月将过期积分 |
| `query-my-coupons` | `page`、`pageSize` | 卡包内全部券 | **文本** |
| `query-store-coupons` | `storeCode`、`orderType`、`beType` | 指定门店可用券 | 模板文本 + JSON 数组 |
| `available-coupons` | 无 | 当前可领取的券 | **文本 + 图片链接** |

### 2.5 订单与商城类

| Tool | 调用参数 | 用途 | 实测返回 |
|---|---|---|---|
| `order-list` | 无 | 历史点餐订单（**含套餐子项拆解**） | JSON：`orderProductList[].comboItemList[]` |
| `mall-order-list` | `size` | 麦麦商城订单 | JSON：`orderId` / `orderStatus` / `goods[]` |
| `mall-points-products` | 无 | 积分商城商品 | 模板文本 + JSON：`spuId` / `point` / `price` / `upTime` / `downTime` / `status` |
| `query-lottery-info` | 无 | 积分抽奖活动（**不执行抽奖**） | JSON：`drawPoint` / `drawTypeText` / `drawDecision` / `prizes[]` |
| `delivery-query-addresses` | 无 | 配送地址列表 | 模板文本 + JSON：`addressId` / `contactName` / `fullAddress` |

### 2.6 活动中台类

| Tool | 调用参数 | 用途 | 实测返回 |
|---|---|---|---|
| `campaign-calendar` | 可选 `specifiedDate` | 当月营销活动日历 | **文本**：往期 / 今日 / 未来，含活动标题、说明、配图 |

### 2.7 未执行的写操作

以下工具具备真实业务后果，**开发过程中一律未调用**：`create-order`、`cancel-order`、`auto-bind-coupons`、`mall-create-order`、`draw-lottery`、`party-order-create`、`delivery-create-address`。

设计原则：**任何写操作都必须经用户显式确认后才执行，绝不静默扣费或领券。**

---

## 3. 调用流程

### 3.1 探测链路（零副作用，用于连通性自检）

```
now-time-info                    ← 无参数、无副作用，验证 Token 与连通性
  → query-nearby-stores(city, keyword)   ← 取得 storeCode
    → query-meals(storeCode)             ← 取得商品 code 与价格
      → query-meal-detail(code)          ← 取得套餐结构与特调项
        → calculate-price(items)         ← 试算价格（不产生订单）
```

### 3.2 到店点餐链路

```
query-nearby-stores(beType=1)
  → query-meals(storeCode, orderType=1, beType=1)
    → query-meal-detail(storeCode, code)          ← 如需换品 / 特调
      → query-store-coupons(storeCode, orderType, beType)
        → calculate-price(storeCode, items[])
          → create-order(...)                     ⚠️ 需用户显式确认
```

### 3.3 会员资产链路

```
query-my-account                 ← 积分余额与过期敞口
  + query-my-coupons             ← 卡包全部券
  + query-store-coupons          ← 指定门店可用券
  + mall-points-products         ← 积分可兑换商品
    → 交叉计算：积分现值、最优兑换出口、即将过期风险
```

---

## 4. 业务价值

### 4.1 已验证的能力

1. **全链路可达**：从"找店 → 看菜单 → 选品 → 算价 → 用券"的完整到店点餐闭环，所有接口均已实测跑通。
2. **零副作用试算**：`calculate-price` 允许在不产生订单的前提下反复试算任意商品组合的价格，为"组合优化"类能力提供了安全基础。
3. **真实数据源**：所有价格、库存、优惠、活动信息均来自麦当劳官方接口实时返回，**不使用离线快照**。
4. **营养数据可得**：`list-nutrition-foods` 提供 160 项官方营养数据，覆盖能量、蛋白质、脂肪、碳水化合物、钠、钙六个维度。

### 4.2 已识别的工程价值点

在实测中发现了若干**未被公开讨论的数据工程问题**，这些构成了本项目的技术壁垒：

| 问题 | 说明 | 处理难度 |
|---|---|---|
| **返回格式不统一** | 一半接口返回纯 JSON，一半返回 Markdown 文本，还有一部分是"模板文本 + 尾部 JSON"无分隔符 | 高——需为每类接口单独写解析适配层 |
| **数值类型混乱** | 菜单价格是**元（字符串）**、算价结果是**分（整数）**、订单金额是**元（字符串）**，三种口径并存 | 中——需统一转换 |
| **特调 key 反直觉** | 含 `unselectedKey` 的特调组必须**全部传参**，"不要某配料"要传 `unselectedKey` 而非不传 | 高——写错则算价/下单失败 |
| **门店经纬度为 0** | `query-nearby-stores` 的 `longitude`/`latitude` 实测恒为 `0.0` | 中——需自行地理编码或用 `distance` 替代 |
| **数据重复与过期未下架** | 营养表与券列表存在重复项；`mall-points-products` 中 `downTime` 已过的商品仍标记 `status=2`（上架） | 中——需按时间二次过滤 + 去重 |

### 4.3 业务价值主张

**对用户**：把散落在麦当劳 App 多个页面、需要手动比对的决策过程（菜单价格、可用券、积分余额、套餐组成、营养数据），压缩为一次自然语言对话，并给出**有数据出处**的结论。

**对生态**：为麦当劳 MCP 的数据形态问题提供一套可复用的**适配与清洗层**，降低后续开发者的接入成本。

---

## 5. 实测边界与已知限制

- **团餐 / 外送链路未完整验证**：`query-meal-assistance`（企业团餐助餐服务）需要先有配送地址，当前账号无地址，链路未走通。
- **无登录态下的券查询**：`query-store-coupons` 在无持券账号的情况下返回空数组，无法验证有券场景的完整返回。
- **未验证下单与支付**：所有写操作均未执行，`create-order` 之后的行为未经实测。
- **数据时效性**：菜单、价格、活动均随门店与时间变化，本文档记录的字段**结构**稳定，但具体数值仅代表实测时刻。

---

*本项目为麦当劳程序员节创意开发大赛参赛作品，由参赛者独立开发，非麦当劳官方产品。*
