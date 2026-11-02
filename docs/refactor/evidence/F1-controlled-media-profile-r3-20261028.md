# 受控媒体 profile 与 r3 草案
结论：只接现有DSH预算/工具机制，不升级或重写引擎。可信宿主可选budgetProfile=media:<四类taskType之一>，runner加载单独配置，限定180000ms、2次模型、1次媒体工具、每key1次、0重试、512输出token，并将任务白名单压为单项。普通默认/CSV不变，后续warm轮次不继承工具权限。

独立审查发现warm agent初始agentOptions.maxTokens会跨Run沿用，预算报告128却实际请求512。主Agent修为每次agent/request在next返回后按当前active上限设置maxTokens，未配则删除旧值，之后才记录model intent。真实SDK断言provider options实际512→128，复查通过。media配置还强制180000/512，缺失或漂移拒绝。

验证：
- 原Runtime四方法/五事件26项契约检查通过；父子RPC11项（包含host所选profile只透传至对应task、不污染相邻task）通过。
- 原预算变更专项扩展controlled profile、wrong-task零RPC、warm默认实际maxTokens128；CSV真实SDK专项与preflight9项通过。
- 四任务SDK→runner→host RBAC→PGlite持久grant→同tx意图→替身生成→完成/Run状态联测4项通过；默认零工具与单模型限制原反例保留。
- profile源码快照15文件check通过，manifest SHA15ccd479fe16dae36a1bebb2c39797d003f90acc6989e74c0d6adfe8c70814c3；DSH包20文件0.1.1-rc.2清单通过。

## 不可覆盖的 r3 草案
`northstar-controlled-trial-20261028-candidate-34-r3-draft.tar.gz` SHA256 `44b1757736ddd425a4157917984f7138f36959ef6c9d5804e3b965cf6940bce4`；369成员、313文件、168当前源码SHA。新builder复用r1/r2构建逻辑，独立audit复用统一结构/来源检查，不覆盖旧产物。
同tar在隔离Linux/amd64 Node22.23.4干净npm ci（ignore-scripts）后：原portable closure check PASS（472包/30091文件）；预算变更与四任务联测5/5通过。没有真实模型/媒体请求。r1/r2冻结源已非当前，旧current-source checks预期检测漂移；不能把历史归档改为跟随新源码。

## 仍未启用
server尚未提供可信授权签发/读取入口，受控profile未自动开放给用户body；计数授权不是金额硬上限。结果未知保持占位；核对纯函数已主审53项，但未接DB释放。真实测试总/单次credits仍待用户确认，未执行付费POST。新包仍DRAFT_NOT_FOR_DEPLOYMENT；真实普通问答/A→B/四媒体/CSV/费用记录/历史重开及目标发布回滚尚待同版验收。
