"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fingerprint } = require("../contracts/phase1.cjs");

const REQUEST_KIND = "northstar.chat";
const REQUEST_VERSION = 1;
const ATTACHMENT_REQUEST_VERSION = 2;
const MODEL_REQUEST_VERSION = 3;
const SKILL_REQUEST_VERSION = 4;
const {pinSkillReleases}=require("../skills/release-snapshot.cjs");
const HASH_CHUNK_BYTES = 64 * 1024;
const TASK_TYPES = new Set(["text2image", "image2image", "text2video", "image2video"]);
const REF_RE = /^\/uploads\/([0-9a-f-]{36})\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,254})$/i;

function fail(message, code = "CHAT_REQUEST_INVALID", statusCode = 400) {
  return Object.assign(new TypeError(message), { code, statusCode });
}
function text(value, field, max) {
  if (typeof value !== "string" || value.length > max || !value.trim()) throw fail(`${field} is invalid`);
  return value;
}
function tenantUuid(value) { return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value); }

function normalizeChatRequest(input, tenantId) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Chat body must be an object");
  const allowedInput = new Set(["conversationId", "idempotencyKey", "message", "image", "documents", "csvSelections", "sourceCitations", "skillReleaseIds", "allowQuestions", "allowWeb", "allowBilling", "allowDocuments", "media", "taskType", "context", "branchFrom", "regenerate"]);
  if (Object.keys(input).some((key) => !allowedInput.has(key))) throw fail("Chat body contains unsupported fields");
  if (!tenantUuid(tenantId)) throw fail("tenantId is invalid");
  const uploadRef = (value) => {
    if (typeof value !== "string") return false;
    const match = REF_RE.exec(value);
    return Boolean(match && match[1] === tenantId && match[2] !== "." && match[2] !== "..");
  };
  const body = {};
  if(input.allowDocuments!==undefined){if(typeof input.allowDocuments!=="boolean")throw fail("allowDocuments is invalid");if(input.allowDocuments)body.allowDocuments=true;}
  if(input.allowBilling!==undefined){if(typeof input.allowBilling!=="boolean")throw fail("allowBilling is invalid");if(input.allowBilling)body.allowBilling=true;}
  if(input.allowWeb!==undefined){if(typeof input.allowWeb!=="boolean")throw fail("allowWeb is invalid");if(input.allowWeb)body.allowWeb=true;}
  if(input.allowQuestions!==undefined){if(typeof input.allowQuestions!=="boolean")throw fail("allowQuestions is invalid");if(input.allowQuestions)body.allowQuestions=true;}
  if (input.message !== undefined) body.message = text(input.message, "message", 100000);
  if(input.skillReleaseIds!==undefined){
    if(!Array.isArray(input.skillReleaseIds)||input.skillReleaseIds.length>1||input.skillReleaseIds.some(id=>typeof id!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)))throw fail('Skill selection is invalid');
    body.skillReleaseIds=[...input.skillReleaseIds];
  }
  if (input.image !== undefined && input.image !== null && input.image !== "") {
    body.image = text(input.image, "image", 2048);
    if (!uploadRef(body.image)) throw fail("image must be a tenant upload reference");
  }
  if (input.documents !== undefined) {
    if (!Array.isArray(input.documents) || input.documents.length > 32) throw fail("documents is invalid");
    body.documents = input.documents.map((value) => {
      const ref = text(value, "document", 2048);
      if (!uploadRef(ref)) throw fail("document must be a tenant upload reference");
      return ref;
    });
  }
  if (input.csvSelections !== undefined) {
    if (!Array.isArray(input.csvSelections) || input.csvSelections.length > 1) throw fail("csvSelections is invalid");
    const seen = new Set();
    body.csvSelections = input.csvSelections.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
          Object.keys(item).sort().join(",") !== "column,headerRow,sourceRef,sourceSha256,startRow" ||
          !uploadRef(item.sourceRef) || !item.sourceRef.toLowerCase().endsWith(".csv") ||
          !body.documents?.includes(item.sourceRef) || seen.has(item.sourceRef) ||
          typeof item.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceSha256) ||
          !(item.headerRow === null || (Number.isSafeInteger(item.headerRow) && item.headerRow > 0)) ||
          !Number.isSafeInteger(item.startRow) || item.startRow < 1 ||
          !Number.isSafeInteger(item.column) || item.column < 1 ||
          (item.headerRow !== null && item.headerRow >= item.startRow)) throw fail("csvSelections is invalid");
      seen.add(item.sourceRef);
      return { sourceRef: item.sourceRef, sourceSha256: item.sourceSha256,
        headerRow: item.headerRow, startRow: item.startRow, column: item.column };
    });
  }
  if (input.sourceCitations !== undefined) {
    if (!Array.isArray(input.sourceCitations) || input.sourceCitations.length>8) throw fail('sourceCitations is invalid');
    body.sourceCitations=input.sourceCitations.map(item=>{
      if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='blockIndex,sourceRef,sourceSha256,textSha256,version'||!uploadRef(item.sourceRef)||!Number.isSafeInteger(item.version)||item.version<1||!Number.isSafeInteger(item.blockIndex)||item.blockIndex<1||item.blockIndex>5000||!/^[a-f0-9]{64}$/.test(item.sourceSha256)||!/^[a-f0-9]{64}$/.test(item.textSha256))throw fail('sourceCitations is invalid');
      return {sourceRef:item.sourceRef,sourceSha256:item.sourceSha256,version:item.version,blockIndex:item.blockIndex,textSha256:item.textSha256};
    });
  }
  if (input.media !== undefined) {
    if (!Array.isArray(input.media) || input.media.length > 32) throw fail("media is invalid");
    body.media = input.media.map((item) => {
      const type = item && (item.type || item.kind);
      if (!item || typeof item !== "object" || Array.isArray(item) || !["image", "video", "audio"].includes(type)) throw fail("media item is invalid");
      const url = text(item.url, "media url", 2048);
      if (!uploadRef(url)) throw fail("media must be a tenant upload reference");
      return { type, url };
    });
  }
  if (input.taskType !== undefined && input.taskType !== null && input.taskType !== "") {
    if (!TASK_TYPES.has(input.taskType)) throw fail("taskType is invalid");
    body.taskType = input.taskType;
  }
  if (input.context !== undefined && input.context !== null) {
    if (!input.context || typeof input.context !== "object" || Array.isArray(input.context)) throw fail("context is invalid");
    if (Object.keys(input.context).some((key) => key !== "panel" && key !== "panelLabel")) throw fail("context contains unsupported fields");
    const context = {};
    for (const key of ["panel", "panelLabel"]) if (input.context[key] !== undefined) context[key] = text(input.context[key], `context.${key}`, 128);
    body.context = context;
  }
  if (input.branchFrom !== undefined && input.branchFrom !== null) {
    if (!(Number.isSafeInteger(input.branchFrom) && input.branchFrom >= 0) && !(typeof input.branchFrom === "string" && input.branchFrom.length <= 128)) throw fail("branchFrom is invalid");
    body.branchFrom = input.branchFrom;
  }
  if (input.regenerate !== undefined) {
    if (typeof input.regenerate !== "boolean") throw fail("regenerate is invalid");
    body.regenerate = input.regenerate;
  }
  if (!body.regenerate && body.branchFrom === undefined && !body.message) throw fail("message is required");
  if(body.allowDocuments&&(body.allowBilling||body.allowWeb||body.allowQuestions||body.taskType||body.skillReleaseIds?.length||body.csvSelections?.length))throw fail("Document export mode cannot be combined with another tool mode");
  if(body.allowBilling&&(body.allowWeb||body.allowQuestions||body.taskType||body.skillReleaseIds?.length||body.csvSelections?.length))throw fail("Billing mode cannot be combined with another tool mode");
  if(body.allowWeb&&(body.allowQuestions||body.taskType||body.skillReleaseIds?.length||body.csvSelections?.length))throw fail("Web mode cannot be combined with another tool mode");
  if(body.allowQuestions&&(body.taskType||body.skillReleaseIds?.length||body.csvSelections?.length))throw fail("Question mode cannot be combined with another tool mode");
  fingerprint(body);
  return { kind: REQUEST_KIND, schemaVersion: REQUEST_VERSION, body };
}

function attachmentRefs(body) {
  const refs = [body.image, ...(Array.isArray(body.documents) ? body.documents : []), ...(Array.isArray(body.sourceCitations)?body.sourceCitations.map(item=>item.sourceRef):[]), ...(Array.isArray(body.media) ? body.media.map((item) => item?.url) : [])].filter(Boolean);
  return [...new Set(refs)];
}

function parseCanonicalRequest(request, tenantId) {
  if(request?.schemaVersion===SKILL_REQUEST_VERSION){
    const {pinnedSkills,...base}=request;
    if(!pinnedSkills||Object.keys(pinnedSkills).sort().join(',')!=='pinHash,schemaVersion,skills'||pinnedSkills.schemaVersion!==1||!Array.isArray(pinnedSkills.skills)||pinnedSkills.skills.length>1)throw fail('Durable skill pin is invalid');
    for(const pin of pinnedSkills.skills)if(!pin||Object.keys(pin).sort().join(',')!=='contentHash,releaseId,skillId,version'||! /^[a-f0-9-]{36}$/i.test(pin.releaseId||''))throw fail('Durable skill pin is invalid');
    let snapshot;try{snapshot=pinSkillReleases(pinnedSkills.skills.map(pin=>({schemaVersion:1,...pin})));}catch{throw fail('Durable skill pin is invalid');}
    if(crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')!==pinnedSkills.pinHash)throw fail('Durable skill pin is invalid');
    base.schemaVersion=MODEL_REQUEST_VERSION;const parsed=parseCanonicalRequest(base,tenantId);
    if(JSON.stringify(parsed.request.body.skillReleaseIds||[])!==JSON.stringify(pinnedSkills.skills.map(pin=>pin.releaseId)))throw fail('Durable skill selection mismatch');
    return {refs:parsed.refs,request:{...parsed.request,schemaVersion:SKILL_REQUEST_VERSION,pinnedSkills}};
  }
  if (request?.schemaVersion !== MODEL_REQUEST_VERSION) return parseBaseRequest(request, tenantId);
  if (Object.keys(request).some((key) => !["kind", "schemaVersion", "body", "attachmentEvidence", "modelSelection"].includes(key))) throw fail("Durable chat request contains unsupported fields");
  const selection = request.modelSelection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection) || Object.keys(selection).some(key => !["requestedModelId", "reasoningEffort"].includes(key)) || typeof selection.requestedModelId !== "string" || !selection.requestedModelId.trim() || selection.requestedModelId !== selection.requestedModelId.trim() || selection.requestedModelId.length > 512) throw fail("Durable model selection is invalid");
  if (selection.reasoningEffort !== undefined && (selection.requestedModelId === "AUTO" || typeof selection.reasoningEffort !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(selection.reasoningEffort))) throw fail("Durable reasoning selection is invalid");
  const { modelSelection, ...base } = request;
  base.schemaVersion = Object.hasOwn(base, "attachmentEvidence") ? ATTACHMENT_REQUEST_VERSION : REQUEST_VERSION;
  const parsed = parseBaseRequest(base, tenantId);
  return { refs: parsed.refs, request: { ...parsed.request, schemaVersion: MODEL_REQUEST_VERSION, modelSelection: { requestedModelId: selection.requestedModelId, ...(selection.reasoningEffort === undefined ? {} : {reasoningEffort:selection.reasoningEffort}) } } };
}

// Capture the server-owned preference before enqueue. Client body cannot carry
// this field; recovery reuses the stored choice, never the latest preference.
function bindChatModelSelection(request, tenantId, requestedModelId, reasoningEffort = null) {
  if (request?.schemaVersion === MODEL_REQUEST_VERSION) throw fail("Model selection is already bound");
  return parseCanonicalRequest({ ...request, schemaVersion: MODEL_REQUEST_VERSION, modelSelection: { requestedModelId, ...(reasoningEffort === null ? {} : {reasoningEffort}) } }, tenantId).request;
}
function bindChatSkillPins(request,tenantId,pinnedSkills){if(request?.schemaVersion!==MODEL_REQUEST_VERSION)throw fail('Model snapshot must precede skill pin');return parseCanonicalRequest({...request,schemaVersion:SKILL_REQUEST_VERSION,pinnedSkills},tenantId).request;}
function chatRequestIdempotencyView(request, tenantId) {
  if (request?.kind !== REQUEST_KIND || ! [MODEL_REQUEST_VERSION,SKILL_REQUEST_VERSION].includes(request.schemaVersion)) return request;
  const canonical = parseCanonicalRequest(request, tenantId).request;
  const { modelSelection, pinnedSkills, ...base } = canonical;
  base.schemaVersion = Object.hasOwn(base, "attachmentEvidence") ? ATTACHMENT_REQUEST_VERSION : REQUEST_VERSION;
  return base;
}

function parseBaseRequest(request, tenantId) {
  if (!request || typeof request !== "object" || Array.isArray(request) || request.kind !== REQUEST_KIND || ![REQUEST_VERSION, ATTACHMENT_REQUEST_VERSION].includes(request.schemaVersion) || !request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw fail("Unsupported durable chat request", "CHAT_REQUEST_UNSUPPORTED");
  }
  const allowedEnvelope = request.schemaVersion === REQUEST_VERSION ? ["kind", "schemaVersion", "body"] : ["kind", "schemaVersion", "body", "attachmentEvidence"];
  if (Object.keys(request).some((key) => !allowedEnvelope.includes(key))) throw fail("Durable chat request contains unsupported fields");
  const normalized = normalizeChatRequest(request.body, tenantId);
  if (fingerprint(normalized.body) !== fingerprint(request.body)) throw fail("Durable chat request is not canonical");
  const refs = attachmentRefs(normalized.body);
  if (request.schemaVersion === REQUEST_VERSION) {
    if (refs.length) throw fail("Durable attachment evidence is missing", "CHAT_ATTACHMENT_EVIDENCE_MISSING", 409);
    return { request: normalized, refs };
  }
  if (!refs.length || !Array.isArray(request.attachmentEvidence) || request.attachmentEvidence.length !== refs.length) throw fail("Durable attachment evidence is invalid", "CHAT_ATTACHMENT_EVIDENCE_INVALID", 409);
  const evidence = request.attachmentEvidence.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "ref,sha256,size" || item.ref !== refs[index] || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0) {
      throw fail("Durable attachment evidence is invalid", "CHAT_ATTACHMENT_EVIDENCE_INVALID", 409);
    }
    return { ref: item.ref, sha256: item.sha256, size: item.size };
  });
  return { request: { kind: REQUEST_KIND, schemaVersion: ATTACHMENT_REQUEST_VERSION, body: normalized.body, attachmentEvidence: evidence }, refs };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readUploadEvidence(uploadsRoot, tenantId, ref, { includeBytes = false, maxBytes } = {}) {
  const match = REF_RE.exec(ref);
  if (!match || match[1] !== tenantId || match[2] === "." || match[2] === "..") throw fail("Attachment is not scoped to the authenticated tenant", "CHAT_ATTACHMENT_SCOPE_INVALID", 403);
  if (typeof uploadsRoot !== "string" || !path.isAbsolute(uploadsRoot)) throw fail("Upload root must be an absolute trusted path", "CHAT_ATTACHMENT_ROOT_INVALID", 500);

  const rootPath = path.resolve(uploadsRoot);
  const tenantPath = path.join(rootPath, tenantId);
  const filePath = path.join(tenantPath, match[2]);
  let rootReal, tenantStat, tenantReal, fileStat, fileReal;
  try {
    rootReal = await fs.promises.realpath(rootPath);
    tenantStat = await fs.promises.lstat(tenantPath);
    if (!tenantStat.isDirectory() || tenantStat.isSymbolicLink()) throw new Error("tenant directory is not a regular directory");
    tenantReal = await fs.promises.realpath(tenantPath);
    fileStat = await fs.promises.lstat(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("attachment is not a regular file");
    fileReal = await fs.promises.realpath(filePath);
  } catch (error) {
    if (error.code === "CHAT_ATTACHMENT_SCOPE_INVALID") throw error;
    throw fail("Attachment is missing or is not a regular file", "CHAT_ATTACHMENT_UNAVAILABLE", 409);
  }
  const expectedFilePath = path.join(tenantReal, match[2]);
  if (!isWithin(rootReal, tenantReal) || tenantReal === rootReal || !isWithin(tenantReal, fileReal) || fileReal !== expectedFilePath) {
    throw fail("Attachment resolves outside the authenticated tenant upload directory", "CHAT_ATTACHMENT_SCOPE_INVALID", 403);
  }

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let handle;
  try {
    handle = await fs.promises.open(fileReal, fs.constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if(maxBytes!==undefined&&(!Number.isSafeInteger(maxBytes)||maxBytes<0||opened.size>maxBytes))throw fail('Attachment exceeds byte budget','CHAT_ATTACHMENT_TOO_LARGE',409);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.dev !== fileStat.dev || opened.ino !== fileStat.ino || opened.size !== fileStat.size) {
      throw fail("Attachment changed while it was being verified", "CHAT_ATTACHMENT_CHANGED", 409);
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    const chunks = includeBytes ? [] : null;
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (bytesRead <= 0) throw fail("Attachment changed while it was being verified", "CHAT_ATTACHMENT_CHANGED", 409);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (chunks) chunks.push(Buffer.from(chunk));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (position !== opened.size || after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs) {
      throw fail("Attachment changed while it was being verified", "CHAT_ATTACHMENT_CHANGED", 409);
    }
    return { ref, sha256: hash.digest("hex"), size: opened.size, ...(chunks ? { bytes: Buffer.concat(chunks, position) } : {}) };
  } catch (error) {
    if (error.code && error.code.startsWith("CHAT_ATTACHMENT_")) throw error;
    throw fail("Attachment could not be safely opened", "CHAT_ATTACHMENT_UNAVAILABLE", 409);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Read the exact tenant-scoped bytes while checking them against historical evidence. */
async function readVerifiedChatAttachmentBytes(ref, evidence, { uploadsRoot, identity, includeBytes = true, maxBytes } = {}) {
  assertIdentity(identity);
  if (!evidence) throw fail("Durable attachment evidence is missing", "CHAT_ATTACHMENT_EVIDENCE_MISSING", 409);
  if (typeof evidence !== "object" || Array.isArray(evidence) || Object.keys(evidence).sort().join(",") !== "ref,sha256,size" || evidence.ref !== ref || !/^[a-f0-9]{64}$/.test(evidence.sha256) || !Number.isSafeInteger(evidence.size) || evidence.size < 0) {
    throw fail("Durable attachment evidence is invalid", "CHAT_ATTACHMENT_EVIDENCE_INVALID", 409);
  }
  const current = await readUploadEvidence(uploadsRoot, identity.tenantId, ref, { includeBytes, maxBytes });
  if (current.sha256 !== evidence.sha256 || current.size !== evidence.size) throw fail("Attachment changed after request persistence", "CHAT_ATTACHMENT_CHANGED", 409);
  return current.bytes || null;
}

function assertIdentity(identity) {
  if (!identity || typeof identity !== "object" || typeof identity.userId !== "string" || !identity.userId.trim() || !tenantUuid(identity.tenantId)) {
    throw fail("A trusted user and tenant identity is required", "CHAT_ATTACHMENT_IDENTITY_INVALID", 403);
  }
}

/** Capture a content snapshot before persisting a new request. Text-only v1 remains unchanged. */
async function captureDurableChatAttachments(request, { uploadsRoot, identity } = {}) {
  assertIdentity(identity);
  if (!request || request.kind !== REQUEST_KIND || request.schemaVersion !== REQUEST_VERSION) throw fail("Only a normalized v1 request can be captured");
  if (Object.keys(request).some((key) => !["kind", "schemaVersion", "body"].includes(key))) throw fail("Durable chat request contains unsupported fields");
  const body = normalizeChatRequest(request.body, identity.tenantId).body;
  if (fingerprint(body) !== fingerprint(request.body)) throw fail("Durable chat request is not canonical");
  const normalized = { kind: REQUEST_KIND, schemaVersion: REQUEST_VERSION, body };
  const refs = attachmentRefs(body);
  if (!refs.length) return normalized;
  const attachmentEvidence = [];
  for (const ref of refs) attachmentEvidence.push(await readUploadEvidence(uploadsRoot, identity.tenantId, ref));
  for (const selection of body.csvSelections || []) {
    if (attachmentEvidence.find((item) => item.ref === selection.sourceRef)?.sha256 !== selection.sourceSha256) {
      throw fail("Selected CSV changed after preview", "CHAT_ATTACHMENT_CHANGED", 409);
    }
  }
  return { kind: REQUEST_KIND, schemaVersion: ATTACHMENT_REQUEST_VERSION, body: normalized.body, attachmentEvidence };
}

/** Recheck persisted evidence immediately before execution; any missing/changed attachment fails closed. */
async function verifyDurableChatAttachments(request, { uploadsRoot, identity } = {}) {
  assertIdentity(identity);
  const parsed = parseCanonicalRequest(request, identity.tenantId);
  if (!parsed.refs.length) return parsed.request;
  if (!Array.isArray(parsed.request.attachmentEvidence)) throw fail("Durable attachment evidence is missing", "CHAT_ATTACHMENT_EVIDENCE_MISSING", 409);
  for (let i = 0; i < parsed.refs.length; i++) {
    const current = await readUploadEvidence(uploadsRoot, identity.tenantId, parsed.refs[i]);
    const expected = parsed.request.attachmentEvidence[i];
    if (current.sha256 !== expected.sha256 || current.size !== expected.size) throw fail("Attachment changed after request persistence", "CHAT_ATTACHMENT_CHANGED", 409);
  }
  return parsed.request;
}

function isReplayableChatRequest(request, expectedTenantId = null) {
  if (!tenantUuid(expectedTenantId)) return false;
  try {
    const parsed = parseCanonicalRequest(request, expectedTenantId);
    const refs = parsed.refs;
    if (refs.length && !Array.isArray(parsed.request.attachmentEvidence)) return false;
    return refs.every((ref) => {
      const match = REF_RE.exec(ref);
      return Boolean(match && match[1] === expectedTenantId && match[2] !== "." && match[2] !== "..");
    });
  } catch { return false; }
}

function validateStoredChatRequest(request, tenantId) {
  return parseCanonicalRequest(request, tenantId).request;
}

module.exports = {
  REQUEST_KIND,
  REQUEST_VERSION,
  ATTACHMENT_REQUEST_VERSION,
  MODEL_REQUEST_VERSION,
  SKILL_REQUEST_VERSION,
  bindChatSkillPins,
  bindChatModelSelection,
  chatRequestIdempotencyView,
  normalizeChatRequest,
  captureDurableChatAttachments,
  readVerifiedChatAttachmentBytes,
  verifyDurableChatAttachments,
  isReplayableChatRequest,
  validateStoredChatRequest,
};
