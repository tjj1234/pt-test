"use strict";
const Ajv = require("ajv");
const Ajv2019 = require("ajv/dist/2019");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { fingerprint } = require("../contracts/phase1.cjs");
const DIALECTS = Object.freeze({
  "http://json-schema.org/draft-07/schema#": Ajv,
  "https://json-schema.org/draft/2019-09/schema": Ajv2019,
  "https://json-schema.org/draft/2020-12/schema": Ajv2020,
});
const invalid = (code, message) => Object.assign(new TypeError(message), { code, statusCode: 400 });
function snapshotJSON(value) {
  // Checks finite JSON, depth/node/byte budgets and rejects getters/toJSON/non-plain data.
  fingerprint(value);
  return structuredClone(value);
}
function freeze(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function compileInputSchema(inputSchema) {
  let schema, compiled;
  try {
    schema = snapshotJSON(inputSchema);
    if (typeof schema !== "boolean" && (!schema || typeof schema !== "object" || Array.isArray(schema))) throw new TypeError("Schema must be boolean or object");
    const dialect = typeof schema === "object" && schema.$schema;
    const Constructor = dialect ? DIALECTS[dialect] : Ajv;
    if (!Constructor) throw new TypeError("Unsupported schema dialect");
    const ajv = new Constructor({ strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false, allowUnionTypes: true, strictNumbers: true, allErrors: false, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: true, addUsedSchema: false, logger: false });
    addFormats(ajv);
    compiled = ajv.compile(schema);
    if (compiled.$async) throw new TypeError("Async validation is not supported");
    freeze(schema);
  } catch { throw invalid("TOOL_SCHEMA_INVALID", "Tool input schema is invalid or unsupported"); }
  return Object.freeze({
    schema,
    prepare(args) {
      let snapshot;
      try { snapshot = snapshotJSON(args); }
      catch { return { valid: false, errors: [{ keyword: "json", instancePath: "", schemaPath: "" }] }; }
      if (compiled(snapshot)) return { valid: true, value: snapshot, errors: [] };
      return { valid: false, errors: (compiled.errors || []).slice(0, 8).map(({ keyword, instancePath, schemaPath }) => ({ keyword, instancePath, schemaPath })) };
    },
  });
}
module.exports = { compileInputSchema, DIALECTS: Object.freeze(Object.keys(DIALECTS)) };
