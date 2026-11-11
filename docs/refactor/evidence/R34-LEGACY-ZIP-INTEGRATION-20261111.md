# R34 02包：旧Office与ZIP补齐

原范围核对发现此前候选仍拒绝旧Office/ZIP，因此a3f39f5不作为完整R34发布；服务器旧部署脚本已停用保留，线上仍为R33。

复用：DSH原生subprocess、既有Landlock+seccomp/CPU/内存/墙钟监督、Debian catdoc 0.95-6全部九项补丁、现有fflate、Office/PDF/OCR worker及资料检索，不使用另一程序员C02的Docling成果。固定CLI仅输出有界文本；宿主预备只读输入和已校验程序/字符映射，不提供模型任意命令。

格式矩阵：OLE Word97–2003 DOC、BIFF XLS、二进制PPT为文字/值抽取；不承诺版式、公式、合并单元格与原始页码，XLS坐标标记为导出表格坐标。宏、嵌入活跃内容、已识别加密、坏文件和格式不符明确拒绝。ZIP仅支持16个文档成员、64个总条目、单成员10MB、合计展开20MB，拒绝嵌套通用ZIP、执行内容、软链、穿越、重复、CRC异常；不向文件系统解包。引用同时绑定原ZIP SHA、成员SHA及真实内层定位。

验证：Apache POI公开fixture三种旧格式真实服务器抽取通过；三种宏和两种加密拒绝、坏文件/错格式、真实spawn后取消及join、ZIP中旧文件来源共八组通过。ZIP七组边界、本地解析/定位24项通过（扫描OCR一项本机跳过，服务器另行真实通过）；Office/PDF+ZIP HTTP/DSH与来源撤销三项本机通过。最终服务器HTTP/真实DSH SDK联测已通过：三种旧Office及ZIP上传→真实抽取→模型请求→Run持久化→来源检索与跨用户拒绝；包括ZIP内PDF真实页码。该联测使用固定无付费模型适配器，不代替真实供应商与独立QA。

运行资源：原始源码SHA 0d6ef66ff18d93915e62d77845194ba92bf49b60305c51f866a6f55421e37a79；Debian补丁SHA 943ec46b792d576c469212a75e4d702c672b664558176440f76ccbc03510dc70。GPL许可证、对应原始源码/补丁随运行资源归档，主仓库保留守卫源码与构建命令。

运维：目标机共享/tmp存在用户配额及大批历史验证缓存；已将确认全为主程所有且无进程引用的旧验证缓存原样移到/home/tongjiawan/pt-r34-preserved-tmp-20261111保存，不删除、不改线上。正式R34使用/var/lib/northstar/runtime内northstar私有磁盘临时目录；生产R33始终PID367662、NRestarts0。
