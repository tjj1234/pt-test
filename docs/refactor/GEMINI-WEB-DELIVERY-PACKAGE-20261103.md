# Gemini任务包：可信联网研究与引用｜2026-11-03

基线：`f4a3d39e9454a13f37d39ec84d01ae0b625162d0`（源码仍会前进；交付报告必须记录实际base和文件SHA）。状态：READY_TO_FORWARD，文档创建不表示已派送。目标是实现可集成闭环，不接受仅调查报告替代功能。

边界：只新增 `shell/candidates/web-20261103/`、`tests/probes/web-delivery-20261103.mjs`、`docs/refactor/evidence/GEMINI-WEB-DELIVERY-20261103.md`；本任务包仅追加交付记录。禁止编辑server、persistent-runner、tenant、public、共享迁移、package/lock、发布归档、其他候选、`tests/e2e/`和OAuth文档。需要接入共享文件时，提交逐项接线说明和补丁文件在独占目录，由主Agent集成。依赖新增只能给版本/许可/安装及锁定方案，不擅自修改共享依赖。不得存凭据、付费调用、部署、merge、push或覆盖他人改动。

交付契约：先把输入/输出schema、可信身份来源、取消/期限/资源限制、错误码、Run事件及挂载接口写入独占目录的CONTRACT.md；随后实现代码和真实fixture闭环。跨包只引用对方CONTRACT，不编辑对方文件；依赖不齐时用严格模拟依赖测试边界并显式记未联测，不能把模拟叫真实产品验收。优先复用锁定DSH已有服务；确认原生缺口后才实现最小宿主桥。

执行：`node tests/probes/web-delivery-20261103.mjs` 必须可重复运行、失败非零，内部真正调用实现及真实解析器/SDK/浏览器/本地协议服务中与任务有关的路径；禁止仅检查文件字符串。输出命令/退出码/通过失败数、fixture、源码与依赖SHA、反例、修复记录、未验证与外部BLOCKED。额外提供只加载本包依赖的临时目录探针。报告标记 FILES_PRESENT / CANDIDATE_TESTED / INTEGRATION_PENDING；只有主Agent可标主线验收。新文件和测试完成后即时回传，不等本批其他包。

实现目标：复用锁定DSH tool-web与provider服务，实现受信provider契约和有界出口/来源证据桥。提供实际本地HTTP→原生工具→来源保存闭环，公网资格另列。

先读：tests/regression/native-tool-run-gate-sdk-test.mjs、shell/media/pinned-asset-fetch.cjs、shell/tasks/budget.cjs。

必须覆盖：私网/混合DNS/重绑定/重定向/凭据URL拒绝，取消/超时/字节预算，额外模型调用计入同Run，引用绑定真实响应和抓取时间；未配置provider必须清晰不可用。
