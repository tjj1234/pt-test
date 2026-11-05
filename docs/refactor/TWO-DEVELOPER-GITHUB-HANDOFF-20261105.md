# 两位程序员跨电脑开发交接与GitHub规则
2026-11-05｜状态：领取准备；A/B为角色占位，人员账号与实际能力待登记。范围暂按现有35包减Gemini原01–08，即09–35共27包；用户提到28包，额外1包未确认，不自行新增。09/10仅规格样本获批，仍有实现工作。

## 适用范围与责任边界
本文的个人账号、独立开发分支、推送和PR规则，仅适用于分给两位新程序员的任务包。Gemini原01–08正在由Codex审核，r28 Bug修复也由Codex接收复审；这些线的合并、推送与接线由Codex负责，不要求两位新程序员接手、维护分支或重复修复。GitHub已保存的fix/auto-08-r1-r6、fix/questions-isolation-20261104、candidate/r28-bugfix-full仅为主程留存候选，不是新程序员领取入口，也不代表通过审核。

## 仓库与可用基线
共同使用https://github.com/tjj1234/pt-test。协作准备分支为handoff/two-developers-20261105；其代码基线为bbd9997，附当前任务规格、候选和审核证据，**不是所有修复已经合并的可发布版本**。main不是本轮开发基线。两人分别使用自己的GitHub账号、SSH或个人凭据，由管理员授予必要仓库访问权；不共享主账号/Token/生产权限。账号未提供前A/B分支只是命名占位，不代表GitHub权限已设置。
必读顺序：[入门](DEVELOPER-ONBOARDING.md)→[研发测试发布流程](ENGINEERING-DELIVERY-WORKFLOW.md)→[总台账](REFACTOR-MASTER-TRACKER-20261103.md)→[路线图](PRODUCT-ROADMAP-AND-RESOURCES-20261103.md)→所属任务包及[规格索引](PACKAGE-SPEC-INDEX-20261104.md)。包内已有UI/契约/验收内容不在本文复制；遇历史状态冲突，以最新主审证据和总台账为准，不凭日期猜测，向主程登记冲突。

## 建议分工与领取顺序（待人员能力确认，不等于全部开工）
| 主责 | 包号 | 工作关联及首轮建议 |
|---|---|---|
| A，产品交互与工作空间 | 09、10、12、19、20、21、22、23、24、28、29、30，共12包 | 首轮19工作空间M0；12可先核实原生；随后20/21/29交互契约，再09/22/23/24/30；28需ACL，10受PT协议与媒体能力阻断，先规格/接口核实 |
| B，运行可靠性与集成基础 | 11、13、15、17、25、26、27、31、32、35，共10包 | 首轮17目录与AUTO接缝M0，31契约可并行设计；13/15作为可靠性基础；26/27后接调度，25先单系统只读，32先L1，35按最小切片 |
| 主程负责，A/B按明确子项协助 | 14、16、18、33、34，共5包 | 验收、CI性能、运维恢复、资源、PT核实；不能把采购、供应商确认、生产部署和最终验收全部丢给开发者 |
A/B工作量按复杂度持续调整，包数不等于工时。每人同时只推进一个实现包，可提前设计下一包。05/06与08、r28 Bug仍由原作者/主程处理，不计入两人新包。前置包未接入时可做候选与标记替身的接口测试，不伪称真实联调通过。

## 分支、推送与共享文件所有权
不采用每人一条无限累积所有包的长分支。每包从主程指定的已审核基线创建dev/a/pNN-topic或dev/b/pNN-topic，M0和实现PR可分阶段；同包修订继续原分支，避免重复PR。handoff仅初始领取快照，后续基线由主程更新，禁止自行把其他未审候选合入。
```bash
git clone https://github.com/tjj1234/pt-test.git
cd pt-test
git fetch origin
git switch -c dev/a/p19-workspace origin/handoff/two-developers-20261105
# 只提交本包已登记文件；B使用dev/b/p17-catalog等对应分支
git add path/to/owned-file
git diff --cached --stat
git commit -m "feat(p19): describe bounded change"
git push -u origin dev/a/p19-workspace
```
PR目标先为handoff/two-developers-20261105，作为本轮审核队列；**不自动合并该准备分支进生产集成分支**。主程负责逐项审阅、选择性接入和受影响验证。禁止直接推main、集成、handoff或他人分支；禁止force push、删除远端分支、push --all/--mirror/--tags、全量git add、顺手升级锁依赖、迁移改号或提交secrets。不同分支不能防止共享文件合并冲突，必须登记具体路径。
允许范围先由每包M0列精确文件清单，建议候选在shell/candidates/pNN-<topic>/、本包探针tests/probes/pNN-<topic>-*.mjs、材料docs/refactor/deliveries/pNN/。仓库已有同职责目录优先复用，不为隔离而造平行引擎。server.cjs、persistent-runner.mjs、runtime/dsh-adapter.cjs、public/app.js/styles.css/index.html、鉴权、DB迁移、依赖锁/profile/CI等共享位置由主程协调；作者需要这些改动时交明确补丁/独立组件，主程批准所有权后才改。tests/e2e当前属既有测试线，不自行占用。总台账由主程更新，开发者交本包状态而非各改一份总表。
建议仓库管理员在main、feature/northstar-integration-20261102、handoff分支设置PR审核、禁止强推与删除；要求实际启用并成功的CI检查。**本文是协作约定，不等于GitHub服务端保护已配置**；普通Write权限本身不限制只能推自己的前缀，需规则集/分支保护实际约束。A/B无需管理员权限，规则与权限由主程/管理员统一核实。

## 每台电脑首次提交内容
按入门文档独立安装锁定依赖和本地runtime/DB/master key/DSH_HOME，提交OS/Node/npm、base SHA、安装/语法/隔离fixture结果及BLOCKED清单。不复制主程的node_modules、真实DB、Cookie、浏览器登录态、生产env或个人~/.dsh。DSH锁定tgz在shell/vendor已跟踪，安装失败先报告，不擅自升级。某些历史探针硬编码/private/tmp或/Users/mmdn路径，必须参数化本包新测试或在报告说明，路径不存在不代表产品失败。
每包先提交M0：真实原生能力/运行装配/宿主缺口、完整数据与状态契约、用户分支或后端失败恢复、精确所有权、依赖与待决策、完整AC测试映射。主程确认再实施，不能用任务包中的“建议/待拍板”当已定产品决定。用户旅程三件套与Mermaid真实渲染按既有流程执行；纯后端不套UI模板。
自测交付须绑定base/tip、文件SHA、真实命令/退出码、完整AC的PASS/FAIL/BLOCKED、合成fixture/清理、回退与配置影响；不使用样本值特判，不复制实现作测试，不把静态检查和模拟接口算真实产品验收。主程负责独立审、接线，独立QA负责同版本staging；两人不自行上线或真实付费试错。

## 当前阻断与不能误用的候选
05/06：fb250a9未通过主审，M0材料也尚待澄清；参见统一修订任务书及20261105 M0主审。08：0c8841c需要主程假值补丁后仅选择器层通过，真实attempt/PT零费用拒绝语义未确认，不自动切换。r28 Bug：1e677a3原5反例通过但写端祖先/替换仍阻断，不把修复分支当发布基线。旧临时worktree目录消失，Git对象和远端保存ref才是跨电脑来源。
PT报错受理/费用不明一律不自动重试/换候选；取消不代表上游停费或副作用回滚。staging资源与身份未完整核定时记BLOCKED，开发可继续安全候选，不使用真实用户库验收。
