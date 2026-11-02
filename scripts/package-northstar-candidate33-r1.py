#!/usr/bin/env python3
"""Build a revisioned candidate-33 diagnostic draft without replacing prior evidence."""
import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE_SCRIPT = ROOT / "scripts/package-northstar-candidate33.py"
spec = importlib.util.spec_from_file_location("candidate33_base", BASE_SCRIPT)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

base.ARCHIVE = base.ARTIFACTS / "northstar-controlled-trial-20261023-candidate-33-draft-r1.tar.gz"
base.UNIT = base.ARTIFACTS / "northstar-shell-candidate-33-draft-r1.service"
base.NOTE = ROOT / "docs/refactor/evidence/candidate33-model-catalog-diagnostics-draft-r1-20261023.md"


def main():
    if sys.argv[1:] not in ([], ["--write"], ["--check"]):
        raise SystemExit("usage: package-northstar-candidate33-r1.py [--write|--check]")
    check_only = sys.argv[1:] == ["--check"]
    archive, unit, note, members = base.build()
    note = note.replace(
        b"It does not identify why the live candidate-32 instance has no successful user-scoped catalog snapshot; the current live `/api/models` syncError or safe service logs are still needed.",
        b"Candidate-32 suppresses the caught exception, so the reported `Model catalog unavailable` identifies the internal-error fallback but cannot reveal the failing operation. This revision records only a bounded error class/code in `/api/models` and logs; raw exception text, filesystem paths, and credentials remain hidden.",
    )
    outputs = ((base.ARCHIVE, archive), (base.UNIT, unit), (base.NOTE, note))
    if check_only:
        for path, data in outputs:
            if not path.exists() or path.read_bytes() != data:
                raise SystemExit(f"candidate-33 r1 output differs from reproducible build: {path}")
    else:
        if any(path.exists() for path, _ in outputs):
            raise SystemExit("candidate-33 r1 output already exists; refusing to overwrite")
        for path, data in outputs:
            path.write_bytes(data)
    print(f"draft archive sha256: {base.sha(archive)}")
    print(f"draft service sha256: {base.sha(unit)}")
    print(f"archive members: {members}")
    print("revision: r1; includes safe internal-error classification")
    print("reproducibility: PASS" if check_only else "draft: written; NOT FOR DEPLOYMENT")


if __name__ == "__main__":
    main()
