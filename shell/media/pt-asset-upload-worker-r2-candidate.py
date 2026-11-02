#!/usr/bin/env python3
"""Trusted-host JSONL worker for product asset upload and GET-only recovery (R2 Candidate).

Communicates with Node bridge over stdio via bounded JSON frames.
Strictly adheres to vendored fixed endpoints (https://powertokens.ai/api/...).
Never rewrites asset URLs, never accepts caller baseUrl, never echoes raw bytes or API keys.
"""
import base64
import importlib.util
import json
import os
import pathlib
from pathlib import Path
import re
import signal
import sys

MAX_INITIAL_FRAME = 8 * 1024 * 1024  # 8 MiB (envelope for <= 5 MiB base64 payload)
MAX_EVENT_FRAME = 128 * 1024         # 128 KiB
MAX_ASSET_BYTES = 5 * 1024 * 1024    # 5 MiB

SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}\Z")
ASSET_TASK_ID_RE = re.compile(r"^[a-zA-Z0-9_.:-]{1,256}\Z")
ASSET_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,256}\Z")
REQUEST_ID_RE = re.compile(r"^[a-f0-9-]{36}\Z")


class ProtocolError(Exception):
    pass


def read_frame(stream, max_size=MAX_EVENT_FRAME):
    line = stream.readline(max_size + 1)
    if not line or len(line) > max_size or not line.endswith(b"\n"):
        raise ProtocolError("Frame size exceeded or missing trailing newline")
    try:
        value = json.loads(line.decode("utf-8"))
    except Exception as exc:
        raise ProtocolError("Invalid JSON in frame") from exc
    if not isinstance(value, dict):
        raise ProtocolError("Frame must be a JSON object")
    return value


def run(stdin=None, stdout=None, transport=None, engine_path=None):
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout
    request_id = None

    def emit(frame):
        data = json.dumps(frame, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
        encoded = data.encode("utf-8")
        if len(encoded) + 1 > MAX_EVENT_FRAME:
            raise ProtocolError("Outgoing frame exceeded maximum boundary")
        stdout.write(data + "\n")
        stdout.flush()

    # Step 1: worker emits ready
    emit({"version": 1, "type": "ready"})

    try:
        # Step 2: read initial request frame (bounded up to 8 MiB)
        frame = read_frame(stdin, max_size=MAX_INITIAL_FRAME)
        if frame.get("version") != 1:
            raise ProtocolError("Unsupported protocol version")

        req_type = frame.get("type")
        if req_type not in ("upload", "recover"):
            raise ProtocolError("Unsupported request type")

        request_id = frame.get("requestId")
        if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
            raise ProtocolError("Invalid requestId format")

        # R2 SECURITY REQUIREMENT: No caller baseUrl is accepted!
        if "baseUrl" in frame:
            raise ProtocolError("baseUrl is forbidden in R2 protocol")

        poll_timeout = frame.get("pollTimeout", 120)
        try:
            poll_timeout = float(poll_timeout)
            if poll_timeout <= 0 or poll_timeout > 120.0:
                poll_timeout = 120.0
        except (TypeError, ValueError):
            poll_timeout = 120.0

        # Resolve engine path (strictly trusted host configuration)
        if engine_path:
            target_engine = pathlib.Path(engine_path)
        elif os.environ.get("PT_ASSET_UPLOAD_ENGINE_PATH"):
            target_engine = pathlib.Path(os.environ["PT_ASSET_UPLOAD_ENGINE_PATH"])
        else:
            target_engine = Path(__file__).resolve().parent / "vendor/powertokens_video/pt_video.py"

        if not target_engine.is_file():
            raise ProtocolError(f"Engine file not found: {target_engine}")

        spec = importlib.util.spec_from_file_location("northstar_asset_engine", target_engine)
        engine = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(engine)

        # R2 SECURITY REQUIREMENT: Worker MUST NOT rewrite fixed endpoints!
        # Fixed endpoints remain:
        # ASSET_UPLOAD = "https://powertokens.ai/api/v1/asset/upload"
        # ASSET_GET_ID = "https://powertokens.ai/api/v1/asset/jobs/get-asset-id?task_id={}"

        # Setup cancellation
        is_cancelled = False

        def handle_sigterm(signum, frame_sig):
            nonlocal is_cancelled
            is_cancelled = True

        signal.signal(signal.SIGTERM, handle_sigterm)

        sequence = 0

        def acknowledged(event_type, payload):
            nonlocal sequence
            sequence += 1
            emit({
                "version": 1,
                "type": "event",
                "requestId": request_id,
                "eventId": sequence,
                "event": event_type,
                "payload": payload,
            })
            ack = read_frame(stdin, max_size=MAX_EVENT_FRAME)
            if (
                set(ack) != {"version", "type", "requestId", "eventId", "ok"}
                or ack["version"] != 1
                or ack["type"] != "ack"
                or ack["requestId"] != request_id
                or ack["eventId"] != sequence
                or ack["ok"] is not True
            ):
                raise ProtocolError(f"Ack rejected or mismatched for event {event_type}")

        if req_type == "upload":
            expected_keys = {"version", "type", "requestId", "apiKey", "filename", "contentBase64", "pollTimeout"}
            if set(frame) != expected_keys:
                raise ProtocolError("Upload frame has invalid or unexpected fields")

            api_key = frame.get("apiKey")
            if not isinstance(api_key, str) or not api_key or len(api_key) > 4096 or any(ord(c) < 32 for c in api_key):
                raise ProtocolError("Invalid apiKey")

            filename = frame.get("filename", "reference.png")
            if not isinstance(filename, str) or not SAFE_FILENAME_RE.fullmatch(filename) or any(c in filename for c in "/\\\r\n"):
                raise ProtocolError("Invalid filename")

            b64_data = frame.get("contentBase64")
            if not isinstance(b64_data, str) or not b64_data:
                raise ProtocolError("contentBase64 must be a non-empty string")

            try:
                content = base64.b64decode(b64_data, validate=True)
            except Exception as exc:
                raise ProtocolError("contentBase64 decoding failed") from exc

            if len(content) == 0 or len(content) > MAX_ASSET_BYTES:
                raise ProtocolError("Decoded content bytes out of boundary")

            hooks = {
                "before_submit": lambda meta: acknowledged("before_submit", {
                    "byte_count": meta.get("byte_count"),
                    "sha256": meta.get("sha256"),
                    "filename": meta.get("filename"),
                }),
                "submission_started": lambda: acknowledged("submission_started", {}),
                "on_task_id": lambda tid: acknowledged("on_task_id", {"taskId": tid}),
                "on_asset_id": lambda aid: acknowledged("on_asset_id", {"assetId": aid}),
            }

            result = engine.upload_asset_for_product(
                content,
                filename=filename,
                key=api_key,
                hooks=hooks,
                transport=transport,
                cancel_token=lambda: is_cancelled,
                poll_timeout=poll_timeout,
            )

        elif req_type == "recover":
            expected_keys = {"version", "type", "requestId", "taskId", "pollTimeout"}
            if set(frame) != expected_keys:
                raise ProtocolError("Recover frame has invalid or unexpected fields")

            task_id = frame.get("taskId")
            if not isinstance(task_id, str) or not ASSET_TASK_ID_RE.fullmatch(task_id):
                raise ProtocolError("Invalid taskId for recovery")

            hooks = {
                "on_asset_id": lambda aid: acknowledged("on_asset_id", {"assetId": aid, "taskId": task_id}),
            }

            result = engine.recover_uploaded_asset_for_product(
                task_id,
                hooks=hooks,
                transport=transport,
                cancel_token=lambda: is_cancelled,
                poll_timeout=poll_timeout,
            )

        emit({"version": 1, "type": "done", "requestId": request_id, "result": result})

    except Exception:
        # Never output traceback, raw cause, or private key
        emit({"version": 1, "type": "error", "requestId": request_id, "code": "ASSET_UPLOAD_WORKER_FAILED"})


if __name__ == "__main__":
    run()
