# 08主程接缝探针：文字意图不是提交栅栏

结论：08预调用M1的下一前置是最小持久attempt/提交栅栏设计，现有文字调用意图不能直接替代。未改功能代码、未合并上线、零供应商调用；测试源为git archive 88d6535的独立快照，实际生产createModelIntentHandler、createTaskStore与PGlite持久库，priceStore仅用标注合成替身。

探针 tests/probes/auto08-host-intent-boundary-20261109.cjs，运行以AUTO08_SOURCE_ROOT指向R33导出目录，PT_PGLITE_PATH指定本机安装。结果见AUTO08-HOST-INTENT-BOUNDARY-20261109.txt，最终退出0：

| 验证 | 结果及意义 |
|---|---|
| 同handler重复requestId | 一条持久意图；现有Map去重有效 |
| 重建handler，同requestId | 两条持久意图；Map不会跨实例恢复，事件仓库按eventId而非attemptId唯一；确认缺口，不等于证明生产已经发生重复收费 |
| 持久证据 | submission=intent_only；没有证明上游已发送/接受/零收费 |
| 租约接管 | 旧owner append被LEASE_LOST拒绝，可复用现有owner fencing |
| 跨tenant读取 | NOT_FOUND，可复用owned Run读取门禁 |

第一次探针使用非UUID tenant夹具，被数据库22P02拒绝；修正为合法随机UUID后通过。初次日志单独保留，不当成产品缺陷。未验证真实PostgreSQL并发、真实SDK提交计数或跨进程发送互斥，这些仍待下一阶段。

接线方案边界：保留DSH原生Agent/provider及Run事件链；配置只决定预调用候选顺序，资格仍由routeChatTask判定。需增加/复用的权威记录必须按可信Run+逻辑请求序号（如turn/step及purpose）定位attempt，而不依赖仅当次进程生成的RPC UUID；绑定config/catalog/capability revision、selectedModel及租约代次。重放同一逻辑attempt必须返回原记录，参数变更拒绝。网络提交前持久CAS从准备态进入SUBMITTING，已有SUBMITTING或UNKNOWN不允许自动换模型/重发。记录了intent并不代表“确认尚未发送”，重启不能据此重提。

当前媒体外部操作仓库有真实owner/状态/查询语义，但recordExternalIntent会把Run转waiting_external且单Run一个external_operation_key；文字Agent可有多个model call和compaction，不能直接借媒体字段塞所有文字attempt，避免破坏现有生命周期。下一实现前需核定可复用事件/表及唯一约束，冻结逻辑attempt标识、写入与lease接管语义，再跑实际仓库与SDK合成provider全矩阵。不以盲改现有appendEvent规则处理所有历史事件。

费用证据只限制提交后的自动降级；M1不等PT账单、不声称零费用。Gemini04继续按原生web主审修订；08共享记录/栅栏/入口由Codex处理。05普通澄清M1已随R33上线待QA，审批/FS/脚本仍关闭。
