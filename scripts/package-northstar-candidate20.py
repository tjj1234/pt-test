#!/usr/bin/env python3
"""Freeze the narrowed memory-cancellation scope over candidate-19."""
import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-19.tar.gz"
SOURCE_SHA = "b433ec44795c455bcf40a83f8d5ecefd9181d25e0f40fc1e1688d4d65fd0eb1c"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-19.service"
SOURCE_UNIT_SHA = "b9743df3134e20c6154b63ba924f9d9eba982e03e4d85c3e8c85a54a01a7a071"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-20.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-20.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-20.md"
HELPER = "shell/tasks/memory-run-invalidation.cjs"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    original, unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-19 inputs differ from their reviewed checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        raise SystemExit("candidate-20 output exists; refusing to overwrite")
    updated = (ROOT / HELPER).read_bytes()
    if b'"running", "waiting_external", "awaiting_confirmation", "cancelling"' not in updated or b'"queued"' in updated:
        raise SystemExit("memory cancellation helper does not match the approved active-Run scope")
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(original)), mode="r:") as source:
        members = source.getmembers()
        with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
            found = False
            for member in members:
                data = None
                if member.isfile():
                    extracted = source.extractfile(member)
                    if extracted is None:
                        raise SystemExit(f"cannot read archive member: {member.name}")
                    data = updated if member.name == HELPER else extracted.read()
                    found |= member.name == HELPER
                info = tarfile.TarInfo(member.name)
                info.type = tarfile.DIRTYPE if member.isdir() else tarfile.REGTYPE
                info.mode, info.uid, info.gid = member.mode, 0, 0
                info.uname = info.gname = ""
                info.mtime = member.mtime
                info.size = len(data) if data is not None else 0
                output.addfile(info, io.BytesIO(data) if data is not None else None)
            if not found:
                raise SystemExit("candidate-19 is missing the memory cancellation helper")
    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as zipped:
        zipped.write(tar_buffer.getvalue())
    ARCHIVE.write_bytes(compressed.getvalue())
    updated_unit = unit.replace(b"candidate-19", b"candidate-20")
    UNIT.write_bytes(updated_unit)
    archive_sha, unit_sha = sha(compressed.getvalue()), sha(updated_unit)
    book = (ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-19.md").read_text()
    book = book.replace("candidate-19", "candidate-20")
    book = book.replace("candidate-02 至 candidate-18 均已作废", "candidate-02 至 candidate-19 均已作废")
    book = book.replace(SOURCE_SHA, archive_sha).replace(SOURCE_UNIT_SHA, unit_sha)
    book = book.replace("记忆变更会请求取消活动Run，仅在终态`cancelled`时报告成功；跨进程取消未确认会返回503。", "记忆变更会请求取消已进入执行或等待外部结果的Run；queued Run尚未发送记忆且会保留。只有终态`cancelled`才报告成功；跨进程取消未确认会返回503。")
    RUNBOOK.write_text(book)
    print(f"archive sha256: {archive_sha}")
    print(f"service sha256: {unit_sha}")
    print(f"archive members: {len(members)}")


if __name__ == "__main__":
    main()
