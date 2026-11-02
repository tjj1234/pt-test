const POSTGRES_TESTS = Object.freeze([
  "t03-external-operation-lock-order-postgres-test.mjs",
  "run-sse-multi-instance-postgres-test.mjs",
  "task-lease-postgres-review-test.mjs",
  "task-store-postgres-integration-test.mjs",
]);

export const REGRESSION_MODES = Object.freeze(["default", "postgres"]);
export const POSTGRES_REGRESSION_TESTS = POSTGRES_TESTS;

export function planRegressionTests(entries, mode = "default") {
  if (!REGRESSION_MODES.includes(mode)) {
    throw new Error(`Unknown regression mode: ${mode}`);
  }

  const files = [...new Set(entries)].filter((name) => name.endsWith(".mjs"));
  const available = new Set(files);
  const missingPostgresTests = POSTGRES_TESTS.filter((name) => !available.has(name));
  if (missingPostgresTests.length) {
    throw new Error(`Missing PostgreSQL regression suites: ${missingPostgresTests.join(", ")}`);
  }

  return files
    .filter((name) => name !== "mock-dsh-runner.mjs")
    .filter((name) => mode === "postgres"
      ? POSTGRES_TESTS.includes(name)
      : !POSTGRES_TESTS.includes(name))
    .sort();
}
