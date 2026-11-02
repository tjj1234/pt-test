# candidate-33 draft r4: portable catalog diagnostics closure

基底为冻结 candidate-33 r2，归档 SHA-256 `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77`。本地草稿仅覆盖四个运行成员：catalog failure-stage 的两个源码文件，以及已修复本地 `file:` source 路径可移植性的 closure helper 与 Linux/amd64 manifest。

| 文件 | SHA-256 |
|---|---|
| `release-artifacts/northstar-controlled-trial-20261023-candidate-33-draft-r4.tar.gz` | `665ad991cb38f3f00fecf1c463a83c02319e5fe2e29a8e9829ae2e3fd3a79f4c` |
| `release-artifacts/northstar-shell-candidate-33-draft-r4.service` | `ee7f9118190278ea0c7289eb70d94c754191a30f58152bf33e10841f1a8fe772` |
| failure-stage patch | `8e2a1fa7e4483eef6b54fa19658657b7690e2ef39ce0770e00a978dc16687e8f` |
| portable closure helper | `9f5ffe4bf45c0174474ac3c4d1b86f5e7d1253af8d01c7fac6fb6f92b9889ad8` |
| portable closure manifest | `88203b2c8606c790aa901366225fc1b029727e62b2e18d4f9c4a45ef878f2eaa` |

r2 共 325 个归档成员，overlay 仅修改 `shell/server.cjs`、`shell/model-catalog.cjs`、`shell/northstar-dependency-closure.cjs`、`shell/dependency-closure-manifest.json`；其余 321 个成员逐字节继承。目标固定 Linux/amd64，Node.js >=22.19.0，Arborist 8.0.5、semver 7.8.5；manifest 记录 472 个生产包与 30,091 个文件。portable helper/manifest 在两个不同绝对根完成 Linux/amd64 clean `npm ci` + closure `--check`，2/2 PASS；r4完整归档在模拟immutable release路径独立clean install + 包内closure `--check` 亦PASS，均为472 packages / 30,091 files。独立归档审计 `scripts/audit-t16-candidate33-r4.py` PASS。

这是不可部署的本地 draft。最终runbook与handoff ZIP尚未绑定，目标机实际r2 systemd配置/回滚映射尚未取得；本builder不执行安装、部署或发送产物。candidate-33 r2/r3与既有交接包保持冻结。
