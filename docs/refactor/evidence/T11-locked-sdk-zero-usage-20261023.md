# T11：锁定 DSH 流式用量的全零占位边界

锁定的 `@earendil-works/pi-ai@0.82.1` 在 OpenAI completions 流开始时先创建全零 `output.usage`；只有收到 `chunk.usage` 或 `choice.usage` 才替换它。流可在没有用量帧时以 `finish_reason` 正常结束；异常路径也把当前 `output` 推入 `error`。`parseChunkUsage()` 对缺失的 token 字段同样使用零回退。目标 `shell/dsh-settings.yaml` 使用 `openai-completions`，所以这不是无关适配器分支。源码位置：`shell/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:105–120, 318–326, 437–462, 1057–1079`。

锁定 DSH `dsh-llm-pi-ai` 在 `done` 和 `error` 都无条件把该对象映射成 usage chunk；`dsh-agent-loop` 在成功时把本 step 的 chunk 序号写入 `assistant/message.sourceEventSeqs`，错误重试时可能没有 message。源码位置：`shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1424–1445`、`shell/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:617–683`。因此仅凭现有四个 token 数字，**全零对象无法证明上游真实报告零用量**。

本地 collector 将四分量全零的 SDK usage 改为未知，包括成功 message 和失败 usage chunk；这会保守地放弃真实零的确认，但不会把缺失证据落成可信零费用。若未来要区分真实零，须在下层事件中携带“上游实际返回 usage 且字段完整”的证据位，不能从全零值推断。定向 SDK 形状回归新增成功/失败两例；子Agent报告 `node --test tests/regression/usage-dsh-sdk-shape-test.mjs` **14/14 PASS**，原有正数成功及失败重试仍通过。此为锁定源码与本地fixture证据，尚未用真实 PT 账单核对。
