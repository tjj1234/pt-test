#!/usr/bin/env python3
"""Rebuild the reviewed candidate-17 archive with the runner budget-summary fix."""
from __future__ import annotations

import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-17.tar.gz"
SOURCE_SHA = "480e97cd975f61d7691163f9466e7f79ac3b898d01d79b2eb0771a977ee1f964"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-17.service"
SOURCE_UNIT_SHA = "a5abf2112af069331c621232ea50033c0b30e5ef08ff50280bf0b15dd0fb8869"
RUNNER = ROOT / "shell/persistent-runner.mjs"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-18.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-18.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-18.md"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    original = SOURCE.read_bytes()
    unit = SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-17 inputs differ from their reviewed checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        raise SystemExit("candidate-18 output already exists; refusing to overwrite")
    runner = RUNNER.read_bytes()
    if b"raw.modelCalls >= 0 ? raw.modelCalls : null" not in runner:
        raise SystemExit("runner does not contain the verified unknown-counter behavior")

    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(original)), mode="r:") as source:
            members = source.getmembers()
            if len(members) != 318:
                raise SystemExit(f"expected 318 candidate-17 members, found {len(members)}")
            for member in members:
                if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE):
                    raise SystemExit(f"unexpected member type: {member.name} ({member.type!r})")
                if member.name.startswith("/") or ".." in pathlib.PurePosixPath(member.name).parts:
                    raise SystemExit(f"unsafe archive path: {member.name}")
                data = None
                if member.isfile():
                    extracted = source.extractfile(member)
                    if extracted is None:
                        raise SystemExit(f"cannot read archive member: {member.name}")
                    data = runner if member.name == "shell/persistent-runner.mjs" else extracted.read()
                info = tarfile.TarInfo(member.name)
                info.type = tarfile.DIRTYPE if member.isdir() else tarfile.REGTYPE
                info.mode = member.mode
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = member.mtime
                info.size = len(data) if data is not None else 0
                output.addfile(info, io.BytesIO(data) if data is not None else None)

    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as zipped:
        zipped.write(tar_buffer.getvalue())
    ARCHIVE.write_bytes(compressed.getvalue())

    updated_unit = unit.replace(b"candidate-17", b"candidate-18")
    UNIT.write_bytes(updated_unit)
    archive_sha, unit_sha = sha(compressed.getvalue()), sha(updated_unit)

    old_book = (ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-17.md").read_text()
    book = old_book.replace("candidate-17", "candidate-18")
    book = book.replace("candidate-02 至 candidate-16 均已作废", "candidate-02 至 candidate-17 均已作废")
    book = book.replace(
        "候选基于分支 `feature/northstar-phase1-refactor-20261016`、HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`，从 candidate-17 冻结归档更新 `shell/persistent-runner.mjs`：非法、负数或不安全的预算计数保留为 `null`，有效的零值仍为 `0`，随后重封 USTAR。",
        "候选基于分支 `feature/northstar-phase1-refactor-20261016`、HEAD `b09b1e13720cd16cd7538999d4c63386920b367c`，从 candidate-17 冻结归档更新 `shell/persistent-runner.mjs`：非法、负数或不安全的预算计数保留为 `null`，有效的零值仍为 `0`，随后重封 USTAR。",
    )
    book = book.replace("且包内`server.cjs`和`public/app.js`与当前源码字节一致", "且包内`server.cjs`、`public/app.js`和`persistent-runner.mjs`与当前源码字节一致")
    book = book.replace(SOURCE_SHA, archive_sha).replace(SOURCE_UNIT_SHA, unit_sha)
    RUNBOOK.write_text(book)
    print(f"archive sha256: {archive_sha}")
    print(f"service sha256: {unit_sha}")
    print(f"archive members: {len(members)}")


if __name__ == "__main__":
    main()
