# DSH `web` Profile 配置快照（B8 · dsh-better-sidebar）

> ⚠️ **这是 profile 快照，非权威源。** 权威源是本机全局目录 `~/.dsh/profiles/web/`
> （Windows：`C:\Users\<user>\.dsh\profiles\web\`）。本快照**可能会漂移**——全局目录会被
> `dsh plugin` 等命令随时改写，而这里只是 B8 任务完成那一刻的只读拷贝。核实/复现时请以
> 本机全局目录为准，并用下文命令重新生成，不要直接信任本快照。

## 这是什么

B8 任务包（DSH 升级核查 + 安装 `dsh-better-sidebar` 侧边栏插件）完成后，全局 DSH `web`
profile 两个关键配置文件的**原样（verbatim）拷贝**：

| 文件 | 来源 | 作用 |
|---|---|---|
| `package.json` | `~/.dsh/profiles/web/package.json` | 声明 `dsh.profile.bundles`（含 `dsh-better-sidebar`）与 `dependencies`（`dsh-better-sidebar: 0.17.1`） |
| `cordis.patch.yml` | `~/.dsh/profiles/web/cordis.patch.yml` | profile 的用户 patch 层（directory-picker / llm-deepseek / web-search / browser 配置） |

两个文件均**逐字节原样拷贝、未注入任何注释**，以便你拉下来后与本机全局目录做
`diff` / `fc` 得到零差异。所有说明集中在本 README 与 commit message，不污染快照本体。

## 关键事实（B8 核实结论）

- **DSH 核心未升级**：仍为 `@deepseek-ai/dsh@0.1.1-rc.2`（仓库 `shell/package.json` 亦锁定此版本）。
- **插件版本 = 0.17.1（非 @latest）**：`@latest`（0.21.1）要求 peerDep `@deepseek-ai/dsh-agent ^0.1.7-rc.1`，
  与当前 DSH `0.1.1-rc.2` 不兼容；0.17.1 要求 `^0.1.0-rc.8`，兼容。详见升级清单第 9 节。
- **插件挂载方式**：`dsh-better-sidebar` 靠 `package.json` 的 `dsh.profile.bundles` 触发**插件自带的**
  `cordis.patch.yml`（位于 `node_modules/dsh-better-sidebar/`）自动挂载，**不是**靠 profile 自己的
  `cordis.patch.yml` 手写 insert。因此本快照的 `cordis.patch.yml` 里看不到 better-sidebar 行，属正常现象。
- **机器相关值**：`cordis.patch.yml` 里的 `browser.config.executablePath` 是本机 Chrome 路径，
  换机器需相应调整（这是 profile 既有配置，与侧边栏插件无关）。

## 如何在新环境复现

见 [`docs/DSH-UPGRADE-CHECKLIST.md`](../DSH-UPGRADE-CHECKLIST.md) **第 9 节「侧边栏插件环境复现」**
（含 `dsh plugin --profile web add dsh-better-sidebar@0.17.1` 具体命令、bundles 顺序要求、验证步骤）。
