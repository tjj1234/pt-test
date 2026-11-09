#!/bin/sh
set -eu
umask 022
ARCHIVE=/input/release-artifacts/northstar-controlled-trial-20261109-candidate-34-r34-auto08-m1-draft.tar.gz
node -e 'const fs=require("node:fs"),c=require("node:crypto");const p=process.argv[1],h=c.createHash("sha256").update(fs.readFileSync(p)).digest("hex");if(h!=="70361b6ed893ae440650e3d7dce37058efa0633ea7f1b8f936b91026d359ee5d")throw Error("ARCHIVE_SHA_MISMATCH");console.log(JSON.stringify({archiveSha256:h,node:process.version,platform:process.platform,arch:process.arch}));' "$ARCHIVE"
mkdir -p /work/exact
tar -xzf "$ARCHIVE" -C /work/exact
cp -R /input/tests /work/exact/tests
cp -R /input/scripts /work/exact/scripts
cd /work/exact/shell
npm ci --include=dev --no-audit --no-fund
cd /work/exact
node shell/northstar-dependency-closure.cjs --check shell/dependency-closure-manifest.json
node --check shell/public/app.js
node --check shell/server.cjs
node --test tests/regression/batch1-bugfix-test.mjs tests/regression/batch2-bugfix-test.mjs tests/regression/batch3-bugfix-test.mjs tests/regression/batch4-bugfix-test.mjs tests/regression/batch5-followup-test.mjs tests/regression/reasoning-native-runner-test.mjs tests/regression/ui-model-switch-test.mjs tests/regression/ui-media-authorization-test.mjs tests/regression/skill-http-sdk-integration-test.mjs tests/regression/memory-provenance-store-test.mjs tests/regression/native-tool-run-gate-sdk-test.mjs tests/regression/questions-authority-store-test.mjs tests/regression/questions-http-sdk-integration-test.mjs tests/regression/dsh-cli-profile-ready-test.mjs tests/regression/f1-native-model-switch-intent-test.mjs
node --test tests/regression/auto08-attempt-authority-test.mjs tests/regression/auto08-route-policy-test.mjs
AUTO08_POLICY_TEST=1 node --test tests/regression/questions-http-sdk-integration-test.mjs
printf 'R34_EXACT_LINUX_VALIDATION_PASS\n'
