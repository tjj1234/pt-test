# candidate-33 draft: catalog diagnostics and T16 closure binding

**DRAFT ONLY — NOT AUTHORIZED FOR DEPLOYMENT.** Candidate-32 is already deployed; this local draft does not authorize a replacement or model request.

Base archive: candidate-32 SHA-256 `c10fccd5fda1a8a5f3b0a8fd2bb16b4517c96a941c988eca0e7dc3704972e7d3`. Candidate-33 draft archive SHA-256 `7507bb696228e1756c5afba2609d0cfde7559a0fefe4825fba59eefe7c70193c`; service SHA-256 `550390488200bb578339a0b792e073f53442f1bfb27d9f367d6ea63fac8c9e13`. The archive is a deterministic USTAR overlay of the frozen base.

Exact source overlays: `shell/server.cjs`, `shell/model-catalog.cjs`, `shell/public/app.js`, `shell/package.json`, `shell/package-lock.json`. Exact additions: `shell/northstar-dependency-closure.cjs` and `shell/dependency-closure-manifest.json`. The T16 manifest binds package.json SHA-256 `db0ff4eef9176f5de58ea1c4bf406baf6cdcde367128f82f072e8d053f7ed518` and package-lock SHA-256 `795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912`; manifest SHA-256 `bec48d7e0eafc6662933f7f1954317c3f68d0c1df7e7d3ad4069d225e5653dbe`. Target gate is Linux/amd64 and Node.js >=22.19.0.

The diagnostic changes keep model routing fail-closed while exposing a bounded catalog state/error code/upstream HTTP status, separating missing credentials from decrypt failure, network/timeout/response errors, and cache write failure. The UI reports the detected category and stops telling users to switch to AUTO when the catalog itself is unknown. The archive also carries the previously reviewed idempotent T11 transient-write retry.

This draft still needs a separate independent package/runbook audit and target-specific evidence before any deployment review. It does not identify why the live candidate-32 instance has no successful user-scoped catalog snapshot; the current live `/api/models` syncError or safe service logs are still needed. No provider request, deployment, or production mutation was performed.
