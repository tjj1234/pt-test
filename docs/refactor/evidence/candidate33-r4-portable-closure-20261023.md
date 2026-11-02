# candidate-33 r4 portable dependency closure — 2026-10-23

## 结论与边界

冻结 r3 在新鲜 Linux/amd64 安装后的 closure `--check` 返回 `MANIFEST_MISMATCH`；临时重建清单定位唯一差异为 `@deepseek-ai/dsh` 本地 tarball 的 `resolved` 记录含原构建目录绝对路径。r3 因此保持发布阻断。未来 r4 的 helper 将该本地来源写为锁文件相对 spec `file:vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz`，同时对实际文件同源、普通文件、项目内路径、锁身份/integrity 和安装包逐文件 SHA 保持验证；registry 来源不变。

## 输入与复核

| 输入 | SHA-256 |
|---|---|
| 冻结 candidate-33 r2 归档 | `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77` |
| portable closure helper 源码 | `9f5ffe4bf45c0174474ac3c4d1b86f5e7d1253af8d01c7fac6fb6f92b9889ad8` |
| portable manifest | `88203b2c8606c790aa901366225fc1b029727e62b2e18d4f9c4a45ef878f2eaa` |
| `shell/package-lock.json` | `795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912` |

在一次性 `node:22-bookworm-slim` 容器中强制 `--platform linux/amd64`，从冻结 r2 归档分别解包到 `/work-a` 与 `/different/work-b`，将上述 helper 与 manifest 覆盖到各自 `shell/`。每个目录单独执行 `npm ci --no-audit --no-fund`，随后运行 `node northstar-dependency-closure.cjs --check dependency-closure-manifest.json`；未复制第一个目录的 `node_modules` 给第二个目录。

| 安装根 | Node/平台 | npm ci | closure --check |
|---|---|---|---|
| `/work-a` | v22.23.4, linux/x64 | 621 packages，clean install | PASS：472 production packages、30,091 files、Arborist 8.0.5 |
| `/different/work-b` | v22.23.4, linux/x64 | 621 packages，clean install | PASS：472 production packages、30,091 files、Arborist 8.0.5 |

锁文件哈希两次均为 `795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912`；`generatedWithNode` 与 `checkedWithNode` 均为 v22.23.4。定向 helper 回归 `tests/regression/t16-dependency-closure-manifest-test.cjs` **12/12 PASS**。另从已生成的 r4 归档在模拟 immutable release 路径独立新鲜安装，包内 closure `--check` 再次 **PASS**（472 packages / 30,091 files）；r4 builder可复现检查与独立T16四成员审计均PASS。三个容器运行完成后销毁，没有修改冻结 r2/r3 归档或目标机；没有 PT 目录/聊天/付费模型请求。这些本地证据不代表目标机安装、目录同步或聊天能力已通过。
