# 饱饱盘数据集

官方读取与核价结果的脱敏快照，用于离线演示、模板维护和字段验证。真实推荐需要重新查菜单、券与报价。

## 文件

| 文件 | 当前规模 | 用途 |
|---|---:|---|
| `manifest.json` | 1 份 | 来源、版本、门店、默认值、时间、计数、SHA256 |
| `plan-recipes.json` | 50 个 | 人数、每人食量、标题、套餐份数、轮次替换 |
| `menu.json` | 117 项 | 分类、编码、名称、展示价；排除个人常点字段 |
| `packages.json` | 8 套 | 轮次、选项、已选数量、限制、特调 |
| `meal-plans.json` | 50 份 | 完整套餐与子项、数量、主食编码、整单报价 |
| `nutrition.json` | 160 行 | 原营养记录与重复名称报告，158 个不同名称 |
| `tool-catalog.json` | 35 个 | 工具描述及输入/输出定义 |
| `coupon-offers.json` | 4 类 | 可领取券的去重展示，无个人券编号 |
| `campaigns.json` | 18 条 | 指定日及最近前后活动日的脱敏日历；不是全部当月活动 |

默认 1 人、7 分、人均预算 30 元，覆盖 1–4 人与 5/7/9 三档。多人暂用同一食量档位，食量不保证实际饱腹程度。

`priceFen` 是整顿总价，单位分；`parts[].quantity` 已展开为整顿数量；`packages[].quantity` 是套餐份数。`mainCodes` 为模板显式登记的主餐编码，用于人数检查与不重样。菜单 `menuPriceYuan` 仅用于展示。

模板 `ingredients[].choices` 用轮次 ID 字符串指定替换商品编码。未替换的轮次保留详情中的已选数量，包括 `isDefault=0` 的已选项。增加新主餐时同步维护 `mainProductCodes`。

## 券与个人资产

`CAN_GET` 表示本次官方返回“可领取”；未知状态保留标签，`canClaim=null`。去重条数是展示种类，不是可领取张数；其他账号不保证同样可领取。

公共 50 份报价未显式传入个人券编号。个人持券与门店适用关系由实时脚本在内存中处理。公开文件不保存 Token、个人券 ID/券码、订单、地址或账户积分。

活动日历仅保存标题、日期、事件类型、公开时间限制与展示字段，排除券编号、文章正文和个人订阅。`priceDisplay` 不是核价金额；文章类型即使官方返回 `price=0` 也保存为 `null`，避免误读为免费。`status` / `timeStatus` 反映采样时点。价格判断只用实时 `calculate-price`。

## 更新

```bash
python3 scripts/refresh_dataset.py
python3 scripts/check_coupons.py --refresh-offers
python3 scripts/prepare_wheel.py --refresh-public
python3 scripts/verify_dataset.py
```

刷新使用环境变量 `MCD_TOKEN`，选择显式样本门店；全部构造与核价成功后才替换文件，清单最后更新。网络读取和核价最多尝试 3 次，业务失败不重试，不用展示价补缺失报价。

校验器核对哈希、模板、轮次数量、主餐数量和人数/食量覆盖。每份多人餐单都真实提交完整 `items[]` 核价，单人价格乘人数不能代替此步骤。

`prepare_wheel.py --save-report` 保存到忽略提交的 `data/local/prepared-wheel.json`，包含本次餐单价格、信息表和有效截止时间，不是公共 50 份报价的替代快照。本地页面每次计算均重新查询和核价。
