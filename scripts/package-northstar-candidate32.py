#!/usr/bin/env python3
"""Freeze the paginated media-operation usage projection/UI over immutable candidate-30."""
import gzip
import hashlib
import io
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-30.tar.gz"
SOURCE_SHA = "dcabffe5cfc04e4280e92e221cc5c15e4c64379134be1747c59ac401ffb21559"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-30.service"
SOURCE_UNIT_SHA = "116cda02601ebef2dbb8a39d53787f03defe69ca16d669fe17ecb76fda7f3175"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-32.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-32.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-32.md"
OVERLAYS = (
    "shell/tasks/external-operations-store.cjs",
    "shell/server.cjs",
    "shell/public/app.js",
    "shell/public/index.html",
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    source_bytes, source_unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(source_bytes) != SOURCE_SHA or sha(source_unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-30 inputs differ from their frozen checksums")
    check_only = sys.argv[1:] == ["--check"]
    refresh_book = sys.argv[1:] == ["--refresh-runbook"]
    if sys.argv[1:] not in ([], ["--check"], ["--refresh-runbook"]):
        raise SystemExit("usage: package-northstar-candidate31.py [--check|--refresh-runbook]")
    if not check_only and not refresh_book and (ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists()):
        raise SystemExit("candidate-32 output already exists; refusing to overwrite")

    implementations = {name: (ROOT / name).read_bytes() for name in OVERLAYS}
    markers = {
        "shell/tasks/external-operations-store.cjs": (b"costCoverage", b"unknown"),
        "shell/server.cjs": (b"/api/usage/external-operations", b"afterOperationId", b"externalOperations"),
        "shell/public/app.js": (b"external-operations", b"bizLoadMoreExternalOperations", "unknown（待 PT 对账）".encode()),
        "shell/public/index.html": ("近期媒体外部操作".encode(), b"usageExternalOperations"),
    }
    for name, required in markers.items():
        if any(marker not in implementations[name] for marker in required):
            raise SystemExit(f"media operation usage projection is incomplete: {name}")

    raw = gzip.decompress(source_bytes)
    archive_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        members = source.getmembers()
        names = {member.name for member in members}
        if len(names) != len(members) or not set(OVERLAYS).issubset(names):
            raise SystemExit("candidate-30 archive member set is invalid")
        with tarfile.open(fileobj=archive_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
            for member in members:
                data = None
                if member.isfile():
                    if member.name in implementations:
                        data = implementations[member.name]
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
    unit = source_unit.replace(b"candidate-30", b"candidate-32")
    unit = unit.replace(
        b"Description=Northstar Shell (Controlled Trial Candidate 30)",
        b"Description=Northstar Shell (Controlled Trial Candidate 32)",
    )

    source_book = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-30.md"
    source_text = source_book.read_text()
    if "## 执行规则" not in source_text:
        raise SystemExit("candidate-30 runbook is missing execution section")
    execution = "## 执行规则" + source_text.split("## 执行规则", 1)[1]
    execution = execution.replace("candidate-30", "candidate-32")
    execution = execution.replace("candidate-02 至 candidate-29 均已作废", "candidate-02 至 candidate-31 均已作废")
    execution = execution.replace(SOURCE_SHA, sha(archive_bytes)).replace(SOURCE_UNIT_SHA, sha(unit))
    book = f"""# 北极星受控试运行部署命令清单（candidate-32）

日期：2026-10-23。用途：由维护者仅切换现有测试机的 Northstar shell，以核验 T06/T07 模型资格并按已批准额度做一次受控文本 Run。candidate-32 以不可变 candidate-30 为基底，增加按当前 user/tenant 隔离、支持稳定游标分页的媒体外部操作用量视图：列出 Run/operation/provider/task 状态与查单记录，范围按工具调用页面的日历日边界筛选；费用和币种保留 unknown，不从 chat token 推导。candidate-30 已将 runner 的安全控制错误传递到 Run 结果；candidate-29 已加入 runner 安全错误码；candidate-28 已落实 PT `/v1/models` 逐 ID 权限及分页 fail-closed 语义。其他限流、router、run-budget、T10/T12 切片从基底继承。

此包不是 Phase 1 最终发布，不改变 T00–T18 或 AC01–AC24 整体验收状态。candidate-02 至 candidate-31 均已作废，维护者只执行本版清单。此次受控额度为一次文本请求、0重试、0工具、180秒，使用 `?northstarNoChatRetry=1`；不授权真实图片生成，也不证明线上 `hello` 根因或图片费用。用量新视图显示 unknown cost，最终费用只能用 PT usage/billing 核对。analytics 与 attribution 仅为快照，本次不切换。

| 产物 | SHA-256 | 用途 |
|---|---|---|
| [`northstar-controlled-trial-20261022-candidate-32.tar.gz`](../../release-artifacts/northstar-controlled-trial-20261022-candidate-32.tar.gz) | `{sha(archive_bytes)}` | 冻结源快照；本次只部署 shell |
| [`northstar-shell-candidate-32.service`](../../release-artifacts/northstar-shell-candidate-32.service) | `{sha(unit)}` | systemd shell unit，指向 candidate-32 发布目录 |

candidate-32 相对 candidate-30 仅覆盖 `shell/tasks/external-operations-store.cjs`、`shell/server.cjs`、`shell/public/app.js` 与 `shell/public/index.html`。发布审计须确认 USTAR headers、323个唯一成员、20个 migrations、无 AppleDouble/禁用路径、变化文件恰为这四项，并验证命令块语法与checksum。目标 Linux 部署、health、rollback、线上权限字段及受控文本Run仍由维护者执行并回传；本包不包含图片生成调用。

{execution}"""
    if check_only:
        for path, data in ((ARCHIVE, archive_bytes), (UNIT, unit), (RUNBOOK, book.encode("utf-8"))):
            if not path.exists() or path.read_bytes() != data:
                raise SystemExit(f"candidate-32 output differs from reproducible build: {path}")
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
