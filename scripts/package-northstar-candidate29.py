#!/usr/bin/env python3
"""Freeze the safe DSH control-error diagnostics over immutable candidate-28."""
import gzip
import hashlib
import io
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-28.tar.gz"
SOURCE_SHA = "1d50a46516ad1d3501889c3caaa814967a77e02e8b8bda9edcc1cb1f669789f4"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-28.service"
SOURCE_UNIT_SHA = "ccb75eeb1e36abe5602066beebe6fc206003969308d434e6f4df344b9d8b4b61"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-29.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-29.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-29.md"
OVERLAY = "shell/persistent-runner.mjs"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    source_bytes, source_unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(source_bytes) != SOURCE_SHA or sha(source_unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-28 inputs differ from their frozen checksums")
    check_only = sys.argv[1:] == ["--check"]
    refresh_book = sys.argv[1:] == ["--refresh-runbook"]
    if sys.argv[1:] not in ([], ["--check"], ["--refresh-runbook"]):
        raise SystemExit("usage: package-northstar-candidate29.py [--check|--refresh-runbook]")
    if not check_only and not refresh_book and (ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists()):
        raise SystemExit("candidate-29 output already exists; refusing to overwrite")
    implementation = (ROOT / OVERLAY).read_bytes()
    required = (
        b"RUNNER_SETUP_FAILED:",
        b"RUNNER_QUEUE_FAILED:",
        b"PARENT_FRAME_INVALID:",
        b"PARENT_COMMAND_UNSUPPORTED:",
        b"Parent frame is not valid JSON",
        b"Parent command is not supported",
    )
    if any(marker not in implementation for marker in required):
        raise SystemExit("safe runner control-error mapping is incomplete")

    raw = gzip.decompress(source_bytes)
    archive_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        members = source.getmembers()
        names = {member.name for member in members}
        if len(names) != len(members) or OVERLAY not in names:
            raise SystemExit("candidate-28 archive member set is invalid")
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
    unit = source_unit.replace(b"candidate-28", b"candidate-29")
    unit = unit.replace(
        b"Description=Northstar Shell (Controlled Trial Candidate 28)",
        b"Description=Northstar Shell (Controlled Trial Candidate 29)",
    )
    book_source = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-28.md"
    source_book = book_source.read_text()
    if "## 执行规则" not in source_book:
        raise SystemExit("candidate-28 runbook is missing execution section")
    execution = "## 执行规则" + source_book.split("## 执行规则", 1)[1]
    execution = execution.replace("candidate-28", "candidate-29")
    execution = execution.replace("candidate-02 至 candidate-27 均已作废", "candidate-02 至 candidate-28 均已作废")
    execution = execution.replace(SOURCE_SHA, sha(archive_bytes)).replace(SOURCE_UNIT_SHA, sha(unit))
    book = f"""# 北极星受控试运行部署命令清单（candidate-29）

日期：2026-10-22。用途：由维护者仅切换现有测试机的 Northstar shell，以核验 T06/T07 模型资格并按已批准额度做一次受控文本 Run。candidate-29 以不可变 candidate-28 为基底，仅覆盖 `shell/persistent-runner.mjs`，加入安全、稳定的 DSH 控制协议错误诊断；其余资格映射、账号限流（35次/分钟）、Run 并发（每账号4、全局16）、T10 历史产物恢复、router endpoint fail-closed 和 sessionStorage 恢复键门禁均继承自 candidate-28。systemd 继续读取包内 `shell/northstar-limits.conf`，其值覆盖共享环境文件中的旧限额。

candidate-24 已包含 Run 失败收尾诊断，candidate-27 已将 runner shutdown 的 `RUN_INTERRUPTED` 映射为 durable `interrupted` 终态；candidate-28 已落实当前 PT `/v1/models` 返回列表中的模型 ID 对当前 key 赋 `permission=true`，并保留不完整分页的 fail-closed 行为。candidate-29 只在 candidate-28 上更新 runner 控制异常出口，不修改以上资格、Run 或媒体行为。此包不修复目标机 DSH 子进程根因，也不改变媒体收费证据或 T03/T11 验收状态。

此包不是 Phase 1 最终发布，不改变 T06/T07/T03/T11/T10 或其他任务的整体状态。candidate-02 至 candidate-28 均已作废，维护者只执行本版清单。包内的 `supported_endpoint_types` 任务映射、手动路由、AUTO 验证门禁和 T10 修复均继承 candidate-28。本次受控额度继续使用 `?northstarNoChatRetry=1`，只允许一次文本请求、0重试、0工具、180秒；不授权真实图片生成，也不证明目标机 `hello` 根因或 PT 媒体收费次数。analytics 与 attribution 仅为快照，本次不安装或切换。

| 产物 | SHA-256 | 用途 |
|---|---|---|
| [`northstar-controlled-trial-20261022-candidate-29.tar.gz`](../../release-artifacts/northstar-controlled-trial-20261022-candidate-29.tar.gz) | `{sha(archive_bytes)}` | 冻结源快照；本次只部署 shell，analytics/business 不切换 |
| [`northstar-shell-candidate-29.service`](../../release-artifacts/northstar-shell-candidate-29.service) | `{sha(unit)}` | systemd shell unit，指向 candidate-29 发布目录 |

候选沿用不可变 candidate-28 的完整快照，仅将 `shell/persistent-runner.mjs` 替换为当前经过审查的安全错误出口实现；其余322个文件保持基底内容。包使用 USTAR，含20个 SQL migration，不含 `.env`、密钥、`node_modules` 或 Git 元数据。部署仍沿用既有 r5 测试机和维护者逐步执行流程，目标 Linux 的实际部署与 health 必须由维护者验证。

{execution}"""
    if check_only:
        expected = ((ARCHIVE, archive_bytes), (UNIT, unit), (RUNBOOK, book.encode("utf-8")))
        for path, data in expected:
            if not path.exists() or path.read_bytes() != data:
                raise SystemExit(f"candidate-29 output differs from reproducible build: {path}")
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
    print("reproducibility: PASS" if check_only else "build: written")


if __name__ == "__main__":
    main()
