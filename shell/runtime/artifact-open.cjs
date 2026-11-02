'use strict';

const fs = require('node:fs');
const path = require('node:path');
const koffi = require('koffi');

let libc;
let openatNative;
let closeNative;

function nativeFs() {
  if (openatNative) return { openat: openatNative, close: closeNative };
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw Object.assign(new Error('Race-safe artifact access is unsupported on this platform'), { code: 'ARTIFACT_PLATFORM_UNSUPPORTED' });
  }
  const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  libc = koffi.load(library);
  openatNative = libc.func('int openat(int dirfd, const char *pathname, int flags, int mode)');
  closeNative = libc.func('int close(int fd)');
  return { openat: openatNative, close: closeNative };
}

function fail(code = 'ARTIFACT_OPEN_FAILED') {
  return Object.assign(new Error('Artifact path could not be opened safely'), { code });
}

function openAt(openat, dirFd, component, flags) {
  const fd = openat(dirFd, component, flags, 0);
  if (!Number.isInteger(fd) || fd < 0) throw fail();
  return fd;
}

function closeQuietly(close, fd) {
  if (Number.isInteger(fd) && fd >= 0) {
    try { close(fd); } catch { /* best effort after another failure */ }
  }
}

/**
 * Open an artifact by walking from the filesystem root with openat and
 * O_NOFOLLOW. Every directory is pinned by its fd before the next path segment
 * is opened, so renaming/replacing an ancestor cannot redirect the leaf open.
 * Files with multiple hard links are rejected because their tenant provenance
 * cannot be established from a pathname alone.
 *
 * onDirectoryOpened is an internal deterministic race-test hook. Production
 * callers must omit it.
 */
function openTenantArtifact({ workspaceRoot, tenantId, relativePath, onDirectoryOpened } = {}) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) ||
      typeof tenantId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tenantId) ||
      typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\0')) {
    throw fail('ARTIFACT_PATH_INVALID');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw fail('ARTIFACT_PATH_INVALID');
  const { openat, close } = nativeFs();
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC || 0);
  // Non-blocking open makes special files such as a FIFO reach the post-open
  // fstat rejection instead of blocking the synchronous Node event loop.
  // It has no effect on regular-file reads, which are the only opened type we
  // return to callers.
  const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC || 0) | (fs.constants.O_NONBLOCK || 0);
  const workspaceReal = fs.realpathSync(workspaceRoot);
  const tenantPath = path.join(workspaceReal, tenantId);
  const tenantReal = fs.realpathSync(tenantPath);
  if (tenantReal !== path.resolve(workspaceReal, tenantId)) throw fail('ARTIFACT_TENANT_ESCAPE');
  const tenantStat = fs.statSync(tenantReal);
  const rootPath = path.parse(workspaceReal).root;
  const rootSegments = workspaceReal.slice(rootPath.length).split(path.sep).filter(Boolean);
  let directoryFd = fs.openSync(rootPath, directoryFlags);
  let fileFd = -1;
  try {
    for (const [index, component] of [...rootSegments, tenantId].entries()) {
      const nextFd = openAt(openat, directoryFd, component, directoryFlags);
      closeQuietly(close, directoryFd);
      directoryFd = nextFd;
      if (index === rootSegments.length && (fs.fstatSync(directoryFd).dev !== tenantStat.dev || fs.fstatSync(directoryFd).ino !== tenantStat.ino)) {
        throw fail('ARTIFACT_TENANT_CHANGED');
      }
    }
    for (let index = 0; index < parts.length - 1; index += 1) {
      const nextFd = openAt(openat, directoryFd, parts[index], directoryFlags);
      closeQuietly(close, directoryFd);
      directoryFd = nextFd;
      if (typeof onDirectoryOpened === 'function') onDirectoryOpened({ index, component: parts[index], fd: directoryFd });
    }
    fileFd = openAt(openat, directoryFd, parts[parts.length - 1], fileFlags);
    const stat = fs.fstatSync(fileFd);
    if (!stat.isFile() || stat.nlink !== 1) throw fail(stat.nlink !== 1 ? 'ARTIFACT_HARDLINK_REJECTED' : 'ARTIFACT_NOT_REGULAR_FILE');
    const opened = { fd: fileFd, stat, path: path.join(tenantReal, ...parts) };
    fileFd = -1;
    return opened;
  } catch (error) {
    if (fileFd >= 0) closeQuietly(close, fileFd);
    throw error;
  } finally {
    closeQuietly(close, directoryFd);
  }
}

module.exports = { openTenantArtifact };
