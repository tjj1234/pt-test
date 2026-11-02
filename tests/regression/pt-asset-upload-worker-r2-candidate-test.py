"""Regression test suite for PT Asset Upload Worker R2 Candidate (offline, socket blocked)."""
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
WORKER_PATH = ROOT / "shell/media/pt-asset-upload-worker-r2-candidate.py"

# Import worker candidate
worker_spec = importlib.util.spec_from_file_location("asset_worker_r2", WORKER_PATH)
worker = importlib.util.module_from_spec(worker_spec)
worker_spec.loader.exec_module(worker)

REQUEST_ID = "12345678-1234-4123-8123-123456789012"

EXPECTED_UPLOAD_URL = "https://powertokens.ai/api/v1/asset/upload"
EXPECTED_GET_URL_PREFIX = "https://powertokens.ai/api/v1/asset/jobs/get-asset-id?task_id="


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


class WorkerR2RegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Create isolated temporary directory and apply original patch -> main review overlay
        cls._temp_dir = tempfile.mkdtemp(prefix="asset-worker-r2-engine-")
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

    def test_upload_asserts_fixed_vendored_full_url(self):
        content = b"fake-png-content-bytes-12345"
        b64 = base64.b64encode(content).decode("utf-8")
        initial = {
            "version": 1,
            "type": "upload",
            "requestId": REQUEST_ID,
            "apiKey": "PT-SECRET-API-KEY-9999",
            "filename": "reference.png",
            "contentBase64": b64,
            "pollTimeout": 60,
        }

        calls = []
        urls = []
        def transport(req, timeout=None):
            method = req.get_method()
            url = req.full_url
            calls.append(method)
            urls.append((method, url))
            if method == "POST":
                # STRICT ASSERTION: POST must target exact vendored upload endpoint!
                self.assertEqual(url, EXPECTED_UPLOAD_URL, "POST endpoint must match vendored ASSET_UPLOAD")
                return FakeHTTPResponse(b'{"code":200,"data":{"task_id":"task_123"}}')
            # STRICT ASSERTION: GET must target exact vendored get-asset-id endpoint!
            self.assertTrue(url.startswith(EXPECTED_GET_URL_PREFIX), f"GET endpoint must match vendored ASSET_GET_ID: {url}")
            return FakeHTTPResponse(b'{"code":200,"data":{"asset_id":"asset_456"}}')

        output, raw_out = self.execute_worker(initial, ack_count=4, transport=transport)

        # Verify calls and URLs
        self.assertEqual(calls, ["POST", "GET"])
        self.assertEqual(urls[0], ("POST", EXPECTED_UPLOAD_URL))
        self.assertTrue(urls[1][1].startswith(EXPECTED_GET_URL_PREFIX))

        # Event sequence
        events = [f["event"] for f in output if f.get("type") == "event"]
        self.assertEqual(events, ["before_submit", "submission_started", "on_task_id", "on_asset_id"])

        # Result verification
        res = output[-1]["result"]
        self.assertTrue(res["ok"])
        self.assertEqual(res["outcome"], "succeeded")
        self.assertEqual(res["task_id"], "task_123")
        self.assertEqual(res["asset_id"], "asset_456")
        self.assertFalse(res["may_resubmit"])

        # Zero key or raw bytes in stdout
        self.assertNotIn("PT-SECRET-API-KEY-9999", raw_out)
        self.assertNotIn(content.decode("latin1"), raw_out)

    def test_recover_asserts_fixed_vendored_full_url(self):
        initial = {
            "version": 1,
            "type": "recover",
            "requestId": REQUEST_ID,
            "taskId": "task_recovered_789",
            "pollTimeout": 30,
        }

        urls = []
        def transport(req, timeout=None):
            self.assertEqual(req.get_method(), "GET")
            self.assertNotIn("Authorization", req.headers)
            self.assertNotIn("Cookie", req.headers)
            urls.append(req.full_url)
            return FakeHTTPResponse(b'{"code":200,"data":{"asset_id":"asset_recovered_999"}}')

        output, raw_out = self.execute_worker(initial, ack_count=1, transport=transport)

        self.assertEqual(len(urls), 1)
        self.assertTrue(urls[0].startswith(EXPECTED_GET_URL_PREFIX))
        self.assertIn("task_recovered_789", urls[0])

        res = output[-1]["result"]
        self.assertTrue(res["ok"])
        self.assertEqual(res["outcome"], "succeeded")
        self.assertEqual(res["task_id"], "task_recovered_789")
        self.assertEqual(res["asset_id"], "asset_recovered_999")
        self.assertFalse(res["may_resubmit"])

    def test_rejection_of_caller_base_url_zero_post(self):
        # Attempting to supply baseUrl (attacker URL) must be rejected with 0 POST!
        initial = {
            "version": 1,
            "type": "upload",
            "requestId": REQUEST_ID,
            "apiKey": "PT-SECRET-API-KEY-9999",
            "baseUrl": "https://attacker.example.test",
            "filename": "reference.png",
            "contentBase64": base64.b64encode(b"fake").decode("utf-8"),
            "pollTimeout": 60,
        }

        calls = []
        def transport(req, timeout=None):
            calls.append(req.get_method())
            return FakeHTTPResponse(b'{}')

        output, _ = self.execute_worker(initial, ack_count=0, transport=transport)

        self.assertEqual(calls, [], "Providing baseUrl must result in ZERO provider requests")
        self.assertEqual(output[-1]["type"], "error")
        self.assertEqual(output[-1]["code"], "ASSET_UPLOAD_WORKER_FAILED")

    def test_refusal_before_submit_yields_zero_post(self):
        content = b"fake-png-content"
        initial = {
            "version": 1,
            "type": "upload",
            "requestId": REQUEST_ID,
            "apiKey": "PT-SECRET-API-KEY-9999",
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

        self.assertEqual(calls, [])
        res = output[-1]["result"]
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

        self.assertEqual(calls, [])
        res = output[-1]["result"]
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
            "filename": "reference.png",
            "contentBase64": base64.b64encode(content).decode("utf-8"),
            "pollTimeout": 60,
        }

        calls = []
        def transport(req, timeout=None):
            calls.append(req.get_method())
            return FakeHTTPResponse(b'{"code":200,"data":{"task_id":"persisted_task_444"}}')

        output, _ = self.execute_worker(initial, ack_count=3, refused_event=3, transport=transport)

        self.assertEqual(calls, ["POST"])
        res = output[-1]["result"]
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
            "taskId": "known_task_888",
            "pollTimeout": 30,
        }

        calls = []
        def transport(req, timeout=None):
            calls.append(req.get_method())
            return FakeHTTPResponse(b'{"code":200,"data":{"asset_id":"aid_999"}}')

        output, _ = self.execute_worker(initial, ack_count=1, refused_event=1, transport=transport)

        self.assertEqual(calls, ["GET"])
        res = output[-1]["result"]
        self.assertFalse(res["ok"])
        self.assertEqual(res["outcome"], "asset_id_persisting_failed")
        self.assertEqual(res["task_id"], "known_task_888")
        self.assertEqual(res["asset_id"], "aid_999")
        self.assertEqual(res["error_code"], "HOOK_ON_ASSET_ID_FAILED")

    def test_private_sentinel_never_leaked(self):
        SENTINEL = "PRIVATE_SENTINEL_TOKEN_XYZ_98765"
        initial = {
            "version": 1,
            "type": "upload",
            "requestId": REQUEST_ID,
            "apiKey": SENTINEL,
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
