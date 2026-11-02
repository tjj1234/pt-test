# powertokens-video 媒体生成提案评审（2026-10-27）

**决定边界**：复用上游生成引擎可行；北极星保留已有 host 权限/Run/外部操作账本、资格和资产保存边界。用户已明确：**媒体生成仍在 F1**，提案第 3 点“媒体不属于本期收尾”不成立；后移的是思考深度、通用 Skill 发布、压缩和联网搜索。当前只准备并行引擎候选，不启用媒体生产入口，不做付费调用。

## 核查依据

通过 GitHub 连接读取提案仓库固定 commit [`0a601f4e91ae5993ddd275c1446290146bb7a4dd`](https://github.com/tjj1234/powertokens-video/commit/0a601f4e91ae5993ddd275c1446290146bb7a4dd)，核对 `SKILL.md`、`pt_video.py`、`mcp_server.py`、`docs/pitfall-archive.md`、`docs/publish.md` 和 MIT LICENSE。源码 blob：Python 引擎 `7a01e4131e8ea32dbebaa38a674533603debab24`；MCP `c13913f6314c6c28256b6f126ff14be58903a856`。本轮未运行上游代码或真实生成。仓库出片/资产跨账户行为是作者记录的证据，未由主 Agent 独立复验；Seedance 文档还包含后续跨账户成功生成的报告，不能只沿用提案“全部仅到预扣费”的旧口径。

## 正确复用路径

DSH `ctx.skills` / `tool-skill` 负责发现和读取 Skill，**不是 Python 执行入口**。现行 profile 的 `tool-skill`、Bash/文件工具均禁用，因此复制该 Skill 文件夹不会得到可用的生成链。为读 Skill 而开放通用 Bash 会扩大权限面，也会绕过现有 Run 账本。

建议路径：用户请求 → 单个审核固定版本的媒体 Skill/宿主媒体工具 → 已有同 Key 资格/权限/预算 → 宿主按次注入用户凭据调用 Python 引擎 → 提交前 Run intent → 收到任务 ID 立即持久化 → 轮询/取消/未知结果核对 → 受控资产保存 → Run 历史重开。只保留一个生成引擎；现有 JS provider 逐步替换，不让两套 payload/模型路由继续分叉。DSH 可使用隔离 provider 读取唯一固定内置 Skill；不依赖先建设完整的 PM 技能发布平台，也不需要升级 DSH。实际开关、预算和 profile 接线由主 Agent 后续审阅实施。

## 原提案五项缺口

| 缺口 | 接入前必须做什么 | 后续可迭代部分 |
|---|---|---|
| 零单测/轮询无熔断 | 提交/查询离线行为测试；限流、5xx、未知状态分别有界；单调时限、取消、任务 ID 保留 | 更细的退避调优/可观测图表 |
| 错误分类 | 稳定脱敏错误码；403 不直接等于 Key 失效；未知外部结果禁止自动重提 | 文案与更多上游错误样本 |
| BYOK | 源码已证实 `POWERTOKENS_API_KEY` 优先于文件，故不需要再实现相同优先级；产品调用必须显式 key、按次隔离、空 key 不回退全局文件 | 个人 CLI 配置体验 |
| Seedance 协议 UI | 启用该系列前有当前用户的签署引导与明确拒绝；不得用共享本地布尔值或代签 | 更完整引导页面；若首批不宣称支持该系列，可后接该 UI |
| asset 跨账户引用 | 使用 Northstar 侧来源归属/授权校验；默认仅自己的上传可引用，不根据 asset 字符串推断所有权；避免 ID 进入公开分享/日志 | 跨账户协作/共享是另一个产品决定 |

## 源码新增阻断

| 发现 | 证据 | 处理 |
|---|---|---|
| 下载先向结果 URL 发送 BYOK | `pt_video.py:682-701`：`download_binary` 先 `_headers(key)`，失败才匿名下载；结果 URL 不一定是 PT 域名 | 必修。产品模式不下载，复用 Northstar 资产保存器；普通下载也不得带 Key 至结果域名/重定向 |
| 目录失败仍猜模型提交 | `auto_candidates:397-427`：列表为空时返回配置默认或写死 fallback；CLI 生成还有自动换模型 | 产品模式仅接受 host 通过同 Key 资格校验的精确模型，不调用 fallback/auto |
| 不提供耐久任务 ID 的交接点 | `generate_video:808-812`：submit 后立即 poll；MCP `_run` 只在整个子进程结束后拿 combined output | 必须增加 before_submit/on_task_id/on_result 钩子，宿主确认 ID 入账后才轮询；本地停止不冒充远端取消 |
| 空结果也可能成功 | `generate_image:843-864` 无 URL 仅 warning，`_finish_image:1039-1045` 仍 `ok:true`；视频也可把 null URL 输出成功 | 空资产明确失败/结果未知，不生成伪成功消息 |
| 图生图未实现 | `generate_image:839` 明示 `subject_reference` 待实测，当前仅 text-to-image | F1 四类媒体不能据此全部签收。图生图另需确定真实输入契约与引擎适配，不能缩减原验收 |
| 模型/价格是静态启发式 | 名字分型、表格费率和 1080p×2/时长线性，不是当前所有 model×task/计费规则 | 保留 host 资格与 F3 版本化定价，禁止把 CLI 估价当账单 |

源链接：[引擎](https://github.com/tjj1234/powertokens-video/blob/0a601f4e91ae5993ddd275c1446290146bb7a4dd/pt_video.py)、[MCP](https://github.com/tjj1234/powertokens-video/blob/0a601f4e91ae5993ddd275c1446290146bb7a4dd/mcp_server.py)、[踩坑档案](https://github.com/tjj1234/powertokens-video/blob/0a601f4e91ae5993ddd275c1446290146bb7a4dd/docs/pitfall-archive.md)。

## 并行交付与排期

用户授权将独立引擎线交给 Gemini。已准备 `GEMINI-F1-PTVIDEO-ENGINE-HARDENING-PACKAGE-20261027.md`：在固定上游 commit 的临时检出实现补丁，PT 工作区仅新建 patch、Python 离线测试、报告三个文件；不碰主 Agent 的 F3 或任何既有产品文件，不提交远端，不用真实 Key。此包要求实际修复候选，非只写审计。

Gemini 负责引擎产品入口/钩子、轮询与错误、下载凭据修复及离线回归；主 Agent 负责审阅、Python 依赖/版本与产物闭包、DSH/host/Run/预算/凭据/资产/UI 接线、四类任务矩阵与真实验收。主 Agent 当前 F3 顺序可保持；F1 总交付仍有接线和真实媒体验收依赖，不能承诺总工期零影响。

初步工程量仅供排期：引擎候选约 2–4 人日；主 Agent 接线/隔离回归约 1–3 人日；真实四类媒体、Seedance 前置和目标环境验收另需额度/可用模型与样本，无法凭少量作者出片记录给出固定上限。图生图契约若缺，单独列阻断。不能将表内估计简单相加为承诺日期；两条开发线可并行。

当前无需用户重新提供 Key；到真实试验时再确认当时可用的凭据、模型和有界额度，不使用聊天中的旧 Key 盲测。
