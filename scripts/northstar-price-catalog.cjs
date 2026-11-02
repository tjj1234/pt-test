'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { open, pgConfigured } = require('../shell/db.cjs');
const { createTextPriceCatalogStore } = require('../shell/usage/price-catalog-store.cjs');
const fail = code => Object.assign(new Error(code), { code });

async function main(argv = process.argv.slice(2)) {
  const flags = new Map();
  if (argv[0] !== 'import') throw fail('PRICE_CATALOG_USAGE');
  for (let index = 1; index < argv.length; index++) {
    const key = argv[index];
    if (flags.has(key) || !['--db-dir', '--input', '--offline', '--reviewed'].includes(key)) throw fail('PRICE_CATALOG_USAGE');
    if (key === '--offline' || key === '--reviewed') flags.set(key, true);
    else {
      const value = argv[++index];
      if (!value || !path.isAbsolute(value)) throw fail('PRICE_CATALOG_USAGE');
      flags.set(key, value);
    }
  }
  if (!flags.get('--offline') || !flags.get('--reviewed') || !flags.get('--db-dir') || !flags.get('--input')) {
    throw fail('PRICE_CATALOG_REVIEW_REQUIRED');
  }
  if (pgConfigured() || process.env.PT_PGLITE_PATH) throw fail('PRICE_CATALOG_BACKEND_UNSUPPORTED');
  // This explicit maintenance command never creates a database or migrates unrelated schema.
  const dbDir = flags.get('--db-dir');
  if (fs.lstatSync(dbDir).isSymbolicLink() || !fs.statSync(path.join(dbDir, 'PG_VERSION')).isFile()) throw fail('PRICE_CATALOG_DATABASE_REQUIRED');
  const fd = fs.openSync(flags.get('--input'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let input;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1_048_576) throw fail('PRICE_CATALOG_INPUT_LIMIT');
    input = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  if (!input || Object.keys(input).some(key => !['sourceEvidence', 'snapshots'].includes(key))) throw fail('PRICE_CATALOG_INVALID');
  const connection = await open({ dataDir: dbDir });
  try {
    const result = await createTextPriceCatalogStore(connection.db).importCatalog({ ...input, reviewed: true });
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    return result;
  } finally { await connection.close(); }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code || 'PRICE_CATALOG_IMPORT_FAILED' }) + '\n');
  process.exitCode = 1;
});
module.exports = { main };
