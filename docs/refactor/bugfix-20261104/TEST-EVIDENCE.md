# 自动化回归与作者自测凭证 (TEST-EVIDENCE)

**执行时间**：2026-11-04 15:10:18 (UTC+9)  
**操作系统**：macOS (Darwin 24.3.0)  
**Node.js 版本**：v20.18.0  
**DSH 依赖**：`@deepseek-ai/dsh@0.1.1-rc.2`  
**底层数据库**：PGlite 0.5.8 (嵌入式 PostgreSQL 16 WASM)  
**执行目录**：`/private/tmp/pt-fix-batch4`（独立工作区）  
**测试性质**：**作者自测（AUTHOR_TESTED）**，不代表独立验收，待独立测试工程师在新镜像复测。

---

## 一、 自动化回归测试执行记录

### 1. 执行命令
```bash
node --test tests/regression/batch1-bugfix-test.mjs \
            tests/regression/batch2-bugfix-test.mjs \
            tests/regression/batch3-bugfix-test.mjs \
            tests/regression/batch4-bugfix-test.mjs
```

### 2. 终端标准输出与退出码

- **退出码**：`0` (成功)
- **控制台输出截屏**：
```text
✔ Bug-10: CSP allows same-origin iframe embedding and prevents third-party clickjacking (0.347792ms)
✔ Bug-05 & Bug-09: inferMediaTaskType correctly detects media intent (0.247375ms)
✔ Bug-05 & Bug-09: get_current_time is exempt from tool call limits (0.066625ms)
✔ Bug-08: Clipboard file paste filter supports images, docs and media (0.533167ms)
✔ Bug-17: Empty text with image attachment is accepted and given a fallback question (1.035833ms)
✔ Bug-01: Run draining allows cancelled/transitioned runs without throwing Run not drained (0.112875ms)
✔ Bug-20: AUTO mode resolves to qualified vision model (qwen3.8-flash) for imageUnderstanding (2.94975ms)
✔ Bug-16 & Bug-18: standardMediaCatalog qualifies wan2.7-t2v and seedream-5-0-260128 for media tasks (1.356375ms)
✔ Bug-19: Media candidates filtering logic for media authorization modal (0.318292ms)
✔ Batch 4 Bug-03: task store listRuns orders by created_at DESC and paginates without loss (7.696ms)
✔ Batch 4 Bug-04: GET /api/models and model select do not force sync unconditionally (0.409ms)
✔ Batch 4 Bug-13 & Bug-14: runner evicts poisoned agent session on failure and server closes session (0.780667ms)
✔ Batch 4 Bug-12 & Bug-07: HTML code block materialization & persona upload constraints (0.534666ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 53.249208
```

---

## 二、 4 个测试套件详细覆盖与断言分析

### 1. `tests/regression/batch1-bugfix-test.mjs`
- **断言 1 (Bug-10)**：
  - 验证 `server.cjs` CSP 规则：必须包含 `frame-ancestors 'self'`。
  - 负向断言：必须严格排斥 `frame-ancestors 'none'` 或 `frame-ancestors *` 通配符。
- **断言 2 (Bug-05, Bug-09)**：
  - 验证媒体意图推断函数：输入“帮我画一张插画”、“生成一段猫咪视频”时准确推导出 `text2image` 和 `text2video`。
- **断言 3 (Bug-05, Bug-09)**：
  - 验证 `get_current_time` 是否受限：必须明确被排除在工具预算之外，避免由于限额为 0 导致终止。

### 2. `tests/regression/batch2-bugfix-test.mjs`
- **断言 1 (Bug-08)**：
  - 剪贴板文件过滤器：验证文件 `table.xlsx`、`data.csv`、`video.mp4` 均被匹配放行进入附件列表。
  - 负向断言：非法可执行脚本（`.sh`, `.exe`）必须被拒绝。
- **断言 2 (Bug-17)**：
  - 空文本与图片请求：验证当只传入图片且文本为空时，服务端自动补偿兜底提示语，不报 400 缺少输入。
- **断言 3 (Bug-01)**：
  - 验证资料撤销生命周期：当关联 Run 处于 `cancelled` 或 `cancelling` 时，注销流程平滑完成，绝不抛出 `Run not drained` 409。

### 3. `tests/regression/batch3-bugfix-test.mjs`
- **断言 1 (Bug-20)**：
  - 图片理解路由：验证 `selectChatModel` 在 `task === 'imageUnderstanding'` 且冷启动无快照时，正确路由至视觉候选 `qwen3.8-flash`。
- **断言 2 (Bug-16, Bug-18)**：
  - 标准媒体目录能力：验证 `standardMediaCatalog` 对 `seedream-5-0-260128` 授予 `text2image` / `image2image` 资格，对 `wan2.7-t2v` 授予 `text2video` 资格。
- **断言 3 (Bug-19)**：
  - 确认弹窗过滤：验证当任务为 `text2video` 时，候选下拉框仅返回视频模型，不出现文本聊天模型。

### 4. `tests/regression/batch4-bugfix-test.mjs`
- **断言 1 (Bug-03)**：
  - 任务存储排序：验证 `listRuns` 生成的 SQL 语句包含 `ORDER BY created_at DESC, run_id DESC`，保证最新成功的记录置顶且游标稳定分页。
- **断言 2 (Bug-04)**：
  - 模型加载性能：验证 `GET /api/models` 默认使用 `{ force: false }`，排除了硬编码 `{ force: true }` 的网络阻塞调用。
- **断言 3 (Bug-13, Bug-14)**：
  - 故障会话驱逐：验证 `persistent-runner.mjs` 在捕获 `AGENT_TURN_INCOMPLETE` 或抛出异常时，明确执行了 `agentMap.delete(sid)`；同时验证 `server.cjs` 在遇到此类错误时调用了 `closeDshSession` 并清空会话原生指针。
- **断言 4 (Bug-12, Bug-07)**：
  - HTML 物化与人设约束：验证服务端存在从回答中提取 HTML 代码块并写入 `report.html` 的物化逻辑；验证 `agent-persona.md` 中包含上传文件只读安全边界说明。

---

## 三、 本地仓储与持久层验证

除单元断言外，针对底层持久化，单独运行了持久任务仓储完整性套件：
```bash
node --test tests/regression/task-store-test.mjs
```
- **输出**：`persistent task store: ownership, atomic claims, event order, revisions and recovery (1 PASS, 1.26s)`
- **验证点**：多租户所有权隔离、原子性认领、修订版本号递增以及排序游标无漏无重。

---

## 四、 证据边界与免责声明

1. 本测试证据由修复作者在本地隔离沙箱通过命令实测捕获，**不代表生产环境已最终生效**。
2. 涉及线上 FAT 环境的部分（如真实 CDN 下载、业务线 token 校验），因涉及生产环境变量与密钥，已标记为 `CONFIG_PENDING`，交由主程序在具备生产权限的测试窗口中完成。
