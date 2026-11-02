#!/usr/bin/env python3
"""Freeze the runner failure diagnostics over the unpublished candidate-23."""
import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-23.tar.gz"
SOURCE_SHA = "30568c8ea3f1c02369342b4338c9f484e64f61441a82491f0b5050c2afa2d4e2"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-23.service"
SOURCE_UNIT_SHA = "12062c15b0195efb19a3116bf9da4006bf66db78f80bacae2e8dd17bf9eec072"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-24.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-24.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-24.md"
OVERLAYS = ("shell/persistent-runner.mjs", "shell/server.cjs")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    original, source_unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(source_unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-23 inputs differ from their frozen checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        raise SystemExit("candidate-24 output already exists; refusing to overwrite")
    overlays = {name: (ROOT / name).read_bytes() for name in OVERLAYS}
    runner = overlays["shell/persistent-runner.mjs"]
    server = overlays["shell/server.cjs"]
    for marker in (b"EMPTY_ASSISTANT_RESPONSE", b"RUN_INTERRUPTED", b"RUN_DURATION_LIMIT"):
        if marker not in runner:
            raise SystemExit(f"runner diagnostic marker missing: {marker.decode()}")
    if b"code: r.code || null" not in server:
        raise SystemExit("server completion frame does not preserve runner code")

    raw = gzip.decompress(original)
    out_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        members = source.getmembers()
        names = {m.name for m in members}
        if len(names) != len(members) or not all(name in names for name in OVERLAYS):
            raise SystemExit("candidate-23 archive member set is invalid")
        with tarfile.open(fileobj=out_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
            for member in members:
                data = None
                if member.isfile():
                    data = overlays.get(member.name)
                    if data is None:
                        extracted = source.extractfile(member)
                        if extracted is None:
                            raise SystemExit(f"cannot read archive member: {member.name}")
                        data = extracted.read()
                info = tarfile.TarInfo(member.name)
                info.type = tarfile.DIRTYPE if member.isdir() else tarfile.REGTYPE
                info.mode, info.uid, info.gid = member.mode, 0, 0
                info.uname = info.gname = ""
                info.mtime = member.mtime
                info.size = len(data) if data is not None else 0
                output.addfile(info, io.BytesIO(data) if data is not None else None)
    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as zipped:
        zipped.write(out_buffer.getvalue())
    ARCHIVE.write_bytes(compressed.getvalue())

    unit = source_unit.replace(b"candidate-23", b"candidate-24")
    unit = unit.replace(b"Description=Northstar Shell (Controlled Trial Candidate 23)", b"Description=Northstar Shell (Controlled Trial Candidate 24)")
    UNIT.write_bytes(unit)
    old_book = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-23.md"
    book = old_book.read_text()
    book = book.replace("candidate-23", "candidate-24")
    book = book.replace("candidate-02 至 candidate-22 均已作废", "candidate-02 至 candidate-23 均已作废")
    book = book.replace(SOURCE_SHA, sha(compressed.getvalue())).replace(SOURCE_UNIT_SHA, sha(unit))
    book = book.replace("323个归档成员", "323个归档成员")
    intro = "candidate-24 在 candidate-23 基础上更新 `shell/persistent-runner.mjs` 与 `shell/server.cjs`：失败 Run 现在携带稳定错误码和明确诊断，区分预算耗尽、用户取消、runner shutdown、aborted/未完成状态及空文本；server completion frame 保留错误码。不会将原始 SDK 异常透传给用户。此包不修复/验证目标机 DSH 子进程根因，也不改变媒体收费或 T03/T11 验收状态。\n\n"
    book = book.replace("此包不是 Phase 1 最终发布", intro + "此包不是 Phase 1 最终发布", 1)
    book = book.replace("candidate-24 在 candidate-22 基础上合入", "candidate-24 在 candidate-23 基础上承接既有改动")
    book = book.replace("候选仍不是Phase 1最终发布；", "候选仍不是Phase 1最终发布；")
    RUNBOOK.write_text(book)
    print(f"archive sha256: {sha(compressed.getvalue())}")
    print(f"service sha256: {sha(unit)}")
    print(f"archive members: {len(members)}")


if __name__ == "__main__":
    main()
