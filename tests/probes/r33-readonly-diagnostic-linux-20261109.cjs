'use strict';
// Run only in the dedicated disposable Linux Node fixture, never on a target host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
assert.equal(process.platform, 'linux');
assert.equal(process.env.R33_DIAG_LINUX_FIXTURE, '1');
assert.equal(fs.existsSync('/usr/bin/systemctl'), false, 'Do not replace an existing systemctl');
const release = '/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/shell';
for (const file of ['db-pg.cjs', 'questions/service.cjs', 'questions/store.cjs', 'db-migrations/029_user_questions.sql']) {
  fs.mkdirSync(path.dirname(path.join(release, file)), { recursive: true });
  fs.copyFileSync(path.join('/r33-source', file), path.join(release, file));
}
fs.symlinkSync('/locked/node_modules', path.join(release, 'node_modules'));
const { openPg } = require(path.join(release, 'db-pg.cjs'));
const diag = '/diagnostic.cjs';
const pgEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', PT_PG_HOST: '127.0.0.1',
  PT_PG_PORT: '5432', PT_PG_DATABASE: 'northstar', PT_PG_USER: 'r33_diag_runtime' };
(async () => {
  const admin = await openPg({ ...pgEnv, PT_PG_USER: 'postgres' });
  let service;
  try {
    await admin.db.exec(`CREATE ROLE r33_diag_runtime LOGIN;
      CREATE TABLE public.agent_runs(run_id UUID PRIMARY KEY,state TEXT,revision INTEGER);
      ALTER TABLE public.agent_runs OWNER TO r33_diag_runtime;
      CREATE TABLE public.schema_migrations(name TEXT PRIMARY KEY);
      GRANT SELECT ON public.schema_migrations TO r33_diag_runtime;
      INSERT INTO public.schema_migrations VALUES('029_user_questions.sql')`);
    await admin.db.exec(fs.readFileSync(path.join(release, 'db-migrations/029_user_questions.sql'), 'utf8'));
    service = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: release, env: pgEnv, uid: 65534, gid: 65534, stdio: 'ignore',
    });
    await new Promise((resolve, reject) => { service.once('spawn', resolve); service.once('error', reject); });
    const stub = (directory = release) => fs.writeFileSync('/usr/bin/systemctl', `#!/bin/sh
test "$1" = show || exit 71
printf '%s\\n' 'ActiveState=active' 'SubState=running' 'MainPID=${service.pid}' 'NRestarts=0' 'WorkingDirectory=${directory}'
`, { mode: 0o755 });
    stub();
    const execute = () => spawnSync(process.execPath, [diag], { encoding: 'utf8', timeout: 25000 });
    let result = execute();
    assert.equal(result.status, 0, result.stderr);
    let report = JSON.parse(result.stdout);
    assert.equal(report.sourcesMatched, 4);
    assert.equal(report.service.MainPID, String(service.pid));
    assert.equal(report.diagnostic.role, 'r33_diag_runtime');
    assert.equal(report.diagnostic.runtimeSuperuser, false);
    assert.equal(report.diagnostic.aclSufficient, false);
    assert.equal(report.diagnostic.questionMigrationRecorded, true);
    console.log('PASS Linux: real /proc environment + cwd + source hashes + OS uid/gid 65534 child diagnose missing ACL');
    await admin.db.exec('GRANT SELECT,INSERT,UPDATE ON public.agent_run_questions,public.agent_question_scopes TO r33_diag_runtime');
    result = execute(); assert.equal(result.status, 0, result.stderr);
    report = JSON.parse(result.stdout); assert.equal(report.diagnostic.aclSufficient, true);
    assert.equal((await admin.db.query('SELECT count(*)::int AS count FROM public.agent_run_questions')).rows[0].count, 0);
    console.log('PASS Linux: minimal grants visible under service identity; full wrapper writes zero question rows');
    const file = path.join(release, 'questions/service.cjs');
    const original = fs.readFileSync(file); fs.appendFileSync(file, '\n// fixture source drift\n');
    result = execute(); assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'R33_DIAG_SOURCE_DRIFT'); assert.equal(result.stdout, '');
    fs.writeFileSync(file, original);
    stub('/tmp/wrong-release'); result = execute(); assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'R33_DIAG_SERVICE_OR_RELEASE_DRIFT'); assert.equal(result.stdout, '');
    console.log('PASS Linux: source and release drift rejected with bounded error JSON');
    console.log(`FIXTURE_ONLY Node=${process.version}; systemctl metadata mocked, /proc/uid/PG real; no formal target accessed`);
  } finally {
    service?.kill('SIGTERM');
    await admin.close();
    fs.rmSync('/usr/bin/systemctl', { force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
