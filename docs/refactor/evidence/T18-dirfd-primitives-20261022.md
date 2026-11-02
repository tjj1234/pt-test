# T18 dirfd primitives (2026-10-22)

## Scope

Added `shell/runtime/backup-fs.cjs` as an isolated, non-integrated filesystem primitive for a future backup/restore hardening pass. On Linux and Darwin, `pinDirectory()` walks from `/` one component at a time with `openat(O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)`. The returned handle supports relative directory/file opens, exclusive file creation, `mkdirat`, `unlinkat`, `linkat`, and descriptor-based chmod. Paths are one-component validated; non-regular files are rejected. Directory enumeration is enabled only on locally verified 64-bit Darwin using `dup` + `fdopendir` + `readdir`; Linux throws `BACKUP_FS_ENUMERATION_UNSUPPORTED` rather than falling back to path-based traversal because its ABI is not verified in this environment.

## Evidence

`tests/regression/northstar-backup-fs-test.mjs` verifies deterministic rename/replacement after pinning: subsequent file read, mkdir, hardlink publish, chmod, and unlink stay attached to the original directory inode. It also covers symlink/traversal rejection and directory enumeration while the pinned path is renamed and replaced; enumeration returns only entries from the original inode.

Commands: `node --check shell/runtime/backup-fs.cjs`; `node --test tests/regression/northstar-backup-fs-test.mjs`.

Result on Darwin: **3/3 PASS** (Linux-only fail-closed enumeration check is skipped on Darwin); syntax and `git diff --check` pass.

## Limits

The helper is not called by `data-backup.cjs`; the existing walker, hash/copy, archive I/O, and restore still use path-based operations, so it has not fixed the backup/restore TOCTOU exposure. Linux enumeration ABI is unverified and remains fail-closed. Source snapshot consistency, archive creation/verification, restore integration, writer quiescence, signing/encryption, retention, RPO/RTO, operational roles, and target restore remain unimplemented or unverified. T18 and AC24 remain blocked.
