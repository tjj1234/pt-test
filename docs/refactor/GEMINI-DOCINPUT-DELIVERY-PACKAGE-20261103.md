# Gemini任务包：PDF/OCR/旧Office/ZIP输入｜2026-11-03

> 实施门禁：以[DSH最大化复用原则](PRODUCT-ROADMAP-AND-RESOURCES-20261103.md#首要原则最大化复用dsh)为准。先交需求与锁定DSH原生/插件/UI/协议的复用矩阵；优先配置、直接复用和必要接线，主审确认具体缺口后才补最小宿主实现。此包不要求另造原生已有机制；已分配包在交卷/主审时补此矩阵，不覆盖执行者已有工作。

基线：`f4a3d39e9454a13f37d39ec84d01ae0b625162d0`（源码仍会前进；交付报告必须记录实际base和文件SHA）。状态：ASSIGNED（2026-11-03用户确认已分配）；执行者、实际交付与验收进度待回执，不代表完成。状态统一维护于 [完整重构主台账](REFACTOR-MASTER-TRACKER-20261103.md)。目标是实现可集成闭环，不接受仅调查报告替代功能。

边界：只新增 `shell/candidates/docinput-20261103/`、`tests/probes/docinput-delivery-20261103.mjs`、`docs/refactor/evidence/GEMINI-DOCINPUT-DELIVERY-20261103.md`；本任务包仅追加交付记录。禁止编辑server、persistent-runner、tenant、public、共享迁移、package/lock、发布归档、其他候选、`tests/e2e/`和OAuth文档。需要接入共享文件时，提交逐项接线说明和补丁文件在独占目录，由主Agent集成。依赖新增只能给版本/许可/安装及锁定方案，不擅自修改共享依赖。不得存凭据、付费调用、部署、merge、push或覆盖他人改动。

交付契约：先把输入/输出schema、可信身份来源、取消/期限/资源限制、错误码、Run事件及挂载接口写入独占目录的CONTRACT.md；随后实现代码和真实fixture闭环。跨包只引用对方CONTRACT，不编辑对方文件；依赖不齐时用严格模拟依赖测试边界并显式记未联测，不能把模拟叫真实产品验收。优先复用锁定DSH已有服务；确认原生缺口后才实现最小宿主桥。

执行：`node tests/probes/docinput-delivery-20261103.mjs` 必须可重复运行、失败非零，内部真正调用实现及真实解析器/SDK/浏览器/本地协议服务中与任务有关的路径；禁止仅检查文件字符串。输出命令/退出码/通过失败数、fixture、源码与依赖SHA、反例、修复记录、未验证与外部BLOCKED。额外提供只加载本包依赖的临时目录探针。报告标记 FILES_PRESENT / CANDIDATE_TESTED / INTEGRATION_PENDING；只有主Agent可标主线验收。新文件和测试完成后即时回传，不等本批其他包。

实现目标：实现可运行的有界输入解析：文本PDF逐页定位、扫描件OCR、旧Office转换和ZIP资料包。明确格式矩阵；未支持项必须具名失败，不能假称完成。

先读：shell/attachments/office-document-parser.cjs、office-document-worker.cjs、office-zip-guard.cjs、source-store.cjs。

必须覆盖：中文多页PDF、扫描件、旧Office和ZIP真实fixture；页面/成员/SHA来源，ZIP穿越/炸弹、外链/宏、加密坏文件、取消与资源上限；需给Linux依赖清单及离线可执行测试。

## PT依赖、Plan B与进度影响
| PT依赖/需求编号 | Plan B | 进度/验收影响 |
|---|---|---|
| PT-12可选OCR | 原生文字提取+受限本地OCR，优先已有解析器 | Office/文字PDF继续；复杂扫描格式可能延期，不能标全格式完成 |
依据：[PT接口规格v1.1第15节](PT-API-REQUIREMENTS-20261104.md)。PT未接受建议接口形态时先映射既有协议；遵循DSH最大复用原则。上述Plan B为规划候选，不表示已验证或获准额外模型/资源/供应商调用；原范围未满足仍标未完成，变更需用户确认。签署协议仅已签署/未签署，无有效期/续签；资产启用及凭据/缓存/资源有效期分别处理。
