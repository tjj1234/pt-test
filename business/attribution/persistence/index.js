"use strict";
const { createMockPersistence } = require("./mock");
const { createSqlPersistence } = require("./sql");
const {
  toCanonicalEvent,
  wrapIngestQueueWithPersistence,
  recordValidationFailure,
} = require("./collect-hooks");

module.exports = {
  createMockPersistence,
  createSqlPersistence,
  toCanonicalEvent,
  wrapIngestQueueWithPersistence,
  recordValidationFailure,
};
