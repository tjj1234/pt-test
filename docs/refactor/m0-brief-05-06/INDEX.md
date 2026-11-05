# 05/06 原生接缝与架构方案 (M0 阶段交付索引)

> **版本**：1.0.0 (M0 Seam & Architecture Review)  
> **日期**：2026-11-04  
> **提交方**：Gemini (原 05 提问审批 / 06 受控执行模块作者)  
> **审查方**：Codex / 主程序负责人  
> **基准代码**：`bbd9997` (主线) / `fb250a9` (fix/questions-isolation-20261104 隔离工作树)  
> **目标**：响应 `docs/refactor/QUESTIONS-ISOLATION-FROZEN-REVISION-BRIEF-20261104.md`，交付 5 份核心设计文档，明确原生接缝、真实缺口、可信数据流、后端威胁模型与 F01–F40 验收映射，**在 M0 获得审查放行前不扩大代码施工**。

---

## 交付文档导航

| 序号 | 交付文档 | 核心内容与审核重点 | 文档链接 |
|---|---|---|---|
| 01 | **REUSE-MATRIX.md** | 逐项核验 `@deepseek-ai/*` (0.1.1-rc.2) 原生导出、装配方式、锁路径、真实功能及宿主最小缺口补充 | [REUSE-MATRIX.md](file:///Users/mmdn/Downloads/pt项目/docs/refactor/m0-brief-05-06/REUSE-MATRIX.md) |
| 02 | **TRUST-AND-STATES.md** | 可信边界划分、RequestBinding 规范化 Schema、CanonicalDigest 跨包一致性、状态机流转、原子 CAS 单次消费与崩溃恢复 | [TRUST-AND-STATES.md](file:///Users/mmdn/Downloads/pt项目/docs/refactor/m0-brief-05-06/TRUST-AND-STATES.md) |
| 03 | **BACKEND-PROPOSAL.md** | 真实 OS (macOS/Linux) 沙箱能力分析、威胁模型（读/写/网络/凭据/进程）、Fail-Closed 闭门门禁与无执行后端时的降级策略 | [BACKEND-PROPOSAL.md](file:///Users/mmdn/Downloads/pt项目/docs/refactor/m0-brief-05-06/BACKEND-PROPOSAL.md) |
| 04 | **AC-MAP.md** | F01–F40 全量 40 项验收标准矩阵映射，明确当前状态、用例/探针手段、作者责任与主程/独立测试分工 | [AC-MAP.md](file:///Users/mmdn/Downloads/pt项目/docs/refactor/m0-brief-05-06/AC-MAP.md) |
| 05 | **PATCH-PLAN.md** | 基于基线 `fb250a9` 的分步最小切片演化路线、文件隔离边界、分支策略与回退保证 | [PATCH-PLAN.md](file:///Users/mmdn/Downloads/pt项目/docs/refactor/m0-brief-05-06/PATCH-PLAN.md) |

---

## 阶段原则承诺

1. **先交方案，不盲目改代码**：严格遵守 M0 停止点门禁，待主程序核准原生接缝与缺口定义后再开启 M1 最小切片实现。
2. **拒绝表面通过**：不以“仅通过若干合成探针”假充全系统闭合；无法满足内核隔离时，明确置执行开关为关闭状态（Fail-Closed）。
3. **隔离工作树施工**：后续 M1–M2 修改仍严格保持在独立 worktree (`/private/tmp/pt-fix-05-06`) 与独立分支，不污染主工作区共享文件。
