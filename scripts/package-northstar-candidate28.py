#!/usr/bin/env python3
"""Freeze per-ID PT listing permission semantics over candidate-27."""
import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-27.tar.gz"
SOURCE_SHA = "91cf2af7a033c89d108b703ca9c39ee085d75f8db988ad44b3b6c808ecca367d"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-27.service"
SOURCE_UNIT_SHA = "ea50acb72e28910957273a108cf9c21f5c2e00331933f655615e7ed76769809a"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-28.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-28.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-28.md"
OVERLAY = "shell/model-catalog.cjs"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    original, source_unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(source_unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-27 inputs differ from their frozen checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        raise SystemExit("candidate-28 output already exists; refusing to overwrite")
    implementation = (ROOT / OVERLAY).read_bytes()
    required = (
        b"const listedIds = new Set(fetched.records.map((record) => modelIdOf(record)).filter(Boolean));",
        b"listedIds.has(id) ? true : null",
        b"complete: fetched.complete, records: fetched.records",
    )
    if any(marker not in implementation for marker in required):
        raise SystemExit("per-ID permission and incomplete-snapshot semantics are missing")

    raw = gzip.decompress(original)
    out_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        members = source.getmembers()
        names = {member.name for member in members}
        if len(names) != len(members) or OVERLAY not in names:
            raise SystemExit("candidate-27 archive member set is invalid")
        with tarfile.open(fileobj=out_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
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
        zipped.write(out_buffer.getvalue())
    ARCHIVE.write_bytes(compressed.getvalue())

    unit = source_unit.replace(b"candidate-27", b"candidate-28")
    unit = unit.replace(b"Description=Northstar Shell (Controlled Trial Candidate 27)", b"Description=Northstar Shell (Controlled Trial Candidate 28)")
    UNIT.write_bytes(unit)
    old_book = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-27.md"
    book = old_book.read_text().replace("candidate-27", "candidate-28")
    book = book.replace("candidate-02 至 candidate-26 均已作废", "candidate-02 至 candidate-27 均已作废")
    book = book.replace(
        "candidate-28 从 candidate-26 冻结包仅更新 durable Run 终态映射",
        "candidate-28 从 candidate-27 冻结包仅更新 PT 模型目录权限同步",
    )
    book = book.replace(
        "candidate-28 在 candidate-26 基础上仅更新 shell/tasks/execution.cjs：DSH runner 以 RUN_INTERRUPTED 结束时，"
        "durable Run 状态同步落为 interrupted，终态事件保留错误码。此修复不扩大受控文本试运行范围；"
        "候选未部署，也不代表 T03/AC04 整包通过。",
        "candidate-27 已将 RUN_INTERRUPTED 映射为 durable interrupted 终态；candidate-28 在其不可变包上仅覆盖 shell/model-catalog.cjs，"
        "落实当前 /v1/models 响应中列出的模型 ID 对当前 key 授予 permission=true。未列出的缓存模型 permission 为 null 且不可路由；"
        "分页/完整性未确认时不把省略模型标记 removed。该改动不改变 T06/T07 整体验收状态。",
    )
    book = book.replace(
        "candidate-28 仅覆盖 `shell/tasks/execution.cjs`，将 RUN_INTERRUPTED 映射为 durable interrupted 终态，再封 USTAR。",
        "candidate-28 仅覆盖 `shell/model-catalog.cjs`，按本次响应中的模型 ID 授予权限，并将权限与列表完整性/移除语义分开，再封 USTAR。",
    )
    book = book.replace(
        "候选源码仅 `shell/tasks/execution.cjs` 与 candidate-26 不同",
        "候选源码仅 `shell/model-catalog.cjs` 与 candidate-27 不同",
    )
    book = book.replace(
        "candidate-26 仅覆盖 `shell/public/app.js`，增加 sessionStorage 恢复键保存失败时不发POST的门禁；"
        "candidate-28 仅覆盖 `shell/tasks/execution.cjs`，将 RUN_INTERRUPTED 映射为 durable interrupted 终态，再封USTAR。",
        "candidate-26 仅覆盖 `shell/public/app.js`，增加 sessionStorage 恢复键保存失败时不发POST的门禁；"
        "candidate-27 仅覆盖 `shell/tasks/execution.cjs`，将 RUN_INTERRUPTED 映射为 durable interrupted 终态；"
        "candidate-28 再仅覆盖 `shell/model-catalog.cjs`，落实当前 PT 响应逐模型授权与不完整列表不删除目录记录。",
    )
    book = book.replace(SOURCE_SHA, sha(compressed.getvalue())).replace(SOURCE_UNIT_SHA, sha(unit))
    RUNBOOK.write_text(book)
    print(f"archive sha256: {sha(compressed.getvalue())}")
    print(f"service sha256: {sha(unit)}")
    print(f"archive members: {len(members)}")


if __name__ == "__main__":
    main()
