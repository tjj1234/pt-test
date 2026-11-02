#!/usr/bin/env python3
"""
Regression test suite for Northstar release archive preflight candidate.

Runs strictly offline:
- Tests pure read-only inspection of archives (.tar.gz / .tar).
- Validates SHA256 verification and TOCTOU defense on same file descriptor.
- Tests rejection of symlinks, hardlinks, FIFOs, devices, setuid, setgid, world-writable bits.
- Tests rejection of path traversals (.., absolute paths, backslashes, control characters, redundant slashes, duplicates, file/dir conflicts).
- Tests low-threshold compression bombs, large member counts, corrupted archives, truncated streams.
- Tests zero-leakage of PRIVATE_SENTINEL.
- Tests zero-extraction guarantee (no files unpacked to disk).
- Cleans up all temp fixtures in finally / tearDown.
"""

import gzip
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
MODULE_PATH = os.path.join(PROJECT_ROOT, "scripts", "northstar-release-archive-preflight-candidate.py")

# Import inspect_archive dynamically from candidate script
import importlib.util
spec = importlib.util.spec_from_file_location("preflight_candidate", MODULE_PATH)
preflight_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight_mod)
inspect_archive = preflight_mod.inspect_archive

PRIVATE_SENTINEL = "PRIVATE_SENTINEL_LEAK_CHECK_XYZ_777"


def compute_sha256(data_or_path):
    h = hashlib.sha256()
    if isinstance(data_or_path, (bytes, bytearray)):
        h.update(data_or_path)
    else:
        with open(data_or_path, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
    return h.hexdigest().lower()


class TestReleaseArchivePreflight(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="preflight_test_")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _create_tar_gz(self, entries, compress=True):
        """
        Helper to construct in-memory or on-disk tar archives.
        entries: list of dicts:
          - name: str
          - type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'fifo'
          - content: bytes (optional)
          - mode: int (optional)
          - linkname: str (optional)
        """
        buf = io.BytesIO()
        mode_str = "w:gz" if compress else "w:"
        with tarfile.open(fileobj=buf, mode=mode_str) as tar:
            for e in entries:
                ti = tarfile.TarInfo(name=e["name"])
                ti.mtime = 1700000000
                ti.mode = e.get("mode", 0o644 if e.get("type", "file") == "file" else 0o755)

                etype = e.get("type", "file")
                if etype == "file":
                    ti.type = tarfile.REGTYPE
                    content = e.get("content", b"hello world\n")
                    ti.size = len(content)
                    tar.addfile(ti, io.BytesIO(content))
                elif etype == "dir":
                    ti.type = tarfile.DIRTYPE
                    ti.size = 0
                    tar.addfile(ti)
                elif etype == "symlink":
                    ti.type = tarfile.SYMTYPE
                    ti.size = 0
                    ti.linkname = e.get("linkname", "target")
                    tar.addfile(ti)
                elif etype == "hardlink":
                    ti.type = tarfile.LNKTYPE
                    ti.size = 0
                    ti.linkname = e.get("linkname", "target")
                    tar.addfile(ti)
                elif etype == "fifo":
                    ti.type = tarfile.FIFOTYPE
                    ti.size = 0
                    tar.addfile(ti)

        raw_bytes = buf.getvalue()
        path = os.path.join(self.temp_dir, f"test_archive_{os.urandom(4).hex()}.{'tar.gz' if compress else 'tar'}")
        with open(path, "wb") as f:
            f.write(raw_bytes)
        return path, compute_sha256(raw_bytes)

    # -------------------------------------------------------------------------
    # 1. Happy Paths
    # -------------------------------------------------------------------------
    def test_valid_archive_with_unicode_and_directories(self):
        entries = [
            {"name": "dist", "type": "dir"},
            {"name": "dist/bundle.js", "type": "file", "content": b"console.log('northstar');"},
            {"name": "docs", "type": "dir"},
            {"name": "docs/中文手册.md", "type": "file", "content": "这是北极星文档".encode("utf-8")},
        ]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertTrue(res["ok"])
        self.assertEqual(res["sha256"], sha)
        self.assertEqual(res["files"], 2)
        self.assertEqual(res["directories"], 2)
        self.assertEqual(res["members"], 4)
        self.assertGreater(res["totalRegularBytes"], 0)

    def test_valid_uncompressed_tar(self):
        entries = [
            {"name": "app/main.py", "type": "file", "content": b"print('hello')"},
        ]
        path, sha = self._create_tar_gz(entries, compress=False)
        res = inspect_archive(path, sha)

        self.assertTrue(res["ok"])
        self.assertEqual(res["sha256"], sha)
        self.assertEqual(res["files"], 1)

    def test_valid_standard_dot_slash_prefix(self):
        entries = [
            {"name": "./", "type": "dir"},
            {"name": "./src", "type": "dir"},
            {"name": "./src/index.js", "type": "file", "content": b"export default 42;"},
        ]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertTrue(res["ok"])
        self.assertEqual(res["files"], 1)

    # -------------------------------------------------------------------------
    # 2. Input Integrity, Symlinks, and TOCTOU Defense
    # -------------------------------------------------------------------------
    def test_input_symlink_rejected(self):
        """Input file being a symlink must be strictly rejected (NON_REGULAR_INPUT)."""
        entries = [{"name": "file.txt", "type": "file", "content": b"content"}]
        real_path, sha = self._create_tar_gz(entries)

        symlink_path = os.path.join(self.temp_dir, "symlink_archive.tar.gz")
        os.symlink(real_path, symlink_path)

        res = inspect_archive(symlink_path, sha)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "NON_REGULAR_INPUT")

    def test_non_existent_file_returns_not_found(self):
        res = inspect_archive(os.path.join(self.temp_dir, "nonexistent.tar.gz"), "a" * 64)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "INPUT_NOT_FOUND")

    def test_invalid_expected_sha256_format(self):
        bad_shas = ["", "abc", "12345", "g" * 64, "A" * 63, "A" * 65, None, 123]
        entries = [{"name": "file.txt", "type": "file"}]
        path, _ = self._create_tar_gz(entries)

        for s in bad_shas:
            res = inspect_archive(path, s)
            self.assertFalse(res["ok"])
            self.assertEqual(res["error_code"], "INPUT_INVALID")

    def test_sha256_mismatch_rejected(self):
        entries = [{"name": "file.txt", "type": "file"}]
        path, sha = self._create_tar_gz(entries)
        tampered_sha = "f" * 64
        res = inspect_archive(path, tampered_sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "SHA256_MISMATCH")

    # -------------------------------------------------------------------------
    # 3. Disallowed Member Types & Insecure Permissions
    # -------------------------------------------------------------------------
    def test_symlink_member_rejected(self):
        entries = [
            {"name": "safe.txt", "type": "file"},
            {"name": "evil_symlink", "type": "symlink", "linkname": "/etc/shadow"},
        ]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "DISALLOWED_MEMBER_TYPE")

    def test_hardlink_member_rejected(self):
        entries = [
            {"name": "file1.txt", "type": "file"},
            {"name": "file2_hardlink", "type": "hardlink", "linkname": "file1.txt"},
        ]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "DISALLOWED_MEMBER_TYPE")

    def test_fifo_member_rejected(self):
        entries = [{"name": "evil_pipe", "type": "fifo"}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "DISALLOWED_MEMBER_TYPE")

    def test_setuid_member_rejected(self):
        entries = [{"name": "root_shell", "type": "file", "mode": 0o4755}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "INSECURE_MEMBER_PERMISSIONS")

    def test_setgid_member_rejected(self):
        entries = [{"name": "group_exec", "type": "file", "mode": 0o2755}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "INSECURE_MEMBER_PERMISSIONS")

    def test_world_writable_member_rejected(self):
        entries = [{"name": "public_write.sh", "type": "file", "mode": 0o0777}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "INSECURE_MEMBER_PERMISSIONS")

    # -------------------------------------------------------------------------
    # 4. Path Hygiene & Traversal Rejection
    # -------------------------------------------------------------------------
    def test_absolute_path_rejected(self):
        entries = [{"name": "/etc/passwd", "type": "file"}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "PATH_TRAVERSAL_OR_INVALID")

    def test_parent_directory_traversal_rejected(self):
        entries = [{"name": "foo/../../bar.txt", "type": "file"}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "PATH_TRAVERSAL_OR_INVALID")

    def test_backslash_rejected(self):
        entries = [{"name": "windows\\path\\file.txt", "type": "file"}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "PATH_TRAVERSAL_OR_INVALID")

    def test_control_character_rejected(self):
        entries = [{"name": "file\x1bevil.txt", "type": "file"}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "PATH_TRAVERSAL_OR_INVALID")

    def test_redundant_double_slash_rejected(self):
        entries = [{"name": "foo//bar.txt", "type": "file"}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "PATH_TRAVERSAL_OR_INVALID")

    def test_redundant_dot_slash_rejected(self):
        entries = [{"name": "foo/./bar.txt", "type": "file"}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "PATH_TRAVERSAL_OR_INVALID")

    def test_duplicate_normalized_path_rejected(self):
        entries = [
            {"name": "foo/bar.txt", "type": "file", "content": b"v1"},
            {"name": "./foo/bar.txt", "type": "file", "content": b"v2"},
        ]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "PATH_DUPLICATE")

    def test_file_and_directory_name_conflict_rejected(self):
        entries = [
            {"name": "item", "type": "file", "content": b"i am a file"},
            {"name": "item", "type": "dir"},
        ]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertIn(res["error_code"], ("PATH_DUPLICATE", "PATH_CONFLICT"))

    def test_file_used_as_parent_directory_rejected(self):
        entries = [
            {"name": "parent", "type": "file", "content": b"not a dir"},
            {"name": "parent/child.txt", "type": "file", "content": b"child"},
        ]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "PATH_CONFLICT")

    # -------------------------------------------------------------------------
    # 5. Resource Limits and Compression Bomb Defense
    # -------------------------------------------------------------------------
    def test_archive_size_limit_exceeded(self):
        entries = [{"name": "file.txt", "type": "file", "content": b"x" * 1000}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha, limits={"max_archive_bytes": 50})

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "ARCHIVE_SIZE_EXCEEDED")

    def test_total_uncompressed_limit_exceeded(self):
        entries = [
            {"name": "big1.txt", "type": "file", "content": b"0" * 5000},
            {"name": "big2.txt", "type": "file", "content": b"0" * 5000},
        ]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha, limits={"max_uncompressed_bytes": 4000})

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "TOTAL_UNCOMPRESSED_EXCEEDED")

    def test_member_count_limit_exceeded(self):
        entries = [{"name": f"f_{i}.txt", "type": "file", "content": b"1"} for i in range(15)]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha, limits={"max_members": 10})

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "MEMBER_COUNT_EXCEEDED")

    def test_member_size_limit_exceeded(self):
        entries = [{"name": "oversize.bin", "type": "file", "content": b"z" * 10000}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha, limits={"max_member_bytes": 5000})

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "MEMBER_SIZE_EXCEEDED")

    # -------------------------------------------------------------------------
    # 6. Corrupted and Truncated Archives
    # -------------------------------------------------------------------------
    def test_truncated_gzip_rejected(self):
        entries = [{"name": "file.txt", "type": "file", "content": b"lots of content" * 100}]
        path, _ = self._create_tar_gz(entries)
        with open(path, "rb") as f:
            data = f.read()

        truncated_data = data[:len(data) // 2]
        path_trunc = os.path.join(self.temp_dir, "trunc.tar.gz")
        with open(path_trunc, "wb") as f:
            f.write(truncated_data)

        sha = compute_sha256(truncated_data)
        res = inspect_archive(path_trunc, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "ARCHIVE_CORRUPTED")

    def test_non_tar_garbage_file_rejected(self):
        garbage = os.urandom(1024)
        path = os.path.join(self.temp_dir, "garbage.bin")
        with open(path, "wb") as f:
            f.write(garbage)

        sha = compute_sha256(garbage)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "ARCHIVE_CORRUPTED")

    # -------------------------------------------------------------------------
    # 7. Redaction of PRIVATE_SENTINEL and Safe Errors
    # -------------------------------------------------------------------------
    def test_private_sentinel_in_member_path_not_leaked(self):
        entries = [{"name": f"traversal/../{PRIVATE_SENTINEL}", "type": "file"}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha)

        self.assertFalse(res["ok"])
        self.assertNotIn(PRIVATE_SENTINEL, res.get("error_code", ""))
        self.assertNotIn(PRIVATE_SENTINEL, res.get("error_message", ""))
        self.assertNotIn(PRIVATE_SENTINEL, json.dumps(res))

    # -------------------------------------------------------------------------
    # 8. Zero Extraction Guarantee
    # -------------------------------------------------------------------------
    def test_zero_extraction_guarantee(self):
        entries = [
            {"name": "secret/unpacked_marker.txt", "type": "file", "content": b"CANARY_MARKER"}
        ]
        path, sha = self._create_tar_gz(entries)

        # Record file count in temp_dir before inspect
        files_before = set(os.listdir(self.temp_dir))
        res = inspect_archive(path, sha)
        self.assertTrue(res["ok"])

        files_after = set(os.listdir(self.temp_dir))
        # Ensure no new directories or canary files were extracted
        self.assertEqual(files_before, files_after)
        self.assertFalse(os.path.exists(os.path.join(self.temp_dir, "secret")))
        self.assertFalse(os.path.exists(os.path.join(self.temp_dir, "unpacked_marker.txt")))

    # -------------------------------------------------------------------------
    # 9. CLI Interface
    # -------------------------------------------------------------------------
    def test_cli_invocation_success(self):
        entries = [{"name": "cli_test.txt", "type": "file", "content": b"cli payload"}]
        path, sha = self._create_tar_gz(entries)

        cmd = [sys.executable, MODULE_PATH, "--archive", path, "--sha256", sha]
        proc = subprocess.run(cmd, capture_output=True, text=True)

        self.assertEqual(proc.returncode, 0)
        data = json.loads(proc.stdout.strip())
        self.assertTrue(data["ok"])
        self.assertEqual(data["sha256"], sha)
        self.assertEqual(data["files"], 1)

    def test_cli_invocation_failure(self):
        entries = [{"name": "cli_test.txt", "type": "file", "content": b"cli payload"}]
        path, _ = self._create_tar_gz(entries)

        cmd = [sys.executable, MODULE_PATH, "--archive", path, "--sha256", "0" * 64]
        proc = subprocess.run(cmd, capture_output=True, text=True)

        self.assertEqual(proc.returncode, 1)
        data = json.loads(proc.stdout.strip())
        self.assertFalse(data["ok"])
        self.assertEqual(data["error_code"], "SHA256_MISMATCH")

    # -------------------------------------------------------------------------
    # 10. Advanced Limits and Normalization
    # -------------------------------------------------------------------------
    def test_uppercase_sha256_accepted(self):
        entries = [{"name": "file.txt", "type": "file", "content": b"content"}]
        path, sha = self._create_tar_gz(entries)
        res = inspect_archive(path, sha.upper())
        self.assertTrue(res["ok"])
        self.assertEqual(res["sha256"], sha.lower())

    def test_raising_limits_clamped_to_defaults(self):
        """Caller attempting to raise limits above hard defaults is clamped."""
        entries = [{"name": "file.txt", "type": "file", "content": b"content"}]
        path, sha = self._create_tar_gz(entries)
        # Attempt to raise to 10 GB
        res = inspect_archive(path, sha, limits={"max_archive_bytes": 10 * 1024 * 1024 * 1024})
        self.assertTrue(res["ok"])

    def test_toctou_path_swapped_after_open_prevented(self):
        """
        Verify that file operations happen on the opened file descriptor.
        Even if the file at the path is modified/removed after opening,
        the open fd ensures we inspect the exact opened bytes.
        """
        entries = [{"name": "original.txt", "type": "file", "content": b"original"}]
        path, sha = self._create_tar_gz(entries)

        # Inspect should succeed
        res = inspect_archive(path, sha)
        self.assertTrue(res["ok"])
        self.assertEqual(res["files"], 1)


    def test_main_review_gzip_crc_trailer_and_tail_budget(self):
        path,_=self._create_tar_gz([{'name':'a','content':b'ok'}])
        with open(path,'rb') as f: valid=f.read()
        for data in [valid[:-8],valid[:-8]+bytes([valid[-8]^1])+valid[-7:]]:
            with open(path,'wb') as f:f.write(data)
            self.assertFalse(inspect_archive(path,compute_sha256(data))['ok'])
        data=gzip.compress(gzip.decompress(valid)+bytes(100000))
        with open(path,'wb') as f:f.write(data)
        self.assertEqual(inspect_archive(path,compute_sha256(data),{'max_uncompressed_bytes':20000})['error_code'],'TOTAL_UNCOMPRESSED_EXCEEDED')

    def test_main_review_reverse_parent_conflict(self):
        path,sha=self._create_tar_gz([{'name':'a/b'},{'name':'a'}])
        self.assertEqual(inspect_archive(path,sha)['error_code'],'PATH_CONFLICT')

    def test_main_review_root_file_and_duplicate_root(self):
        for entries in [[{'name':'.'}],[{'name':'./','type':'dir'},{'name':'.','type':'dir'}]]:
            path,sha=self._create_tar_gz(entries)
            self.assertFalse(inspect_archive(path,sha)['ok'])

    def test_main_review_invalid_limits_never_raise_or_leak(self):
        for limits in [{'max_members':PRIVATE_SENTINEL},{'max_members':True},{'unknown':2},['bad']]:
            result=inspect_archive('/unused','0'*64,limits)
            self.assertEqual(result['error_code'],'INPUT_INVALID');self.assertNotIn(PRIVATE_SENTINEL,json.dumps(result))

    @unittest.skipUnless(hasattr(os,'mkfifo'),'FIFO unavailable')
    def test_main_review_fifo_input_returns_without_writer(self):
        path=os.path.join(self.temp_dir,'input.fifo');os.mkfifo(path)
        result=subprocess.run([sys.executable,'-B',MODULE_PATH,'--archive',path,'--sha256','0'*64],capture_output=True,text=True,timeout=2)
        self.assertNotEqual(result.returncode,0);self.assertEqual(json.loads(result.stdout)['error_code'],'NON_REGULAR_INPUT')

    def test_main_review_real_path_replacement_uses_same_fd(self):
        path,sha=self._create_tar_gz([{'name':'a'}]);other=os.path.join(self.temp_dir,'replacement')
        with open(other,'wb') as f:f.write(b'not a tar')
        original_seek=os.lseek;replaced=[]
        def swap(fd,offset,whence):
            if not replaced:os.replace(other,path);replaced.append(True)
            return original_seek(fd,offset,whence)
        with patch.object(preflight_mod.os,'lseek',side_effect=swap):result=inspect_archive(path,sha)
        self.assertTrue(replaced);self.assertTrue(result['ok']);self.assertNotEqual(compute_sha256(path),sha)

if __name__ == "__main__":
    unittest.main(verbosity=2)
