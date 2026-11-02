# 真实测试、暖会话模型意图修复

费用授权已更新：用户允许本Key现有余额用于测试、不足再申请，余额约20美元。不是API读取余额或官方账单；不再等待单次credits数值。Key无回显stdin进入进程内存；产品测试仅临时加密BYOK库，结束删除。

| 验证层 | 结果与边界 |
|---|---|
| 当前Key目录 | GET200、82模型；后续产品目录含AUTO显示项83，不代表新增上游模型 |
| 文本provider预检 | qwen3.8-flash 200、预期回答；usage68输入/34输出/102总，请求max_tokens32不是输出计费硬上限。response model不是实际底层身份验证 |
| 真实文生图 | Seedream一次POST，n1/2048x2048/sequence disabled，约19.8秒成功；匿名固定IP/TLS下载与writer实际落盘JPEG153587字节、2048×2048、SHA2b8e94fd3e7afc80de0d351867b8643fdb9000ab0db274a7f071c1a6d43b8b4e；目视蓝杯符合提示。该Run为probe合成身份，不冒充产品Agent |
| 原生产品A→B失败 | 两轮独立诊断均A完成/B失败；不覆盖证据。离线启用model-intent后复现：B意图错误地提交A，B未发送 |
| 修复 | Cordis waterfall顺序：把原生installModelSelection放到预算/意图listener之后注册，使await next()观察最终model/provider。既有预算/重试边界不放宽，未修改或升级DSH |
| 修后产品真实验收 | 真server→锁定DSH原生CLI/pi-ai→PT：qwen3.5-flash→seed-2-0-lite-260228同对话均completed，历史两条；每轮1model/0tool/0retry/128output；upstreamModelId仍null。临时加密凭据删除，server日志无Key |
| 离线防回归 | 原生CLI＋原生pi-ai＋本地SSE替身验证两轮intent=model=实际POST，均128；联合身份、四媒体SDK/HTTP三项通过 |

证据：F1-live-session-20261029.json、F1-live-agent-20261029.json、F1-live-agent-20261029-review-r2.json、F1-live-agent-20261029-fixed-r3.json；未保存Key或签名结果URL。初版probe曾用整个SSE包含marker判定回答，可能命中用户提示；后续改按owned历史assistant及Run completed联合判定，初版结果不外推通过。

r8冻结SHA143f373fae2dacdc0fa5a9d7d5ee5e0796f202b3f28d2ae7aa33de537c4d0543，379成员/178源码，build/audit/活动门禁通过。完整回归进程中断、无最终汇总，不能报全绿；截断日志有6历史源绑定及心跳项失败，独立心跳复跑2/2通过，仍保留原失败记录。后续宿主审核view源码增量已使r8不再绑定当前源码，必须新修订；不覆盖r8。

宿主审核接线：PT_MEDIA_REVIEW_FILE默认未设置；仅受控media resolver加载文件，不改普通聊天目录缓存。文件≤64KiB、32reviews、每model≤4tasks、最多24h有效、准确scope/revision、固定schema/owner/mode/regular/no-symlink/no-hardlink校验；每次重新核对，不持久抬高基础cache权限、不制造运行验证/AUTO。独立7项及既有资格/授权/HTTP专项通过；真实产品媒体链待验证。

2026-10-29 真实产品媒体链补证：首次产品文生图 `F1-live-agent-20261029-media-r6.json` 已明确授权并单次成功生成，外部操作 succeeded、托管JPEG121400字节GET200，但原生DSH拒绝工具返回的 `managed` 字段（output schema `additionalProperties:false`），Run失败、历史无媒体；模型又试图调用工具但1次调用预算阻断，未第二次POST。修复 `persistent-runner.mjs` 的媒体工具输出 schema，精确声明受信宿主 `managed.rel/mime/size/sha256` 并维持 `additionalProperties:false`。锁定版原生DSH SDK RPC与同server四媒体HTTP离线回归2/2通过，`git diff --check`通过。随后新的显式单次授权真实产品试验 `F1-live-agent-20261029-media-r7.json`：Run completed，外部操作 succeeded，1工具/2模型/0重试/512输出上限，托管JPEG150097字节SHA d934c68191d0f15edf135d18811a72cdd3c74a314503c426f47f79bcf4e49a2c，owned GET200字节/hash匹配，匿名401，历史assistant引用同一本地媒体URL；原生工具结果成功。无传输mock；测试后临时加密BYOK库删除、交互Key进程退出、日志未含Key。该证据只覆盖真实文生图，不外推图生图/视频、目标机或账单金额。

2026-10-29 真实图生图追加 `F1-live-agent-20261029-i2i-r1.json`：固定仓库JPEG119992字节、SHA3730be1b01a4450f902ee6ccbbd33006f3dcb5235189c349bb4e0a5d79daa550经产品`/api/upload`进入同一Run，`media_input_bound`事件匹配源SHA；Seedream 5.0当次手动审核资格和显式授权后，真实原生Agent调用1次`media_route(image2image)`，外部操作succeeded，Run completed，2模型/1工具/0重试，托管JPEG120897字节SHA9c4ec94c81116ae27043fb37c6f7fba1a3261137aeaa9b97029ef20a8bebfb0f，owned GET200字节/hash匹配、匿名401、历史引用同一本地URL。无传输mock；临时加密BYOK库已删除，交互Key进程退出，日志未含Key。模型文字称颜色已改，但生成图未保存为独立可视审查件，故不把语义视觉效果列为已目视验收。该证据不覆盖视频、F3账单或目标环境。
