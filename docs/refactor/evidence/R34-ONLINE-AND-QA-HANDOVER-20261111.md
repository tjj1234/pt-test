# R34正式环境发布回执与独立QA交接

状态：DEPLOYED_FOR_QA。2026-11-11 14:40东京时间启动本轮发布；用户终端回执通过，主程另行SSH读取服务及公网资源核对。代码集成、生产部署、同版本独立QA、真实供应商/计费验收分别登记，后两项尚未完成。

| 项目 | 绑定值 |
|---|---|
| 正式环境 | https://agent-fat.adorado.top；唯一正式环境 |
| 源码提交/分支 | 1586f765b53fde0a767ef13def3a47e56ca0c726 / integration/r34-final-all8-20261109 |
| 归档 | northstar-controlled-trial-20261111-r34-all8-1586f76-target.tar.gz |
| 归档SHA256 | cb36cdc5002bdc70a855fd30558893632c9442d847dd609534ea027efe94e4bf |
| 来源清单SHA256 | 8ee72b3d955eb79918409536380fe83c9b2eaf3e8a83cb9303e127aed9bb46c9 |
| 成员/输入 | 1095成员，953绑定输入；逐文件内容及mode校验 |
| 发布脚本SHA256 | a4a3ae240d3d28e1f39306667e00f85e43c5764c24f2b9df85dc73644ebd0858 |
| 依赖 | Linux x64，515包32753文件；锁SHA bc87a472976657df6268d9baee95ef77e5de94645965b2b2de6784cbeaeea623 |
| Release | /opt/northstar/releases/controlled-trial-20261111-r34-all8-1586f76-target |
| 服务 | northstar-shell；发布后PID494892，active，NRestarts0 |
| 备份 | /var/backups/northstar/r34-20261111T054024Z |
| 隔离验证库 | northstar_r34_verify_20261111054024；恢复361:30→迁移361:35；关闭普通连接 |
| 保留降级 | Bug-12=DEGRADED_PREVIEW |

## 实际发布证据

用户终端回执：旧版本机/公网基线、R34完整源码绑定、依赖闭包、真实原生媒体与隔离预检、northstar/postgres实际身份模块预检、备份隔离恢复、PROFILE_REBUILD、隔离迁移、隔离ACL与审核价格导入均PASS；正式库追加迁移361:35、实际运行身份ACL与价格导入PASS；源码1095再次校验后DEPLOYED_FOR_QA。五项迁移030–034均为本轮追加，旧迁移未改动。运行身份最小权限包括问答两表SELECT/INSERT/UPDATE，不含DELETE；其余按审核ACL契约逐表授权。价格快照已导入且运行身份选取通过，不代表历史unknown自动重算或估算等于官方credits实扣。

独立核验见[R34-INDEPENDENT-ONLINE-POSTCHECK-20261111.json](R34-INDEPENDENT-ONLINE-POSTCHECK-20261111.json)：实际service路径、健康PID、1095源码及mode、公网JS/CSS与安装内容绑定。公网app.js SHA256为58ab60dd7c687fb40d351ffaa4ba9357d47a522a9cba712edee38763bc5e3b4a。

首次发布失败与回滚保留：备份r34-20261111T051705Z，隔离库northstar_r34_verify_20261111051705，PROFILE_REBUILD前ERR_INVALID_PACKAGE_CONFIG，回滚R33后PID494147。实际northstar身份对照实验确认cwd为用户暂存目录失败、cwd=/成功。修正版固定工作目录并前置实际身份校验，本轮已通过，不重复执行发布脚本。首次回滚只恢复unit/profile，未执行数据库倒灌；本轮成功后的数据库回滚未演练。

## 可直接转发测试工程师

请开始唯一正式环境R34同版本独立黑盒验收，版本绑定以上commit/归档SHA/清单及迁移。先核对版本，避免沿用R33页面缓存；按原总台账逐项测试，保留原FAIL/BLOCKED/UNTESTED与历史Run证据，新证据另记。不得因上线回执或作者自测自动勾选。请覆盖真实点击、上传、下载、刷新、重开与跨账号隔离，并输出Run ID、时间、模型/配置、脱敏网络响应与产物指纹；遵循既有付费测试授权和预算，勿在报告中记录凭证。

| 包/修复 | 重点验收及结果边界 |
|---|---|
| 01音视频 | 实际音频转写/视频采样帧与原生附件理解、取消/限额/历史；区分本地处理与真实模型理解 |
| 02文档输入 | DOCX/XLSX/PPTX、文字/扫描PDF、DOC/XLS/PPT、ZIP实际上传→解析→对话→来源定位；非法/超限/加密/宏/嵌套ZIP拒绝，来源原文及成员SHA；旧格式不声称无损版式或原页码 |
| 03文档输出 | Word/中文PDF/Excel真实工具触发、下载可打开、中文/表格及公式字面量、刷新后产物恢复、其他账号无法下载 |
| 04可信联网 | 原生搜索/抓取→可核验来源→历史恢复；超时/取消/字节限额/不可信地址拒绝；搜索上游无结果单独记录，不捏造引用 |
| 05澄清/审批 | M1单选/多选/自定义答复→同Run续流；取消/过期/刷新重开；精确审批的批准/拒绝/一次消费/过期与身份隔离；复测R33 TOOL_REQUEST_FAILED与预算耗尽问题，保留新旧Run对照 |
| 06受限分析 | 原生只读文件/目录与经精确审批的Python分析；结果、资源上限、取消/超时、拒绝后不执行；内核只读与网络阻断证据独立于真实模型业务验收 |
| 07计费 | 官方实扣按同账号/时间范围/credits与账单核对；本地估算按已审核价格/实际tokens/工作日时段规则独立复算并显式标估算；未知缓存维度/未审核模型保持unknown，USD与credits不推断汇率 |
| 08 AUTO | 配置资格/版本pin、调用前候备选择及提交预留；已提交后结果/费用未知不得自动换模型重提；零费用声明必须有对应真实账单证据，静态筛选不替代计费失败闭环 |
| Bug3/R33整改 | 中断现场文字及刷新后落库、错误/超时/进程关闭边界、真实价格快照及列宽/窄屏横向滚动、资料面板关闭；不可变firstConnected及历史回归 |
| Bug-12 | 严格维持DEGRADED_PREVIEW，不标完整通过 |

交付修订后的R34独立报告与MASTER_PRODUCT_FEATURE_AND_TEST_SPEC.md，分别列出已通过、失败、阻塞、未测及所需真实供应商/费用证据。新缺陷绑定R34同一指纹，不将本次上线等同全部业务完成。
