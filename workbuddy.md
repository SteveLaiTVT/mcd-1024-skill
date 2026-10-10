# WorkBuddy 开发对话上下文

本项目真实使用腾讯 WorkBuddy。本文是本机 WorkBuddy 应用实际对话的脱敏摘录及交付说明；原始对话保留在参赛者的 WorkBuddy 任务“整理开发者创新挑战赛仓库”。2026-10-11 已在实际应用中复核原任务，并继续完成发布配套。专项奖励资格以活动方核验为准。

## 开发来源与贡献

| 阶段 | 工具 | 实际贡献 |
|---|---|---|
| 2026-10-10 调研与初始化 | WorkBuddy，Deepseek-V4.1-Flash | 官方活动规则、参赛项目调研、MCP 接入研究、公开仓库与必交材料初始化、文本表格解析器 |
| 2026-10-10 至 11 产品迭代 | Codex、Python / JavaScript、桌面 Chrome | 套餐数据集、优惠核价、圆盘、用餐雷达、本机凭证保存、DeepSeek 饭搭子与反馈记忆、真实浏览器验证 |
| 2026-10-11 发布配套 | WorkBuddy 5.7.7，Deepseek-V4.1-Flash | Python ZIP 打包与校验脚本、GitHub Pages 工作流、扩展安装与发布指南，以及交付复核后的脚本修正 |

GitHub 提交、Release 上传及活动 Issue 由参赛者授权的协作工具执行。WorkBuddy 的实际贡献对应下述三个发布文件，产品核心迭代的来源按上表记录。

## 2026-10-10 原任务摘录

**用户，15:26：**

> 帮我整理一下这个，https://github.com/M-China/mcd-developer-innovation-challenge 然后我们看看后面怎么玩

**WorkBuddy，15:28：**

> 整理完了。材料落在 mcd-1024/：官方仓库完整克隆在 official-repo/，速览文档、榜单 CSV 已生成。

**用户，15:51：**

> 开始，使用gh 命令行创建 issues，然后准备报名，并未在 github 上创建仓库还有 README.md 熟悉麦当劳的mcp 然后初始化项目先，后面我在想玩法

**WorkBuddy，15:55，节选：**

> 仓库在 https://github.com/SteveLaiTVT/mcd-1024-skill
>
> 另外写了个真能跑的东西：src/mcd_text_parser.py
>
> 报名材料准备好了，但没提交。

原对话中还包含接口调研与工程问题摘要；当前工具清单、字段和验证口径以 [MCP_INTEGRATION.md](MCP_INTEGRATION.md)、[实测笔记](docs/mcp-field-notes.md)与 [验证记录](docs/validation.md)为准。

## 2026-10-11 发布任务上下文

发送到 WorkBuddy 的任务节选：

> 用户已确认 2.3.0，并要求更新 GitHub、按活动报名、使用真实 WorkBuddy。
>
> 请真实完成 GitHub 发布配套：你只允许修改 3 个文件：scripts/package_release.py、.github/workflows/github-pages.yml、docs/release-guide.md。你不是唯一协作者，其余模块和 README 正由另一位协作者处理，请勿覆盖、回滚或修改其他文件，请勿 git commit/push、发 Issue 或发布 Release。
>
> 编写 Python 标准库打包脚本，从当前 build 的 extension/static 目录生成 2.3.0 的两份 ZIP 与 SHA256SUMS.txt。ZIP 仅含构建产物，验证 package/manifest/build-info 版本一致。
>
> GitHub Pages 工作流发布 output/mcd-wheel-static，仅历史套餐样本与明确标为虚构的热力图。使用 GitHub 官方 actions，通过公开 API 核对版本并固定完整 SHA。
>
> docs/release-guide.md 写 ZIP 下载、Chrome/Edge 安装、更新扩展、静态体验与真实连接的区别、GitHub Release 和活动投稿必需文件。

WorkBuddy 的实际执行进度摘录：

> 仓库已经被另一位协作者大幅推进了。我只动我负责的 3 个文件。
>
> 基线全绿（JS 69、Python 23、数据集校验通过）。
>
> 打包通过，且与系统 shasum -c 一致。

交付复核后继续发送的修正要求节选：

> verify 除版本和文件集合外，必须把每个前端资源、公开 data JSON、launcher.js、manifest.json、两份打包说明逐字节与当前源码比较，避免同为 2.3.0 但代码已修改而旧 build 混入 Release。
>
> 凭证扫描不能因为一整行出现 example/占位符就跳过，按每个匹配片段判断占位符，并拦截真实 key；--check 的 SHA256SUMS 仅允许两份预期 ZIP 文件名和有效 SHA256，不读取任意相对路径。

**WorkBuddy，01:59，实际完成回复节选：**

> 两处缺陷都确认存在，已修好并做了反向验证。
>
> 扩展 29 个、静态 24 个文件全部字节一致。
>
> 反向验证：19/19 通过（临时目录整仓副本）。

最终安装指南由协作工具继续复核，补全原目录覆盖更新、包内版本查看及实际平台验证口径。

## 可检查的产出

- [scripts/package_release.py](scripts/package_release.py)：构建版本、文件集合与来源核对；单一顶层文件夹 ZIP；凭证特征检查；确定性打包与 SHA256 清单。
- [.github/workflows/github-pages.yml](.github/workflows/github-pages.yml)：测试、数据校验、构建、产物复核与静态页部署；官方 action 固定完整提交 SHA，仅部署作业获得 Pages / OIDC 权限。
- [docs/release-guide.md](docs/release-guide.md)：安装、更新、静态样本与真实连接、GitHub 发布和参赛文件说明。

发布件可用 `python3 scripts/package_release.py --check` 与下载附件中的 `SHA256SUMS.txt` 复验。实际发布、CI 与报名结果分别以 GitHub Release、Actions 和官方报名 Issue 为准。

上下文与提交文件不包含真实 Token、DeepSeek key、私人手机号、地址或订单。所有公开数据来自脱敏餐品快照；真实账号验证记录只保留必要的行为结果。
