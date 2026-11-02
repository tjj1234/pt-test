#!/usr/bin/env python3
"""Freeze the complete initAuth failure cleanup over candidate-21."""
import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-21.tar.gz"
SOURCE_SHA = "81cc6cd4467c2ef34f320ca40f71e25c10e43f50ecfcda021614948988b0140a"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-21.service"
SOURCE_UNIT_SHA = "fd1ce0025cc06c384a7ff13ec5a7c7115bf22f73e9ac025cfac559f67019ed7f"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-22.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-22.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-22.md"
AUTH = "shell/auth.cjs"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    original, unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-21 inputs differ from their reviewed checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        raise SystemExit("candidate-22 output exists; refusing to overwrite")
    updated = (ROOT / AUTH).read_bytes()
    if (b"dbmod.migrate(db, migrationsDir);" not in updated
            or b"closeAfterInitializationFailure" not in updated
            or b"ensureDefaultAdmin(opts.defaultAdmin.username" not in updated):
        raise SystemExit("auth.cjs does not close on migration and admin-seed failures")
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(original)), mode="r:") as source:
        members = source.getmembers()
        found = False
        with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
            for member in members:
                data = None
                if member.isfile():
                    extracted = source.extractfile(member)
                    if extracted is None:
                        raise SystemExit(f"cannot read archive member: {member.name}")
                    data = updated if member.name == AUTH else extracted.read()
                    found |= member.name == AUTH
                info = tarfile.TarInfo(member.name)
                info.type = tarfile.DIRTYPE if member.isdir() else tarfile.REGTYPE
                info.mode, info.uid, info.gid = member.mode, 0, 0
                info.uname = info.gname = ""
                info.mtime = member.mtime
                info.size = len(data) if data is not None else 0
                output.addfile(info, io.BytesIO(data) if data is not None else None)
    if not found:
        raise SystemExit("candidate-21 is missing shell/auth.cjs")
    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as zipped:
        zipped.write(tar_buffer.getvalue())
    ARCHIVE.write_bytes(compressed.getvalue())
    updated_unit = unit.replace(b"candidate-21", b"candidate-22")
    UNIT.write_bytes(updated_unit)
    archive_sha, unit_sha = sha(compressed.getvalue()), sha(updated_unit)
    book = (ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-21.md").read_text()
    book = book.replace("candidate-21", "candidate-22")
    book = book.replace("candidate-02 至 candidate-20 均已作废", "candidate-02 至 candidate-21 均已作废")
    book = book.replace(SOURCE_SHA, archive_sha).replace(SOURCE_UNIT_SHA, unit_sha)
    book = book.replace(
        "migration 失败时关闭其打开的数据库句柄并保留原始错误，之后重封 USTAR。",
        "migration 或默认管理员初始化失败时关闭其打开的数据库句柄并保留原始错误，之后重封 USTAR。",
    )
    RUNBOOK.write_text(book)
    print(f"archive sha256: {archive_sha}")
    print(f"service sha256: {unit_sha}")
    print(f"archive members: {len(members)}")


if __name__ == "__main__":
    main()
