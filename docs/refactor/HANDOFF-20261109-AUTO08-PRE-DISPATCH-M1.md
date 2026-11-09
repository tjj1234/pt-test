# 08调用前AUTO M1：独立接入与发布边界

当前：独立分支 integration/auto08-pre-dispatch-20261109，工作树 /private/tmp/pt-auto08-integration-20261109；R33基线88d6535，生产代码f5fa39a。仅本地接入、尚未部署；正式环境未修改。普通澄清已随R33上线待QA；审批/FS/脚本关闭，第三批Bug abb3851主审NEEDS_REVISION，不混入。

已完成：宿主可选配置PT_AUTO08_ROUTE_CONFIG_FILE只改变AUTO调用前候选顺序，复用routeChatTask资格判定；配置SHA/版本、目录scope与模型capability revision绑定到持久请求证据。server调用意图RPC统一走Run持久许可，按Run/purpose/turn/step唯一；同一逻辑请求不同RPC id亦不能再获许可；同一handler重复RPC也拒绝再授权，旧无reserve的测试兼容路径只用于隔离单元场景，生产统一提供reserve。Run行锁后校验实际租约，许可与事件同事务；旧worker被隔离，新worker遇旧记录不自动续发。

保守边界：记录只说明“可能已提交”，不证明供应商执行/结算；没有发送后自动降级，没有零费用保证，没有自动清除旧许可接口。跨进程恢复宁可阻断并核对，也不重复扣费。当前每个Run最多100条model request许可，现有预算另行生效。媒体外部操作仓库仍保持自己的状态机；文字请求不挤占媒体external_operation_key。

R34归档SHA 70361b6ed893ae440650e3d7dce37058efa0633ea7f1b8f936b91026d359ee5d，225绑定源/428成员；新增030只新增model_request_attempts表。复现与初始缺口见AUTO08-HOST-INTENT-REVIEW-20261109.md；当前校验见AUTO08-M1-INTEGRATION-REVIEW-20261109.md；正式同版QA清单见R34-AUTO08-M1-QA-REQUEST-20261109.md。部署必须先获正式R33→R34切换授权，再现场核对并发Run、备份及隔离恢复/迁移、可回退unit/profile和部署后源码/公网指纹；不得盲重跑R33脚本，不部署工作区。

Gemini只继续04原生web接缝修订，08共享接线已由主程接管，不让作者重复写选择器；两位程序员C01/C02/C03路径未动。主工作树bbd9997的既有脏文件未覆盖；独立作者分支保留。恢复先看Git及已结束的测试证据，不重复未变源码测试、不把旧归档覆盖生成。暂无供应商费用核验或独立QA完成证明。

## 2026-11-09用户扩大R34范围并暂缓发布

本M1成果保留，但不满足用户要求的R34全量最终包，不再单独上线。当前主分支改为integration/r34-final-all8-20261109；以R34-FINAL-ALL8-RELEASE-SCOPE-20261109.md为准，合入Gemini八包、Bug及QA后重新冻结最终产物。现有归档与部署脚本是历史草稿，不覆盖/复用为最终发布。
