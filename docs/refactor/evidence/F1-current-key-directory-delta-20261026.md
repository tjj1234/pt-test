# F1 同 Key 模型目录复核（2026-10-26 11:31 日本时间）

用户再次提供并授权使用测试 Key。本机环境变量未配置 Key；通过关闭终端回显的标准输入传给一次性只读探针，未写入仓库、脚本、命令参数或证据。沙箱内 DNS 返回 `ENOTFOUND`，经获准的网络执行后两次 `GET https://api.powertokens.ai/v1/models` 均为 HTTP 200；响应完成分别约 1468 ms、1133 ms。均返回 82 个模型 ID，规范化 ID 与端点列表的 SHA-256 为 `20f3e2265367e509dd34f27f855855a100ed4bcbd4ac5f2fef48690efabcf2dc`。该摘要只覆盖按响应顺序排列的 `{id,endpoints}` 数组，不代表原始响应、权限或任务能力。

与 [10 月 25 日脱敏目录](F1-current-key-directory-matrix-20261025.json)相比，模型 ID 无新增或删除；`mimo-v2.6-flash` 与 `mimo-v2.6-pro` 的端点提示由空数组变为 `["openai"]`，其余 ID 的端点列表未变化。泛化 `openai` 端点不能单独推出 `textChat` 或任何媒体任务权限。目录仍缺四类媒体的任务/输入输出模态、适配器和当前 scope 运行验证；本次没有生成 POST、余额/账单读取、Agent 入口或目标机验收。旧 T2V 未知提交继续保持人工核对，不自动重提。

公开的 [Seedream 5.0 官方模型页](https://powertokens.ai/models/seedream-5-0-260128)写明文生图/图生图和 24 小时 CDN 链接，[Wan 2.7 T2V 官方模型页](https://www.powertokens.ai/models/wan2.7-t2v)写明文生视频与 `/v1/videos`；[Wan 2.7 I2V 官方模型页](https://www.powertokens.ai/models/wan2.7-i2v)标示图生视频。网页只提供任务说明与接口线索，不证明该 Key 当前有调用权限，也不消除之前 I2V 403、T2V 未知提交或短期 URL 的历史恢复缺口。
