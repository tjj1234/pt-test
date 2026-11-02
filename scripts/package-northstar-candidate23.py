#!/usr/bin/env python3
"""Freeze the current Northstar improvements over reviewed candidate-22."""
import gzip
import hashlib
import io
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-22.tar.gz"
SOURCE_SHA = "0921e28b73727dec8ba9503d0bb1bd035c0e43e904df16f60f68acfa694be0f3"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-22.service"
SOURCE_UNIT_SHA = "5e22ae8e8f0b98f032373c49362bcafcacc37c20fdf3a8686cc1cf2a06490862"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-23.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-23.service"
RUNBOOK = ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-23.md"
OVERLAYS = (
    "shell/server.cjs",
    "shell/runtime/session-scheduler.cjs",
    "shell/public/app.js",
    "shell/models/task-router.cjs",
)
LIMITS = "shell/northstar-limits.conf"
PREVIOUS_ARCHIVE_SHA = "54dc2f76c8d25a25a3cd2244891e8d7f2cf8eb83968bd4542d25167a7bba6368"
PREVIOUS_UNIT_SHA = "12062c15b0195efb19a3116bf9da4006bf66db78f80bacae2e8dd17bf9eec072"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    original, source_unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(original) != SOURCE_SHA or sha(source_unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-22 inputs differ from their reviewed checksums")
    if ARCHIVE.exists() or UNIT.exists() or RUNBOOK.exists():
        if not ARCHIVE.exists() or not UNIT.exists() or not RUNBOOK.exists():
            raise SystemExit("candidate-23 output is incomplete; refusing to overwrite")
        if sha(ARCHIVE.read_bytes()) != PREVIOUS_ARCHIVE_SHA or sha(UNIT.read_bytes()) != PREVIOUS_UNIT_SHA:
            raise SystemExit("candidate-23 output differs from the known unpublished package")
    contents = {name: (ROOT / name).read_bytes() for name in (*OVERLAYS, LIMITS)}
    server = contents["shell/server.cjs"]
    scheduler = contents["shell/runtime/session-scheduler.cjs"]
    if (b"chatLimiter.allow(me.user.id)" not in server
            or b"PT_RATE_CHAT_PER_MIN || 35" not in server
            or b"PT_RUNS_PER_USER || 4" not in server
            or b"PT_RUNS_GLOBAL || 16" not in server):
        raise SystemExit("server does not bind account-based 35/min and widened run limits")
    if b"perUserLimit = 4, globalLimit = 16" not in scheduler:
        raise SystemExit("scheduler defaults do not match 4 per account / 16 global")
    router = contents["shell/models/task-router.cjs"]
    if b"endpointCompatible !== true" not in router:
        raise SystemExit("task router does not fail closed on missing endpoint compatibility")
    if contents[LIMITS] != b"# Candidate-controlled chat and durable Run concurrency limits.\nPT_RATE_CHAT_PER_MIN=35\nPT_RUNS_PER_USER=4\nPT_RUNS_GLOBAL=16\n":
        raise SystemExit("candidate limit configuration differs from the reviewed values")

    raw_archive = gzip.decompress(original)
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw_archive), mode="r:") as source:
        members = source.getmembers()
        names = {member.name for member in members}
        if LIMITS in names:
            raise SystemExit("candidate-22 unexpectedly already contains the limits file")
        with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
            for member in members:
                data = None
                if member.isfile():
                    if member.name in contents:
                        data = contents[member.name]
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
            info = tarfile.TarInfo(LIMITS)
            info.type, info.mode, info.uid, info.gid = tarfile.REGTYPE, 0o644, 0, 0
            info.uname = info.gname = ""
            info.mtime = 0
            info.size = len(contents[LIMITS])
            output.addfile(info, io.BytesIO(contents[LIMITS]))

    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as zipped:
        zipped.write(tar_buffer.getvalue())
    ARCHIVE.write_bytes(compressed.getvalue())

    unit = source_unit.replace(b"candidate-22", b"candidate-23")
    unit = unit.replace(b"Description=Northstar Shell (Controlled Trial Candidate 17)", b"Description=Northstar Shell (Controlled Trial Candidate 23)")
    base_env = b"EnvironmentFile=/etc/northstar/northstar.env"
    if unit.count(base_env) != 1:
        raise SystemExit("candidate-22 unit EnvironmentFile layout changed")
    unit = unit.replace(base_env, base_env + b"\nEnvironmentFile=/opt/northstar/releases/controlled-trial-20261022-candidate-23/shell/northstar-limits.conf")
    UNIT.write_bytes(unit)

    archive_sha, unit_sha = sha(compressed.getvalue()), sha(unit)
    book = (ROOT / "docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-22.md").read_text()
    book = book.replace("candidate-22", "candidate-23")
    book = book.replace("candidate-02 至 candidate-21 均已作废", "candidate-02 至 candidate-22 均已作废")
    book = book.replace(SOURCE_SHA, archive_sha).replace(SOURCE_UNIT_SHA, unit_sha)
    book = book.replace(
        "candidate-23 更新 `shell/auth.cjs`，使 `initAuth` migration 或默认管理员初始化失败时关闭其打开的数据库句柄并保留原始错误，之后重封 USTAR。",
        "candidate-22 冻结 `shell/auth.cjs` 初始化错误清理；candidate-23 在其上更新 `shell/server.cjs`、`shell/runtime/session-scheduler.cjs`、`shell/public/app.js`，并新增 `shell/northstar-limits.conf`：聊天限流改按 `me.user.id` 计数且默认35次/分钟，Run并发默认每账号4、全局16，历史对话重开恢复安全产物预览；systemd后加载候选限额文件覆盖共享环境文件旧值。随后重封 USTAR。",
    )
    book = book.replace(
        "并发默认每账号4、全局16，历史对话重开恢复安全产物预览；systemd",
        "并发默认每账号4、全局16，历史对话重开恢复安全产物预览；router 对缺失的 endpoint 兼容证据 fail closed；systemd",
    )
    intro = "candidate-23 在 candidate-22 基础上合入 T10 历史产物重开恢复修复、账号级聊天限流（35次/分钟）、Run 并发放宽（每账号4、全局16），并使 router 在缺少 endpoint 兼容证据时拒绝放行。systemd 额外读取包内 `shell/northstar-limits.conf`，其值覆盖共享环境文件中的旧限额；回滚 unit 时随之恢复原配置。\n\n"
    book = book.replace("日期：2026-10-22。用途：", "日期：2026-10-22。用途：")
    book = book.replace("此包不是 Phase 1 最终发布", intro + "此包不是 Phase 1 最终发布", 1)
    book = book.replace("322个归档成员", "323个归档成员")
    book = book.replace("`SQL_MIGRATION_FILES=20`", "`SQL_MIGRATION_FILES=20`")
    book = book.replace("`APPLEDOUBLE_PATHS=0`。", "`APPLEDOUBLE_PATHS=0`；候选限额文件包含35/分钟、4/账号、16全局配置。", 1)
    book = book.replace(
        "成功条件：两个 SHA-256 与表格逐字一致；解压 gzip 后 `file -` 标为 POSIX tar archive；",
        "成功条件：两个 SHA-256 与表格逐字一致；远端扫描输出 `ARCHIVE_MEMBERS=323`；解压 gzip 后 `file -` 标为 POSIX tar archive；",
        1,
    )
    old_awk = """awk '\n  /^shell\\/db-migrations\\/[0-9][0-9][0-9][^[:space:]]*\\.sql$/ { migrations++ }\n  /(^|\\/)(\\.env($|\\.)|secrets\\/|node_modules\\/|\\.git\\/)/ { forbidden++ }\n  /(^|\\/)\\._/ || /(^|\\/)__MACOSX(\\/|$)/ { apple++ }\n  END { printf \"SQL_MIGRATION_FILES=%d\\nFORBIDDEN_PATHS=%d\\nAPPLEDOUBLE_PATHS=%d\\n\", migrations, forbidden, apple; if(migrations!=20||forbidden!=0||apple!=0) exit 1 }\n' /tmp/northstar-candidate-23-files.txt"""
    new_awk = """awk '\n  { members++ }\n  /^shell\\/db-migrations\\/[0-9][0-9][0-9][^[:space:]]*\\.sql$/ { migrations++ }\n  /(^|\\/)(\\.env($|\\.)|secrets\\/|node_modules\\/|\\.git\\/)/ { forbidden++ }\n  /(^|\\/)\\._/ || /(^|\\/)__MACOSX(\\/|$)/ { apple++ }\n  END { printf \"ARCHIVE_MEMBERS=%d\\nSQL_MIGRATION_FILES=%d\\nFORBIDDEN_PATHS=%d\\nAPPLEDOUBLE_PATHS=%d\\n\", members, migrations, forbidden, apple; if(members!=323||migrations!=20||forbidden!=0||apple!=0) exit 1 }\n' /tmp/northstar-candidate-23-files.txt"""
    if old_awk not in book:
        raise SystemExit("candidate-22 archive scan block changed; update the generator explicitly")
    book = book.replace(old_awk, new_awk, 1)
    extract_command = "sudo chown -R root:root /opt/northstar/releases/controlled-trial-20261022-candidate-23\nsudo stat"
    verify_limits = "sudo chown -R root:root /opt/northstar/releases/controlled-trial-20261022-candidate-23\nsudo grep -Fx 'PT_RATE_CHAT_PER_MIN=35' /opt/northstar/releases/controlled-trial-20261022-candidate-23/shell/northstar-limits.conf\nsudo grep -Fx 'PT_RUNS_PER_USER=4' /opt/northstar/releases/controlled-trial-20261022-candidate-23/shell/northstar-limits.conf\nsudo grep -Fx 'PT_RUNS_GLOBAL=16' /opt/northstar/releases/controlled-trial-20261022-candidate-23/shell/northstar-limits.conf\nsudo stat"
    if extract_command not in book:
        raise SystemExit("candidate-22 runbook extraction block changed; update the generator explicitly")
    book = book.replace(extract_command, verify_limits, 1)
    book = book.replace("EnvironmentFile 指向 `/etc/northstar/northstar.env`", "EnvironmentFile 同时指向 `/etc/northstar/northstar.env` 和候选目录 `shell/northstar-limits.conf`（候选限额后加载并覆盖旧值）")
    RUNBOOK.write_text(book)
    print(f"archive sha256: {archive_sha}")
    print(f"service sha256: {unit_sha}")
    print(f"archive members: {len(members) + 1}")


if __name__ == "__main__":
    main()
