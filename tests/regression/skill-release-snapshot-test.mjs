import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSkillReleaseSnapshot, pinSkillReleases } = require('../../shell/skills/release-snapshot.cjs');

const sourceFiles = [
  { path: 'SKILL.md', content: '---\nname: sample-skill\ndescription: fixture\n---\nUse the fixture.' },
  { path: 'assets/reference.txt', content: Buffer.from([0, 1, 2, 255]) },
];

test('release identity is deterministic across input order and changes with any bundled byte', () => {
  const first = createSkillReleaseSnapshot({ skillId: 'sample-skill', version: 'v1', files: sourceFiles });
  const reordered = createSkillReleaseSnapshot({ skillId: 'sample-skill', version: 'v1', files: [...sourceFiles].reverse() });
  const changed = createSkillReleaseSnapshot({
    skillId: 'sample-skill', version: 'v1', files: [{ ...sourceFiles[0] }, { ...sourceFiles[1], content: Buffer.from([0, 1, 2, 254]) }],
  });
  assert.equal(first.contentHash, reordered.contentHash);
  assert.notEqual(first.contentHash, changed.contentHash);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.files) && first.files.every(Object.isFrozen));
});

test('snapshot rejects traversal, duplicate paths, empty manifests, and invalid DSH skill ids', () => {
  const base = { skillId: 'sample-skill', version: 'v1', files: sourceFiles };
  assert.throws(() => createSkillReleaseSnapshot({ ...base, files: [{ path: '../secret', content: 'x' }] }), /canonical/);
  assert.throws(() => createSkillReleaseSnapshot({ ...base, files: [{ path: 'C:/outside/file', content: 'x' }] }), /relative POSIX/);
  assert.throws(() => createSkillReleaseSnapshot({ ...base, files: [{ path: 'e\u0301.txt', content: 'x' }] }), /Unicode NFC/);
  assert.throws(() => createSkillReleaseSnapshot({ ...base, files: [{ path: 'x', content: 'a' }, { path: 'x', content: 'b' }] }), /unique/);
  assert.throws(() => createSkillReleaseSnapshot({ ...base, files: [{ path: 'Readme.md', content: 'a' }, { path: 'README.md', content: 'b' }] }), /case-insensitive/);
  assert.throws(() => createSkillReleaseSnapshot({ ...base, files: [] }), /at least one/);
  assert.throws(() => createSkillReleaseSnapshot({ ...base, skillId: 'Not A Skill' }), /kebab-case/);
});

test('Run pin copies immutable release identities and canonicalizes order', () => {
  const a = createSkillReleaseSnapshot({ skillId: 'alpha', version: 'v2', files: [{ path: 'SKILL.md', content: 'alpha' }] });
  const b = createSkillReleaseSnapshot({ skillId: 'beta', version: 'release-2026-10-22', files: [{ path: 'SKILL.md', content: 'beta' }] });
  const pin = pinSkillReleases([b, a]);
  assert.deepEqual(pin.skills.map(({ skillId }) => skillId), ['alpha', 'beta']);
  assert.equal(pin.skills[0].version, 'v2');
  assert.equal(pin.skills[0].contentHash, a.contentHash);
  assert.ok(Object.isFrozen(pin) && Object.isFrozen(pin.skills) && pin.skills.every(Object.isFrozen));
  assert.throws(() => pinSkillReleases([a, a]), /one release per skillId/);
  assert.throws(() => pinSkillReleases([{ ...a, contentHash: 'bad' }]), /schema v1/);
});
