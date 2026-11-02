# Context R2 主审：候选未接生产
结论：原4/4单元与本地HTTP探针可独立复跑通过，但未满足任务包要求的真实原生自动/手动压缩；存在预算及取消门禁缺口。保留原四文件，不修改其交付记录，不启用主线压缩插件。

| 要求 | 源码与独立证据 | 判定 |
|---|---|---|
| 实际插件触发压缩 | probe只导入Context/PiAiAdapter与候选；直接调用waterfall，人工emit三种compaction事件，未加载compaction-basic或command-compact | 未验证 |
| chat每次网络请求已准入 | 候选仅按purpose=chat或缺省值直接next；无准入凭证核验 | 缺口 |
| 取消后网络前拒绝 | activeTurn.cancelRequested=true仍准入compaction并dispatch | 缺口 |
| 两个重叠会话 | 原probe顺序完成sess-1后执行sess-2，没有并发重叠 | 仅顺序隔离 |
| 用量/意图与持久审计 | 只有本地计数与人工事件，未走主线持久Run/模型意图/用量记录 | 未验证 |
| settle | 包装流消费结束finally才settle，比R1正确；未消费返回流、recordEvent抛出与取消传播仍需验证 | 局部通过 |

独立执行：`node --test tests/regression/dsh-native-context-r2-test.mjs tests/regression/dsh-native-reasoning-r2-test.mjs`，8/8，见`dsh-native-r2-main-review-20261030.log`。两个原生Adapter本地探针均exit0，见`dsh-context-r2-probe-main-20261030.log`、`dsh-reasoning-r2-probe-main-20261030.log`；不将其升格为真实压缩触发证据。

反例：`node tests/probes/dsh-context-r2-main-review-20261030.mjs` exit0表示成功复现不安全行为，输出`BLOCKED_CANDIDATE_NOT_INTEGRATED`，不是安全验收PASS；无Run chat不计预算却dispatch、取消Run辅助调用仍dispatch，共2次内存夹具dispatch、0真实providerCalls。

已核实当前锁定`dsh-compaction-basic/lib/index.js`摘要调用明确带`sessionId: agent.session.id`及`purpose: compaction`。因此可复用此原生归属，不应猜唯一会话，也无需重写压缩引擎。Runner使用业务sid而原生sessionId前缀为session-；主线需显式建立当前Run与确切原生session.id映射。普通聊天需网络门禁消费一次性准入凭证，不能仅信purpose；摘要需统一取消、截止时间、输出上限、durable模型意图及usage审计。空闲手动压缩没有活动Run时应先通过宿主创建受控Run，不能绕过绑定。

推理R2另有生成profile中相对node_modules导入不可移植、元数据map/filter早于长度上限的问题；原候选保留，尚不接生产。
