# T16 candidate-33 r2 输入绑定独立审计 — 2026-10-23

## 结论

candidate-33 draft-r2 归档的字节内容与六项 T16 发布输入一致：`server.cjs`、`package.json`、`package-lock.json`、`.npmrc`、Arborist 闭包 helper、逐文件 manifest。独立审计同时确认归档只是在冻结 candidate-32 上应用五个已声明覆盖并新增两个 T16 文件；没有从 dirty 工作树整体打包。T16 manifest 的目标为 Linux/amd64，闭包为 472 个生产包、30,091 个文件。此项只证明当前 draft 的输入绑定，不代表候选已通过完整发布/部署验收。

## 复核方式与证据

运行 `python3 scripts/audit-t16-candidate33-r2-input-binding.py`。该只读工具固定 candidate-32 基底 SHA-256 `c10fccd5fda1a8a5f3b0a8fd2bb16b4517c96a941c988eca0e7dc3704972e7d3` 与 candidate-33 r2 归档 SHA-256 `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77`，再逐个比较当前指定输入文件、归档成员和审计常量的 SHA-256。它不遍历或读取整个工作树以构建产物；仅读取上述六个源输入和两个固定归档。

```text
T16_INPUT_BINDING=PASS
REQUIRED_INPUTS=6 exact source/candidate SHA-256 matches
MANIFEST_BINDING=PASS package.json + package-lock.json + .npmrc
CANDIDATE_DELTA=PASS frozen candidate-32 plus 5 declared overlays and 2 T16 additions
TARGET=PASS linux/amd64; packages=472; files=30091
SCOPE=archive-only comparison; no full-worktree packaging
```

当前精确输入哈希：

| 发布输入 | 归档成员 | SHA-256 |
|---|---|---|
| `shell/server.cjs` | `shell/server.cjs` | `64ad1cdc9cc1f7fed1f90ef918f39e8c260eee294d15730715ac766fe9eafe54` |
| `shell/package.json` | `shell/package.json` | `db0ff4eef9176f5de58ea1c4bf406baf6cdcde367128f82f072e8d053f7ed518` |
| `shell/package-lock.json` | `shell/package-lock.json` | `795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912` |
| `shell/.npmrc` | `shell/.npmrc` | `a093bb2fed59d699b7f9a62a5203cc196054c624e9c39c6d908c9e7db5dd2464` |
| `scripts/northstar-dependency-closure.cjs` | `shell/northstar-dependency-closure.cjs` | `e51c4c1b6f6ca45c3f0ee9123249d0fb0a8e541da7cbe2c160c2b2a39e23309b` |
| `docs/refactor/evidence/T16-dependency-closure-linux-amd64-node22.23.4.json` | `shell/dependency-closure-manifest.json` | `bec48d7e0eafc6662933f7f1954317c3f68d0c1df7e7d3ad4069d225e5653dbe` |

The manifest itself binds `package.json`, `package-lock.json`, and `.npmrc` with those same hashes. `.npmrc` is byte-identical in candidate-32 and candidate-33 r2, so it is inherited rather than changed in the five-file overlay set; it remains a required candidate input because npm consumes it and the manifest binds it.

## 后续候选冻结门

Every future candidate must define a reviewed immutable input map and fail closed unless each source hash is pinned and the archive member matches the source bytes. At minimum, bind the six rows above, candidate base archive, unit and runbook. Verify the manifest's three configuration hashes, compare archive membership and all changed bytes with an explicit overlay/addition allowlist, and reject unknown members. Build from a frozen base plus named file inputs; never create a release archive from the dirty working tree or a broad directory walk.

## Base builder `.npmrc` hardening

The initial fix guarded only the r2 wrapper. The same gate now lives in `scripts/package-northstar-candidate33.py`, so r1/r2 and later wrappers using `base.build()` cannot bypass it. The generic builder pins `.npmrc` SHA-256 `a093bb2fed59d699b7f9a62a5203cc196054c624e9c39c6d908c9e7db5dd2464` and checks the workspace source, T16 manifest `evidence.npmrcSha256`, frozen candidate-32 `shell/.npmrc`, and generated candidate member. Any mismatch stops before output writes. `.npmrc` remains unchanged and inherited from the base; the builder validates it as a required T16 input without misclassifying it as a byte-different overlay.

After base-builder hardening, the direct base `--check` still reports its pre-existing stale-output mismatch: the unrevisioned draft archive on disk is SHA-256 `7507bb696228e1756c5afba2609d0cfde7559a0fefe4825fba59eefe7c70193c`, while the current deterministic base build is `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77`. The `.npmrc` gate itself completes before this output comparison; no unrevisioned artifact was rewritten. Revisioned r1 `--check` and r2 `--check` both pass, and the independent binding audit passes. r2 archive SHA-256 remains `bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77`, service SHA-256 `eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105`, and archive membership 325. Candidate archives, deployment ZIP/checklist, and shared application sources were not rewritten. The builder assembles only from the frozen base plus named overlay/addition inputs; this evidence covers local artifact binding, not full release or deployment acceptance.

## Negative drift probes and wrapper coverage

An ephemeral Python fixture imported the base builder and used `unittest.mock` to substitute bytes in memory only; it did not write repository or release files. Four isolated probes each failed closed with the expected reason: (1) workspace `.npmrc` changed, `T16 .npmrc input differs`; (2) manifest `evidence.npmrcSha256` changed while its file hash pin was adjusted for the probe, `T16 manifest is not bound`; (3) candidate-32 archive member changed while its archive SHA pin was adjusted, `frozen candidate-32 shell/.npmrc differs`; (4) generated candidate member readback changed, `generated candidate shell/.npmrc differs`. Result: **4/4 negative drift probes rejected**.

Wrapper routing check: `scripts/package-northstar-candidate33-r1.py:22` and `scripts/package-northstar-candidate33-r2.py:52` both call `base.build()` imported from `scripts/package-northstar-candidate33.py`; neither independently constructs a candidate archive. The r2 wrapper retains its additional local `.npmrc` guard. Therefore the shared base gate executes for both revisioned wrappers.
