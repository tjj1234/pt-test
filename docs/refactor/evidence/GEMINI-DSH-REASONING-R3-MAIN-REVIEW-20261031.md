# 推理R3主审：保留原候选，主线改用已有DSH校验API
结论：任务包末尾已标COMPLETED，故按正式候选复审；原4/4单元、本地HTTP/SSE探针均独立通过。但4个反例阻止直接集成，不能以测试通过替代依赖信任与完整资源边界。原四文件未修改，未接入生产或r19。
审查候选SHA256 `ef4c41c3fcac0bdd23e126aafeb7be3843b1bd37ff9ba998e1ebb3b0487dcf77`。原记录为开发者声明，不是生产验收；Context R3仍没有交付记录，其临时文件不作主审完成依据。

| 缺口 | 独立复现 |
|---|---|
| 标准依赖导入失败后扫描cwd/shell/NODE_PATH等不受信路径 | 将候选复制到独立profile，cwd放版本999.0.0的同名无害stub，成功加载UNVERIFIED_CWD_STUB；未核对锁/closure，不能视为可移植受信加载 |
| reasoning=false分支仍先Object.keys再拒绝 | 100项映射的全部100个属性描述符被访问后才抛错，限额未在该分支前置 |
| thinkingLevelMap未限制实际wire语义 | high映射任意非空unverified-wire-fixture仍被宣称supported high；与任务“非法wire拒绝”不符 |
| 错误回显原始元数据值 | supportedEfforts中private-fixture-marker出现在错误正文，违背任务固定脱敏错误要求 |

`node tests/probes/reasoning-r3-main-review-20261031.mjs` exit0表示这些缺口成功复现；证据`reasoning-r3-main-review-counterexamples-20261031.json`标BLOCKED_CANDIDATE_NOT_INTEGRATED，0 providerCalls，不是安全PASS。原单元`reasoning-r3-main-review-unit-20261031.log`、原探针`reasoning-r3-main-review-probe-20261031.log`均exit0。

## 复用优先的主线决定
锁定DSH已经实现：`ctx.llm.resolveModelInfo(provider,model,signal)`输出规范化`reasoning.efforts[].id/name`；`resolveCallWithInfo(config,info)`与`resolveCallConfig(config,signal)`精确拒绝UNSUPPORTED_REASONING_EFFORT，不钳位、不猜通用档位。故不再继续叠加一套原始thinkingLevelMap推断/验证器。
独立原生服务探针`tests/probes/native-reasoning-api-main-review-20261031.mjs`在真实Context/Llm服务上验证：规范化元数据、显式high成功、未知档位和无推理模型显式high在stream前拒绝、普通选择不继承effort；0 providerCalls。证据`native-reasoning-api-main-review-20261031.json`。模型本身为受控适配器，不能把其low/high当成真实PT声明。首个夹具把原生必需字段name写为label被DSH拒绝，已按真实API修正，不能照旧报告猜结构。
生产接线应仅补用户输入界限、可信选中模型→原生元数据查询、UI→持久Run→Runner参数，以及原生installModelSelection；没有受信依赖时直接拒绝，不扫描租户cwd。实际派发继续由DSH原生LLM校验，UI元数据不是权限或运行验证。`resolveCallConfig`单次查询不锁定后续adapter注册，日志与派发须遵守原生prepareCall/真实dispatch的绑定语义；不能把仅查询成功当真实调用成功。
这些共享接线尚未实现；保留为下一主线，不能把本次主审写成推理强度产品已交付。
