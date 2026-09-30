"use strict";
const { createEventMappingStore, DEFAULT_EVENT_MAPPINGS } = require("./mapping-store");
const { createQualityStatsStore } = require("./quality-stats");
const { adaptEvent, adaptBatch, deterministicEventId } = require("./adapt");
const { runConnectionTest, diagnoseHttpStatus, DIAG } = require("./connection-test");
const { createIngestionAdapter } = require("./service");
const { registerIngestionAdapterRoutes } = require("./routes");
const { registerRawIngestRoutes } = require("./raw-ingest-routes");

module.exports = {
  createEventMappingStore,
  DEFAULT_EVENT_MAPPINGS,
  createQualityStatsStore,
  adaptEvent,
  adaptBatch,
  deterministicEventId,
  runConnectionTest,
  diagnoseHttpStatus,
  DIAG,
  createIngestionAdapter,
  registerIngestionAdapterRoutes,
  registerRawIngestRoutes,
};
