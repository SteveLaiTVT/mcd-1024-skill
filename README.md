# mcd-1024-skill

> 基于**麦当劳中国 MCP** 开发的 Agent Skill · 参加「麦当劳程序员创意开发大赛」参赛作品
> 非麦当劳官方产品

---

## 项目状态

**🚧 开发中（Scaffold）**

当前进度：

- [x] 连接麦当劳 MCP Server，完成 **24 个只读接口的实测**，产出 [`docs/mcp-field-notes.md`](docs/mcp-field-notes.md)
- [x] 摸清返回数据形态、识别 7 个关键工程坑（返回格式不统一、数值类型混乱、特调 key 规则、门店经纬度为 0 等）
- [ ] 核心功能开发（方向待定）
- [ ] 可传播产出物
- [ ] 在线 Demo

---

## 项目介绍

本项目是一个基于麦当劳官方 MCP（Model Context Protocol）能力构建的 **Agent Skill**，运行在支持 MCP 的智能体（如 WorkBuddy）中，通过自然语言对话调用麦当劳的真实业务接口。

**已完成的 MCP 能力探查**覆盖以下场景：

| 场景 | 已实测接口 |
|---|---|
| 门店与时段 | `query-nearby-stores`、`now-time-info` |
| 菜单与商品 | `query-meals`、`query-meal-detail`、`list-nutrition-foods` |
| 价格 | `calculate-price` |
| 订单 | `order-list`、`mall-order-list` |
| 会员资产 | `query-my-account`、`query-my-coupons`、`query-store-coupons`、`available-coupons` |
| 积分商城与活动 | `mall-points-products`、`query-lottery-info`、`campaign-calendar` |
| 配送 | `delivery-query-addresses` |

详细的数据形态、字段说明与踩坑记录见 **[`docs/mcp-field-notes.md`](docs/mcp-field-notes.md)**。

---

## 目标用户

面向使用麦当劳中国 App / 小程序的日常消费者，以及希望通过 AI 智能体更高效完成点餐决策的人群。

*（具体人群画像将随功能方向确定后补充）*

---

## 安装方法

### 前置条件

1. 申请麦当劳中国 MCP Token：访问 <https://open.mcd.cn/mcp> → 手机号登录 → 控制台 → 激活 → 复制 Token
2. 一个支持 **Streamable HTTP** 协议的 MCP Client（推荐 WorkBuddy、Cherry Studio、Cursor、Trae）

### 配置 MCP Server

将以下内容填入 MCP Client 的 Server 配置，并把 `${MCD_MCP_TOKEN}` 替换为你的实际 Token：

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": {
        "Authorization": "Bearer ${MCD_MCP_TOKEN}"
      }
    }
  }
}
```

参考文件：[`mcp-config.example.json`](mcp-config.example.json)

### 通过对话安装本 Skill

在 WorkBuddy 中复制以下内容发送：

```text
请从 https://github.com/SteveLaiTVT/mcd-1024-skill 安装「mcd-1024-skill」：
先阅读 README.md 与 docs/mcp-field-notes.md，按说明配置麦当劳 MCP 连接器并自检连通性，
然后引导我使用。
```

---

## 使用示例

*（功能开发完成后补充）*

---

## 目录结构

```
mcd-1024-skill/
├── README.md                    项目介绍、安装方法、使用示例、目标用户
├── CONTEST_DECLARATION.md       参赛声明（官方原文，内容不可改动）
├── MCP_INTEGRATION.md           使用的 MCP Server / Tool、调用流程、业务价值
├── mcp-config.example.json      脱敏 MCP 配置示例（仅环境变量占位符）
├── workbuddy.md                 WorkBuddy 开发对话上下文
├── LICENSE                      MIT
├── docs/
│   └── mcp-field-notes.md       麦当劳 MCP 实测笔记（24 个接口 + 7 个工程坑）
└── src/                         源代码
```

---

## 安全说明

- 本仓库**不包含任何真实 Token、密钥或账号凭证**，配置文件仅使用环境变量占位符
- 所有涉及费用的写操作（下单、领券、抽奖、兑换）在设计上均需**用户显式确认**后才执行
- 麦当劳 MCP Token 限流 **600 次/分钟**，使用中需控制调用频率

---

## 参赛说明

本项目参加「麦当劳程序员节创意开发大赛」。

- 参赛声明：[`CONTEST_DECLARATION.md`](CONTEST_DECLARATION.md)
- MCP 接入说明：[`MCP_INTEGRATION.md`](MCP_INTEGRATION.md)
- 项目为参赛者独立开发，**非麦当劳官方产品**；项目输出仅供参考，不构成医疗、营养或其他专业建议；餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准。

## License

[MIT](LICENSE)
