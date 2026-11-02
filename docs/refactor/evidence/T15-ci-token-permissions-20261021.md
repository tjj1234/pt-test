# T15 CI 权限最小化差距（2026-10-21）

**结论：已在 workflow 顶层声明最小只读 `contents` 权限；这是静态配置修订，不代表 GitHub Actions 已运行或 T15 通过。** `.github/workflows/ci.yml` 在现有 `push`、`pull_request` 触发器之后、`jobs` 之前声明 `permissions: contents: read`，该 workflow 的所有 jobs 因而使用只读仓库内容权限。现有 job 与步骤未改动。实际运行权限效果、仓库设置及 branch protection 尚未核验。

## 范围与证据

| 检查项 | 观察 | 边界 |
|---|---|---|
| Workflow 触发器 | `.github/workflows/ci.yml:3-8` 配置 main 的 push 与 pull request。 | 未查询 GitHub 仓库设置或最近 Actions 运行。 |
| Workflow/job 权限 | `.github/workflows/ci.yml:9-10` 在 workflow 顶层设置 `permissions: contents: read`，适用于所有 jobs。 | 仅静态确认配置文本；未实跑 Actions、核验仓库 Actions 设置或 branch protection。 |
| 当前动作 | workflow 使用 `actions/checkout@v4`、`actions/setup-node@v4` 和本地 npm/Node 命令；未见需写仓库内容、发布包或请求 OIDC 的步骤。 | 第三方 action 的实现与运行行为未在本切片审计。 |

## 修订内容

已在 workflow 顶层设置最小只读权限，覆盖所有 jobs：

```yaml
permissions:
  contents: read
```

当前静态可见步骤没有写仓库内容或请求 OIDC 的需求。若后续 job 确实需要额外权限，应仅在该 job 声明所需权限并记录用途。该配置不触及 T06/T07、模型路由、产品运行时或验收数据。

## 验证要求与状态

本次只修改 workflow 权限声明并更新本证据；未运行测试、未触发 GitHub Actions、未查询仓库设置，故尚无 Actions run 结果，也未核验 required checks 与 branch protection。该静态修订仍需 workflow 语法/配置验证及一次真实 Actions run；T15 原有浏览器/移动端、AC 场景矩阵、性能、目标环境、恢复和独立综合验收缺口均不受影响，故 T15 继续 `blocked`，AC 状态不变。
