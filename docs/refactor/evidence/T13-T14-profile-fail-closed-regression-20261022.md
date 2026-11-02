# T13/T14 generated profile fail-closed regression — 2026-10-22

**Result: 1/1 PASS.** `tests/regression/t13-t14-profile-fail-closed-test.mjs` builds the current `run-persistent` profile in a temporary DSH home, then checks its generated Cordis patch explicitly disables `tool-skill` and `tool-web`, and its generated dependency contract contains only `@deepseek-ai/dsh-base`. The generated profile manifest covers both `cordis.patch.yml` and `package.json`.

This is a regression guard for the current deny-by-default configuration; it does not prove a DSH process loaded the generated profile, skill release selection/Run pinning, or web search/page fetching. It does not satisfy T13, T14, or AC15 and does not change their status.

Command: `node --test tests/regression/t13-t14-profile-fail-closed-test.mjs` — **1 pass, 0 fail**. No network access or model/tool invocation was performed.

## Required decisions and dependencies

- T13: define the authoritative immutable skill source that a Run loader will consume, and the trusted publisher/disable authorization boundary.
- T14: approve the exact search/read plugin and locked version, permitted outbound network scope, and controlled fake-target/runtime entry point.

Until these boundaries are settled, enabling either DSH tool or adding an unconnected URL guard would not provide a verifiable product path. Next implementation slice should connect the approved source/capability contract to Run admission and loader, then validate the generated profile through a controlled DSH boot.
