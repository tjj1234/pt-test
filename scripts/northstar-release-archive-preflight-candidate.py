#!/usr/bin/env python3
"""
northstar-release-archive-preflight-candidate.py

Read-only, secure preflight inspector for Northstar release archives (.tar.gz / .tar).
Validates archive authenticity (SHA256), structural integrity, resource bounds,
path hygiene, and security boundaries without unpacking or executing any content.

Contracts:
- Pure standard library Python 3.
- Reads from the exact same opened file descriptor for both hash computation and tar parsing (TOCTOU protection).
- Strictly rejects symlinks, device files, FIFOs, hardlinks, setuid/setgid/world-writable permissions.
- Strictly rejects path traversals (.., absolute paths, backslashes, NUL/control characters, duplicate/overlapping paths).
- Streaming decompress with hard bounds: max 512 MiB archive, max 512 MiB uncompressed, max 20,000 members, max 64 MiB per member.
- Safe error desensitization: returns fixed error codes and static messages without echoing member paths or secrets.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
import posixpath
import re
import stat
import sys
import tarfile
import zlib

DEFAULT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024        # 512 MiB
DEFAULT_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024   # 512 MiB
DEFAULT_MAX_MEMBERS = 20000                          # 20,000 members
DEFAULT_MAX_MEMBER_BYTES = 64 * 1024 * 1024          # 64 MiB per member

SHA256_RE = re.compile(r"^[a-fA-F0-9]{64}\Z")

ERROR_MESSAGES = {
    "INPUT_INVALID": "输入参数或预期哈希格式非法",
    "INPUT_NOT_FOUND": "输入归档文件不存在或无法访问",
    "NON_REGULAR_INPUT": "输入文件必须为常规文件，禁止符号链接或设备文件",
    "ARCHIVE_SIZE_EXCEEDED": "归档文件大小超出安全上限",
    "SHA256_MISMATCH": "归档文件SHA256哈希校验不匹配",
    "TOTAL_UNCOMPRESSED_EXCEEDED": "归档解压总字节数超出安全上限",
    "MEMBER_COUNT_EXCEEDED": "归档成员数量超出安全上限",
    "MEMBER_SIZE_EXCEEDED": "单成员解压字节数超出安全上限",
    "DISALLOWED_MEMBER_TYPE": "归档包含不允许的成员类型（仅允许常规文件与目录）",
    "INSECURE_MEMBER_PERMISSIONS": "归档成员包含不安全的文件权限（禁止setuid/setgid/全局可写）",
    "PATH_TRAVERSAL_OR_INVALID": "归档成员路径非法或存在路径穿越风险",
    "PATH_DUPLICATE": "归档包含重复的规范化路径",
    "PATH_CONFLICT": "归档包含文件与目录层级命名冲突",
    "ARCHIVE_CORRUPTED": "归档格式损坏、校验和错误或过早截断",
}


class DecompressionCountingStream(io.RawIOBase):
    """Raw stream wrapper that counts bytes read and enforces a strict ceiling."""
    def __init__(self, raw_stream, max_bytes):
        self.raw_stream = raw_stream
        self.max_bytes = max_bytes
        self.total_read = 0
        self.tail = b""

    def readinto(self, b):
        n = self.raw_stream.readinto(b)
        if n:
            self.total_read += n
            self.tail = (self.tail + bytes(b[:n]))[-1024:]
            if self.total_read > self.max_bytes:
                raise _PreflightLimitError("TOTAL_UNCOMPRESSED_EXCEEDED")
        return n

    def readable(self):
        return True


class _PreflightLimitError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _validate_member_path(raw_name):
    """
    Validate and canonicalize tar member name.
    Returns (ok, norm_path_or_error_code).
    """
    if not raw_name or not isinstance(raw_name, str):
        return False, "PATH_TRAVERSAL_OR_INVALID"

    # Reject ASCII control characters and NUL
    if any(ord(c) < 32 or ord(c) == 127 for c in raw_name):
        return False, "PATH_TRAVERSAL_OR_INVALID"

    # Reject Windows backslashes
    if "\\" in raw_name:
        return False, "PATH_TRAVERSAL_OR_INVALID"

    # Reject absolute paths
    if raw_name.startswith("/"):
        return False, "PATH_TRAVERSAL_OR_INVALID"

    # Check components before normalization
    parts = raw_name.split("/")
    for part in parts:
        if part == "..":
            return False, "PATH_TRAVERSAL_OR_INVALID"

    # Reject redundant slashes or internal dot components: e.g. "a//b", "a/./b"
    for i, part in enumerate(parts):
        if part == "" and i != len(parts) - 1:
            return False, "PATH_TRAVERSAL_OR_INVALID"
        if part == "." and i != 0:
            return False, "PATH_TRAVERSAL_OR_INVALID"

    norm = posixpath.normpath(raw_name)
    if norm.startswith("/") or norm == ".." or norm.startswith("../"):
        return False, "PATH_TRAVERSAL_OR_INVALID"

    clean_path = norm.strip("/")
    return True, clean_path


def inspect_archive(archive_path, expected_sha256, limits=None):
    """
    Pure read-only inspection of a release archive.

    Parameters:
    - archive_path: path to .tar.gz or .tar file.
    - expected_sha256: 64-character hex string of expected SHA256 digest.
    - limits: optional dict with lower ceilings:
        max_archive_bytes, max_uncompressed_bytes, max_members, max_member_bytes.

    Returns:
    - On success: {"ok": True, "sha256": hex, "members": int, "files": int, "directories": int, "totalRegularBytes": int}
    - On failure: {"ok": False, "error_code": str, "error_message": str}
    """
    # 1. Validate inputs
    if not expected_sha256 or not isinstance(expected_sha256, str):
        return {"ok": False, "error_code": "INPUT_INVALID", "error_message": ERROR_MESSAGES["INPUT_INVALID"]}

    clean_expected_sha = expected_sha256.strip().lower()
    if not SHA256_RE.match(clean_expected_sha):
        return {"ok": False, "error_code": "INPUT_INVALID", "error_message": ERROR_MESSAGES["INPUT_INVALID"]}

    if not archive_path or not isinstance(archive_path, (str, os.PathLike)):
        return {"ok": False, "error_code": "INPUT_INVALID", "error_message": ERROR_MESSAGES["INPUT_INVALID"]}

    # Compute effective limits (can only be lowered, never raised above defaults)
    invalid = {"ok":False,"error_code":"INPUT_INVALID","error_message":ERROR_MESSAGES["INPUT_INVALID"]}
    hard = {"max_archive_bytes":DEFAULT_MAX_ARCHIVE_BYTES,"max_uncompressed_bytes":DEFAULT_MAX_UNCOMPRESSED_BYTES,"max_members":DEFAULT_MAX_MEMBERS,"max_member_bytes":DEFAULT_MAX_MEMBER_BYTES}
    if limits is None: limits = {}
    if type(limits) is not dict or any(key not in hard for key in limits): return invalid
    if any(type(value) is not int or value <= 0 for value in limits.values()): return invalid
    effective = {key:min(value,limits.get(key,value)) for key,value in hard.items()}
    max_archive_bytes=effective['max_archive_bytes'];max_uncompressed_bytes=effective['max_uncompressed_bytes']
    max_members=effective['max_members'];max_member_bytes=effective['max_member_bytes']

    # 2. Open file descriptor with O_NOFOLLOW to prevent symlink traversal
    open_flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
    if hasattr(os, "O_NOFOLLOW"):
        open_flags |= os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        open_flags |= os.O_CLOEXEC

    try:
        fd = os.open(archive_path, open_flags)
    except FileNotFoundError:
        return {"ok": False, "error_code": "INPUT_NOT_FOUND", "error_message": ERROR_MESSAGES["INPUT_NOT_FOUND"]}
    except OSError as e:
        # Symlink encountered with O_NOFOLLOW results in ELOOP / EEXIST / EINVAL on various platforms
        return {"ok": False, "error_code": "NON_REGULAR_INPUT", "error_message": ERROR_MESSAGES["NON_REGULAR_INPUT"]}

    try:
        # 3. fstat verification on the opened file descriptor
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return {"ok": False, "error_code": "NON_REGULAR_INPUT", "error_message": ERROR_MESSAGES["NON_REGULAR_INPUT"]}

        if st.st_size > max_archive_bytes:
            return {"ok": False, "error_code": "ARCHIVE_SIZE_EXCEEDED", "error_message": ERROR_MESSAGES["ARCHIVE_SIZE_EXCEEDED"]}

        # 4. Compute SHA256 in chunks using the same fd
        hasher = hashlib.sha256()
        total_archive_read = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            total_archive_read += len(chunk)
            if total_archive_read > max_archive_bytes:
                return {"ok": False, "error_code": "ARCHIVE_SIZE_EXCEEDED", "error_message": ERROR_MESSAGES["ARCHIVE_SIZE_EXCEEDED"]}
            hasher.update(chunk)

        computed_sha = hasher.hexdigest().lower()
        if computed_sha != clean_expected_sha:
            return {"ok": False, "error_code": "SHA256_MISMATCH", "error_message": ERROR_MESSAGES["SHA256_MISMATCH"]}

        # 5. Rewind fd to offset 0 for tar analysis
        os.lseek(fd, 0, os.SEEK_SET)

        # 6. Stream and inspect tar contents from the same fd
        raw_io = io.FileIO(fd, mode="r", closefd=False)

        # Detect gzip magic
        magic = raw_io.read(2)
        raw_io.seek(0)

        is_gzip = (magic == b"\x1f\x8b")
        if is_gzip:
            try:
                gz_stream = gzip.GzipFile(fileobj=raw_io, mode="rb")
            except Exception:
                return {"ok": False, "error_code": "ARCHIVE_CORRUPTED", "error_message": ERROR_MESSAGES["ARCHIVE_CORRUPTED"]}
            counting_stream = DecompressionCountingStream(gz_stream, max_uncompressed_bytes)
            stream_for_tar = io.BufferedReader(counting_stream)
        else:
            counting_stream = DecompressionCountingStream(raw_io, max_uncompressed_bytes)
            stream_for_tar = io.BufferedReader(counting_stream)

        try:
            tar = tarfile.open(fileobj=stream_for_tar, mode="r|")
        except _PreflightLimitError as e:
            return {"ok": False, "error_code": e.code, "error_message": ERROR_MESSAGES[e.code]}
        except Exception as e:
            curr = e
            while curr is not None:
                if isinstance(curr, _PreflightLimitError):
                    return {"ok": False, "error_code": curr.code, "error_message": ERROR_MESSAGES[curr.code]}
                curr = getattr(curr, "__cause__", None) or getattr(curr, "__context__", None)
            return {"ok": False, "error_code": "ARCHIVE_CORRUPTED", "error_message": ERROR_MESSAGES["ARCHIVE_CORRUPTED"]}

        member_count = 0
        file_count = 0
        dir_count = 0
        total_regular_bytes = 0

        seen_paths = set()
        files = set()
        directories = set()

        try:
            for tarinfo in tar:
                member_count += 1
                if member_count > max_members:
                    return {"ok": False, "error_code": "MEMBER_COUNT_EXCEEDED", "error_message": ERROR_MESSAGES["MEMBER_COUNT_EXCEEDED"]}

                # Check member type: strictly regular files and directories only
                if tarinfo.isreg():
                    is_dir = False
                elif tarinfo.isdir():
                    is_dir = True
                else:
                    return {"ok": False, "error_code": "DISALLOWED_MEMBER_TYPE", "error_message": ERROR_MESSAGES["DISALLOWED_MEMBER_TYPE"]}

                # Check permissions: no setuid, setgid, or world-writable
                mode = tarinfo.mode
                if (mode & 0o4000) or (mode & 0o2000) or (mode & 0o0002):
                    return {"ok": False, "error_code": "INSECURE_MEMBER_PERMISSIONS", "error_message": ERROR_MESSAGES["INSECURE_MEMBER_PERMISSIONS"]}

                # Path hygiene
                valid, norm_path = _validate_member_path(tarinfo.name)
                if not valid:
                    return {"ok": False, "error_code": norm_path, "error_message": ERROR_MESSAGES.get(norm_path, ERROR_MESSAGES["PATH_TRAVERSAL_OR_INVALID"])}

                # Skip pure root directory "./" or "." if already counted
                if norm_path == "" or norm_path == ".":
                    if not is_dir:
                        return {"ok":False,"error_code":"PATH_TRAVERSAL_OR_INVALID","error_message":ERROR_MESSAGES["PATH_TRAVERSAL_OR_INVALID"]}
                    if "." in seen_paths:
                        return {"ok":False,"error_code":"PATH_DUPLICATE","error_message":ERROR_MESSAGES["PATH_DUPLICATE"]}
                    seen_paths.add(".");dir_count += 1
                    continue

                if norm_path in seen_paths:
                    return {"ok": False, "error_code": "PATH_DUPLICATE", "error_message": ERROR_MESSAGES["PATH_DUPLICATE"]}
                seen_paths.add(norm_path)

                # Check file size limits
                if is_dir:
                    dir_count += 1
                    if norm_path in files:
                        return {"ok": False, "error_code": "PATH_CONFLICT", "error_message": ERROR_MESSAGES["PATH_CONFLICT"]}

                    # Check parent path conflict: parent cannot be an existing regular file
                    parent = norm_path
                    while True:
                        parent = posixpath.dirname(parent)
                        if not parent or parent == ".":
                            break
                        directories.add(parent)
                        if parent in files:
                            return {"ok": False, "error_code": "PATH_CONFLICT", "error_message": ERROR_MESSAGES["PATH_CONFLICT"]}

                    directories.add(norm_path)
                else:
                    file_count += 1
                    if tarinfo.size > max_member_bytes:
                        return {"ok": False, "error_code": "MEMBER_SIZE_EXCEEDED", "error_message": ERROR_MESSAGES["MEMBER_SIZE_EXCEEDED"]}

                    total_regular_bytes += tarinfo.size
                    if total_regular_bytes > max_uncompressed_bytes:
                        return {"ok": False, "error_code": "TOTAL_UNCOMPRESSED_EXCEEDED", "error_message": ERROR_MESSAGES["TOTAL_UNCOMPRESSED_EXCEEDED"]}

                    if norm_path in directories:
                        return {"ok": False, "error_code": "PATH_CONFLICT", "error_message": ERROR_MESSAGES["PATH_CONFLICT"]}

                    # Check parent path conflict: parent cannot be an existing regular file
                    parent = norm_path
                    while True:
                        parent = posixpath.dirname(parent)
                        if not parent or parent == ".":
                            break
                        directories.add(parent)
                        if parent in files:
                            return {"ok": False, "error_code": "PATH_CONFLICT", "error_message": ERROR_MESSAGES["PATH_CONFLICT"]}

                    files.add(norm_path)

            # tar stops at its EOF marker; consume gzip to EOF as well, so
            # CRC/trailer errors and trailing expansion cannot evade limits.
            while stream_for_tar.read(65536):
                pass
            if counting_stream.total_read % 512 or len(counting_stream.tail) < 1024 or counting_stream.tail != bytes(1024):
                return {"ok":False,"error_code":"ARCHIVE_CORRUPTED","error_message":ERROR_MESSAGES["ARCHIVE_CORRUPTED"]}

        except _PreflightLimitError as e:
            return {"ok": False, "error_code": e.code, "error_message": ERROR_MESSAGES[e.code]}
        except (tarfile.TarError, gzip.BadGzipFile, zlib.error, EOFError, OSError) as e:
            curr = e
            while curr is not None:
                if isinstance(curr, _PreflightLimitError):
                    return {"ok": False, "error_code": curr.code, "error_message": ERROR_MESSAGES[curr.code]}
                curr = getattr(curr, "__cause__", None) or getattr(curr, "__context__", None)
            return {"ok": False, "error_code": "ARCHIVE_CORRUPTED", "error_message": ERROR_MESSAGES["ARCHIVE_CORRUPTED"]}

        return {
            "ok": True,
            "sha256": computed_sha,
            "members": member_count,
            "files": file_count,
            "directories": dir_count,
            "totalRegularBytes": total_regular_bytes,
        }

    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description="Northstar Release Archive Preflight Inspector")
    parser.add_argument("--archive", required=True, help="Path to archive file (.tar.gz / .tar)")
    parser.add_argument("--sha256", required=True, help="Expected SHA256 hex string")
    parser.add_argument("--max-archive-bytes", type=int, default=None)
    parser.add_argument("--max-uncompressed-bytes", type=int, default=None)
    parser.add_argument("--max-members", type=int, default=None)
    parser.add_argument("--max-member-bytes", type=int, default=None)

    args = parser.parse_args()

    limits = {}
    if args.max_archive_bytes is not None:
        limits["max_archive_bytes"] = args.max_archive_bytes
    if args.max_uncompressed_bytes is not None:
        limits["max_uncompressed_bytes"] = args.max_uncompressed_bytes
    if args.max_members is not None:
        limits["max_members"] = args.max_members
    if args.max_member_bytes is not None:
        limits["max_member_bytes"] = args.max_member_bytes

    res = inspect_archive(args.archive, args.sha256, limits=limits or None)
    sys.stdout.write(json.dumps(res, ensure_ascii=False) + "\n")
    sys.exit(0 if res.get("ok") else 1)


if __name__ == "__main__":
    main()
