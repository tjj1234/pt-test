"""Regression test suite for PT Asset Upload Worker Candidate (offline, socket blocked)."""
import base64
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

# Global network blocking
def blocked(*args, **kwargs):
    raise AssertionError("NETWORK_ACCESS_FORBIDDEN")

socket.socket.connect = blocked
socket.socket.connect_ex = blocked
socket.create_connection = blocked
socket.getaddrinfo = blocked

ROOT = pathlib.Path(__file__).resolve().parents[2]
VENDOR_ENGINE = ROOT / "shell/media/vendor/powertokens_video/pt_video.py"
PATCH_1 = ROOT / "docs/refactor/candidates/pt-asset-upload-product-20261029.patch"
PATCH_2 = ROOT / "docs/refactor/candidates/pt-asset-upload-main-review-20261029.patch"
WORKER_PATH = ROOT / "shell/media/pt-asset-upload-worker-candidate.py"

# Import worker candidate
worker_spec = importlib.util.spec_from_file_location("asset_worker", WORKER_PATH)
worker = importlib.util.module_from_spec(worker_spec)
worker_spec.loader.exec_module(worker)

REQUEST_ID = "12345678-1234-4123-8123-123456789012"


class FakeHTTPResponse:
    def __init__(self, data, code=200):
        self._data = data
        self.code = code
        self.status = code
        self.headers = {"Content-Type": "application/json"}

    def read(self, amt=None):
        return self._data

    def getcode(self):
        return self.code

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class WorkerRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Create isolated temporary directory and apply original patch -> main review overlay
        cls._temp_dir = tempfile.mkdtemp(prefix="asset-worker-engine-")
        cls.engine_path = pathlib.Path(cls._temp_dir) / "pt_video.py"
        shutil.copy2(VENDOR_ENGINE, cls.engine_path)

        # Baseline SHA check
        baseline_sha = hashlib.sha256(cls.engine_path.read_bytes()).hexdigest()
        assert baseline_sha == "08268f5f4e1da2782e3729498567054562d73b0c24ecab0970f861adc90f8351"

        # Apply Patch 1 (Gemini)
        subprocess.run(["patch", "-p1", "-i", str(PATCH_1)], cwd=cls._temp_dir, check=True, capture_output=True)
        # Apply Patch 2 (Main review overlay)
        subprocess.run(["patch", "-p1", "-i", str(PATCH_2)], cwd=cls._temp_dir, check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._temp_dir, ignore_errors=True)

    def execute_worker(self, initial_frame, ack_count=4, refused_event=None, transport=None):
        frames = [initial_frame]
        for i in range(1, ack_count + 1):
            frames.append({
                "version": 1,
                "type": "ack",
                "requestId": REQUEST_ID,
                "eventId": i,
                "ok": (i != refused_event),
            })

        stdin_data = ("\n".join(json.dumps(x) for x in frames) + "\n").encode("utf-8")
        stdin = io.BytesIO(stdin_data)
        stdout = io.StringIO()

        worker.run(stdin=stdin, stdout=stdout, transport=transport, engine_path=self.engine_path)
        raw_output = stdout.getvalue()
        lines = [line for line in raw_output.splitlines() if line.strip()]
        output_frames = [json.loads(line) for line in lines]
        return output_frames, raw_output

    def test_upload_success_ordering(self):
        content = b"fake-png-content-bytes-12345"
        b64 = base64.b64encode(content).decode("utf-8")
        initial = {
            "version": 1,
            "type": "upload",
            "requestId": REQUEST_ID,
            "apiKey": "PT-SECRET-API-KEY-9999",
            "baseUrl": "https://api.powertokens.ai",
            "filename": "reference.png",
            "contentBase64": b64,
            "pollTimeout": 60,
        }

        calls = []
        def transport(req, timeout=None):
            method = req.get_method()
            calls.append(method)
            if method == "POST":
                return FakeHTTPResponse(b'{"code":200,"data":{"task_id":"task_123"}}')
            return FakeHTTPResponse(b'{"code":200,"data":{"asset_id":"asset_456"}}')

        output, raw_out = self.execute_worker(initial, ack_count=4, transport=transport)

        # Verify calls
        self.assertEqual(calls, ["POST", "GET"])

        # Ready frame
        self.assertEqual(output[0], {"version": 1, "type": "ready"})

        # Event sequence: before_submit -> submission_started -> on_task_id -> on_asset_id
        events = [f["event"] for f in output if f.get("type") == "event"]
        self.assertEqual(events, ["before_submit", "submission_started", "on_task_id", "on_asset_id"])

        # Done frame
        done_frame = output[-1]
        self.assertEqual(done_frame["type"], "done")
        res = done_frame["result"]
        self.assertTrue(res["ok"])
        self.assertEqual(res["outcome"], "succeeded")
        self.assertEqual(res["task_id"], "task_123")
        self.assertEqual(res["asset_id"], "asset_456")
        self.assertEqual(res["byte_count"], len(content))
        self.assertEqual(res["sha256"], hashlib.sha256(content).hexdigest())
        self.assertFalse(res["may_resubmit"])

        # Zero key or raw bytes in stdout
        self.assertNotIn("PT-SECRET-API-KEY-9999", raw_out)
        self.assertNotIn(content.decode("latin1"), raw_out)

    def test_recover_success_get_only(self):
        initial = {
            "version": 1,
            "type": "recover",
            "requestId": REQUEST_ID,
            "baseUrl": "https://api.powertokens.ai",
            "taskId": "task_recovered_789",
            "pollTimeout": 30,
        }

        calls = []
        def transport(req, timeout=None):
            method = req.get_method()
            calls.append(method)
            self.assertEqual(method, "GET")
            self.assertNotIn("Authorization", req.headers)
            self.assertNotIn("Cookie", req.headers)
            return FakeHTTPResponse(b'{"code":200,"data":{"asset_id":"asset_recovered_999"}}')

        output, raw_out = self.execute_worker(initial, ack_count=1, transport=transport)

        self.assertEqual(calls, ["GET"])
        events = [f["event"] for f in output if f.get("type") == "event"]
        self.assertEqual(events, ["on_asset_id"])

        done_frame = output[-1]
        self.assertEqual(done_frame["type"], "done")
        res = done_frame["result"]
        self.assertTrue(res["ok"])
        self.assertEqual(res["outcome"], "succeeded")
        self.assertEqual(res["task_id"], "task_recovered_789")
        self.assertEqual(res["asset_id"], "asset_recovered_999")
        self.assertFalse(res["may_resubmit"])

    def test_refusal_before_submit_yields_zero_post(self):
        content = b"fake-png-content"
        initial = {
            "version": 1,
            "type": "upload",
            "requestId": REQUEST_ID,
            "apiKey": "PT-SECRET-API-KEY-9999",
            "baseUrl": "https://api.powertokens.ai",
            "filename": "reference.png",
            "contentBase64": base64.b64encode(content).decode("utf-8"),
            "pollTimeout": 60,
        }

        calls = []
        def transport(req, timeout=None):
            calls.append(req.get_method())
            return FakeHTTPResponse(b'{"code":200,"data":{}}')

        # Refuse event 1 (before_submit)
        output, _ = self.execute_worker(initial, ack_count=1, refused_event=1, transport=transport)

        self.assertEqual(calls, [], "Refusal at before_submit must yield ZERO provider requests")
        done_frame = output[-1]
        self.assertEqual(done_frame["type"], "done")
        res = done_frame["result"]
        self.assertFalse(res["ok"])
        self.assertEqual(res["outcome"], "not_submitted")
        self.assertEqual(res["error_code"], "HOOK_BEFORE_SUBMIT_FAILED")
        self.assertFalse(res["submission_may_have_started"])

    def test_refusal_submission_started_yields_zero_post(self):
        content = b"fake-png-content"
        initial = {
            "version": 1,
            "type": "upload",
            "requestId": REQUEST_ID,
            "apiKey": "PT-SECRET-API-KEY-9999",
            "baseUrl": "https://api.powertokens.ai",
            "filename": "reference.png",
            "contentBase64": base64.b64encode(content).decode("utf-8"),
            "pollTimeout": 60,
        }

        calls = []
        def transport(req, timeout=None):
            calls.append(req.get_method())
            return FakeHTTPResponse(b'{"code":200,"data":{}}')

        # Refuse event 2 (submission_started)
        output, _ = self.execute_worker(initial, ack_count=2, refused_event=2, transport=transport)

        self.assertEqual(calls, [], "Refusal at submission_started must yield ZERO provider requests")
        done_frame = output[-1]
        self.assertEqual(done_frame["type"], "done")
        res = done_frame["result"]
        self.assertFalse(res["ok"])
        self.assertEqual(res["outcome"], "not_submitted")
        self.assertEqual(res["error_code"], "HOOK_SUBMISSION_STARTED_FAILED")

    def test_refusal_on_task_id_retains_task_id_and_stops_get(self):
        content = b"fake-png-content"
        initial = {
            "version": 1,
            "type": "upload",
            "requestId": REQUEST_ID,
            "apiKey": "PT-SECRET-API-KEY-9999",
            "baseUrl": "https://api.powertokens.ai",
            "filename": "reference.png",
            "contentBase64": base64.b64encode(content).decode("utf-8"),
            "pollTimeout": 60,
        }

        calls = []
        def transport(req, timeout=None):
            calls.append(req.get_method())
            return FakeHTTPResponse(b'{"code":200,"data":{"task_id":"persisted_task_444"}}')

        # Refuse event 3 (on_task_id)
        output, _ = self.execute_worker(initial, ack_count=3, refused_event=3, transport=transport)

        # Exactly 1 POST, NO GET
        self.assertEqual(calls, ["POST"])
        done_frame = output[-1]
        self.assertEqual(done_frame["type"], "done")
        res = done_frame["result"]
        self.assertFalse(res["ok"])
        self.assertEqual(res["outcome"], "task_id_persisting_failed")
        self.assertEqual(res["task_id"], "persisted_task_444")
        self.assertEqual(res["error_code"], "HOOK_ON_TASK_ID_FAILED")
        self.assertTrue(res["submission_may_have_started"])
        self.assertFalse(res["may_resubmit"])

    def test_recover_refusal_on_asset_id_retains_ids_without_post(self):
        initial = {
            "version": 1,
            "type": "recover",
            "requestId": REQUEST_ID,
            "baseUrl": "https://api.powertokens.ai",
            "taskId": "known_task_888",
            "pollTimeout": 30,
        }

        calls = []
        def transport(req, timeout=None):
            calls.append(req.get_method())
            return FakeHTTPResponse(b'{"code":200,"data":{"asset_id":"aid_999"}}')

        # Refuse event 1 (on_asset_id)
        output, _ = self.execute_worker(initial, ack_count=1, refused_event=1, transport=transport)

        self.assertEqual(calls, ["GET"])
        done_frame = output[-1]
        self.assertEqual(done_frame["type"], "done")
        res = done_frame["result"]
        self.assertFalse(res["ok"])
        self.assertEqual(res["outcome"], "asset_id_persisting_failed")
        self.assertEqual(res["task_id"], "known_task_888")
        self.assertEqual(res["asset_id"], "aid_999")
        self.assertEqual(res["error_code"], "HOOK_ON_ASSET_ID_FAILED")

    def test_protocol_violations_emit_error_frame(self):
        cases = [
            # Wrong version
            {"version": 2, "type": "upload", "requestId": REQUEST_ID},
            # Unknown type
            {"version": 1, "type": "unknown_action", "requestId": REQUEST_ID},
            # Invalid requestId format
            {"version": 1, "type": "upload", "requestId": "invalid-req-id"},
            # Unexpected key in upload
            {"version": 1, "type": "upload", "requestId": REQUEST_ID, "extra_key": "injected"},
            # apiKey in recover
            {"version": 1, "type": "recover", "requestId": REQUEST_ID, "baseUrl": "https://api.powertokens.ai", "taskId": "t1", "apiKey": "leak"},
        ]

        for initial in cases:
            stdin_data = (json.dumps(initial) + "\n").encode("utf-8")
            stdin = io.BytesIO(stdin_data)
            stdout = io.StringIO()
            worker.run(stdin=stdin, stdout=stdout, engine_path=self.engine_path)
            lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
            self.assertEqual(lines[0], {"version": 1, "type": "ready"})
            self.assertEqual(lines[-1]["type"], "error")
            self.assertEqual(lines[-1]["code"], "ASSET_UPLOAD_WORKER_FAILED")

    def test_private_sentinel_never_leaked_in_error(self):
        SENTINEL = "PRIVATE_SENTINEL_TOKEN_XYZ_98765"
        initial = {
            "version": 1,
            "type": "upload",
            "requestId": REQUEST_ID,
            "apiKey": SENTINEL,
            "baseUrl": f"https://api.powertokens.ai/{SENTINEL}",  # invalid url path
            "filename": "reference.png",
            "contentBase64": "invalid_base64_???",
            "pollTimeout": 60,
        }

        stdin_data = (json.dumps(initial) + "\n").encode("utf-8")
        stdin = io.BytesIO(stdin_data)
        stdout = io.StringIO()
        worker.run(stdin=stdin, stdout=stdout, engine_path=self.engine_path)
        raw_out = stdout.getvalue()
        self.assertNotIn(SENTINEL, raw_out)
        lines = [json.loads(line) for line in raw_out.splitlines() if line.strip()]
        self.assertEqual(lines[-1]["type"], "error")


if __name__ == "__main__":
    unittest.main()
