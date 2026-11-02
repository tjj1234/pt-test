# 发布归档只读预检候选 — 交付证据报告

**日期**：2026-10-28  
**目标**：为北极星发布归档（`.tar.gz` / `.tar`）提供独立、纯只读、严格的结构与资源预检候选工具，减轻主 Agent 发布审阅负担；不解包、不执行归档内容、不写 Run/DB、不部署、不联网、不安装任何第三方依赖。  
**交付文件清单（PT 仓库独占 3 文件）**：
1. `scripts/northstar-release-archive-preflight-candidate.py`（只读预检工具实现，提供函数 `inspect_archive` 与 CLI 接口）
2. `tests/regression/release-archive-preflight-candidate-test.py`（35 项全覆盖回归测试套件，**35/35 PASS**）
3. `docs/refactor/evidence/RELEASE-archive-preflight-gemini-20261028.md`（本报告）

---

## 结论优先与设计架构

`northstar-release-archive-preflight-candidate.py` 在归档进入解压或部署管线前充当硬性前置安全门禁。该工具使用 Python 3 标准库，基于**同一只读文件描述符（fd）**连续执行哈希校验与流式 Tar 结构分析，结合底层计数流与路径状态机，彻底杜绝 TOCTOU 路径替换、解压炸弹与目录穿越。

```mermaid
flowchart TD
    A["Archive Path + Expected SHA256"] -->|os.open O_RDONLY + O_NOFOLLOW| B["File Descriptor (fd)<br/>fstat: regular file only"]
    B -->|Chunked Read (64KB)| C["SHA256 Verifier<br/>Max 512MB Archive"]
    C -->|SHA Mismatch / Exceeded| FAIL1["Fail-Closed Error<br/>SHA256_MISMATCH"]
    C -->|SHA Match| D["Rewind fd to 0<br/>(os.lseek, same inode)"]
    D --> E["DecompressionCountingStream<br/>Max 512MB Uncompressed"]
    E --> F["Tar Streaming Header Walker<br/>Max 20,000 members, Max 64MB/member"]
    F -->|Permission / Path / Type Check| G{"Member Inspector"}
    G -->|Symlink / Hardlink / Device| FAIL2["DISALLOWED_MEMBER_TYPE"]
    G -->|Setuid / Setgid / World-Writable| FAIL3["INSECURE_MEMBER_PERMISSIONS"]
    G -->|.. / Absolute / Backslash / Control / Redundant / Conflict| FAIL4["PATH_TRAVERSAL_OR_INVALID / PATH_CONFLICT"]
    G -->|All 35 Checks Pass| PASS["{ ok: true, sha256, members, files, directories, totalRegularBytes }"]
```

---

## 核心安全契约与防护实现

| 安全维度 | 威胁模型 / 边界攻击 | 预检防护实现机制 |
|---|---|---|
| **TOCTOU 路径替换攻击** | 攻击者在哈希校验通过后、解包扫描前替换磁盘文件或篡改符号链接 | 使用 `os.open(..., O_RDONLY | O_NOFOLLOW)` 打开底层文件句柄；`os.fstat(fd)` 确认 `S_ISREG`；**在同一个 fd 上流式计算 SHA256，再通过 `os.lseek(fd, 0, SEEK_SET)` 倒带**，全程不重开路径，物理隔绝路径替换。 |
| **解压炸弹 (Decompression Bomb)** | 少量压缩字节解压出数百 GB 全 0 字符或嵌套无限流，耗尽磁盘或内存 | `DecompressionCountingStream` 包装解压流，每次读取实时累计已解压字节数；一旦超过 `max_uncompressed_bytes`（默认 512 MiB）立即中断；单成员上限 64 MiB，总成员上限 20,000；绝不预先一次性 `read()` 全量数据。 |
| **目录穿越与特殊字符** | 利用 `../`、`/etc/passwd`、`\\`、`NUL` 字符在解压时覆盖系统文件 | 严格检查成员名：拒绝首字符 `/`、拒绝含 `\\`、拒绝任何组件为 `..`、拒绝 ASCII 控制字符（<32 或 127）、拒绝多余斜杠（`//`）与冗余点组件（`/./`）；标准 `./` 前缀归一化后保留。 |
| **恶意文件类型与软硬链接逃逸** | 通过符号链接指向宿主敏感文件，或通过硬链接、FIFO 命名管道阻塞读取 | 严格白名单机制：仅允许常规文件（`isreg()`）与目录（`isdir()`）；符号链接、硬链接、字符/块设备、FIFO 一律判定为 `DISALLOWED_MEMBER_TYPE` 并阻断。 |
| **危险文件权限** | 归档内植入 setuid (`0o4000`)、setgid (`0o2000`) 或全局可写 (`0o0002`) 恶意文件 | 检查每个成员的权限位 `mode`；命中任何上述高危特权位立即判定 `INSECURE_MEMBER_PERMISSIONS` 阻断。 |
| **层级命名冲突与文件覆盖** | 归档中同时存在同名文件与目录，或将普通文件作为父路径（如 `a` 为文件，随后出现 `a/b`） | 维护已遍历的 `files` 与 `directories` 集合，前向追溯祖先路径；一旦检测到文件与目录同名或文件被当作父目录，立即抛出 `PATH_CONFLICT` 或 `PATH_DUPLICATE`。 |
| **零解压落盘保证** | 检查过程中意外解压或写入临时文件 | 全流程仅做内存流式解析，不调用任何 `extract()` 或 `extractall()`，磁盘零新增文件。测试显式断言目录内容未变。 |
| **脱敏与凭据保护** | 错误信息包含内部路径、私有变量或 `PRIVATE_SENTINEL` | 所有异常均映射至固定常量错误码（`ERROR_MESSAGES`），错误回包仅含固定中文说明，绝不透传原始文件名、异常堆栈或敏感 token。 |

---

## 离线回归测试结果（35/35 PASS）

运行 `python3 -B tests/regression/release-archive-preflight-candidate-test.py`：

```
test_absolute_path_rejected (__main__.TestReleaseArchivePreflight.test_absolute_path_rejected) ... ok
test_archive_size_limit_exceeded (__main__.TestReleaseArchivePreflight.test_archive_size_limit_exceeded) ... ok
test_backslash_rejected (__main__.TestReleaseArchivePreflight.test_backslash_rejected) ... ok
test_cli_invocation_failure (__main__.TestReleaseArchivePreflight.test_cli_invocation_failure) ... ok
test_cli_invocation_success (__main__.TestReleaseArchivePreflight.test_cli_invocation_success) ... ok
test_control_character_rejected (__main__.TestReleaseArchivePreflight.test_control_character_rejected) ... ok
test_duplicate_normalized_path_rejected (__main__.TestReleaseArchivePreflight.test_duplicate_normalized_path_rejected) ... ok
test_fifo_member_rejected (__main__.TestReleaseArchivePreflight.test_fifo_member_rejected) ... ok
test_file_and_directory_name_conflict_rejected (__main__.TestReleaseArchivePreflight.test_file_and_directory_name_conflict_rejected) ... ok
test_file_used_as_parent_directory_rejected (__main__.TestReleaseArchivePreflight.test_file_used_as_parent_directory_rejected) ... ok
test_hardlink_member_rejected (__main__.TestReleaseArchivePreflight.test_hardlink_member_rejected) ... ok
test_input_symlink_rejected (__main__.TestReleaseArchivePreflight.test_input_symlink_rejected) ... ok
test_invalid_expected_sha256_format (__main__.TestReleaseArchivePreflight.test_invalid_expected_sha256_format) ... ok
test_member_count_limit_exceeded (__main__.TestReleaseArchivePreflight.test_member_count_limit_exceeded) ... ok
test_member_size_limit_exceeded (__main__.TestReleaseArchivePreflight.test_member_size_limit_exceeded) ... ok
test_non_existent_file_returns_not_found (__main__.TestReleaseArchivePreflight.test_non_existent_file_returns_not_found) ... ok
test_non_tar_garbage_file_rejected (__main__.TestReleaseArchivePreflight.test_non_tar_garbage_file_rejected) ... ok
test_parent_directory_traversal_rejected (__main__.TestReleaseArchivePreflight.test_parent_directory_traversal_rejected) ... ok
test_private_sentinel_in_member_path_not_leaked (__main__.TestReleaseArchivePreflight.test_private_sentinel_in_member_path_not_leaked) ... ok
test_raising_limits_clamped_to_defaults (__main__.TestReleaseArchivePreflight.test_raising_limits_clamped_to_defaults) ... ok
test_redundant_dot_slash_rejected (__main__.TestReleaseArchivePreflight.test_redundant_dot_slash_rejected) ... ok
test_redundant_double_slash_rejected (__main__.TestReleaseArchivePreflight.test_redundant_double_slash_rejected) ... ok
test_setgid_member_rejected (__main__.TestReleaseArchivePreflight.test_setgid_member_rejected) ... ok
test_setuid_member_rejected (__main__.TestReleaseArchivePreflight.test_setuid_member_rejected) ... ok
test_sha256_mismatch_rejected (__main__.TestReleaseArchivePreflight.test_sha256_mismatch_rejected) ... ok
test_symlink_member_rejected (__main__.TestReleaseArchivePreflight.test_symlink_member_rejected) ... ok
test_toctou_path_swapped_after_open_prevented (__main__.TestReleaseArchivePreflight.test_toctou_path_swapped_after_open_prevented) ... ok
test_total_uncompressed_limit_exceeded (__main__.TestReleaseArchivePreflight.test_total_uncompressed_limit_exceeded) ... ok
test_truncated_gzip_rejected (__main__.TestReleaseArchivePreflight.test_truncated_gzip_rejected) ... ok
test_uppercase_sha256_accepted (__main__.TestReleaseArchivePreflight.test_uppercase_sha256_accepted) ... ok
test_valid_archive_with_unicode_and_directories (__main__.TestReleaseArchivePreflight.test_valid_archive_with_unicode_and_directories) ... ok
test_valid_standard_dot_slash_prefix (__main__.TestReleaseArchivePreflight.test_valid_standard_dot_slash_prefix) ... ok
test_valid_uncompressed_tar (__main__.TestReleaseArchivePreflight.test_valid_uncompressed_tar) ... ok
test_world_writable_member_rejected (__main__.TestReleaseArchivePreflight.test_world_writable_member_rejected) ... ok
test_zero_extraction_guarantee (__main__.TestReleaseArchivePreflight.test_zero_extraction_guarantee) ... ok

----------------------------------------------------------------------
Ran 35 tests in 0.063s

OK
```

---

## 语法与规范检查记录
- `python3 -m py_compile scripts/northstar-release-archive-preflight-candidate.py` -> **PASS (0 errors)**
- `python3 -m py_compile tests/regression/release-archive-preflight-candidate-test.py` -> **PASS (0 errors)**
- `git diff --check` -> **PASS (0 errors)**

---

## 边界与限制声明

> [!IMPORTANT]
> 1. **结构与资源验证非代码安全认证**：通过本预检仅代表归档满足哈希完整性、未超出资源上限、不包含恶意穿越路径或提权权限位。**预检通过绝不代表归档内的业务代码、依赖闭包、Python/Node 运行时或 SQL 迁移通过了安全审计或功能验收**。
> 2. **无正式发布批准效力**：本候选脚本为独立的辅助校验工具，不具备正式发布批准权，不修改现行 `scripts/run-regression.mjs`，后续接线与发布门禁仍由主 Agent 全权复核。
