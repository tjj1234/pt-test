#!/usr/bin/env python3
"""Build a local-only candidate-33 r3 diagnostic draft from frozen r2."""
from __future__ import annotations

import copy
import gzip
import hashlib
import io
import pathlib
import subprocess
import sys
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
BASE = ARTIFACTS / "northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz"
BASE_UNIT = ARTIFACTS / "northstar-shell-candidate-33-draft-r2.service"
PATCH_FILE = ROOT / "docs/refactor/evidence/candidate33-r3-failure-stage.patch"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261023-candidate-33-draft-r3.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-33-draft-r3.service"
NOTE = ROOT / "docs/refactor/evidence/candidate33-model-catalog-diagnostics-draft-r3-20261023.md"

BASE_SHA256 = "bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77"
BASE_UNIT_SHA256 = "eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105"
PATCH_SHA256 = "8e2a1fa7e4483eef6b54fa19658657b7690e2ef39ce0770e00a978dc16687e8f"
TARGET_MEMBERS = {"shell/server.cjs", "shell/model-catalog.cjs"}
OLD_RELEASE = "/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2"
NEW_RELEASE = "/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r3"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify_frozen_inputs() -> None:
    if sha(BASE.read_bytes()) != BASE_SHA256:
        raise ValueError("frozen candidate-33 r2 archive checksum changed")
    if sha(BASE_UNIT.read_bytes()) != BASE_UNIT_SHA256:
        raise ValueError("frozen candidate-33 r2 unit checksum changed")
    if sha(PATCH_FILE.read_bytes()) != PATCH_SHA256:
        raise ValueError("failure-stage patch checksum changed")


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
            raise ValueError("candidate-33 r2 member count or required source members differ")
        return members, files


def apply_named_patch(files: dict[str, bytes]) -> dict[str, bytes]:
    with tempfile.TemporaryDirectory(prefix="northstar-c33-r3-patch-") as temp:
        work = pathlib.Path(temp)
        for name in TARGET_MEMBERS:
            path = work / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(files[name])
        patch = subprocess.run(
            ["patch", "-p1", "-d", str(work), "--batch", "--forward"],
            input=PATCH_FILE.read_bytes(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        if patch.returncode != 0:
            raise ValueError("failure-stage patch did not apply cleanly: " + patch.stderr.decode("utf-8", "replace"))
        updated = dict(files)
        for name in TARGET_MEMBERS:
            updated[name] = (work / name).read_bytes()
        changed = {name for name in files if files[name] != updated[name]}
        if changed != TARGET_MEMBERS:
            raise ValueError(f"patch changed an undeclared archive member: {sorted(changed)}")
        expected = {
            "shell/server.cjs": "ee7c595018873d48527bbeda411a3247bde36eeb25873319c9c1b8429a8549f6",
            "shell/model-catalog.cjs": "620f18c683b348aeecb6c9cc50ef74652f572b713bd3b75eb9422041bffa5a13",
        }
        for name, digest in expected.items():
            if sha(updated[name]) != digest:
                raise ValueError(f"patched member checksum differs: {name}")
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
    new_description = b"Description=Northstar Shell (DRAFT ONLY - NOT FOR DEPLOYMENT - Candidate 33 r3)"
    if unit.count(old_description) != 1:
        raise ValueError("r2 service description differs from the reviewed base")
    return unit.replace(old_description, new_description)


def build_note(archive: bytes, unit: bytes) -> bytes:
    text = f"""# candidate-33 draft r3: catalog failure-stage diagnostics

基底为冻结 candidate-33 r2，归档 SHA-256 `{BASE_SHA256}`。本草稿只叠加安全目录失败阶段诊断，target Linux/amd64、Node.js >=22.19；不含模型调用、数据库迁移或依赖变更。

| 文件 | SHA-256 |
|---|---|
| `{ARCHIVE.relative_to(ROOT)}` | `{sha(archive)}` |
| `{UNIT.relative_to(ROOT)}` | `{sha(unit)}` |
| failure-stage patch | `{PATCH_SHA256}` |

覆盖成员仅 `shell/server.cjs`、`shell/model-catalog.cjs`；其余 323 个归档成员逐字节继承 r2。新增接口字段 `failureStage` 限于九项固定枚举，internal error 的失败计数为 unknown。测试只使用本地 fixture，不发出 PT 模型请求。

本轮工作区回归：failure-stage 3/3、catalog diagnostics 3/3、HTTP/API脱敏与日志故障回退 1/1；合并执行为 7/7 PASS。T11 usage/UI 6/6 与 T03 lease recovery 10/10 是并行重构切片证据，未包含在本 r3 包内。HTTP fixture仅证明接口投影与安全日志边界；qualification真实故障注入仍未覆盖。线上 TypeError 根因尚未确定。

线上 r2 回传的 `MODEL_CATALOG_INTERNAL_TYPE_ERROR` 只说明异常未命中固定错误码、名称为 `TypeError`；r2 fallback 会固定返回 `failureCount:0`、`upstreamStatus:null`、`lastSuccessfulAt:null` 和 `syncedAt:0`，这些不是请求是否发出、历史成功/失败次数的证据。`models.length:24` 是本地 fallback 列表展示数，不代表远端目录数或可执行数。r3 把未测得的失败计数改为 `null`/`failureCountKnown:false`，并增加固定 `failureStage` 以供后续回传定位。

这是不可部署的本地草稿。candidate-33 r2 归档/unit和已交接 ZIP 保持冻结；r3 新鲜 Linux closure检查失败，也没有最终可执行 runbook、handoff ZIP 或独立发布门审计。当前仅有不可执行 runbook 审阅稿（SHA-256 `193bdf147294c9bb0cccb1eaa5899f0180483c4739adafb102132201e1773854`），目标机实际 r2 systemd unit、drop-in、EnvironmentFiles 尚无安全快照，必须以其精确快照作为以后回滚基线。不得用于部署。

追加发布阻断：新鲜 Linux/amd64 解包安装后，包内closure `--check` 实测 `MANIFEST_MISMATCH`。临时重建manifest仍有472包、30,091文件，差异仅在本地DSH tarball的`resolved`：冻结manifest记录原构建目录的绝对路径。r3运行包保持冻结且不得交付；需在后续候选修正可移植来源记录，重新生成并复验逐文件manifest。
"""
    return text.encode("utf-8")


def main() -> None:
    if sys.argv[1:] not in ([], ["--write"], ["--check"]):
        raise SystemExit("usage: package-northstar-candidate33-r3.py [--write|--check]")
    verify_frozen_inputs()
    members, original_files = read_archive()
    patched_files = apply_named_patch(original_files)
    archive = build_archive(members, patched_files)
    unit = build_unit()
    note = build_note(archive, unit)
    outputs = ((ARCHIVE, archive), (UNIT, unit), (NOTE, note))
    check_only = sys.argv[1:] == ["--check"]
    if check_only:
        for path, expected in outputs:
            if not path.exists() or path.read_bytes() != expected:
                raise SystemExit(f"candidate-33 r3 output differs from reproducible build: {path}")
    else:
        if any(path.exists() for path, _ in outputs):
            raise SystemExit("candidate-33 r3 output already exists; refusing to overwrite")
        for path, data in outputs:
            path.write_bytes(data)
    print(f"base archive sha256: {BASE_SHA256}")
    print(f"draft archive sha256: {sha(archive)}")
    print(f"draft service sha256: {sha(unit)}")
    print(f"failure-stage patch sha256: {PATCH_SHA256}")
    print("overlay: PASS shell/server.cjs + shell/model-catalog.cjs only")
    print("archive members: 325 (323 byte-identical to frozen r2)")
    print("revision: candidate-33 r3 local diagnostic draft only")
    print("reproducibility: PASS" if check_only else "draft: written; NOT FOR DEPLOYMENT")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f"candidate-33 r3 build failed: {error}", file=sys.stderr)
        raise SystemExit(1)
