# F1 当前 Key 媒体资格链复核（2026-10-24）

**结论：当前持久 Run 的媒体 AUTO 入口尚无合格候选，四类均不能作为用户可用功能交付。** 这不是媒体业务适配器不存在：四种 `taskType` 已能组装图片/视频请求。缺的是以当前 Key 目录为起点、绑定同一 scope 与能力版本的本地策略、任务/模态审定、端点适配和运行验证；T2V 未知提交也禁止为了补验证而重投。

| 任务 | 当前目录证据 | 官方模型页与直接探针 | AUTO 尚缺的证据 |
|---|---|---|---|
| 文生图 `seedream-5-0-260128` | `image-generation` → `textToImage`、text→image | [PT Seedream 页](https://powertokens.ai/models/seedream-5-0-260128)声明 T2I；同 Key 直接 POST 成功并获可读图像 | 当前 scope 的 localPolicy、`openai-images-generations` 端点适配、绑定 scope/能力版本/适配版本的验证记录、持久 Run 结果/历史 |
| 图生图 `seedream-5-0-260128` | 目录没有 `imageToImage`、image→image 的独立字段 | 同一[模型页](https://powertokens.ai/models/seedream-5-0-260128)声明 I2I；同 Key 参考图直接 POST 成功 | 带来源/版本的人工任务与输入模态审定、适配/策略/绑定验证、持久 Run 结果/历史 |
| 文生视频 `wan2.7-t2v` | `openai-video` → `textToVideo`、text→video | [PT Wan T2V 页](https://powertokens.ai/zh-Hans/models/wan2.7-t2v)声明 T2V；此前 POST 传输失败且无 task ID | 端点适配/策略；未知上游结果与扣费不得当作失败或成功、不得自动重提；仍需可核对的运行验证 |
| 图生视频 `wan2.7-i2v` | 目录 `openai-video` 只给 `textToVideo` 提示，没有 I2V 专属事实 | [PT Wan I2V 页](https://powertokens.ai/zh-Hans/models/wan2.7-i2v)声明首帧必需；直接 POST 得 HTTP403，无结果 | 带来源/版本的人工任务/输入模态审定、适配/策略；403 原因和可调用性未证实，不能签运行验证 |

`routeMediaTask()` 的 AUTO 资格要求：当前模型在同 Key 可用目录、permission=true、localPolicy.enabled=true、该任务与输入/输出模态均有来源、适配器ID/版本/端点匹配、`endpointCompatible=true`，且 `verifications[task]` 的 model/task/scopeId/capabilityRevision/adapterId/adapterVersion/endpoint/时间一致。目录的 `image-generation` / `openai-video` 是 PT 任务提示，**不是**本地适配器端点 `openai-images-generations` / `openai-videos`；因此四类均需审定后配置本地端点，不可凭目录标签直接放行。图生图/图生视频的人工 override 还须写明 task=true 与输入模态；不能按模型名猜测或把通用 `openai` 端点判成聊天。

本轮修复了额外的 scope 不一致：`catalog-cache.resolveScopeId()` 将 baseURL 放进哈希，展示目录以 `DEFAULT_BASE_URL=https://api.powertokens.ai/v1` 计算 scope，而媒体 admission 原先省略 baseURL，产生另一份缓存/能力版本。`media-route-admission.cjs` 现显式传同一 baseURL；独立夹具验证同一 Key+用户得到相同 scope，且目录同步失败仍先拒绝。此修复只对齐资格查找，不创建任何策略或验证记录。

后续核查还发现媒体POST基址可由 `POWERTOKENS_BASE_URL` 覆盖，但目录仍固定官方 `api.powertokens.ai/v1`。媒体 admission 已在读目录和登记付费意图前比较两侧有效基址：默认及等价尾斜杠允许，不同源或不同路径给固定 `MEDIA_GATEWAY_MISMATCH`；专用子进程测试覆盖环境变量，未访问 PT。业务模块当前按字符串追加 `/v1/...`，若媒体基址带尾斜杠会构成双斜杠路径；入口把它视为同网关，实际POST路径归一化仍需由业务模块独立修正和验证。

**可实施的最小闭环**：为三项选定模型维护经审阅、版本化的 `override/policy/adaptation` 地图，显示来源；在真实同 Key、同能力版本、同适配器路径的受控调用完成并取得结果后记录 verification。每次持久 Run 使用提交同一 Key 强制刷新目录并检查以上条件，再做 Run 级预算与外部意图登记，最后 POST；产物需作为用户可见结果和历史持久化。当前同 Key 直接图片成功仅是适配探针，不是持久 Run 验收。`maxToolCalls=0` 会阻止媒体工具。PT 无本 Key 可登录账单，实际金额不可核对；任何未知提交不得自动补发。

证据范围：本地代码 `shell/models/capabilities.cjs`、`shell/models/media-task-router.cjs`、`shell/models/media-route-admission.cjs`、`shell/models/catalog-cache.cjs`、`shell/tasks/media-run-handler.cjs` 与当前 Key 的脱敏 82 项目录矩阵；官方页在 2026-10-24 复核。本文是资格审计，不是目标环境、真实四类 Run 或发布验收。
