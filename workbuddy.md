# WorkBuddy 开发对话上下文

> 本文件用于核验本项目是否符合「麦当劳程序员创意开发大赛」WorkBuddy 联动活动奖励条件。
> 记录本项目使用 WorkBuddy 完成的实际开发工作。

---

## 会话概要

| 项 | 值 |
|---|---|
| 开发工具 | WorkBuddy |
| 开发日期 | 2026-10-10 |
| 会话主题 | 麦当劳 MCP 能力实测 → 参赛项目初始化 |
| 产出 | 24 个 MCP 接口实测记录、7 个工程坑分析、项目骨架与参赛材料 |

---

## 实际使用 WorkBuddy 完成的工作

### 1. 赛事调研与竞品分析

- 通过 WorkBuddy 拉取并解析官方活动仓库的全部规则文档（活动规则、参赛声明、排行榜）
- 采集全部 **269 条报名 Issue**，解析出「项目名称 → 仓库地址」映射（官方榜单中 Owner 昵称是脱敏的，无法直接对应）
- 批量抓取 **229 个参赛仓库**的实时 GitHub 数据（Star、语言、体积、在线 Demo、topics）
- 产出赛道密度分析、Star 门槛分布、空白赛道识别

### 2. 麦当劳 MCP 能力实测

通过 WorkBuddy 的 MCP 连接器（`mcd-mcp`）直连 `https://mcp.mcd.cn`，完成 **24 个只读接口**的真实调用与返回结构记录，并识别出 7 个关键工程坑：

1. 返回格式不统一（JSON / Markdown 文本 / 模板文本 + 尾部 JSON 三种形态并存）
2. 数值类型混乱（元-字符串、分-整数、元-字符串三种货币口径）
3. `query-meal-detail` 特调 key 规则反直觉（含 `unselectedKey` 的组必须全部传参）
4. 门店经纬度实测恒为 `0.0`
5. 数据存在重复项，且积分商城过期商品仍标记为上架
6. 团餐 / 外送链路前置门槛高（需先有配送地址）
7. `calculate-price` 是唯一可零风险反复试算的接口

> 完整记录见 [`docs/mcp-field-notes.md`](docs/mcp-field-notes.md)

### 3. 项目初始化

- 建立项目骨架与参赛材料（README / CONTEST_DECLARATION / MCP_INTEGRATION / mcp-config.example.json / workbuddy.md）
- 校验 `CONTEST_DECLARATION.md` 与官方原文逐字节一致（SHA256 比对通过）
- 编写 MCP 调用链路与业务价值说明

---

## 对话记录摘录

**用户**：帮我整理一下这个（麦当劳程序员创意开发大赛官方仓库），然后我们看看后面怎么玩

**WorkBuddy**：克隆官方仓库 → 拉取 269 条报名 Issue → 批量抓取 229 个参赛仓库实时数据 → 产出赛事速览、参赛项目目录表、热门项目拆解、行动方案

**用户**：在 `~/source/activity/` 创建对应的仓库，创建活动目录表，参考热门项目怎么做

**WorkBuddy**：建立 `~/source/activity/mcd-1024/` 作战室 → 生成 231 行结构化目录表 CSV → 逐个抓取 Top15 项目的 README / MCP_INTEGRATION / SKILL.md / 文件树并拆解 → 提炼出"窄切口 × 确定性算法 × 可传播产出物 × 真实数据"的拿分公式

**用户**：开始，用 gh 创建 issues 准备报名，在 GitHub 创建仓库和 README.md，熟悉麦当劳的 MCP，初始化项目

**WorkBuddy**：实测 24 个 MCP 只读接口 → 识别 7 个工程坑 → 创建 GitHub 仓库与项目骨架 → 准备报名材料

---

## 声明

- 本项目使用 WorkBuddy 完成调研、MCP 接口实测、数据分析与项目初始化
- 未使用任何自动化脚本操纵 GitHub Star 或其他平台数据
- 所有 MCP 调用均为**只读接口**，未执行任何下单、领券、抽奖等写操作
- 本仓库不包含任何真实 Token、密钥或他人个人信息
