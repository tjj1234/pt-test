#!/usr/bin/env python3
"""
Offline regression tests for PT asset upload hardening and product boundary candidate.
Validates upload_asset_for_product and refactored upload_asset in pt_video.py.

All tests run strictly offline:
- Global socket.connect, connect_ex, create_connection, and getaddrinfo blocked at startup
- Injected transport, sleep, and clock with exact payload and header inspection
- No real network, no real credentials, no filesystem escape
"""

import argparse
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Global offline gate: block all network activity
# ---------------------------------------------------------------------------
def _blocked_network(*args, **kwargs):
    raise RuntimeError("Network access blocked in offline unit tests")

socket.socket.connect = _blocked_network
socket.socket.connect_ex = _blocked_network
socket.create_connection = _blocked_network
socket.getaddrinfo = _blocked_network

# Parse --engine-path before unittest steals argv
_PARSER = argparse.ArgumentParser(add_help=False)
_PARSER.add_argument("--engine-path", default=None)
_KNOWN, _REMAINING = _PARSER.parse_known_args()
sys.argv = [sys.argv[0]] + _REMAINING

ENGINE_PATH = _KNOWN.engine_path

_TEMP_DIR = None


def _get_or_load_engine():
    global _TEMP_DIR
    if ENGINE_PATH and os.path.isfile(ENGINE_PATH):
        path = ENGINE_PATH
    else:
        # Automatically apply patch to a temporary copy of baseline pt_video.py
        _TEMP_DIR = tempfile.mkdtemp(prefix="pt_upload_test_")
        orig_file = os.path.abspath("shell/media/vendor/powertokens_video/pt_video.py")
        patch_file = os.path.abspath("docs/refactor/candidates/pt-asset-upload-product-20261029.patch")
        patched_target = os.path.join(_TEMP_DIR, "pt_video.py")
        shutil.copyfile(orig_file, patched_target)

        import subprocess
        res = subprocess.run(
            ["patch", "-p1", "-i", patch_file],
            cwd=_TEMP_DIR,
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            raise RuntimeError(f"Failed to apply patch to pt_video.py: {res.stderr or res.stdout}")
        path = patched_target

    spec = importlib.util.spec_from_file_location("pt_video_candidate", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pt_video = _get_or_load_engine()


class FakeHTTPResponse:
    def __init__(self, body_bytes, code=200, headers=None):
        self._body = io.BytesIO(body_bytes)
        self.code = code
        self.status = code
        self.headers = headers or {}

    def read(self, n=-1):
        return self._body.read(n)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class TestPtAssetUploadProduct(unittest.TestCase):
    def setUp(self):
        self.valid_key = "pt-test-key-12345"
        self.valid_content = b"\x89PNG\r\n\x1a\nsample png bytes"
        self.valid_filename = "reference.png"

    def tearDown(self):
        pass

    # 1. actual multipart fields, fixed endpoint and Authorization
    def test_01_multipart_fields_and_authorization(self):
        captured_requests = []

        def fake_transport(req, timeout):
            captured_requests.append(req)
            resp_body = json.dumps({"code": 200, "data": {"task_id": "task-test-001"}}).encode()
            return FakeHTTPResponse(resp_body)

        hooks = {}
        # We only run the POST phase and halt via task_id persisting failure
        hooks["on_task_id"] = lambda tid: (_ for _ in ()).throw(RuntimeError("stop_after_post"))

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            filename="my_test_ref.png",
            key=self.valid_key,
            hooks=hooks,
            transport=fake_transport,
        )

        self.assertEqual(len(captured_requests), 1)
        req = captured_requests[0]
        self.assertEqual(req.full_url, pt_video.ASSET_UPLOAD)
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.headers.get("Authorization"), self.valid_key)

        ct = req.headers.get("Content-type")
        self.assertTrue(ct.startswith("multipart/form-data; boundary="))
        boundary = ct.split("boundary=")[1]

        body = req.data
        self.assertIn(f"--{boundary}".encode(), body)
        self.assertIn(b'name="file"; filename="my_test_ref.png"', body)
        self.assertIn(b"Content-Type: application/octet-stream", body)
        self.assertIn(self.valid_content, body)
        self.assertEqual(res["task_id"], "task-test-001")

    # 2. GET query is anonymous: no Authorization, no Cookie
    def test_02_query_is_anonymous(self):
        captured_requests = []

        def fake_transport(req, timeout):
            captured_requests.append(req)
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-test-002"}}).encode())
            else:
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"asset_id": "asset-valid-002"}}).encode())

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport,
        )

        self.assertEqual(res["outcome"], "succeeded")
        self.assertEqual(len(captured_requests), 2)
        get_req = captured_requests[1]
        self.assertEqual(get_req.get_method(), "GET")
        self.assertIsNone(get_req.headers.get("Authorization"))
        self.assertIsNone(get_req.headers.get("Cookie"))
        self.assertIn("get-asset-id?task_id=task-test-002", get_req.full_url)

    # 3. CLI/product shared multipart construction
    def test_03_shared_multipart_builder(self):
        body, ct = pt_video._build_asset_multipart(self.valid_content, "test.jpg", group_name="my_group")
        self.assertTrue(ct.startswith("multipart/form-data; boundary="))
        self.assertIn(b'name="group_name"\r\n\r\nmy_group\r\n', body)
        self.assertIn(b'name="file"; filename="test.jpg"\r\n', body)
        self.assertIn(self.valid_content, body)

    # 4. bytes / filename / boundaries validation
    def test_04_bytes_and_filename_boundaries(self):
        # 0 bytes rejected
        res0 = pt_video.upload_asset_for_product(content=b"", key=self.valid_key)
        self.assertFalse(res0["ok"])
        self.assertEqual(res0["outcome"], "not_submitted")
        self.assertEqual(res0["error_code"], "EMPTY_CONTENT")

        # Non-bytes rejected
        res_nb = pt_video.upload_asset_for_product(content="not-bytes", key=self.valid_key)
        self.assertFalse(res_nb["ok"])
        self.assertEqual(res_nb["outcome"], "not_submitted")

        # Exceeding 5 MiB rejected
        huge = b"x" * (5 * 1024 * 1024 + 1)
        res_huge = pt_video.upload_asset_for_product(content=huge, key=self.valid_key)
        self.assertFalse(res_huge["ok"])
        self.assertEqual(res_huge["outcome"], "not_submitted")
        self.assertEqual(res_huge["error_code"], "CONTENT_SIZE_EXCEEDED")

        # Filename with path traversal rejected
        res_trav = pt_video.upload_asset_for_product(content=self.valid_content, filename="../evil.png", key=self.valid_key)
        self.assertFalse(res_trav["ok"])
        self.assertEqual(res_trav["outcome"], "not_submitted")
        self.assertEqual(res_trav["error_code"], "INVALID_FILENAME")

        # Filename with CRLF rejected
        res_crlf = pt_video.upload_asset_for_product(content=self.valid_content, filename="evil\r\n.png", key=self.valid_key)
        self.assertFalse(res_crlf["ok"])
        self.assertEqual(res_crlf["outcome"], "not_submitted")
        self.assertEqual(res_crlf["error_code"], "INVALID_FILENAME")

    # 5. before_submit failure -> exactly 0 POST made
    def test_05_hook_before_submit_order_and_zero_post(self):
        post_count = 0

        def fake_transport(req, timeout):
            nonlocal post_count
            post_count += 1
            return FakeHTTPResponse(b"{}")

        def bad_before_submit(details):
            self.assertEqual(details["byte_count"], len(self.valid_content))
            raise RuntimeError("Database connection down")

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            hooks={"before_submit": bad_before_submit},
            transport=fake_transport,
        )

        self.assertEqual(post_count, 0)
        self.assertEqual(res["outcome"], "not_submitted")
        self.assertFalse(res["submission_may_have_started"])
        self.assertEqual(res["error_code"], "HOOK_BEFORE_SUBMIT_FAILED")

    # 6. submission_started failure -> exactly 0 POST made
    def test_06_hook_submission_started_order_and_zero_post(self):
        post_count = 0

        def fake_transport(req, timeout):
            nonlocal post_count
            post_count += 1
            return FakeHTTPResponse(b"{}")

        def bad_submission_started():
            raise RuntimeError("Transaction rollback")

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            hooks={"submission_started": bad_submission_started},
            transport=fake_transport,
        )

        self.assertEqual(post_count, 0)
        self.assertEqual(res["outcome"], "not_submitted")
        self.assertFalse(res["submission_may_have_started"])
        self.assertEqual(res["error_code"], "HOOK_SUBMISSION_STARTED_FAILED")

    # 7. POST network failure -> exactly 1 POST made, unknown_submission
    def test_07_post_network_disconnect(self):
        post_count = 0

        def fake_transport(req, timeout):
            nonlocal post_count
            post_count += 1
            raise urllib.error.URLError("Connection reset by peer")

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport,
        )

        self.assertEqual(post_count, 1)
        self.assertEqual(res["outcome"], "unknown_submission")
        self.assertTrue(res["submission_may_have_started"])
        self.assertFalse(res["may_resubmit"])

    # 8. POST HTTP 5xx or 408 -> unknown_submission
    def test_08_post_http_500_502_503_408(self):
        for code in (500, 502, 503, 408, 429):
            def fake_transport(req, timeout):
                raise urllib.error.HTTPError(req.full_url, code, f"HTTP {code}", {}, io.BytesIO(b"server error"))

            res = pt_video.upload_asset_for_product(
                content=self.valid_content,
                key=self.valid_key,
                transport=fake_transport,
            )

            self.assertEqual(res["outcome"], "unknown_submission")
            self.assertTrue(res["submission_may_have_started"])

    # 9. POST HTTP 400 or 403 -> upstream rejected
    def test_09_post_http_400_rejected(self):
        def fake_transport(req, timeout):
            raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, io.BytesIO(b'{"code":400}'))

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport,
        )

        self.assertEqual(res["outcome"], "rejected")
        self.assertTrue(res["submission_may_have_started"])

    # 10. POST malformed JSON response -> unknown_submission
    def test_10_post_malformed_json(self):
        def fake_transport(req, timeout):
            return FakeHTTPResponse(b"<!DOCTYPE html><html>gateway timeout</html>")

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport,
        )

        self.assertEqual(res["outcome"], "unknown_submission")
        self.assertEqual(res["error_code"], "MALFORMED_JSON_RESPONSE")

    # 11. POST missing or invalid task_id -> unknown_submission
    def test_11_post_missing_or_invalid_task_id(self):
        # Missing task_id
        def fake_transport1(req, timeout):
            return FakeHTTPResponse(json.dumps({"code": 200, "data": {}}).encode())

        res1 = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport1,
        )
        self.assertEqual(res1["outcome"], "unknown_submission")

        # Invalid task_id format
        def fake_transport2(req, timeout):
            return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "invalid id with spaces"}}).encode())

        res2 = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport2,
        )
        self.assertEqual(res2["outcome"], "unknown_submission")

    # 12. on_task_id failure halts execution: retains task_id, 0 GET queries made
    def test_12_on_task_id_failure_halts_polling(self):
        get_count = 0

        def fake_transport(req, timeout):
            nonlocal get_count
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-halt-012"}}).encode())
            get_count += 1
            return FakeHTTPResponse(b"{}")

        def bad_on_task_id(tid):
            self.assertEqual(tid, "task-halt-012")
            raise RuntimeError("Database crash during task_id commit")

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            hooks={"on_task_id": bad_on_task_id},
            transport=fake_transport,
        )

        self.assertEqual(res["outcome"], "task_id_persisting_failed")
        self.assertEqual(res["task_id"], "task-halt-012")
        self.assertEqual(get_count, 0)
        self.assertTrue(res["submission_may_have_started"])

    # 13. pending -> asset_id success workflow
    def test_13_pending_to_asset_success(self):
        poll_step = 0

        def fake_transport(req, timeout):
            nonlocal poll_step
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-poll-013"}}).encode())
            poll_step += 1
            if poll_step < 3:
                # Pending: no asset_id yet
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"status": "processing"}}).encode())
            return FakeHTTPResponse(json.dumps({"code": 200, "data": {"asset_id": "asset-final-013"}}).encode())

        sleep_count = 0
        def fake_sleep(dur):
            nonlocal sleep_count
            sleep_count += 1

        persisted_aid = None
        def record_aid(aid):
            nonlocal persisted_aid
            persisted_aid = aid

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            hooks={"on_asset_id": record_aid},
            transport=fake_transport,
            sleep=fake_sleep,
        )

        self.assertTrue(res["ok"])
        self.assertEqual(res["outcome"], "succeeded")
        self.assertEqual(res["task_id"], "task-poll-013")
        self.assertEqual(res["asset_id"], "asset-final-013")
        self.assertEqual(persisted_aid, "asset-final-013")
        self.assertEqual(sleep_count, 2)

    # 14. failure envelope with asset_id rejected
    def test_14_error_envelope_with_asset_id_rejected(self):
        def fake_transport(req, timeout):
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-err-014"}}).encode())
            # GET returns code != 200 even though data has asset_id
            return FakeHTTPResponse(json.dumps({
                "code": 400,
                "message": "Task failed",
                "data": {"asset_id": "fake-asset-id"},
            }).encode())

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport,
        )

        self.assertFalse(res["ok"])
        self.assertEqual(res["outcome"], "get_asset_id_rejected")
        self.assertIsNone(res["asset_id"])

    # 15. GET HTTP error retries until success
    def test_15_get_http_error_retries_until_success(self):
        poll_step = 0

        def fake_transport(req, timeout):
            nonlocal poll_step
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-retry-015"}}).encode())
            poll_step += 1
            if poll_step == 1:
                raise urllib.error.HTTPError(req.full_url, 502, "Bad Gateway", {}, io.BytesIO(b"502"))
            return FakeHTTPResponse(json.dumps({"code": 200, "data": {"asset_id": "asset-retry-015"}}).encode())

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport,
            sleep=lambda s: None,
        )

        self.assertTrue(res["ok"])
        self.assertEqual(res["asset_id"], "asset-retry-015")

    # 16. GET oversized response rejected
    def test_16_get_oversized_response_rejected(self):
        def fake_transport(req, timeout):
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-oversize-016"}}).encode())
            # Response larger than 128 KiB
            huge_body = b"{" + b'"k":"' + b"x" * (128 * 1024 + 50) + b'"}'
            return FakeHTTPResponse(huge_body)

        clock_val = 0.0
        def fake_clock():
            nonlocal clock_val
            clock_val += 10.0
            return clock_val

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport,
            clock=fake_clock,
            sleep=lambda s: None,
            poll_timeout=30,
        )

        self.assertFalse(res["ok"])

    # 17. asset_id format validation
    def test_17_asset_id_format_validation(self):
        # Invalid format: contains spaces or special chars
        def fake_transport(req, timeout):
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-fmt-017"}}).encode())
            return FakeHTTPResponse(json.dumps({"code": 200, "data": {"asset_id": "bad asset id with spaces!"}}).encode())

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport,
        )

        self.assertFalse(res["ok"])
        self.assertEqual(res["outcome"], "get_asset_id_failed")
        self.assertIsNone(res["asset_id"])

    # 18. monotonic clock timeout terminates cleanly
    def test_18_monotonic_timeout(self):
        current_time = 100.0

        def fake_clock():
            return current_time

        def fake_sleep(dur):
            nonlocal current_time
            current_time += 15.0

        def fake_transport(req, timeout):
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-timeout-018"}}).encode())
            return FakeHTTPResponse(json.dumps({"code": 200, "data": {"status": "pending"}}).encode())

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport,
            clock=fake_clock,
            sleep=fake_sleep,
            poll_timeout=30,
        )

        self.assertEqual(res["outcome"], "poll_timeout")
        self.assertEqual(res["task_id"], "task-timeout-018")
        self.assertIsNone(res["asset_id"])

    # 19. late success does not wipe timeout
    def test_19_late_success_does_not_override_timeout(self):
        current_time = 0.0

        def fake_clock():
            return current_time

        def fake_transport(req, timeout):
            nonlocal current_time
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-late-019"}}).encode())
            # Advance clock past deadline inside transport read
            current_time = 200.0
            return FakeHTTPResponse(json.dumps({"code": 200, "data": {"asset_id": "late-asset-019"}}).encode())

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            transport=fake_transport,
            clock=fake_clock,
            sleep=lambda s: None,
            poll_timeout=30,
        )

        self.assertEqual(res["outcome"], "poll_timeout")
        self.assertEqual(res["task_id"], "task-late-019")
        self.assertFalse(res["ok"])

    # 20. cancellation before POST
    def test_20_cancellation_before_post(self):
        cancelled = True
        post_count = 0

        def fake_transport(req, timeout):
            nonlocal post_count
            post_count += 1
            return FakeHTTPResponse(b"{}")

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            cancel_token=lambda: cancelled,
            transport=fake_transport,
        )

        self.assertEqual(res["outcome"], "cancelled")
        self.assertEqual(post_count, 0)
        self.assertFalse(res["submission_may_have_started"])

    # 21. cancellation during polling retains task_id
    def test_21_cancellation_during_polling(self):
        is_canc = False

        def fake_transport(req, timeout):
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-canc-021"}}).encode())
            return FakeHTTPResponse(json.dumps({"code": 200, "data": {"status": "pending"}}).encode())

        def fake_sleep(dur):
            nonlocal is_canc
            is_canc = True

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            cancel_token=lambda: is_canc,
            transport=fake_transport,
            sleep=fake_sleep,
        )

        self.assertEqual(res["outcome"], "cancelled")
        self.assertEqual(res["task_id"], "task-canc-021")
        self.assertTrue(res["submission_may_have_started"])

    # 22. NoRedirectHandler intercepts redirects
    def test_22_no_redirect_handler_intercepts_redirects(self):
        handler = pt_video._NoRedirectHandler()
        res = handler.redirect_request(None, None, 302, "Found", {}, "http://evil.com")
        self.assertIsNone(res, "redirect_request must return None to prohibit automatic redirects")

    # 23. on_asset_id failure retains both task_id and asset_id for recovery
    def test_23_on_asset_id_failure_retains_ids_for_recovery(self):
        def fake_transport(req, timeout):
            if req.get_method() == "POST":
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-recov-023"}}).encode())
            return FakeHTTPResponse(json.dumps({"code": 200, "data": {"asset_id": "asset-recov-023"}}).encode())

        def failing_on_asset_id(aid):
            raise RuntimeError("Database out of disk space during asset_id persistence")

        res = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            hooks={"on_asset_id": failing_on_asset_id},
            transport=fake_transport,
        )

        self.assertFalse(res["ok"])
        self.assertEqual(res["outcome"], "asset_id_persisting_failed")
        self.assertEqual(res["task_id"], "task-recov-023")
        self.assertEqual(res["asset_id"], "asset-recov-023")
        self.assertEqual(res["error_code"], "HOOK_ON_ASSET_ID_FAILED")

    # 24. PRIVATE_SENTINEL never leaked in errors, results or exceptions
    def test_24_private_sentinel_never_leaked(self):
        SENTINEL = "PRIVATE_SENTINEL_SECRET_TOKEN_XYZ98765"

        # Sentinel in key
        res_key = pt_video.upload_asset_for_product(content=self.valid_content, key=f"invalid\n{SENTINEL}")
        self.assertNotIn(SENTINEL, str(res_key))
        self.assertNotIn("PRIVATE_SENTINEL", str(res_key))

        # Sentinel in filename
        res_fn = pt_video.upload_asset_for_product(content=self.valid_content, filename=f"bad/{SENTINEL}", key=self.valid_key)
        self.assertNotIn(SENTINEL, str(res_fn))
        self.assertNotIn("PRIVATE_SENTINEL", str(res_fn))

        # Sentinel in hook exception
        def evil_hook(d):
            raise RuntimeError(f"Crashing with {SENTINEL}")

        res_hk = pt_video.upload_asset_for_product(
            content=self.valid_content,
            key=self.valid_key,
            hooks={"before_submit": evil_hook},
        )
        self.assertNotIn(SENTINEL, str(res_hk))
        self.assertNotIn("PRIVATE_SENTINEL", str(res_hk))

    # 25. CLI upload_asset backward compatibility
    def test_25_cli_upload_asset_backward_compatibility(self):
        tmp_file = tempfile.NamedTemporaryFile(delete=False)
        try:
            tmp_file.write(self.valid_content)
            tmp_file.close()

            # Mock upload_asset_for_product internally during upload_asset call
            orig_func = pt_video.upload_asset_for_product
            try:
                pt_video.upload_asset_for_product = lambda **kwargs: {
                    "ok": True,
                    "asset_id": "asset-cli-compat-025",
                }
                aid = pt_video.upload_asset(self.valid_key, tmp_file.name)
                self.assertEqual(aid, "asset-cli-compat-025")

                # Failure test
                pt_video.upload_asset_for_product = lambda **kwargs: {
                    "ok": False,
                    "outcome": "rejected",
                    "error_code": "HTTP_400",
                }
                with self.assertRaises(pt_video.ApiError):
                    pt_video.upload_asset(self.valid_key, tmp_file.name)
            finally:
                pt_video.upload_asset_for_product = orig_func
        finally:
            os.unlink(tmp_file.name)

    # 26. CLI upload_asset with group_name
    def test_26_cli_upload_asset_with_group_name(self):
        tmp_file = tempfile.NamedTemporaryFile(delete=False)
        try:
            tmp_file.write(self.valid_content)
            tmp_file.close()

            captured = []
            def fake_opener_open(req, timeout):
                captured.append(req)
                if req.get_method() == "POST":
                    return FakeHTTPResponse(json.dumps({"code": 200, "data": {"task_id": "task-grp-026"}}).encode())
                return FakeHTTPResponse(json.dumps({"code": 200, "data": {"asset_id": "asset-grp-026"}}).encode())

            orig_opener = pt_video._ASSET_NO_REDIRECT_OPENER
            class FakeOpener:
                def open(self, req, timeout):
                    return fake_opener_open(req, timeout)

            pt_video._ASSET_NO_REDIRECT_OPENER = FakeOpener()
            try:
                aid = pt_video.upload_asset(self.valid_key, tmp_file.name, group_name="special_grp")
                self.assertEqual(aid, "asset-grp-026")
                self.assertIn(b'name="group_name"\r\n\r\nspecial_grp\r\n', captured[0].data)
            finally:
                pt_video._ASSET_NO_REDIRECT_OPENER = orig_opener
        finally:
            os.unlink(tmp_file.name)

    # 27. may_resubmit is strictly False across all outcomes
    def test_27_may_resubmit_is_always_false(self):
        # 1. not_submitted
        r1 = pt_video.upload_asset_for_product(content=b"", key=self.valid_key)
        self.assertFalse(r1["may_resubmit"])

        # 2. unknown_submission
        def fake_t(req, timeout):
            raise urllib.error.URLError("timeout")
        r2 = pt_video.upload_asset_for_product(content=self.valid_content, key=self.valid_key, transport=fake_t)
        self.assertFalse(r2["may_resubmit"])


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        if _TEMP_DIR and os.path.isdir(_TEMP_DIR):
            shutil.rmtree(_TEMP_DIR, ignore_errors=True)
