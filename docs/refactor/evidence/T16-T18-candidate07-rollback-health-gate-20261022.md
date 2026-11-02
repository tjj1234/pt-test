# T16/T18 candidate-07 rollback health gate (2026-10-22)

## Finding and change

The candidate-07 deploy success gate requires `northstar-shell` active plus both local and public HTTPS `/healthz` responses containing `ok:true` ([candidate-07 checklist](../北极星受控试运行部署命令清单-20261022-candidate-07.md):75-87). Its rollback branch restored the previous unit and checked `is-active` and only the local endpoint; it could therefore label a rollback healthy while the public reverse-proxy path remained broken. The rollback branch now probes `https://agent-fat.adorado.top/healthz` too, and explicitly treats either failed health check as incomplete recovery: do not send model traffic, retain release and unit backup, and report diagnostics ([same checklist](../北极星受控试运行部署命令清单-20261022-candidate-07.md):89-98).

This is a runbook correctness fix only. It adds no new deployment operation and does not claim that the rollback was executed.

## Validation

- Markdown/code-fence structure and the rollback command block were statically inspected.
- Scoped `git diff --check` passed for the runbook and this evidence file.
- No SSH, server, model, or browser operation was performed.

## Boundary and next dependency

This strengthens a health gate for the candidate's unit rollback only. It does not restore or reverse database migrations, application data/files, BYOK master keys, or other external services; it is not T18 recovery/rollback acceptance. The rollback gate still requires execution by the maintainer on the target host and recording both health results. T16/T18 and AC19/20/24 remain at their recorded states pending frozen-candidate target checks, real upgrade/restore/rollback, and independent delivery acceptance.
