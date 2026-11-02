'use strict';
const { openPg, pgConfigured } = require(process.cwd() + '/db-pg.cjs');
let connection;
(async () => {
  if (!pgConfigured(process.env)) throw Object.assign(new Error(), { code: 'PG_NOT_CONFIGURED_STOP' });
  connection = await openPg({ ...process.env, PT_PG_POOL_MAX: '1', PT_PG_CONNECT_TIMEOUT_MS: '5000' });
  const counts = await connection.db.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    await tx.query("SET LOCAL statement_timeout = '5s'");
    return (await tx.query(`
      SELECT 'agent_runs' AS source, state AS status, count(*)::int AS count
      FROM agent_runs WHERE state IN ('queued','running','waiting_external','cancelling') GROUP BY state
      UNION ALL
      SELECT 'run_external_operations' AS source, status, count(*)::int AS count
      FROM run_external_operations WHERE status IN ('submitting','querying') GROUP BY status
      ORDER BY source,status
    `)).rows;
  });
  console.log(JSON.stringify({ backend: 'postgresql', idle: counts.length === 0, counts }));
})().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'IDLE_CHECK_FAILED';
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
}).finally(async () => {
  if (connection) {
    try { await connection.close(); } catch { console.error('{"ok":false,"code":"DB_CLOSE_FAILED"}'); process.exitCode = 1; }
  }
});
