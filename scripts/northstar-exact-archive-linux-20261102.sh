#!/bin/sh
set -eu
mkdir -p /work/exact
tar -xzf /input/candidate.tar.gz -C /work/exact
cp -R /input/tests /work/exact/tests
cd /work/exact/shell
npm ci --include=dev --no-audit --no-fund
cd /work/exact
node shell/northstar-dependency-closure.cjs --check shell/dependency-closure-manifest.json
node --test tests/regression/reasoning-http-sdk-integration-test.mjs tests/regression/source-http-sdk-integration-test.mjs tests/regression/xlsx-http-sdk-integration-test.mjs tests/regression/f2-csv-http-sdk-integration-test.mjs tests/regression/office-http-sdk-integration-test.mjs tests/regression/memory-provenance-store-test.mjs tests/regression/native-tool-run-gate-sdk-test.mjs
NORTHSTAR_MEMORY_CHAIN=1 node --test tests/regression/source-http-sdk-integration-test.mjs
