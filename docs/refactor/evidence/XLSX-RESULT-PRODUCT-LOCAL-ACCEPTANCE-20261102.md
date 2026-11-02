# CSV分析→Excel产物｜本地同版验收关闭
结论：LOCAL_CHAIN_CLOSED，仅关闭“已有CSV分析工具按显式outputFormat=xlsx生成、下载及重开结果”的产品链。主Agent批准该接线；不是任意结构化文档生成、中文PDF、统一产物版本管理或完整重构交付。

复用原生csv_analyze、既有CSV源SHA/用户列选择、精确分析器、安全目录句柄发布、owned产物下载、历史产物面板和Word已有的有界导出worker。工具新增可选csv/xlsx格式，默认CSV不变；不加模型调用/工具预算、不改依赖或锁定DSH。XLSX由宿主worker生成，模型不能指定磁盘路径或外部URL。正常分析Run仍2 model/1 tool/0 retries；这是次数限制，不是金额上限。

## 主审修复与边界
原候选保留在保险提交dae46d5。新增portable-xlsx-main-review-test.mjs首先复现3类失败，输出保留xlsx-main-review-before-20261102.txt；修正后原4项加主审3项通过。去掉cwd/NODE_PATH/sibling目录依赖回退，只使用shell安装路径的fflate；合法隔离探针显式提供锁定依赖布局，缺依赖必须拒绝。非法/非有限/未知limits明确拒绝，增加4MiB聚合文本上限；sheet名与cell均校验XML字符及孤立surrogate，不猜数字或日期；潜在公式字符串以inlineStr和已记录转义处理，不生成公式/宏/外链。

产品边界进一步收紧：CSV结果正文2MiB、5000行/100列/50000格，导出产物5MiB；Word与XLSX共用2个worker名额、每worker128MiB old heap、默认10秒且最多15秒、退出后才释放名额。取消在生成前/线程执行中/发布前受控；产物用租户与Run目录、随机名和安全目录fd原子发布。下载需要登录及所属租户，XLSX用正确MIME并强制attachment，不在iframe解释。原生/宿主工具权限与源选择校验继续生效。

联合测试发现宿主artifact事件中的SHA在通用文件扫描后丢失；现将已持久化的宿主artifact元数据合并到历史，并保留SHA，不能用扫描结果覆盖可信摘要。失败证据xlsx-http-integrity-before-20261102.txt保留（两份修复前日志仅规范化行尾空白，失败内容不删改）；修后CSV与XLSX都逐字节核对事件/历史/下载SHA。

| 验证层 | 最终结果 |
|---|---|
| 候选与主审/worker/兼容边界 | unit-review命令14/14；另产物UI脚本64/64，不能与Node用例数混加 |
| 原候选合法布局与格式反读 | 独立probe exit0，中文/多sheet/原始类型/无公式与限额通过 |
| 同版HTTP→原生SDK | CSV、XLSX、Office/Word三条联合用例3/3；XLSX summary行A2:I2逐单元格精确反读，来源SHA/操作/范围/结果相符、formula=false |
| 真实浏览器 | 已生成Run的历史打开显示Excel下载；实际浏览器下载为.xlsx，reload后入口仍存在，见xlsx-browser-20261102.png |
| 访问隔离 | 同owner下载200、匿名401、其他用户404，重开产物字节相同 |
| 既有推理链兼容 | 当前共享源码重新执行reasoning --browser，三个命令均exit0，源码绑定验证通过 |

复跑：`node scripts/northstar-chain-checks.mjs --chain xlsx --browser`。报告xlsx-chain-checks-20261102.json绑定25个源码/测试文件，完整日志*-unit-review/probe/http-sdk.txt；`--verify-report`检查当前源码是否仍对应同一证据。机械报告本身只标MAIN_AGENT_REQUIRED；此文是主Agent接入判断。

真实付费providerCalls=0；原生SDK的模型为本机受控适配器。未部署、未做目标机/最终干净Linux归档验收、未声称当前源码等于旧r19，最终发布须重新冻结。任意模型主动DOCX/PDF/多sheet结构化文档工具仍未关闭；此链不缩减原始交付范围。
