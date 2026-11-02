#!/usr/bin/env python3
"""Freeze the initAuth migration cleanup fix over candidate-20."""
import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-20.tar.gz"
SOURCE_SHA = "4bc1f95b3f4797764fd33212171f1b98e6130dd37f4dd1342e4512d644b6dfbc"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-20.service"
SOURCE_UNIT_SHA = "aaa52f886c2ef577b75f62c39aa7fb4bbeceac38ce3da08b38750264f0a06046"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-21.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-21.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-21.md"
AUTH = "shell/auth.cjs"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    original, unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-20 inputs differ from their reviewed checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        raise SystemExit("candidate-21 output exists; refusing to overwrite")
    updated = (ROOT / AUTH).read_bytes()
    if b"dbmod.migrate(db, migrationsDir);" not in updated or b"Preserve the original initialization failure" not in updated:
        raise SystemExit("auth.cjs does not contain the verified initAuth migration cleanup")
    raw = gzip.decompress(original)
    tar_buffer = io.BytesIO()
    found = False
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        members = source.getmembers()
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
        raise SystemExit("candidate-20 is missing shell/auth.cjs")
    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as zipped:
        zipped.write(tar_buffer.getvalue())
    ARCHIVE.write_bytes(compressed.getvalue())
    updated_unit = unit.replace(b"candidate-20", b"candidate-21")
    UNIT.write_bytes(updated_unit)
    archive_sha, unit_sha = sha(compressed.getvalue()), sha(updated_unit)
    book = (ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-20.md").read_text()
    book = book.replace("candidate-20", "candidate-21")
    book = book.replace("candidate-02 至 candidate-19 均已作废", "candidate-02 至 candidate-20 均已作废")
    book = book.replace(SOURCE_SHA, archive_sha).replace(SOURCE_UNIT_SHA, unit_sha)
    book = book.replace("candidate-19 已从 candidate-18 更新7个归档文件并加入4个新增shell文件；candidate-20 再更新 `shell/tasks/memory-run-invalidation.cjs`", "candidate-19 已从 candidate-18 更新7个归档文件并加入4个新增shell文件；candidate-20 再更新 `shell/tasks/memory-run-invalidation.cjs`；candidate-21 再更新 `shell/auth.cjs`，确保migration失败时关闭auth已打开的数据库句柄并保留原始错误")
    RUNBOOK.write_text(book)
    print(f"archive sha256: {archive_sha}")
    print(f"service sha256: {unit_sha}")
    print(f"archive members: {len(members)}")


if __name__ == "__main__":
    main()
