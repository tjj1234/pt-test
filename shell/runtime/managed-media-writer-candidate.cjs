'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {types}=require('node:util');
const { pinDirectory } = require('./backup-fs.cjs');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MiB
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MiB

const ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: 'MANAGED_MEDIA_WRITER_ARGUMENT_INVALID',
  SIZE_INVALID: 'MANAGED_MEDIA_WRITER_SIZE_INVALID',
  SIGNATURE_MISMATCH: 'MANAGED_MEDIA_WRITER_SIGNATURE_MISMATCH',
  WRITE_FAILED: 'MANAGED_MEDIA_WRITER_WRITE_FAILED',
});

const ALLOWED_OPTIONS = Object.freeze(new Set([
  'workspaceRoot',
  'tenantId',
  'runId',
  'buffer',
  'kind',
  'mime',
]));

const MIME_SPECS = Object.freeze({
  'image/png': Object.freeze({ kind: 'image', ext: '.png', name: 'generated-image.png' }),
  'image/jpeg': Object.freeze({ kind: 'image', ext: '.jpg', name: 'generated-image.jpg' }),
  'image/gif': Object.freeze({ kind: 'image', ext: '.gif', name: 'generated-image.gif' }),
  'image/webp': Object.freeze({ kind: 'image', ext: '.webp', name: 'generated-image.webp' }),
  'image/avif': Object.freeze({ kind: 'image', ext: '.avif', name: 'generated-image.avif' }),
  'video/mp4': Object.freeze({ kind: 'video', ext: '.mp4', name: 'generated-video.mp4' }),
  'video/quicktime': Object.freeze({ kind: 'video', ext: '.mov', name: 'generated-video.mov' }),
  'video/webm': Object.freeze({ kind: 'video', ext: '.webm', name: 'generated-video.webm' }),
});

const KNOWN_MP4_BRANDS = Object.freeze(new Set([
  'isom', 'iso2', 'mp41', 'mp42', 'dash', 'avc1', 'M4V ', 'M4VH', 'mp71',
]));

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Validates bounded magic bytes for media types without copying the full buffer.
 *
 * @param {Buffer} buf - Media content buffer
 * @param {string} mime - Declared MIME type
 * @returns {boolean} Whether content matches the expected magic bytes
 */
function verifyMagicBytes(buf, mime) {
  if (types.isProxy(buf) || !Buffer.isBuffer(buf) || Object.getPrototypeOf(buf)!==Buffer.prototype || Object.hasOwn(buf,'length') || buf.length < 3) return false;

  switch (mime) {
    case 'image/png':
      return (
        buf.length >= 8 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf[4] === 0x0d &&
        buf[5] === 0x0a &&
        buf[6] === 0x1a &&
        buf[7] === 0x0a
      );

    case 'image/jpeg':
      return (
        buf.length >= 3 &&
        buf[0] === 0xff &&
        buf[1] === 0xd8 &&
        buf[2] === 0xff
      );

    case 'image/gif': {
      if (buf.length < 6) return false;
      const sig = Buffer.prototype.toString.call(buf,'ascii',0,6);
      return sig === 'GIF87a' || sig === 'GIF89a';
    }

    case 'image/webp': {
      if (buf.length < 12) return false;
      return (
        Buffer.prototype.toString.call(buf,'ascii',0,4) === 'RIFF' &&
        Buffer.prototype.toString.call(buf,'ascii',8,12) === 'WEBP'
      );
    }

    case 'image/avif':
    case 'video/mp4':
    case 'video/quicktime': {
      if (buf.length < 16 || Buffer.prototype.toString.call(buf,'ascii',4,8) !== 'ftyp') return false;
      const boxSize=Buffer.prototype.readUInt32BE.call(buf,0);
      if (boxSize<16 || boxSize>buf.length || boxSize%4!==0) return false;
      const allowed=brand=>mime==='image/avif' ? brand==='avif'||brand==='avis'
        : mime==='video/quicktime' ? brand==='qt  ' : KNOWN_MP4_BRANDS.has(brand);
      if (allowed(Buffer.prototype.toString.call(buf,'ascii',8,12))) return true;
      for (let offset=16;offset+4<=Math.min(boxSize,64);offset+=4) {
        if (allowed(Buffer.prototype.toString.call(buf,'ascii',offset,offset+4))) return true;
      }
      return false;
    }

    case 'video/webm': {
      if (buf.length < 8) return false;
      // EBML ID: 0x1A 0x45 0xDF 0xA3
      if (
        buf[0] !== 0x1a ||
        buf[1] !== 0x45 ||
        buf[2] !== 0xdf ||
        buf[3] !== 0xa3
      ) {
        return false;
      }
      // Check for 'webm' docType in bounded header
      const headerSlice = Buffer.prototype.subarray.call(buf,0,Math.min(buf.length,64));
      return Buffer.prototype.indexOf.call(headerSlice,Buffer.from('webm','ascii')) !== -1;
    }

    default:
      return false;
  }
}

function openOrCreate(parent, name) {
  try {
    return parent.openDirectory(name);
  } catch (error) {
    if (error?.code !== 'BACKUP_FS_OPEN_FAILED') throw error;
    try {
      parent.mkdir(name, 0o700);
    } catch {
      // Concurrently created directory
      return parent.openDirectory(name);
    }
    return parent.openDirectory(name);
  }
}

/**
 * Atomically writes managed media artifact using secure pinned directory handles.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot - Absolute existing workspace directory
 * @param {string} options.tenantId - Valid UUID
 * @param {string} options.runId - Valid UUID
 * @param {Buffer} options.buffer - Raw binary Buffer
 * @param {'image'|'video'} options.kind - Media kind
 * @param {string} options.mime - Strict lowercase MIME type
 * @returns {object} Deeply frozen artifact metadata: { rel, name, kind, mime, size, sha256 }
 */
function writeManagedMediaArtifact(options = {}) {
  if (types.isProxy(options) || !options || typeof options !== 'object' || Array.isArray(options) || ![Object.prototype,null].includes(Object.getPrototypeOf(options))) {
    throw fail(ERROR_CODES.ARGUMENT_INVALID, 'Managed media options must be a plain object');
  }
  const keys=Reflect.ownKeys(options),values={};
  if(keys.length!==ALLOWED_OPTIONS.size)throw fail(ERROR_CODES.ARGUMENT_INVALID,'Managed media options are invalid');
  for(const key of keys){
    if(typeof key!=='string'||!ALLOWED_OPTIONS.has(key))throw fail(ERROR_CODES.ARGUMENT_INVALID,'Managed media options are invalid');
    const desc=Object.getOwnPropertyDescriptor(options,key);
    if(!desc||!desc.enumerable||!Object.hasOwn(desc,'value'))throw fail(ERROR_CODES.ARGUMENT_INVALID,'Managed media options are invalid');
    values[key]=desc.value;
  }
  const { workspaceRoot, tenantId, runId, buffer, kind, mime } = values;

  if (
    typeof workspaceRoot !== 'string' ||
    !path.isAbsolute(workspaceRoot) ||
    workspaceRoot.includes('\0')
  ) {
    throw fail(ERROR_CODES.ARGUMENT_INVALID, 'Workspace root must be an absolute path');
  }

  if (typeof tenantId !== 'string' || !UUID_REGEX.test(tenantId)) {
    throw fail(ERROR_CODES.ARGUMENT_INVALID, 'Tenant ID must be a valid UUID');
  }

  if (typeof runId !== 'string' || !UUID_REGEX.test(runId)) {
    throw fail(ERROR_CODES.ARGUMENT_INVALID, 'Run ID must be a valid UUID');
  }

  if (types.isProxy(buffer) || !Buffer.isBuffer(buffer) || Object.getPrototypeOf(buffer)!==Buffer.prototype || Object.hasOwn(buffer,'length')) {
    throw fail(ERROR_CODES.ARGUMENT_INVALID, 'Buffer must be a Node.js Buffer');
  }

  if (kind !== 'image' && kind !== 'video') {
    throw fail(ERROR_CODES.ARGUMENT_INVALID, 'Media kind must be image or video');
  }

  if (typeof mime !== 'string' || mime !== mime.toLowerCase()) {
    throw fail(ERROR_CODES.ARGUMENT_INVALID, 'MIME type must be a lowercase string');
  }

  const spec = Object.hasOwn(MIME_SPECS,mime) ? MIME_SPECS[mime] : null;
  if (!spec || spec.kind !== kind) {
    throw fail(ERROR_CODES.ARGUMENT_INVALID, 'Unsupported MIME type or kind mismatch');
  }

  // Length validation upfront
  if (buffer.length === 0) {
    throw fail(ERROR_CODES.SIZE_INVALID, 'Media buffer cannot be empty');
  }

  const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (buffer.length > maxBytes) {
    throw fail(ERROR_CODES.SIZE_INVALID, 'Media buffer exceeds maximum allowed size');
  }

  // Magic bytes signature verification
  if (!verifyMagicBytes(buffer, mime)) {
    throw fail(ERROR_CODES.SIGNATURE_MISMATCH, 'Media content signature does not match declared MIME');
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync(workspaceRoot);
  } catch {
    throw fail(ERROR_CODES.WRITE_FAILED, 'Workspace root does not exist or cannot be resolved');
  }

  let rootHandle;
  let tenantHandle, mediaDirHandle, runDirHandle;
  let tempName = null;
  let tempCreated = false;

  try {
    rootHandle=pinDirectory(realRoot);
    tenantHandle = openOrCreate(rootHandle, tenantId);
    mediaDirHandle = openOrCreate(tenantHandle, 'media-results');
    runDirHandle = openOrCreate(mediaDirHandle, runId);

    const token = crypto.randomUUID();
    tempName = `.pending-${token}`;
    const finalName = `${token}${spec.ext}`;

    let fd;
    try {
      fd = runDirHandle.openFile(tempName, {
        createExclusive: true,
        writeOnly: true,
        mode: 0o600,
      });
      tempCreated=true;

      let offset = 0;
      while (offset < buffer.length) {
        const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
        if (written <= 0) {
          throw fail(ERROR_CODES.WRITE_FAILED, 'Failed to write bytes to media file');
        }
        offset += written;
      }
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }

    // Atomically link into final immutable destination
    runDirHandle.linkFile(tempName, runDirHandle, finalName);
    runDirHandle.unlinkFile(tempName);
    tempName = null;
    tempCreated=false;

    const result = {
      rel: `media-results/${runId}/${finalName}`,
      name: spec.name,
      kind,
      mime,
      size: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    };

    return Object.freeze(result);
  } catch (error) {
    if (tempCreated && tempName && runDirHandle) {
      try { runDirHandle.unlinkFile(tempName); } catch {}
    }
    if (
      error?.code === ERROR_CODES.ARGUMENT_INVALID ||
      error?.code === ERROR_CODES.SIZE_INVALID ||
      error?.code === ERROR_CODES.SIGNATURE_MISMATCH
    ) {
      throw error;
    }
    throw fail(ERROR_CODES.WRITE_FAILED, 'Managed media artifact could not be published');
  } finally {
    runDirHandle?.close();
    mediaDirHandle?.close();
    tenantHandle?.close();
    rootHandle?.close();
  }
}

const PUBLIC_MP4_BRANDS=Object.freeze([...KNOWN_MP4_BRANDS]);
module.exports = {
  ERROR_CODES,
  KNOWN_MP4_BRANDS: PUBLIC_MP4_BRANDS,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MIME_SPECS,
  verifyMagicBytes,
  writeManagedMediaArtifact,
};
