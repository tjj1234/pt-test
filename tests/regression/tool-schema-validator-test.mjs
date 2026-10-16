import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { compileInputSchema: compile } = require('../../shell/tools/schema-validator.cjs');
const registry = require('../../shell/tools/registry.cjs');
const permissions = require('../../shell/permissions/index.cjs');
const valid = (schema, input) => compile(schema).prepare(input).valid;
const definition = (name, schema, execute) => ({ name, type: 'workflow', version: '1', description: 'schema fixture', inputSchema: schema, outputType: 'data', riskLevel: 'read', requiredPermissions: [], execute });

test('Ajv and standard formats are exact direct dependencies', () => {
  const manifest = require('../../shell/package.json');
  const lock = require('../../shell/package-lock.json');
  assert.equal(manifest.dependencies.ajv, '8.20.0');
  assert.equal(manifest.dependencies['ajv-formats'], '3.0.1');
  assert.equal(lock.packages[''].dependencies.ajv, manifest.dependencies.ajv);
  assert.equal(lock.packages['node_modules/ajv'].version, manifest.dependencies.ajv);
});
test('draft-07 nested constraints, local refs, composition and formats validate without mutation', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['rows', 'email'], definitions: { row: { type: 'object', required: ['amount'], additionalProperties: false, properties: { amount: { type: 'number', exclusiveMinimum: 0, maximum: 20, multipleOf: 0.5 } } } }, properties: { rows: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { $ref: '#/definitions/row' } }, email: { type: 'string', format: 'email' }, mode: { enum: ['short', 'long'] } }, allOf: [{ if: { properties: { mode: { const: 'long' } }, required: ['mode'] }, then: { properties: { rows: { minItems: 2 } } } }] };
  const good = { rows: [{ amount: 1.5 }], email: 'a@example.test' };
  const original = structuredClone(good); assert.equal(valid(schema, good), true); assert.deepEqual(good, original);
  for (const bad of [{ ...good, extra: 1 }, { ...good, email: 'bad' }, { ...good, rows: [{ amount: '1.5' }] }, { ...good, rows: [{ amount: 0 }] }, { ...good, rows: [{ amount: 1.2 }] }, { ...good, rows: [{ amount: 1 }, { amount: 1 }] }, { ...good, mode: 'long' }]) assert.equal(valid(schema, bad), false);
  assert.equal(valid({ oneOf: [{ type: 'string', pattern: '^a+$' }, { type: 'integer', minimum: 2 }] }, 'aa'), true);
  assert.equal(valid({ not: { const: 'forbidden' } }, 'forbidden'), false);
});
test('2019 and 2020 dialect keywords are not silently ignored', () => {
  const s2019 = { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object', dependentRequired: { a: ['b'] }, properties: { a: { type: 'string' }, b: { type: 'string' } }, unevaluatedProperties: false };
  assert.equal(valid(s2019, { a: 'a' }), false); assert.equal(valid(s2019, { a: 'a', b: 'b' }), true);
  const s2020 = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], items: false, minItems: 2 };
  assert.equal(valid(s2020, ['a', 1]), true); assert.equal(valid(s2020, ['a', '1']), false); assert.equal(valid(s2020, ['a', 1, 2]), false);
  assert.throws(() => compile({ type: 'string', typoConstraint: true }), { code: 'TOOL_SCHEMA_INVALID' });
});
test('malformed/remote/async schemas fail registration without partial tool state', async () => {
  for (const schema of [{ type: 'unrecognized' }, { $ref: 'https://example.test/remote-schema' }, { $schema: 'https://unknown.test/schema' }, { $async: true, type: 'object' }, { type: 'string', format: 'unknown-format' }]) assert.throws(() => registry.registerTool(definition('bad-schema-tool', schema, () => {})), { code: 'TOOL_SCHEMA_INVALID' });
  assert.equal((await registry.listToolsForWorkspace('fixture', {})).some((x) => x.name === 'bad-schema-tool'), false);
  registry.registerTool(definition('deny-all', false, () => { throw new Error('must not execute'); }));
  assert.equal(await registry.validateToolCall('deny-all', {}, {}), false);
});
test('defaults, coercion and property removal never rescue invalid input', () => {
  const validator = compile({ type: 'object', required: ['n'], additionalProperties: false, properties: { n: { type: 'integer', default: 1 } } });
  const input = { n: '1', extra: 'preserve' };
  assert.equal(validator.prepare(input).valid, false); assert.deepEqual(input, { n: '1', extra: 'preserve' });
  assert.equal(validator.prepare({}).valid, false);
});
test('cyclic/getter/non-JSON/oversized arguments fail closed without invoking getters', () => {
  let getterCalled = false;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalled = true; return 1; } });
  const cycle = {}; cycle.self = cycle;
  const validator = compile(true);
  for (const input of [getter, cycle, undefined, NaN, { value: undefined }, new Date(), 'x'.repeat(1024 * 1024 + 1)]) assert.equal(validator.prepare(input).valid, false);
  assert.equal(getterCalled, false);
});
test('invalid registry args reach neither logger nor executor; valid input preserves ordinary execution', async () => {
  let starts = 0, finishes = 0, calls = 0;
  registry.setToolCallLogger({ async start() { starts++; return { id: 'fixture-log' }; }, async finish() { finishes++; } });
  try {
    registry.registerTool(definition('guarded-schema-tool', { type: 'object', required: ['n'], additionalProperties: false, properties: { n: { type: 'integer', minimum: 1 } } }, async (args) => { calls++; return args.n + 1; }));
    assert.equal(await registry.validateToolCall('guarded-schema-tool', { n: '1' }, {}), false);
    await assert.rejects(registry.executeTool('guarded-schema-tool', { n: 'SECRET_INVALID_PARAMETER' }, {}), (e) => e.code === 'TOOL_INPUT_INVALID' && !JSON.stringify(e).includes('SECRET_INVALID_PARAMETER'));
    assert.deepEqual([starts, finishes, calls], [0, 0, 0]);
    const output = await registry.executeTool('guarded-schema-tool', { n: 2 }, {});
    assert.equal(output.result, 3); assert.deepEqual([starts, finishes, calls], [1, 1, 1]);
  } finally { registry.setToolCallLogger(null); }
});
test('registry schema is immutable; async authorization and logger cannot race caller input mutation', async () => {
  let release; const wait = new Promise((r) => release = r); let checked;
  const permissionStarted = new Promise((r) => checked = r);
  permissions.setDb({ query: async () => { checked(); await wait; return { rows: [{ role: 'owner' }] }; } });
  const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } };
  const tool = definition('race-schema-tool', schema, async (args) => args.n); tool.requiredPermissions = ['tool:execute'];
  registry.registerTool(tool); schema.properties.n.type = 'string';
  const args = { n: 7 };
  const pending = registry.executeTool('race-schema-tool', args, { userId: 'fixture-user', tenantId: 'fixture-tenant' });
  await permissionStarted; args.n = 'invalid-after-call'; release();
  assert.equal((await pending).result, 7);
  const listed = (await registry.listToolsForWorkspace('fixture', { userId: 'fixture-user', tenantId: 'fixture-tenant' })).find((x) => x.name === tool.name);
  assert.throws(() => { listed.inputSchema.properties.n.type = 'string'; }, TypeError);
  assert.equal(await registry.validateToolCall(tool.name, { n: 'bad' }, { userId: 'fixture-user', tenantId: 'fixture-tenant' }), false);
  permissions.setDb(null);
});

test('registration update while awaiting permission cannot swap the validated executor version', async () => {
  let release, started; const gate = new Promise((r) => release = r); const ready = new Promise((r) => started = r);
  permissions.setDb({ query: async () => { started(); await gate; return { rows: [{ role: 'owner' }] }; } });
  const first = definition('version-race-tool', { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }, async (args) => ({ version: 1, value: args.n }));
  first.requiredPermissions = ['tool:execute']; registry.registerTool(first);
  const pending = registry.executeTool(first.name, { n: 5 }, { userId: 'fixture-user', tenantId: 'fixture-tenant' });
  await ready;
  registry.registerTool(definition(first.name, { type: 'object', properties: { n: { type: 'string' } }, required: ['n'] }, async () => ({ version: 2 })));
  release(); assert.deepEqual((await pending).result, { version: 1, value: 5 });
  permissions.setDb(null);
});

test('async tool logger cannot create a validation-to-execution caller mutation gap', async () => {
  let release, started; const gate = new Promise((r) => release = r); const ready = new Promise((r) => started = r);
  registry.setToolCallLogger({ async start() { started(); await gate; return { id: 'log' }; }, async finish() {} });
  try {
    registry.registerTool(definition('logger-race-tool', { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }, async (args) => args.n));
    const input = { n: 9 }; const pending = registry.executeTool('logger-race-tool', input, {});
    await ready; input.n = 'invalid'; release();
    assert.equal((await pending).result, 9);
  } finally { registry.setToolCallLogger(null); }
});

test('new schema without executor clears the prior version; invalid re-registration preserves current definition and executor', async () => {
  let oldCalls = 0, newCalls = 0;
  const v1 = definition('executor-lifecycle-tool', { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }, async () => { oldCalls++; return 'v1'; });
  registry.registerTool(v1);
  const broken = { ...v1, version: 'broken', inputSchema: { type: 'not-a-type' }, execute: async () => 'invalid' };
  assert.throws(() => registry.registerTool(broken), { code: 'TOOL_SCHEMA_INVALID' });
  assert.equal((await registry.executeTool(v1.name, { n: 3 }, {})).result, 'v1');
  assert.equal(oldCalls, 1);
  const v2 = { ...definition(v1.name, { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string' } } }), version: '2' };
  delete v2.execute;
  registry.registerTool(v2);
  const unbound = await registry.executeTool(v1.name, { text: 'v2 input' }, {});
  assert.equal(unbound.metadata.executed, false);
  assert.equal(oldCalls, 1, 'v2 never inherits the v1 executor');
  registry.registerToolExecutor(v1.name, async (args) => { newCalls++; return args.text; });
  assert.equal((await registry.executeTool(v1.name, { text: 'new executor' }, {})).result, 'new executor');
  assert.equal(newCalls, 1);
  assert.throws(() => registry.registerTool(broken), { code: 'TOOL_SCHEMA_INVALID' });
  assert.equal((await registry.executeTool(v1.name, { text: 'still v2' }, {})).result, 'still v2');
  assert.equal(newCalls, 2);
  assert.equal(oldCalls, 1);
});
