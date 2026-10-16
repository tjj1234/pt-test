# T00 契约独立反例审查

日期：2026-10-16。审查对象为当前工作区新实现 `shell/contracts/phase1.cjs`；审查者未参与该实现。基线提交 `a2adbee64c326653dbf5bfed3f918dd09f96589d`，被审查文件是本轮未提交增量，不能称为该基线已有代码。范围仅离线契约函数；未改实现、依赖或共享入口，未启动服务／数据库或调用付费网络。

**首轮结论：FAIL，不应据现有自测直接冻结此契约。** 独立编写并实际执行 `node --test tests/regression/phase1-contract-review-test.mjs`，12 项中 3 通过、9 失败，exit 1。失败断言保留为返工用反例，不跳过、不修改期望来制造通过。测试只覆盖函数边界，不等于线上漏洞利用或完整产品验收。

| 编号 | 实际反例与结果 | 风险／最小修复建议 |
|---|---|---|
| CR01 | 自引用对象传入 `fingerprint` 得到 `RangeError: Maximum call stack size exceeded` | 缺循环检测；使用祖先集合检测循环，给受控 TypeError／明确契约错误，不让调用栈决定输入上限 |
| CR02 | 20,000 层普通对象同样栈溢出 | 缺深度／节点／字节预算；在递归前检查有界资源，深 JSON 也可能由网络解析获得，不只是假造 JS 对象 |
| CR03 | event payload 为 BigInt、循环对象或 Infinity 时 `validate` 均返回零错误；前两项 JSON.stringify 抛 TypeError，Infinity 会静默变 null | 所有接受的可持久化／SSE 对象应验证有限 JSON，禁止未校验 payload 到存储或流式写入；Infinity 不是序列化崩溃，但会语义丢失 |
| CR04 | 合法 run 额外带 `clientMetadata: 1n` 仍零错误 | 只查已知字段，扩展字段可绕过序列化约束；选择拒绝未知字段或全对象有限 JSON 验证，不要求一律禁止兼容扩展 |
| CR05 | revision 为 MAX_SAFE_INTEGER 是合法 run；transition 后返回不安全整数 revision，未抛错 | 状态操作不能产生不符合自身契约的结果；先判断递增上限并给可识别错误 |
| CR06 | `assertEventAfter(null, done事件, queued状态run)` 接受完成事件 | 当前仅验证 scope/seq，未绑定事件状态语义；明确该函数是否承担状态一致性，若由另一入口负责必须给真实强制入口和测试，不能仅声明下游会处理 |
| CR07 | `tool.finished` 只要 callId 就能带 `{state:'running'}` 通过 | 定义并验证最小事件 payload，与工具终态一致；跨 call 对象关联应由执行／存储层再验，不把此静态测试冒充真实关联已完成 |
| CR08 | endpointTypes、tasks、input/outputModalities 全为 `unknown`，但声明 discovered/adapted/verified=true 且有任意非空来源，AUTO 仍通过 | verified 布尔不是能力内容验证；允许 unknown 目录记录，但 AUTO 必须要求已知、已适配的任务／端点／模态，未来扩展枚举须有明确规则 |
| CR09 | 1 MiB 幂等 key 被接受并哈希 | 这是资源边界缺失，不证明此体量单次导致服务中断；需制定并在 API／契约一致执行 key/operation/标识符字节上限，超长输入受控拒绝 |

补充直接行为探针实际输出：BigInt payload「validationErrors=0，serialization=TypeError」；循环 payload 同样；Infinity payload「validationErrors=0，serialization=serialized」，其值会变 null。循环与 BigInt 不能直接由合法 JSON 请求携带，但可能来自工具／内部对象；此结论针对产品对象边界，不声称网络 JSON 能注入 BigInt。

通过的独立控制项：① bindRun 拒绝 userId／tenantId 覆盖且保持可信身份；② 事件 runId／conversationId 不符会拒绝；③ ModelAttempt 的 reportedModel=null、state=unknown 保持未知语义，没有强制伪造已知模型。控制项能说明部分保护实际有效，不能抵消上述失败。

CR06/CR07 是当前缺失的语义保证，若设计确定事件校验必须使用运行前快照或由专门状态机接管，应先明确该契约及所有调用入口，再调整反例到真正执行边界；不能生硬增加错误限制而破坏合法先发事件后持久化的协议。CR08 不要求任意将新模型任务拒为未知，而是要求 AUTO 候选具备有证据的已知执行能力。CR09 的具体限额待实现者明确，测试只选明显应拒绝的 1 MiB 键，没有臆造产品规定的精确阈值。

返工后需由未参与修复的审查者重跑本测试和原契约测试。再验证全量回归及实际契约接入路径；本轮只新增测试与证据，未把类型层补齐等同于持久任务、跨租户权限或真实 DSH 已完成。

## 独立复验 1：原反例修复，新增边界仍失败

同日读取主 Agent 修改后的实际实现并重新运行原测试，原 9 类反例已全部通过，没有降低断言。新增 8 个独立测试：6 个正常／边界控制通过，另 2 个新反例失败。联合执行 `node --test tests/regression/phase1-contract-review-test.mjs tests/regression/phase1-contract-test.mjs`：**31 项，29 PASS／2 FAIL，exit 1**；其中本审查文件 20 项，18 PASS／2 FAIL。当前最终结论仍为 **FAIL，需再返工**。

通过控制的实际内容：done 对四种终态 append 快照均合法；tool.finished 对 succeeded/failed/cancelled/unknown 合法；共享对象出现在两个分支不被误判循环；JSON 1 MiB 精确字节边界、Unicode 字节和转义扩张、10,000 节点与 64 层深度的边界接受／越界拒绝符合新限制；普通嵌套 payload 可校验并 JSON 序列化；幂等 operation=128字符、key=256字符正常，越界受控拒绝；revision 从 MAX_SAFE_INTEGER-1 增至最后安全值合法，下一次以 REVISION_EXHAUSTED 拒绝。此前 reportedModel=null、身份覆盖和跨 run/conv 控制继续通过。

| 新编号 | 实际反例 | 最小修复／边界 |
|---|---|---|
| CR10 | run.state=completed，而 done.payload.state=failed，assertEventAfter 仍接受 | 终态快照语义已明确；若事件声明 state，应要求等于该 append 快照，不能把矛盾结果送 UI／审计。若 state 必填，需同步公开 schema 与调用者 |
| CR11 | 普通对象 payload.value='normal'，使用非枚举自有 toJSON 方法抛错；validate 仍零错误，而真实 JSON.stringify 抛出 | canonicalJSON 只遍历可枚举键，未排除 JSON.stringify 会执行的隐藏 toJSON。需拒绝行为属性／访问器、或返回并只持久化已规范化的纯 JSON 快照，不把原对象作为校验后安全值。此输入来自内部对象而非普通 JSON 网络请求，不误报为已证明外部可利用 |

当前复验未修改实现、依赖或共享文件；新失败断言保留。通过边界预算测试只证明这些构造输入，不证明任意代理对象／getter 无副作用，也不证明整体资源消耗已完成压力验收。

## 独立复验 2：本次契约函数范围通过

再次读取修复后的实现，独立执行上述联合命令：**31/31 PASS，exit 0**。CR10 已要求 done 事件声明 state 为终态且匹配 append 当时的 run 快照；CR11 的隐藏 toJSON 被拒绝。原反例与新增正常边界控制均保留。本次最终结论为 **PASS（契约函数及本组反例范围）**，取代前两轮 FAIL 状态；历史发现保留不抹除。

事件校验语义：`assertEventAfter` 接收的是事件追加当时的 run snapshot；历史事件重放不能把当前最新终态快照套给每个历史事件。真实存储／事件发布者须保存或重建相应版本并在原子追加边界调用；本次函数通过不证明实际调用入口已经接通。没有真实 DSH、数据库持久事件或浏览器端到端验收。
