import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { planRegressionTests, POSTGRES_REGRESSION_TESTS } from "../../scripts/regression-plan.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const entries = readdirSync(testDir);
const defaultPlan = planRegressionTests(entries);
const postgresPlan = planRegressionTests(entries, "postgres");

assert.deepEqual(postgresPlan, [...POSTGRES_REGRESSION_TESTS].sort());
assert.equal(defaultPlan.some((name) => POSTGRES_REGRESSION_TESTS.includes(name)), false);
assert.equal(defaultPlan.includes("regression-plan-test.mjs"), true);
assert.equal(postgresPlan.includes("t03-external-operation-lock-order-postgres-test.mjs"), true, "real PostgreSQL lock-order suite requires the disposable DB mode");
for (const plan of [defaultPlan, postgresPlan]) {
  assert.equal(new Set(plan).size, plan.length, "a suite must run at most once per mode");
  assert.equal(plan.includes("mock-dsh-runner.mjs"), false, "the helper process is never a test suite");
}
assert.deepEqual(planRegressionTests([...entries, ...entries]), defaultPlan, "duplicate directory entries must not duplicate execution");
assert.throws(() => planRegressionTests(entries, "unknown"), /Unknown regression mode/);
assert.throws(() => planRegressionTests(entries.filter((name) => name !== POSTGRES_REGRESSION_TESTS[0])), /Missing PostgreSQL regression suites/);

console.log("regression-plan-test: PASS");
