'use strict';
// Diagnostic only: no migrations, grants, storage initialization or model calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const RELEASE = '/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/shell';
const SOURCE_HASHES = Object.freeze({
  'db-pg.cjs': 'd50867d33825efacc7b9e904c09e9a7692f273e0a0cdd22848a9f77cd07499cc',
  'questions/service.cjs': '07f70c58291c542da9caa358c1c4ac60c571c5ff14a0c3f0690bc0c1394530f1',
  'questions/store.cjs': '550deda5d9d839eb7d8ddd5d455121edb0adaafc5764dc7c2b288610084ca909',
  'db-migrations/029_user_questions.sql': '000e5ab9667dd7d9bca6eb1a7b2943fb0e5f5087c2560c95ce4187a1a60aa504',
});
const RUN_IDS = Object.freeze(['58653c59-d6ad-49e2-8846-134bfaad1b0c', '5db2efd9-02ee-4ce6-9052-723261f979a5']);
const fail = code => Object.assign(new Error(code), { code });
const PG_KEYS = ['PT_PG_DSN', 'PT_PG_HOST', 'PT_PG_PORT', 'PT_PG_USER', 'PT_PG_USERNAME',
  'PT_PG_PASSWORD', 'PT_PG_DATABASE', 'PT_PG_DB', 'PT_PG_SSL',
  'PGUSER', 'PGDATABASE', 'PGHOST', 'PGPORT', 'PGPASSWORD', 'PGSSLMODE'];

function runtimePgEnvironment(raw) {
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', PT_PG_POOL_MAX: '1', PT_PG_CONNECT_TIMEOUT_MS: '5000' };
  const seen = new Set();
  for (const entry of raw.toString('utf8').split('\0')) {
    const at = entry.indexOf('=');
    if (at < 1) continue;
    const key = entry.slice(0, at);
    if (key === 'PGOPTIONS' && entry.slice(at + 1)) throw fail('R33_DIAG_CONNECTION_IDENTITY_UNSUPPORTED');
    if (!PG_KEYS.includes(key)) continue;
    if (seen.has(key)) throw fail('R33_DIAG_ENV_AMBIGUOUS');
    seen.add(key); env[key] = entry.slice(at + 1);
  }
  if (!['PT_PG_DSN', 'PT_PG_HOST', 'PT_PG_DATABASE', 'PT_PG_DB', 'PT_PG_USER', 'PT_PG_USERNAME']
    .some(key => env[key]?.trim())) throw fail('R33_DIAG_POSTGRES_REQUIRED');
  let expectedRole, expectedDatabase;
  if (env.PT_PG_DSN?.trim()) {
    try {
      const uri = new URL(env.PT_PG_DSN.trim());
      if (!['postgres:', 'postgresql:'].includes(uri.protocol)) throw Error();
      expectedRole = decodeURIComponent(uri.username) || env.PGUSER;
      expectedDatabase = decodeURIComponent(uri.pathname.slice(1)) || env.PGDATABASE;
      // Query overrides require a separate, explicitly reviewed connection identity.
      if (uri.searchParams.has('user') || uri.searchParams.has('database') || uri.searchParams.has('dbname')) throw Error();
    } catch { throw fail('R33_DIAG_CONNECTION_IDENTITY_UNSUPPORTED'); }
  } else {
    expectedRole = env.PT_PG_USER || env.PT_PG_USERNAME || 'postgres';
    expectedDatabase = env.PT_PG_DATABASE || env.PT_PG_DB || 'northstar';
  }
  if (!expectedRole || expectedDatabase !== 'northstar') throw fail('R33_DIAG_TARGET_IDENTITY_REQUIRED');
  return { env, expectedRole, expectedDatabase };
}

async function collectQuestionPermissions(db, { expectedRole, expectedDatabase }) {
  return db.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    await tx.query("SET LOCAL statement_timeout='5s'");
    await tx.query("SET LOCAL lock_timeout='1s'");
    const { rows: [identity] } = await tx.query(`SELECT current_user AS role, session_user AS session_role,
      pg_catalog.current_database() AS database, pg_catalog.clock_timestamp() AS observed_at,
      r.rolsuper AS superuser, pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS schema_usage
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (!identity || identity.role !== expectedRole || identity.session_role !== expectedRole ||
        identity.database !== expectedDatabase) throw fail('R33_DIAG_RUNTIME_IDENTITY_MISMATCH');
    const tables = [];
    for (const name of ['agent_runs', 'agent_run_questions', 'agent_question_scopes', 'schema_migrations']) {
      const { rows: [relation] } = await tx.query(`SELECT c.oid,c.relkind,c.relrowsecurity AS rls,
        pg_catalog.pg_get_userbyid(c.relowner) AS owner FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1`, [name]);
      if (!relation || relation.relkind !== 'r') { tables.push({ table: name, exists: false }); continue; }
      const privileges = {};
      for (const action of ['SELECT', 'INSERT', 'UPDATE']) {
        const { rows: [value] } = await tx.query(
          'SELECT pg_catalog.has_table_privilege(current_user,$1::oid,$2) AS allowed', [relation.oid, action]);
        privileges[action] = value.allowed === true;
      }
      tables.push({ table: name, exists: true, owner: relation.owner, rls: relation.rls, privileges });
    }
    const readable = name => identity.schema_usage && tables.some(t => t.table === name && t.privileges?.SELECT);
    let questionMigrationRecorded = null, runs = null, questionCounts = null;
    if (readable('schema_migrations')) {
      questionMigrationRecorded = (await tx.query(
        "SELECT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name='029_user_questions.sql') AS recorded")).rows[0].recorded;
    }
    if (readable('agent_runs')) runs = (await tx.query(
      'SELECT run_id::text,state,revision FROM public.agent_runs WHERE run_id=ANY($1::uuid[]) ORDER BY run_id', [RUN_IDS])).rows;
    if (readable('agent_run_questions')) questionCounts = (await tx.query(
      'SELECT run_id::text,count(*)::int AS count FROM public.agent_run_questions WHERE run_id=ANY($1::uuid[]) GROUP BY run_id ORDER BY run_id', [RUN_IDS])).rows;
    const questionTables = tables.filter(t => t.table.startsWith('agent_question') || t.table === 'agent_run_questions');
    return { scope: 'R33_QUESTION_ACL_DIAGNOSTIC_ONLY', role: identity.role, database: identity.database,
      observedAt: identity.observed_at, runtimeSuperuser: identity.superuser, schemaUsage: identity.schema_usage,
      questionMigrationRecorded, tables, runs, questionCounts,
      aclSufficient: identity.schema_usage && questionTables.length === 2 && questionTables.every(t =>
        t.exists && !t.rls && Object.values(t.privileges).every(Boolean)),
      conclusion: 'ACL evidence only; does not prove complete historical RPC/model retry causality' };
  });
}

function serviceSnapshot() {
  const raw = execFileSync('/usr/bin/systemctl', ['show', 'northstar-shell', '--property=ActiveState',
    '--property=SubState', '--property=MainPID', '--property=NRestarts', '--property=WorkingDirectory'],
  { encoding: 'utf8', timeout: 5000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'] });
  const values = Object.fromEntries(raw.trim().split('\n').map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  if (values.ActiveState !== 'active' || values.SubState !== 'running' || values.WorkingDirectory !== RELEASE ||
      !/^[1-9]\d*$/.test(values.MainPID)) throw fail('R33_DIAG_SERVICE_OR_RELEASE_DRIFT');
  return values;
}

async function databaseChild() {
  const { env, expectedRole, expectedDatabase } = runtimePgEnvironment(
    Buffer.from(process.env.R33_DIAG_PG_INPUT || '', 'base64'));
  // Replace the child environment with only the service's allowlisted PG settings.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  const { openPg } = require(path.join(RELEASE, 'db-pg.cjs'));
  const connection = await openPg();
  try { return await collectQuestionPermissions(connection.db, { expectedRole, expectedDatabase }); }
  finally { await connection.close(); }
}

function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw fail('R33_DIAG_LINUX_ROOT_REQUIRED');
  if (process.argv.length !== 2) throw fail('R33_DIAG_NO_ARGUMENTS');
  const before = serviceSnapshot();
  for (const [relative, expected] of Object.entries(SOURCE_HASHES)) {
    const file = path.join(RELEASE, relative);
    if (fs.realpathSync(file) !== file || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) {
      throw fail('R33_DIAG_SOURCE_DRIFT');
    }
  }
  let cwd, status, environment;
  try {
    cwd = fs.realpathSync(`/proc/${before.MainPID}/cwd`);
    status = fs.readFileSync(`/proc/${before.MainPID}/status`, 'utf8');
    environment = fs.readFileSync(`/proc/${before.MainPID}/environ`);
  } catch { throw fail('R33_DIAG_PROCESS_READ_FAILED'); }
  if (cwd !== RELEASE) throw fail('R33_DIAG_PROCESS_CWD_DRIFT');
  const uid = Number(status.match(/^Uid:\s+\d+\s+(\d+)/m)?.[1]);
  const gid = Number(status.match(/^Gid:\s+\d+\s+(\d+)/m)?.[1]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw fail('R33_DIAG_PROCESS_IDENTITY_UNKNOWN');
  const pg = runtimePgEnvironment(environment);
  const raw = Buffer.from(Object.entries(pg.env).filter(([key]) => PG_KEYS.includes(key))
    .map(([key, value]) => `${key}=${value}`).join('\0')).toString('base64');
  // Feed public diagnostic code over stdin: the service OS identity need not
  // traverse the operator's private staging directory. PG credentials stay in env.
  const result = execFileSync(process.execPath, ['-', '--database-child'], {
    input: fs.readFileSync(__filename),
    env: { R33_DIAG_PG_INPUT: raw, PATH: '/usr/local/bin:/usr/bin:/bin' }, uid, gid,
    timeout: 20000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const after = serviceSnapshot();
  if (before.MainPID !== after.MainPID || before.NRestarts !== after.NRestarts) throw fail('R33_DIAG_SERVICE_CHANGED');
  return { service: after, sourcesMatched: Object.keys(SOURCE_HASHES).length, diagnostic: JSON.parse(result.toString('utf8')) };
}

const databaseStdinChild = process.argv[1] === '-' && process.argv[2] === '--database-child';
if (require.main === module || databaseStdinChild) {
  Promise.resolve().then(() => databaseStdinChild ? databaseChild() : main())
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => {
      const code = /^R33_DIAG_[A-Z_]+$/.test(error.code || '') ? error.code : 'R33_DIAG_FAILED';
      process.stderr.write(JSON.stringify({ ok: false, code }) + '\n'); process.exitCode = 1;
    });
}
module.exports = { runtimePgEnvironment, collectQuestionPermissions };
