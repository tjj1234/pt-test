"""Offline counterexample probe; findings are not acceptance passes."""
import importlib.util
import json
import shutil
import sys
from pathlib import Path
sys.dont_write_bytecode=True

spec = importlib.util.spec_from_file_location('candidate_tests', Path(__file__).resolve().parents[1] / 'regression/pt-asset-upload-product-candidate-test.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
engine = candidate.pt_video

def invoke(post, get, **options):
    calls = []
    def transport(req, timeout):
        calls.append(req.get_method())
        return candidate.FakeHTTPResponse(json.dumps(post if req.get_method() == 'POST' else get).encode())
    result = engine.upload_asset_for_product(b'fixture', key='offline-fixture-key', transport=transport, **options)
    return result, calls

try:
    accepted = {'code': 200, 'data': {'task_id': 'fixture-task'}}
    success = {'code': 200, 'data': {'asset_id': 'fixture-asset'}}
    findings = []
    result, calls = invoke(accepted, {'data': {'asset_id': 'fixture-asset'}})
    findings.append({'case': 'missing_success_code', 'unsafe_success': result['ok'], 'calls': calls})
    result, calls = invoke({'code': 'PRIVATE_SENTINEL'}, success)
    findings.append({'case': 'untrusted_code_echo', 'sentinel_leaked': 'PRIVATE_SENTINEL' in json.dumps(result), 'calls': calls})
    result, calls = invoke(accepted, success, poll_timeout=float('nan'))
    findings.append({'case': 'nonfinite_deadline', 'unsafe_success': result['ok'], 'calls': calls})
    print(json.dumps({'scope': 'offline_candidate_counterexamples', 'providerCalls': 0, 'findings': findings}, indent=2))
finally:
    if candidate._TEMP_DIR:
        shutil.rmtree(candidate._TEMP_DIR)
