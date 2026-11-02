# candidate-20 包验证（2026-10-22）

candidate-20 从 candidate-19 固定归档 `b433ec44795c455bcf40a83f8d5ecefd9181d25e0f40fc1e1688d4d65fd0eb1c` 更新记忆取消 helper 一个文件，并重封 USTAR。原因：排队 Run 尚未发送记忆到上游，应保留；只取消已进入 `running`、`waiting_external`、`awaiting_confirmation` 或 `cancelling` 的用户 Run。工作区仍未提交，因此候选绑定的是当前快照。

| 产物 | SHA-256 |
|---|---|
| `release-artifacts/northstar-controlled-trial-20261022-candidate-20.tar.gz` | `4bc1f95b3f4797764fd33212171f1b98e6130dd37f4dd1342e4512d644b6dfbc` |
| `release-artifacts/northstar-shell-candidate-20.service` | `aaa52f886c2ef577b75f62c39aa7fb4bbeceac38ce3da08b38750264f0a06046` |

`tests/regression/t16-candidate19-ustar-release-test.mjs` 中的 candidate-20 断言核对上述 checksum、322 个 USTAR 成员和归档内 helper 与源码逐字节一致，并确认取消状态不含 `queued`；该文件 3/3 PASS。记忆 Run 取消集成测试已改为同时创建一个 running Run 和一个 queued Run，确认仅 running Run 进入 `cancelled`，queued Run 保持 `queued`；专测通过。目标环境多实例传播、真实 PT 取消行为、部署及一次真实模型验证仍未执行。
