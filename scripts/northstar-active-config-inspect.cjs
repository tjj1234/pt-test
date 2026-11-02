#!/usr/bin/env node
'use strict';
// Run from the active release's shell directory with its service environment.
// Never modifies settings, baselines, profiles, services or external providers.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
function inspectConfiguration({requireRelease = createRequire(path.resolve(process.cwd(), 'package.json')), home, template = path.resolve(process.cwd(), 'dsh-settings.yaml')} = {}) {
  home = home || requireRelease('./tenant.cjs').DSH_HOME;
  const version = requireRelease('./runtime/settings-version.cjs');
  const current = version.inspectSettings({home, template});
  const raw = version.settingsIO.readOwned(path.join(home, 'settings.yaml'));
  if (raw.length > 1024 * 1024 || version.settingsIO.digest(raw) !== current.settingsHash) throw Error('CONFIG_CHANGED');
  const settings = requireRelease('yaml').parse(raw.toString('utf8'), {maxAliasCount: 0});
  const models = settings?.['llm-pi-ai']?.providers?.powertokens?.models;
  if (!Array.isArray(models) || models.length > 2048) throw Error('CONFIG_INVALID');
  const ids = new Set(models.map(model => model?.id));
  const profile = path.join(home, 'profiles/run-persistent/northstar-profile-manifest.json');
  let profileManifestHash = null;
  try { profileManifestHash = version.settingsIO.digest(version.settingsIO.readOwned(profile)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {scope: 'active_release_read_only', settingsStatus: current.status,
    settingsHash: current.settingsHash, templateHash: current.templateHash, baselineHash: current.baselineHash,
    matchesActiveReleaseTemplate: current.settingsHash === current.templateHash,
    baselineMatchesActive: current.baseline ? current.baseline.settingsHash === current.settingsHash : null,
    baselineMatchesItsTemplate: current.baseline ? current.baseline.settingsHash === current.baseline.templateHash : null,
    configuredModelCount: models.length,
    models: Object.fromEntries(['deepseek-flash', 'deepseek-v4-1-flash-260910', 'qwen3.8-flash', 'seed-2-0-lite-260228'].map(id => [id, ids.has(id)])),
    profileManifestHash, providerCalls: 0};
}
if (require.main === module) {
  try { console.log(JSON.stringify(inspectConfiguration())); }
  catch { console.log(JSON.stringify({scope: 'active_release_read_only', code: 'ACTIVE_CONFIG_INSPECTION_FAILED', providerCalls: 0})); process.exitCode = 2; }
}
module.exports = {inspectConfiguration};
