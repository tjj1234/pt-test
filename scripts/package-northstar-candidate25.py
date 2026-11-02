#!/usr/bin/env python3
"""Freeze key-only preheader submission recovery over immutable candidate-24."""
import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-24.tar.gz"
SOURCE_SHA = "246706043e98a6b15fc0ac79db4515fada50f74d34fb67d525c28df2fb6d0d9e"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-24.service"
SOURCE_UNIT_SHA = "d458a1158d9f7c461298af563b3aac20a29c6c25d4d2eee30923bbcba37369d3"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-25.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-25.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-25.md"
OVERLAYS = ("shell/public/app.js", "shell/server.cjs", "shell/tasks/store.cjs")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    original, source_unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(source_unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-24 inputs differ from their frozen checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        raise SystemExit("candidate-25 output already exists; refusing to overwrite")
    overlays = {name: (ROOT / name).read_bytes() for name in OVERLAYS}
    app, server, store = (overlays[name] for name in OVERLAYS)
    for marker in (b"ptPendingChatSubmissions.v1", b"resumePendingSubmissions()", b"conversationId === item.conversationId"):
        if marker not in app:
            raise SystemExit(f"UI recovery marker missing: {marker.decode()}")
    if b"/api/runs/by-idempotency-key" not in server:
        raise SystemExit("server idempotency-key recovery route missing")
    if b"getRunByIdempotencyKey" not in store:
        raise SystemExit("owner-scoped idempotency-key store lookup missing")

    raw = gzip.decompress(original)
    out_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        members = source.getmembers()
        names = {member.name for member in members}
        if len(names) != len(members) or not all(name in names for name in OVERLAYS):
            raise SystemExit("candidate-24 archive member set is invalid")
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

    unit = source_unit.replace(b"candidate-24", b"candidate-25")
    unit = unit.replace(b"Description=Northstar Shell (Controlled Trial Candidate 24)", b"Description=Northstar Shell (Controlled Trial Candidate 25)")
    UNIT.write_bytes(unit)
    old_book = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-24.md"
    book = old_book.read_text()
    book = book.replace("candidate-24", "candidate-25")
    book = book.replace("candidate-02 至 candidate-23 均已作废", "candidate-02 至 candidate-24 均已作废")
    book = book.replace(SOURCE_SHA, sha(compressed.getvalue())).replace(SOURCE_UNIT_SHA, sha(unit))
    intro = (
        "candidate-25 在不可变 candidate-24 上只更新 `shell/public/app.js`、`shell/server.cjs`、"
        "`shell/tasks/store.cjs`：响应头丢失或网络结果不明时只在 sessionStorage 保留会话 ID 与幂等键，"
        "重载后以该键做 owner-scoped GET 查询，找到同一会话 Run 后通过现有事件 GET 恢复；不保存 prompt/附件，"
        "不新增 POST 重试。查找未确认时保持该会话锁定。此改动不改变媒体调用/收费与 T03/T11 整体验收状态。\n\n"
    )
    book = book.replace("此包不是 Phase 1 最终发布", intro + "此包不是 Phase 1 最终发布", 1)
    book = book.replace("candidate-25 在 candidate-23 基础上承接既有改动", "candidate-25 在 candidate-24 基础上只覆盖上述三份 UI/API/store 源文件")
    book = book.replace(
        "如果收到 header 前网络错误，服务端可能已接单；结果必须标为 `unknown/manual_check`，停止且绝不重发。由维护者按该用户/对话/时间核对唯一 Run 和 provider 调用记录后，只回传脱敏的状态/计数；没有足够记录时继续标为未知，不猜成功或失败。",
        "如果收到 header 前网络错误，浏览器将自动使用同一幂等键执行 GET 查找并恢复同一 Run；这不是新的聊天 POST。查找仍未确认时界面保持锁定，刷新后继续 GET 核对，严禁换新键重发。由维护者按该用户/对话/时间核对唯一 Run 和 provider 调用记录后，只回传脱敏状态/计数；若目标环境部署的版本不含此恢复行为，则按 unknown/manual_check 停止，不得重发。"
    )
    RUNBOOK.write_text(book)
    print(f"archive sha256: {sha(compressed.getvalue())}")
    print(f"service sha256: {sha(unit)}")
    print(f"archive members: {len(members)}")


if __name__ == "__main__":
    main()
