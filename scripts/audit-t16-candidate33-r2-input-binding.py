#!/usr/bin/env python3
"""Read-only audit of T16 inputs bound into the frozen candidate-33 r2 draft."""
from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "release-artifacts/northstar-controlled-trial-20261022-candidate-32.tar.gz"
CANDIDATE = ROOT / "release-artifacts/northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz"
BASE_SHA256 = "c10fccd5fda1a8a5f3b0a8fd2bb16b4517c96a941c988eca0e7dc3704972e7d3"
CANDIDATE_SHA256 = "bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77"

# These are the release inputs whose exact bytes must be part of the candidate.
# .npmrc is inherited unchanged from candidate-32 in r2, but is still an explicit
# input because the closure manifest binds it and npm ci consumes it.
INPUTS = {
    "shell/server.cjs": ("shell/server.cjs", "64ad1cdc9cc1f7fed1f90ef918f39e8c260eee294d15730715ac766fe9eafe54"),
    "shell/package.json": ("shell/package.json", "db0ff4eef9176f5de58ea1c4bf406baf6cdcde367128f82f072e8d053f7ed518"),
    "shell/package-lock.json": ("shell/package-lock.json", "795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912"),
    "shell/.npmrc": ("shell/.npmrc", "a093bb2fed59d699b7f9a62a5203cc196054c624e9c39c6d908c9e7db5dd2464"),
    "shell/northstar-dependency-closure.cjs": ("scripts/northstar-dependency-closure.cjs", "e51c4c1b6f6ca45c3f0ee9123249d0fb0a8e541da7cbe2c160c2b2a39e23309b"),
    "shell/dependency-closure-manifest.json": ("docs/refactor/evidence/T16-dependency-closure-linux-amd64-node22.23.4.json", "bec48d7e0eafc6662933f7f1954317c3f68d0c1df7e7d3ad4069d225e5653dbe"),
}

EXPECTED_CHANGED = {
    "shell/server.cjs",
    "shell/model-catalog.cjs",
    "shell/public/app.js",
    "shell/package.json",
    "shell/package-lock.json",
    "shell/northstar-dependency-closure.cjs",
    "shell/dependency-closure-manifest.json",
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def archive_contents(path: pathlib.Path) -> tuple[dict[str, bytes], set[str]]:
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)):
            raise ValueError(f"duplicate member path in {path.name}")
        files: dict[str, bytes] = {}
        for member in members:
            if member.pax_headers or not (member.isdir() or member.isfile()):
                raise ValueError(f"non-USTAR or unsupported member: {member.name}")
            if member.name.startswith("/") or "\\" in member.name or ".." in pathlib.PurePosixPath(member.name).parts:
                raise ValueError(f"unsafe member path: {member.name}")
            if member.isfile():
                stream = archive.extractfile(member)
                if stream is None:
                    raise ValueError(f"cannot read member: {member.name}")
                files[member.name] = stream.read()
        return files, set(names)


def main() -> int:
    for path, expected in ((BASE, BASE_SHA256), (CANDIDATE, CANDIDATE_SHA256)):
        actual = digest(path.read_bytes())
        if actual != expected:
            raise ValueError(f"frozen artifact hash mismatch: {path.name} sha256={actual}")

    base_files, base_names = archive_contents(BASE)
    candidate_files, candidate_names = archive_contents(CANDIDATE)
    additions = {"shell/northstar-dependency-closure.cjs", "shell/dependency-closure-manifest.json"}
    if candidate_names != base_names | additions or set(candidate_files) != set(base_files) | additions:
        raise ValueError("candidate member set is not exactly frozen base plus two declared T16 additions")

    for archive_path, (source_path, expected_sha) in INPUTS.items():
        source = (ROOT / source_path).read_bytes()
        bundled = candidate_files.get(archive_path)
        if bundled is None:
            raise ValueError(f"required T16 input missing from candidate: {archive_path}")
        if digest(source) != expected_sha or digest(bundled) != expected_sha or source != bundled:
            raise ValueError(f"T16 input differs across pin/source/candidate: {archive_path}")

    changed = {
        name for name, data in candidate_files.items()
        if name not in base_files or data != base_files[name]
    }
    if changed != EXPECTED_CHANGED:
        raise ValueError(f"candidate delta is not the declared overlay set: {sorted(changed)}")

    manifest = json.loads(candidate_files["shell/dependency-closure-manifest.json"])
    evidence = manifest.get("evidence", {})
    expected_evidence = {
        "packageJsonSha256": INPUTS["shell/package.json"][1],
        "packageLockSha256": INPUTS["shell/package-lock.json"][1],
        "npmrcSha256": INPUTS["shell/.npmrc"][1],
    }
    if any(evidence.get(key) != value for key, value in expected_evidence.items()):
        raise ValueError("closure manifest does not bind package.json, package-lock.json, and .npmrc")
    if manifest.get("target", {}).get("platform") != "linux" or manifest.get("target", {}).get("arch") != "x64":
        raise ValueError("closure manifest target is not Linux/amd64")
    if (manifest.get("packageCount"), manifest.get("fileCount")) != (472, 30091):
        raise ValueError("closure manifest package/file counts differ from the reviewed T16 evidence")

    print("T16_INPUT_BINDING=PASS")
    print("REQUIRED_INPUTS=6 exact source/candidate SHA-256 matches")
    print("MANIFEST_BINDING=PASS package.json + package-lock.json + .npmrc")
    print("CANDIDATE_DELTA=PASS frozen candidate-32 plus 5 declared overlays and 2 T16 additions")
    print("TARGET=PASS linux/amd64; packages=472; files=30091")
    print("SCOPE=archive-only comparison; no full-worktree packaging")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError, tarfile.TarError) as error:
        print(f"T16_INPUT_BINDING=FAIL {error}", file=sys.stderr)
        raise SystemExit(1)
