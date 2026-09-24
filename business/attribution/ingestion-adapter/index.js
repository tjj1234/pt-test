"use strict";
const { createEventMappingStore } = require("./mapping-store");
const { createQualityStatsStore } = require("./quality-stats");
const { adaptEvent, adaptBatch, deterministicEventId } = require("./adapt");
const { runConnectionTest, diagnoseHttpStatus, DIAG } = require("./connection-test");
const { createIngestionAdapter } = require("./service");
const { registerIngestionAdapterRoutes } = require("./routes");

module.exports = {
  createEventMappingStore,
  createQualityStatsStore,
  adaptEvent,
  adaptBatch,
  deterministicEventId,
  runConnectionTest,
  diagnoseHttpStatus,
  DIAG,
  createIngestionAdapter,
  registerIngestionAdapterRoutes,
};
