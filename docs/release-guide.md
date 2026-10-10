# 发布与安装指南

版本 **2.3.0** ｜ 麦当劳程序员节创意开发大赛参赛作品（参赛者独立开发，非麦当劳官方产品）

从 [GitHub Release 2.3.0](https://github.com/SteveLaiTVT/mcd-1024-skill/releases/tag/v2.3.0) 下载，或 [在线体验历史样本](https://stevelaitvt.github.io/mcd-1024-skill/)。扩展通过开发者模式加载已解压文件夹，尚未发布到 Chrome / Edge 商店；报名和审核状态以官方 Issue 为准。

---

## 一、下载发布件

发布件由 `scripts/package_release.py` 从 `npm run build` 的产物打包，落在 `output/releases/v2.3.0/`（`output/` 已被 `.gitignore` 忽略，因此这些文件不进版本库，而是作为 GitHub Release 的附件上传）。

| 文件 | 内容 | 适用 |
|---|---|---|
| `mcd-wheel-extension-2.3.0.zip` | 25 个顶层文件 + `data/` 目录（4 份公开样本），共 29 个文件 | Chrome / Edge 加载已解压扩展 |
| `mcd-wheel-static-2.3.0.zip` | 24 个文件，无 `manifest.json` / `launcher.js` | 任意静态服务器托管，或本机 `npm run preview` |
| `SHA256SUMS.txt` | 上面两个 ZIP 的 SHA256，`sha256sum` 兼容格式 | 校验下载完整性 |

ZIP 内只有构建产物，且**只有一个顶层文件夹**，解压后可直接用于"加载已解压的扩展程序"。两个 ZIP 都不包含源码、脚本、数据集刷新结果或任何私有文件。

### 校验下载

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows PowerShell（逐条比对）
Get-FileHash .\mcd-wheel-extension-2.3.0.zip -Algorithm SHA256
```

本机 2026-10-11 打包结果（同一份构建产物重复打包哈希不变，已实测字节级可复现）：

```text
a684e455883c164e8d238f718b36d84ddda0946db97799c5c2c8a2783064c936  mcd-wheel-extension-2.3.0.zip
bf44ed931268bc663d840eb94931745f89e177ad8e4f6e9976802f757d5a0fa6  mcd-wheel-static-2.3.0.zip
```

> 以随包分发的 `SHA256SUMS.txt` 为准。协作方改动 `web/` 或 `data/` 后重新构建，哈希会随之变化。

### 解压

```bash
ditto -x -k mcd-wheel-extension-2.3.0.zip .      # macOS
unzip -q mcd-wheel-extension-2.3.0.zip           # macOS / Linux
Expand-Archive mcd-wheel-extension-2.3.0.zip -DestinationPath .   # Windows PowerShell
```

也可用系统“解压 / 全部解压缩”。macOS 已验证 `ditto`、`unzip` 与 Python `zipfile` 正确还原中文文件名；`unzip -Z1` 的列表显示可能受 locale 影响。Windows 解压命令供参考，尚未现场验证。

---

## 二、安装扩展（Chrome / Edge）

1. 解压 `mcd-wheel-extension-2.3.0.zip`，得到文件夹 `mcd-wheel-extension/`（`manifest.json` 就在这一层）。
2. 打开扩展管理页：Chrome `chrome://extensions`，Edge `edge://extensions`。
3. 打开右上角"开发者模式"。
4. 点击"加载已解压的扩展程序"，选中 `mcd-wheel-extension` 文件夹本身。
5. 点击工具栏上的扩展图标"麦麦饱饱盘"，会打开应用标签页。

扩展申请 `storage` 与四个明确域名权限（`mcp.mcd.cn`、`api.deepseek.com`、`api.open-meteo.com`、`geocoding-api.open-meteo.com`），不注入其他网页、不上传开发者服务器。

---

## 三、更新扩展

1. 下载新版 ZIP，解压后把文件覆盖到原来已加载的 `mcd-wheel-extension` 目录，保持原安装路径。
2. 在扩展管理页点击原扩展卡片上的“重新加载”，关闭已打开的应用标签页。
3. 再次点击扩展图标打开应用页；用户已选择保存的本机凭证继续沿用。

使用新的目录再次加载会创建另一份扩展，本机凭证按扩展身份隔离。更新时保留原目录和原扩展卡片。

版本可在包内 `build-info.json` 或扩展详情页确认，与本仓库 `package.json` 的 `version` 对照。

---

## 四、静态体验与真实连接的区别

| 项目 | 扩展（`mcd-wheel-extension`） | 静态页（`mcd-wheel-static`） |
|---|---|---|
| 连接麦当劳 MCP | 可以。用户填自己的 Token 后直连 `mcp.mcd.cn` | **不可以**，页面禁用 Token 输入 |
| Token 输入 | 用户自行填写；可选本机长期保存（默认关闭） | 账号界面中的真实凭证输入禁用 |
| 领券写操作 | 有明确确认窗口，用户点击才发送 | 禁用 |
| 价格 / 券 / 活动 | 官方实时核价 | 标注采样时间的历史样本（2026-10-10 深圳样本门店） |
| 雷达热力图 | 用户主动读取自己的历史订单 | 明确标注为**虚构示例**，不能导入主食 |
| 托管方式 | 本机加载，无业务后端 | 任意静态托管（如 GitHub Pages） |

**为什么静态页不能直连**：官方 `mcp.mcd.cn` 对普通网页来源的 CORS 预检返回 403，浏览器网页无法携带认证头跨域访问；扩展应用页通过 `host_permissions` 才能发起该请求。这不是可以靠代理或关闭浏览器安全策略绕过的限制。

**静态页能做什么**：完整走一遍选餐流程（人数 / 食量 / 预算 → 比较历史样本报价 → 转盘揭晓），用于无需 Token 的体验与评审复现。它**不产生真实订单、价格、券状态**。

---

## 五、GitHub Release 与活动投稿

### 5.1 发布 Release（由仓库维护者执行）

```bash
npm test && python3 -m unittest discover -s tests
python3 scripts/verify_dataset.py
npm run build
python3 scripts/package_release.py          # 生成 output/releases/v2.3.0/
gh release create v2.3.0 \
  output/releases/v2.3.0/mcd-wheel-extension-2.3.0.zip \
  output/releases/v2.3.0/mcd-wheel-static-2.3.0.zip \
  output/releases/v2.3.0/SHA256SUMS.txt \
  --title "麦麦饱饱盘 2.3.0" --notes-file docs/release-notes-v2.3.0.md
```

`python3 scripts/package_release.py` 在打包前会拒绝任何不一致的产物。校验分四层：

1. **版本一致**：`package.json`、`web/manifest.json`、两个 `build-info.json` 必须同为 2.3.0；
2. **文件集合精确**：与 `scripts/build_frontend.mjs` 声明的清单完全相等，多余或缺失都失败；
3. **逐字节回源**：每个前端资源、公开 data JSON、`launcher.js`、`manifest.json`、两份打包说明与 `build-info.json` 都与当前源码逐字节一致——版本号同为 2.3.0 但代码已改、旧构建混入 Release 会被直接拦住；
4. **私有文件与凭证**：黑名单过滤，并按匹配片段判定凭证占位符（整行出现 `example` 不豁免同行的真实 key）。

`python3 scripts/package_release.py --check` 可在不写文件的前提下执行上述校验，并复验已发布 ZIP 的哈希。复验 `SHA256SUMS.txt` 时只接受两份预期 ZIP 的**纯文件名**（不得含路径分隔、`..` 或绝对路径）与合法的 64 位小写摘要，因此清单里的越界路径不会被读取，也不会被当成发布件。

### 5.2 GitHub Pages

`.github/workflows/github-pages.yml` 在推送到 `main` 或手动触发（`workflow_dispatch`）时：

1. `npm test` → `python3 -m unittest discover -s tests` → `python3 scripts/verify_dataset.py`；
2. `npm run build`；
3. `python3 scripts/package_release.py --check`（版本一致、文件集合精确、逐字节回源、无私有文件、无旧版本）；
4. 上传并部署 `output/mcd-wheel-static`。

工作流使用官方 `actions/checkout`、`actions/setup-node`、`actions/upload-pages-artifact`、`actions/deploy-pages`，全部固定到官方发布的完整 commit SHA；默认权限只有 `contents: read`，`pages: write` 与 `id-token: write` 仅授予部署作业；**不读取任何 secrets**。Pages 部署分组并发且不取消进行中的发布。

静态页的部署目标是 `output/mcd-wheel-static`，只包含历史套餐样本与明确标注为虚构的热力图示例。真实麦当劳 Token 与 DeepSeek key 输入均禁用。

### 5.3 活动投稿必需文件

按《麦当劳程序员节创意开发大赛活动规则》"开发与发布项目"，参赛仓库须以标准命名包含下列文件。这些文件属于**仓库**，不放进 ZIP 发布件：

| 文件 | 作用 | 本仓库 |
|---|---|---|
| `README.md` | 项目介绍、安装方法、使用示例、目标用户 | 已有 |
| `CONTEST_DECLARATION.md` | 参赛声明：原创性、合规性、敏感信息 | 已有（与官方原文逐字节一致） |
| `MCP_INTEGRATION.md` | 实际使用的麦当劳 MCP Server / Tool、调用流程、业务价值 | 已有 |
| `mcp-config.example.json` | 脱敏配置示例，仅环境变量占位符 | 已有 |
| `workbuddy.md` | 参与 WorkBuddy 专项奖励时提交的对话上下文 | 已有 |

投稿通过活动页面的指定 Issue 模板提交，需含项目名称、项目地址、项目简介。仓库须保持**公开可访问**，且创建时间在 2025-12-25 至 2026-10-25 之间。

---

## 六、数据与隐私

实时核价在用户安装扩展并填入自有凭证后发生。发布件、工作流与文档仅包含公开代码和脱敏样本；`mcp-config.example.json` 保留 `${MCD_TOKEN}` 占位符。订单在本机应用页处理，不上传开发者服务器或写入公开数据集。报名与奖励结果以活动官方为准。
