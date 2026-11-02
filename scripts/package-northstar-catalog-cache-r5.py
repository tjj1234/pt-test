#!/usr/bin/env python3
"""Frozen r2 plus one reviewed cache module. Builds/checks a review candidate only."""
import copy
import gzip
import hashlib
import io
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'release-artifacts'
BASE = OUT / 'northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz'
BASE_UNIT = OUT / 'northstar-shell-candidate-33-draft-r2.service'
PATCH = ROOT / 'docs/refactor/candidates/candidate33-r5-cache-schema.patch'
ARCHIVE = OUT / 'northstar-controlled-trial-20261027-catalog-cache-r5.tar.gz'
UNIT = OUT / 'northstar-shell-catalog-cache-r5.service'
CHECKSUMS = OUT / 'northstar-catalog-cache-r5.sha256'
TARGET = 'shell/models/catalog-cache.cjs'
OLD_PATH = b'/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2'
NEW_PATH = b'/opt/northstar/releases/controlled-trial-20261027-catalog-cache-r5'
PINNED = {
    BASE: 'bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77',
    BASE_UNIT: 'eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105',
    PATCH: '1464d66102f66bb8f66598142a7180d4e7d87c3fc1e20b17f3693ded7d8cbdb4',
}
sha = lambda data: hashlib.sha256(data).hexdigest()


def build():
    for file, digest in PINNED.items():
        if sha(file.read_bytes()) != digest:
            raise ValueError('Frozen input checksum differs: ' + file.name)
    with tarfile.open(BASE, 'r:gz') as source:
        members = source.getmembers()
        names = [m.name for m in members]
        if len(members) != 325 or len(set(names)) != 325:
            raise ValueError('Frozen member set differs')
        files = {}
        for member in members:
            p = PurePosixPath(member.name)
            if p.is_absolute() or '..' in p.parts or '\\' in member.name or member.pax_headers or not (member.isfile() or member.isdir()):
                raise ValueError('Unsupported archive member')
            if member.isfile():
                files[member.name] = source.extractfile(member).read()
    if sha(files[TARGET]) != '05266578ab4f3489dfa0a467c60de8f2e1f984b59be8295699cc1e6c81eacc4a':
        raise ValueError('Original cache module differs')
    with tempfile.TemporaryDirectory(prefix='northstar-cache-r5-build-') as directory:
        target = Path(directory) / TARGET
        target.parent.mkdir(parents=True)
        target.write_bytes(files[TARGET])
        applied = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i', str(PATCH)], cwd=directory, capture_output=True)
        if applied.returncode:
            raise ValueError('Reviewed patch did not apply cleanly')
        replacement = target.read_bytes()
    if sha(replacement) != '9ea20f59d2d452381c54d0a78c20673565707f2bd132857c6fb1bd5e95454a1e':
        raise ValueError('Replacement cache module differs')
    output = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=9) as zipped:
        with tarfile.open(fileobj=zipped, mode='w', format=tarfile.USTAR_FORMAT) as destination:
            for original in members:
                member = copy.copy(original)
                member.pax_headers = {}
                if member.isfile():
                    data = replacement if member.name == TARGET else files[member.name]
                    member.size = len(data)
                    destination.addfile(member, io.BytesIO(data))
                else:
                    destination.addfile(member)
    # Independent readback: exactly one content overlay; all member metadata
    # remains inherited except that member's byte count.
    archive = output.getvalue()
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as result:
        if [m.name for m in result.getmembers()] != names:
            raise ValueError('Output member set differs')
        changed = {name for name, data in files.items() if result.extractfile(name).read() != data}
        if changed != {TARGET}:
            raise ValueError('Undeclared content overlay')
        if any(m.pax_headers for m in result.getmembers()):
            raise ValueError('PAX metadata in output')
    unit = BASE_UNIT.read_bytes()
    if unit.count(OLD_PATH) != 3:
        raise ValueError('Frozen unit path count differs')
    unit = unit.replace(OLD_PATH, NEW_PATH).replace(
        b'Description=Northstar Shell (DRAFT ONLY - NOT FOR DEPLOYMENT - Candidate 33)',
        b'Description=Northstar Shell (CATALOG CACHE R5 - REVIEW CANDIDATE)')
    checksums = ''.join(sha(data) + '  ' + file.name + '\n' for file, data in [(ARCHIVE, archive), (UNIT, unit)]).encode()
    return {ARCHIVE: archive, UNIT: unit, CHECKSUMS: checksums}


def main():
    if sys.argv[1:] not in ([], ['--check']):
        raise ValueError('Usage: package-northstar-catalog-cache-r5.py [--check]')
    artifacts = build()
    for file, data in artifacts.items():
        if sys.argv[1:] == ['--check']:
            if not file.is_file() or file.read_bytes() != data:
                raise ValueError('Candidate differs from frozen reproducible build: ' + file.name)
        else:
            if file.exists() and file.read_bytes() != data:
                raise ValueError('Refusing to overwrite a different candidate: ' + file.name)
            file.write_bytes(data)
        print(sha(data) + '  ' + file.name)
    print('REVIEW_CANDIDATE_ONLY members=325 overlay=1 dependency_changes=0 migrations=0')

if __name__ == '__main__':
    main()
