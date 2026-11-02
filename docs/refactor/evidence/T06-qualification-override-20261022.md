# T06 qualification override review and candidate-17

PT技术团队确认：supported_endpoint_types 的五个精确值可信映射到聊天、图片生成和视频生成；该字段无需逐模型人工核实。工作区复核发现 textChatQualificationMaps() 曾为每个静态目录 ID 生成 textChat=true、文本 I/O 和 chat-completions endpoint override。能力归一化的人工 override 优先于 PT 能力事实，因此图片模型或明确 textChat=false 可能错误取得手动聊天资格。

修复移除该合成 override，仅保留用户已确认的 textChat localPolicy、OpenAI-compatible adapter 登记及资格默认项；任务能力仍由 PT 元数据和显式否定门禁决定。新增 independent review case 验证 image-generation 记录在通用资格默认项存在时仍不会取得 textChat 能力。candidate-17 中 server.cjs 与当前源码字节一致。

候选 UI 对一般场景保留 T03 的同 key/body 前置 ACK 丢失重放；?northstarNoChatRetry=1 在请求拒绝时禁止第二个 /api/chat POST，供本次额度严格为一次请求、零重试的受控 Run。回归覆盖该参数只发一次 HTTP 尝试，且默认重放行为仍通过 T03/UI resume tests。

证据：model-capabilities-review-test.mjs 6/6、chat-transport-retry-budget-test.mjs 1/1、ui-archive-readonly-test.mjs 25/25；candidate-17 完整默认回归 node scripts/run-regression.mjs 为 117 suites / 117 PASS（在允许 loopback 的执行环境中）。独立 package review 检查 archive SHA 480e97cd975f61d7691163f9466e7f79ac3b898d01d79b2eb0771a977ee1f964、unit SHA a5abf2112af069331c621232ea50033c0b30e5ef08ff50280bf0b15dd0fb8869；318 USTAR members、0 PAX/GNU extension、0 AppleDouble/禁用路径、19 migrations；包内 server/app 与当前源码 2/2 字节相同。完整部署清单在 docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-17.md。

边界：本地映射、回归和封包不证明线上 key 的 /v1/models 返回、目标 Linux、运行时资格或真实模型调用。维护者部署及获准的一次真实 Run 尚未完成；T06/T07/T03 与 T00–T18、AC01–AC24 整体状态不因此通过。
