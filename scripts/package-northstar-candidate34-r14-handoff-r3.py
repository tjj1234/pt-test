#!/usr/bin/env python3
"""Freeze the Linux PTY-verified r14 execution handoff."""
import importlib.util
from pathlib import Path

spec=importlib.util.spec_from_file_location('r14_handoff',Path(__file__).with_name('package-northstar-candidate34-r14-handoff-r2.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
base=parent.parent
base.ZIP=base.OUT/(base.NAME+'-handoff-r3.zip')
base.SHA=base.OUT/(base.NAME+'-handoff-r3.sha256')
if __name__=='__main__':base.main()
