# R34主程QA修复：问答参数修复与表格列宽

状态：LOCAL_FIX_VERIFIED，等待全量候选整合与同版独立QA；不把本地合成复现当作已确认线上Run根因。用户要求R34全部八包+Bug+QA统一发布仍有效，本次不冻结/部署局部版本。

## 问答：真实本地复现、修复与硬边界

tests/probes/r33-question-budget-characterization-20261109.mjs在实际server、原生SDK、生产Run仓库和PGlite上复现：合法单次问答2模型请求完成；首次question为空但已扣工具预算，第二次合法工具调用因RUN_TOOL_CALL_LIMIT失败，0问题卡；两个有效工具调用也会耗尽工具预算。这与QA“2次模型响应、无卡、工具预算耗尽”的外观相符，但还需失败RunID/实际首次工具参数与返回错误才能确认同因。

修复不扩大run-budget-questions.json常量：模型总上限仍3（含上下文）、工具上限仍1（一次可批量1–8问题）、单工具key上限1、时间/输出限制不变。新增副作用为零的内部northstar.user_question_validate预检，复用生产service同一prepareQuestions/validateQuestionInput，而不是复制一套规则；只有参数有效才扣真正的提问工具额度。预检有32KB/8问题限额、复用可信native call上下文和宿主问题模式门禁，不创建问题、不等待用户、不授予审批/执行能力。

questions模式可借用未实际消耗的上下文预留名额用于一次参数纠正后的最终回答；所有模型请求仍逐一过原预算admit与08持久栅栏，最多3次总请求。其它profile仍保留原上下文预留策略。若上下文已经使用额度，总量硬上限照常拒绝；没有供应商重试或无界修复循环。预检closure按persistent runner上下文隔离，warm-agent取消/替换后仍拒绝迟到结果。

最终实际HTTP/SDK验证：valid-one完成/2请求；empty-question-then-valid完成/3请求且恰好1已答问题；two-tool-calls仍失败于工具硬上限/2请求；always-invalid无问题卡且3请求后失败于模型硬上限。questions-budget-repair-http-sdk-test.mjs、原问答HTTP与生产问题仓库共16测试单元通过；最终问答修复+原生工具/推理6测试单元通过；用量/Run恢复/推理/Skill受影响回归28测试单元通过。原表征测试故意断言旧行为，在首次修复后出现1个预期断言失败，该日志保留；新的修复回归用明确成功/失败预期，不篡改旧复现。

线上“查看提问记录无法读取”的实际HTTP错误仍需QA抓包；本地零问题场景GET正常200，不能未经证据将其与预算问题合并结项。R33_FULL_INDEPENDENT_QA_ACCEPTANCE_REPORT.md整体REJECTED保持，R34尚未上线。

## 列宽：修改生产bizTable并真实Chrome测量

短字段不再overflow-wrap:anywhere：时间、类型、工具、模型、耗时、状态保持nowrap和最小72px；输入/输出摘要、文件/详情仍可折行。滚动限制在table host，避免把整个页面撑宽。复用原表格渲染器，不改业务数据或费用口径。此项未收到作者独立patch，主程在共享UI接缝最小修复，不声称已合入未知补丁。

本机Chrome执行实际生产bizTable，桌面1280/窄屏375两种viewport；短列实际宽度约171/89/144/144/72/97px，Skill/get_current_time/模型名均一行，host宽900或343、表格scrollWidth1039，页面无横向溢出。截图已人工查看，见R34-USAGE-TABLE-1280/375-20261109.png。这是隔离DOM布局验证，不冒充正式环境页面E2E。

## 价格治理：已拿到真实公开证据，不能直接导入旧常量

已匿名实时抓取PT公开模型页并记录正文SHA与采集时刻，见PT-PRICE-PUBLIC-OBSERVATIONS-20261109.json，不使用搜索缓存价、不读取QA scratch凭据。发现deepseek-v4-pro公开页有工作日09–12/14–18（UTC+8）2倍计价条款；两个模型的缓存创建栏均为“--”，不能臆填0。现有快照选择器要求四个明确费率且固定/pricing来源，目前不能原样承载这些条件；不能为让unknown消失而削弱审核或伪造生效时间/缓存维度。下一步需冻结条件价格与缺失维度的证据语义/最小补充，再经F3导入治理；不以本次观察文件当可导入生产快照。

[官方模型页](https://powertokens.ai/models/deepseek-v4-pro)、[GLM模型页](https://powertokens.ai/models/glm-4.7)为当前价格观察来源；观察不是已完成逐笔实扣对账，不能用USD估算强行等同credits金额或回填历史QA调用。
