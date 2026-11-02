# T03 runner shutdown terminal-state alignment (2026-10-22)

## Finding

The persistent DSH runner emitted `code: RUN_INTERRUPTED` and `canceled: false` during process shutdown. The durable execution service copied the completion code into the terminal event but selected `failed` for every non-cancelled `ok: false` outcome. The Run contract already defines `interrupted` as a terminal state, so the durable Run state contradicted the runner diagnostic.

## Change and verification

`shell/tasks/execution.cjs` now maps either explicit `outcome.interrupted === true` or completion code `RUN_INTERRUPTED` to durable `interrupted`, while preserving normal cancellation precedence and the completion payload. `tests/regression/task-execution-test.mjs` verifies the Run state and terminal `done` diagnostic code. The shutdown fixture in `persistent-runner-parallel-test.mjs` already releases its pending turn on cancellation and verifies the runner frame remains `RUN_INTERRUPTED` with `canceled: false`.

Command: `node --test tests/regression/task-execution-test.mjs tests/regression/persistent-runner-parallel-test.mjs`

Result: **2/2 test files PASS, 0 failures**. The complete default regression then passed **131/131 suites, 0 failures**. `git diff --check` passed.

## Release boundary

Candidate-27 is derived from immutable candidate-26 and overlays only `shell/tasks/execution.cjs`. Archive SHA-256: `91cf2af7a033c89d108b703ca9c39ee085d75f8db988ad44b3b6c808ecca367d`; unit SHA-256: `ea50acb72e28910957273a108cf9c21f5c2e00331933f655615e7ed76769809a`. It has 323 USTAR members, 20 SQL migrations, and no AppleDouble paths. An independent review caught the runbook passing the gzip stream directly to `file`; step 2 now checks the decompressed tar stream. The corrected command was exercised against the actual candidate and returned `POSIX tar archive`; all 8 bash blocks pass `bash -n`. The numbered maintainer runbook is `北极星受控试运行部署命令清单-20261022-candidate-27.md`.

The candidate is not deployed. The fix does not diagnose the target host's `hello` failure; child stdout/stderr and the corresponding Run event are still required. It does not identify the screenshot's media truncation cause or provider charges. No media request was sent. Strict T03/AC03 and full-package acceptance remain incomplete.
