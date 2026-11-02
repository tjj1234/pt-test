import assert from "node:assert/strict";
import { createRequire } from "node:module";

const shellRequire = createRequire(new URL("../../shell/package.json", import.meta.url));
const { initMemory } = shellRequire("./memory.cjs");

function createDb(rows, { transactional = true } = {}) {
  const stats = { pageQueries: 0, pageRows: 0 };
  const db = {
    stats,
    async query(sql, params = []) {
      if (sql.startsWith("SET TRANSACTION")) return { rows: [] };
      if (sql.includes("SELECT COUNT(*) AS total_count")) {
        const count = rows.filter((row) => row.user_id === params[0] && !String(row.key).startsWith("$")).length;
        return { rows: [{ total_count: String(count) }] };
      }
      if (sql.includes("LIMIT $2 OFFSET $3")) {
        const ordered = rows
          .filter((row) => row.user_id === params[0])
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.key.localeCompare(b.key));
        const page = ordered.slice(params[2], params[2] + params[1]);
        stats.pageQueries++;
        stats.pageRows += page.length;
        return { rows: page };
      }
      if (sql.includes("FROM user_memory WHERE user_id = $1 ORDER BY")) {
        return {
          rows: rows
            .filter((row) => row.user_id === params[0])
            .filter((row) => !String(row.key).startsWith("$"))
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.key.localeCompare(b.key)),
        };
      }
      throw new Error(`Unexpected query in memory budget test: ${sql}`);
    },
  };
  if (transactional) db.transaction = (callback) => callback({ query: db.query.bind(db) });
  return db;
}

const rows = [
  { user_id: "u1", key: "a", value: "x", updated_at: "2026-01-03T00:00:00.000Z" },
  { user_id: "u1", key: "b", value: "y", updated_at: "2026-01-02T00:00:00.000Z" },
  { user_id: "u1", key: "large", value: "0123456789", updated_at: "2026-01-01T00:00:00.000Z" },
  { user_id: "u1", key: "z", value: "1", updated_at: "2025-12-31T00:00:00.000Z" },
  { user_id: "u1", key: "emoji", value: "🐙", updated_at: "2025-12-30T00:00:00.000Z" },
  { user_id: "u2", key: "private", value: "other-user", updated_at: "2026-01-04T00:00:00.000Z" },
  { user_id: "u1", key: "$model", value: "internal", updated_at: "2026-01-05T00:00:00.000Z" },
];
const memory = await initMemory(createDb(rows));

// Each `a=x` / `b=y` row costs 4 prefix code units + 3 content units;
// the second row adds one newline, so the final formatted text is exactly 15.
const exactFormattedBudget = await memory.memorySnapshot("u1", { maxChars: 15 });
assert.deepEqual(exactFormattedBudget.lines, ["a=x", "b=y"]);
assert.equal(exactFormattedBudget.includedChars, 15);
assert.equal(exactFormattedBudget.includedChars, exactFormattedBudget.maxChars);

const underFormattedBudget = await memory.memorySnapshot("u1", { maxChars: 14 });
assert.deepEqual(underFormattedBudget.lines, ["a=x"]);
assert.equal(underFormattedBudget.includedChars, 7);

// A too-large newer row is omitted while a later, shorter row still fits.
const laterMemory = await initMemory(createDb([
  { user_id: "u1", key: "large", value: "0123456789", updated_at: "2026-01-02T00:00:00.000Z" },
  { user_id: "u1", key: "z", value: "1", updated_at: "2026-01-01T00:00:00.000Z" },
]));
const laterShortBudget = await laterMemory.memorySnapshot("u1", { maxChars: 7 });
assert.deepEqual(laterShortBudget.lines, ["z=1"]);
assert.equal(laterShortBudget.includedChars, 7);
assert.equal(laterShortBudget.omittedCount, 1);

// No row may be selected if even the shortest formatted line exceeds the cap.
const zeroIncluded = await memory.memorySnapshot("u1", { maxChars: 5 });
assert.deepEqual(zeroIncluded.lines, []);
assert.equal(zeroIncluded.includedChars, 0);
assert.equal(zeroIncluded.omittedCount, 5);

// JS string length counts the emoji as two UTF-16 code units: `u=🐙` is four
// raw units and costs eight after adding the four-unit prefix.
const unicodeMemory = await initMemory(createDb([
  { user_id: "u1", key: "u", value: "🐙", updated_at: "2026-01-01T00:00:00.000Z" },
]));
const unicodeBudget = await unicodeMemory.memorySnapshot("u1", { maxChars: 8 });
assert.deepEqual(unicodeBudget.lines, ["u=🐙"]);
assert.equal(unicodeBudget.includedChars, 8);
assert.ok(unicodeBudget.includedChars <= unicodeBudget.maxChars);

// A row that consumes the whole budget stops later value-page reads; the
// count remains exact without fetching every row's key/value text.
const manyRows = Array.from({ length: 150 }, (_, index) => ({
  user_id: "u1",
  key: index === 0 ? "k" : `k${index}`,
  value: index === 0 ? "x".repeat(3994) : "later",
  updated_at: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
}));
const pagedDb = createDb(manyRows);
const pagedMemory = await initMemory(pagedDb);
const fullBudget = await pagedMemory.memorySnapshot("u1");
assert.equal(fullBudget.includedChars, 4000);
assert.equal(fullBudget.totalCount, 150);
assert.equal(fullBudget.omittedCount, 149);
assert.equal(pagedDb.stats.pageQueries, 1);
assert.equal(pagedDb.stats.pageRows, 64);

// Existing callers still receive the original array of raw `key=value` lines.
const lines = await memory.memoryLines("u1", { maxChars: 15 });
assert.ok(Array.isArray(lines));
assert.deepEqual(lines, ["a=x", "b=y"]);
assert.ok(lines.every((line) => typeof line === "string"));
const queryOnlyMemory = await initMemory(createDb([
  { user_id: "u1", key: "legacy", value: "adapter", updated_at: "2026-01-01T00:00:00.000Z" },
], { transactional: false }));
assert.deepEqual(await queryOnlyMemory.memoryLines("u1"), ["legacy=adapter"]);

// Exercise transaction isolation, SQL paging, and the count query against the
// actual PGlite adapter rather than only the query mock above.
const { PGlite } = shellRequire("@electric-sql/pglite");
const pglite = new PGlite();
await pglite.waitReady;
try {
  await pglite.exec(`CREATE TABLE user_memory (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, key)
  )`);
  await pglite.query("INSERT INTO user_memory (user_id,key,value,updated_at) VALUES ($1,$2,$3,$4),($1,$5,$6,$7)", [
    "u1", "a", "x", "2026-01-02T00:00:00.000Z", "b", "y", "2026-01-01T00:00:00.000Z",
  ]);
  const pgliteMemory = await initMemory(pglite);
  const pgliteSnapshot = await pgliteMemory.memorySnapshot("u1", { maxChars: 15 });
  assert.deepEqual(pgliteSnapshot.lines, ["a=x", "b=y"]);
  assert.equal(pgliteSnapshot.includedChars, 15);
  assert.equal(pgliteSnapshot.totalCount, 2);
} finally {
  await pglite.close();
}

console.log("memory-context-budget-test: focused assertions passed (mock + PGlite)");
