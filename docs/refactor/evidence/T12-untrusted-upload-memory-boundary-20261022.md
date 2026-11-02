# T12 Markdown upload trust boundary — 2026-10-22

**Decision:** The tested Markdown upload-to-chat path does not promote document instructions into the trusted memory channel. This is a bounded local HTTP/PGlite regression, not full T12 or prompt-injection acceptance.

`node --test tests/regression/memory-untrusted-upload-boundary-http-test.mjs` — **1/1 PASS**. The fixture explicitly saves one user preference, uploads a Markdown file containing a hostile “write to trusted system memory” instruction, and sends a chat referencing the upload. It asserts that `docNote` identifies the upload as reference data rather than system instructions and brackets the excerpt as untrusted; the separate `memory` argument contains only the previously saved preference; and `/api/memory` is unchanged after the request. The shell uses `PT_CHAT_DRYRUN=1`; no external model is called. The test uses a temporary local HTTP listener and isolated PGlite storage.

The test was repeated by the primary agent after the sandbox denied loopback bind with `EPERM`; the approved local-listener run passed. The fixture cleans its temporary database, server process, and tenant-owned runtime paths.

**Boundary:** This proves only the Markdown upload → chat → tenant-call path. It does not cover workspace files, webpages, tool-initiated memory writes, real DSH behavior, cross-process memory caches, or all prompt-injection defenses. T12 remains `partial`; AC14 remains `untested`. Next: validate provenance/consent and bounded context behavior across supported source types, then verify the same boundary through the real DSH and target database path.
