"use strict";
/**
 * A7 · 统一验收：A0→A6 门禁串联
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const tests = [
  "business/attribution/contracts/validate.js",
  "tests/attribution/a1-parsers.test.js",
  "tests/attribution/a2-persistence.test.js",
  "tests/attribution/a3-a6-workflows.test.js",
  "tests/attribution/wire-funnel-collect.test.js",
  "tests/attribution/part1-policy.test.js",
];

const results = [];
for (const t of tests) {
  const r = spawnSync(process.execPath, [path.join(ROOT, t)], {
    encoding: "utf8",
    cwd: ROOT,
  });
  results.push({
    test: t,
    ok: r.status === 0,
    status: r.status,
    stderr: (r.stderr || "").slice(0, 400),
  });
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
  }
}

const ok = results.every((x) => x.ok);
const report = {
  ok,
  slice: "A7",
  a8Approved: false,
  productionSeedAllowed: false,
  clientTenantTrusted: false,
  secondDbConnectionAllowed: false,
  shellModified: false,
  results,
};
console.log(JSON.stringify(report, null, 2));
process.exit(ok ? 0 : 1);
