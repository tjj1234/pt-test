'use strict';

// Non-integrated dirfd primitives for a future backup implementation. Darwin
// 64-bit enumeration uses the locally verified dirent ABI; Linux fails closed
// until its target ABI is verified.
const fs = require('node:fs');
const path = require('node:path');
const koffi = require('koffi');

const HANDLE = Symbol('backup-fs-dirfd');
let native;
let darwinDirent;

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function apiForPlatform() {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw fail('BACKUP_FS_PLATFORM_UNSUPPORTED', 'dirfd operations are unsupported on this platform');
  if (native) return native;
  const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  const libc = koffi.load(library);
  native = {
    openat: libc.func('int openat(int dirfd, const char *pathname, int flags, int mode)'),
    mkdirat: libc.func('int mkdirat(int dirfd, const char *pathname, int mode)'),
    unlinkat: libc.func('int unlinkat(int dirfd, const char *pathname, int flags)'),
    linkat: libc.func('int linkat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, int flags)'),
    close: libc.func('int close(int fd)'),
  };
  return native;
}
function apiForDarwinEnumeration() {
  if (process.platform !== 'darwin') throw fail('BACKUP_FS_ENUMERATION_UNSUPPORTED', 'safe directory enumeration is not implemented for this ABI');
  const api = apiForPlatform();
  if (!api.dup) {
    const library = '/usr/lib/libSystem.B.dylib';
    const libc = koffi.load(library);
    api.dup = libc.func('int dup(int oldfd)');
    api.fdopendir = libc.func('void *fdopendir(int fd)');
    api.readdir = libc.func('void *readdir(void *dirp)');
    api.closedir = libc.func('int closedir(void *dirp)');
    api.rewinddir = libc.func('void rewinddir(void *dirp)');
    api.errnoLocation = libc.func('int *__error(void)');
    // MacOSX SDK sys/dirent.h under __DARWIN_64_BIT_INO_T defines the ABI as
    // uint64 ino, uint64 seekoff, uint16 reclen, uint16 namlen, uint8 type,
    // char name[1024]. The host is arm64 and Node is a 64-bit Darwin process.
    darwinDirent = koffi.struct('NorthstarDarwinDirent64Header', {
      d_ino: 'uint64', d_seekoff: 'uint64', d_reclen: 'uint16', d_namlen: 'uint16', d_type: 'uint8',
    });
  }
  return api;
}
function component(value, label = 'name') {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) {
    throw fail('BACKUP_FS_COMPONENT_INVALID', `${label} must be one safe path component`);
  }
  return value;
}
function stateOf(handle) {
  const state = handle && handle[HANDLE];
  if (!state || state.closed) throw fail('BACKUP_FS_HANDLE_CLOSED', 'directory handle is closed');
  return state;
}
function openAt(api, dirfd, name, flags, mode = 0) {
  const fd = api.openat(dirfd, name, flags, mode);
  if (!Number.isInteger(fd) || fd < 0) throw fail('BACKUP_FS_OPEN_FAILED', 'relative open failed');
  return fd;
}
function requireDirectory(fd) {
  if (!fs.fstatSync(fd).isDirectory()) throw fail('BACKUP_FS_NOT_DIRECTORY', 'opened entry is not a directory');
}

function createHandle(api, fd) {
  const handle = {};
  Object.defineProperty(handle, HANDLE, { value: { api, fd, closed: false } });
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC || 0);
  handle.openDirectory = (name) => {
    const state = stateOf(handle);
    const childFd = openAt(state.api, state.fd, component(name), directoryFlags);
    try { requireDirectory(childFd); return createHandle(state.api, childFd); }
    catch (error) { state.api.close(childFd); throw error; }
  };
  handle.openFile = (name, { mode = 0o600, createExclusive = false, writeOnly = false } = {}) => {
    const state = stateOf(handle);
    const access = writeOnly ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
    const create = createExclusive ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0;
    const flags = access | create | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC || 0) | (fs.constants.O_NONBLOCK || 0);
    const fileFd = openAt(state.api, state.fd, component(name), flags, mode);
    try {
      if (!fs.fstatSync(fileFd).isFile()) throw fail('BACKUP_FS_NOT_REGULAR_FILE', 'opened entry is not a regular file');
      if (createExclusive) fs.fchmodSync(fileFd, mode & 0o777);
    } catch (error) { fs.closeSync(fileFd); throw error; }
    return fileFd;
  };
  handle.mkdir = (name, mode = 0o700) => {
    const state = stateOf(handle);
    if (state.api.mkdirat(state.fd, component(name), mode) !== 0) throw fail('BACKUP_FS_MKDIR_FAILED', 'relative mkdir failed');
    const child = handle.openDirectory(name);
    try { fs.fchmodSync(stateOf(child).fd, mode & 0o777); } finally { child.close(); }
  };
  handle.unlinkFile = (name) => {
    const state = stateOf(handle);
    if (state.api.unlinkat(state.fd, component(name), 0) !== 0) throw fail('BACKUP_FS_UNLINK_FAILED', 'relative unlink failed');
  };
  handle.linkFile = (name, destination, destinationName) => {
    const sourceState = stateOf(handle); const destinationState = stateOf(destination);
    if (sourceState.api.linkat(sourceState.fd, component(name), destinationState.fd, component(destinationName), 0) !== 0) throw fail('BACKUP_FS_LINK_FAILED', 'relative link failed');
  };
  handle.chmodFile = (name, mode) => {
    const fileFd = handle.openFile(name);
    try { fs.fchmodSync(fileFd, mode & 0o777); } finally { fs.closeSync(fileFd); }
  };
  handle.chmodDirectory = (name, mode) => {
    const child = handle.openDirectory(name);
    try { fs.fchmodSync(stateOf(child).fd, mode & 0o777); } finally { child.close(); }
  };
  handle.close = () => {
    const state = handle[HANDLE];
    if (!state.closed) { state.closed = true; state.api.close(state.fd); }
  };
  return handle;
}

function pinDirectory(absolutePath, { onDirectoryPinned } = {}) {
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath) || absolutePath.includes('\0')) throw fail('BACKUP_FS_ABSOLUTE_REQUIRED', 'directory path must be absolute');
  const api = apiForPlatform();
  const normalized = path.normalize(absolutePath);
  const root = path.parse(normalized).root;
  const parts = normalized.slice(root.length).split(path.sep).filter(Boolean);
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC || 0);
  let fd = fs.openSync(root, flags);
  try {
    requireDirectory(fd);
    for (const part of parts) {
      const next = openAt(api, fd, component(part, 'path component'), flags);
      try { requireDirectory(next); } catch (error) { api.close(next); throw error; }
      api.close(fd); fd = next;
      if (typeof onDirectoryPinned === 'function') onDirectoryPinned({ component: part });
    }
    const result = createHandle(api, fd);
    fd = -1;
    return result;
  } finally { if (fd >= 0) api.close(fd); }
}

function listNames(handle, { onEntryRead } = {}) {
  const state = stateOf(handle);
  const api = apiForDarwinEnumeration();
  const duplicate = api.dup(state.fd);
  if (!Number.isInteger(duplicate) || duplicate < 0) throw fail('BACKUP_FS_DUP_FAILED', 'could not duplicate pinned directory descriptor');
  const directory = api.fdopendir(duplicate);
  if (!directory) { api.close(duplicate); throw fail('BACKUP_FS_FDOPENDIR_FAILED', 'fdopendir rejected duplicated directory descriptor'); }
  const names = [];
  try {
    for (;;) {
      const errnoPointer = api.errnoLocation();
      koffi.encode(errnoPointer, 'int', 0);
      const entryPointer = api.readdir(directory);
      if (!entryPointer) {
        if (koffi.decode(errnoPointer, 'int') !== 0) throw fail('BACKUP_FS_READDIR_FAILED', 'readdir failed');
        break;
      }
      const entry = koffi.decode(entryPointer, darwinDirent);
      if (!entry.d_namlen || entry.d_namlen > 1023 || entry.d_reclen < 21 + entry.d_namlen) throw fail('BACKUP_FS_DIRENT_INVALID', 'directory entry record length is invalid');
      const name = Buffer.from(koffi.decode(entryPointer, 21, koffi.array('char', entry.d_namlen))).toString('utf8');
      if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) throw fail('BACKUP_FS_DIRENT_INVALID', 'directory entry name is invalid');
      if (name !== '.' && name !== '..') names.push(name);
      if (typeof onEntryRead === 'function') onEntryRead({ name, names: names.slice() });
    }
    return names;
  } finally { api.rewinddir(directory); api.closedir(directory); }
}

module.exports = { pinDirectory, listNames };
