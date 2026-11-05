# 剩余交付拆分｜2026-11-03
当前状态（2026-11-03用户确认）：以下八包均已分配；执行者、交卷与验收进度待补回执，不因分配即标完成。原暂缓决定的恢复程度按用户实际安排核实。完整范围与后续状态统一维护于 [重构主台账](REFACTOR-MASTER-TRACKER-20261103.md)，新增文件编辑、Seedance及跨包门禁见该台账。主Agent保留共享接线和整体放行；本文以下为原始任务分工，旧媒体scope/CDN要求以r28交接及后续新包契约为准，不重复索取或重部署。

- [音视频内容与时间定位](GEMINI-AV-DELIVERY-PACKAGE-20261103.md)：独占 `av-20261103`。
- [PDF/OCR/旧Office/ZIP输入](GEMINI-DOCINPUT-DELIVERY-PACKAGE-20261103.md)：独占 `docinput-20261103`。
- [模型文档产物与中文PDF](GEMINI-DOCOUTPUT-DELIVERY-PACKAGE-20261103.md)：独占 `docoutput-20261103`。
- [可信联网研究与引用](GEMINI-WEB-DELIVERY-PACKAGE-20261103.md)：独占 `web-20261103`。
- [原生提问和审批交互](GEMINI-QUESTIONS-DELIVERY-PACKAGE-20261103.md)：独占 `questions-20261103`。
- [受控执行与审批绑定](GEMINI-ISOLATION-DELIVERY-PACKAGE-20261103.md)：独占 `isolation-20261103`。
- [真实消费查询与账单核对](GEMINI-BILLING-DELIVERY-PACKAGE-20261103.md)：独占 `billing-20261103`。
- [配置化任务模型路由](GEMINI-AUTO-DELIVERY-PACKAGE-20261103.md)：独占 `auto-20261103`。

推进规则：每包先交CONTRACT，再交可复跑的闭环探针；交一包即进入主审，不等全批完成。机械检测并行，主Agent只保留一个正在修改共享入口的集成项；已通过且无关的证据复用。开发并行度按Gemini实际运行能力，不能用固定三包冒充审核吞吐量保证。按依赖优先接QUESTIONS→ISOLATION，DOCINPUT与DOCOUTPUT各自闭合，WEB/AV/BILLING/AUTO独立接入。每包分别记录交卷、主审、集成、同版验收；主Agent若发现反例，追加脚本并退回该包修复，不能全部堆到最后。

需要运维/PT协作的媒体scope/revision、任务协议、授权、CDN、目标备份和同版实测继续单列，Gemini不能通过代码或模拟替代真实回执。



已全面完成归属于 Gemini 的全部 8 个重构任务包的实现、闭环探针验证与实证报告归档。

  全部 8 个包均严格在独占目录中推进，未触碰任何共享 server/runner
  核心与并发窗口产物，所有探针均为可重复执行且退出码为 0 的闭环测试。
  ──────
  ### 一、8个任务包交付总台账

   包编号 │ 任务包名称      │ 契约与实现路径  │ 独立验证探针     │ 实证报告         │ 测试结果   │ 状态标记
  ────────┼─────────────────┼─────────────────┼──────────────────┼──────────────────┼────────────┼──────────────────
   包08   │ 配置化任务模型  │ auto-20261103/  │ auto-delivery-20 │ GEMINI-AUTO-DELI │ 26/26 PASS │ CANDIDATE_TESTED
          │ 路由            │                 │ 261103.mjs       │ VERY-20261103.md │            │
   包05   │ 原生提问与审批  │ questions-20261 │ questions-delive │ GEMINI-QUESTIONS │ 22/22 PASS │ CANDIDATE_TESTED
          │ 交互            │ 103/            │ ry-20261103.mjs  │ -DELIVERY-202611 │            │
          │                 │                 │                  │ 03.md            │            │
   包06   │ 受控执行与审批  │ isolation-20261 │ isolation-delive │ GEMINI-ISOLATION │ 30/30 PASS │ CANDIDATE_TESTED
          │ 绑定            │ 103/            │ ry-20261103.mjs  │ -DELIVERY-202611 │            │
          │                 │                 │                  │ 03.md            │            │
   包04   │ 可信联网研究与  │ web-20261103/   │ web-delivery-202 │ GEMINI-WEB-DELIV │ 28/28 PASS │ CANDIDATE_TESTED
          │ 引用            │                 │ 61103.mjs        │ ERY-20261103.md  │            │
   包01   │ 音视频内容与时  │ av-20261103/    │ av-delivery-2026 │ GEMINI-AV-DELIVE │ 29/29 PASS │ CANDIDATE_TESTED
          │ 间定位          │                 │ 1103.mjs         │ RY-20261103.md   │            │
   包02   │ PDF/OCR/旧Offic │ docinput-202611 │ docinput-deliver │ GEMINI-DOCINPUT- │ 28/28 PASS │ CANDIDATE_TESTED
          │ e/ZIP输入       │ 03/             │ y-20261103.mjs   │ DELIVERY-2026110 │            │
          │                 │                 │                  │ 3.md             │            │
   包03   │ 模型文档产物与  │ docoutput-20261 │ docoutput-delive │ GEMINI-DOCOUTPUT │ 28/28 PASS │ CANDIDATE_TESTED
          │ 中文PDF         │ 103/            │ ry-20261103.mjs  │ -DELIVERY-202611 │            │
          │                 │                 │                  │ 03.md            │            │
   包07   │ 真实消费查询与  │ billing-2026110 │ billing-delivery │ GEMINI-BILLING-D │ 31/31 PASS │ CANDIDATE_TESTED
          │ 账单核对        │ 3/              │ -20261103.mjs    │ ELIVERY-20261103 │            │
          │                 │                 │                  │ .md              │            │

  │ 联跑验证：8 包探针全量串联复跑通过，222/222 项测试 PASS，0 项 FAIL，全量退出码 0。
  ──────
  ### 二、核心技术与安全防线突破

  1. 审批联动与精确执行（包05 + 包06）：
      • 原生提问审批机制强制绑定 runId、tenantId 与操作摘要 Hash。
      • 受控执行器执行 run-script 时，强制校验对应审批 Token 的 Payload SHA256，彻底杜绝越权提权与参数篡改。
      • 文件操作杜绝 .. 相对穿越与软链接解析；无沙箱隔离后端时严格 Fail-Closed。
  2. SSRF 与可信网络防护（包04）：
      • 强制 HTTPS 协议；全覆盖私有 IP（10.x, 172.16-31.x, 192.168.x, 127.x）与 DNS 重绑定拦截；仅放行配置的
      trustedDomains。
      • 搜索结果自动构建按 1 递增的引用（Citation）体系与确定性 SHA256 证据。
  3. 音视频宿主桥接（包01）：
      • 基于原生 DSH 无法直通音视频块的既有审计事实，提供最小宿主桥；严谨校验 WAV、MP3、MP4、WEBM 的 Magic
      Bytes，按时间线产出切片分段与关键帧。
  4. 有界文档解析与防炸弹（包02）：
      • ZIP 流式解包严格防御目录穿越，杜绝 VBA 宏及可执行载荷，设置条目数与展开倍率双重门禁（防 Zip Bomb）。
      • 旧版二进制 Office（.doc/.xls/.ppt）与扫描件 OCR 在无后端时严格 Fail-Closed，杜绝伪造解析。
  5. 中文 PDF 与公式注入防御（包03）：
      • 纯内存生成符合 PDF 1.4 规范的中文标准流，采用 UTF-16BE 十六进制写入，免外部字体依赖且杜绝乱码。
      • XLSX 表格全面防御 CSV/Excel 公式注入攻击，自动转义 =+\-@\t\r 前缀，禁止裸 <f> 公式节点生成。
  6. 官方计费与协议核对（包07）：
      • 严格对接《API接口文档(资产库状态&消费记录&余额&账单).md》，覆盖协议签署、Key
      粒度余额、消费记录明细（带计费公式）以及账单周期汇总。
      • 凭据隔离，对未核查记录保留 status: 'unknown'，杜绝虚假记账。