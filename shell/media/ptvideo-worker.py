#!/usr/bin/env python3
"""Trusted-host JSONL worker. Never invokes CLI auto/fallback or downloads assets."""
import importlib.util
import json
from pathlib import Path
import re
import signal
import sys
import urllib.parse

MAX_FRAME = 128 * 1024
MODULE = Path(__file__).resolve().parent / 'vendor/powertokens_video/pt_video.py'
FIELDS = {'model','kind','prompt','duration','resolution','ratio','aspect_ratio','n','seed',
          'first_frame','last_frame','ref_images','no_audio','no_prompt_extend','watermark',
          'poll_timeout','submit_timeout','poll_interval'}

class ProtocolError(Exception):
    pass


def read_frame(stream):
    line = stream.readline(MAX_FRAME + 1)
    if not line or len(line) > MAX_FRAME or not line.endswith(b'\n'):
        raise ProtocolError()
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ProtocolError()
    return value


def run(stdin=None, stdout=None, transport=None):
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout
    request_id = None
    def emit(frame):
        data = json.dumps(frame, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
        if len(data.encode()) + 1 > MAX_FRAME:
            raise ProtocolError()
        stdout.write(data + '\n'); stdout.flush()
    emit({'version': 1, 'type': 'ready'})
    try:
        frame = read_frame(stdin)
        if set(frame) != {'version','type','requestId','apiKey','baseUrl','request'} or frame['version'] != 1 or frame['type'] != 'generate':
            raise ProtocolError()
        request_id = frame['requestId']
        if not isinstance(request_id, str) or not re.fullmatch(r'[a-f0-9-]{36}', request_id):
            raise ProtocolError()
        request = frame['request']; key = frame['apiKey']
        if not isinstance(request, dict) or set(request) - FIELDS or not {'model','kind'} <= set(request):
            raise ProtocolError()
        if not isinstance(key, str) or not key or len(key) > 4096 or any(ord(c) < 32 for c in key):
            raise ProtocolError()
        url = urllib.parse.urlsplit(frame['baseUrl'])
        if url.scheme != 'https' or not url.hostname or url.username is not None or url.password is not None or url.path not in ('','/') or url.query or url.fragment:
            raise ProtocolError()
        if url.port is not None and url.port < 1:
            raise ProtocolError()
        spec = importlib.util.spec_from_file_location('northstar_media_engine', MODULE)
        engine = importlib.util.module_from_spec(spec); spec.loader.exec_module(engine)
        engine.PT_BASE = urllib.parse.urlunsplit((url.scheme, url.netloc, '', '', ''))
        token = engine.CancellationToken()
        signal.signal(signal.SIGTERM, lambda *args: token.cancel())
        sequence = 0
        billing = {}
        known_task = None
        def acknowledged(event, payload):
            nonlocal sequence
            sequence += 1
            emit({'version':1,'type':'event','requestId':request_id,'eventId':sequence,'event':event,'payload':payload})
            ack = read_frame(stdin)
            if set(ack) != {'version','type','requestId','eventId','ok'} or ack['version'] != 1 or ack['type'] != 'ack' or ack['requestId'] != request_id or ack['eventId'] != sequence or ack['ok'] is not True:
                raise ProtocolError()
        class Hooks(engine.ProductHooks):
            def before_submit(self, metadata):
                nonlocal billing
                billing = dict(metadata['billing_params'])
                acknowledged('before_submit', metadata)
            def on_task_id(self, task_id):
                nonlocal known_task
                known_task = task_id
                acknowledged('task_id', {'taskId': task_id})
            def on_result(self, result):
                acknowledged('result', result.to_dict())
        try:
            result = engine.generate_for_product(engine.ProductRequest(**request), api_key=key,
                hooks=Hooks(), _transport=transport, _cancel=token).to_dict()
        except engine.TaskIdWriteError:
            result = engine.ProductResult(ok=False, task_id=known_task, model=request['model'], kind=request['kind'],
                status='unknown_poll_error', error_code='TASK_ID_WRITE_FAILED',
                error_hint='任务ID持久化未获确认；保留ID核对，不自动重提。', billing_params=billing).to_dict()
        emit({'version':1,'type':'done','requestId':request_id,'result':result})
    except Exception:
        # A trusted parent classifies this using its acknowledged submission phase
        # and independently retained ID. Never emit input, a traceback or raw cause.
        emit({'version':1,'type':'error','requestId':request_id,'code':'MEDIA_WORKER_FAILED'})

if __name__ == '__main__':
    run()
