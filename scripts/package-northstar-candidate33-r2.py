#!/usr/bin/env python3
"""Build a revisioned candidate-33 diagnostic draft without replacing prior evidence."""
import importlib.util
import hashlib
import io
import json
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE_SCRIPT = ROOT / "scripts/package-northstar-candidate33.py"
spec = importlib.util.spec_from_file_location("candidate33_base", BASE_SCRIPT)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

base.ARCHIVE = base.ARTIFACTS / "northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz"
base.UNIT = base.ARTIFACTS / "northstar-shell-candidate-33-draft-r2.service"
base.NOTE = ROOT / "docs/refactor/evidence/candidate33-model-catalog-diagnostics-draft-r2-20261023.md"
NPMRC_SHA256 = "a093bb2fed59d699b7f9a62a5203cc196054c624e9c39c6d908c9e7db5dd2464"


def require_npmrc_binding(candidate_archive):
    """Bind npm configuration across the source, closure manifest, base and output."""
    source_npmrc = (ROOT / "shell/.npmrc").read_bytes()
    source_sha = hashlib.sha256(source_npmrc).hexdigest()
    if source_sha != NPMRC_SHA256:
        raise SystemExit(f"T16 .npmrc input differs from its frozen checksum: {source_sha}")

    manifest = json.loads(base.MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("evidence", {}).get("npmrcSha256") != NPMRC_SHA256:
        raise SystemExit("T16 manifest evidence.npmrcSha256 differs from the frozen .npmrc checksum")

    for label, archive_bytes in (("candidate-32 base", base.SOURCE.read_bytes()), ("candidate-33 r2 output", candidate_archive)):
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
            try:
                member = archive.extractfile("shell/.npmrc")
            except KeyError:
                member = None
            if member is None:
                raise SystemExit(f"shell/.npmrc is missing from {label} archive")
            bundled_npmrc = member.read()
        bundled_sha = hashlib.sha256(bundled_npmrc).hexdigest()
        if bundled_sha != NPMRC_SHA256 or bundled_npmrc != source_npmrc:
            raise SystemExit(f"shell/.npmrc in {label} archive differs from the frozen source input")


def main():
    if sys.argv[1:] not in ([], ["--write"], ["--check"]):
        raise SystemExit("usage: package-northstar-candidate33-r2.py [--write|--check]")
    check_only = sys.argv[1:] == ["--check"]
    archive, unit, note, members = base.build()
    require_npmrc_binding(archive)
    old_unit_sha = base.sha(unit).encode("ascii")
    old_path = b"/opt/northstar/releases/controlled-trial-20261022-candidate-33-draft"
    new_path = b"/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2"
    if old_path not in unit:
        raise SystemExit("generated service unit does not contain the expected candidate-33 draft path")
    unit = unit.replace(old_path, new_path)
    new_unit_sha = base.sha(unit).encode("ascii")
    note = note.replace(
        b"It does not identify why the live candidate-32 instance has no successful user-scoped catalog snapshot; the current live `/api/models` syncError or safe service logs are still needed.",
        b"Candidate-32 suppresses the caught exception, so the reported `Model catalog unavailable` identifies the internal-error fallback but cannot reveal the failing operation. This revision records only a bounded error class/code in `/api/models` and logs; raw exception text, filesystem paths, and credentials remain hidden.",
    )
    note = note.replace(old_unit_sha, new_unit_sha)
    note = note.replace(
        b"This draft still needs a separate independent package/runbook audit and target-specific evidence before any deployment review.",
        b"This r2 draft corrects the service working-directory path to match its versioned release directory. It still needs a separate independent package/runbook audit and target-specific evidence before any deployment review.",
    )
    outputs = ((base.ARCHIVE, archive), (base.UNIT, unit), (base.NOTE, note))
    if check_only:
        for path, data in outputs:
            if not path.exists() or path.read_bytes() != data:
                raise SystemExit(f"candidate-33 r2 output differs from reproducible build: {path}")
    else:
        if any(path.exists() for path, _ in outputs):
            raise SystemExit("candidate-33 r2 output already exists; refusing to overwrite")
        for path, data in outputs:
            path.write_bytes(data)
    print(f"draft archive sha256: {base.sha(archive)}")
    print(f"draft service sha256: {base.sha(unit)}")
    print(f"archive members: {members}")
    print("revision: r2; includes safe internal-error classification and corrected unit path")
    print("reproducibility: PASS" if check_only else "draft: written; NOT FOR DEPLOYMENT")


if __name__ == "__main__":
    main()
