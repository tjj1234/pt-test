# T10 FIFO 产物拒绝与HTTP事件循环回归（2026-10-22）

**结果：本地 8/8 PASS；修复了一个会阻塞同步HTTP事件循环的特殊文件打开路径。** 旧实现以同步 `openat(O_RDONLY)` 打开叶子，再用 `fstat` 检查常规文件类型。无 writer FIFO 会在到达类型检查前阻塞。新增 `O_NONBLOCK` 后，FIFO open 可立即返回，`fstat` 拒绝非 regular 文件并映射为404；普通 regular file、symlink、hardlink、父目录替换和租户隔离行为保持通过。

证据：`tests/regression/t10-artifact-openat-nonregular-test.mjs` 在限时子进程中直接调用helper，预期输出 `ARTIFACT_NOT_REGULAR_FILE`；`tests/regression/t10-artifact-tenant-symlink-audit-test.mjs` 通过真实本地shell HTTP/PGlite登录与 `/api/artifact` 请求访问租户工作区中的 FIFO，断言404后 `/healthz` 仍返回 `ok:true`，证明请求失败没有挂住shell事件循环。联合命令：

```bash
node --test tests/regression/t10-artifact-openat-nonregular-test.mjs tests/regression/t10-artifact-tenant-symlink-audit-test.mjs tests/regression/artifact-openat-test.mjs tests/regression/t10-artifact-openat-leaf-race-test.mjs
```

结果为 **8/8 PASS**（Darwin，本机helper + 本地HTTP/PGlite）。此证据不替代目标Linux/koffi行为、生产反向代理、同UID隔离、完整artifact Run归属/持久化/导出验收；T10与AC11仍为partial/untested。修复位于 `shell/runtime/artifact-open.cjs`，应进入下一部署候选；此前candidate-15不含该修复，不能部署。
