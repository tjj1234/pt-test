# Slice 2 验收报告

| 项 | 内容 |
|---|---|
| 基线 | `origin/main` @ `96b7b28`（其上为 `fbe874a` Slice 2 代码、`9325d4c` 基线记录） |
| 日期 | 2026-09-21 |
| 运行时代码 | **未修改**（`git diff HEAD -- shell analytics/backend conv tests/regression` 为空） |
| 真实 PT key | **没有**。环境变量 `PT_TEST_API_KEY` 未设置，仓库内测试 key 已按此前要求删除 |

## 1. 已有测试（mock，无 HTTP）

| 套件 | 结果 |
|---|---|
| `tests/regression/runtime-contract-test.mjs` | 26/26 |
| `tests/regression/tenant-mock-smoke.mjs` | 14/14 |

## 2. Live HTTP（独立进程，不占用 8098）

用 `PT_MOCK_DSH=1`、`PT_KEY_LIVE_VERIFY=0`、临时库 `/tmp/pt-slice2-live-db`，在 `127.0.0.1:18198` 起了一次 `shell/server.cjs`。验证完已停掉。

| 步骤 | 结果 |
|---|---|
| `GET /healthz` | 200，`ok: true` |
| `POST /api/auth/register` | 200 |
| `POST /api/auth/login` | 200，`pt_session` cookie |
| `POST /api/auth/key` | 200，`verified: "format"`（格式校验，不是 PowerTokens 探活） |
| `POST /api/conversations` | 200 |
| `POST /api/chat` | 200，`text/event-stream`，delta 与回复均为 mock 文案「这是一条回复」 |

这证明：进程能起来、登录链路通、SSE 帧顺序与 Runtime Contract 的 mock 路径一致。

## 3. 真实 DSH 实机

**未做。** `dsh-adapter.cjs` 仍是从 `tenant.cjs` 抽出的真实适配器，本次没有真实 PT key，也没有对 `api.powertokens.ai` 发对话。不能把 mock SSE 写成真实模型已验证。

要补这一步：提供一把新的 PT key（不要把已删除的测试 key 写回仓库），设 `PT_MOCK_DSH` 为空、`PT_KEY_LIVE_VERIFY=1`，再跑一轮登录 → 存 key → SSE。

## 结论

Slice 2 代码与 mock 测试、mock live HTTP 通过。真实 DSH 对话仍是外部缺口，不靠改运行时代码解决。
