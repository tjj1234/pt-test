# r28 20项Bug修复局部修正报告（针对主审阻断项的R1交付）

> **交付结论**：3项主审接入阻断（`BR-HTML-01`、`BR-HTML-02`、`BR-STREAM-01`）已全部通过原探针闭环验证；第4节8项共享改动逐项完成边界与配置依赖澄清。  
> **审查基准**：主审报告 [docs/refactor/evidence/R28-BUGFIX-MAIN-REVIEW-20261104.md](file:///Users/mmdn/Downloads/pt项目/docs/refactor/evidence/R28-BUGFIX-MAIN-REVIEW-20261104.md)  
> **最新候选 Commit**：`da4fe91520f1156a859fac691900713275eb0529`（前序提交：`d37c7f4c38a0ab6db584a421b30fb7f04d051ca2`）  
> **集成分支**：`candidate/r28-bugfix-full`（隔离工作区 `/private/tmp/pt-fix-batch4`）  
> **补丁文件**：[R28-BUGFIX-REVISION-R1-20261104.patch](file:///Users/mmdn/Downloads/pt项目/docs/refactor/evidence/R28-BUGFIX-REVISION-R1-20261104.patch)  
> **机器证据**：[R28-BUGFIX-REVISION-R1-20261104.json](file:///Users/mmdn/Downloads/pt项目/docs/refactor/evidence/R28-BUGFIX-REVISION-R1-20261104.json)（3/3 PASS）  

---

## 一、 主审阻断项验证结果

针对主程探针脚本 `tests/probes/r28-bugfix-main-review-20261104.mjs`，在隔离工作区对最新候选代码（`da4fe91`）执行源码绑定反例验证，**3/3 全部通过，退出码 0**：

```text
PASS BR-HTML-01 两次HTML产物不得覆盖先前历史文件
PASS BR-HTML-02 HTML落盘不得跟随已有symlink写出授权目录
PASS BR-STREAM-01 旧对话已有assistant时仍保留本轮错误前增量
{"total":3,"passed":3,"failed":0}
```

---

## 二、 3项阻断修复技术方案与代码对比

### 1. BR-HTML-01（P1 数据正确性：不可变产物与序列防覆写）
- **原缺口**：`shell/server.cjs` 每次将 HTML 块直接写入固定路径 `report.html`，同租户第二次生成将无条件覆写第一次产物，破坏既有引用。
- **修正方案**：
  1. 物化前首先探测 `report.html` 是否存在（含符号链接检查）；
  2. 若已存在，则自动进入序列递增寻址循环（`report_2.html`，`report_3.html`...），确保历史产物完全不可变；
  3. 将物化后的实际相对路径 `htmlRel` 同步注入产物名称，保证 SSE 发送的产物与磁盘文件严格一致且 URL 独立。

### 2. BR-HTML-02（P1 写入边界：符号链接与越权写保护）
- **原缺口**：`fs.writeFileSync` 在路径为符号链接时会直接跟随链接写入外部目标文件。
- **修正方案**：
  1. 先通过 `fs.lstatSync` 探测目标路径；若存在且为符号链接或实体文件，均视为冲突跳过；
  2. 采用底层独占标志位 `O_WRONLY | O_CREAT | O_EXCL` 打开文件描述符，权限收紧至 `0o600`；操作系统级拒绝跟随任何符号链接，遭遇竞态时返回 `EEXIST` 自动触发下一序列编号；
  3. 安全写入后显式 `fs.closeSync(fd)`，杜绝越权写入租户沙箱外的任何文件。

### 3. BR-STREAM-01（P1 增量保留：多轮会话轮次边界判定）
- **原缺口**：`shell/public/app.js` 在流式异常中断分支中，使用全局 `!obj.messages.some(m => m.role === "assistant")` 判断是否保留增量 `acc`；在多轮对话中，若早先轮次已存在 assistant 消息，该条件误判为 `false`，导致当前轮次尚未持久化的部分回复内容被丢弃。
- **修正方案**：
  1. 通过 `obj.messages.map(m => m.role).lastIndexOf("user")` 准确定位**当前轮次**的起始索引；
  2. 仅检查在最后一条 user 消息之后是否已存在持久化 assistant 回复；
  3. 若本轮尚未落盘 assistant 回复，即使历史早有 assistant 记录，仍安全调用 `renderMessage` 保留并渲染 `acc`；
  4. 同步修正了约 1357 行 Durable Run 补读终态处理中的镜像逻辑。

---

## 三、 对主审报告第4节 8项共享改动的逐项说明与依赖边界

| 编号 | 审查项 | 当前代码实现与隔离边界说明 | 运维/配置/外部依赖 |
|---|---|---|---|
| **1** | **资料删除 (Bug-01)** | `onRevoke` 中将取消状态从 `cancelling` 安全推进至 `cancelled`，仅针对当前已被标记为取消的 Run；未直接中断运行中 worker 的内存上下文，而是等待 drain 超时（1秒）以保障外部租约平稳过期。 | 无外部破坏性，DB终态与内存状态一致。 |
| **2** | **工具预算 (Bug-05 & Bug-09)** | 仅将 `get_current_time`（纯时间获取）从工具调用计数额度中排除，避免多步推理因查询时间而提前超限。总模型调用预算、单次请求总超时、用户主动取消机制依然完整受控。 | 无需额外配置，防越界策略保持生效。 |
| **3** | **模型资格/环境 (Bug-16/18/20)** | 将媒体任务目录过滤从强制严格全等 `=== 'standard3'` 放宽为 `!== 'off'`，满足非受限部署；AUTO 视觉任务在主模型不具备视觉能力时，安全路由至经过资格校验的视觉模型候选（如 `qwen3.8-flash`）。 | 未越权解锁未授权收费模型；真实生成依赖客户配置对应 Provider Key。 |
| **4** | **内部鉴权 (Bug-02/06/11/15)** | `ensureTenantAnalytics` 修复了请求头透传租户上下文与内部鉴权 Token；在未配置 `PT_DASH_INTERNAL_KEY` 的本地或测试环境中降级报警并安全跳过，防止服务崩溃。 | **CONFIG_PENDING**：线上跨服务调用需在环境变量中注入 `PT_DASH_INTERNAL_KEY`。 |
| **5** | **日志分页 (Bug-03)** | `listRuns` 分页基于 `created_at DESC, id DESC` 联合游标排序，消除同一时间戳丢失数据的问题；查询严格携带 `owner / tenant` 租户隔离条件，不会跨租户泄露运行记录。 | PGlite 本地测试已验证游标跨页幂等性与租户隔离。 |
| **6** | **会话恢复 (Bug-13/14)** | 失败时在 Runner 侧主动清理被污染的 agent 实例映射（`delete agentMap[key]`），并触发 Server 侧 Session 销毁与垃圾回收，确保下一轮对话重建纯净上下文。 | 保证同会话后续交互不继承脏状态。 |
| **7** | **上传文件修改 (Bug-07)** | 在 `agent-persona.md` 中强化只读边界提示，明确系统不对用户原始上传文件执行原地写操作，需输出新文件或表格展示。 | 规范模型行为边界，不伪造不存在的就地修改。 |
| **8** | **复测版本与性能统一** | 修复提交历程明确：`bbd9997`（基线）→ `13806fa`（B1）→ `6b932ce`（B2）→ `5b941d6`（B3）→ `27f4731`（B4）→ `0f0bb52`（文档）→ `d37c7f4`（交付）→ `da4fe91`（本次R1修正）。生产代码变动范围严格受限；测试套件耗时 < 60ms。 | 统一版本引用为 `da4fe91`，避免版本号错位。 |

---

## 四、 复测与验收命令

在当前环境下可执行以下真实验证命令：

```bash
# 1. 运行主审探针测试（3/3 必须 PASS，退出码 0）
node tests/probes/r28-bugfix-main-review-20261104.mjs \
  --candidate /private/tmp/pt-fix-batch4 \
  --report docs/refactor/evidence/R28-BUGFIX-REVISION-R1-20261104.json

# 2. 在候选工作区运行4批回归测试套件（13/13 PASS，退出码 0）
cd /private/tmp/pt-fix-batch4 && \
node --test tests/regression/batch1-bugfix-test.mjs \
            tests/regression/batch2-bugfix-test.mjs \
            tests/regression/batch3-bugfix-test.mjs \
            tests/regression/batch4-bugfix-test.mjs

# 3. 运行 PGlite 真实隔离仓储回归测试（1/1 PASS，退出码 0）
cd /private/tmp/pt-fix-batch4 && \
PT_PGLITE_PATH='/Users/mmdn/Downloads/pt项目/shell/node_modules/@electric-sql/pglite/dist/index.cjs' \
node --test tests/regression/task-store-test.mjs
```

---

## 五、 交付物清单

1. **隔离分支最新提交**：`candidate/r28-bugfix-full`（`da4fe91520f1156a859fac691900713275eb0529`）
2. **完整补丁**：`docs/refactor/evidence/R28-BUGFIX-REVISION-R1-20261104.patch`
3. **机器反例证据**：`docs/refactor/evidence/R28-BUGFIX-REVISION-R1-20261104.json`
4. **主工作区规范守则**：主仓库 `/Users/mmdn/Downloads/pt项目` 保持干净独立，未执行直接合并或修改线上基线。
