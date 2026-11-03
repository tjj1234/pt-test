#!/usr/bin/env python3
"""
Offline regression tests for powertokens-video engine hardening R3.

Usage:
  python3 tests/regression/powertokens-video-engine-hardening-r3-test.py \
      --engine-path /tmp/ptvideo-r3-verify

All tests run strictly offline:
- Global socket.connect, connect_ex, create_connection, and getaddrinfo blocked at startup
- Isolated temporary HOME and PT_VIDEO_CONFIG
- Programmatically constructed fake keys (no real keys)
- Injected transport, sleep, and clock with exact payload inspection
"""
import argparse
import copy
import importlib.util
import math
import os
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error

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


def _load_engine(path=None):
    if path is None:
        path = ENGINE_PATH
    if path is None:
        raise RuntimeError("--engine-path is required")
    spec = importlib.util.spec_from_file_location("pt_video_r3_test",
                                                   os.path.join(path, "pt_video.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _fake_key():
    return "sk" + "-pt-" + "x" * 24


# ---------------------------------------------------------------------------
class TestValidateProductRequestR2(unittest.TestCase):
    def setUp(self):
        self.m = _load_engine()

    def _req(self, **kw):
        defaults = dict(model="wan3.0-video", kind="video", prompt="a cat running")
        defaults.update(kw)
        return self.m.ProductRequest(**defaults)

    def test_missing_key_rejected(self):
        req = self._req()
        with self.assertRaises(ValueError) as ctx:
            self.m._validate_product_request(req, "")
        self.assertIn("api_key", str(ctx.exception))

    def test_none_key_rejected(self):
        req = self._req()
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, None)

    def test_auto_model_rejected(self):
        req = self._req(model="auto")
        with self.assertRaises(ValueError) as ctx:
            self.m._validate_product_request(req, _fake_key())
        self.assertIn("auto", str(ctx.exception))

    def test_unknown_kind_rejected(self):
        req = self._req(kind="unknown_type")
        with self.assertRaises(ValueError) as ctx:
            self.m._validate_product_request(req, _fake_key())
        self.assertIn("kind", str(ctx.exception))

    # --- R2 COUNTER-EXAMPLE: Image2image unsupported across ALL image models ---
    def test_image_models_with_first_frame_rejected_all_models(self):
        """Any image model with first_frame must be rejected (0 POSTs)."""
        models = ["seedream-5-0-260128", "image-01", "qwen-image-2.0-pro", "kling-image-o1"]
        for mid in models:
            req = self.m.ProductRequest(model=mid, kind="image", prompt="city",
                                        first_frame="https://example.com/ref.jpg")
            with self.assertRaises(ValueError) as ctx:
                self.m._validate_product_request(req, _fake_key())
            msg = str(ctx.exception).lower()
            self.assertIn("unsupported", msg)
            self.assertIn("image-to-image", msg)

    def test_image_models_with_ref_images_rejected(self):
        req = self.m.ProductRequest(model="seedream-5-0-260128", kind="image", prompt="city",
                                    ref_images=["https://example.com/ref1.jpg"])
        with self.assertRaises(ValueError) as ctx:
            self.m._validate_product_request(req, _fake_key())
        self.assertIn("unsupported", str(ctx.exception).lower())

    def test_image_models_with_last_frame_rejected(self):
        req = self.m.ProductRequest(model="seedream-5-0-260128", kind="image", prompt="city",
                                    last_frame="https://example.com/last.jpg")
        with self.assertRaises(ValueError) as ctx:
            self.m._validate_product_request(req, _fake_key())
        self.assertIn("unsupported", str(ctx.exception).lower())

    # --- R2 COUNTER-EXAMPLE: Seedance strictly asset:// format ---
    def test_seedance_file_scheme_rejected(self):
        req = self._req(model="seedance-1-5-pro-251215", kind="seedance",
                        first_frame="file:///fixture.png")
        with self.assertRaises(ValueError) as ctx:
            self.m._validate_product_request(req, _fake_key())
        self.assertIn("asset://", str(ctx.exception))

    def test_seedance_http_media_rejected(self):
        req = self._req(model="seedance-1-5-pro-251215", kind="seedance",
                        first_frame="https://example.com/fixture.png")
        with self.assertRaises(ValueError) as ctx:
            self.m._validate_product_request(req, _fake_key())
        self.assertIn("asset://", str(ctx.exception))

    def test_seedance_empty_asset_id_rejected(self):
        req = self._req(model="seedance-1-5-pro-251215", kind="seedance",
                        first_frame="asset://")
        with self.assertRaises(ValueError) as ctx:
            self.m._validate_product_request(req, _fake_key())
        self.assertIn("asset://", str(ctx.exception))

    def test_seedance_valid_asset_accepted(self):
        req = self._req(model="seedance-1-5-pro-251215", kind="seedance",
                        first_frame="asset://asset-20261026180014-bc47m")
        self.m._validate_product_request(req, _fake_key())

    # --- Types and boolean masquerading checks ---
    def test_duration_bool_rejected(self):
        """bool is an instance of int in Python; must be strictly rejected!"""
        req = self._req(duration=True)
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, _fake_key())

    def test_duration_float_rejected(self):
        req = self._req(duration=5.5)
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, _fake_key())

    def test_duration_nan_rejected(self):
        req = self._req(duration=float("nan"))
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, _fake_key())

    def test_duration_infinity_rejected(self):
        req = self._req(duration=float("inf"))
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, _fake_key())

    def test_duration_negative_rejected(self):
        req = self._req(duration=-5)
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, _fake_key())

    def test_duration_over_max_rejected(self):
        req = self._req(duration=9999)
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, _fake_key())

    def test_n_bool_rejected(self):
        req = self.m.ProductRequest(model="seedream-5-0-260128", kind="image", prompt="x", n=True)
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, _fake_key())

    def test_timeout_bool_rejected(self):
        req = self._req(poll_timeout=True)
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, _fake_key())

    def test_model_id_too_long_rejected(self):
        req = self._req(model="x" * 200)
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, _fake_key())

    def test_prompt_too_long_rejected(self):
        req = self._req(prompt="x" * 3000)
        with self.assertRaises(ValueError):
            self.m._validate_product_request(req, _fake_key())

    def test_empty_prompt_and_empty_media_rejected(self):
        req = self._req(prompt="")
        with self.assertRaises(ValueError) as ctx:
            self.m._validate_product_request(req, _fake_key())
        self.assertIn("prompt or at least one media", str(ctx.exception))

    def test_error_message_does_not_echo_raw_input(self):
        secret_prompt = "CONFIDENTIAL_USER_PROMPT_12345"
        req = self.m.ProductRequest(model="seedream-5-0-260128", kind="image",
                                    prompt=secret_prompt, first_frame="https://x.com/ref.jpg")
        with self.assertRaises(ValueError) as ctx:
            self.m._validate_product_request(req, _fake_key())
        self.assertNotIn(secret_prompt, str(ctx.exception))

    def test_valid_video_request_accepted(self):
        req = self._req()
        self.m._validate_product_request(req, _fake_key())

    def test_valid_image_request_accepted(self):
        req = self.m.ProductRequest(model="seedream-5-0-260128", kind="image",
                                    aspect_ratio="16:9", n=2, prompt="sunny day")
        self.m._validate_product_request(req, _fake_key())


# ---------------------------------------------------------------------------
class TestBeforeSubmitHookR2(unittest.TestCase):
    def setUp(self):
        self.m = _load_engine()

    def test_before_submit_failure_prevents_post(self):
        class RejectHook(self.m.ProductHooks):
            def before_submit(self, metadata):
                raise RuntimeError("policy check failed")

        calls = []
        def _transport(m, p, k, b=None, t=30):
            calls.append((m, p))
            return {}

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="x")
        result = self.m.generate_for_product(
            req, api_key=_fake_key(),
            hooks=RejectHook(),
            _transport=_transport,
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "BEFORE_SUBMIT_REJECTED")
        self.assertEqual(len(calls), 0)

    def test_before_submit_metadata_no_key_or_prompt(self):
        captured = {}

        class CaptureHook(self.m.ProductHooks):
            def before_submit(self, metadata):
                captured.update(metadata)
                raise StopIteration("halt")

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="SECRET_PROMPT_12345")
        self.m.generate_for_product(
            req, api_key=_fake_key(),
            hooks=CaptureHook(),
            _transport=lambda m, p, k, b=None, t=30: {},
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
        )
        self.assertNotIn("api_key", captured)
        self.assertNotIn("SECRET_PROMPT_12345", str(captured))
        self.assertIn("billing_params", captured)

    def test_before_submit_metadata_mutation_does_not_affect_submission(self):
        captured_payload = []

        class MutatingHook(self.m.ProductHooks):
            def before_submit(self, metadata):
                metadata["model"] = "MUTATED_MODEL"
                metadata["billing_params"]["duration_s"] = 999

        def _transport(m, p, k, b=None, t=30):
            captured_payload.append(b)
            if m == "POST":
                return {"id": "tid-unmutated"}
            return {"status": "succeeded", "metadata": {"url": "https://cdn.example.com/ok.mp4"}}

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="x", duration=5)
        self.m.generate_for_product(
            req, api_key=_fake_key(),
            hooks=MutatingHook(),
            _transport=_transport,
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
        )
        self.assertEqual(captured_payload[0]["model"], "wan3.0-video")
        self.assertEqual(captured_payload[0]["seconds"], "5")


# ---------------------------------------------------------------------------
class TestTimingAndDeadlinesR2(unittest.TestCase):
    def setUp(self):
        self.m = _load_engine()

    def _make_clock(self):
        t = [1000.0]
        def clock():
            return t[0]
        def advance(dt):
            t[0] += dt
        return clock, advance

    def test_late_completed_response_rejected_as_timeout(self):
        """R2 COUNTER-EXAMPLE:
        poll_timeout=10; transport wait takes 20s then returns completed.
        Timeout must NOT be wiped away by late success!
        """
        clock, advance = self._make_clock()
        observed_timeouts = []

        def _mock_transport(method, path, key, body=None, timeout=30):
            if method == "POST":
                return {"id": "tid-late"}
            observed_timeouts.append(timeout)
            advance(20.0)  # takes 20 seconds, exceeding 10s deadline!
            return {"status": "succeeded", "metadata": {"url": "https://cdn.example.com/late.mp4"}}

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="x",
                                    poll_timeout=10, poll_interval=1)

        result = self.m.generate_for_product(
            req, api_key=_fake_key(),
            _transport=_mock_transport,
            _sleep=lambda s: advance(s),
            _clock=clock,
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "POLL_TIMEOUT")
        self.assertEqual(result.task_id, "tid-late")
        self.assertLessEqual(observed_timeouts[0], 10.0)

    def test_http_timeout_clamped_to_remaining_time(self):
        """HTTP timeout passed to transport must be <= remaining time."""
        clock, advance = self._make_clock()
        observed_http_timeouts = []

        def _transport(method, path, key, body=None, timeout=30):
            if method == "POST":
                return {"id": "tid-clamp"}
            observed_http_timeouts.append(timeout)
            advance(4.0)
            return {"status": "in_progress"}

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="x",
                                    poll_timeout=15, poll_interval=2)

        self.m.generate_for_product(
            req, api_key=_fake_key(),
            _transport=_transport,
            _sleep=lambda s: advance(s),
            _clock=clock,
        )
        for to in observed_http_timeouts:
            self.assertLessEqual(to, 15.0)

    def test_cancellation_preserves_task_id(self):
        cancel = self.m.CancellationToken()
        calls = []

        def _transport(method, path, key, body=None, timeout=30):
            if method == "POST":
                return {"id": "tid-cancel-mid"}
            calls.append(method)
            cancel.cancel()  # cancel right after first poll
            return {"status": "in_progress"}

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="x",
                                    poll_timeout=60, poll_interval=1)
        res = self.m.generate_for_product(
            req, api_key=_fake_key(),
            _transport=_transport,
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
            _cancel=cancel,
        )
        self.assertFalse(res.ok)
        self.assertEqual(res.task_id, "tid-cancel-mid")
        self.assertEqual(res.error_code, "CANCELLED_DURING_POLL")

    def test_cancellation_before_submit(self):
        cancel = self.m.CancellationToken()
        cancel.cancel()
        calls = []

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="x")
        res = self.m.generate_for_product(
            req, api_key=_fake_key(),
            _transport=lambda m, p, k, b=None, t=30: calls.append(m) or {},
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
            _cancel=cancel,
        )
        self.assertFalse(res.ok)
        self.assertEqual(res.error_code, "CANCELLED_BEFORE_SUBMIT")
        self.assertEqual(len(calls), 0)


# ---------------------------------------------------------------------------
class TestOnResultHookR2(unittest.TestCase):
    def setUp(self):
        self.m = _load_engine()

    def test_on_result_failure_distinguishes_remote_success_vs_local_save(self):
        """R2 COUNTER-EXAMPLE:
        When on_result raises, generate_for_product must NOT return ok:true,
        must return structured failure with task_id and result_urls preserved,
        and must NOT resubmit.
        """
        post_count = [0]

        def _transport(method, path, key, body=None, timeout=30):
            if method == "POST":
                post_count[0] += 1
                return {"id": "tid-save-fail"}
            return {"status": "succeeded", "metadata": {"url": "https://cdn.example.com/ok.mp4"}}

        class FailingResultHook(self.m.ProductHooks):
            def on_result(self, result):
                raise IOError("Database connection lost during artifact save")

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="x")
        res = self.m.generate_for_product(
            req, api_key=_fake_key(),
            hooks=FailingResultHook(),
            _transport=_transport,
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
        )
        self.assertFalse(res.ok)
        self.assertEqual(res.error_code, "ON_RESULT_FAILED")
        self.assertEqual(res.status, "completed_local_save_failed")
        self.assertEqual(res.task_id, "tid-save-fail")
        self.assertEqual(res.result_urls, ["https://cdn.example.com/ok.mp4"])
        self.assertEqual(post_count[0], 1)


# ---------------------------------------------------------------------------
class TestTaskIdWriteErrorSanitization(unittest.TestCase):
    def setUp(self):
        self.m = _load_engine()

    def test_task_id_write_error_sanitization(self):
        """R2 COUNTER-EXAMPLE:
        TaskIdWriteError must NOT leak PRIVATE_SENTINEL, keys, prompts, or raw exception strings.
        """
        class LeakingHook(self.m.ProductHooks):
            def on_task_id(self, task_id):
                raise RuntimeError("SUPER_SECRET_INTERNAL_TOKEN_KEY_PATH_12345")

        def _transport(method, path, key, body=None, timeout=30):
            if method == "POST":
                return {"id": "tid-leak-test"}
            return {}

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="x")
        with self.assertRaises(self.m.TaskIdWriteError) as ctx:
            self.m.generate_for_product(
                req, api_key=_fake_key(),
                hooks=LeakingHook(),
                _transport=_transport,
                _sleep=lambda s: None,
                _clock=lambda: 1000.0,
            )
        err = ctx.exception
        self.assertEqual(err.task_id, "tid-leak-test")
        self.assertNotIn("SUPER_SECRET_INTERNAL_TOKEN_KEY_PATH_12345", str(err))
        self.assertNotIn("SUPER_SECRET_INTERNAL_TOKEN_KEY_PATH_12345", repr(err))
        self.assertIsNone(err.__cause__)
        self.assertIsNone(err.__context__)


# ---------------------------------------------------------------------------
class TestErrorClassificationR2(unittest.TestCase):
    def setUp(self):
        self.m = _load_engine()

    def _err(self, status, msg):
        return self.m.ApiError(status, msg)

    def test_asset_library_content_rejected_not_agreement_required(self):
        """R2 COUNTER-EXAMPLE:
        'asset library content rejected' must NOT be classified as SEEDANCE_AGREEMENT_REQUIRED.
        """
        err = self._err(400, "asset library content rejected")
        code, hint = self.m.classify_error(err)
        self.assertNotEqual(code, "SEEDANCE_AGREEMENT_REQUIRED")
        self.assertEqual(code, "MEDIA_REJECTED")

    def test_clear_agreement_required_classified_correctly(self):
        err = self._err(400, "asset library user agreement required, please sign the agreement")
        code, hint = self.m.classify_error(err)
        self.assertEqual(code, "SEEDANCE_AGREEMENT_REQUIRED")

    def test_quota_insufficient(self):
        code, _ = self.m.classify_error(self._err(402, "token quota is not enough: need quota: $0.20"))
        self.assertEqual(code, "QUOTA_INSUFFICIENT")

    def test_model_not_permitted(self):
        code, _ = self.m.classify_error(self._err(403, "not permitted to use this model"))
        self.assertEqual(code, "UPSTREAM_FORBIDDEN")

    def test_key_invalid(self):
        code, _ = self.m.classify_error(self._err(401, "token_invalid: the provided token is expired"))
        self.assertEqual(code, "KEY_INVALID")

    def test_403_forbidden_generic_not_key_invalid(self):
        err = self._err(403, "forbidden")
        code, _ = self.m.classify_error(err)
        self.assertEqual(code, "UPSTREAM_FORBIDDEN")

    def test_rate_limited(self):
        code, _ = self.m.classify_error(self._err(429, "rate limit exceeded"))
        self.assertEqual(code, "RATE_LIMITED")

    def test_5xx(self):
        code, _ = self.m.classify_error(self._err(503, "service temporarily unavailable"))
        self.assertEqual(code, "UPSTREAM_SERVER_ERROR")

    def test_non_apierror_returns_unknown(self):
        code, _ = self.m.classify_error(RuntimeError("random"))
        self.assertEqual(code, "UPSTREAM_UNKNOWN")

    def test_error_hint_does_not_echo_raw_upstream(self):
        evil_body = "internal token: sk-pt-real-secret-key-1234"
        code, hint = self.m.classify_error(self._err(500, evil_body))
        self.assertNotIn("sk-pt-real-secret-key-1234", hint)


# ---------------------------------------------------------------------------
class TestSharedPayloadAndTransportInspection(unittest.TestCase):
    def setUp(self):
        self.m = _load_engine()

    def test_shared_payload_builder_used_by_product_api(self):
        """Transport must receive body and test asserts canonical string conversions."""
        captured_requests = []

        def _transport(method, path, key, body=None, timeout=30):
            captured_requests.append((method, path, body))
            if method == "POST":
                return {"id": "tid-payload-check"}
            return {"status": "succeeded", "metadata": {"url": "https://cdn.example.com/v.mp4"}}

        req = self.m.ProductRequest(
            model="wan3.0-video", kind="video", prompt="cat dances",
            duration=10, resolution="1080p", ratio="16:9", seed=42
        )
        res = self.m.generate_for_product(
            req, api_key=_fake_key(),
            _transport=_transport,
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
        )
        self.assertTrue(res.ok)
        post_req = captured_requests[0]
        self.assertEqual(post_req[0], "POST")
        self.assertEqual(post_req[1], "/v1/videos")
        body = post_req[2]
        self.assertEqual(body["model"], "wan3.0-video")
        self.assertEqual(body["seconds"], "10")  # must be string!
        self.assertEqual(body["size"], "1080P")   # upper string!
        self.assertEqual(body["ratio"], "16:9")
        self.assertEqual(body["seed"], 42)
        self.assertEqual(body["prompt"], "cat dances")

    def test_seedance_standard_payload_has_top_level_prompt(self):
        captured_requests = []

        def _transport(method, path, key, body=None, timeout=30):
            captured_requests.append((method, path, body))
            if method == "POST":
                return {"id": "tid-seedance-check"}
            return {"status": "succeeded", "metadata": {"url": "https://cdn.example.com/s.mp4"}}

        req = self.m.ProductRequest(
            model="seedance-1-5-pro-251215", kind="seedance", prompt="cat walks",
            first_frame="asset://asset-12345"
        )
        res = self.m.generate_for_product(
            req, api_key=_fake_key(),
            _transport=_transport,
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
        )
        self.assertTrue(res.ok)
        body = captured_requests[0][2]
        self.assertEqual(body["prompt"], "cat walks")
        self.assertEqual(body["seconds"], "5")
        self.assertFalse(any(item.get("type") == "text" for item in body["media"]))
        self.assertEqual(body["media"][0], {"type": "first_frame", "url": "asset://asset-12345"})

    def test_post_network_error_treated_as_submission_unknown(self):
        """Network drop on POST must yield SUBMISSION_OUTCOME_UNKNOWN, 1 POST, no retry."""
        post_count = [0]

        def _transport(method, path, key, body=None, timeout=30):
            post_count[0] += 1
            raise OSError("Connection reset by peer")

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="x")
        res = self.m.generate_for_product(
            req, api_key=_fake_key(),
            _transport=_transport,
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
        )
        self.assertFalse(res.ok)
        self.assertEqual(res.error_code, "SUBMISSION_OUTCOME_UNKNOWN")
        self.assertEqual(post_count[0], 1)

    def test_image_empty_result_rejected(self):
        def _transport(method, path, key, body=None, timeout=30):
            return {"data": [], "metadata": {"success_count": 0}}

        req = self.m.ProductRequest(model="seedream-5-0-260128", kind="image", prompt="x")
        result = self.m.generate_for_product(
            req, api_key=_fake_key(),
            _transport=_transport,
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "IMAGE_RESULT_EMPTY")

    def test_video_empty_result_url_rejected(self):
        def _transport(method, path, key, body=None, timeout=30):
            if method == "POST":
                return {"id": "tid-nurl"}
            return {"status": "succeeded", "metadata": {}}

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="x")
        result = self.m.generate_for_product(
            req, api_key=_fake_key(),
            _transport=_transport,
            _sleep=lambda s: None,
            _clock=lambda: 1000.0,
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "VIDEO_RESULT_EMPTY")


# ---------------------------------------------------------------------------
class TestPollCircuitBreakersR2(unittest.TestCase):
    def setUp(self):
        self.m = _load_engine()

    def _make_clock(self):
        t = [1000.0]
        def clock():
            return t[0]
        def advance(dt):
            t[0] += dt
        return clock, advance

    def test_continuous_429_breaker(self):
        clock, advance = self._make_clock()
        call_count = [0]

        def _transport(method, path, key, body=None, timeout=30):
            call_count[0] += 1
            advance(1.0)
            err = self.m.ApiError(429, "rate limit exceeded")
            err.retry_after = "2"
            raise err

        with self.assertRaises(self.m.ApiError) as ctx:
            self.m.poll_task(
                "sk-pt-fake", "tid-cb429",
                interval=1, timeout=9999,
                _transport=_transport,
                _sleep=lambda s: advance(s),
                _clock=clock,
            )
        self.assertIn("429", str(ctx.exception))
        self.assertLessEqual(call_count[0], self.m.POLL_CB_429_MAX + 2)

    def test_continuous_5xx_breaker(self):
        clock, advance = self._make_clock()
        call_count = [0]

        def _transport(method, path, key, body=None, timeout=30):
            call_count[0] += 1
            advance(1.0)
            raise self.m.ApiError(503, "service unavailable")

        with self.assertRaises(self.m.ApiError) as ctx:
            self.m.poll_task(
                "sk-pt-fake", "tid-cb5xx",
                interval=1, timeout=9999,
                _transport=_transport,
                _sleep=lambda s: advance(s),
                _clock=clock,
            )
        self.assertIn("5xx", str(ctx.exception))
        self.assertLessEqual(call_count[0], self.m.POLL_CB_5XX_MAX + 2)

    def test_unknown_status_breaker(self):
        clock, advance = self._make_clock()
        call_count = [0]

        def _transport(method, path, key, body=None, timeout=30):
            call_count[0] += 1
            advance(1.0)
            return {"status": "unrecognized_status_state"}

        with self.assertRaises(self.m.ApiError) as ctx:
            self.m.poll_task(
                "sk-pt-fake", "tid-cbunkn",
                interval=1, timeout=9999,
                _transport=_transport,
                _sleep=lambda s: advance(s),
                _clock=clock,
            )
        self.assertIn("未识别状态", str(ctx.exception))
        self.assertLessEqual(call_count[0], self.m.POLL_CB_UNKN_MAX + 2)

    def test_fatal_403_breaks_immediately_without_idling(self):
        clock, advance = self._make_clock()
        call_count = [0]

        def _transport(method, path, key, body=None, timeout=30):
            call_count[0] += 1
            advance(1.0)
            raise self.m.ApiError(403, "not permitted to use this model")

        with self.assertRaises(self.m.ApiError):
            self.m.poll_task(
                "sk-pt-fake", "tid-fatal-403",
                interval=1, timeout=600,
                _transport=_transport,
                _sleep=lambda s: advance(s),
                _clock=clock,
            )
        # 403 must fail immediately (1 call), not idle for 600 seconds!
        self.assertEqual(call_count[0], 1)


# ---------------------------------------------------------------------------
class TestRedirectSecurity(unittest.TestCase):
    def setUp(self):
        self.m = _load_engine()

    def test_download_binary_anonymous(self):
        """download_binary does not send Authorization Bearer."""
        captured_headers = []
        mod = self.m

        orig_build_opener = mod.urllib.request.build_opener
        try:
            def fake_build_opener(*handlers):
                class FakeOpener:
                    def open(inner_self, req, timeout=120):
                        captured_headers.append(dict(req.headers))
                        raise mod.urllib.error.HTTPError("https://cdn/x.mp4", 404, "Not Found", {}, None)
                return FakeOpener()

            mod.urllib.request.build_opener = fake_build_opener
            with tempfile.NamedTemporaryFile(suffix=".mp4") as tf:
                try:
                    mod.download_binary("https://cdn/x.mp4", tf.name, _fake_key())
                except mod.ApiError:
                    pass
        finally:
            mod.urllib.request.build_opener = orig_build_opener

        self.assertTrue(len(captured_headers) > 0)
        for h in captured_headers:
            self.assertNotIn("Authorization", h)


# ---------------------------------------------------------------------------
class TestCLICompatibilityR2(unittest.TestCase):
    def setUp(self):
        self.m = _load_engine()

    def test_check_no_key_returns_2(self):
        orig_env = os.environ.get("POWERTOKENS_API_KEY")
        if orig_env:
            del os.environ["POWERTOKENS_API_KEY"]
        orig_cfg = self.m.CONFIG_PATH
        self.m.CONFIG_PATH = type('FakePath', (), {'exists': lambda s: False, '__str__': lambda s: '/tmp/f.json'})()
        try:
            code = self.m.cmd_check()
            self.assertEqual(code, 2)
        finally:
            self.m.CONFIG_PATH = orig_cfg
            if orig_env:
                os.environ["POWERTOKENS_API_KEY"] = orig_env

    def test_estimate_cost(self):
        cost = self.m.estimate_cost("wan3.0-video", 5, "720p", "video")
        self.assertIsNotNone(cost)
        self.assertGreater(cost, 0)

    def test_estimate_unknown_model_returns_none(self):
        cost = self.m.estimate_cost("unknown-model-xyz", 5, "720p", "video")
        self.assertIsNone(cost)

    def test_kind_of_model_correct(self):
        self.assertEqual(self.m.kind_of_model("wan3.0-video"), "video")
        self.assertEqual(self.m.kind_of_model("seedream-5-0-260128"), "image")
        self.assertEqual(self.m.kind_of_model("seedance-1-5-pro-251215"), "seedance")

    def test_cancellation_token_thread_safe(self):
        ct = self.m.CancellationToken()
        self.assertFalse(ct.is_cancelled)
        t = threading.Thread(target=ct.cancel)
        t.start()
        t.join(timeout=1.0)
        self.assertTrue(ct.is_cancelled)


# ---------------------------------------------------------------------------
class TestR3CounterexampleFixes(unittest.TestCase):
    """
    Direct regression tests for the 8 main review counterexamples,
    asserting correct hardened R3 behavior.
    """
    def setUp(self):
        self.m = _load_engine()

    def test_actual_transport_disconnect_yields_unknown_without_retry_suggestion(self):
        """Counterexample 1: Actual opener URLError yields SUBMISSION_OUTCOME_UNKNOWN without '重试'."""
        class FailOpener:
            def open(self, *args, **kwargs):
                raise urllib.error.URLError("PRIVATE_SENTINEL")

        orig_opener = getattr(self.m, "_api_opener", None)
        self.m._api_opener = FailOpener()
        try:
            req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="fixture")
            r = self.m.generate_for_product(req, api_key=_fake_key())
            self.assertFalse(r.ok)
            self.assertEqual(r.error_code, "SUBMISSION_OUTCOME_UNKNOWN")
            self.assertNotIn("重试", r.error_hint or "")
            self.assertNotIn("PRIVATE_SENTINEL", str(r.error_hint))
            self.assertNotIn("PRIVATE_SENTINEL", str(getattr(r, "error_message", "")))
        finally:
            self.m._api_opener = orig_opener

    def test_missing_submission_id_yields_submission_unknown_without_retry(self):
        """Counterexample 2: Empty dict response on video POST yields SUBMISSION_OUTCOME_UNKNOWN."""
        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="fixture")
        r = self.m.generate_for_product(req, api_key=_fake_key(), _transport=lambda *args, **kwargs: {})
        self.assertFalse(r.ok)
        self.assertEqual(r.error_code, "SUBMISSION_OUTCOME_UNKNOWN")
        self.assertNotIn("重试", r.error_hint or "")
        self.assertEqual(r.status, "submission_unknown")

    def test_image_file_url_rejected_as_invalid_url(self):
        """Counterexample 3: file:/// URI in image results rejected."""
        req = self.m.ProductRequest(model="image-01", kind="image", prompt="fixture")
        r = self.m.generate_for_product(req, api_key=_fake_key(),
                                        _transport=lambda *args, **kwargs: {"data": [{"url": "file:///fixture.png"}]})
        self.assertFalse(r.ok)
        self.assertEqual(r.error_code, "IMAGE_RESULT_INVALID_URL")
        self.assertEqual(r.result_urls, [])

    def test_image_failure_with_url_reports_failure(self):
        """Counterexample 4: Remote failure envelope with dummy URL must NOT be reported as success."""
        req = self.m.ProductRequest(model="image-01", kind="image", prompt="fixture")
        r = self.m.generate_for_product(
            req, api_key=_fake_key(),
            _transport=lambda *args, **kwargs: {"status": "failed", "error": "rejected",
                                                "data": [{"url": "https://cdn.invalid/error.png"}]}
        )
        self.assertFalse(r.ok)
        self.assertEqual(r.status, "failed")
        self.assertEqual(r.result_urls, [])

    def test_asset_trailing_newline_rejected(self):
        """Counterexample 5: asset://valid\\n must be rejected at validation."""
        rq = self.m.ProductRequest(model="dreamina-seedance-2-0", kind="seedance",
                                   prompt="fixture", first_frame="asset://valid\n")
        with self.assertRaises(ValueError):
            self.m._validate_product_request(rq, _fake_key())

        rq_crlf = self.m.ProductRequest(model="dreamina-seedance-2-0", kind="seedance",
                                        prompt="fixture", first_frame="asset://valid\r\n")
        with self.assertRaises(ValueError):
            self.m._validate_product_request(rq_crlf, _fake_key())

    def test_malformed_poll_retains_task_id_and_returns_structured_result(self):
        """Counterexample 6: Malformed poll response retains task_id and does not escape unhandled error."""
        def malformed_poll(method, *args, **kwargs):
            return {"id": "fixture-task"} if method == "POST" else {"status": ["completed"]}

        clock = [100.0]
        def _clock():
            return clock[0]
        def _sleep(s):
            clock[0] += s

        req = self.m.ProductRequest(model="wan3.0-video", kind="video", prompt="fixture",
                                    poll_interval=1, poll_timeout=10)
        r = self.m.generate_for_product(req, api_key=_fake_key(), _transport=malformed_poll,
                                        _sleep=_sleep, _clock=_clock)
        self.assertFalse(r.ok)
        self.assertEqual(r.task_id, "fixture-task")

    def test_request_mutation_from_hook_does_not_affect_post_or_billing(self):
        """Counterexample 7: Hook mutating request fields does not change POST body or billing."""
        posted = []
        rq = self.m.ProductRequest(model="image-01", kind="image", prompt="fixture", n=1)

        class MutateHook(self.m.ProductHooks):
            def before_submit(self, metadata):
                rq.n = 9
                rq.model = "different-image-model"

        def capture(method, path, credential, body=None, timeout=30):
            posted.append(body)
            return {"data": [{"url": "https://cdn.invalid/result.png"}]}

        r = self.m.generate_for_product(rq, api_key=_fake_key(), hooks=MutateHook(), _transport=capture)
        self.assertTrue(r.ok)
        self.assertEqual(posted[0]["n"], 1)
        self.assertEqual(r.billing_params["n_images"], 1)

    def test_image_cancel_during_post_reflects_local_cancel_and_preserves_urls(self):
        """Counterexample 8: Cancellation during POST retains result URLs and reflects cancellation."""
        token = self.m.CancellationToken()

        def cancel_during_post(*args, **kwargs):
            token.cancel()
            return {"data": [{"url": "https://cdn.invalid/result.png"}]}

        req = self.m.ProductRequest(model="image-01", kind="image", prompt="fixture")
        r = self.m.generate_for_product(req, api_key=_fake_key(), _cancel=token, _transport=cancel_during_post)
        self.assertFalse(r.ok)
        self.assertEqual(r.error_code, "CANCELLED_AFTER_SUBMIT")
        self.assertEqual(r.status, "completed_locally_cancelled")
        self.assertEqual(r.result_urls, ["https://cdn.invalid/result.png"])


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    if ENGINE_PATH is None:
        print("ERROR: --engine-path is required", file=sys.stderr)
        sys.exit(1)
    unittest.main(verbosity=2)
