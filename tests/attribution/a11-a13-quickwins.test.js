"use strict";
/** A11/A13 冒烟：wrapCollectQueue 可加载；schema SQL 含 RLS */
const fs = require("node:fs");
const path = require("node:path");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = path.join(__dirname, "..", "..");
const schema = fs.readFileSync(
  path.join(root, "business/attribution/schema/a2_raw_dlq.sql"),
  "utf8"
);
assert(/FORCE ROW LEVEL SECURITY/.test(schema), "missing FORCE RLS");
assert(/CREATE POLICY tenant_isolation ON attribution_raw_events/.test(schema), "raw policy");
assert(/CREATE POLICY tenant_isolation ON attribution_event_dlq/.test(schema), "dlq policy");

const { wrapCollectQueue } = require("../../analytics/backend/collect/deps.cjs");
assert(typeof wrapCollectQueue === "function", "wrapCollectQueue export");

const fakeQueue = {
  enqueue: async () => true,
  dequeue: async () => null,
  ack: async () => {},
  moveToDlq: async () => {},
  pendingCount: () => 0,
  deadCount: () => 0,
};
const fakePool = {
  query: async () => ({ rows: [] }),
  connect: async () => ({
    query: async () => ({ rows: [] }),
    release() {},
  }),
};
const wrapped = wrapCollectQueue(fakeQueue, fakePool, () => {}, async () => "ws_x");
assert(typeof wrapped.enqueue === "function", "wrapped enqueue");
assert(typeof wrapped.moveToDlq === "function", "wrapped moveToDlq");

const depsSrc = fs.readFileSync(path.join(root, "analytics/lib/deps.cjs"), "utf8");
assert(/wrapCollectQueue/.test(depsSrc), "lib/deps wires wrapCollectQueue");

console.log(JSON.stringify({ ok: true, a11: true, a13: true }, null, 2));
