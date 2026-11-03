#!/bin/sh
set -eu
mkdir -p /work/exact/tests
tar -xzf /input/candidate.tar.gz -C /work/exact
for suite in regression probes helpers; do
 mkdir -p /work/exact/tests/$suite
 cp -R /input/$suite/. /work/exact/tests/$suite/
done
apt-get update
apt-get install -y --no-install-recommends python3
if [ ! -d /work/exact/shell/node_modules ]; then cp -a /dependencies/node_modules /work/exact/shell/node_modules; fi
cd /work/exact
node shell/northstar-dependency-closure.cjs --check shell/dependency-closure-manifest.json
node --test --test-concurrency=1 tests/regression/native-image-http-sdk-test.mjs tests/regression/reasoning-http-sdk-integration-test.mjs tests/regression/source-http-sdk-integration-test.mjs tests/regression/xlsx-http-sdk-integration-test.mjs tests/regression/f2-csv-http-sdk-integration-test.mjs tests/regression/office-http-sdk-integration-test.mjs tests/regression/memory-provenance-store-test.mjs tests/regression/native-tool-run-gate-sdk-test.mjs tests/regression/context-http-sdk-integration-test.mjs tests/regression/skill-http-sdk-integration-test.mjs tests/regression/skill-publication-store-test.mjs tests/regression/published-skill-provider-test.mjs tests/regression/skill-run-snapshot-test.mjs tests/regression/pt-contract-key-status-test.mjs tests/regression/pt-media-http-status-test.mjs tests/regression/f1-managed-media-http-sdk-test.mjs
NORTHSTAR_MEMORY_CHAIN=1 node --test --test-concurrency=1 tests/regression/source-http-sdk-integration-test.mjs
printf '%s\n' '{"status":"R26_EXACT_ARCHIVE_LINUX_PASS","jointTests":23,"memoryTests":1}'
