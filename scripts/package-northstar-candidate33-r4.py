#!/usr/bin/env python3
"""Build/check a local-only candidate-33 r4 draft from frozen r2 inputs."""
from __future__ import annotations

import copy
import gzip
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
BASE = ARTIFACTS / "northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz"
BASE_UNIT = ARTIFACTS / "northstar-shell-candidate-33-draft-r2.service"
PATCH_FILE = ROOT / "docs/refactor/evidence/candidate33-r3-failure-stage.patch"
HELPER_FILE = ROOT / "scripts/northstar-dependency-closure.cjs"
MANIFEST_FILE = ROOT / "docs/refactor/evidence/T16-dependency-closure-linux-amd64-node22.23.4-portable-r4.json"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261023-candidate-33-draft-r4.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-33-draft-r4.service"
NOTE = ROOT / "docs/refactor/evidence/candidate33-model-catalog-diagnostics-draft-r4-20261023.md"

BASE_SHA256 = "bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77"
BASE_UNIT_SHA256 = "eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105"
PATCH_SHA256 = "8e2a1fa7e4483eef6b54fa19658657b7690e2ef39ce0770e00a978dc16687e8f"
HELPER_SHA256 = "9f5ffe4bf45c0174474ac3c4d1b86f5e7d1253af8d01c7fac6fb6f92b9889ad8"
MANIFEST_SHA256 = "88203b2c8606c790aa901366225fc1b029727e62b2e18d4f9c4a45ef878f2eaa"
TARGET_MEMBERS = {
    "shell/server.cjs",
    "shell/model-catalog.cjs",
    "shell/northstar-dependency-closure.cjs",
    "shell/dependency-closure-manifest.json",
}
PATCH_MEMBERS = {"shell/server.cjs", "shell/model-catalog.cjs"}
OLD_RELEASE = "/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2"
NEW_RELEASE = "/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r4"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify_frozen_inputs() -> None:
    expected = (
        (BASE, BASE_SHA256, "frozen candidate-33 r2 archive"),
        (BASE_UNIT, BASE_UNIT_SHA256, "frozen candidate-33 r2 unit"),
        (PATCH_FILE, PATCH_SHA256, "failure-stage patch"),
        (HELPER_FILE, HELPER_SHA256, "portable closure helper"),
        (MANIFEST_FILE, MANIFEST_SHA256, "portable closure manifest"),
    )
    for path, digest, label in expected:
        if sha(path.read_bytes()) != digest:
            raise ValueError(f"{label} checksum changed")


def read_archive() -> tuple[list[tarfile.TarInfo], dict[str, bytes]]:
    with tarfile.open(BASE, "r:gz") as archive:
        members = archive.getmembers()
        files: dict[str, bytes] = {}
        names: set[str] = set()
        for member in members:
            if member.name in names:
                raise ValueError(f"duplicate archive member: {member.name}")
            names.add(member.name)
            if member.pax_headers or not (member.isdir() or member.isfile()):
                raise ValueError(f"non-USTAR or unsupported member: {member.name}")
            if member.name.startswith("/") or "\\" in member.name or ".." in pathlib.PurePosixPath(member.name).parts:
                raise ValueError(f"unsafe archive path: {member.name}")
            if member.isfile():
                stream = archive.extractfile(member)
                if stream is None:
                    raise ValueError(f"cannot read archive member: {member.name}")
                files[member.name] = stream.read()
        if len(members) != 325 or not TARGET_MEMBERS.issubset(files):
            raise ValueError("candidate-33 r2 member count or required runtime members differ")
        return members, files


def apply_named_patch(files: dict[str, bytes]) -> dict[str, bytes]:
    with tempfile.TemporaryDirectory(prefix="northstar-c33-r4-patch-") as temp:
        work = pathlib.Path(temp)
        for name in PATCH_MEMBERS:
            path = work / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(files[name])
        result = subprocess.run(
            ["patch", "-p1", "-d", str(work), "--batch", "--forward"],
            input=PATCH_FILE.read_bytes(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        if result.returncode != 0:
            raise ValueError("failure-stage patch did not apply cleanly: " + result.stderr.decode("utf-8", "replace"))
        updated = dict(files)
        for name in PATCH_MEMBERS:
            updated[name] = (work / name).read_bytes()
        changed = {name for name in files if files[name] != updated[name]}
        if changed != PATCH_MEMBERS:
            raise ValueError(f"named source patch changed an unexpected archive member: {sorted(changed)}")
        expected = {
            "shell/server.cjs": "ee7c595018873d48527bbeda411a3247bde36eeb25873319c9c1b8429a8549f6",
            "shell/model-catalog.cjs": "620f18c683b348aeecb6c9cc50ef74652f572b713bd3b75eb9422041bffa5a13",
        }
        for name, digest in expected.items():
            if sha(updated[name]) != digest:
                raise ValueError(f"patched member checksum differs: {name}")
        return updated


def apply_portable_closure_inputs(files: dict[str, bytes]) -> dict[str, bytes]:
    helper = HELPER_FILE.read_bytes()
    manifest_bytes = MANIFEST_FILE.read_bytes()
    manifest = json.loads(manifest_bytes)
    package = json.loads(files["shell/package.json"])
    lock = json.loads(files["shell/package-lock.json"])
    if manifest.get("target") != {"platform": "linux", "arch": "x64", "gate": "enforced"}:
        raise ValueError("portable manifest target is not enforced Linux/amd64")
    evidence = manifest.get("evidence", {})
    node_version = evidence.get("node")
    node_match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", str(node_version))
    if not node_match or tuple(map(int, node_match.groups())) < (22, 19, 0):
        raise ValueError("portable manifest Node version is below the locked runtime minimum")
    arborist = lock.get("packages", {}).get("node_modules/@npmcli/arborist", {})
    semver = lock.get("packages", {}).get("node_modules/semver", {})
    if (package.get("devDependencies", {}).get("@npmcli/arborist") != "8.0.5" or
            package.get("devDependencies", {}).get("semver") != "7.8.5" or
            arborist.get("version") != "8.0.5" or not arborist.get("integrity") or
            semver.get("version") != "7.8.5" or not semver.get("integrity") or
            evidence.get("arboristIntegrity") != arborist.get("integrity")):
        raise ValueError("frozen package and lock do not pin/integrity-bind Arborist 8.0.5 and semver 7.8.5")
    if evidence.get("arborist") != "8.0.5" or (manifest.get("packageCount"), manifest.get("fileCount")) != (472, 30091):
        raise ValueError("portable closure manifest versions or counts differ from reviewed Linux baseline")
    for field, member in (
        ("packageJsonSha256", "shell/package.json"),
        ("packageLockSha256", "shell/package-lock.json"),
        ("npmrcSha256", "shell/.npmrc"),
    ):
        if evidence.get(field) != sha(files[member]):
            raise ValueError(f"portable manifest does not bind frozen {member}")
    updated = dict(files)
    updated["shell/northstar-dependency-closure.cjs"] = helper
    updated["shell/dependency-closure-manifest.json"] = manifest_bytes
    changed = {name for name in files if files[name] != updated[name]}
    if changed != {"shell/northstar-dependency-closure.cjs", "shell/dependency-closure-manifest.json"}:
        raise ValueError(f"portable closure overlay differs from helper+manifest allowlist: {sorted(changed)}")
    return updated


def build_archive(members: list[tarfile.TarInfo], files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for original in members:
                member = copy.copy(original)
                member.pax_headers = {}
                if member.isfile():
                    data = files[member.name]
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
                else:
                    archive.addfile(member)
    return output.getvalue()


def build_unit() -> bytes:
    unit = BASE_UNIT.read_bytes()
    if unit.count(OLD_RELEASE.encode()) != 3:
        raise ValueError("r2 unit does not contain exactly three immutable release paths")
    unit = unit.replace(OLD_RELEASE.encode(), NEW_RELEASE.encode())
    old_description = b"Description=Northstar Shell (DRAFT ONLY - NOT FOR DEPLOYMENT - Candidate 33)"
    new_description = b"Description=Northstar Shell (DRAFT ONLY - NOT FOR DEPLOYMENT - Candidate 33 r4)"
    if unit.count(old_description) != 1:
        raise ValueError("r2 service description differs from the reviewed base")
    return unit.replace(old_description, new_description)


def build_note(archive: bytes, unit: bytes) -> bytes:
    text = f"""# candidate-33 draft r4: portable catalog diagnostics closure

基底为冻结 candidate-33 r2，归档 SHA-256 `{BASE_SHA256}`。本地草稿仅覆盖四个运行成员：catalog failure-stage 的两个源码文件，以及已修复本地 `file:` source 路径可移植性的 closure helper 与 Linux/amd64 manifest。

| 文件 | SHA-256 |
|---|---|
| `{ARCHIVE.relative_to(ROOT)}` | `{sha(archive)}` |
| `{UNIT.relative_to(ROOT)}` | `{sha(unit)}` |
| failure-stage patch | `{PATCH_SHA256}` |
| portable closure helper | `{HELPER_SHA256}` |
| portable closure manifest | `{MANIFEST_SHA256}` |

r2 共 325 个归档成员，overlay 仅修改 `shell/server.cjs`、`shell/model-catalog.cjs`、`shell/northstar-dependency-closure.cjs`、`shell/dependency-closure-manifest.json`；其余 321 个成员逐字节继承。目标固定 Linux/amd64，Node.js >=22.19.0，Arborist 8.0.5、semver 7.8.5；manifest 记录 472 个生产包与 30,091 个文件。portable helper/manifest 在两个不同绝对根完成 Linux/amd64 clean `npm ci` + closure `--check`，2/2 PASS；r4完整归档在模拟immutable release路径独立clean install + 包内closure `--check` 亦PASS，均为472 packages / 30,091 files。独立归档审计 `scripts/audit-t16-candidate33-r4.py` PASS。

这是不可部署的本地 draft。最终runbook与handoff ZIP尚未绑定，目标机实际r2 systemd配置/回滚映射尚未取得；本builder不执行安装、部署或发送产物。candidate-33 r2/r3与既有交接包保持冻结。
"""
    return text.encode("utf-8")


def main() -> None:
    if sys.argv[1:] not in ([], ["--write"], ["--check"]):
        raise SystemExit("usage: package-northstar-candidate33-r4.py [--write|--check]")
    verify_frozen_inputs()
    members, original_files = read_archive()
    patched = apply_named_patch(original_files)
    updated = apply_portable_closure_inputs(patched)
    changed = {name for name in original_files if original_files[name] != updated[name]}
    if changed != TARGET_MEMBERS:
        raise ValueError(f"r4 runtime overlay differs from exact four-member allowlist: {sorted(changed)}")
    archive = build_archive(members, updated)
    unit = build_unit()
    note = build_note(archive, unit)
    outputs = ((ARCHIVE, archive), (UNIT, unit), (NOTE, note))
    check_only = sys.argv[1:] == ["--check"]
    if check_only:
        for path, expected in outputs:
            if not path.exists() or path.read_bytes() != expected:
                raise SystemExit(f"candidate-33 r4 output differs from reproducible build: {path}")
    else:
        if any(path.exists() for path, _ in outputs):
            raise SystemExit("candidate-33 r4 output already exists; refusing to overwrite")
        for path, data in outputs:
            path.write_bytes(data)
    print(f"base archive sha256: {BASE_SHA256}")
    print(f"draft archive sha256: {sha(archive)}")
    print(f"draft service sha256: {sha(unit)}")
    print(f"portable closure manifest sha256: {MANIFEST_SHA256}")
    print("overlay: PASS shell/server.cjs + shell/model-catalog.cjs + closure helper + closure manifest")
    print("archive members: 325 (321 byte-identical to frozen r2)")
    print("revision: candidate-33 r4 local draft only; NOT FOR DEPLOYMENT")
    print("reproducibility: PASS" if check_only else "draft: written; NOT FOR DEPLOYMENT")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f"candidate-33 r4 build failed: {error}", file=sys.stderr)
        raise SystemExit(1)
