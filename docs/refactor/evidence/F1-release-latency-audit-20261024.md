# F1 发布与延迟证据审计（2026-10-24，独立只读工作位）

**结论：当前没有可冻结的 F1 完整 Agent 候选；旧 candidate-33 r4 的可复现审计通过，但它仅是目录故障诊断草案，不包含本轮 F1 功能。** 现有真实请求时间是单次样本，可用来划定后续观测阶段，不能用来声明优化收益或服务分位数。未调用 PT、未修改服务、未打包、未部署。

| 现场核查 | 实测结果 | 能证明的范围 |
|---|---|---|
| `git branch --show-current`、`git rev-parse HEAD`、`git status --short`（主 Agent 同轮现场记录） | `feature/northstar-phase1-refactor-20261016`、`b09b1e13720cd16cd7538999d4c63386920b367c`，大量已改及新增文件；`wb copy/`保留 | HEAD 不能代表当前完整 F1 源码 |
| `python3 scripts/package-northstar-candidate33-r4.py --check` | PASS；r2 base SHA `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77`；r4 draft SHA `665ad991cb38f3f00fecf1c463a83c02319e5fe2e29a8e9829ae2e3fd3a79f4c`；325 成员、仅四成员 overlay | 旧草案构建可复现；构建器显式标记 `NOT FOR DEPLOYMENT`，不能代表当前 F1 |
| `python3 scripts/audit-t16-candidate33-r4.py` | PASS；321 成员与冻结 r2 逐字节相同；安装输入不变；portable manifest 472 包、30,091 文件 | 旧草案本地归档/闭包审计；不证明目标机或当前 dirty 功能 |
| `cat docs/dsh-profile-snapshot/run-persistent/run-budget.json` 与 `cat shell/runtime/run-budget.json` | 两者均 `maxModelCalls=1`、`maxToolCalls=0`、`maxToolCallsPerKey=0`、`maxRetries=0`、`maxDurationMs=180000` | 当前保守试验配置会挡住 Agent 媒体工具；这些数值也不是实际费用上限 |
| `git diff --check` | PASS | 当前可见 diff 无空白错误，不代表构建/回归/发布通过 |

目标机证据以[第一轮基线清单](../北极星r4目标机只读基线采集-20261023.md)及[第二轮只读文件/健康清单](../北极星r4目标机只读文件与健康采集-20261023.md)为边界。已有第一轮摘要称 Linux/x86_64、Node v24.22.0、服务 active、r2 release 工作目录及无 drop-in；本工作位没有实时 SSH 或原始输出。第二轮 unit 类型/owner/mode/链接目标/SHA、环境文件属性、最终路径的`test -e`与`test -L`退出码、local/public health JSON `ok===true`均未见回传；有效 systemd 配置与回滚源→备份映射因此尚不能冻结。旧[r4 runbook](candidate33-r4-diagnostic-runbook-draft-20261023.md)仍有`[FREEZE]`、`[TARGET]`占位和 DRAFT unit，不能执行。

延迟口径以[本轮真实PT探针](F1-pt-live-probes-20261024.md)为原始记录：目录头/完成833/840 ms；直接文字模型头/完成分别4179/4184 ms、3033/3037 ms；DSH单模型首 delta/完成4824/5079 ms；文生图 POST头/完成17529/17538 ms，图生图39565/39576 ms；文生视频 POST在10551 ms无响应失败，图生视频HTTP403约1056/1066 ms。上述每行都是一次观测；失败/未知结果不进入成功延迟分布。DSH同会话 A 冷/B 热且上游身份未回传，不能据2985/2986 ms与819/1228 ms比较模型速度。图片下载头/完成1266/8945 ms是产物拉取阶段，与模型生成阶段分列。无账户登录，实际扣费未知。

下一可执行验证序列：①冻结**当前 F1 全源码**、依赖/manifest、配置及候选身份，保留 dirty 用户工作，生成候选成员与 SHA 表；②在隔离安装根/最终模拟 release 路径做闭包、构建、聚焦与跨功能回归；③明确当前 Key 下每个被声明的 model×task 的能力、权限、适配和预算，再在同一候选从用户入口测对话、A→B、四类媒体结果与历史；④按阶段记录请求受理、首 delta、模型完成、媒体 POST/轮询、资源可见、刷新重开，每个样本附候选/模型/任务/冷暖/成功状态，累积足够样本后才算 P50/P95；⑤取得目标机原始只读基线、健康、有效配置与回滚映射，再单独审阅是否可发布。任何一项失败，保持 F1 不可交付结论；不能用 candidate-33 r4 的诊断审计替代。此次无需用户提供该 Key 的控制台账单。
