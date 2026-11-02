#!/usr/bin/env python3
"""Freeze the complete operations execution document with the r14 handoff."""
import importlib.util
from pathlib import Path

spec=importlib.util.spec_from_file_location('r14_handoff',Path(__file__).with_name('package-northstar-candidate34-r14-handoff.py'))
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
parent.INPUTS=parent.INPUTS+[parent.ROOT/'docs/refactor/OPS-CANDIDATE34-R14-EXECUTION-20261030.md']
parent.ZIP=parent.OUT/(parent.NAME+'-handoff-r2.zip')
parent.SHA=parent.OUT/(parent.NAME+'-handoff-r2.sha256')
if __name__=='__main__':parent.main()
