#!/usr/bin/env python3
"""Reuse the independent archive/source/import audit for the new revision."""
import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('candidate34_audit',Path(__file__).with_name('audit-northstar-candidate34-draft.py'))
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
if __name__=='__main__':audit.audit_candidate(name='northstar-controlled-trial-20261028-candidate-34-r4-draft',unit_name='northstar-shell-candidate-34-r4-draft.service')
