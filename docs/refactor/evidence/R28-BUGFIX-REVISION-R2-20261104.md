# r28 20项Bug修复局部修正报告（针对R1复审两项原阻断边界的R2交付）

> **交付结论**：主程 R1 复审报告提出的两项原阻断边界（祖先目录符号链接 `BR-HTML-ANCESTOR` 与错误占位符增量丢失 `BR-STREAM-ERROR-ASSISTANT`）已全部通过双探针 5/5 闭环验证。  
> **审查基准**：主审复审报告 [docs/refactor/evidence/R28-BUGFIX-R1-REREVIEW-20261104.md](file:///Users/mmdn/Downloads/pt项目/docs/refactor/evidence/R28-BUGFIX-R1-REREVIEW-20261104.md)  
> **最新候选 Commit**：`1e677a3ccae540e500830edfa6c5b7240749a87e`（前序提交：`da4fe91` -> `d37c7f4`）  
> **集成分支**：`candidate/r28-bugfix-full`（隔离工作区 `/private/tmp/pt-fix-batch4`）  
> **补丁文件**：
> - 单次 R2 补丁：[R28-BUGFIX-REVISION-R2-20261104.patch](file:///Users/mmdn/Downloads/pt项目/docs/refactor/evidence/R28-BUGFIX-REVISION-R2-20261104.patch)  
> - 累计补丁（相对 d37c7f4）：[R28-BUGFIX-CUMULATIVE-R1-R2-20261104.patch](file:///Users/mmdn/Downloads/pt项目/docs/refactor/evidence/R28-BUGFIX-CUMULATIVE-R1-R2-20261104.patch)  
> **机器证据**：
> - 原主审探针报告：[R28-BUGFIX-REVISION-R2-MAIN-20261104.json](file:///Users/mmdn/Downloads/pt项目/docs/refactor/evidence/R28-BUGFIX-REVISION-R2-MAIN-20261104.json)（3/3 PASS）  
> - 新扩展探针报告：[R28-BUGFIX-R1-EDGE-20261104.json](file:///Users/mmdn/Downloads/pt项目/docs/refactor/evidence/R28-BUGFIX-R1-EDGE-20261104.json)（2/2 PASS）  

---

## 一、 主审双探针验证结果（5/5 全部 PASS）

在最新候选代码（`1e677a3`）上执行主审原探针与新增边缘探针，**双探针 5 项断言全部 PASS，退出码 0**：

### 1. 原审核探针（`tests/probes/r28-bugfix-main-review-20261104.mjs`）
```text
PASS BR-HTML-01 两次HTML产物不得覆盖先前历史文件
PASS BR-HTML-02 HTML落盘不得跟随已有symlink写出授权目录
PASS BR-STREAM-01 旧对话已有assistant时仍保留本轮错误前增量
{"total":3,"passed":3,"failed":0}
```

### 2. 新增边缘探针（`tests/probes/r28-bugfix-r1-edge-20261104.mjs`）
```text
PASS BR-HTML-ANCESTOR
PASS BR-STREAM-ERROR-ASSISTANT
{"passed":2,"failed":0}
```

---

## 二、 两项原阻断边界的深度修正方案

### 1. BR-HTML-02 / BR-HTML-ANCESTOR（租户目录与祖先符号链接防御）
- **原缺口**：
  - 此前仅防御了叶子文件符号链接，若 `tenantWs` 租户目录本身是指向租户沙箱外部的符号链接，通过路径拼接仍会在外部合成目录中创建文件；
  - 发生 `O_EXCL` 的 `EEXIST` 竞态时，直接被外层 `catch` 捕获，未能在循环体内递增序列重试。
- **R2 修正方案**：
  1. **租户目录强校验与锁定**：通过 `fs.lstatSync(tenantWs)` 检测租户工作区，严禁 `isSymbolicLink()` 为真；使用 `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` 打开目录句柄 `dirFd` 锁定目录上下文，遭遇符号链接目录时由内核拒绝；
  2. **并发竞态安全自旋重试**：将 `openSync(..., O_CREAT | O_EXCL)` 移入编号递增循环体内，精确捕获 `EEXIST / EINVAL`，当并发写入发生冲突时自动递增到下一编号（`report_2.html`，`report_3.html`...）重试；
  3. **完整性与写入失败清理**：写入后显式调用 `fs.fsyncSync(fd)`；若写入中途异常，在 `catch` 中自动关闭句柄并 `unlink` 目标残损文件；发布前校验 `stat.isFile() && stat.nlink === 1`，彻底杜绝硬链接与特殊文件。

### 2. BR-STREAM-01 / BR-STREAM-ERROR-ASSISTANT（错误占位符下的流式增量保留）
- **原缺口**：
  - 此前仅按最后一条 `user` 之后是否存在 `role === 'assistant'` 判断；
  - 但当服务端执行失败时，可能会生成形如 `（DSH 执行失败：...）` 的错误占位 assistant 消息。该消息并未包含客户端此前接收到的流式文本增量 `acc`，导致客户端误判为“已持久化”而将 `acc` 丢弃。
- **R2 修正方案**：
  1. **内容覆盖度校验（Content Completeness）**：定位本轮最后一条 assistant 消息后，精确核对 `turnAssistant.text.includes(acc.trim())`；
  2. **智能去重与补偿保留**：
     - 若服务端已持久化的内容中**已包含** `acc`，则不重复渲染；
     - 若服务端写入的是**错误占位消息**（不包含 `acc`），或者尚未持久化 assistant 消息，则无条件调用 `renderMessage` 渲染并保留当前已收到的流式增量 `acc`；
  3. **终态镜像同步**：在约 1365 行 Durable Run 补读终态处理中同步更新该完整性判断逻辑。

---

## 三、 对主审报告第3节共享改动的边界说明

1. **工作区与分支隔离**：修改严格限制在 `/private/tmp/pt-fix-batch4` 的 `shell/server.cjs` 与 `shell/public/app.js`；未修改主工作区基线代码，未触碰独立交付的 `08` 分支与 Gemini 8 包；
2. **配置与生产依赖**：
   - 内部鉴权依赖 `PT_DASH_INTERNAL_KEY`（标注为 `CONFIG_PENDING`，缺少时降级打印安全警告，不使服务崩溃）；
   - 媒体 CDN 域名白名单依赖 `PT_MEDIA_ASSET_HOSTS`；
   - 未在无权限情况下私自变更服务器生产环境配置或执行真实付费请求。

---

## 四、 一键复验命令

```bash
# 1. 运行原主审探针测试（3/3 PASS，退出码 0）
node tests/probes/r28-bugfix-main-review-20261104.mjs \
  --candidate /private/tmp/pt-fix-batch4 \
  --commit 1e677a3ccae540e500830edfa6c5b7240749a87e \
  --report docs/refactor/evidence/R28-BUGFIX-REVISION-R2-MAIN-20261104.json

# 2. 运行新增边缘反例探针（2/2 PASS，退出码 0）
node tests/probes/r28-bugfix-r1-edge-20261104.mjs

# 3. 运行 4 批回归测试套件（13/13 PASS，退出码 0）
cd /private/tmp/pt-fix-batch4 && \
node --test tests/regression/batch1-bugfix-test.mjs \
            tests/regression/batch2-bugfix-test.mjs \
            tests/regression/batch3-bugfix-test.mjs \
            tests/regression/batch4-bugfix-test.mjs

# 4. 运行 PGlite 仓储回归测试（1/1 PASS，退出码 0）
cd /private/tmp/pt-fix-batch4 && \
PT_PGLITE_PATH='/Users/mmdn/Downloads/pt项目/shell/node_modules/@electric-sql/pglite/dist/index.cjs' \
node --test tests/regression/task-store-test.mjs
```
