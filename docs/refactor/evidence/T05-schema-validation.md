# T05 · Registry JSON Schema 输入校验子范围

日期：2026-10-16 17:20–17:30 JST。实施者：架构子 Agent；主集成者：Codex。分支：`feature/northstar-phase1-refactor-20261016`。状态：**Registry JSON Schema 输入校验子范围独立验收 PASS；不是 T05 全包完成，也未统一 DSH 直连注册路径。** 提交待做；合并和部署未做。

## 变更与依赖证据

| 文件 | 改动 |
|---|---|
| `shell/tools/schema-validator.cjs` | Ajv 编译、标准 format 插件、有界纯 JSON 参数快照、非变异校验和脱敏错误摘要 |
| `shell/tools/registry.cjs` | 注册前编译快照；validateToolCall 完整校验；executeTool 在 tool-call logger／executor 前拒绝非法参数；锁定同次调用的 schema／executor 版本与输入快照 |
| `tests/regression/tool-schema-validator-test.mjs` | 11 个边界与执行拒绝测试，包括重注册时防止沿用旧 executor |
| `shell/package.json`／`shell/package-lock.json` | 直接精确依赖 `ajv:8.20.0`、`ajv-formats:3.0.1`；不依赖传递安装偶然性 |

安装命令：在 shell 执行 `npm install --save-exact ajv@8.20.0 ajv-formats@3.0.1 --ignore-scripts --no-audit --no-fund`，exit 0（up to date）。二者原已由传递依赖安装；本次 manifest 与 lock 根 dependencies 各新增两行，既有 resolved／integrity／包版本未漂移。测试同时断言 manifest 精确版本、lock 根声明和实际锁定 Ajv 版本。

依据：[Ajv options](https://ajv.js.org/options.html)、[JSON Schema dialects](https://ajv.js.org/json-schema.html)。官方选项说明用于选择不修改数据的校验策略与显式 dialect，不据库支持声明代替本项目行为验证。

## 执行语义

未声明 `$schema` 默认 draft-07；显式支持官方 draft-07 URI、2019-09 和 2020-12，各用对应 Ajv 类。支持嵌套对象／数组、required、additionalProperties、数值与字符串限制、enum／const、allOf／anyOf／oneOf／not、if／then／else、本地 `$ref`、依赖与对应 dialect 关键字、标准 format。不是手写 required 检查。

未知 schema 关键字／format、无效类型、不支持 dialect、无法解析的外部 `$ref`、async schema 在注册时拒绝，错误 code TOOL_SCHEMA_INVALID；没有远程加载器或验证网络请求。不允许类型强转、自动默认值或删除多余字段以“修好”输入。boolean false schema 可注册但拒绝全部调用。每次注册独立 Ajv，避免其他工具意外提供跨工具引用；不支持从其他工具加载 `$id` 资源。

Schema 在任何 Registry／权限表变动前完成编译并保存冻结快照；调用方或工具清单读取者不能随后改 schema 绕过校验。参数先进行 phase1 的深度／节点／字节预算及纯 JSON 检查，再独立拷贝。undefined、NaN、循环、getter／toJSON、类实例、过大参数均 fail-closed，且 getter 不执行。schema 与参数不是可执行权限来源。

`validateToolCall` 保持 boolean 接口；权限或 schema 不通过返回 false。`executeTool` 非法输入抛 TOOL_INPUT_INVALID／400，只含关键字和位置，不回传完整输入值；权限失败抛 TOOL_PERMISSION_DENIED／403。非法输入不触达 executor，**也不触达当前 tool-call logger**。如需另记被拒请求，应由上层独立安全审计实现，不把拒绝计成已执行工具。

execute 使用校验前快照直到真正 executor；异步权限／logger 等待期间原始对象变化不会改变执行参数。等待时若同名工具重注册，已开始调用继续绑定原 executor／schema，不把旧校验结果交给新实现。当前日志数据结构未新增工具版本列，该关联信息的持久化仍需后续 T11。

## 实际验证

命令：`node --test tests/regression/tool-schema-validator-test.mjs tests/regression/tool-registry-test.mjs tests/regression/m1-tool-wiring-test.mjs`。修复前12/12；独立首验发现旧 executor 跨版本复用后保留该红例；修复后当前结果 **13 Node tests／13 pass／0 fail／0 skip**，其中新增11项，原Registry脚本通过，原M1真实PGlite工具接线内部12断言通过。`git diff --check` exit 0。

新增覆盖：三种 dialect；本地 ref、嵌套、分支、条件、format、数值和数组约束；无效 schema 不留部分注册；禁止 defaults／coercion／removeAdditional；非 JSON／过大／getter；非法参数 logger/executor 均 0 次；合法参数保留日志与执行；schema 外部修改、权限等待、logger 等待、重注册四类竞态不改变本次已验证执行对象。所有权限检查使用受控角色 DB 夹具；M1 只验证既有工具和日志，不是完整生产授权／HTTP／DSH 验收。

## 边界与剩余工作

- DSH 的 `agentCtx.tools.register()` 直连仍可能绕开 Registry。此次只接入当前 Registry 两入口，不能声称所有对话／HTTP 工具已统一；后续主集成人必须把 DSH 工具桥接到同一治理入口并验收。
- 不包含报告模型可见性、多报告持久化、真实凭据检查、文件／命令／网络沙箱、外部副作用审批或预算。requiredPermissions 既有自动登记逻辑保留，未把 schema 完整性当授权证明。
- Schema 属可信 PM／服务端工具定义。参数受资源预算，但复杂正则、组合 schema 的计算成本没有线程硬隔离；新 schema 发布仍须受控审查与代表样本验证，不接受用户随意提交任意正则并宣称防 ReDoS。
- 不支持 draft-04／draft-06、自定义关键词、远程 schema 拉取与 async 验证；它们明确拒绝，不默默忽略。支持范围是已声明 dialect 下的同步 Ajv 标准校验，不是任意供应商扩展语义。
- 参数默认值不会补齐；若既有调用原来传 undefined 或依赖隐式宽松，需调用者按 schema 提交有效 JSON，不能为了兼容绕过校验。现有原 Registry／M1 回归通过，未深测所有业务 executor。

独立审查报告：`docs/refactor/evidence/T05-schema-review.md`，独立测试 `tests/regression/tool-schema-review-test.mjs`。首验联合17项中16 PASS／1 FAIL；修复后保留原独立反例复跑，独立+当前实现 **18/18 PASS**。PASS仅覆盖Registry JSON Schema与调用版本边界，不扩展到T05整包。

## 独立首验 P1：旧 executor 残留（FAIL → 修复待复验）

独立验收者发现有效同名 v2 定义未附 execute、等待后续 registerToolExecutor 时，旧 executor 映射仍存在，导致“v2 schema 校验→v1 executor 执行”。缺陷成立，首验 FAIL；属于 schema 与执行版本不一致，不能仅以输入校验通过接受。

修复：只有有效 schema 完成编译并注册后，带 execute 函数则替换；未带函数则删除旧 executor，不继承上一版本。坏 schema 在任何定义／executor 变更前拒绝，因此原定义与 executor 保持。已在途调用继续使用调用开始时捕获的旧定义／executor，这是明确的版本绑定，不是新调用继承旧 executor。

实施回归新增“v1→坏 schema 保持 v1→有效 v2 无 executor 不调用 v1→显式绑定 v2 executor→再次坏 schema 保持 v2”全链路，验证原／新 executor 次数。`node --test tests/regression/tool-schema-validator-test.mjs tests/regression/tool-registry-test.mjs tests/regression/m1-tool-wiring-test.mjs` 实际 **13／13 PASS**。独立复验保留红例并联合现实现 **18／18 PASS**；缺陷闭环为 **FAIL → 修复 → 独立PASS**。详情见`T05-schema-review.md`，T05全包仍未完成。
