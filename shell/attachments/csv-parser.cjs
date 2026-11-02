"use strict";

const DEFAULT_LIMITS = Object.freeze({
  // These are parser safety ceilings, not product entitlements. Product-facing
  // limits remain subject to T00 validation of the target deployment.
  maxBytes: 20 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 16_384,
  maxCells: 100_000,
});
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));

function invalid(message, code = "CSV_INVALID") {
  return Object.assign(new TypeError(message), { code });
}

function inputText(input, maxBytes) {
  if (typeof input === "string") {
    const bytes = Buffer.byteLength(input, "utf8");
    if (bytes > maxBytes) throw invalid("CSV exceeds the byte limit", "CSV_LIMIT_EXCEEDED");
    return { text: input, bytes };
  }
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const byteLength = input.byteLength;
    if (byteLength > maxBytes) throw invalid("CSV exceeds the byte limit", "CSV_LIMIT_EXCEEDED");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input); }
    catch { throw invalid("CSV input is not valid UTF-8", "CSV_ENCODING_INVALID"); }
    return { text, bytes: byteLength };
  }
  throw invalid("CSV input must be a string, Buffer, or Uint8Array", "CSV_INPUT_INVALID");
}

function limitsFrom(options) {
  const supplied = options?.limits;
  if (supplied != null && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) {
    throw invalid("CSV limits must be an object", "CSV_LIMIT_INVALID");
  }
  const limits = {};
  for (const key of LIMIT_KEYS) {
    const value = supplied && Object.hasOwn(supplied, key) ? supplied[key] : DEFAULT_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) {
      throw invalid(`CSV ${key} must be an integer between 1 and ${DEFAULT_LIMITS[key]}`, "CSV_LIMIT_INVALID");
    }
    limits[key] = value;
  }
  if (supplied && Object.keys(supplied).some((key) => !LIMIT_KEYS.includes(key))) {
    throw invalid("CSV limits contain unsupported fields", "CSV_LIMIT_INVALID");
  }
  return limits;
}

/**
 * Parse one UTF-8 CSV snapshot without inferring headers, types, or numbers.
 *
 * API: parseCsv(input, { limits }) -> { rows, bytes, cellCount }
 * Each row is an array of cells. A cell is
 * { value, row, column, sourceLine, sourceColumn }, where row/column are
 * 1-based logical CSV coordinates and sourceLine/sourceColumn are 1-based
 * physical coordinates (UTF-16 code-unit columns) at the start of the field.
 * Empty fields are retained as value:"". A UTF-8 BOM is ignored for parsing,
 * but is included in the byte limit. Newlines between records accept LF or
 * CRLF; bare CR, malformed quoting, and trailing characters after a closing
 * quote are rejected.
 */
function parseCsv(input, options = {}) {
  const limits = limitsFrom(options);
  let { text, bytes } = inputText(input, limits.maxBytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let cells = [], value = "", index = 0, line = 1, physicalColumn = 1;
  let logicalRow = 1, fieldColumn = 1, fieldLine = 1, fieldSourceColumn = 1;
  let state = "field_start", recordTouched = false, cellCount = 0;

  const appendCharacter = (character) => { value += character; };
  const consumeCharacter = (character) => {
    index += character.length;
    physicalColumn += character.length;
  };
  const consumeNewline = () => {
    if (text[index] === "\r") {
      if (text[index + 1] !== "\n") throw invalid("Bare CR is not a valid CSV line ending", "CSV_SYNTAX_INVALID");
      index += 2;
    } else {
      index += 1;
    }
    line += 1;
    physicalColumn = 1;
  };
  const ensureCellCapacity = () => {
    if (fieldColumn > limits.maxColumns || cellCount >= limits.maxCells) {
      throw invalid("CSV exceeds the cell or column limit", "CSV_LIMIT_EXCEEDED");
    }
  };
  const finishCell = () => {
    ensureCellCapacity();
    cells.push({ value, row: logicalRow, column: fieldColumn, sourceLine: fieldLine, sourceColumn: fieldSourceColumn });
    cellCount += 1;
    value = "";
  };
  const beginNextField = () => {
    fieldColumn += 1;
    fieldLine = line;
    fieldSourceColumn = physicalColumn;
    state = "field_start";
  };
  const finishRecord = () => {
    finishCell();
    if (rows.length >= limits.maxRows) throw invalid("CSV exceeds the row limit", "CSV_LIMIT_EXCEEDED");
    rows.push(cells);
    cells = [];
    logicalRow += 1;
    fieldColumn = 1;
    recordTouched = false;
    consumeNewline();
    fieldLine = line;
    fieldSourceColumn = physicalColumn;
    state = "field_start";
  };

  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    const width = character.length;
    const isNewline = character === "\n" || character === "\r";

    if (state === "quoted") {
      if (character === '"') {
        if (text[index + width] === '"') {
          appendCharacter('"');
          consumeCharacter('"');
          consumeCharacter('"');
        } else {
          consumeCharacter('"');
          state = "after_quote";
        }
      } else if (character === "\r") {
        if (text[index + 1] !== "\n") throw invalid("Bare CR inside a quoted field", "CSV_SYNTAX_INVALID");
        appendCharacter("\r\n");
        consumeNewline();
      } else if (character === "\n") {
        appendCharacter("\n");
        consumeNewline();
      } else {
        appendCharacter(character);
        consumeCharacter(character);
      }
      continue;
    }

    if (state === "after_quote") {
      if (character === ",") {
        finishCell();
        consumeCharacter(character);
        beginNextField();
        recordTouched = true;
      } else if (isNewline) {
        finishRecord();
      } else {
        throw invalid("Unexpected character after a closing quote", "CSV_SYNTAX_INVALID");
      }
      continue;
    }

    if (state === "field_start") {
      if (character === '"') {
        consumeCharacter(character);
        state = "quoted";
        recordTouched = true;
      } else if (character === ",") {
        finishCell();
        consumeCharacter(character);
        beginNextField();
        recordTouched = true;
      } else if (isNewline) {
        finishRecord();
      } else {
        appendCharacter(character);
        consumeCharacter(character);
        state = "unquoted";
        recordTouched = true;
      }
      continue;
    }

    // state === "unquoted"
    if (character === '"') throw invalid("Quote inside an unquoted field", "CSV_SYNTAX_INVALID");
    if (character === ",") {
      finishCell();
      consumeCharacter(character);
      beginNextField();
      recordTouched = true;
    } else if (isNewline) {
      finishRecord();
    } else {
      appendCharacter(character);
      consumeCharacter(character);
    }
  }

  if (state === "quoted") throw invalid("CSV ends inside a quoted field", "CSV_SYNTAX_INVALID");
  if (recordTouched || cells.length || fieldColumn > 1) {
    finishCell();
    if (rows.length >= limits.maxRows) throw invalid("CSV exceeds the row limit", "CSV_LIMIT_EXCEEDED");
    rows.push(cells);
  }

  return { rows, bytes, cellCount };
}

module.exports = { DEFAULT_LIMITS, parseCsv };
