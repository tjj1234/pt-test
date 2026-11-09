'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openPg } = require('../../shell/db-pg.cjs');
const { runtimePgEnvironment, collectQuestionPermissions } = require('../../scripts/northstar-r33-readonly-diagnostic.cjs');

(async () => {
  assert.equal(process.env.PT_PG_HOST, '127.0.0.1');
  assert.equal(process.env.PT_PG_PORT, '65011');
  assert.equal(process.env.R33_DIAG_FIXTURE, '1');
  const admin = await openPg(); let runtime;
  try {
    await admin.db.exec(`CREATE ROLE r33_diag_runtime LOGIN;
      REVOKE USAGE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO r33_diag_runtime;
      CREATE TABLE public.agent_runs(run_id UUID PRIMARY KEY,state TEXT,revision INTEGER,request JSONB);
      ALTER TABLE public.agent_runs OWNER TO r33_diag_runtime;
      CREATE TABLE public.schema_migrations(name TEXT PRIMARY KEY);
      GRANT SELECT ON public.schema_migrations TO r33_diag_runtime;
      INSERT INTO public.schema_migrations VALUES('029_user_questions.sql');
      INSERT INTO public.agent_runs VALUES('58653c59-d6ad-49e2-8846-134bfaad1b0c','failed',1,
        '{"prompt":"SYNTHETIC_PRIVATE_PROMPT"}')`);
    await admin.db.exec(fs.readFileSync(path.join(__dirname, '../../shell/db-migrations/029_user_questions.sql'), 'utf8'));
    runtime = await openPg({ ...process.env, PT_PG_DSN: '', PT_PG_USER: 'r33_diag_runtime' });
    const identity = { expectedRole: 'r33_diag_runtime', expectedDatabase: 'northstar' };
    let result = await collectQuestionPermissions(runtime.db, identity);
    assert.equal(result.aclSufficient, false);
    assert.equal(result.questionMigrationRecorded, true);
    assert.equal(result.tables.find(t => t.table === 'agent_runs').owner, 'r33_diag_runtime');
    assert.equal(result.tables.find(t => t.table === 'agent_run_questions').owner, 'postgres');
    assert.equal(result.runs[0].state, 'failed');
    assert.equal(result.questionCounts, null);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_PROMPT'));
    console.log('PASS: runtime identity, migration and ownership mismatch visible; missing ACL reported; no prompt read/output');
    await admin.db.exec('GRANT SELECT,INSERT,UPDATE ON public.agent_run_questions,public.agent_question_scopes TO r33_diag_runtime');
    result = await collectQuestionPermissions(runtime.db, identity);
    assert.equal(result.aclSufficient, true); assert.deepEqual(result.questionCounts, []);
    await assert.rejects(collectQuestionPermissions(runtime.db, { ...identity, expectedRole: 'wrong' }),
      { code: 'R33_DIAG_RUNTIME_IDENTITY_MISMATCH' });
    console.log('PASS: necessary grants change diagnosis; wrong role rejected');
    const parsed = runtimePgEnvironment(Buffer.from('PT_PG_HOST=127.0.0.1\0PT_PG_USER=r33_diag_runtime\0PT_PG_DATABASE=northstar\0PT_PG_PASSWORD=SYNTHETIC_SECRET\0OPENAI_API_KEY=EXCLUDED\0NODE_OPTIONS=EXCLUDED'));
    assert.equal(parsed.env.PT_PG_PASSWORD, 'SYNTHETIC_SECRET');
    assert.equal(parsed.env.OPENAI_API_KEY, undefined); assert.equal(parsed.env.NODE_OPTIONS, undefined);
    assert.throws(() => runtimePgEnvironment(Buffer.from('PT_PG_HOST=a\0PT_PG_HOST=b')), { code: 'R33_DIAG_ENV_AMBIGUOUS' });
    assert.throws(() => runtimePgEnvironment(Buffer.from('PT_PG_HOST=a\0PGOPTIONS=-c role=other')), { code: 'R33_DIAG_CONNECTION_IDENTITY_UNSUPPORTED' });
    assert.throws(() => runtimePgEnvironment(Buffer.from('PT_PG_DSN=postgres://user@localhost/other')), { code: 'R33_DIAG_TARGET_IDENTITY_REQUIRED' });
    console.log('PASS: only PG settings forwarded; duplicate/role overrides/wrong target rejected without echoing secrets');
    const input = Buffer.from('PT_PG_HOST=127.0.0.1\0PT_PG_PORT=65011\0PT_PG_USER=r33_diag_runtime\0PT_PG_DATABASE=northstar').toString('base64');
    const diagnostic = path.join(__dirname, '../../scripts/northstar-r33-readonly-diagnostic.cjs');
    // Test only the child stdin transport against the local locked installation.
    const source = fs.readFileSync(diagnostic, 'utf8').replace(
      "const RELEASE = '/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/shell';",
      `const RELEASE = ${JSON.stringify(path.resolve(__dirname, '../../shell'))};`);
    const child = spawnSync(process.execPath, ['-', '--database-child'], {
      input: source, env: { R33_DIAG_PG_INPUT: input, PATH: process.env.PATH }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).aclSufficient, true);
    assert.ok(!child.stdout.includes('SYNTHETIC_PRIVATE_PROMPT'));
    console.log('PASS: actual stdin child CLI emits bounded diagnostic JSON only; no staging-directory access needed');
    await admin.db.exec('REVOKE USAGE ON SCHEMA public FROM r33_diag_runtime');
    result = await collectQuestionPermissions(runtime.db, identity);
    assert.equal(result.aclSufficient, false); assert.equal(result.runs, null);
    const { rows: [count] } = await admin.db.query('SELECT count(*)::int AS count FROM public.agent_run_questions');
    assert.equal(count.count, 0);
    console.log('PASS: effective schema denial reported; diagnostic created zero question rows');
  } finally { if (runtime) await runtime.close(); await admin.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
