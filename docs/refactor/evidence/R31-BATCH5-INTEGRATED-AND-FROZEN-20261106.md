# R31 batch5：正式集成与冻结，待目标预检
状态：**INTEGRATED_AND_FROZEN / READY_FOR_TARGET_PREFLIGHT**。集成分支integration/r31-batch5-20261106，运行源码提交 **fd1f11ef120082068a0d0b83819883c35285ee07**，基线ab8107182a0d29d78c674ff64f69ae68319e603b。作者d3325a4/e208343的累计差异以已审查补丁纳入，再加主程精确错误码修正；未将作者旧基线整支覆盖R30。源码提交不是merge commit，不虚报作者tip为父提交。
修复仅覆盖：2.4失效Skill保留引用、明确提示并由用户移除/重选；2.6 Usage所选时间范围高亮；2.8无会话时禁止对话范围写入且不静默改用户范围。仅明确SKILL_NOT_AVAILABLE可标技能失效，普通包含“技能”的错误不会误标。原R4推理拒绝后同会话恢复、模型标签保持；Bug-12仍DEGRADED_PREVIEW。其他第二批问题与Gemini01–08未随包纳入。

## 冻结指纹
| 对象 | 值 |
|---|---|
| 工作树 | /private/tmp/pt-r31-batch5-20261106 |
| 归档 | northstar-controlled-trial-20261106-candidate-34-r31-batch5-draft.tar.gz |
| 归档SHA256 | 6addd5e342b9696f4d37ddc30bc60412b6f8ab5b735161b2e07fe38df4818955 |
| 绑定源码/归档成员 | 217 / 419 |
| app.js SHA256 | 518d4b7e121bf2666a44366cba233c584d25b34f47b53e66c6bdf082acac3095 |
| styles.css SHA256 | 4854a660de0ff59a0fd57b3575b4f5f15998e04744bfd8b9bc26994586323e56 |
| server.cjs SHA256 | c3da979a5ee0bd103ab003d6b336e8870f0fb43a30ba6503573acd34fdc5d094 |
| 构建与审计 | scripts/package-northstar-candidate34-r31-draft.py、audit-northstar-candidate34-r31-draft.py |

与已冻结R30的217份源码逐一比较：只改以上三个文件，无新增/删除绑定源码；依赖锁、DSH settings、迁移、Runner及模型模块完全一致。旧归档与旧构建器未改；只在专属分支把current-draft指向新R31。

## 验证与证据层
| 检查 | 结果 | 证据 |
|---|---|---|
| 锁定依赖安装 | shell npm ci、analytics npm ci成功 | 独立树真实安装，未用node_modules链接；锁未改 |
| 全文件语法 | 646 JS文件，0失败 | R31-BATCH5-SYNTAX-20261106.txt |
| 完整默认回归 | 共268套件；首次267 PASS/1环境FAIL；修复环境后该套件10/10 PASS，全部268已取得通过结果 | R31-BATCH5-FULL-REGRESSION-20261106.txt、R31-BATCH5-DOCEXPORT-ENV-RERUN-20261106.txt；没有宣称一次运行268/268 |
| 环境失败原因 | docexport-candidate-test缺analytics/node_modules/xlsx；按analytics原锁npm ci后通过 | 未修改源码或测试断言，不归责产品实现 |
| 本地浏览器 | 7/7、pageErrors=0；真实Chrome点击，精确源码hash绑定 | BATCH5-E208343-BROWSER-LEAD-R31-INTEGRATED-20261106.json及R31-BATCH5-BROWSER-20261106.png；API为本地fixture，不是staging E2E |
| R4与相关回归 | batch1–5、原生reasoning恢复、模型UI通过；UI内部57/57 | 同版源码执行；包含在完整默认回归中 |
| 确切归档Linux | linux/x64、Node22.23.4；干净安装后25/25、UI57/57、原生SDK/owned Skill HTTP通过 | R31-BATCH5-EXACT-LINUX-20261106.txt；脚本先校验确切归档SHA |
| 严格生产依赖闭包 | 495包 / 31,007文件与冻结清单匹配 | Linux同一日志；Arborist8.0.5、umask022；没有放宽门禁 |
| builder --check与独立audit | 可重复构建、源码绑定、路径/导入/闭包输入PASS | 新归档状态仍DRAFT_NOT_FOR_DEPLOYMENT，不把审计当部署授权 |

未因前端修复重复运行外部PostgreSQL专属4套件；迁移/仓储实现未改，PGlite与owned API相关套件已覆盖，不能声称新增PG多连接实证。无供应商/付费请求或生产数据操作。

## 线上与下一步
本轮尚未上传、切换服务或修改服务器；服务器WorkingDirectory/源码/在途Run必须下一步实时核对，历史R30部署证据不能代替。现有/private/tmp/pt-ops-20261105.sock不存在，已请求用户在本机恢复原SSH master；没有索取/保存密码，不改sudoers。
连接恢复后先只读核对当前服务/release/健康/旧资源路径与源码，确认唯一目标仍agent-fat。新release单独安装并在目标核验闭包与217源码；切换前重新备份、实际隔离恢复PG，保留旧release及全部历史。root操作只用经审核SHA绑定脚本和用户安全sudo交互，不盲重跑R30脚本。切换后再核对PID/目录/本地及公网/assets/app.js指纹，随后独立QA；未满足这些步骤不能称上线或业务验收完成。
同版QA入口：R31-BATCH5-QA-REQUEST-20261106.md。测试工程师的既有R30结果不能自动覆盖R31；原20Bug状态、第二批8项及本包三项分别记录。

主工作区仍feature/northstar-integration-20261102 / bbd9997，原28个已跟踪脏文件保留；作者batch5与Gemini d78d5c9工作树未改。临时Linux容器pt-r31-exact-20261106已随成功退出自动移除；未清理其他容器或关闭用户SSH。具体保存提交/远端状态以Git回读为准，不能从本文提前推断推送成功。
