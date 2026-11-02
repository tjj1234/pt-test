#!/usr/bin/env python3
"""Deployment control tests: isolated paths and fake service commands; never touches systemd."""
import contextlib
import importlib.util
import io
import shutil
from pathlib import Path
import socket
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
socket.create_connection = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('OFFLINE'))
socket.getaddrinfo = socket.create_connection

class ActivationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='r5-activation-offline-')
        self.addCleanup(self.temp.cleanup)
        spec = importlib.util.spec_from_file_location('r5_activation', ROOT / 'scripts/northstar-catalog-cache-r5-activate.py')
        self.m = m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        root = Path(self.temp.name)
        for name in ['OLD', 'NEW', 'INPUT', 'UNIT', 'BACKUP', 'RUNTIME']:
            setattr(m, name, root / name)
        m.OLD.mkdir(); m.INPUT.mkdir(); m.RUNTIME.mkdir()
        self.commands = []
        for name in [m.ARCHIVE, m.UNIT_NAME]:
            shutil.copyfile(ROOT / 'release-artifacts' / name, m.INPUT / name)
        with tarfile.open(ROOT / 'release-artifacts/northstar-controlled-trial-20261023-candidate-33-draft-r2.tar.gz') as archive:
            for entry in archive.getmembers():
                file = m.OLD / entry.name
                if entry.isdir(): file.mkdir(parents=True, exist_ok=True)
                else:
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_bytes(archive.extractfile(entry).read())
        shutil.copyfile(ROOT / 'release-artifacts/northstar-shell-candidate-33-draft-r2.service', m.UNIT)
        deps = m.OLD / 'shell/node_modules'; deps.mkdir()
        (deps / 'module.js').write_text('module.exports = 1;\n')
        (deps / 'module-link.js').symlink_to('module.js')
        m.property_value = lambda key: {'WorkingDirectory': str(m.OLD / 'shell'), 'ActiveState': 'active', 'DropInPaths': ''}[key]
        def run(args):
            self.commands.append(args)
            if args == [m.NODE, '--version']: return 'v24.22.0'
            if args[0] == 'install': shutil.copyfile(args[-2], args[-1])
            return ''
        m.run = run
        self.quiet = contextlib.redirect_stdout(io.StringIO())
        self.quiet.__enter__(); self.addCleanup(lambda: self.quiet.__exit__(None, None, None))

    def test_stage_isolated_release_without_service_change_or_package_install(self):
        self.m.stage()
        self.assertEqual(self.m.digest(self.m.UNIT), self.m.OLD_UNIT)
        self.assertEqual(self.m.digest(self.m.NEW / self.m.CACHE), self.m.CACHE_SHA)
        self.assertTrue((self.m.NEW / 'shell/node_modules/module-link.js').is_symlink())
        self.assertFalse(self.m.BACKUP.exists())
        self.assertFalse(any(cmd[0] in ['install', 'npm', 'systemctl'] for cmd in self.commands))

    def test_dangling_destination_symlink_rejected_without_following(self):
        self.m.NEW.symlink_to(Path(self.temp.name) / 'missing-target')
        with self.assertRaisesRegex(RuntimeError, 'DESTINATION_EXISTS_STOP'): self.m.stage()
        self.assertTrue(self.m.NEW.is_symlink())

    def test_baseline_drift_stops_before_new_release_is_created(self):
        self.m.UNIT.write_text('different unit')
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_DRIFT'): self.m.stage()
        self.assertFalse(self.m.NEW.exists())

    def test_staged_source_change_blocks_activation(self):
        self.m.stage()
        (self.m.NEW / self.m.CACHE).write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'STAGED_MEMBER_CHANGED'): self.m.activate()
        self.assertEqual(self.m.digest(self.m.UNIT), self.m.OLD_UNIT)
        self.assertFalse(self.m.BACKUP.exists())

    def test_copied_dependency_change_blocks_activation(self):
        self.m.stage()
        (self.m.NEW / 'shell/node_modules/module.js').write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'COPIED_DEPENDENCIES_DIFFER'): self.m.activate()
        self.assertEqual(self.m.digest(self.m.UNIT), self.m.OLD_UNIT)

    def test_unhealthy_new_process_automatically_restores_exact_old_unit(self):
        self.m.stage()
        checks = []
        def health(expected):
            checks.append(expected)
            if expected == self.m.NEW: raise RuntimeError('HEALTH_OR_PROCESS_IDENTITY_FAILED')
        self.m.health_matches = health
        with self.assertRaisesRegex(RuntimeError, 'HEALTH_OR_PROCESS_IDENTITY_FAILED'): self.m.activate()
        self.assertEqual(checks, [self.m.NEW, self.m.OLD])
        self.assertEqual(self.m.digest(self.m.UNIT), self.m.OLD_UNIT)
        self.assertEqual(self.m.digest(self.m.BACKUP / 'northstar-shell.service'), self.m.OLD_UNIT)
        self.assertEqual((self.m.BACKUP / 'northstar-shell.service').stat().st_mode & 0o777, 0o600)
        self.assertEqual(sum(cmd[:2] == ['systemctl', 'restart'] for cmd in self.commands), 2)

    def test_successful_activation_retains_backup_and_explicit_rollback_restores_r2(self):
        self.m.stage(); checks = []
        self.m.health_matches = lambda expected: checks.append(expected)
        self.m.activate()
        self.assertEqual(self.m.digest(self.m.UNIT), self.m.NEW_UNIT)
        self.m.rollback()
        self.assertEqual(self.m.digest(self.m.UNIT), self.m.OLD_UNIT)
        self.assertEqual(checks, [self.m.NEW, self.m.OLD])
        self.assertTrue(self.m.NEW.exists(), 'rollback preserves staged candidate for investigation')

    def test_uploaded_unit_swap_after_verification_cannot_change_installed_unit(self):
        self.m.stage(); self.m.health_matches = lambda expected: None
        original_run = self.m.run
        def run(args):
            if args[0] == 'systemd-analyze':
                (self.m.INPUT / self.m.UNIT_NAME).write_text('untrusted replacement after verification')
            return original_run(args)
        self.m.run = run
        self.m.activate()
        self.assertEqual(self.m.digest(self.m.UNIT), self.m.NEW_UNIT)
        installed = [cmd for cmd in self.commands if cmd[0] == 'install']
        self.assertEqual(Path(installed[0][-2]).parent, self.m.BACKUP)

    def test_archive_swap_after_snapshot_never_changes_extracted_source(self):
        original_inspect = self.m.inspect_inputs
        calls = 0
        def inspect():
            nonlocal calls
            result = original_inspect()
            calls += 1
            if calls == 1:
                (self.m.INPUT / self.m.ARCHIVE).write_bytes(b'untrusted replacement')
            return result
        self.m.inspect_inputs = inspect
        with self.assertRaisesRegex(RuntimeError, 'INPUT_CHECKSUM'): self.m.stage()
        self.assertEqual(self.m.digest(self.m.NEW / self.m.CACHE), self.m.CACHE_SHA)
        self.assertEqual(self.m.digest(self.m.UNIT), self.m.OLD_UNIT)

    def test_uploaded_symlink_is_rejected_even_if_its_target_has_the_correct_hash(self):
        file = self.m.INPUT / self.m.UNIT_NAME
        target = file.with_suffix('.original'); file.rename(target); file.symlink_to(target)
        with self.assertRaises(OSError): self.m.stage()
        self.assertFalse(self.m.NEW.exists())

    def test_unknown_intervening_unit_is_never_overwritten_by_rollback(self):
        self.m.stage(); self.m.health_matches = lambda expected: None
        self.m.activate()
        self.m.UNIT.write_text('operator changed unit')
        before = len(self.commands)
        with self.assertRaisesRegex(RuntimeError, 'REFUSE_OVERWRITING_UNRECOGNIZED_UNIT'): self.m.rollback()
        self.assertEqual(self.m.UNIT.read_text(), 'operator changed unit')
        self.assertEqual(len(self.commands), before)

if __name__ == '__main__':
    unittest.main()
