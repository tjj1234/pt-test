'use strict';

// Read-only release gate. Never migrates, grants privileges, or opens PGlite.
const { pgConfigured } = require('../shell/db.cjs');
const { openPg } = require('../shell/db-pg.cjs');
const TABLES = Object.freeze([
  { name: 'agent_question_scopes', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  { name: 'agent_run_questions', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  { name: 'model_request_attempts', privileges: ['SELECT', 'INSERT'] },
]);
const fail = code => Object.assign(new Error(code), { code });

async function inspectRuntimeDatabase(db, { expectedRole, expectedDatabase } = {}) {
  if (!expectedRole || !expectedDatabase) throw fail('RUNTIME_DB_IDENTITY_REQUIRED');
  return db.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    await tx.query("SET LOCAL statement_timeout = '5s'");
    await tx.query("SET LOCAL lock_timeout = '2s'");
    const { rows: [identity] } = await tx.query(`SELECT current_user AS role,
      session_user AS session_role, pg_catalog.current_database() AS database,
      r.rolsuper AS superuser,
      pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS schema_usage
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (!identity || identity.role !== expectedRole || identity.session_role !== expectedRole ||
        identity.database !== expectedDatabase) throw fail('RUNTIME_DB_IDENTITY_MISMATCH');
    if (identity.superuser) throw fail('RUNTIME_DB_SUPERUSER_REJECTED');
    const tables = [];
    for (const table of TABLES) {
      const qualified = `public.${table.name}`;
      if (!identity.schema_usage) {
        tables.push({ table: qualified, ok: false, code: 'SCHEMA_USAGE_REQUIRED' });
        continue;
      }
      const { rows: [relation] } = await tx.query(`SELECT c.oid,
        pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relkind,
        c.relrowsecurity AS rls
        FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($1)`, [qualified]);
      if (!relation || relation.relkind !== 'r') {
        tables.push({ table: qualified, ok: false, code: 'TABLE_REQUIRED' });
        continue;
      }
      const privileges = {};
      for (const privilege of table.privileges) {
        const { rows: [row] } = await tx.query(
          'SELECT pg_catalog.has_table_privilege(current_user,$1::oid,$2) AS allowed',
          [relation.oid, privilege]);
        privileges[privilege] = row.allowed === true;
      }
      // RLS would need a separate functional policy proof; ACL success alone is insufficient.
      const ok = identity.schema_usage && !relation.rls && Object.values(privileges).every(Boolean);
      if (ok) await tx.query(`SELECT * FROM public.${table.name} LIMIT 0`);
      tables.push({ table: qualified, owner: relation.owner, privileges, rls: relation.rls, ok });
    }
    return { ok: tables.every(table => table.ok), scope: 'R34_NEW_TABLE_ACL_ONLY',
      role: identity.role, database: identity.database, schemaUsage: identity.schema_usage, tables };
  });
}

async function main(argv = process.argv.slice(2)) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    if (!['--expect-role', '--expect-database'].includes(key) || flags.has(key) ||
        !value || value.startsWith('--')) throw fail('RUNTIME_DB_USAGE');
    flags.set(key, value);
  }
  if (!flags.get('--expect-role') || !flags.get('--expect-database')) throw fail('RUNTIME_DB_IDENTITY_REQUIRED');
  if (!pgConfigured()) throw fail('RUNTIME_DB_POSTGRES_REQUIRED');
  const connection = await openPg();
  try {
    const result = await inspectRuntimeDatabase(connection.db, {
      expectedRole: flags.get('--expect-role'), expectedDatabase: flags.get('--expect-database'),
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
    return result;
  } finally { await connection.close(); }
}

if (require.main === module) main().catch(error => {
  // Do not emit SQL, DSN, passwords, or raw driver error messages.
  const code = /^RUNTIME_DB_[A-Z_]+$/.test(error.code || '') ? error.code : 'RUNTIME_DB_CHECK_FAILED';
  process.stderr.write(JSON.stringify({ ok: false, code }) + '\n');
  process.exitCode = 1;
});
module.exports = { inspectRuntimeDatabase, main };
