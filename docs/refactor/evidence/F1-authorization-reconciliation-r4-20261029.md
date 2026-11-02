# r4 授权与显式核对接线

结论：已在本地接通用户确认→持久授权→媒体 profile→宿主消费/外部意图→结果记录→显式核对 API。前端确认面板支持切会话及刷新事件重放；未知提交保留占位。仅替身 provider 证据，未实际 PT 扣费、未部署，F1 未交付。

授权入口由 `PT_CONTROLLED_MEDIA_AUTHORIZATION=1` 显式启用，默认关闭。等待确认先写 Run 事件，最多120秒（单调时钟），沿用现有租约心跳和取消；确认前不调用模型。签发仅接受 confirmed/modelId，同用户/租户/运行中租约与等待事件必须有效；scope、任务、revision、adapter/provider 全取宿主的新鲜同 Key 路由。确定性 grant ID 防重复签发，消费仍由原子事务执行。次数限制不等于金额硬上限；API/界面均明确 `monetaryCapEnforced:false`。尚未明确测试总/单次额度，不启用真实付费。

显式核对提供 owned Run 的有界预留列表和单 reservationId 请求；不接受 force/结果/费用。复用023及原释放事务：证据充分才释放，重复请求幂等，原授权始终已消费；manual_check/未知提交继续保留。UI 历史核对展示仍待集成，独立 Gemini 任务包已准备，未宣称其已接单或完成。

## 冻结归档

`northstar-controlled-trial-20261028-candidate-34-r4-draft.tar.gz` SHA256 `4a681c86cbc0689d9f7c4fc25fda1b78f0c027ba2bf1d082f0adc1cbf9df4d03`；373成员/317文件/172绑定源码。builder --check、独立审计及只读归档预检已通过；状态仍 `DRAFT_NOT_FOR_DEPLOYMENT`。r1/r2/r3原归档不覆盖。r4包含023、授权模块和核对/释放模块，正式manifest逐项列明未完成的真实业务/价格/金额硬上限/目标部署回滚。

## 实际执行与环境边界

| 验证 | 已观察结果 |
|---|---|
| 授权、HTTP/宿主核对、UI、四媒体SDK/CSV专项 | 14/14；模型/provider替身。HTTP测试实际完成确认前零模型调用、签发后profile、授权消费、结果记录及核对释放 |
| 前端恢复/会话隔离 | 新4项通过；原隔离43断言与manual_check4项通过。原replay25项因切片夹具缺新helper先失败，补载真实helper后25/25 |
| 契约 | runtime原26断言通过；连同phase1及review，Node报告32项通过（runtime文件作为一项） |
| 完整默认回归首轮 | 199套件171通过/28失败；21项本地监听EPERM、6项历史归档/源码绑定、1项上述UI切片夹具。不是业务全绿 |
| 沙箱外完整回归 | 10/28已发起，但跨环境后tmp日志消失，未取得最终结果；不能据此报告通过。10/29重跑，日志改存仓库证据目录 |
| Linux r4 首次尝试 | Node22.23.4/amd64，npm ci(ignore-scripts)安装621包；随后closure命令漏传manifest路径而USAGE失败，未跑后续测试。是验证脚本参数错误，不能宣称依赖闭包或Linux测试通过；待修正重跑 |

10/29恢复现场：HEAD仍b09b1e13720cd16cd7538999d4c63386920b367c，r4源绑定check仍通过。临时日志/fixture目录不再存在，Docker daemon原未运行，已启动以继续隔离验证。历史已通过证据仅按上表记录，不冒充本轮重新执行。
