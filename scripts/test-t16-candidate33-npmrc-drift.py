#!/usr/bin/env python3
"""Repeatable, read-only negative probes for candidate-33 T16 .npmrc binding."""
import gzip
import hashlib
import importlib.util
import json
import pathlib
import sys
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUILDER_PATH = ROOT / "scripts/package-northstar-candidate33.py"
spec = importlib.util.spec_from_file_location("candidate33_base_npmrc_negative", BUILDER_PATH)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

original_read_bytes = pathlib.Path.read_bytes


def sha(data):
    return hashlib.sha256(data).hexdigest()


def reject_case(label, expected_message):
    try:
        builder.build()
    except SystemExit as error:
        if expected_message not in str(error):
            raise AssertionError(f"{label}: wrong rejection: {error}") from error
        print(f"{label}=PASS")
    else:
        raise AssertionError(f"{label}: builder accepted drift")


def no_release_writes(*_args, **_kwargs):
    raise AssertionError("negative probe attempted to write a file")


def probe_workspace_source():
    def read_bytes(path):
        if path == builder.ROOT / "shell/.npmrc":
            return b"legacy-peer-deps=truE\n"
        return original_read_bytes(path)

    with patch.object(pathlib.Path, "read_bytes", read_bytes), patch.object(pathlib.Path, "write_bytes", no_release_writes):
        reject_case("WORKSPACE_NPMRC_DRIFT", "T16 .npmrc input differs from its reviewed checksum")


def probe_manifest_field():
    manifest = json.loads(original_read_bytes(builder.MANIFEST))
    manifest["evidence"]["npmrcSha256"] = "0" * 64
    replacement = (json.dumps(manifest, indent=2) + "\n").encode()

    def read_bytes(path):
        if path == builder.MANIFEST:
            return replacement
        return original_read_bytes(path)

    # Adjust only the manifest file pin so this probe reaches the semantic field check.
    with patch.object(pathlib.Path, "read_bytes", read_bytes), \
         patch.object(builder, "MANIFEST_SHA", sha(replacement)), \
         patch.object(pathlib.Path, "write_bytes", no_release_writes):
        reject_case("MANIFEST_NPMRC_FIELD_DRIFT", "T16 manifest is not bound to package.json, package-lock.json, and .npmrc")


def probe_frozen_base_member():
    raw = gzip.decompress(original_read_bytes(builder.SOURCE))
    old = b"legacy-peer-deps=true\n"
    replacement = b"legacy-peer-deps=truE\n"
    if raw.count(old) != 1:
        raise AssertionError("expected exactly one .npmrc payload in frozen candidate-32 tar stream")
    changed_archive = gzip.compress(raw.replace(old, replacement, 1), mtime=0)

    def read_bytes(path):
        if path == builder.SOURCE:
            return changed_archive
        return original_read_bytes(path)

    # Adjust the archive pin only to isolate the explicit member comparison.
    with patch.object(pathlib.Path, "read_bytes", read_bytes), \
         patch.object(builder, "SOURCE_SHA", sha(changed_archive)), \
         patch.object(pathlib.Path, "write_bytes", no_release_writes):
        reject_case("FROZEN_BASE_NPMRC_DRIFT", "frozen candidate-32 shell/.npmrc differs from the reviewed workspace input")


def probe_generated_member():
    read_member = builder.archive_member_bytes
    calls = 0

    def read_with_output_drift(archive_bytes, member_name):
        nonlocal calls
        calls += 1
        result = read_member(archive_bytes, member_name)
        if calls == 2 and member_name == "shell/.npmrc":
            return result + b"# injected drift\n"
        return result

    with patch.object(builder, "archive_member_bytes", read_with_output_drift), \
         patch.object(pathlib.Path, "write_bytes", no_release_writes):
        reject_case("GENERATED_ARCHIVE_NPMRC_DRIFT", "generated candidate shell/.npmrc differs from the reviewed T16 input")


def main():
    probe_workspace_source()
    probe_manifest_field()
    probe_frozen_base_member()
    probe_generated_member()
    print("T16_NPMRC_NEGATIVE_REGRESSION=PASS 4/4; in-memory fixtures; writes prohibited")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"T16_NPMRC_NEGATIVE_REGRESSION=FAIL {error}", file=sys.stderr)
        raise SystemExit(1)
