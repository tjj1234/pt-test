'use strict';
const fs = require('node:fs');
const YAML = require('yaml');

// Discovery offers adoption candidates; pi-ai only serves settings.yaml models.
// Read the actual seeded home, falling back to the template only before seeding.
function configuredModels({settings, template}) {
  let filename = settings;
  try { fs.lstatSync(filename); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    filename = template;
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let document;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('DSH_SETTINGS_INVALID');
    document = YAML.parse(fs.readFileSync(fd, 'utf8'), {maxAliasCount: 0});
  } finally { fs.closeSync(fd); }
  const models = document?.['llm-pi-ai']?.providers?.powertokens?.models;
  if (!Array.isArray(models) || models.length > 2048) throw Error('DSH_SETTINGS_INVALID');
  const ids = models.map(model => model?.id);
  if (ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 256) || new Set(ids).size !== ids.length) throw Error('DSH_SETTINGS_INVALID');
  return ids;
}

function constrainCatalog(catalog, ids) {
  const configured = new Set(ids);
  return {...catalog, models: catalog.models.map(model => {
    if (configured.has(model.id)) return {...model, dshConfigured: true};
    const adaptations = {...model.adaptations};
    delete adaptations.textChat;
    delete adaptations.imageUnderstanding;
    const states = {...model.states};
    for (const task of ['textChat', 'imageUnderstanding']) if (states[task]) {
      states[task] = {...states[task], adapted: false, endpointCompatible: false, verified: false, autoEligible: false};
    }
    return {...model, adaptations, states, dshConfigured: false, runtimeStatus: 'unadapted'};
  })};
}
module.exports = {configuredModels, constrainCatalog};
