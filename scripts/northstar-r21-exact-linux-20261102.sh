#!/bin/sh
set -eu
mkdir -p /work/exact/tests
tar -xzf /input/candidate.tar.gz -C /work/exact
for suite in regression probes helpers; do
 mkdir -p /work/exact/tests/$suite
 cp -R /input/$suite/. /work/exact/tests/$suite/
done
if [ ! -d /work/exact/shell/node_modules ]; then cp -a /dependencies/node_modules /work/exact/shell/node_modules; fi
cd /work/exact
node shell/northstar-dependency-closure.cjs --check shell/dependency-closure-manifest.json
node --test --test-concurrency=1 tests/regression/reasoning-http-sdk-integration-test.mjs tests/regression/source-http-sdk-integration-test.mjs tests/regression/xlsx-http-sdk-integration-test.mjs tests/regression/f2-csv-http-sdk-integration-test.mjs tests/regression/office-http-sdk-integration-test.mjs tests/regression/memory-provenance-store-test.mjs tests/regression/native-tool-run-gate-sdk-test.mjs tests/regression/context-http-sdk-integration-test.mjs
NORTHSTAR_MEMORY_CHAIN=1 node --test --test-concurrency=1 tests/regression/source-http-sdk-integration-test.mjs
printf '%s\n' '{"status":"R21_EXACT_ARCHIVE_LINUX_PASS","jointTests":8,"memoryTests":1}'
