# T00／T16 · 一期最小产品契约证据

日期：2026-10-16。分支：`feature/northstar-phase1-refactor-20261016`；HEAD：`a2adbee64c326653dbf5bfed3f918dd09f96589d`。实施者：架构子 Agent。状态：**纯契约代码与自测完成，尚未接入产品请求、存储、runner 或前端，未独立验收。** 本记录不是项目第二份进度表。

## 交付与语义

| 文件 | 交付 |
|---|---|
| `shell/contracts/phase1.cjs` | 契约版本 `1.0`；身份、Run、RunEvent、ModelAttempt、ToolCall、Attachment、Artifact、ModelRecord 的最小校验；归属、状态转换、事件顺序和幂等语义 |
| `tests/regression/phase1-contract-test.mjs` | 11 个正负向测试，覆盖越权、终态重开、revision 冲突、事件串线／乱序、未知计量、拒绝工具执行、产物路径、AUTO 能力与请求幂等 |

复用 `shell/runtime/contract.cjs` 的方法／事件常量，不实现新 Runtime，不修改既有契约、Adapter、DSH 包或产品共享接缝。校验失败抛 `CONTRACT_INVALID`，校验函数也可返回错误数组。新增可选字段允许保留；本模块不是完整 HTTP schema、防敏感信息序列化器或权限引擎。

可信身份由调用方从服务端 session 获得，再传入 `bindRun(identity,input)`；输入内冲突 userId／tenantId 拒绝，workspaceId 必须由服务端解析。`assertOwned` 同时检查 user 与 tenant。纯函数不能证明传入 identity 的来源，接线时不得把请求体直接充当可信身份；workspace、资源关联与跨对象外键仍由执行服务／存储层验证。

Run 转换返回新对象并增加 revision；期望 revision 不一致抛 `REVISION_CONFLICT`，无效转换抛 `INVALID_TRANSITION`。queued 可开始或直接结束取消／失败／中断；running 可进入外部等待、确认等待或取消；cancelling 仍可能收敛为 completed（取消先于完成确认，真实工作可能已成功），不能把“发出取消”冒充已取消。全部终态不可重开；重试应创建新 Run。`needs_reconciliation` 是独立 reconciliation 标记，不是允许自动重新提交的状态。

`assertEventAfter` 校验 run／conversation 关联、从 1 开始的连续 seq 与相邻 eventId 不重复；工具事件要求 callId，产物事件要求 artifactId。存储必须另外对 `(runId,seq)` 与 eventId 建唯一约束、事务分配序号，并为重连去重；该函数不记忆全部 eventId，也不提供并发锁或持久事件保证。

幂等 scope 为可信 tenant＋user＋operation＋client key 的 SHA-256，requestHash 来自排序对象键后的有限 JSON；数组顺序保留，undefined、非有限数、稀疏数组等不接受。无记录返回 `new`；同 scope／同请求返回 `replay`，调用方返回既有 runId；同 scope／不同请求抛 `IDEMPOTENCY_CONFLICT`（HTTP 409）；误传不同 scope 记录明确拒绝。必须由数据库唯一约束与事务原子认领解决两个并发 `new`，不能把本函数宣称为已经做到恰好一次。hash 不是凭据脱敏工具；指纹请求中不应包含 Key。

Attachment 支持页／sheet／幻灯片／段落／行／ZIP 内路径／时间来源定位；Artifact 只接收相对对象键，真实读取仍须防路径穿越、符号链接与越权。ModelRecord 的 AUTO 资格要求已发现、已适配、已验证、有能力来源、非空任务和端点；未知实际模型／请求 ID／用量来源保留 null，不伪造为前端选择值或 0。工具 denied 不允许 running／succeeded；真正授权及参数执行入口尚未接线。

## 实际验证

环境：macOS，Node `v24.14.0`。无网络调用、无数据库写入、无付费模型调用、未修改六个共享接缝文件。

| 命令 | 实际结果 |
|---|---|
| `node --test tests/regression/phase1-contract-test.mjs` | 11 tests，11 pass，0 fail |
| `node --test tests/regression/phase1-contract-test.mjs tests/regression/runtime-contract-test.mjs` | Node runner 12 子测试通过，0 fail；旧 Runtime 脚本内部 26 项通过／0 失败 |
| `node --check shell/contracts/phase1.cjs` | exit 0 |
| `git diff --check` | exit 0；新增未跟踪文件不受该命令完整检查，不以此代替测试 |

旧 Runtime 测试包含 mock 行为和真实 Adapter 方法形状，**不是**真实 DSH 多 Session、真实取消、模型切换或 PT 端到端证据。本交付没有 schema 迁移、数据库唯一索引、HTTP／SSE 路由、生产授权或 UI 接线，因此 T03／T04／T16 产品能力不能标记完成。

## 后续接线与独立验收

主集成人在实现任务服务前核定字段并冻结版本；存储原子执行 revision 比较、事件唯一约束与幂等认领。旧 `/api/chat` 与新 Run API 必须共用同一底层服务；兼容旧 Runtime 的 sessionKey 取消，由集成层明确映射 runId。按 T00 获取真实 DSH／PT 技术证据后补 capability 取值与 usage 来源，不把本契约的自由字符串等同上游支持证明。独立验收应额外尝试跨租户伪造、并发认领、重复事件、迟到终态与外部付费结果未知，不复述自测即判通过。
