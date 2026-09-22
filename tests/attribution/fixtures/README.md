# Attribution fixtures（从 A0 起建设）

| 目录 | 用途 | 阶段 |
|---|---|---|
| `contracts/` | Contract 形状样例 JSON | A0 |
| `providers/` | `google-ads.csv` / `meta-ads.csv` / `x-ads.csv` | A1 |
| `events/` | Collect 合法/非法事件 | A2 |
| `golden/` | Workflow 期望输出 | A3–A5 |
| `panels/` | Panel 渲染快照输入（仅 Workflow 输出） | A4 |

规则：

- fixture 中的 `tenantId` / `workspaceId` 只出现在 **Context 样例**，不得出现在「客户端请求」样例里作为可信字段。
- 生产路径不得加载本目录做自动 seed。
