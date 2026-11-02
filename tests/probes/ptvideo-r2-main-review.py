#!/usr/bin/env python3
"""Offline counterexamples documenting why R2 is blocked, not an acceptance test."""
import argparse, importlib.util, json, socket, urllib.error

def deny(*args, **kwargs):
    raise RuntimeError('OFFLINE_NETWORK_BLOCKED')
socket.socket.connect = deny
socket.getaddrinfo = deny
parser = argparse.ArgumentParser()
parser.add_argument('--engine-path', required=True)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('reviewed_engine', args.engine_path + '/pt_video.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
rows = []
key = 'offline-fixture'
request = lambda: m.ProductRequest(model='wan3.0-video', kind='video', prompt='fixture')
image = lambda: m.ProductRequest(model='image-01', kind='image', prompt='fixture')
class FailOpener:
    def open(self, *args, **kwargs):
        raise urllib.error.URLError('PRIVATE_SENTINEL')
m._api_opener = FailOpener()
r = m.generate_for_product(request(), api_key=key)
assert r.error_code == 'UPSTREAM_ERROR' and '重试' in r.error_hint
rows.append({'case': 'actual_transport_disconnect', 'defect': 'unknown_submission_suggests_retry'})
r = m.generate_for_product(request(), api_key=key, _transport=lambda *args: {})
assert r.error_code == 'UPSTREAM_ERROR' and '重试' in r.error_hint
rows.append({'case': 'missing_submission_id', 'defect': 'unknown_submission_suggests_retry'})
r = m.generate_for_product(image(), api_key=key, _transport=lambda *args: {'data': [{'url': 'file:///fixture.png'}]})
assert r.ok
rows.append({'case': 'image_file_url', 'defect': 'invalid_result_scheme_accepted'})
r = m.generate_for_product(image(), api_key=key, _transport=lambda *args: {'status': 'failed', 'error': 'rejected', 'data': [{'url': 'https://cdn.invalid/error.png'}]})
assert r.ok
rows.append({'case': 'image_failure_with_url', 'defect': 'remote_failure_reported_success'})
rq = m.ProductRequest(model='dreamina-seedance-2-0', kind='seedance', prompt='fixture', first_frame='asset://valid\n')
m._validate_product_request(rq, key)
rows.append({'case': 'asset_trailing_newline', 'defect': 'invalid_asset_identifier_accepted'})
def malformed_poll(method, *args):
    return {'id': 'fixture-task'} if method == 'POST' else {'status': ['completed']}
try:
    m.generate_for_product(request(), api_key=key, _transport=malformed_poll)
    raise AssertionError('Expected malformed poll to escape R2')
except AttributeError as error:
    assert not hasattr(error, 'task_id')
rows.append({'case': 'malformed_poll', 'defect': 'structured_result_and_task_id_lost'})
rq = image()
posted = []
class MutateHook(m.ProductHooks):
    def before_submit(self, metadata):
        rq.n = 9
        rq.model = 'different-image-model'
def capture(method, path, credential, body, timeout):
    posted.append(body)
    return {'data': [{'url': 'https://cdn.invalid/result.png'}]}
r = m.generate_for_product(rq, api_key=key, hooks=MutateHook(), _transport=capture)
assert posted[0]['n'] == 9 and r.billing_params['n_images'] == 1
rows.append({'case': 'request_mutation_from_hook', 'defect': 'actual_post_differs_from_admitted_billing_parameters'})
token = m.CancellationToken()
def cancel_during_post(*args):
    token.cancel()
    return {'data': [{'url': 'https://cdn.invalid/result.png'}]}
r = m.generate_for_product(image(), api_key=key, _cancel=token, _transport=cancel_during_post)
assert r.ok and r.status == 'completed'
rows.append({'case': 'image_cancel_during_post', 'defect': 'cancellation_not_reflected_in_outcome'})
print(json.dumps({'scope': 'r2_counterexamples_not_acceptance', 'external_requests': 0, 'reproduced': len(rows), 'rows': rows}))
