#!/usr/bin/env python3
"""Independent, read-only T16 release audit for candidate-33 r4."""
from __future__ import annotations

import hashlib
import base64
import json
import pathlib
import re
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
BASE = ARTIFACTS / "northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz"
CANDIDATE = ARTIFACTS / "northstar-controlled-trial-20261023-candidate-33-draft-r4.tar.gz"
BASE_UNIT = ARTIFACTS / "northstar-shell-candidate-33-draft-r2.service"
UNIT = ARTIFACTS / "northstar-shell-candidate-33-draft-r4.service"
MANIFEST_SOURCE = ROOT / "docs/refactor/evidence/T16-dependency-closure-linux-amd64-node22.23.4-portable-r4.json"

BASE_SHA256 = "bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77"
BASE_UNIT_SHA256 = "eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105"
R4_SHA256 = "665ad991cb38f3f00fecf1c463a83c02319e5fe2e29a8e9829ae2e3fd3a79f4c"
R4_UNIT_SHA256 = "ee7f9118190278ea0c7289eb70d94c754191a30f58152bf33e10841f1a8fe772"
HELPER_SHA256 = "9f5ffe4bf45c0174474ac3c4d1b86f5e7d1253af8d01c7fac6fb6f92b9889ad8"
MANIFEST_SHA256 = "88203b2c8606c790aa901366225fc1b029727e62b2e18d4f9c4a45ef878f2eaa"
VENDOR_SHA256 = "47ec05f45ada5ab87779ae18a90456b5ebff5421dc0ff5c179677d65e1c16057"
PACKAGE_SHA256 = "db0ff4eef9176f5de58ea1c4bf406baf6cdcde367128f82f072e8d053f7ed518"
LOCK_SHA256 = "795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912"
NPMRC_SHA256 = "a093bb2fed59d699b7f9a62a5203cc196054c624e9c39c6d908c9e7db5dd2464"
ALLOWLIST = {
    "shell/server.cjs",
    "shell/model-catalog.cjs",
    "shell/northstar-dependency-closure.cjs",
    "shell/dependency-closure-manifest.json",
}
LOCAL_DSH = "file:vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz"
OLD_RELEASE = "/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2"
NEW_RELEASE = "/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r4"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_archive(path: pathlib.Path) -> tuple[dict[str, bytes], set[str]]:
    files: dict[str, bytes] = {}
    names: set[str] = set()
    with tarfile.open(path, "r:gz") as archive:
        for item in archive.getmembers():
            if item.name in names:
                raise ValueError(f"duplicate archive member: {item.name}")
            names.add(item.name)
            if item.pax_headers or not (item.isdir() or item.isfile()):
                raise ValueError(f"non-USTAR/unsupported member: {item.name}")
            parts = pathlib.PurePosixPath(item.name).parts
            if item.name.startswith("/") or "\\" in item.name or ".." in parts:
                raise ValueError(f"unsafe archive path: {item.name}")
            if item.isfile():
                stream = archive.extractfile(item)
                if stream is None:
                    raise ValueError(f"missing member bytes: {item.name}")
                files[item.name] = stream.read()
    return files, names


def main() -> None:
    if sha(BASE.read_bytes()) != BASE_SHA256:
        raise ValueError("frozen candidate-33 r2 archive checksum mismatch")
    if sha(BASE_UNIT.read_bytes()) != BASE_UNIT_SHA256:
        raise ValueError("frozen candidate-33 r2 unit checksum mismatch")
    if sha(MANIFEST_SOURCE.read_bytes()) != MANIFEST_SHA256:
        raise ValueError("portable Linux manifest checksum mismatch")
    base, base_names = read_archive(BASE)
    candidate_bytes = CANDIDATE.read_bytes()
    if sha(candidate_bytes) != R4_SHA256:
        raise ValueError("candidate-33 r4 archive checksum mismatch")
    candidate, candidate_names = read_archive(CANDIDATE)
    if candidate_names != base_names or len(candidate_names) != 325:
        raise ValueError("r4 archive member set/count differs from frozen r2")
    changed = {name for name, content in base.items() if candidate.get(name) != content}
    if changed != ALLOWLIST:
        raise ValueError(f"r4 overlay differs from exact four-member allowlist: {sorted(changed)}")

    expected_hashes = {
        "shell/server.cjs": "ee7c595018873d48527bbeda411a3247bde36eeb25873319c9c1b8429a8549f6",
        "shell/model-catalog.cjs": "620f18c683b348aeecb6c9cc50ef74652f572b713bd3b75eb9422041bffa5a13",
        "shell/northstar-dependency-closure.cjs": HELPER_SHA256,
        "shell/dependency-closure-manifest.json": MANIFEST_SHA256,
    }
    for name, expected in expected_hashes.items():
        if name not in candidate or sha(candidate[name]) != expected:
            raise ValueError(f"r4 overlay member hash mismatch: {name}")

    for name, expected in (
        ("shell/package.json", PACKAGE_SHA256),
        ("shell/package-lock.json", LOCK_SHA256),
        ("shell/.npmrc", NPMRC_SHA256),
        ("shell/vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz", VENDOR_SHA256),
    ):
        if sha(candidate[name]) != expected or candidate[name] != base[name]:
            raise ValueError(f"frozen T16 input changed or differs from r2: {name}")

    package = json.loads(candidate["shell/package.json"])
    lock = json.loads(candidate["shell/package-lock.json"])
    manifest = json.loads(candidate["shell/dependency-closure-manifest.json"])
    evidence = manifest.get("evidence", {})
    if package.get("devDependencies", {}).get("@npmcli/arborist") != "8.0.5" or package.get("devDependencies", {}).get("semver") != "7.8.5":
        raise ValueError("package.json does not retain pinned Arborist/semver versions")
    if (evidence.get("packageJsonSha256"), evidence.get("packageLockSha256"), evidence.get("npmrcSha256")) != (PACKAGE_SHA256, LOCK_SHA256, NPMRC_SHA256):
        raise ValueError("portable manifest does not bind package.json, lockfile, and .npmrc")
    target = manifest.get("target", {})
    if target != {"platform": "linux", "arch": "x64", "gate": "enforced"}:
        raise ValueError("manifest target is not enforced Linux/amd64 (Node linux/x64)")
    node = evidence.get("node", "")
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", node)
    if not match or tuple(map(int, match.groups())) < (22, 19, 0):
        raise ValueError("manifest generation Node is below 22.19.0")
    if evidence.get("arborist") != "8.0.5" or (manifest.get("packageCount"), manifest.get("fileCount")) != (472, 30091):
        raise ValueError("manifest closure engine/count differs from reviewed baseline")
    if evidence.get("arboristIntegrity") != lock.get("packages", {}).get("node_modules/@npmcli/arborist", {}).get("integrity"):
        raise ValueError("manifest Arborist integrity does not match lockfile")

    locked_dsh = lock.get("packages", {}).get("node_modules/@deepseek-ai/dsh", {})
    packaged_dsh = next((row for row in manifest.get("packages", []) if row.get("name") == "@deepseek-ai/dsh"), None)
    if locked_dsh.get("version") != "0.1.1-rc.2" or locked_dsh.get("resolved") != LOCAL_DSH:
        raise ValueError("lockfile no longer pins the expected local DSH tarball")
    if not packaged_dsh or packaged_dsh.get("resolved") != LOCAL_DSH or packaged_dsh.get("integrity") != locked_dsh.get("integrity"):
        raise ValueError("manifest DSH record is not portable or differs from lock integrity")
    if "file:/" in candidate["shell/dependency-closure-manifest.json"].decode("utf-8"):
        raise ValueError("manifest contains an absolute local file source")
    if sha(candidate["shell/vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz"]) != VENDOR_SHA256:
        raise ValueError("vendored DSH tarball hash changed")
    vendor_sri = "sha512-" + base64.b64encode(hashlib.sha512(candidate["shell/vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz"]).digest()).decode("ascii")
    if locked_dsh.get("integrity") != vendor_sri:
        raise ValueError("vendored DSH tarball bytes do not match lockfile SRI")

    unit_bytes = UNIT.read_bytes()
    if sha(unit_bytes) != R4_UNIT_SHA256:
        raise ValueError("candidate-33 r4 systemd unit checksum mismatch")
    if unit_bytes.count(NEW_RELEASE.encode()) != 3 or OLD_RELEASE.encode() in unit_bytes or b"Candidate 33 r4" not in unit_bytes:
        raise ValueError("r4 systemd unit path/description mismatch")
    forbidden = [name for name in candidate if name.endswith(".env") or "/node_modules/" in name or "/.git/" in name or "/secrets/" in name]
    apple = [name for name in candidate_names if name.startswith("__MACOSX/") or pathlib.PurePosixPath(name).name.startswith("._")]
    if forbidden or apple:
        raise ValueError(f"forbidden/Apple metadata paths found: {forbidden + apple}")

    print("FROZEN_R2_BASE=PASS sha256=" + BASE_SHA256)
    print("USTAR_MEMBER_SET=PASS count=325")
    print("RUNTIME_OVERLAY=PASS exact four-member allowlist; 321 members byte-identical")
    print("T16_INPUTS=PASS package + lock + npmrc + vendor DSH tarball unchanged from frozen r2")
    print("PORTABLE_MANIFEST=PASS Linux/x64, Node>=22.19, Arborist=8.0.5, packages=472, files=30091")
    print("LOCAL_DSH_SOURCE=PASS relative locked source + integrity; no absolute file path")
    print("UNIT=PASS sha256=" + sha(unit_bytes))
    print("ARCHIVE=PASS sha256=" + sha(candidate_bytes))
    print("SCOPE=local artifact integrity audit only; no deployment or paid request")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError, tarfile.TarError) as error:
        print(f"T16_CANDIDATE33_R4_AUDIT=FAIL {error}", file=sys.stderr)
        raise SystemExit(1)
