#!/usr/bin/env python3
"""Freeze durable RUN_INTERRUPTED terminal-state mapping over candidate-26."""
import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-26.tar.gz"
SOURCE_SHA = "aeeeec81d1afe686e71d63f67a0887523fe7c39d2c5753ee1cb922667d54f419"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-26.service"
SOURCE_UNIT_SHA = "9940ea1559b2e4ba28911df2ce36f28ebf66a4e874665fc61dd6059f1c1bb4bb"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-27.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-27.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-27.md"
OVERLAY = "shell/tasks/execution.cjs"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    original, source_unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(source_unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-26 inputs differ from their frozen checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        raise SystemExit("candidate-27 output already exists; refusing to overwrite")
    implementation = (ROOT / OVERLAY).read_bytes()
    required = (
        b"const interrupted = outcome?.interrupted === true || source.code === \"RUN_INTERRUPTED\";",
        b"interrupted ? \"interrupted\" : outcome?.ok === false ? \"failed\" : \"completed\"",
    )
    if any(marker not in implementation for marker in required):
        raise SystemExit("durable interrupted-state mapping is missing")

    raw = gzip.decompress(original)
    out_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        members = source.getmembers()
        names = {member.name for member in members}
        if len(names) != len(members) or OVERLAY not in names:
            raise SystemExit("candidate-26 archive member set is invalid")
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

    unit = source_unit.replace(b"candidate-26", b"candidate-27")
    unit = unit.replace(b"Description=Northstar Shell (Controlled Trial Candidate 26)", b"Description=Northstar Shell (Controlled Trial Candidate 27)")
    UNIT.write_bytes(unit)
    old_book = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-26.md"
    book = old_book.read_text().replace("candidate-26", "candidate-27")
    book = book.replace("candidate-02 至 candidate-25 均已作废", "candidate-02 至 candidate-26 均已作废")
    book = book.replace(
        "file - < /tmp/northstar-release-candidate-27.tar.gz | grep -F 'POSIX tar archive'",
        "gzip -cd /tmp/northstar-release-candidate-27.tar.gz | file - | grep -F 'POSIX tar archive'",
    )
    book = book.replace(
        "candidate-27 是 AC04 本地 fail-closed 修复候选：若浏览器不能在 sessionStorage 持久记录恢复键，"
        "界面明确说明请求未发送并停止，不会创建Run或发出聊天POST。Candidate-25 保持冻结且不覆盖；"
        "本版未部署，不代表 T03/AC04 整包通过，也不改变唯一一次文本试运行的授权边界。",
        "candidate-27 在 candidate-26 基础上仅更新 shell/tasks/execution.cjs：DSH runner 以 RUN_INTERRUPTED 结束时，"
        "durable Run 状态同步落为 interrupted，终态事件保留错误码。此修复不扩大受控文本试运行范围；"
        "候选未部署，也不代表 T03/AC04 整包通过。",
    )
    book = book.replace(
        "candidate-27 在不可变 candidate-25 上仅更新 `shell/public/app.js`：新请求必须先将会话 ID 与幂等键写入 sessionStorage；"
        "写入失败时明确提示请求未发送，且不发 chat POST；写入成功后，POST结果不明仍按原幂等键 GET恢复。"
        "此改动不改变媒体调用/收费及 T06/T07/T11 整体验收状态。",
        "candidate-26 已包含上述 sessionStorage 门禁；candidate-27 在其不可变归档上仅覆盖 `shell/tasks/execution.cjs`，"
        "使 runner shutdown 的 RUN_INTERRUPTED 结果在 durable Run 与 done 事件中保持 interrupted 语义和诊断码。",
    )
    book = book.replace(
        "candidate-27 只再覆盖 `shell/public/app.js`，在不可变 candidate-25 的幂等键恢复上增加sessionStorage写失败时的fail-closed门禁，再封USTAR。",
        "candidate-27 只再覆盖 `shell/tasks/execution.cjs`，将 RUN_INTERRUPTED 映射为 durable interrupted 终态，再封 USTAR。",
    )
    book = book.replace(SOURCE_SHA, sha(compressed.getvalue())).replace(SOURCE_UNIT_SHA, sha(unit))
    RUNBOOK.write_text(book)
    print(f"archive sha256: {sha(compressed.getvalue())}")
    print(f"service sha256: {sha(unit)}")
    print(f"archive members: {len(members)}")


if __name__ == "__main__":
    main()
