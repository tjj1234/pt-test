#!/usr/bin/env python3
"""Immutable revision after strict managed media tool output repair."""
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('candidate34_r9', Path(__file__).with_name('package-northstar-candidate34-r9-draft.py'))
parent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parent)
builder = parent.builder
builder.NAME = 'northstar-controlled-trial-20261029-candidate-34-r10-draft'
builder.PLAN = builder.OUT / (builder.NAME + '.sources.json')
builder.ARCHIVE = builder.OUT / (builder.NAME + '.tar.gz')
builder.UNIT = builder.OUT / 'northstar-shell-candidate-34-r10-draft.service'
builder.CHECKSUM = builder.OUT / (builder.NAME + '.sha256')
previous_build = builder.build

def build():
    output = previous_build()
    output[builder.UNIT] = output[builder.UNIT].replace(b'controlled-trial-20261029-candidate-34-r9-draft', b'controlled-trial-20261029-candidate-34-r10-draft')
    plan = json.loads(output[builder.PLAN])
    plan['revision'] = 'r10'
    plan['scope'] = 'strict-managed-media-tool-output-schema; ' + plan['scope']
    plan['controlledMediaAuthorization']['liveText2ImageEvidence'] = 'F1-live-agent-20261029-media-r7.json; local same-version product trial only'
    output[builder.PLAN] = (json.dumps(plan, ensure_ascii=False, indent=2) + '\n').encode()
    return output

builder.build = build
if __name__ == '__main__':
    builder.main()
