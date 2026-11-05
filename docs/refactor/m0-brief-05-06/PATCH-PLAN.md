# 05/06 分步实施计划与补丁演进方案 (PATCH-PLAN)

> **版本**：1.0.0  
> **所属阶段**：M0 原生接缝与架构评审  
> **演进基线**：`bbd9997` (主线) -> `fb250a9` (`fix/questions-isolation-20261104` 修复分支)

---

## 1. 范围与独占文件隔离铁律

为了防止跨模块污染并确保评审完全独立，所有改动严格限定在以下独占资产中，禁止触碰主工作区共享文件：

### 允许修改的独占文件范围：
- `shell/candidates/questions-20261103/` (Package 05 独占目录)
- `shell/candidates/isolation-20261103/` (Package 06 独占目录)
- `tests/probes/` (专有探针脚本与测试夹具)
- `docs/refactor/m0-brief-05-06/` 与 `docs/refactor/evidence/` (设计与证据文档)

### 严格禁止触碰的文件（违者视为破坏发布边界）：
- 共享服务入口：`shell/index.mjs`、`shell/server.mjs`
- 租户鉴权与核心配置：`shell/auth.mjs`、`shell/config.mjs`
- 依赖锁定与工程配置：`package.json`、`pnpm-lock.yaml`、`tsconfig.json`
- 历史交付文件与主交付任务书：`shell/candidates/*-20261103.mjs`、`docs/refactor/GEMINI-*-DELIVERY-PACKAGE-20261103.md`

---

## 2. 分阶段实施计划 (M0 -> M4)

```
[M0: 方案评审] (当前阶段)
  --> 提交 5 份设计文档，明确原生接缝与缺口契约
  --> 冻结实现代码，等待 Codex 主程序书面核准
           | (主程序通过 M0 门禁)
           v
[M1: 最小切片实现]
  --> 05: 接入原生 UserQuestionService 服务接口 + RequestBinding 严格校验
  --> 06: 实现宿主安全只读与硬链接拦截 + 默认 Fail-Closed 禁执行
           | (最小切片通过基本断言)
           v
[M2: 作者完整自验]
  --> 编写并运行 F01–F40 对应作者层探针
  --> 输出测试记录、退出码、SHA 与详细自测报告
           | (自测矩阵无阻断缺陷)
           v
[M3: 主程序独立复审]
  --> Codex 在固定 Tip 重放探针，审查补丁范围与不变式
           | (主审出具合格复查意见)
           v
[M4: 主线接线与 Staging 验收]
  --> 主程序接入共享入口，独立 QA 进行 Staging E2E 验证
```

### 各阶段细化施工任务：

### 阶段 M0：原生接缝与设计评审（当前）
- 目标：核验 `@deepseek-ai/*` 原生导出真实性，设计 `RequestBinding`、`CanonicalDigest`、状态机与执行威胁模型。
- 输出物：`REUSE-MATRIX.md`, `TRUST-AND-STATES.md`, `BACKEND-PROPOSAL.md`, `AC-MAP.md`, `PATCH-PLAN.md`。
- 门禁：**先交方案，不盲目改代码**。待主程序书面批准后方可进入 M1。

### 阶段 M1：实现最小功能切片
- **Package 05 (提问审批)**：
  - 构建 `HostUserQuestionProvider`，适配原生 `UserQuestionService`；
  - 引入 RFC 8785 标准 `CanonicalDigest` 计算逻辑；
  - 冻结 `options`、禁止外部突变，实施绝对 `deadline` 拦截与异参冲突检测。
- **Package 06 (受控执行)**：
  - 完善只读路径严审逻辑：`realpathSync` 物理防穿透，拦截硬链接（`nlink > 1`）与父目录逃逸；
  - 接入执行门禁：默认 `hasIsolationBackend = false`，无验证沙箱时严禁任何 bare spawn 执行；
  - 接入 `GrantRef` 验签与原子 CAS 消费模拟机制。

### 阶段 M2：作者全量自验
- 在 `/private/tmp/pt-fix-05-06` 隔离工作树中扩展测试套件，覆盖 F01–F40 中作者归属的 24 项关键指标；
- 验证原 8 个安全反例持续保持 PASS，新接缝无回归；
- 生成补丁文件 `QUESTIONS-ISOLATION-M1-M2-REVISION.patch`，提交证据报告。

### 阶段 M3：Codex 独立复审
- 主程序审核人员切入 tip 提交节点；
- 独立重放测试套件与反向对抗样本，验证代码未触碰受保护共享文件。

### 阶段 M4：接线与独立验收
- 主程序负责将 05/06 候选模块接入全局路由，并在 Staging 环境进行 E2E UI 点击与发布冒烟。

---

## 3. 回退策略与差异防护 (Rollback & Safety)

1. **工作树物理隔离**：
   所有 M1–M2 的代码改动均局限于分支 `fix/questions-isolation-20261104` 的专属 worktree (`/private/tmp/pt-fix-05-06`)，主工作区 (`feature/northstar-integration-20261102`) 保持干净，随时可无损放弃或重置。
2. **提交原子性**：
   每个功能切片单独提交 Git Commit，并生成对应的 `.patch` 归档。一旦复审发现方向偏差，可精确 `git revert` 到特定切片。
3. **补丁导出与交付**：
   最终交付物包括：
   - Git Commit SHA 指针；
   - 包含完整上下文的标准 unified diff patch 文件；
   - 附带执行命令、退出码与随机测试因子的复验报告。
