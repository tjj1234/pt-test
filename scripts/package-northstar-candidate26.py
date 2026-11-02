#!/usr/bin/env python3
"""Freeze fail-closed recovery-key storage over immutable candidate-25."""
import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-25.tar.gz"
SOURCE_SHA = "0c6cd34d6bba56c6434768653c0285a10e500caab5a0ddb16b9515cd82a239ad"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-25.service"
SOURCE_UNIT_SHA = "56e469177320a6a87d7be0e2c647305493ed1b20d80f11df257696dea6b94e52"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-26.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-26.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-26.md"
OVERLAY = "shell/public/app.js"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    original, source_unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(source_unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-25 inputs differ from their frozen checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        raise SystemExit("candidate-26 output already exists; refusing to overwrite")
    app = (ROOT / OVERLAY).read_bytes()
    required = (
        b"function rememberPendingSubmission(conversationId, idempotencyKey)",
        b"catch { return false; /* never submit a paid request without its recovery key */ }",
        b"if (!rememberPendingSubmission(targetId, idempotencyKey))",
        "浏览器无法保存请求恢复凭据，这次请求未发送。请恢复会话存储后重试。".encode(),
    )
    if any(marker not in app for marker in required):
        raise SystemExit("fail-closed sessionStorage markers are missing")

    raw = gzip.decompress(original)
    out_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        members = source.getmembers()
        names = {member.name for member in members}
        if len(names) != len(members) or OVERLAY not in names:
            raise SystemExit("candidate-25 archive member set is invalid")
        with tarfile.open(fileobj=out_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
            for member in members:
                data = None
                if member.isfile():
                    if member.name == OVERLAY:
                        data = app
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

    unit = source_unit.replace(b"candidate-25", b"candidate-26")
    unit = unit.replace(b"Description=Northstar Shell (Controlled Trial Candidate 25)", b"Description=Northstar Shell (Controlled Trial Candidate 26)")
    UNIT.write_bytes(unit)
    old_book = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-25.md"
    book = old_book.read_text().replace("candidate-25", "candidate-26")
    book = book.replace("candidate-02 至 candidate-24 均已作废", "candidate-02 至 candidate-25 均已作废")
    book = book.replace(
        "candidate-26 在不可变 candidate-24 上只更新 `shell/public/app.js`、`shell/server.cjs`、"
        "`shell/tasks/store.cjs`：响应头丢失或网络结果不明时只在 sessionStorage 保留会话 ID 与幂等键，"
        "重载后以该键做 owner-scoped GET 查询，找到同一会话 Run 后通过现有事件 GET 恢复；不保存 prompt/附件，"
        "不新增 POST 重试。查找未确认时保持该会话锁定。此改动不改变媒体调用/收费与 T03/T11 整体验收状态。",
        "candidate-26 在不可变 candidate-25 上仅更新 `shell/public/app.js`：新请求必须先将会话 ID 与幂等键写入 sessionStorage；"
        "写入失败时明确提示请求未发送，且不发 chat POST；写入成功后，POST结果不明仍按原幂等键 GET恢复。"
        "此改动不改变媒体调用/收费及 T06/T07/T11 整体验收状态。",
    )
    book = book.replace(
        "candidate-26 只再覆盖 `shell/public/app.js`、`shell/server.cjs`、`shell/tasks/store.cjs`，加入页面重载后的幂等键 GET 恢复，再封 USTAR。",
        "candidate-26 只再覆盖 `shell/public/app.js`，在不可变 candidate-25 的幂等键恢复上增加sessionStorage写失败时的fail-closed门禁，再封USTAR。",
    )
    book = book.replace(SOURCE_SHA, sha(compressed.getvalue())).replace(SOURCE_UNIT_SHA, sha(unit))
    intro = (
        "candidate-26 是 AC04 本地 fail-closed 修复候选：若浏览器不能在 sessionStorage 持久记录恢复键，"
        "界面明确说明请求未发送并停止，不会创建Run或发出聊天POST。Candidate-25 保持冻结且不覆盖；"
        "本版未部署，不代表 T03/AC04 整包通过，也不改变唯一一次文本试运行的授权边界。\n\n"
    )
    book = book.replace("此包不是 Phase 1 最终发布", intro + "此包不是 Phase 1 最终发布", 1)
    RUNBOOK.write_text(book)
    print(f"archive sha256: {sha(compressed.getvalue())}")
    print(f"service sha256: {sha(unit)}")
    print(f"archive members: {len(members)}")


if __name__ == "__main__":
    main()
