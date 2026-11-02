# T10 openat leaf replacement regression — 2026-10-22

**Result: 2/2 PASS on Darwin.** The existing openat coverage already checked static final/intermediate symlinks and hard links, plus deterministic replacement of an opened intermediate directory with a symlink. This additional isolated test closes a distinct local gap: after the parent directory descriptor has been opened, its leaf is replaced with (1) a symlink to another tenant's private file and (2) a hard link to that file. The helper rejects the leaf-open attempt and the multi-link inode respectively.

Command: `node --test tests/regression/t10-artifact-openat-leaf-race-test.mjs` — **2 pass, 0 fail**; `process.platform` reported `darwin`.

This demonstrates behavior of the current Darwin `openat`/`O_NOFOLLOW` helper at a deterministic test hook. It does not verify Linux libc/koffi behavior, arbitrary concurrent scheduling, same-UID isolation, the HTTP route in this specific leaf-race scenario, or full T10/AC11 artifact provenance/export requirements. No shared server path, status matrix, or WORKLOG was changed; no online access or model call occurred.
