#!/usr/bin/env python3
"""Build a local, non-deployable candidate-33 draft from frozen candidate-32."""
import gzip
import hashlib
import io
import json
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
SOURCE = ARTIFACTS / "northstar-controlled-trial-20261022-candidate-32.tar.gz"
SOURCE_SHA = "c10fccd5fda1a8a5f3b0a8fd2bb16b4517c96a941c988eca0e7dc3704972e7d3"
SOURCE_UNIT = ARTIFACTS / "northstar-shell-candidate-32.service"
SOURCE_UNIT_SHA = "4c26ab4acf9347556e0e3bdedea822090862331b8f31a1d5ef0c25802a996bc5"
ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261023-candidate-33-draft.tar.gz"
UNIT = ARTIFACTS / "northstar-shell-candidate-33-draft.service"
NOTE = ROOT / "docs/refactor/evidence/candidate33-model-catalog-diagnostics-draft-20261023.md"
MANIFEST = ROOT / "docs/refactor/evidence/T16-dependency-closure-linux-amd64-node22.23.4.json"
LOCK_SHA = "795b97b08935f4320c8d2567ff101d051b2e643c316093513f2031c7ffc9f912"
PACKAGE_SHA = "db0ff4eef9176f5de58ea1c4bf406baf6cdcde367128f82f072e8d053f7ed518"
MANIFEST_SHA = "bec48d7e0eafc6662933f7f1954317c3f68d0c1df7e7d3ad4069d225e5653dbe"
NPMRC_SHA = "a093bb2fed59d699b7f9a62a5203cc196054c624e9c39c6d908c9e7db5dd2464"
OVERLAYS = (
    "shell/server.cjs",
    "shell/model-catalog.cjs",
    "shell/public/app.js",
    "shell/package.json",
    "shell/package-lock.json",
)
ADDITIONS = {
    "shell/northstar-dependency-closure.cjs": ROOT / "scripts/northstar-dependency-closure.cjs",
    "shell/dependency-closure-manifest.json": MANIFEST,
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def archive_member_bytes(archive_bytes, member_name):
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(archive_bytes)), mode="r:") as archive:
        member = archive.getmember(member_name)
        stream = archive.extractfile(member)
        if stream is None:
            raise SystemExit(f"archive member is not a regular file: {member_name}")
        return stream.read()


def audit_archive(archive_bytes, replacements, additions):
    base = gzip.decompress(SOURCE.read_bytes())
    release = gzip.decompress(archive_bytes)
    changed = set()
    with tarfile.open(fileobj=io.BytesIO(base), mode="r:") as source, tarfile.open(fileobj=io.BytesIO(release), mode="r:") as candidate:
        source_members = {member.name: member for member in source.getmembers()}
        candidate_list = candidate.getmembers()
        candidate_members = {member.name: member for member in candidate_list}
        if len(source_members) != len(source.getmembers()) or len(candidate_members) != len(candidate_list):
            raise SystemExit("candidate archive contains duplicate member paths")
        if set(candidate_members) != set(source_members) | set(additions):
            raise SystemExit("candidate archive member set differs from the explicit overlay/addition set")
        for name, member in candidate_members.items():
            if name.startswith("/") or "\\" in name or ".." in pathlib.PurePosixPath(name).parts or "/._" in name or name.rsplit("/", 1)[-1].startswith("._"):
                raise SystemExit(f"candidate archive contains a prohibited path: {name}")
            if member.pax_headers or not (member.isdir() or member.isfile()):
                raise SystemExit(f"candidate archive contains a non-USTAR or unsupported entry: {name}")
            if name in additions:
                changed.add(name)
                continue
            source_member = source_members[name]
            source_file = source.extractfile(source_member) if source_member.isfile() else None
            candidate_file = candidate.extractfile(member) if member.isfile() else None
            old_bytes = source_file.read() if source_file else None
            new_bytes = candidate_file.read() if candidate_file else None
            if old_bytes != new_bytes:
                changed.add(name)
                if name not in replacements:
                    raise SystemExit(f"candidate archive has an unapproved changed member: {name}")
        if changed != set(replacements) | set(additions):
            raise SystemExit("candidate archive is missing an expected source overlay")


def build():
    source_bytes, source_unit = SOURCE.read_bytes(), SOURCE_UNIT.read_bytes()
    if sha(source_bytes) != SOURCE_SHA or sha(source_unit) != SOURCE_UNIT_SHA:
        raise SystemExit("candidate-32 inputs differ from their frozen checksums")
    package = (ROOT / "shell/package.json").read_bytes()
    lock = (ROOT / "shell/package-lock.json").read_bytes()
    npmrc = (ROOT / "shell/.npmrc").read_bytes()
    manifest = MANIFEST.read_bytes()
    if sha(package) != PACKAGE_SHA or sha(lock) != LOCK_SHA or sha(manifest) != MANIFEST_SHA:
        raise SystemExit("T16 package/lock/manifest input differs from its reviewed checksum")
    if sha(npmrc) != NPMRC_SHA:
        raise SystemExit("T16 .npmrc input differs from its reviewed checksum")
    manifest_data = json.loads(manifest)
    evidence = manifest_data.get("evidence", {})
    if (
        evidence.get("packageJsonSha256") != PACKAGE_SHA
        or evidence.get("packageLockSha256") != LOCK_SHA
        or evidence.get("npmrcSha256") != NPMRC_SHA
    ):
        raise SystemExit("T16 manifest is not bound to package.json, package-lock.json, and .npmrc")
    if archive_member_bytes(source_bytes, "shell/.npmrc") != npmrc:
        raise SystemExit("frozen candidate-32 shell/.npmrc differs from the reviewed workspace input")

    replacements = {name: (ROOT / name).read_bytes() for name in OVERLAYS}
    additions = {name: source.read_bytes() for name, source in ADDITIONS.items()}
    raw = gzip.decompress(source_bytes)
    output_buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as source:
        members = source.getmembers()
        original_names = {member.name for member in members}
        if len(original_names) != len(members) or not set(OVERLAYS).issubset(original_names):
            raise SystemExit("candidate-32 archive member set is invalid")
        if original_names.intersection(additions):
            raise SystemExit("candidate-32 already contains a candidate-33 addition")
        with tarfile.open(fileobj=output_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
            for member in members:
                data = None
                if member.isfile():
                    if member.name in replacements:
                        data = replacements[member.name]
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
            for name, data in additions.items():
                info = tarfile.TarInfo(name)
                info.type = tarfile.REGTYPE
                info.mode, info.uid, info.gid, info.mtime = 0o644, 0, 0, 0
                info.uname = info.gname = ""
                info.size = len(data)
                output.addfile(info, io.BytesIO(data))

    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as zipped:
        zipped.write(output_buffer.getvalue())
    archive = compressed.getvalue()
    audit_archive(archive, replacements, additions)
    if archive_member_bytes(archive, "shell/.npmrc") != npmrc:
        raise SystemExit("generated candidate shell/.npmrc differs from the reviewed T16 input")
    unit = source_unit.replace(b"candidate-32", b"candidate-33-draft")
    unit = unit.replace(
        b"Description=Northstar Shell (Controlled Trial Candidate 32)",
        b"Description=Northstar Shell (DRAFT ONLY - NOT FOR DEPLOYMENT - Candidate 33)",
    )
    note = f"""# candidate-33 draft: catalog diagnostics and T16 closure binding

**DRAFT ONLY — NOT AUTHORIZED FOR DEPLOYMENT.** Candidate-32 is already deployed; this local draft does not authorize a replacement or model request.

Base archive: candidate-32 SHA-256 `{SOURCE_SHA}`. Candidate-33 draft archive SHA-256 `{sha(archive)}`; service SHA-256 `{sha(unit)}`. The archive is a deterministic USTAR overlay of the frozen base.

Exact source overlays: {", ".join(f'`{name}`' for name in OVERLAYS)}. Exact additions: `shell/northstar-dependency-closure.cjs` and `shell/dependency-closure-manifest.json`. The T16 manifest binds package.json SHA-256 `{PACKAGE_SHA}` and package-lock SHA-256 `{LOCK_SHA}`; manifest SHA-256 `{MANIFEST_SHA}`. Target gate is Linux/amd64 and Node.js >=22.19.0.

The diagnostic changes keep model routing fail-closed while exposing a bounded catalog state/error code/upstream HTTP status, separating missing credentials from decrypt failure, network/timeout/response errors, and cache write failure. The UI reports the detected category and stops telling users to switch to AUTO when the catalog itself is unknown. The archive also carries the previously reviewed idempotent T11 transient-write retry.

This draft still needs a separate independent package/runbook audit and target-specific evidence before any deployment review. It does not identify why the live candidate-32 instance has no successful user-scoped catalog snapshot; the current live `/api/models` syncError or safe service logs are still needed. No provider request, deployment, or production mutation was performed.
"""
    return archive, unit, note.encode("utf-8"), len(members) + len(additions)


def main():
    if sys.argv[1:] not in ([], ["--write"], ["--check"]):
        raise SystemExit("usage: package-northstar-candidate33.py [--write|--check]")
    check_only = sys.argv[1:] == ["--check"]
    archive, unit, note, members = build()
    outputs = ((ARCHIVE, archive), (UNIT, unit), (NOTE, note))
    if check_only:
        for path, data in outputs:
            if not path.exists() or path.read_bytes() != data:
                raise SystemExit(f"candidate-33 draft output differs from reproducible build: {path}")
    else:
        if any(path.exists() for path, _ in outputs):
            raise SystemExit("candidate-33 draft output already exists; refusing to overwrite")
        for path, data in outputs:
            path.write_bytes(data)
    print(f"draft archive sha256: {sha(archive)}")
    print(f"draft service sha256: {sha(unit)}")
    print(f"archive members: {members}")
    print(f"overlays: {len(OVERLAYS)}; additions: {len(ADDITIONS)}")
    print("reproducibility: PASS" if check_only else "draft: written; NOT FOR DEPLOYMENT")


if __name__ == "__main__":
    main()
