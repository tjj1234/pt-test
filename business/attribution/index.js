"use strict";
/**
 * business/attribution · A0–A7 入口（A8 未批准）
 */
const contracts = require("./contracts/validate");
const parsers = require("./parsers");
const persistence = require("./persistence");
const workflows = require("./workflows");
const { createEngineWorkflows, createAnalyticsWorkflows } = require("./workflows/engine");
const { createPanelProjector } = require("./panel/projector");
const { createMockRegistry } = require("./registry/mock");
const { productionSeedPolicy } = require("./policy/seed");
const importApi = require("./import");
const ingestionAdapter = require("./ingestion-adapter");
const attributionApi = require("./api");

module.exports = {
  ...contracts,
  parsers,
  persistence,
  workflows,
  createEngineWorkflows,
  createAnalyticsWorkflows,
  createPanelProjector,
  createMockRegistry,
  productionSeedPolicy,
  import: importApi,
  ingestionAdapter,
  api: attributionApi,
  packageName: "business/attribution",
  slice: "A18",
  a8Approved: false,
  baseline: "origin/main@96b7b28",
};
