#!/usr/bin/env python3
"""Freeze reviewed batch5 on R30 without rewriting any historical artifact."""
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('r30_builder', Path(__file__).with_name('package-northstar-candidate34-r30-draft.py'))
parent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parent)
builder = parent.builder
builder.NAME = 'northstar-controlled-trial-20261106-candidate-34-r31-batch5-draft'
builder.PLAN = builder.OUT / (builder.NAME + '.sources.json')
builder.ARCHIVE = builder.OUT / (builder.NAME + '.tar.gz')
builder.UNIT = builder.OUT / 'northstar-shell-candidate-34-r31-draft.service'
builder.CHECKSUM = builder.OUT / (builder.NAME + '.sha256')
previous_build = builder.build

def build():
    outputs = previous_build()
    outputs[builder.UNIT] = outputs[builder.UNIT].replace(b'controlled-trial-20261105-candidate-34-r30-bugfix-draft', b'controlled-trial-20261106-candidate-34-r31-batch5-draft').replace(b'Candidate 34 r30 bugfix', b'Candidate 34 r31 batch5')
    plan = json.loads(outputs[builder.PLAN])
    plan['revision'] = 'r31-batch5'
    plan['bugfixScope'] = {
        'codeCommit': 'fd1f11ef120082068a0d0b83819883c35285ee07',
        'baseCommit': 'ab8107182a0d29d78c674ff64f69ae68319e603b',
        'authorCommit': 'e20834380a697fb3ab69c180c66c900939940bec',
        'included': ['2.4 unavailable Skill user choice with exact error code', '2.6 Usage selected range highlight', '2.8 conversation memory scope guard'],
        'htmlPreview': 'DEGRADED_PREVIEW',
        'geminiEightPackages': 'not integrated',
        'otherSecondBatchIssues': 'not resolved by this release',
        'targetDeployment': 'pending',
        'independentQA': 'pending',
    }
    outputs[builder.PLAN] = (json.dumps(plan, ensure_ascii=False, indent=2) + '\n').encode()
    return outputs

builder.build = build
if __name__ == '__main__':
    builder.main()
