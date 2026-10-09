"use strict";
/**
 * business/attribution · A0–A8 入口（A8：真实 Tool Registry；Panel 仍反代）
 */
const contracts = require("./contracts/validate");
const parsers = require("./parsers");
const persistence = require("./persistence");
const workflows = require("./workflows");
const { createEngineWorkflows, createAnalyticsWorkflows } = require("./workflows/engine");
const { createPanelProjector } = require("./panel/projector");
const registry = require("./registry");
const { productionSeedPolicy } = require("./policy/seed");
const importApi = require("./import");
const ingestionAdapter = require("./ingestion-adapter");
const attributionApi = require("./api");

module.exports = {
  gaConnector: require('./ga-connector'),
  ...contracts,
  parsers,
  persistence,
  workflows,
  createEngineWorkflows,
  createAnalyticsWorkflows,
  createPanelProjector,
  createMockRegistry: registry.createMockRegistry,
  createAttributionRegistry: registry.createAttributionRegistry,
  registerAttributionQueryTool: registry.registerAttributionQueryTool,
  callAttributionQuery: registry.callAttributionQuery,
  productionSeedPolicy,
  import: importApi,
  ingestionAdapter,
  api: attributionApi,
  registry,
  packageName: "business/attribution",
  slice: "A18-A19",
  a8Approved: true,
  baseline: "origin/main@96b7b28",
};
