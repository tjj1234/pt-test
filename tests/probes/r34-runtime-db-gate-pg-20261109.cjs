'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openPg } = require('../../shell/db-pg.cjs');
const { inspectRuntimeDatabase } = require('../../scripts/northstar-runtime-db-gate.cjs');

(async () => {
  const database = process.env.PT_PG_DATABASE;
  if (database !== 'r34_gate_fixture' || process.env.PT_PG_HOST !== '127.0.0.1') {
    throw Error('Isolated localhost r34_gate_fixture database required');
  }
  const admin = await openPg();
  let runtime;
  try {
    await admin.db.exec(`CREATE ROLE r34_gate_runtime LOGIN;
      REVOKE USAGE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO r34_gate_runtime;
      CREATE TABLE public.agent_runs (run_id UUID PRIMARY KEY)`);
    for (const name of ['029_user_questions.sql', '030_model_request_attempts.sql']) {
      await admin.db.exec(fs.readFileSync(path.join(__dirname, '../../shell/db-migrations', name), 'utf8'));
    }
    runtime = await openPg({ ...process.env, PT_PG_DSN: '', PT_PG_USER: 'r34_gate_runtime' });
    const identity = { expectedRole: 'r34_gate_runtime', expectedDatabase: database };
    const audit = () => inspectRuntimeDatabase(runtime.db, identity);
    let result = await audit();
    assert.equal(result.ok, false);
    assert.ok(result.tables.every(t => Object.values(t.privileges).every(v => !v)));
    console.log('PASS: administrator migrations leave runtime ACL gate closed');
    await admin.db.exec(`GRANT SELECT,INSERT,UPDATE ON public.agent_question_scopes,
      public.agent_run_questions TO r34_gate_runtime`);
    result = await audit();
    assert.equal(result.ok, false);
    assert.ok(result.tables.slice(0, 2).every(t => t.ok));
    console.log('PASS: question grants alone do not mask missing AUTO attempt privileges');
    await admin.db.exec('GRANT SELECT,INSERT ON public.model_request_attempts TO r34_gate_runtime');
    assert.equal((await audit()).ok, true);
    assert.equal((await audit()).ok, true);
    console.log('PASS: exact necessary grants pass repeatedly as actual runtime login');
    const cli = spawnSync(process.execPath, [path.join(__dirname, '../../scripts/northstar-runtime-db-gate.cjs'),
      '--expect-role', 'r34_gate_runtime', '--expect-database', database], {
      env: { ...process.env, PT_PG_DSN: '', PT_PG_USER: 'r34_gate_runtime' }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).ok, true);
    console.log('PASS: actual read-only CLI exits 0 with matching runtime credentials');
    await assert.rejects(inspectRuntimeDatabase(admin.db, {
      expectedRole: 'postgres', expectedDatabase: database,
    }), { code: 'RUNTIME_DB_SUPERUSER_REJECTED' });
    await assert.rejects(inspectRuntimeDatabase(runtime.db, {
      ...identity, expectedRole: 'wrong_role',
    }), { code: 'RUNTIME_DB_IDENTITY_MISMATCH' });
    await assert.rejects(inspectRuntimeDatabase(runtime.db, {
      ...identity, expectedDatabase: 'wrong_database',
    }), { code: 'RUNTIME_DB_IDENTITY_MISMATCH' });
    console.log('PASS: superuser, wrong role and wrong database cannot pass');
    await admin.db.exec('REVOKE UPDATE ON public.agent_run_questions FROM r34_gate_runtime');
    assert.equal((await audit()).ok, false);
    await admin.db.exec('GRANT UPDATE ON public.agent_run_questions TO r34_gate_runtime');
    await admin.db.exec('ALTER TABLE public.agent_run_questions ENABLE ROW LEVEL SECURITY');
    assert.equal((await audit()).ok, false);
    await admin.db.exec('ALTER TABLE public.agent_run_questions DISABLE ROW LEVEL SECURITY');
    console.log('PASS: revoked write privilege and unproven RLS policy close gate');
    await admin.db.exec('REVOKE USAGE ON SCHEMA public FROM r34_gate_runtime');
    assert.equal((await audit()).ok, false);
    await admin.db.exec('GRANT USAGE ON SCHEMA public TO r34_gate_runtime');
    for (const table of ['agent_question_scopes', 'agent_run_questions', 'model_request_attempts']) {
      const { rows: [row] } = await admin.db.query(`SELECT count(*)::int AS count FROM public.${table}`);
      assert.equal(row.count, 0);
    }
    console.log('PASS: schema denial rejected; gate wrote zero business rows');
    await admin.db.exec('DROP TABLE public.model_request_attempts');
    result = await audit();
    assert.equal(result.ok, false);
    assert.equal(result.tables[2].code, 'TABLE_REQUIRED');
    console.log('PASS: missing migration table rejected without creating it');
  } finally {
    if (runtime) await runtime.close();
    await admin.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
