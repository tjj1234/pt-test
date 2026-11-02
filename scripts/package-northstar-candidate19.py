#!/usr/bin/env python3
"""Freeze current Northstar shell sources over the reviewed candidate-18 snapshot."""
from __future__ import annotations

import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-18.tar.gz"
SOURCE_SHA = "eb6e9cdbc931eafe4d215596b354fc498d283638a99f00f356900ed58de94f37"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-18.service"
SOURCE_UNIT_SHA = "ed3b4de17f4c27fdf5552ed5b3fdc9730e77ba816e9437851473ee45db70cfa8"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-19.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-19.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-19.md"
NEW_FILES = (
    "shell/attachments/csv-analysis.cjs",
    "shell/db-migrations/019_account_disable.sql",
    "shell/skills/release-snapshot.cjs",
    "shell/tasks/memory-run-invalidation.cjs",
)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    original, unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-18 inputs differ from their reviewed checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        raise SystemExit("candidate-19 output exists; refusing to overwrite")
    replacements: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(original)), mode="r:") as source:
        members = source.getmembers()
        names = {member.name for member in members}
        for member in members:
            if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE):
                raise SystemExit(f"unexpected member type: {member.name} ({member.type!r})")
            path = pathlib.PurePosixPath(member.name)
            if member.name.startswith("/") or ".." in path.parts or member.name.startswith("__MACOSX/") or path.name.startswith("._"):
                raise SystemExit(f"unsafe or AppleDouble archive path: {member.name}")
            if member.isfile():
                extracted = source.extractfile(member)
                if extracted is None:
                    raise SystemExit(f"cannot read archive member: {member.name}")
                data = extracted.read()
                current = ROOT / member.name
                if current.is_file() and current.read_bytes() != data:
                    replacements[member.name] = current.read_bytes()
        for name in NEW_FILES:
            current = ROOT / name
            if name in names or not current.is_file():
                raise SystemExit(f"new source input missing or already archived: {name}")
            replacements[name] = current.read_bytes()

    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(original)), mode="r:") as source:
            for member in source.getmembers():
                data = None
                if member.isfile():
                    data = replacements.get(member.name)
                    if data is None:
                        data = source.extractfile(member).read()
                info = tarfile.TarInfo(member.name)
                info.type = tarfile.DIRTYPE if member.isdir() else tarfile.REGTYPE
                info.mode = member.mode
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = member.mtime
                info.size = len(data) if data is not None else 0
                output.addfile(info, io.BytesIO(data) if data is not None else None)
        for name in NEW_FILES:
            data = replacements[name]
            info = tarfile.TarInfo(name)
            info.type = tarfile.REGTYPE
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = 0
            info.size = len(data)
            output.addfile(info, io.BytesIO(data))

    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as zipped:
        zipped.write(tar_buffer.getvalue())
    ARCHIVE.write_bytes(compressed.getvalue())
    updated_unit = unit.replace(b"candidate-18", b"candidate-19")
    UNIT.write_bytes(updated_unit)
    archive_sha, unit_sha = sha(compressed.getvalue()), sha(updated_unit)

    old_book = (ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-18.md").read_text()
    book = old_book.replace("candidate-18", "candidate-19")
    book = book.replace("candidate-02 至 candidate-17 均已作废", "candidate-02 至 candidate-18 均已作废")
    book = book.replace("eb6e9cdbc931eafe4d215596b354fc498d283638a99f00f356900ed58de94f37", archive_sha)
    book = book.replace("ed3b4de17f4c27fdf5552ed5b3fdc9730e77ba816e9437851473ee45db70cfa8", unit_sha)
    book = book.replace("318个归档成员", f"{len(members) + len(NEW_FILES)}个归档成员")
    book = book.replace("19个SQL migration", "20个SQL migration")
    book = book.replace("SQL_MIGRATION_FILES=19", "SQL_MIGRATION_FILES=20")
    book = book.replace("migrations!=19", "migrations!=20")
    book = book.replace("EXPECTED=19 APPLIED=19", "EXPECTED=20 APPLIED=20")
    book = book.replace("T10新回归在Darwin helper + HTTP/PGlite边界 **8/8 PASS**；目标Linux仍需复验。", "T10新回归在Darwin helper + HTTP/PGlite边界 **8/8 PASS**；目标Linux仍需复验。记忆变更会请求取消活动Run，仅在终态`cancelled`时报告成功；跨进程取消未确认会返回503。当前候选还包括存储初始化清理和账户停用迁移更新；真实目标库迁移状态须按第5步逐项核对。")
    book = book.replace(
        "候选基于分支 `feature/northstar-phase1-refactor-20261016`、HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`，从 candidate-17 冻结归档更新 `shell/persistent-runner.mjs`：非法、负数或不安全的预算计数保留为 `null`，有效的零值仍为 `0`，随后重封 USTAR。",
        "候选基于分支 `feature/northstar-phase1-refactor-20261016` 与当前未提交工作区快照：从 candidate-18 更新7个已归档文件并加入4个新增shell文件，包含`persistent-runner.mjs`预算修复、PT确认的endpoint能力映射、当前存储/认证/CSV/预算事件改动及记忆修改删除时的活动Run取消；随后重封USTAR。",
    )
    book = book.replace("包内`server.cjs`、`public/app.js`和`persistent-runner.mjs`与当前源码字节一致", "包内当前工作区所有匹配的shell源文件均与打包输入字节一致")
    book = book.replace("candidate-17 冻结归档", "candidate-18 冻结归档")
    book = book.replace("只回传候选模型的", "只回传候选模型的")
    RUNBOOK.write_text(book)
    print(f"archive sha256: {archive_sha}")
    print(f"service sha256: {unit_sha}")
    print(f"archive members: {len(members) + len(NEW_FILES)}")
    print(f"updated files: {len(replacements)}")


if __name__ == "__main__":
    main()
