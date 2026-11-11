#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
stage=/home/tongjiawan/pt-r34-stage-37930c7
cd "$stage"
[[ ! -e deps-build ]] || { echo DEPENDENCY_BUILD_EXISTS_REQUIRES_REVIEW; exit 1; }
mkdir deps-build
tar -xzf r34-dependency-build-inputs-37930c7.tar.gz -C deps-build
cd deps-build/shell
npm ci --ignore-scripts --include=optional --prefer-offline --no-audit --no-fund
cd ..
node scripts/northstar-dependency-closure.cjs --check shell/dependency-closure-manifest.json
tar -czf "$stage/r34-target-linux-node-modules-20261111.tar.gz" -C shell node_modules
sha256sum "$stage/r34-target-linux-node-modules-20261111.tar.gz"
printf 'R34_TARGET_DEPENDENCY_BUILD_PASS\n'
