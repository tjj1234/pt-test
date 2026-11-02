# r16模型配置修复：本地证据与目标缺口
结论：修复已冻结并通过聚焦/确切归档Linux验证，未在目标机应用。线上UNKNOWN_MODEL已证实；具体错误到模型/Run的对应关系仍未获取。媒体缺配置、INVALID_REQUEST单条未定位及最终重构剩余范围均未关闭。

| 验证层 | 证据 | 结论 |
|---|---|---|
| 运维原始回执 | `../logs20261030` | 扫27文件，25错误：UNKNOWN_MODEL12/预算8/INVALID_REQUEST1/旧UNKNOWN4 |
| 源码与锁定原生SDK | `tests/probes/r14-model-config-offline-20261030.mjs` | 未配置模型零HTTP，UNKNOWN_MODEL安全分类；同会话两DeepSeek配置ID成功；128实际输出上限；400安全INVALID_REQUEST |
| 聚焦回归 | `r16-config-docx-focused-20261030.log`、`r16-final-focused-20261030.log` | 分别22/22（含UI内部50断言）、25/25；不相加当独立总数 |
| HTTP | `r16-http-focused-20261030-r2.log`、`r16-docx-csv-http-20261030.log` | 模型/媒体2通过；CSV初因新配置事实缺失失败，补齐后含DOCX输入1/1通过 |
| 受影响夹具复跑 | `r16-http-config-fixtures-20261030.log`及r2/r3 | 6+3+2=11套件通过，产品不设测试旁路 |
| 活动归档 | r16 builder --check、独立audit、current-northstar-draft-artifact-test | PASS，193源码/394成员；旧草案不覆盖 |
| Linux干净依赖 | `r16-linux-install-20261030-r2.log` | Node22.23.4 linux/x64，495生产包/31007文件，lockSHAd492d50bdc6bf27ae58ce473507835e240c4bc1ac02f2ab24ac6831fe328e68d |
| 确切归档Linux | `r16-exact-archive-linux-20261030-r2.log` | 同锁定干净依赖上解包确切r16，closure PASS、7/7业务断言+原生故障探针PASS；首次缺测试专用导出候选失败保留，改独立OOXML夹具后复跑 |
| 完整默认首轮 | `r16-default-regression-20261030.log` | 232套件214通过/18失败；随后11配置夹具+1活动指针均独立复跑通过 |

余6个失败仍为历史candidate34、candidate28/30/31/32、旧lockfile来源绑定；candidate31/32为signal终止，不将其表述为断言通过。没有再跑一轮232套件，也不声称完整默认全绿；“214通过+12修复复跑通过”是分批证据。

r16 archiveSHA `5ca372213a0aa22a9b00777cfe51fccc6542f72b027f116afd3e5205cdeb5119`，状态DRAFT_NOT_FOR_DEPLOYMENT。完整目标预检、settings基线/升级、profile重建、同Key实际对话/AUTO/媒体及回滚尚待。操作文档`../OPS-R16-CONFIG-REPAIR-20261030.md`；只读媒体预检脚本SHA `0cdb43fa5a21f5cb70e50b1c7212f4b3e4e846f985198ffeb4c3fa12235757ce`，不含在r16应用tar内，可独立传/tmp并从目标shell目录运行。

Context R2与推理R2未混入r16。原8/8及探针局部通过；Context真实压缩触发与预算/取消缺口见`GEMINI-DSH-CONTEXT-R2-MAIN-REVIEW-20261030.md`。项目完整交付仍按12工作流+5跨功能门禁，未声称最终包完成；本轮无生产部署、付费模型请求、commit或push。
