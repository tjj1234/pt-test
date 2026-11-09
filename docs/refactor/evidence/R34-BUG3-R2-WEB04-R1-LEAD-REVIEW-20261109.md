# R34全量包：第三批Bug R2与04 R1统一复审（2026-11-09）

结论：两份新交付均有进展，但尚未满足整体合并放行。用户已将R34范围扩大为八包+全部Bug+QA，旧08M1 R34不单发；本轮未修改作者分支或正式环境。以下为一次性系统返修清单，不只修本探针样本。

## 第三批Bug：65646de / 补丁e955d4b4...

原专项4项、来源静态1项、流式模拟脚本和UI预览64断言复跑通过，node --test汇总7测试单元。完整补丁在R34 M1基线git apply --check通过；机械可合不代表已批准。此前HTML同源脚本/新窗口放宽已撤销，价格仓库撤回虚构默认值、UI诚实unknown、存储真失败不再伪成功、backend状态语义回到错误码；这些整改可确认，但对应真实功能未全部验收。

仍需作者一次性闭环：

| 编号 | 源码/证据问题 | 修订及验收 |
|---|---|---|
| B3-R2-01 | persistUsage已撤零Token补录，但persistSteps仍以taskType硬编码seedance-2-5/seedream；实际执行两行生产表达式，step无modelName且无grant时仍猜模型 | 整个审计链不造模型身份，不只删除一处writeUsage；从owned external operation/实际工具结果取，缺失null。未知/失败/未发/取消/重复回调均测，不能将选择模型当已生成成功 |
| B3-R2-02 | streaming-lifecycle-e2e-test.mjs自行实现simulateAdapter和handleTurnStopped，以Map模拟DB，没有导入生产adapter/server/store，不是E2E | 用真实adapter帧、实际HTTP/Run/持久DB、刷新与重开验证停止/超时/error/close/lease loss/迟到/多会话与幂等。不得复制实现当oracle；已有静态includes只能标静态证据 |
| B3-R2-03 | 作者已撤假价格，因此B3-07仍缺真实审核价格，不能说“单价缺失已修复” | 真实定价原文/版本/采集/生效/单位及审核导入走F3，空目录保持unknown只是正确底线，不是完成。主程负责部署导入，不要求作者硬编码替代 |
| B3-R2-04 | 资料关闭/图标有实现，存储写失败和价格未知样本通过；未覆盖原清单完整真实浏览器/HTTP/并发矩阵 | 逐项列PASS/FAIL/BLOCKED和证据；元数据跨进程/原子写/重开、reasoning错误分类、来源清空/重开/换会话、HTML禁脚本Cookie加载及图标响应实际验。报告不要所有行直接PASS |

生产函数否定句和空价格验证已整改：主程旧probe跑到ENOTDIR真实抛错，不以非零退出误报整改失败。流式非stopped的error分支已有errText+r.text落库代码，未据此声称错误内容必丢；问题在真实持久链证据缺失及partial语义待验。

## 04可信联网：eb6b29b / 核心源8b3456c1...

作者28断言、旧主审3反例和锁定DSH真实Cordis WebRuntime/tool-web 6项复跑通过。确认导出原生provider接缝，未自建模型工具引擎。下列原矩阵边界仍未满足：

| 编号 | 实测/源码证据 | 一次性修订要求 |
|---|---|---|
| W04-R1-01 | isPrivateIp对fc01::1/fd12::1/fe90::1/::ffff:7f00:1均false；validateUrl允许白名单[::1]的IPv6回环 | 规范化IP与完整CIDR策略，不靠字符串前缀；IPv4映射、IPv6括号、link-local/ULA/非公网及多DNS结果统一测试。白名单不能授予私网权限 |
| W04-R1-02 | ctx.web.fetch返回最终127.0.0.1地址仍ok；customFetcher的hops可缺失，且“逐跳校验”发生请求结束后；DNS默认null且预解析不绑定真实连接 | 明确可信transport与宿主边界；优先核查锁定DSH实际fetch provider，确有缺口才补最小transport。连接前校验每跳并绑定DNS结果/实际socket，重定向目的地请求前拦截；最终URL/状态也校验。后验hops JSON不证明没碰私网 |
| W04-R1-03 | 不配合signal的fetcher，abort后40ms仍pending；search timeoutMs=5，40ms后仍pending，释放backend后才完成 | 本层有界deadline/abort竞争，并协调底层资源真实终止；DNS等待也纳入取消/超时。晚结果不发布，取消后不重复执行/无泄漏；前后检查不能叫“立即取消” |
| W04-R1-04 | maxBytes=NaN成功绕过比较；maxBytes/timeout/结果数量/输出字段类型未完整验证，字节限额只在全量内容返回后做 | 有限整数上下界、共享硬上限；流式真实字节/解压边界/输出总量有界，search摘要/命中数量也限制；不得信任reported byteLength，不能先无界读取再拒绝 |
| W04-R1-05 | ctx/web返回结果、search snippet hash、backend给的hash与真实抓取正文之间无完整绑定；provider默认dsh-run/dsh-tenant，不具备宿主可信Run上下文 | 搜索摘要与正文证据分类型，最终URL/响应/时间/hash不可伪装；错误外泄脱敏。scope由主程tools/execute可信上下文注入，作者交可绑定接口；默认占位值不可称已租户隔离。共享Run/预算/来源入库仍由Codex负责 |
| W04-R1-06 | 有provider注册并不代表有生产可用搜索/抓取后端；available可被allowNetwork/provider名称误标可用 | 明确后端依赖、配置、授权、不可用语义与清理disposer；registerToDsh缺服务应明确失败，不能默默no-op当成功。真实tool-web的search和fetch、注册/撤销/并发/取消/故障全覆盖 |

新增WEB04-REVISION-LEAD-REPRO-20261109.txt来自精确作者模块+合成后端，零网络请求；不是生产私网访问漏洞利用，也不是供应商验收。不配合取消/超时探针会释放后台Promise后收尾，不留挂起任务。所有结果与版本以source manifest为准，不用报告“全数通过”替代原矩阵。

## 主程与QA后续

问答预算P1优先定位，不能仅加maxToolCalls；QA报告根因仍推测，待失败Run ID、首次工具参数/错误或脱敏抓包。单价按审核导入，表格列宽patch尚未核实。第三批Bug与04修订通过后，只在integration/r34-final-all8-20261109选择性接入，保留08持久栅栏。01/02/03/07及05审批/06隔离缺口仍属于R34全量阻断，不因本报告两份交付而结束。本轮所有正式部署继续暂停。
