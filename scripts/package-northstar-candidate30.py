#!/usr/bin/env python3
"""Freeze adapter propagation of safe runner diagnostics over candidate-29."""
import gzip
import hashlib
import io
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-29.tar.gz"
SOURCE_SHA = "e060ebbfed060e8b2d61366d926475abf35a2c178a1b66283b871ec32608cc1f"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-29.service"
SOURCE_UNIT_SHA = "0e56a95c8b43df985a197d0ea32a08cb3614b5eb4436de2dc1bb23498fe7c3c6"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-30.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-30.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-30.md"
OVERLAY = "shell/runtime/dsh-adapter.cjs"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    source_bytes, source_unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(source_bytes) != SOURCE_SHA or sha(source_unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-29 inputs differ from their frozen checksums")
    check_only = sys.argv[1:] == ["--check"]
    refresh_book = sys.argv[1:] == ["--refresh-runbook"]
    if sys.argv[1:] not in ([], ["--check"], ["--refresh-runbook"]):
        raise SystemExit("usage: package-northstar-candidate30.py [--check|--refresh-runbook]")
    if not check_only and not refresh_book and (ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists()):
        raise SystemExit("candidate-30 output already exists; refusing to overwrite")

    implementation = (ROOT / OVERLAY).read_bytes()
    required = (
        b"function normalizeRunnerControlError(frame)",
        b"if (frame.type === \"error\" && !proc.ready)",
        b"uncorrelated runner control error",
        b"RUNNER_CONTROL_ERRORS",
    )
    if any(marker not in implementation for marker in required):
        raise SystemExit("adapter safe control-error propagation is incomplete")

    raw = gzip.decompress(source_bytes)
    archive_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        members = source.getmembers()
        names = {member.name for member in members}
        if len(names) != len(members) or OVERLAY not in names:
            raise SystemExit("candidate-29 archive member set is invalid")
        with tarfile.open(fileobj=archive_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
            for member in members:
                data = None
                if member.isfile():
                    if member.name == OVERLAY:
                        data = implementation
                    else:
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
        zipped.write(archive_buffer.getvalue())
    archive_bytes = compressed.getvalue()
    unit = source_unit.replace(b"candidate-29", b"candidate-30")
    unit = unit.replace(
        b"Description=Northstar Shell (Controlled Trial Candidate 29)",
        b"Description=Northstar Shell (Controlled Trial Candidate 30)",
    )

    source_book = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-29.md"
    source_text = source_book.read_text()
    if "## 执行规则" not in source_text:
        raise SystemExit("candidate-29 runbook is missing execution section")
    execution = "## 执行规则" + source_text.split("## 执行规则", 1)[1]
    execution = execution.replace("candidate-29", "candidate-30")
    execution = execution.replace("candidate-02 至 candidate-28 均已作废", "candidate-02 至 candidate-29 均已作废")
    execution = execution.replace(SOURCE_SHA, sha(archive_bytes)).replace(SOURCE_UNIT_SHA, sha(unit))
    book = f"""# 北极星受控试运行部署命令清单（candidate-30）

日期：2026-10-22。用途：由维护者仅切换现有测试机的 Northstar shell，以核验 T06/T07 模型资格并按已批准额度做一次受控文本 Run。candidate-30 以不可变 candidate-29 为基底，仅覆盖 `shell/runtime/dsh-adapter.cjs`，将 runner 控制异常的安全 code/message 传递至对应 Run，并安全记录无关联 session 的错误；原始子进程文本不会回传。candidate-29 已添加 runner 固定错误码；candidate-28 已落实 PT `/v1/models` 当前返回列表的逐 ID `permission=true` 与不完整分页 fail-closed。账号限流（35次/分钟）、Run 并发（每账号4、全局16）、T10/T12/T15/T17 切片均由基底继承。

此包不是 Phase 1 最终发布，不改变 T00–T18 或 AC01–AC24 的整体验收状态。candidate-02 至 candidate-29 均已作废，维护者只执行本版清单。此次受控额度为一次文本请求、0重试、0工具、180秒，使用 `?northstarNoChatRetry=1`；不授权真实图片生成，也不证明线上 `hello` 根因或图片费用。analytics 与 attribution 仅为快照，本次不切换。

| 产物 | SHA-256 | 用途 |
|---|---|---|
| [`northstar-controlled-trial-20261022-candidate-30.tar.gz`](../../release-artifacts/northstar-controlled-trial-20261022-candidate-30.tar.gz) | `{sha(archive_bytes)}` | 冻结源快照；本次只部署 shell |
| [`northstar-shell-candidate-30.service`](../../release-artifacts/northstar-shell-candidate-30.service) | `{sha(unit)}` | systemd shell unit，指向 candidate-30 发布目录 |

candidate-30 对 candidate-29 仅有一个归档源码 overlay：`shell/runtime/dsh-adapter.cjs`。最终发布审计还须确认 USTAR headers、323 个唯一成员、20 个 migrations、无 AppleDouble/禁用路径、仅该文件变化，并验证本清单所有命令块语法。实际目标机 profile、启动、health、rollback 与受控文本请求仍由维护者执行并回传证据。

{execution}"""
    if check_only:
        for path, data in ((ARCHIVE, archive_bytes), (UNIT, unit), (RUNBOOK, book.encode("utf-8"))):
            if not path.exists() or path.read_bytes() != data:
                raise SystemExit(f"candidate-30 output differs from reproducible build: {path}")
    elif refresh_book:
        for path, data in ((ARCHIVE, archive_bytes), (UNIT, unit)):
            if not path.exists() or path.read_bytes() != data:
                raise SystemExit(f"refusing to update runbook; frozen artifact differs: {path}")
        RUNBOOK.write_text(book)
    else:
        ARCHIVE.write_bytes(archive_bytes)
        UNIT.write_bytes(unit)
        RUNBOOK.write_text(book)
    print(f"archive sha256: {sha(archive_bytes)}")
    print(f"service sha256: {sha(unit)}")
    print(f"archive members: {len(members)}")
    print("reproducibility: PASS" if check_only else ("runbook refresh: PASS" if refresh_book else "build: written"))


if __name__ == "__main__":
    main()
