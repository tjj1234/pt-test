/** No .env loading, credentials, network, DSH home mutations, or model calls. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'shell/package.json'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'shell/package-lock.json'), 'utf8'));
const packages = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-fs-local'];
let blocked = false;
const rows = [];
for (const name of packages) {
  const entry = lock.packages['node_modules/' + name];
  try {
    const resolved = req.resolve(name);
    const exports = Object.keys(await import(pathToFileURL(resolved))).sort();
    rows.push({ name, version: entry?.version ?? null, loaded: true, exports });
  } catch (e) {
    blocked = true;
    const missingPackage = /Cannot find package '([^']+)'/.exec(e.message)?.[1] ?? null;
    rows.push({ name, version: entry?.version ?? null, loaded: false, code: e.code || 'LOAD_ERROR', missingPackage });
  }
}
console.log(JSON.stringify({ stage: 'dependency-preflight-only', paidCalls: 0, sdkBehaviorVerified: false, blocked, packages: rows }, null, 2));
process.exitCode = blocked ? 2 : 0;
