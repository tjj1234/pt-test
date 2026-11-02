# WorkBuddy 逆向实现级设计文档（可复刻交付包）

> 本目录是 WorkBuddy 的**实现级设计文档**，粒度到"另一个 AI 拿到就能照着写代码复刻出一个同类 Agent"。
> 逆向来源：CLI 内核 `codebuddy.js`（22MB webpack bundle）、本机 `~/.workbuddy` / `~/.codebuddy` 运行时数据、内置插件 `tencent-docx` 全套源码。
> 所有枚举值、正则、阈值、文件格式、prompt 模板、算法均从产物还原，非猜测。

---

## 交付物清单

| 文件 | 内容 | 状态 |
|---|---|---|
| [01-agent-core.md](01-agent-core.md) | Agent 循环引擎 + 工具系统 + 会话格式 | ✅ |
| [02-permissions-sandbox.md](02-permissions-sandbox.md) | 权限分级 + 沙箱（风险隔离） | ✅ |
| [03-model-memory-skills.md](03-model-memory-skills.md) | 模型调度 + 记忆架构 + 技能系统 | ✅ |
| [04-docpipeline-automation.md](04-docpipeline-automation.md) | 文档管线 + 自动化调度（Cron） | ✅ |
| [replication-rules.json](replication-rules.json) | 机器可读规则清单（常量/枚举/格式/复刻顺序） | ✅ |
| README.md | 本索引 | ✅ |

---

## 复刻总览：三个横向系统贯穿四批

```
                      ┌────────────────────────────────────────────┐
                      │  ① Agent 循环引擎（Runner / RunState）        │
                      │     用户输入 → LLM 流式 → tool_calls → 工具  │
                      │     执行 → 结果 → 下一轮，直到无工具调用       │
                      └───────────────┬────────────────────────────┘
                                      │ 每次工具调用前
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
│ ② 权限分级         │      │ ③ 模型调度         │      │ ④ 记忆架构         │
│   PermissionMode  │      │   variant→model   │      │   CODEBUDDY.md   │
│   10 种模式        │      │   fallback 链     │      │   MEMORY.md      │
│   双层判定         │      │   configure 落盘  │      │   相关记忆/提取    │
└─────────┬─────────┘      └───────────────────┘      └───────────────────┘
          │
          ▼
┌───────────────────┐
│ ⑤ 沙箱             │
│   CommandUtils     │
│   classifySafety   │
│   auto-mode 分类器 │
│   SandboxOrchestrator│
└───────────────────┘

┌───────────────────┐        ┌───────────────────┐
│ ⑥ 文档管线         │        │ ⑦ 自动化调度       │
│   S1→S2→S3        │        │   Cron 解析/存储   │
│   tencent-docx    │        │   SchedulerService │
│   插件             │        │   /loop 命令      │
└───────────────────┘        └───────────────────┘
```

---

## 复刻顺序（按依赖，强烈建议照此推进）

1. **第一批 §1–§3**：先做 Agent 循环引擎 + RunState + item 协议 + SessionStore（JSONL 追加写 + `lastMessageId` 回退指针）。这是地基，其余全部围绕它。
2. **第一批 §2 + 第二批**：工具系统 + 权限分级（10 种模式、shouldAutoApprove、审批记忆）+ 沙箱分类器（CommandUtils 正则表、classifySafety、敏感路径规则）。纯函数优先，可单测。
3. **第三批 第一部分**：模型调度（`MODEL_VARIANT_TYPES` + `computeRelatedModel` fallback 链 + `configureModelConfig`）。
4. **第三批 第二、三部分**：记忆架构（规则文件 + Agent 持久记忆 + 相关记忆 + 提取子 agent）+ 技能系统（SKILL.md 发现/解析 + `skill_manage`）。
5. **第四批 第二部分**：Cron 自动化（解析器 → StateManager → Storage → createCronScheduler → SchedulerService → 工具 + `/loop`）。
6. **第四批 第一部分**：文档管线（tencent-docx 三段流水线 + 溯源协议 + 下游技能）。
7. **第二批 §5 auto-mode 两阶段分类器**：最复杂，依赖模型服务，最后做（先用 mock fail-closed 占位，再逐步替换真模型）。

---

## 跨批次必须保留的全局语义

| # | 语义 | 出处 |
|---|---|---|
| 1 | **item 追加写 + `lastMessageId` 指针回退**（历史永不删除，回退=移指针） | 01 §3 |
| 2 | **`parentId` 树状链**（消息分组、分叉、重放全依赖它） | 01 §3.2 |
| 3 | **`providerData` 侧车**（模型无关数据与模型数据严格分离） | 01 §3.2 |
| 4 | **turn 中断恢复游标**（`_currentTurnInProgress` + `_currentTurnPersistedItemCount`） | 01 §1.4 |
| 5 | **权限与沙箱双层判定**，互不越权 | 01 §2 / 02 §0 |
| 6 | **fail-closed**：未知/不可用/超时 → 一律按"拦截"处理 | 02 §0 / §5 |
| 7 | **HIGH/CRITICAL 永不自动放行**，即使 bypass/fullAccess | 02 §1.3 |
| 8 | **审批记忆只存"会话级"**，键 = 规范化命令 + cwd | 02 §6 |
| 9 | **模型 fallback 链永远有主模型兜底**，custom/external 跳过默认关联 | 03 §3 |
| 10 | **记忆单一事实源是文件系统**，append-only + 去重 | 03 §0 / §8 |
| 11 | **三阶段合法链**（S1→S2→S3，S1 必经 S2，链必终于 S3），只有最终 docx 才对外可见 | 04 §2 |
| 12 | **Cron 三态**：一次性触发即删 / 递归 3 天过期 / durable 跨重启 | 04 §13 |

---

## 逆向来源与溯源索引

- **codebuddy.js**：22955544 字符。四份文档末尾各有"关键还原偏移量索引"表，标注每个函数/模块在 bundle 中的字符偏移（`@offset`），可据此用 `node dump-range.cjs <file> <start> <end>` 复核。
- **运行时数据**：`~/.workbuddy/`（会话 JSONL、file-history、trace）、`~/.codebuddy/`（skills、记忆）。
- **tencent-docx 插件**：`app-extracted/resources/plugins/workbuddy-builtin/builtin-plugins/tencent-docx/`，源码非 bundle，直接可读。
- **机器可读清单**：[replication-rules.json](replication-rules.json) 汇总了全部常量、枚举、文件格式与复刻顺序，可被程序直接消费。

---

## 交付说明

- **Markdown（保留）**：四份分批次设计文档，人类/AI 均可精读。
- **JSON（导出）**：`replication-rules.json`，把散落在四份文档里的常量、枚举、schema、构建顺序抽成结构化清单，供工具链/脚本消费。
