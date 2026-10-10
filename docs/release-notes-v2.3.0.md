# 麦麦饱饱盘 2.3.0

饭点先比较官方套餐价，再转盘揭晓或请 AI 饭搭子挑选。支持 1–4 人、食量、人均预算、近期主食避开、附近门店与营业时段，以及全年 / 近 12 周用餐热力图。

## 这次更新

- 麦当劳凭证和上次门店可选择仅在本机扩展长期保存，刷新恢复连接并重新确认门店营业情况。
- DeepSeek V4.1 Flash：推荐 Agent、优化 Agent、两轮协作；个性风格、用户口味 prompt、城市天气、月份与节假日。
- 主动喜欢 / 少推荐反馈可选择本机长期记忆，支持查看、忘掉与清空，旧偏好逐渐减弱。
- 模型只从已核价餐单中选择；预算、价格、餐品、券与报价有效期仍由代码和官方结果校验。
- WorkBuddy 实际完成发布工作流、ZIP 打包脚本与安装说明，开发记录见仓库 workbuddy.md。

## 下载与体验

- `mcd-wheel-extension-2.3.0.zip`：解压后在 Chrome / Edge 的扩展管理页“加载已解压的扩展程序”，选择 `mcd-wheel-extension` 文件夹。
- `mcd-wheel-static-2.3.0.zip`：历史样本静态体验，可用标准静态服务器打开。
- `SHA256SUMS.txt`：两份 ZIP 的校验值。
- [在线体验](https://stevelaitvt.github.io/mcd-1024-skill/)与 [完整安装说明](https://github.com/SteveLaiTVT/mcd-1024-skill/blob/main/docs/release-guide.md)。

实时功能使用用户自己的麦当劳 Token 与可选 DeepSeek key；两种 key 独立保存，长期保管默认关闭。刷新不会自动调用 AI。静态体验不接收真实凭证，价格来自 2026-10-10 历史快照，雷达示例明确标为虚构。

## 验证

69 项 JavaScript 测试、23 项 Python 测试、数据集哈希与模板校验通过。桌面 Chrome 实测凭证重载恢复、实时官方核价、真实天气和 DeepSeek 两轮推荐。真实领券折扣、手机端与关闭整个浏览器后重开仍待验证；详见仓库验证记录。

项目通过 GitHub 提供下载，尚未发布到 Chrome / Edge 扩展商店。参赛者独立开发，非麦当劳官方产品；不下单或付款，餐品、价格及供应以官方结果为准。
