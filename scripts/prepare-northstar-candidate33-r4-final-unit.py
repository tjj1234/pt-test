#!/usr/bin/env python3
"""Derive a local r4 unit preview; this does not authorize deployment."""
from __future__ import annotations

import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "release-artifacts"
DRAFT_ARCHIVE = ARTIFACTS / "northstar-controlled-trial-20261023-candidate-33-draft-r4.tar.gz"
DRAFT_UNIT = ARTIFACTS / "northstar-shell-candidate-33-draft-r4.service"
FINAL_UNIT = ARTIFACTS / "northstar-shell-candidate-33-r4.service"
DRAFT_ARCHIVE_SHA = "665ad991cb38f3f00fecf1c463a83c02319e5fe2e29a8e9829ae2e3fd3a79f4c"
DRAFT_UNIT_SHA = "ee7f9118190278ea0c7289eb70d94c754191a30f58152bf33e10841f1a8fe772"
DRAFT_PATH = b"/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r4"
FINAL_PATH = b"/opt/northstar/releases/controlled-trial-20261023-candidate-33-r4"
DRAFT_DESCRIPTION = b"Description=Northstar Shell (DRAFT ONLY - NOT FOR DEPLOYMENT - Candidate 33 r4)"
FINAL_DESCRIPTION = b"Description=Northstar Shell (Candidate 33 r4 diagnostic)"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build() -> bytes:
    if sha(DRAFT_ARCHIVE.read_bytes()) != DRAFT_ARCHIVE_SHA:
        raise ValueError("frozen r4 archive checksum changed")
    source = DRAFT_UNIT.read_bytes()
    if sha(source) != DRAFT_UNIT_SHA:
        raise ValueError("frozen r4 draft unit checksum changed")
    if source.count(DRAFT_PATH) != 3 or source.count(DRAFT_DESCRIPTION) != 1:
        raise ValueError("draft unit path or description differs from reviewed source")
    final = source.replace(DRAFT_PATH, FINAL_PATH).replace(DRAFT_DESCRIPTION, FINAL_DESCRIPTION)
    if DRAFT_PATH in final or DRAFT_DESCRIPTION in final or final.count(FINAL_PATH) != 3 or final.count(FINAL_DESCRIPTION) != 1:
        raise ValueError("final unit contains an unexpected release identity")
    return final


def main() -> None:
    if sys.argv[1:] not in ([], ["--preview"], ["--write"], ["--check"]):
        raise SystemExit("usage: prepare-northstar-candidate33-r4-final-unit.py [--preview|--write|--check]")
    data = build()
    mode = sys.argv[1:] or ["--preview"]
    if mode == ["--check"]:
        if not FINAL_UNIT.exists() or FINAL_UNIT.read_bytes() != data:
            raise ValueError("local final unit differs from the frozen derivation")
    elif mode == ["--write"]:
        if FINAL_UNIT.exists():
            raise ValueError("refusing to overwrite an existing final unit")
        FINAL_UNIT.write_bytes(data)
    print(f"local unit: {FINAL_UNIT.relative_to(ROOT)}")
    print(f"sha256: {sha(data)}")
    print(f"release path: {FINAL_PATH.decode()}")
    print("scope: local unit derivation only; target path, runbook, ZIP, deployment approval remain pending")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"r4 unit preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
