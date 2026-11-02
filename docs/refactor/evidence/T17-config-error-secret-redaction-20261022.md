# T17 configuration error disclosure probe — 2026-10-22

## Result

Expanded the isolated real-adapter negative fixture so a hand-declared provider configuration includes a synthetic API key but omits `baseURL`. The installed `@deepseek-ai/dsh-llm-pi-ai` adapter throws during `apply()`, with provider/model context in the error, while neither the error message nor stack contains the synthetic key. This is a bounded local improvement to AC23's “configuration failure is visible” and “logs do not disclose secrets” requirements.

## Reproduction

`node --test tests/regression/t17-profile-dependency-config-test.mjs` — 2/2 passed (lock/installed-version consistency and missing-endpoint failure disclosure with key redaction assertion). `git diff --check -- tests/regression/t17-profile-dependency-config-test.mjs` — passed.

## Limits and next work

This probes DSH adapter construction only. It does not prove Northstar surfaces the rejection in `settings.mutate`/Web Models, nor that runtime logs redact all provider errors. No source/owner/verified-at/expiry matrix exists for all external dependency values, and no media output domain was fetched. AC23/T17 remain incomplete. Product/operations owners need to provide responsible owner and authoritative source for externally managed endpoint/domain values where repository evidence cannot establish them; we should not infer those values.

