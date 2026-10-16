# T05 JSON Schema 校验子范围独立审查

日期：2026-10-16。审查者未参与实现；阅读 `shell/tools/schema-validator.cjs`、registry、package/lock、原测试与实施证据后新增 `tests/regression/tool-schema-review-test.mjs`。未改实现或实施者测试，未联网／调用工具上游。

**首轮结论：FAIL，同名工具更换schema／version但未附execute时会混用旧executor。** 实跑：

```bash
node --test tests/regression/tool-schema-review-test.mjs tests/regression/tool-schema-validator-test.mjs
```

**17项，16 PASS／1 FAIL，exit 1**。原10项实际通过，独立7项中6通过。不是转述实施者「12项」报告。

| 编号 | 独立实证 | 最小修复方向 |
|---|---|---|
| TS01 | register v1工具，integer schema＋数值executor；同名register v2，string schema且不附execute（API允许定义与registerToolExecutor分开绑定）。新字符串参数通过v2 schema后旧executor仍被调用，oldCalls=1，数值运算结果NaN | 替换定义时清除不再显式绑定的旧executor，或用定义/schema/executor原子版本记录拒绝不完整替换；不能将新schema的校验结果交给旧实现。保持已有飞行中调用固定旧版，同时新调用不隐式复用不兼容旧版 |

本反例不同于「正在await权限时重注册」：后者已有锁定且独立验证通过；TS01是完成重注册后的新调用。当前注册对象没有声明复用旧executor的兼容性，独立API支持后绑定不应被旧映射绕过。若选择允许显式复用，需要明确授权与兼容规则并补验收，不能靠遗漏execute隐式触发。

## 独立通过项

- manifest直接精确声明 `ajv=8.20.0`、`ajv-formats=3.0.1`，lock根dependencies与包版本一致并有integrity；实际shell安装包版本同样一致，不依赖偶然传递安装。
- 嵌套类型／数值错误、extra字段、循环、getter、BigInt、Infinity、超过1MiB参数均TOOL_INPUT_INVALID，logger start/finish和executor计数全部0，getter计数0。没有用「只测validate返回false」替代真实executeTool拒绝入口。
- 远程 `$ref`、async、未知dialect／format／keyword、无进展的自引用schema均注册拒绝；本测试替换global fetch的计数为0。代码没有loadSchema／compileAsync，不进行网络schema加载；不把global fetch计数0冒充任意第三方网络审计。
- 标准date-time错误确实拒绝；2020-12 allOf＋unevaluatedProperties拒绝额外字段，合法样本通过，关键字没有默默失效。
- 已注册工具尝试换成无效远程ref schema时原工具schema/executor完整保留，没有半更新。
- 真正await权限检查时改变原参数和重注册工具，旧调用依然执行原executor＋原有效快照，不将其交给新版本。schema冻结／input复制与版本捕获的原测试也实际通过。

## 范围与限制

Schema来自可信PM／服务端定义。当前参数JSON预算有效，但复杂正则／组合schema的CPU硬隔离不在本子范围，不能因Ajv支持pattern就声称防ReDoS完整。format/dialect支持以实际编译规则为准；不要求接受远程ref、async或供应商自定义keyword。

此审查仅Registry schema校验与对应调用边界，不证明DSH直连工具注册已统一、HTTP权限上下文可信、requiredCredentials已执行、日志存储完整、报告可见性、预算或文件/命令/网络沙箱已完成。既有permission自动登记行为不是本轮新增，不把其存在忽略成权限全验收，也不在此扩大修改。尚未真实运行DSH／业务上游／浏览器；T05整包仍不能标完成。失败测试保留供返工，未提交。

## 独立复验：TS01修复，子范围PASS

同日读取修复后的registerTool逻辑：新定义没有显式execute时删除旧executor映射；已经飞行中的调用仍使用调用开始时固定的旧executor。未修改原独立测试或实现。重新执行上述联合命令，结果 **18/18 PASS，exit 0**（独立7项全部通过；实施测试现11项，新增无executor替换回归）。

原TS01反例中字符串schema版本的新调用不再触达旧数值executor，oldCalls=0，metadata.executed=false；此前通过的非法参数logger/executor零触达、注册失败原版保留、权限等待版本固定、远程ref／危险schema拒绝、format/dialect与依赖锁定控制全部保持通过。闭环为 **FAIL → 清理陈旧executor并补实施回归 → 独立复验PASS**，历史失败保留。

当前结论为 **PASS（Registry JSON Schema输入校验与本组版本边界）**。DSH直连工具治理、HTTP集成、真实权限／凭据、日志持久化和T05其余范围仍未由本次验收覆盖，不标T05整包完成。
