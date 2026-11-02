#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

// Preserve the original A7 delivery boundary independently of whatever other
// work is dirty in the integrated workspace. Keep commit provenance explicit.
const baseline = '96b7b281221b340c9944121e5d1598d012b744f9';
const delivery = 'b5a519d868f7ed233f4ce4cbf0caf875dc894c7e';
const protectedPaths = ['shell', 'analytics/backend/ads/funnel.js', 'analytics/backend/collect'];

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `git ${args.join(' ')} failed\n`);
    process.exit(result.status || 1);
  }
  return result.stdout.trim();
}

const parent = git(['rev-parse', `${delivery}^`]);
if (parent !== baseline) {
  console.error(`A7 parent mismatch: expected ${baseline}, got ${parent}`);
  process.exit(1);
}

const changed = git(['diff', '--name-only', baseline, delivery, '--', ...protectedPaths]);
if (changed) {
  console.error('A7 delivery modified protected base paths:');
  console.error(changed);
  process.exit(1);
}

console.log(`A7 scope PASS: ${delivery} is based on ${baseline}; protected paths unchanged.`);
