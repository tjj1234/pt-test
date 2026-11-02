#!/usr/bin/env python3
"""Read-only integrity and T16 input audit for the local candidate-33 r3 draft."""
from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "release-artifacts/northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz"
CANDIDATE = ROOT / "release-artifacts/northstar-controlled-trial-20261023-candidate-33-draft-r3.tar.gz"
UNIT = ROOT / "release-artifacts/northstar-shell-candidate-33-draft-r3.service"
PATCH = ROOT / "docs/refactor/evidence/candidate33-r3-failure-stage.patch"
BASE_SHA256 = "bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77"
CANDIDATE_SHA256 = "d6a065b678bd1321dadf75d37fc3e52290560537a1df526e7477bd7fb459bc77"
UNIT_SHA256 = "5bce0f4371af7fa25665a188c4ea1455d4e6ae6af00150c6608c1761417463c9"
PATCH_SHA256 = "8e2a1fa7e4483eef6b54fa19658657b7690e2ef39ce0770e00a978dc16687e8f"
INPUTS = {
    "shell/server.cjs": "ee7c595018873d48527bbeda411a3247bde36eeb25873319c9c1b8429a8549f6",
    "shell/model-catalog.cjs": "620f18c683b348aeecb6c9cc50ef74652f572b713bd3b75eb9422041bffa5a13",
    "shell/package.json": "db0ff4eef9176f5de58ea1c4bf406baf6cdcde367128f82f072e8d053f7ed518",
    "shell/package-lock.json": "795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912",
    "shell/.npmrc": "a093bb2fed59d699b7f9a62a5203cc196054c624e9c39c6d908c9e7db5dd2464",
    "shell/northstar-dependency-closure.cjs": "e51c4c1b6f6ca45c3f0ee9123249d0fb0a8e541da7cbe2c160c2b2a39e23309b",
    "shell/dependency-closure-manifest.json": "bec48d7e0eafc6662933f7f1954317c3f68d0c1df7e7d3ad4069d225e5653dbe",
}
EXPECTED_CHANGED = {"shell/server.cjs", "shell/model-catalog.cjs"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def archive(path: pathlib.Path) -> tuple[dict[str, bytes], set[str]]:
    files: dict[str, bytes] = {}
    names: set[str] = set()
    with tarfile.open(path, "r:gz") as tar:
        for item in tar.getmembers():
            if item.name in names:
                raise ValueError(f"duplicate member: {item.name}")
            names.add(item.name)
            if item.pax_headers or not (item.isdir() or item.isfile()):
                raise ValueError(f"non-USTAR/unsupported member: {item.name}")
            if item.name.startswith("/") or "\\" in item.name or ".." in pathlib.PurePosixPath(item.name).parts:
                raise ValueError(f"unsafe path: {item.name}")
            if item.isfile():
                stream = tar.extractfile(item)
                if stream is None:
                    raise ValueError(f"missing member bytes: {item.name}")
                files[item.name] = stream.read()
    return files, names


def main() -> None:
    if digest(BASE.read_bytes()) != BASE_SHA256:
        raise ValueError("candidate-33 r2 base is not the frozen input")
    candidate_bytes = CANDIDATE.read_bytes()
    if digest(candidate_bytes) != CANDIDATE_SHA256:
        raise ValueError("candidate-33 r3 archive checksum mismatch")
    if digest(UNIT.read_bytes()) != UNIT_SHA256:
        raise ValueError("candidate-33 r3 unit checksum mismatch")
    if digest(PATCH.read_bytes()) != PATCH_SHA256:
        raise ValueError("failure-stage patch checksum mismatch")
    base_files, base_names = archive(BASE)
    candidate_files, candidate_names = archive(CANDIDATE)
    if len(candidate_names) != 325 or candidate_names != base_names:
        raise ValueError("r3 archive member set/count differs from frozen r2")
    changed = {name for name in base_files if base_files[name] != candidate_files.get(name)}
    if changed != EXPECTED_CHANGED:
        raise ValueError(f"runtime overlay differs from exact two-file allowlist: {sorted(changed)}")
    for name, expected in INPUTS.items():
        data = candidate_files.get(name)
        if data is None or digest(data) != expected:
            raise ValueError(f"T16 candidate input mismatch: {name}")
    manifest = json.loads(candidate_files["shell/dependency-closure-manifest.json"])
    evidence = manifest.get("evidence", {})
    for field, member in (("packageJsonSha256", "shell/package.json"), ("packageLockSha256", "shell/package-lock.json"), ("npmrcSha256", "shell/.npmrc")):
        if evidence.get(field) != INPUTS[member]:
            raise ValueError(f"closure manifest does not bind {field}")
    target = manifest.get("target", {})
    if target.get("platform") != "linux" or target.get("arch") != "x64":
        raise ValueError("Node/npm linux/x64 target alias (Linux/amd64) changed")
    if (manifest.get("packageCount"), manifest.get("fileCount")) != (472, 30091):
        raise ValueError("dependency closure package/file count changed")
    unit = UNIT.read_text(encoding="utf-8")
    new_path = "/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r3"
    if unit.count(new_path) != 3 or "Candidate 33 r3" not in unit:
        raise ValueError("unit release path or revision description is inconsistent")
    forbidden = [name for name in candidate_files if name.endswith(".env") or "/node_modules/" in name or "/.git/" in name or "/secrets/" in name]
    apple = [name for name in candidate_names if name.startswith("__MACOSX/") or pathlib.PurePosixPath(name).name.startswith("._")]
    if forbidden or apple:
        raise ValueError(f"forbidden/Apple metadata paths found: {forbidden + apple}")
    print("FROZEN_R2_BASE=PASS")
    print("USTAR_MEMBER_SET=PASS count=325")
    print("RUNTIME_OVERLAY=PASS shell/server.cjs + shell/model-catalog.cjs; all other members unchanged")
    print("T16_INPUTS=PASS package + lock + npmrc + helper + manifest + updated server")
    print("TARGET=PASS linux/amd64 (Node process.arch=x64); Node>=22.19 remains inherited")
    print("CLOSURE_MANIFEST=PASS packages=472 files=30091; this is hash binding, not a fresh Linux install")
    print(f"UNIT=PASS sha256={UNIT_SHA256}")
    print("SCOPE=local draft integrity only; no deployment or paid request")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError, tarfile.TarError) as error:
        print(f"T16_CANDIDATE33_R3_AUDIT=FAIL {error}", file=sys.stderr)
        raise SystemExit(1)
