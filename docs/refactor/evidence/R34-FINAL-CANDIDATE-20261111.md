# R34完整候选：冻结与发布准备（2026-11-11）

状态：R34已于2026-11-11正式部署，DEPLOYED_FOR_QA；服务PID494892、active、NRestarts0。第二次发布与独立线上核验通过；首次失败及R33回滚记录保留在下方。独立QA与真实供应商/计费验收待做，详见[R34上线与QA交接](R34-ONLINE-AND-QA-HANDOVER-20261111.md)。

| 指纹 | 值 |
|---|---|
| 运行源码提交 | 1586f765b53fde0a767ef13def3a47e56ca0c726 |
| 代码分支 | integration/r34-final-all8-20261109 |
| 最终归档 | northstar-controlled-trial-20261111-r34-all8-1586f76-target.tar.gz |
| 归档SHA256 | cb36cdc5002bdc70a855fd30558893632c9442d847dd609534ea027efe94e4bf |
| 最终清单SHA256 | 8ee72b3d955eb79918409536380fe83c9b2eaf3e8a83cb9303e127aed9bb46c9 |
| 归档成员/绑定输入 | 1095 / 953；逐文件内容及mode绑定 |
| 依赖闭包 | Linux x64，515包、32753文件；目标Node24.22.0严格匹配 |
| 锁文件SHA256 | bc87a472976657df6268d9baee95ef77e5de94645965b2b2de6784cbeaeea623 |
| 迁移新增 | 030请求预留、031文档格式、032联网来源、033计费凭证、034操作审批 |
| 唯一正式服务 | northstar-shell，agent-fat.adorado.top |
| 发布前版本 | R33；首次尝试前PID367662，回滚后独立核对PID494147、NRestarts0 |
| 部署脚本SHA256 | a4a3ae240d3d28e1f39306667e00f85e43c5764c24f2b9df85dc73644ebd0858 |

01音视频真实本地转写/采样帧及原生DSH附件；02现代Office、PDF逐页/OCR、旧DOC/XLS/PPT与ZIP有界解析及引用；03原生工具→Word/中文PDF/Excel产物、owned下载与历史；04原生ctx.web/provider、可信transport及来源；05普通澄清与精确持久审批；06原生fs/subprocess结合内核只读Python、无网络/资源/取消边界；07按用户独立凭证读取协议账单与双轨估算；08调用前配置资格、版本pin及持久提交预留均在本候选。第三批流式中断/历史、单价、列宽及不可变firstConnected等修复已纳入。Bug-12继续DEGRADED_PREVIEW。

证据按层次分别登记：作者报告不等于主程集成，固定模型fixture不是真实供应商；本候选同版本独立QA、真实模型与账单关联仍待发布后验收。未推断USD/credits汇率；未知缓存维度/未审核模型继续unknown。08仅在首次dispatch前选候备，提交后结果或费用未知绝不自动切模型重提。复杂旧格式不承诺无损版式/公式/原页码，ZIP不允许嵌套通用压缩包或执行内容。

本地冻结与服务器组装产物SHA完全相同；为节省传输复用已审核原生资源，仅传77个变化成员478875字节，仍对1095个最终成员逐一校验，未采用不明本机文件或修改历史归档。全量运行资源与对应许可证/源码来源随包。后台费用调用为零。

正式切换脚本先确认旧版/在途任务、备份与隔离恢复，再对恢复库执行五项迁移、最小ACL及实际运行身份价格选取；均通过才修改正式库并切换unit/profile，随后核验PID、健康、公网资源及完整成员。失败保留新目录与备份、恢复R33 unit/profile；隔离库限制连接。只读诊断不证明历史RPC失败完整因果链。

最终目标预检：1095成员、全部归档路径及依赖闭包匹配；真实语音、中文OCR、视频抽帧与内核隔离通过。首次发布曾停止服务并执行隔离备份恢复，随后自动恢复R33；未到迁移与正式切换步骤。部署后独立QA需使用本说明指纹，记录实际备份/隔离库/新PID及公网指纹；不得把本说明预检状态当上线回执。

2026-11-11首次发布失败记录：备份 `/var/backups/northstar/r34-20261111T051705Z`；恢复库 `northstar_r34_verify_20261111051705`，计数361:30。归档、1095源码成员、依赖闭包、原生媒体/内核预检、备份恢复均通过；输出未到PROFILE_REBUILD_PASS。退出码1，R33_ROLLBACK_HEALTH_AND_SOURCE_PASS；独立SSH核对R33 active、PID494147、NRestarts0。生产数据库迁移/ACL/价格导入尚未执行。服务器独立临时目录中R33配置生成→R34重建→重新校验通过；生产私有日志需sudo只读脱敏诊断，不按推测修正或重跑。

只读诊断回执：配置日志含ERR_INVALID_PACKAGE_CONFIG；PT_RUNTIME_DIR匹配预期。目录元数据未见符号链接；runtime/dsh-home为运行身份所有且0700。准备的脚本修订固定工作目录为/，并把实际northstar/postgres身份的Node stdin模块加载校验前置到停机前，ERR仅输出行号。该修订尚待同身份工作目录对照实验确认，尚未再次部署；原失败脚本SHA为dccd35572c2998d4b02359045b4a1deb5853fb15161ff533c2705ee51956c9b2。

根因确认（用户回传第二版只读实验）：同一northstar身份、同一R34模块，cwd为用户暂存目录时exit1/ERR_INVALID_PACKAGE_CONFIG，cwd为/时exit0/MODULE_LOAD_PASS。运行目录变量正确。本次失败为发布命令继承工作目录导致的Node加载错误；修订固定cwd=/并在停机前分别以northstar与postgres执行同形式模块加载预检。修订脚本SHA256=a4a3ae240d3d28e1f39306667e00f85e43c5764c24f2b9df85dc73644ebd0858；归档/源码/迁移范围不变，尚待重新执行正式发布。
