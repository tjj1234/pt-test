#!/usr/bin/env python3
"""Operator-run r5 stage/activation/rollback. Run mutations only after approved change."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
import time

OLD = Path('/opt/northstar/releases/controlled-trial-20261023-candidate-33-draft-r2')
NEW = Path('/opt/northstar/releases/controlled-trial-20261027-catalog-cache-r5')
INPUT = Path('/tmp')
UNIT = Path('/etc/systemd/system/northstar-shell.service')
BACKUP = Path('/var/lib/northstar/rollback/catalog-cache-r5')
RUNTIME = Path('/var/lib/northstar/runtime')
NODE = '/usr/local/bin/node'
SERVICE = 'northstar-shell'
HEALTH = 'https://agent-fat.adorado.top/healthz'
ARCHIVE = 'northstar-controlled-trial-20261027-catalog-cache-r5.tar.gz'
UNIT_NAME = 'northstar-shell-catalog-cache-r5.service'
OLD_UNIT = 'eeda8fde67704b3df9202c0f6f7f5a235b0c80a32cc3627dcb44109ec8136105'
NEW_UNIT = '69960cd10ccad134babef955480b88602118f57019a54972a883b6426613a83a'
CACHE = 'shell/models/catalog-cache.cjs'
CACHE_SHA = '9ea20f59d2d452381c54d0a78c20673565707f2bd132857c6fb1bd5e95454a1e'
OLD_SOURCES = {'shell/server.cjs': '64ad1cdc9cc1f7fed1f90ef918f39e8c260eee294d15730715ac766fe9eafe54',
               'shell/model-catalog.cjs': '934719b4f542c57d34a4121fdb91639a0e393013a7b49d999b4088d71f35e73d',
               CACHE: '05266578ab4f3489dfa0a467c60de8f2e1f984b59be8295699cc1e6c81eacc4a',
               'shell/models/capabilities.cjs': 'b569a61b7e09da7bd41e901f5da4a16c70cebc926baa8fd0306a2d6bec72b593'}


def fail(code):
    raise RuntimeError(code)


def digest(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    if result.returncode:
        fail('COMMAND_FAILED:' + Path(args[0]).name)  # no raw provider/env output
    return result.stdout.strip()


def property_value(name):
    return run(['systemctl', 'show', SERVICE, '--property=' + name, '--value'])


def baseline():
    if digest(UNIT) != OLD_UNIT or property_value('WorkingDirectory') != str(OLD / 'shell'):
        fail('BASELINE_DRIFT')
    if property_value('ActiveState') != 'active' or property_value('DropInPaths'):
        fail('SERVICE_NOT_ACTIVE_OR_HAS_DROPINS')
    for name, expected in OLD_SOURCES.items():
        if digest(OLD / name) != expected:
            fail('SOURCE_DRIFT')
    if run([NODE, '--version']) != 'v24.22.0':
        fail('NODE_VERSION_DRIFT')
    if not RUNTIME.is_dir() or RUNTIME.is_symlink():
        fail('RUNTIME_PATH_CHANGED')
    run(['runuser', '-u', 'northstar', '--', 'test', '-w', str(RUNTIME)])


def pinned_input(file, expected, limit):
    # Open once without following links; subsequent operations consume these
    # verified bytes, never reopen an upload pathname after checking it.
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        meta = os.fstat(stream.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_size > limit:
            fail('INPUT_NOT_BOUNDED_REGULAR_FILE')
        data = stream.read(limit + 1)
    if len(data) > limit or hashlib.sha256(data).hexdigest() != expected:
        fail('INPUT_CHECKSUM')
    return data


def inspect_inputs():
    archive_bytes = pinned_input(INPUT / ARCHIVE, 'da4933064a310694c2ab12bfba49dd71b5d5be7fec993dbbe85fd3104a2af92b', 32 * 1024 * 1024)
    unit_bytes = pinned_input(INPUT / UNIT_NAME, NEW_UNIT, 64 * 1024)
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
        entries = archive.getmembers()
        if len(entries) != 325 or len({m.name for m in entries}) != 325:
            fail('ARCHIVE_MEMBER_SET')
        for member in entries:
            p = PurePosixPath(member.name)
            if p.is_absolute() or '..' in p.parts or '\\' in member.name or member.pax_headers or not (member.isfile() or member.isdir()):
                fail('ARCHIVE_MEMBER_UNSAFE')
        return sum(m.size for m in entries), archive_bytes, unit_bytes


def dependency_fingerprint(root):
    if root.is_symlink() or not root.is_dir():
        fail('DEPENDENCY_ROOT_CHANGED')
    h = hashlib.sha256()
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs.sort(); files.sort()
        for name in sorted(dirs + files):
            file = Path(directory) / name
            meta = file.lstat()
            relative = str(file.relative_to(root))
            if stat.S_ISLNK(meta.st_mode):
                value = ['link', os.readlink(file)]
            elif stat.S_ISREG(meta.st_mode):
                total += meta.st_size
                value = ['file', stat.S_IMODE(meta.st_mode), digest(file)]
            elif stat.S_ISDIR(meta.st_mode):
                value = ['directory', stat.S_IMODE(meta.st_mode)]
            else:
                fail('DEPENDENCY_SPECIAL_FILE')
            h.update(json.dumps([relative, value], ensure_ascii=True).encode())
    return h.hexdigest(), total


def verify_staged():
    _, archive_bytes, _ = inspect_inputs()
    if NEW.is_symlink() or not NEW.is_dir():
        fail('STAGED_RELEASE_MISSING')
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
        for member in archive.getmembers():
            file = NEW / member.name
            if file.is_symlink() or (member.isdir() and not file.is_dir()):
                fail('STAGED_MEMBER_TYPE')
            if member.isfile() and (not file.is_file() or digest(file) != hashlib.sha256(archive.extractfile(member).read()).hexdigest()):
                fail('STAGED_MEMBER_CHANGED')
    for name in ['shell/package.json', 'shell/package-lock.json', 'shell/.npmrc']:
        if digest(NEW / name) != digest(OLD / name):
            fail('DEPENDENCY_MANIFEST_DRIFT')
    old_deps = dependency_fingerprint(OLD / 'shell/node_modules')[0]
    if dependency_fingerprint(NEW / 'shell/node_modules')[0] != old_deps:
        fail('COPIED_DEPENDENCIES_DIFFER')
    if digest(NEW / CACHE) != CACHE_SHA:
        fail('CACHE_SOURCE_CHANGED')
    for name in ['shell/server.cjs', 'shell/model-catalog.cjs', CACHE]:
        run([NODE, '--check', str(NEW / name)])
    return old_deps


def stage():
    baseline()
    unpacked, archive_bytes, _ = inspect_inputs()
    if os.path.lexists(NEW):
        fail('DESTINATION_EXISTS_STOP')
    before, size = dependency_fingerprint(OLD / 'shell/node_modules')
    if shutil.disk_usage(NEW.parent).free < unpacked + size + 64 * 1024 * 1024:
        fail('INSUFFICIENT_SPACE')
    NEW.mkdir(mode=0o755)  # exclusive, never overwrite any existing release
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
        for member in archive.getmembers():
            target = NEW / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as stream:
                    shutil.copyfileobj(archive.extractfile(member), stream)
            target.chmod(member.mode & 0o777)
    shutil.copytree(OLD / 'shell/node_modules', NEW / 'shell/node_modules', symlinks=True)
    if verify_staged() != before:
        fail('DEPENDENCIES_CHANGED_DURING_COPY')
    baseline()
    print(json.dumps({'result': 'STAGED_NO_SERVICE_CHANGE', 'members': 325, 'dependencyFingerprint': before}))


def health_matches(expected_root):
    for _ in range(30):
        try:
            pid = int(property_value('MainPID'))
            if pid <= 0 or property_value('ActiveState') != 'active' or property_value('WorkingDirectory') != str(expected_root / 'shell'):
                raise ValueError()
            cwd = Path('/proc/' + str(pid) + '/cwd').resolve()
            if cwd != expected_root / 'shell':
                raise ValueError()
            raw = run(['curl', '--fail', '--silent', '--show-error', '--max-time', '2', HEALTH])
            body = json.loads(raw)
            if body.get('ok') is True and body.get('pid') == pid:
                print(json.dumps({'health': 'ok', 'pid': pid, 'workingDirectory': str(expected_root / 'shell')}))
                return
        except Exception:
            pass
        time.sleep(1)
    fail('HEALTH_OR_PROCESS_IDENTITY_FAILED')


def install_unit(source):
    run(['install', '-o', 'root', '-g', 'root', '-m', '0644', str(source), str(UNIT)])
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'restart', SERVICE])


def rollback():
    saved = BACKUP / 'northstar-shell.service'
    if saved.is_symlink() or digest(saved) != OLD_UNIT:
        fail('ROLLBACK_UNIT_MISSING_OR_CHANGED')
    if digest(UNIT) not in [OLD_UNIT, NEW_UNIT]:
        fail('REFUSE_OVERWRITING_UNRECOGNIZED_UNIT')
    for name, expected in OLD_SOURCES.items():
        if digest(OLD / name) != expected:
            fail('ROLLBACK_SOURCE_DRIFT')
    install_unit(saved)
    health_matches(OLD)
    print('ROLLED_BACK_TO_R2_CACHE_FILES_PRESERVED')


def activate():
    baseline()
    verify_staged()
    _, _, unit_bytes = inspect_inputs()
    if os.path.lexists(BACKUP):
        fail('BACKUP_DESTINATION_EXISTS_STOP')
    BACKUP.mkdir(mode=0o700, parents=True)
    saved = BACKUP / 'northstar-shell.service'
    with saved.open('xb') as stream:
        stream.write(UNIT.read_bytes())
        stream.flush(); os.fsync(stream.fileno())
    saved.chmod(0o600)
    if digest(saved) != OLD_UNIT:
        fail('UNIT_BACKUP_FAILED')
    approved = BACKUP / 'northstar-shell-r5.service'
    with approved.open('xb') as stream:
        stream.write(unit_bytes)
        stream.flush(); os.fsync(stream.fileno())
    approved.chmod(0o600)
    if digest(approved) != NEW_UNIT:
        fail('VERIFIED_UNIT_COPY_FAILED')
    run(['systemd-analyze', 'verify', str(approved)])
    try:
        install_unit(approved)
        health_matches(NEW)
    except BaseException:
        try:
            rollback()
        except BaseException:
            print('AUTOMATIC_ROLLBACK_FAILED_OPERATOR_REQUIRED', file=sys.stderr)
        raise
    print('ACTIVATED_R5_CATALOG_VERIFICATION_PENDING')


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ['stage', 'activate', 'rollback']:
        fail('Usage: script.py stage|activate|rollback')
    if os.geteuid() != 0:
        fail('ROOT_REQUIRED_FOR_OPERATOR_CHANGE')
    {'stage': stage, 'activate': activate, 'rollback': rollback}[sys.argv[1]]()

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Error messages in this script are stable codes; never dump env or raw command outputs.
        print('R5_CHANGE_FAILED:' + (str(error) if type(error) is RuntimeError else type(error).__name__), file=sys.stderr)
        sys.exit(1)
