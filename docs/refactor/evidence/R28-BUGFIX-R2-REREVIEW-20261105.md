# r28 Bug修复R2主审：5项旧反例通过，写端安全根仍阻断
结论：NEEDS_REVISION / MERGE_AND_RELEASE_BLOCKED。候选1e677a3ccae540e500830edfa6c5b7240749a87e；作者R2报告已查阅。流式错误占位内容保留的已列最小反例通过，HTML旧文件/叶子链接/tenant自身链接也通过，但祖先与替换安全仍未实现，属于上次明确要求的同一边界，非新增需求。

| 核对项 | 本轮结果 |
|---|---|
| Git与补丁 | candidate/r28-bugfix-full为1e677a3；相对da4fe91仅server.cjs/app.js两文件。相对d37c7f4累计git diff与交付累计patch逐字cmp一致 |
| 原主审探针 | 3/3 PASS，R28-BUGFIX-R2-MAIN-REVIEW-20261105.json |
| 原扩展探针 | 2/2 PASS，R28-BUGFIX-R2-EDGE-REVIEW-20261105.json |
| 作者四批回归 | 13/13 PASS；含静态/简化逻辑检查，不能代表20项真实产品E2E |
| 真实PGlite仓储 | 1/1 PASS，显式PT_PGLITE_PATH；本地测试出现内部鉴权Key未配告警，不代表生产配置已确认 |
| 原安全根/竞态边界扩展 | 0/2 PASS：R2-PARENT-OF-TENANT-LINK、R2-DIRECTORY-FD-NOT-USED；见R28-BUGFIX-R2-ROOT-REVIEW-20261105.json与对应主审探针 |

## 唯一当前确认代码阻断：dirFd未参与文件创建
server.cjs约1394行后虽lstat并以O_DIRECTORY/O_NOFOLLOW打开tenantWs为dirFd，但随后fs.openSync(htmlAbs, ...)仍使用字符串完整路径。O_NOFOLLOW只约束该次打开的末端，不排除更上层目录链接；打开目录句柄也不会锁定它的原路径或阻止重命名。
实证一：tenantWs本身是真目录，但其父目录是指向合成外部目录的链接，成功在外部创建report.html。实证二：在目录open成功后确定性替换其原路径为外部目录链接，后续文件open跟随替换路径写出根。第二项使用代理在真实open返回后执行真实rename/symlink，稳定模拟检查与使用之间的替换，不依靠概率竞态。两项均执行归档实际源代码块，fixture仅合成临时文件，非远程可利用性或生产事故证明。

## 最小后续交付与责任
只修HTML物化写端：复用可信安全文件发布能力，以可信根与安全句柄实际约束创建/发布；无法在支持平台保证时关闭此自动物化路径并给出明确不可用原因，不能仅再加一次realpath/lstat后继续按旧完整路径open。关闭方案会暂缺自动预览，须显式记录降级，不能称对应Bug完整修复。补安全祖先、目录替换、并发冲突、失败清理、发布完整性；这均已列于R1主审要求。无需修改其他包或重复重做已通过的流式最小修复。
主程也承担此前最小fixture覆盖不足的责任；不以连续新增单个fixture取代安全根方案审核。作者先说明实际采用的安全创建/发布机制和平台支持限制，主程核实后实施，避免再次只补一个链接判断。
流式侧当前实现使用最后user后assistant的文本包含检查，两处已同步；本轮通过最小反例，不等于已完成Run绑定、换会话/刷新/部分保存与真实浏览器恢复验收。初审/R1报告中共享行为与环境配置证据仍待同版本独立QA，文档说明不自动关闭这些项。此次未新增确认的流式代码阻断。

## 复测来源与未做动作
旧/private/tmp/pt-fix-batch4目录已不存在，未清理worktree注册。使用git archive固定1e677a3提取至/private/tmp/r28-review-20261105；原主审探针仅在临时副本调整来源路径和Git工作树检查，语义断言未改，明确归档来源。原边界探针临时副本改路径和新报告文件名，未覆盖作者历史JSON或原探针。新增探针：tests/probes/r28-bugfix-r2-root-review-20261105.mjs。
未修改候选或共享实现、未恢复/重置他人worktree、未合并/部署/调用PT或访问真实用户数据。主线仍bbd9997。
