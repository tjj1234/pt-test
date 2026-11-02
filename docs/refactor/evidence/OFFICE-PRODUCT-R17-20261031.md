# r17办公文档产品增量与回归收口
结论：新增XLSX/PPTX受限输入、对话Word导出，均已接产品入口并形成同版离线Agent链；普通默认回归与真实PostgreSQL通过。仍不是周一完整重构包，不代表真实PT、目标机或全部Office格式验收。

| 新增能力 | 产品链 | 支持与边界 |
|---|---|---|
| XLSX资料输入 | 上传按钮/拖拽→受限worker→Run附件快照→原生DSH正文 | 保留原始sheet/cell、shared/inline字符串、原始数值与公式文本/缓存；不求值、不猜日期、不解释样式/图表 |
| PPTX资料输入 | 同入口→受限worker→原生DSH正文 | 依presentation关系顺序及原始slide/paragraph定位；不解释图片、图表、备注、音视频、动画 |
| 对话Word导出 | 对话菜单“导出Word”→owned导出API→worker→下载 | 中文/空格/公式样文本/XML转义保留；原历史不变，可重开原对话再次导出；附件不嵌入，文件明确说明 |
| 遗留门禁修复 | 冻结源码重建/哈希/结构/部署文档检查 | 旧包不要求等于当前源码；当前活动候选依旧严格校验源码/归档绑定，没有跳过历史套件 |

解析复用现有Office ZIP guard、fflate、Mammoth以及已安装的xmldom（显式锁定0.8.15），没有自写解压/XML/文档解析引擎。Office单文件20MiB、总展开64MiB、512ZIP项、2个128MiB worker、上下文总截止15s；结构化XML单部件8MiB、最多10000文本块、共享字符串/单元格受限；拒绝DOCTYPE/ENTITY、外部主关系、路径逃逸、宏/嵌入对象、无效共享字符串及假格式。两次解析均只在worker内读字节，不提取到文件路径，不执行公式或网络关系。

Word复用既有候选生成器/输入门禁，生产入口只固定DOCX，不开放候选PDF或跨服务XLSX依赖。2MiB正文、2000消息/8000段落上界、2个128MiB worker、10s超时；取消/超时待worker退出后释放名额。原文非法XML字符与超限明确拒绝，不静默截断。下载响应包含内容SHA与规范化导出源SHA，不修改消息、Run或历史；未提供统一产物索引/模型主动文档工具，不能称这两项已完成。

## 可复核证据
| 层次 | 文件/命令 | 结果 |
|---|---|---|
| 解析/导出/输入门禁及旧包 | `office-legacy-focused-20261031.log` | 37/37 |
| 上传→上下文、跨租户及前端 | `office-structured-http-20261031-r2.log` | 2/2；前端内部58断言 |
| Word下载/原历史/匿名与他人拒绝 | `office-word-product-http-20261031.log` | 3/3套件 |
| 同版真实DSH SDK产品链 | `office-http-sdk-chain-20261031.log` | 1/1：XLSX/PPTX正文进入实际原生请求、Run completed、每轮1model/0tool、各1个durable意图、Word反读与历史；provider为本地替身 |
| Linux干净安装 | `r17-office-linux-install-20261031-r2.log` | Node22.23.4 linux/x64，closure495包/31007文件；lockSHA eb54f12313941e09c569058836b5662b2db82069a1fa721ae1a8b6c0113610d4 |
| 确切归档Linux | `r17-exact-archive-linux-20261031.log` | closure PASS、10/10业务测试、原生模型故障探针PASS |
| 确切归档原生SDK产品链 | `r17-exact-archive-office-sdk-linux-20261031.log` | 1/1，与上传→原生请求→Run→Word→历史同链 |
| 完整默认回归 | `r17-default-regression-20261031.log` | 236/236，0失败；扫描时已出现的Gemini推理R3测试通过不等于交付确认或主审完成，未纳入r17生产源码 |
| 真实PostgreSQL16 | `r17-postgres-regression-20261031.log` | 4/4独立多连接套件，临时localhost容器已自动清理，无现有DB连接 |

首次HTTP联测失败记录`office-structured-http-20261031.log`保留：新增XLSX/PPTX用例改变最后一条消息，使旧DOCX再生成篡改用例测错对象；调整测试顺序后通过，未放宽篡改拒绝。前端格式列表预期同步更新。首次Linux安装因Docker未运行失败保留；启动Docker后重跑成功。旧门禁原测试存`legacy-release-gates-original-20261031.tar.gz`，SHA d74dac03c30370434321fe444b5e62fea688f24666f40da02fcd5ec9a0157f01；旧发布物与哈希未改，当前候选源码绑定没有取消。

## 冻结与未关闭项
r17 archiveSHA `63c9c22b8b54fdc599791d50453561c0a293ca84ea1651e544631dc612b23715`，198源码/399成员；builder write/check、独立audit与活动指针门禁PASS。状态DRAFT_NOT_FOR_DEPLOYMENT。r16及更早归档不变。
周一目标按用户2026-10-31指令更新到2026-11-02；完整范围仍见`../MONDAY-FINAL-DELIVERY-20261102.md`。PDF/OCR、音视频理解、跨资料检索/引用/删除、原生压缩/推理接线、Skill发布、联网与提问/审批、统一产物及真实费用闭环仍未关闭，不能把本轮多层通过外推为最终包完成。目标settings/媒体配置/线上故障复验继续单列，不等待它们才做独立开发。
本轮无生产修改、commit/push或付费provider请求；旧脏改动和wb copy保留。
