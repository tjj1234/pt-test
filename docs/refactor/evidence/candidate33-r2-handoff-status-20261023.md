# candidate-33 draft r2 handoff status

用户已明确授权按 `北极星诊断部署清单-20261023-candidate-33-draft-r2.md` 执行一次受限诊断部署，并已将此前交接版本转给同事。此状态说明随修正版交接包提供，优先于构建期的 [draft evidence](candidate33-model-catalog-diagnostics-draft-r2-20261023.md) 中“NOT AUTHORIZED FOR DEPLOYMENT”的历史声明；授权范围限于该清单中的诊断部署、GET `/api/models` 与必要回滚，不授权聊天/模型生成请求。

修正版清单补齐了切换命令块 `set -euo pipefail`、当前标准 unit/shared env 可读性检查、candidate-32 当前运行路径断言，以及 unit 的 `WorkingDirectory`、两个 `EnvironmentFile`、`ExecStart` 四项精确路径核对；明确切换块任一命令失败或独立 health 步骤失败都必须立即执行回滚块，回滚失败即停止诊断。health 检查与切换命令分成独立步骤，便于逐步回传。候选归档 SHA-256 `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77`；service unit SHA-256 `eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105`。原交接 ZIP 不含完整修订，继续执行前应改用最新修正版 ZIP。

候选仍是诊断构建，目的是安全暴露 `getCatalog()` 内部异常类别；不是已确定具体异常根因的最终修复。执行期间必须每步单独运行、回传脱敏输出，只有成功条件满足后才继续；HTTP 200、health 与 `/api/models` 诊断不构成 T00–T18 或生产验收。
