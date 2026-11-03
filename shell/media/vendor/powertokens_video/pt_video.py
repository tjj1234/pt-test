#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PowerTokens 图片 + 视频生成 —— 跨 agent 工具的可移植引擎（直连官方 REST，零外部依赖）。

为什么这样设计：
  PowerTokens 两类生成都是「提交任务」但返回形态不同：
  - 视频：POST /v1/videos 提交拿 task_id → 每 10s GET /v1/videos/{id} 轮询 → succeeded 拿 url
  - 图片：POST /v1/images/generations 同步返回 data[].url（OpenAI 风格，不轮询）
  官方文档：
    - 视频提交：https://docs.powertokens.ai/zh-Hans/zmodelVideo/ali/wan3.0-video-generation
    - 视频查询：https://docs.powertokens.ai/zh-Hans/zmodelVideo/minimax/query-video-status
    - 图片（image-01）：https://docs.powertokens.ai/zh-Hans/zmodelImage/minimax/image01-image-to-image
    - Seedance 协议：https://docs.powertokens.ai/assets-library?tab=1 （仪表盘手动签 Asset Library User Agreement）
  本引擎只用 Python 标准库（urllib），**不依赖 Node / powertokens-cli / requests**，
  所以任何能跑 Python 的 agent（WorkBuddy / Claude / Cursor / Trae / 任意 MCP 客户端）都能直接用。

能力层：
  1) check    —— 秒级检查 Key 是否就绪（不生成分文）
  2) 配置     —— 从环境变量或本地 config.json 注入 Key（"输入 Key 的地方"）
  3) auto     —— generate 不写 -m 时，按账号真实可用模型自动选（视频/图片分开排序）
  4) 预校验   —— 显式 -m 先与 live 列表比对，不在则 1 秒内报错退出，不进生成、不扣费
  5) 查询     —— models 命令输出每个模型的定价 + 支持参数（视频 + 图片）
  6) 生成     —— generate 提交图片(同步)/视频(轮询)，直到拿到链接（可选下载到本地）

设计原则（工具无关）：
  - 不依赖任何特定 agent 格式。Key 优先读环境变量 POWERTOKENS_API_KEY；其次 config.json。
  - config.json 默认在 ~/.config/powertokens-video/（可用 PT_VIDEO_CONFIG 覆盖），不写进 skill 目录。
  - 默认模型 = auto（除非用 config --set-model 固定，或 generate 显式 -m）。generate 按模型类型自动分流视频/图片。

子命令：
  check                         Key 体检（exit 0=就绪 2=缺 Key）
  config --set-key <k>          保存 Key 到 config.json
  config --set-model <id|auto>  保存默认模型（generate 未写 -m 时优先用它；默认 auto）
  config --show                 查看配置（Key 脱敏）
  auto-model [--type image|video|seedance]  打印 auto 首选模型 ID（不生成）
  models [-t video|image|seedance|all] [--json]  列出模型 + 定价 + 支持参数
  generate -m <id|auto> -p ... [--type image|video|seedance]  提交并取回链接
  seedance [enable|disable|status]  Seedance 协议标记管理（本地，全系 1.0/1.5/2.0/2.5 通用）
  estimate -m <id> ...          仅估算消耗（美元；图片单价待补充）

退出码：0=成功 2=缺 Key 3=显式模型未过预校验 1=其他失败
"""

import argparse
import difflib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
import copy
import math
import re
import threading
import urllib.parse

# ---------- cancellation token (injectable, thread-safe) ----------
class CancellationToken:
    """Lightweight cancellation flag. Pass to generate_for_product(); call .cancel() to stop."""
    def __init__(self):
        self._cancelled = threading.Event()

    def cancel(self):
        self._cancelled.set()

    @property
    def is_cancelled(self):
        return self._cancelled.is_set()

_NOT_CANCELLED = CancellationToken()  # default sentinel — never cancelled

SCRIPT_DIR = Path(__file__).resolve().parent
# 配置与任何 agent 解耦：默认放用户级目录，可用环境变量覆盖
CONFIG_PATH = Path(os.environ.get(
    "PT_VIDEO_CONFIG",
    Path.home() / ".config" / "powertokens-video" / "config.json",
))
ONBOARD_URL = "https://powertokens.ai/zh-Hans/dashboard"
PT_BASE = "https://api.powertokens.ai"

# ---------- 端点 ----------
VIDEO_SUBMIT = "/v1/videos"
VIDEO_POLL = "/v1/videos/{id}"
IMAGE_ENDPOINT = "/v1/images/generations"   # 实测确认：OpenAI 风格，带 /generations 后缀，同步返回

# ---------- 资产库上传（Seedance 图生视频必须先把素材上传拿 asset://）----------
# 注意：资产库 base 是 powertokens.ai/api（带 /api 前缀），不是 api.powertokens.ai
ASSET_BASE = "https://powertokens.ai/api"
ASSET_UPLOAD = ASSET_BASE + "/v1/asset/upload"                 # POST multipart，需鉴权
ASSET_GET_ID = ASSET_BASE + "/v1/asset/jobs/get-asset-id?task_id={}"   # GET，无需鉴权

# ---------- 提交 / 轮询时序（按用户要求）----------
SUBMIT_TIMEOUT = 120      # POST /v1/videos 的 HTTP 客户端超时（秒）
POLL_INTERVAL = 10        # 每 10 秒查询一次任务状态
POLL_TIMEOUT = 600        # 整体轮询总上限（秒）；真实出片约 3 分钟，故默认 600。
                          # 若想更短可用 generate --timeout 120；但低于实际出片时长会轮询超时。
IMAGE_HTTP_TIMEOUT = 120  # 图片同步生成的 HTTP 客户端超时（秒）
DOWNLOAD_CHUNK = 65536

# ---------- auto 模型优先级（小写包含匹配，排在前先试）----------
# 注意：Seedance 已拆为独立类型，普通 video auto 不再包含它（见 AUTO_PRIORITY_SEEDANCE）
AUTO_PRIORITY_VIDEO = ["kling", "wan", "hailuo", "vidu", "happyhorse"]
AUTO_PRIORITY_SEEDANCE = ["seedance-1-5-pro-251215", "dreamina-seedance-2-0-fast-260128", "dreamina-seedance-2-0-260128"]
AUTO_PRIORITY_IMAGE = ["seedream", "qwen-image", "image-01", "kling-image", "wan"]
AUTO_FALLBACK_VIDEO = "wan3.0-video"   # 仅在拉不到任何列表时的最后兜底
AUTO_FALLBACK_SEEDANCE = "seedance-1-5-pro-251215"
AUTO_FALLBACK_IMAGE = "seedream-5-0-260128"
AUTO_MAX_TRIES = 4

# ---------- 消耗估算（基于 PT 真实 pre-consume 单价探测；零成本建表）----------
# 系数：时长线性（5s→10s = ×2）、1080p = 720p ×2。单位：美元（$）。
# 视频单价已实测；图片单价待补充（生成会扣费，且当前 key 余额有限，未探测）。
# Seedance 全系单价单列（走资产库协议 + asset:// 素材，与普通视频分开计价）
PRICE_VIDEO_5S_720P = {
    "wan3.0-video": 0.20,
    "wan3.0-video-prime": 0.70,
    "kling-v2-1-master": 1.40,
    "kling-video-o1": 0.42,
    "kling-v3": 0.42,
    "wan2.7-t2v": 0.475,
}
PRICE_SEEDANCE_5S_720P = {
    "seedance-1-5-pro-251215": 0.247,
    "dreamina-seedance-2-0-fast-260128": 0.605,
    "dreamina-seedance-2-0-260128": 0.756,
}
# 图片单价：未知（PT 图片按张计费，结构不同于视频）。填真实单价后 estimate 即生效。
# 占位 ID 取自实测可用列表，值为 None 表示「待补充」；有 Key 时 live 列表会覆盖 available。
IMAGE_PRICE = {
    "seedream-5-0-260128": None,
    "seedream-4-5-251128": None,
    "seedream-4-0-250828": None,
    "dola-seedream-5-0-pro-260628": None,
    "qwen-image-2.0-pro": None,
    "qwen-image-3.0-pro": None,
    "image-01": None,
    "kling-image-o1": None,
    "wan2.7-image-pro": None,
}

# ---------- 各模型族支持参数（静态目录，基于 PT 公开能力；以仪表盘为准）----------
# 普通视频模型（不含 Seedance —— Seedance 拆为独立类型）
MODEL_CAPS = [
    ("kling", dict(vendor="Kling", kind="video", max_dur=10, res="720p,1080p",
                   inputs="text, image, audio", camera="supported")),
    ("wan", dict(vendor="Wan", kind="video", max_dur=10, res="720p,1080p", inputs="text, image", camera="—")),
    ("hailuo", dict(vendor="MiniMax Hailuo", kind="video", max_dur=10, res="720p,1080p", inputs="text, image", camera="—")),
    ("vidu", dict(vendor="Vidu", kind="video", max_dur=10, res="720p,1080p", inputs="text, image, multi-reference", camera="—")),
    ("happyhorse", dict(vendor="HappyHorse", kind="video", max_dur=10, res="720p", inputs="text", camera="—")),
]
# Seedance 全系独立类型：必须签 Asset Library 协议 + 素材走 asset://
SEEDANCE_CAPS = [
    ("seedance", dict(vendor="ByteDance Seedance", kind="seedance", max_dur=10, res="720p,1080p",
                      inputs="text, image(first-frame, asset://), start-end frames, video+audio ref",
                      camera="—", requires_agreement=True)),
]
IMAGE_MODEL_CAPS = [
    ("seedream", dict(vendor="ByteDance Seedream", kind="image", max_dur=0, res="1K/2K/4K",
                      inputs="text, image(ref)", camera="—")),
    ("qwen-image", dict(vendor="Qwen Image", kind="image", max_dur=0, res="1K+",
                        inputs="text, image", camera="—")),
    ("image-01", dict(vendor="MiniMax Image-01", kind="image", max_dur=0, res="512-2048px",
                      inputs="text, image(subject_reference)", camera="—")),
    ("kling-image", dict(vendor="Kling Image", kind="image", max_dur=0, res="—",
                         inputs="text, image", camera="—")),
    ("wan", dict(vendor="Wan Image", kind="image", max_dur=0, res="—",
                 inputs="text, image", camera="—")),
]
DEFAULT_CAPS = dict(vendor="unknown", kind="video", max_dur=10, res="720p,1080p", inputs="text, image", camera="—")

# Seedance 全系需要签署 Asset Library User Agreement（仪表盘手动签，无 API 端点）
SEEDANCE_AGREEMENT_URL = "https://powertokens.ai/assets-library?tab=1"


def resolve_caps(mid, kind="video"):
    l = mid.lower()
    if kind == "seedance":
        src = SEEDANCE_CAPS
    elif kind == "image":
        src = IMAGE_MODEL_CAPS
    else:
        src = MODEL_CAPS
    for sub, caps in src:
        if sub in l:
            return caps
    return DEFAULT_CAPS


# ---------- 模型类型识别 ----------
def is_video_model(mid):
    l = mid.lower()
    if "image" in l:
        return False
    if "seedream" in l or "dola-seedream" in l:   # 图片模型，排除出视频
        return False
    if is_seedance(l):
        return False   # Seedance 走独立类型，不计入普通 video
    if "video" in l or "hailuo" in l or "vidu" in l or "happyhorse" in l:
        return True
    if "kling-v" in l:
        return True
    if "wan" in l and any(k in l for k in ("t2v", "i2v", "r2v", "kf2v")):
        return True
    return False


def is_image_model(mid):
    l = mid.lower()
    if "image" in l:
        return True
    if "seedream" in l or "dola-seedream" in l:
        return True
    return False


def is_seedance(mid):
    """模型 ID 含 seedance 即归入 Seedance 独立类型（全系 1.0/1.5/2.0/2.5，含 Mini/Fast 变体）。"""
    return "seedance" in mid.lower()


def kind_of_model(mid):
    if is_image_model(mid):
        return "image"
    if is_seedance(mid):
        return "seedance"
    if is_video_model(mid):
        return "video"
    return "unknown"


# ---------- 消耗估算 ----------
def estimate_cost(model, duration, resolution, kind="video"):
    """返回该次生成的预估消耗（美元），未知模型返回 None。"""
    if not model:
        return None
    lm = model.lower()
    if kind == "seedance":
        table = PRICE_SEEDANCE_5S_720P
    elif kind == "image":
        table = IMAGE_PRICE
    else:
        table = PRICE_VIDEO_5S_720P
    base = None
    for key in sorted(table, key=len, reverse=True):
        if key in lm:
            base = table[key]
            break
    if base is None:
        return None
    if kind == "image":
        return round(base, 3)
    factor = max(float(duration or 5), 1) / 5.0
    if "1080" in (resolution or ""):
        factor *= 2.0
    return round(base * factor, 3)


def print_cost(model, duration, resolution, kind="video"):
    c = estimate_cost(model, duration, resolution, kind)
    if c is None:
        sys.stderr.write(
            f"[credits] 本次预估消耗：未知（{model} 不在单价表；"
            f"可在 PRICE_VIDEO_5S_720P / PRICE_SEEDANCE_5S_720P / IMAGE_PRICE 补充，或 PT 开放消耗接口后直读真值）\n"
        )
    else:
        unit = "张" if kind == "image" else f"{duration}s·{resolution}"
        sys.stderr.write(
            f"[credits] 本次预估消耗：约 ${c}（{model} · {unit}，"
            f"按 PT 预扣单价估算；PT 额度按美元计）\n"
        )


def print_generation_summary(model, kind, duration, resolution, prompt, outputs, urls, seed=None, ratio=None):
    parts = [f"模型={model}", f"类型={kind}"]
    if kind == "video":
        parts.append(f"时长={duration}s")
    parts.append(f"分辨率={resolution}")
    if ratio:
        parts.append(f"比例={ratio}")
    if seed is not None:
        parts.append(f"种子={seed}")
    if prompt:
        parts.append(f"提示词={prompt}")
    if outputs:
        parts.append(f"输出={', '.join(str(o) for o in outputs)}")
    sys.stderr.write("[params] 生成参数：" + " · ".join(parts) + "\n")
    print_cost(model, duration, resolution, kind)
    for u in urls:
        sys.stderr.write(f"[result] 链接：{u}\n")


KEY_MISSING_MSG = f"""[需要 API Key] 还没配置 PowerTokens Key。
获取 Key 三步：打开 {ONBOARD_URL} → 注册/登录 → 充值后创建 Key（形如 sk-pt-xxxx）。
任选一种配置：
  1) 环境变量（推荐，任何 agent 通用）：export POWERTOKENS_API_KEY=sk-pt-xxxx
  2) 命令行保存：python pt_video.py config --set-key "sk-pt-xxxx"
  3) 手动编辑 {CONFIG_PATH} 加 "api_key": "sk-pt-xxx"
"""

ONBOARD_GUIDE = f"""[上手引导] 欢迎使用 PowerTokens 图片+视频生成，上手前 3 件事：
1) 配置 Key：打开 {ONBOARD_URL} → 注册/登录 → 充值 → 创建 Key（形如 sk-pt-xxxx）
   → 设环境变量 POWERTOKENS_API_KEY，或跑：python pt_video.py config --set-key "sk-pt-xxxx"
2) 指定模型：直接写模型名（如「用 kling-v2-1-master 生成视频」「用 seedream-5-0 生成图片」），
   不写则自动选（视频默认 auto；图片加 --type image -m auto）
3) 查看所有模型与定价：输入「获取所有模型」，或跑：python pt_video.py models --json
"""


# ---------- 配置 ----------
def load_config():
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_config(data):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass


# ---------- Key 注入 ----------
def resolve_key():
    env_key = os.environ.get("POWERTOKENS_API_KEY")
    if env_key:
        return env_key
    return load_config().get("api_key", "")


# ---------- 官方 REST 调用（仅标准库）----------
def _headers(key, extra=None):
    h = {"Authorization": f"Bearer {key}", "User-Agent": "pt-media-skill",
         "Content-Type": "application/json", "Accept": "application/json"}
    if extra:
        h.update(extra)
    return h


MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MB limit for response
MAX_ERROR_BYTES = 64 * 1024           # 64 KB limit for error body
CHUNK_SIZE = 64 * 1024


def _read_limited(stream, limit, clock=None, deadline=None, cancel=None):
    """Read stream in chunks with byte limit, timeout deadline and cancellation checks."""
    chunks = []
    total = 0
    while True:
        if cancel and cancel.is_cancelled:
            raise ApiError(0, "响应读取已取消")
        if deadline is not None and clock and clock() >= deadline:
            raise ApiError(0, "响应读取超时")
        chunk = stream.read(min(CHUNK_SIZE, limit - total + 1))
        if cancel and cancel.is_cancelled:
            raise ApiError(0, "Response read cancelled")
        if deadline is not None and clock and clock() >= deadline:
            raise ApiError(0, "Response read deadline exceeded")
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise ApiError(0, f"响应体积超过限制 ({limit} 字节)")
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8")


class _StrictNoRedirect(urllib.request.HTTPRedirectHandler):
    """Ensure credentials are never forwarded to redirect locations."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ApiError(code, f"API redirect disallowed ({code})")


_api_opener = urllib.request.build_opener(_StrictNoRedirect)


def _api_call(method, path, key, body=None, timeout=30, clock=None, deadline=None, cancel=None):
    clock = clock or time.monotonic
    deadline = deadline if deadline is not None else clock() + timeout
    url = PT_BASE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=_headers(key), method=method)
    try:
        with _api_opener.open(req, timeout=timeout) as resp:
            raw = _read_limited(resp, MAX_RESPONSE_BYTES, clock=clock, deadline=deadline, cancel=cancel)
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = _read_limited(e, MAX_ERROR_BYTES, clock=clock, deadline=deadline, cancel=cancel)
            j = json.loads(detail)
            if isinstance(j, dict):
                detail = j.get("error") or j.get("message") or json.dumps(j, ensure_ascii=False)
        except Exception:
            pass
        err_msg = str(detail) or e.reason or f"HTTP {e.code}"
        err = ApiError(e.code, err_msg)
        if hasattr(e, "headers") and e.headers:
            ra = e.headers.get("Retry-After")
            if ra:
                err.retry_after = ra
        raise err
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        err_type = type(e).__name__
        raise ApiError(0, f"网络连接或传输异常: {err_type}")


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message
        self.retry_after = None
        super().__init__(f"HTTP {status}: {message}")


class _PollOutcome(ApiError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(0, reason)


_SIGN_WORD_RE = re.compile(r"(sign\s+the\s+agreement|need\s+to\s+sign|must\s+sign|unsigned\s+agreement)|未签署|未签协议")


def is_agreement_error(e):
    message = (getattr(e, "message", "") or "").lower()
    markers = ("sign the agreement", "need to sign", "must sign", "agreement required",
               "agreement not signed", "agreement has not been signed", "agreement not accepted",
               "unsigned agreement", "未签署", "未签协议", "尚未签署")
    return any(marker in message for marker in markers)


def classify_error(e):
    """Map ApiError to a stable product error code; never echo raw upstream body.
    Returns (code: str, user_hint: str).
    PT confirmed production status split: 401 key, 402 balance, 403 model permission.
    """
    if not isinstance(e, ApiError):
        return ("UPSTREAM_UNKNOWN", "上游返回异常，请稍后核对")
    msg = (e.message or "").lower()
    status = e.status

    if status == 401:
        return ("KEY_INVALID", "API Key 无效或已过期，请检查配置")
    if status == 402:
        return ("QUOTA_INSUFFICIENT", "账户余额不足，请充值后重试")
    if status == 403:
        return ("UPSTREAM_FORBIDDEN", "模型已下架或当前 Key 无此模型权限，请检查 PT 后台")
    if is_agreement_error(e):
        return ("SEEDANCE_AGREEMENT_REQUIRED", "需先签署 Asset Library User Agreement，详见 seedance enable 引导")
    if "asset library" in msg or "media rejected" in msg or "content rejected" in msg or "format rejected" in msg or "design rejected" in msg:
        return ("MEDIA_REJECTED", "媒体素材被上游拒绝（格式、内容或未入库），请检查素材")
    if "quota" in msg or "token quota" in msg or "insufficient" in msg or "balance" in msg:
        return ("QUOTA_INSUFFICIENT", "账户余额不足，请充值后重试")
    if "not permitted" in msg or "no permission" in msg or "not allowed" in msg or "not have access" in msg:
        return ("MODEL_NOT_PERMITTED", "当前 Key 无此模型权限，请在 PT 后台检查白名单")
    if "token_invalid" in msg or "invalid token" in msg or "unauthorized" in msg or status == 401:
        return ("KEY_INVALID", "API Key 无效，请检查配置")
    if "model_not_found" in msg or "model is not" in msg or "not supported" in msg or "not listed" in msg:
        return ("MODEL_NOT_FOUND", "模型 ID 不在账号可用列表，请检查 -m 参数")
    if "no available" in msg or "无可用渠道" in msg:
        return ("NO_AVAILABLE_CHANNEL", "暂无可用渠道，属瞬时故障，稍后重试")
    if status == 429:
        return ("RATE_LIMITED", "请求频率超限（429），请稍后重试")
    if status in (408, 502, 503, 504) or status >= 500:
        return ("UPSTREAM_SERVER_ERROR", f"上游服务器错误 ({status})，受理状态未知")
    if status == 403:
        return ("UPSTREAM_FORBIDDEN", "请求被拒（403），可能是余额、权限或 Key 问题，请查看 PT 后台")
    if status == 400:
        return ("UPSTREAM_BAD_REQUEST", "上游请求参数被拒（400），请检查入参")
    return ("UPSTREAM_ERROR", f"上游返回错误 (HTTP {status})，请稍后核对")


def list_key_models(key, kind="all"):
    """拉取该 Key 真实可用的模型列表（/v1/models 反映 Key 额度），按 kind 过滤并排序。"""
    try:
        data = _api_call("GET", "/v1/models", key, timeout=15)
    except ApiError as e:
        sys.stderr.write(f"[warn] 查询 /v1/models 失败: {e}\n")
        return []
    except Exception as e:
        sys.stderr.write(f"[warn] 查询 /v1/models 异常: {e}\n")
        return []
    ids = []
    items = data.get("data", data if isinstance(data, list) else [])
    for item in items:
        mid = item.get("id") if isinstance(item, dict) else str(item)
        if mid:
            ids.append(mid)
    if kind == "video":
        out = [m for m in ids if is_video_model(m)]
    elif kind == "image":
        out = [m for m in ids if is_image_model(m)]
    elif kind == "seedance":
        out = [m for m in ids if is_seedance(m)]
    else:
        out = ids
    out.sort(key=lambda m: (_priority_rank(m, kind), 0 if "fast" in m.lower() else 1))
    return out


# ---------- 模型识别与 auto 解析 ----------
def _priority_rank(mid, kind="video"):
    l = mid.lower()
    if kind == "seedance":
        prio = AUTO_PRIORITY_SEEDANCE
    elif kind == "image":
        prio = AUTO_PRIORITY_IMAGE
    else:
        prio = AUTO_PRIORITY_VIDEO
    for rank, hint in enumerate(prio):
        if hint in l:
            return rank
    return len(prio)


def auto_candidates(key, kind="video", ignore_default=False):
    """auto 模式的候选模型列表（有序）。config 默认模型先过 live 校验，失效则忽略。

    ignore_default=True 表示用户**显式**写了 -m auto，跳过 config 的 default_model，
    走完整多候选自动排序（保留失败自动换模型的降级链路）。
    """
    cfg_default = "" if ignore_default else load_config().get("default_model", "")
    models = list_key_models(key, kind)
    if cfg_default and cfg_default.lower() != "auto":
        same_kind = (
            (kind == "video" and is_video_model(cfg_default)) or
            (kind == "image" and is_image_model(cfg_default)) or
            (kind == "seedance" and is_seedance(cfg_default))
        )
        if same_kind:
            hit = next((v for v in models if v.lower() == cfg_default.lower()), None)
            if hit:
                return [hit]
            if models:
                sys.stderr.write(
                    f"[precheck] 配置的默认模型 {cfg_default} 已不在你的可用列表，忽略它改用 auto 排序\n"
                )
            else:
                return [cfg_default]
    if models:
        return models
    if kind == "seedance":
        return [AUTO_FALLBACK_SEEDANCE]
    if kind == "image":
        return [AUTO_FALLBACK_IMAGE]
    return [AUTO_FALLBACK_VIDEO]


def suggest_similar(model, vids, n=3):
    lm = model.lower()
    close = difflib.get_close_matches(model, vids, n=n, cutoff=0.35)
    seen = {v.lower() for v in close}
    prefix = lm.split("-")[0]
    if len(prefix) >= 3:
        for v in vids:
            if v.lower().startswith(prefix) and v.lower() not in seen:
                close.append(v)
                seen.add(v.lower())
    return close[:n]


def precheck_explicit_model(key, model, kind="video"):
    """显式 -m 的预校验：只放行 live 列表里存在的模型。返回 (ok?, 最终ID 或 (候选, 总数))。"""
    vids = list_key_models(key, kind)
    if not vids:
        sys.stderr.write("[precheck] 拉不到模型列表（网络/接口异常），跳过校验，照常执行\n")
        return (True, model)
    if model in vids:
        return (True, model)
    ci = next((v for v in vids if v.lower() == model.lower()), None)
    if ci:
        sys.stderr.write(f"[precheck] 模型大小写已纠正: {model} -> {ci}\n")
        return (True, ci)
    return (False, (suggest_similar(model, vids), len(vids)))


# ---------- 模型目录（定价 + 参数）----------
def build_catalog(key, kind="all"):
    """返回模型目录列表：合并静态单价表与 live 可用列表。"""
    live = list_key_models(key, kind) if key else []
    live_set = {m.lower() for m in live}
    rows, seen = [], set()

    def add_from_table(table, caps_src):
        for mid, price in table.items():
            k = kind_of_model(mid) or "video"
            if kind != "all" and k != kind:
                continue
            caps = resolve_caps(mid, k)
            avail = "yes" if mid.lower() in live_set else ("n/a" if not key else "no")
            rows.append({
                "model": mid, "kind": k,
                "price_5s_720p": price if k in ("video", "seedance") else None,
                "max_dur_s": caps["max_dur"], "resolution": caps["res"],
                "inputs": caps["inputs"], "camera_control": caps["camera"],
                "available": avail,
            })
            seen.add(mid.lower())

    add_from_table(PRICE_VIDEO_5S_720P, MODEL_CAPS)
    add_from_table(PRICE_SEEDANCE_5S_720P, SEEDANCE_CAPS)
    add_from_table(IMAGE_PRICE, IMAGE_MODEL_CAPS)

    for mid in live:
        if mid.lower() in seen:
            continue
        k = kind_of_model(mid) or "video"
        caps = resolve_caps(mid, k)
        rows.append({
            "model": mid, "kind": k, "price_5s_720p": None,
            "max_dur_s": caps["max_dur"], "resolution": caps["res"],
            "inputs": caps["inputs"], "camera_control": caps["camera"],
            "available": "yes",
        })
        seen.add(mid.lower())
    rows.sort(key=lambda r: (
        0 if r["available"] == "yes" else (1 if r["available"] == "n/a" else 2),
        r["kind"],
        -(r["price_5s_720p"] or 0),
    ))
    return rows


def cmd_models(argv):
    parser = argparse.ArgumentParser(prog="pt_video.py models")
    parser.add_argument("-t", "--type", default="all", choices=["video", "image", "seedance", "all"])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    key = resolve_key()
    rows = build_catalog(key, args.type)
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    print(f"{'MODEL':<34} {'KIND':<7} {'PRICE(5s/720p)':<15} {'MAX_DUR':<8} {'RES':<13} {'AVAIL':<5} INPUTS")
    print("-" * 120)
    for r in rows:
        price = f"${r['price_5s_720p']}" if r["price_5s_720p"] is not None else "n/a"
        dur = "—" if not r["max_dur_s"] else f"{r['max_dur_s']}s"
        print(f"{r['model']:<34} {r['kind']:<7} {price:<15} {dur:<8} "
              f"{r['resolution']:<13} {r['available']:<5} {r['inputs']}")
    if not key:
        print("\n[提示] 未配置 Key，以上为公开目录（价格基于 PT 预扣单价估算）。"
              "配置 Key 后 AVAIL 列显示你账号当前可用的模型（yes）。")
    print("[说明] 视频价格系数：时长线性（5s→10s = ×2），1080p = 720p ×2。图片按张计费，单价待补充（标 n/a）。"
          "参数以 powertokens.ai 仪表盘为准。")
    return 0


# ---------- 子命令 ----------
def cmd_check():
    key = resolve_key()
    cfg = load_config()
    status = {
        "key_configured": bool(key),
        "key_masked": ("****" + key[-4:]) if key else None,
        "default_model": cfg.get("default_model") or "auto",
        "onboard_url": ONBOARD_URL,
        "engine": "official REST (video: POST /v1/videos + poll; image: POST /v1/images/generations sync)",
    }
    print(json.dumps(status, ensure_ascii=False, indent=2))
    if not key:
        sys.stderr.write(ONBOARD_GUIDE)
        sys.stderr.write(KEY_MISSING_MSG)
        return 2
    return 0


def cmd_config(argv):
    parser = argparse.ArgumentParser(prog="pt_video.py config")
    parser.add_argument("--set-key")
    parser.add_argument("--set-model")
    parser.add_argument("--show", action="store_true")
    args = parser.parse_args(argv)
    cfg = load_config()
    if args.set_key:
        cfg["api_key"] = args.set_key
        save_config(cfg)
        print(f"[ok] 已保存 api_key 到 {CONFIG_PATH}（权限 0600）")
    if args.set_model:
        cfg["default_model"] = args.set_model
        save_config(cfg)
        print(f"[ok] 已保存 default_model={args.set_model}（generate 未写 -m 时优先用它；auto=按账号自动选）")
    if args.show or (not args.set_key and not args.set_model):
        masked = ("****" + cfg["api_key"][-4:]) if cfg.get("api_key") else "(未设置)"
        print(json.dumps({"api_key": masked,
                          "default_model": cfg.get("default_model", "") or "auto",
                          "config_path": str(CONFIG_PATH), "onboard": ONBOARD_URL},
                         ensure_ascii=False, indent=2))
    return 0


def cmd_auto_model(argv):
    parser = argparse.ArgumentParser(prog="pt_video.py auto-model")
    parser.add_argument("--type", default="video", choices=["video", "image", "seedance"])
    args = parser.parse_args(argv)
    key = resolve_key()
    if not key:
        sys.stderr.write(KEY_MISSING_MSG)
        return 2
    cands = auto_candidates(key, kind=args.type)
    print(json.dumps({"kind": args.type, "model": cands[0],
                      "resolved_by": "config 默认模型" if len(cands) == 1 and load_config().get("default_model") else "按 Key 额度自动选择",
                      "candidates": cands[:AUTO_MAX_TRIES]}, ensure_ascii=False))
    return 0


def cmd_estimate(argv):
    parser = argparse.ArgumentParser(prog="pt_video.py estimate")
    parser.add_argument("-m", "--model", required=True)
    parser.add_argument("-d", "--duration", type=int, default=5)
    parser.add_argument("-r", "--resolution", default="720p")
    parser.add_argument("--type", default="auto", choices=["video", "image", "auto"])
    args = parser.parse_args(argv)
    kind = args.type
    if kind == "auto":
        kind = kind_of_model(args.model)
    c = estimate_cost(args.model, args.duration, args.resolution, kind)
    if c is None:
        print(f"[estimate] {args.model}: 单价表无此模型，无法估算（已知模型见 `models`）")
        return 1
    print(json.dumps({"model": args.model, "kind": kind, "duration_s": args.duration,
                      "resolution": args.resolution, "est_cost_usd": c}, ensure_ascii=False))
    return 0


# ---------- 生成：媒体构造（视频/图片/seedance 共用，支持 asset://）----------
def build_media(args, force_asset=False):
    media = []
    if args.first_frame:
        media.append({"type": "first_frame", "url": args.first_frame})
    if args.last_frame:
        media.append({"type": "last_frame", "url": args.last_frame})
    for u in args.ref_image or []:
        media.append({"type": "reference_image", "url": u})
    for u in args.ref_video or []:
        media.append({"type": "reference_video", "url": u})
    for u in args.ref_audio or []:
        media.append({"type": "reference_audio", "url": u})
    # 校验：REST 接口 media[].url 必须是公网 http(s) 或资产库 asset://（Seedance 协议素材）
    for m in media:
        u = m["url"]
        if force_asset:
            # Seedance 独立类型：素材只收资产库 asset://，强制契约，避免误传 http 绕过协议
            if not u.startswith("asset://"):
                raise ApiError(0, f"Seedance 素材必须是资产库 asset:// 格式（如 asset://<ASSET_ID>），收到：{u}")
        else:
            if not (u.startswith("http://") or u.startswith("https://") or u.startswith("asset://")):
                raise ApiError(0, f"媒体地址必须是公网 http(s) 或资产库 asset:// 格式，收到：{u}")
    return media


# ---------- 视频生成：提交 + 自动轮询 ----------
# ---------- 共享 Payload 构造（CLI 与产品 API 共用，保证单一生成逻辑）----------
def build_video_payload(model, duration, resolution, ratio, prompt=None,
                        media=None, seed=None, no_audio=False,
                        no_prompt_extend=False, watermark=False,
                        is_seedance=False):
    """Build canonical video JSON payload.
    Ensures strict string conversion for seconds, size, ratio.
    """
    if is_seedance:
        # PT standard /v1/videos is not passthrough: prompt is top-level.
        body_media = list(media) if media else []
        body = {
            "model": str(model),
            "prompt": str(prompt or ""),
            "media": body_media,
            "size": str(resolution).upper(),
            "ratio": str(ratio),
            "seconds": str(duration),
            "generate_audio": not bool(no_audio),
            "prompt_extend": not bool(no_prompt_extend),
            "watermark": bool(watermark),
        }
    else:
        body = {
            "model": str(model),
            "prompt": str(prompt or ""),
            "size": str(resolution).upper(),
            "ratio": str(ratio),
            "seconds": str(duration),
            "generate_audio": not bool(no_audio),
            "prompt_extend": not bool(no_prompt_extend),
            "watermark": bool(watermark),
        }
        if media:
            body["media"] = list(media)
    if seed is not None:
        body["seed"] = int(seed)
    return body


def build_image_payload(model, prompt=None, aspect_ratio="1:1", n=1, seed=None, response_format=None):
    """Build canonical image JSON payload."""
    body = {
        "model": str(model),
        "prompt": str(prompt or ""),
        "aspect_ratio": str(aspect_ratio),
        "n": int(n),
    }
    if response_format:
        body["response_format"] = str(response_format)
    if seed is not None:
        body["seed"] = int(seed)
    return body


def submit_task(key, body, transport=None, timeout=SUBMIT_TIMEOUT):
    """POST /v1/videos，返回 task_id（str）。提交 HTTP 超时 = timeout。"""
    call_fn = transport or _api_call
    resp = call_fn("POST", VIDEO_SUBMIT, key, body, timeout)
    if not isinstance(resp, dict):
        raise ApiError(0, "提交响应非 JSON 结构，无法获取 task_id")
    if resp.get("error") is not None or resp.get("status") in ("failed", "error"):
        err_msg = resp.get("error") or resp.get("message") or "提交返回错误"
        raise ApiError(0, f"提交被上游拒绝: {err_msg}")
    tid = resp.get("id") or resp.get("task_id")
    if not isinstance(tid, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}", tid) or (key and key in tid):
        raise ApiError(0, "Submission response has no valid task identifier")
    return tid, resp



POLL_CB_5XX_MAX   = 8
POLL_CB_UNKN_MAX  = 40
POLL_CB_429_MAX   = 30
POLL_CB_429_BACKOFF_CAP = 60

_ALLOWED_POLL_STATUSES = {"queued", "pending", "in_progress", "processing", "running", "uploading", "submitted"}


def _parse_retry_after(raw_val):
    if not raw_val:
        return None
    try:
        val = float(raw_val)
        if math.isfinite(val) and val >= 0:
            return min(val, POLL_CB_429_BACKOFF_CAP)
    except (ValueError, TypeError):
        pass
    return None


def poll_task(key, task_id, interval=POLL_INTERVAL, timeout=POLL_TIMEOUT,
              _transport=None, _sleep=None, _clock=None, _cancel=None):
    """每 interval 秒查询一次，直到 succeeded/completed 或 failed/cancelled/超时。
    返回成功时的任务对象（含 metadata.url）。

    时序保证：
    - 采用单调时钟 time.monotonic
    - HTTP timeout <= 剩余总时限
    - 在发请求前、返回后、sleep 前后均检查截止与取消
    - 超时不因迟到成功而消失
    - 429 独立指数退避 + Retry-After 支持
    - 连续 5xx 与连续未识别状态分别计数熔断
    - 401/403/404 等致命非重试错误立即中断
    - 响应防错型保护与脱敏 stderr 状态标签
    """
    call_fn = _transport or _api_call
    _sleep = _sleep or time.sleep
    _clock = _clock or time.monotonic
    _cancel = _cancel or _NOT_CANCELLED

    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError(f"poll_task: timeout must be a positive finite number, got {timeout!r}")
    if isinstance(interval, bool) or not isinstance(interval, (int, float)) or not math.isfinite(interval) or interval <= 0:
        raise ValueError(f"poll_task: interval must be a positive finite number, got {interval!r}")

    deadline = _clock() + timeout
    last_status = None
    consec_5xx = 0
    consec_unkn = 0
    consec_429 = 0
    backoff_429 = interval

    while True:
        # Check cancellation & deadline before request
        if _cancel.is_cancelled:
            raise _PollOutcome("POLL_CANCELLED")
        remaining = deadline - _clock()
        if remaining <= 0:
            raise _PollOutcome("POLL_TIMEOUT")

        http_timeout = min(30.0, max(0.001, remaining))

        try:
            task = call_fn("GET", VIDEO_POLL.format(id=task_id), key, None, http_timeout)
            consec_5xx = 0
            consec_429 = 0
            backoff_429 = interval
        except ApiError as e:
            if e.status in (401, 402, 403, 404):
                raise e

            if e.status == 429:
                consec_429 += 1
                if consec_429 > POLL_CB_429_MAX:
                    raise ApiError(0, f"连续 429 限流 {consec_429} 次，熔断退出；task_id={task_id}")
                ra = getattr(e, "retry_after", None)
                parsed_ra = _parse_retry_after(ra)
                wait = parsed_ra if parsed_ra is not None else min(backoff_429, POLL_CB_429_BACKOFF_CAP)
                backoff_429 = min(backoff_429 * 2, POLL_CB_429_BACKOFF_CAP)
            elif e.status >= 500:
                consec_5xx += 1
                if consec_5xx > POLL_CB_5XX_MAX:
                    raise ApiError(0, f"连续 {consec_5xx} 次 5xx 错误，熔断退出；task_id={task_id}")
                wait = interval
            else:
                wait = interval

            # Check deadline before sleep
            remaining = deadline - _clock()
            if remaining <= 0 or _cancel.is_cancelled:
                if _cancel.is_cancelled:
                    raise _PollOutcome("POLL_CANCELLED")
                raise _PollOutcome("POLL_TIMEOUT")

            actual_sleep = min(wait, remaining)
            _sleep(actual_sleep)
            if _clock() >= deadline:
                raise _PollOutcome("POLL_TIMEOUT")
            continue

        # Check deadline and cancellation AFTER request: late arrival is a timeout!
        if _clock() >= deadline:
            raise _PollOutcome("POLL_TIMEOUT")
        if _cancel.is_cancelled:
            raise _PollOutcome("POLL_CANCELLED")

        if not isinstance(task, dict):
            consec_unkn += 1
            if consec_unkn > POLL_CB_UNKN_MAX:
                raise ApiError(0, f"连续 {consec_unkn} 次返回非字典响应，熔断退出；task_id={task_id}")
            _sleep(min(interval, max(0.001, deadline - _clock())))
            continue

        raw_status = task.get("status")
        status = str(raw_status).lower() if isinstance(raw_status, str) else ""
        last_status = status or "malformed_status"
        progress_val = task.get("progress")

        metadata = task.get("metadata")
        if status == "cancelled":
            raise _PollOutcome("REMOTE_TERMINAL_CANCELLED")
        if status in ("failed", "error") or task.get("error") or (isinstance(metadata, dict) and metadata.get("error")):
            raise _PollOutcome("REMOTE_TERMINAL_FAILED")
        if status in ("succeeded", "completed", "finished", "done", "ready"):
            return task

        if not status or status not in _ALLOWED_POLL_STATUSES:
            consec_unkn += 1
            if consec_unkn > POLL_CB_UNKN_MAX:
                raise ApiError(0, f"连续 {consec_unkn} 次未识别状态，熔断退出；task_id={task_id}")
        else:
            consec_unkn = 0

        # Sanitized stderr logging (never prints arbitrary status strings or raw provider body)
        disp_status = status if status in _ALLOWED_POLL_STATUSES else "checking"
        if isinstance(progress_val, (int, float)) and not isinstance(progress_val, bool) and math.isfinite(progress_val):
            disp_progress = f" {int(max(0, min(100, progress_val)))}%"
        else:
            disp_progress = ""
        sys.stderr.write(f"[poll] task {task_id} status={disp_status}{disp_progress}\n")

        # Check deadline before sleep
        remaining = deadline - _clock()
        if remaining <= 0 or _cancel.is_cancelled:
            if _cancel.is_cancelled:
                raise _PollOutcome("POLL_CANCELLED")
            raise _PollOutcome("POLL_TIMEOUT")

        actual_sleep = min(interval, remaining)
        _sleep(actual_sleep)
        if _clock() >= deadline:
            raise _PollOutcome("POLL_TIMEOUT")


def result_url(task):
    if not isinstance(task, dict):
        return None
    meta = task.get("metadata")
    if isinstance(meta, dict):
        u = meta.get("url") or meta.get("content_url")
        if u and isinstance(u, str):
            return u
    u = task.get("url")
    return u if isinstance(u, str) else None


def download_binary(url, path, key=None):
    """Download result binary WITHOUT sending Authorization header.
    Result URLs are pre-signed (image) or public CDN (video); sending Bearer
    leaks the key. key param retained for signature compatibility only —
    never attached to request headers."""
    req = urllib.request.Request(url, headers={"User-Agent": "pt-media-skill"})
    class _AnonymousRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return urllib.request.Request(newurl, headers={"User-Agent": "pt-media-skill"})
    opener = urllib.request.build_opener(_AnonymousRedirect)
    try:
        with opener.open(req, timeout=120) as r, open(path, "wb") as f:
            while True:
                chunk = r.read(DOWNLOAD_CHUNK)
                if not chunk:
                    break
                f.write(chunk)
        return True
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, f"下载失败 HTTP {e.code}")


# ---------- 资产库上传（Seedance 图生视频必须先把素材上传拿 asset://）----------
def upload_asset(key, path, group_name=None, poll_timeout=120):
    """上传本地文件到 PT 资产库，返回 asset_id（引用为 asset://<id>）。上传免费，不扣 credits。"""
    import uuid
    boundary = "----ptboundary" + uuid.uuid4().hex
    body = b""
    if group_name:
        body += f'--{boundary}\r\n'.encode()
        body += b'Content-Disposition: form-data; name="group_name"\r\n\r\n'
        body += group_name.encode() + b"\r\n"
    fn = os.path.basename(path)
    body += f'--{boundary}\r\n'.encode()
    body += f'Content-Disposition: form-data; name="file"; filename="{fn}"\r\n'.encode()
    body += b'Content-Type: application/octet-stream\r\n\r\n'
    with open(path, "rb") as f:
        body += f.read()
    body += b"\r\n"
    body += f'--{boundary}--\r\n'.encode()
    req = urllib.request.Request(
        ASSET_UPLOAD, data=body,
        headers={"Authorization": key, "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, f"资产上传失败：{e.read().decode('utf-8', 'replace')}")
    if data.get("code") != 200:
        raise ApiError(data.get("code", 0), f"资产上传失败：{data}")
    task_id = (data.get("data") or {}).get("task_id")
    if not task_id:
        raise ApiError(0, f"上传未返回 task_id：{data}")
    # 轮询 get-asset-id（无需鉴权）
    deadline = time.time() + poll_timeout
    while True:
        try:
            with urllib.request.urlopen(ASSET_GET_ID.format(task_id), timeout=30) as r:
                j = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, f"查询 asset_id 失败：{e.read().decode('utf-8', 'replace')}")
        aid = (j.get("data") or {}).get("asset_id")
        if aid:
            return aid
        if time.time() >= deadline:
            raise ApiError(0, f"轮询 asset_id 超时（>{poll_timeout}s），task_id={task_id}")
        time.sleep(2)


def cmd_upload(argv):
    parser = argparse.ArgumentParser(prog="pt_video.py upload")
    parser.add_argument("-f", "--file", required=True, help="本地文件路径")
    parser.add_argument("--group-name", default=None, help="资产组名（可选，自动创建/复用同名组）")
    args = parser.parse_args(argv)
    key = resolve_key()
    if not key:
        sys.stderr.write(KEY_MISSING_MSG)
        return 2
    if not os.path.isfile(args.file):
        sys.stderr.write(f"[error] 文件不存在：{args.file}\n")
        return 1
    sys.stderr.write(f"[upload] POST {ASSET_UPLOAD}  file={os.path.basename(args.file)}\n")
    aid = upload_asset(key, args.file, group_name=args.group_name)
    print(json.dumps({"ok": True, "asset_id": aid, "asset_ref": f"asset://{aid}"}, ensure_ascii=False))
    sys.stderr.write(f"[done] 资产已上传，引用：asset://{aid}\n")
    return 0


def generate_video(key, model, args, timeout, force_asset=False):
    """提交单个视频模型并轮询；成功返回 (url, output_path, task_id)。force_asset=Seedance 时媒体只收 asset://。"""
    media = build_media(args, force_asset=force_asset)
    if not args.prompt and not media:
        raise ApiError(0, "必须提供 -p/--prompt 或至少一种媒体输入（--first-frame/--ref-image...）")

    body = build_video_payload(
        model=model,
        duration=args.duration,
        resolution=args.resolution,
        ratio=args.ratio,
        prompt=args.prompt,
        media=media,
        seed=args.seed,
        no_audio=args.no_audio,
        no_prompt_extend=args.no_prompt_extend,
        watermark=args.watermark,
        is_seedance=force_asset,
    )

    sys.stderr.write(f"[submit] POST {PT_BASE}{VIDEO_SUBMIT}  model={model} seconds={args.duration} size={args.resolution.upper()} ratio={args.ratio}\n")
    task_id, _ = submit_task(key, body, timeout=SUBMIT_TIMEOUT)
    sys.stderr.write(f"[submit] 已提交，task_id={task_id}，开始轮询（每 {POLL_INTERVAL}s）...\n")
    task = poll_task(key, task_id, timeout=timeout)
    url = result_url(task)
    output = None
    if url and not args.no_download:
        out_dir = Path(args.output).resolve().parent if args.output else (SCRIPT_DIR / "out")
        out_dir.mkdir(parents=True, exist_ok=True)
        fname = args.output or str(out_dir / f"{task_id}.mp4")
        try:
            download_binary(url, fname, key)
            output = fname
            sys.stderr.write(f"[download] 已保存：{fname}\n")
        except Exception as e:
            sys.stderr.write(f"[warn] 下载失败（链接仍可用）：{e}\n")
    return url, output, task_id


# ---------- 图片生成：同步提交 ----------
def generate_image(key, model, args, timeout):
    """POST /v1/images/generations 同步返回 data[].url。成功返回 (urls, output_paths, None)。"""
    body = build_image_payload(
        model=model,
        prompt=args.prompt,
        aspect_ratio=args.aspect_ratio,
        n=getattr(args, "n", 1) or 1,
        seed=args.seed,
        response_format=getattr(args, "response_format", None),
    )

    sys.stderr.write(f"[submit] POST {PT_BASE}{IMAGE_ENDPOINT}  model={model} aspect_ratio={args.aspect_ratio}\n")
    resp = _api_call("POST", IMAGE_ENDPOINT, key, body, timeout=IMAGE_HTTP_TIMEOUT)
    data = resp.get("data") if isinstance(resp, dict) else []
    urls = [it.get("url") for it in data if isinstance(it, dict) and it.get("url")]
    if not urls:
        meta = resp.get("metadata") if isinstance(resp, dict) else {}
        sys.stderr.write(f"[warn] 响应未含 data[].url：{json.dumps(resp, ensure_ascii=False)[:300]}\n")
    outputs = []
    if urls and not args.no_download:
        out_dir = Path(args.output).resolve().parent if args.output else (SCRIPT_DIR / "out")
        out_dir.mkdir(parents=True, exist_ok=True)
        for i, url in enumerate(urls):
            if args.output and len(urls) > 1:
                p = Path(args.output)
                fname = str(p.parent / f"{p.stem}_{i+1}{p.suffix}")
            else:
                fname = args.output or str(out_dir / f"{model}_{i+1}.png")
            try:
                download_binary(url, fname, key)
                outputs.append(fname)
                sys.stderr.write(f"[download] 已保存：{fname}\n")
            except Exception as e:
                sys.stderr.write(f"[warn] 下载第 {i+1} 张失败（链接仍可用）：{e}\n")
    return urls, outputs, None


# ---------- Seedance 协议开通流程（全系通用；本地标记 + 报错回退）----------
# PT 没有查询「协议是否已签」的 API，只能仪表盘手动签。故用本地标记决定是否弹开通引导，
# 并在提交被拒报「未签」时重置标记、重新弹引导（报错回退）。


def seedance_enable_flow(key, model):
    """Seedance 协议（全系通用）：检测本地标记，未签则弹『跳转 PT 开通』流程（不阻断提交）。"""
    cfg = load_config()
    if cfg.get("seedance_agreement_signed"):
        return
    sys.stderr.write(
        f"[seedance] ⚠️ 使用 Seedance（全系 1.0/1.5/2.0/2.5）前需签署《Asset Library User Agreement》\n"
        f"  ① 打开并签署协议：{SEEDANCE_AGREEMENT_URL}\n"
        f"  ② 上传素材到资产库，拿到 asset://<ASSET_ID>\n"
        f"  ③ 用 asset:// 传入媒体，例如：--first-frame asset://xxxx\n"
        f"  ④ 签好后告诉本工具：python pt_video.py seedance enable\n"
        f"  （协议只能网页手动签，无 API 可代签；标记后此提示不再出现。若提交仍报未签，会自动重置并再提示）\n"
    )


def mark_seedance_signed():
    cfg = load_config()
    if not cfg.get("seedance_agreement_signed"):
        cfg["seedance_agreement_signed"] = True
        save_config(cfg)
        sys.stderr.write("[seedance] 已记录协议为已签（本地标记）；后续不再弹开通引导\n")


def reset_seedance_signed():
    cfg = load_config()
    if cfg.get("seedance_agreement_signed"):
        cfg["seedance_agreement_signed"] = False
        save_config(cfg)
        sys.stderr.write("[seedance] 检测到协议未签，已重置本地标记；请签好后跑 `seedance enable`\n")


# ============================================================
# PUBLIC PRODUCT API (R3 HARDENED)
# ============================================================
_ALLOWED_KINDS = {"image", "video", "seedance"}
_ALLOWED_RESOLUTIONS = {"480p", "480P", "720p", "720P", "1080p", "1080P"}
_ALLOWED_RATIOS = {"adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"}
_ALLOWED_ASPECT_RATIOS = {"1:1", "16:9", "4:3", "3:4", "9:16", "3:2", "2:3"}
_MAX_PROMPT_LEN = 2000
_MAX_MODEL_ID_LEN = 128
_MAX_ASSET_URL_LEN = 512
_MAX_DURATION = 30
_MIN_DURATION = 2
_MAX_N_IMAGES = 9
_MAX_REF_IMAGES = 10
_SEEDANCE_ASSET_RE = re.compile(r"^asset://[a-zA-Z0-9_.-]+\Z")


def _is_safe_result_url(url):
    if not isinstance(url, str) or not url or len(url) > 8192 or url != url.strip():
        return False
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
        return False
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
            return False
        if parsed.username is not None or parsed.password is not None:
            return False
        host = parsed.hostname
        if any(c in host for c in "\\%/?#@") or not host.rstrip('.'):
            return False
        host.encode('idna')
        port = parsed.port  # Access validates non-numeric and out-of-range ports.
        if parsed.netloc.endswith(':') or (port is not None and port < 1):
            return False
    except (ValueError, UnicodeError):
        return False
    return True


class ProductResult:
    """Structured result returned by generate_for_product.
    Does NOT include raw prompt, full provider body, Key, or local paths.
    """
    __slots__ = ("ok", "task_id", "model", "kind", "status",
                 "result_urls", "billing_params", "error_code", "error_hint",
                 "cost_unknown")

    def __init__(self, *, ok, task_id=None, model=None, kind=None, status=None,
                 result_urls=None, billing_params=None,
                 error_code=None, error_hint=None):
        self.ok = ok
        self.task_id = task_id
        self.model = model
        self.kind = kind
        self.status = status
        self.result_urls = list(result_urls) if result_urls else []
        self.billing_params = dict(billing_params) if billing_params else {}
        self.error_code = error_code
        self.error_hint = error_hint
        self.cost_unknown = True  # product cost always unknown; use F3 snapshot

    def to_dict(self):
        d = {
            "ok": self.ok,
            "task_id": self.task_id,
            "model": self.model,
            "kind": self.kind,
            "status": self.status,
            "result_urls": self.result_urls,
            "billing_params": self.billing_params,
            "cost_usd": None,   # always null — F3 price snapshot must supply
            "cost_unknown": self.cost_unknown,
        }
        if not self.ok:
            d["error_code"] = self.error_code
            d["error_hint"] = self.error_hint
        return d


class ProductRequest:
    """Input contract for generate_for_product. All fields explicit; no defaults from config/env."""
    __slots__ = ("model", "kind", "prompt", "duration", "resolution", "ratio",
                 "aspect_ratio", "n", "seed", "first_frame", "last_frame",
                 "ref_images", "no_audio", "no_prompt_extend", "watermark",
                 "poll_timeout", "submit_timeout", "poll_interval")

    def __init__(self, *, model, kind, prompt="",
                 duration=5, resolution="720p", ratio="adaptive",
                 aspect_ratio="1:1", n=1, seed=None,
                 first_frame=None, last_frame=None, ref_images=None,
                 no_audio=False, no_prompt_extend=False, watermark=False,
                 poll_timeout=POLL_TIMEOUT, submit_timeout=SUBMIT_TIMEOUT,
                 poll_interval=POLL_INTERVAL):
        self.model = model
        self.kind = kind
        self.prompt = prompt
        self.duration = duration
        self.resolution = resolution
        self.ratio = ratio
        self.aspect_ratio = aspect_ratio
        self.n = n
        self.seed = seed
        self.first_frame = first_frame
        self.last_frame = last_frame
        self.ref_images = list(ref_images) if ref_images is not None else []
        self.no_audio = no_audio
        self.no_prompt_extend = no_prompt_extend
        self.watermark = watermark
        self.poll_timeout = poll_timeout
        self.submit_timeout = submit_timeout
        self.poll_interval = poll_interval


class _RequestSnapshot:
    """Immutable snapshot captured at entry of generate_for_product.
    Protects against caller or hooks mutating request parameters mid-flight.
    """
    __slots__ = ("model", "kind", "prompt", "duration", "resolution", "ratio",
                 "aspect_ratio", "n", "seed", "first_frame", "last_frame",
                 "ref_images", "no_audio", "no_prompt_extend", "watermark",
                 "poll_timeout", "submit_timeout", "poll_interval")

    def __init__(self, req):
        self.model = getattr(req, "model", None)
        self.kind = getattr(req, "kind", None)
        self.prompt = getattr(req, "prompt", None)
        self.duration = getattr(req, "duration", None)
        self.resolution = getattr(req, "resolution", None)
        self.ratio = getattr(req, "ratio", None)
        self.aspect_ratio = getattr(req, "aspect_ratio", None)
        self.n = getattr(req, "n", None)
        self.seed = getattr(req, "seed", None)
        self.first_frame = getattr(req, "first_frame", None)
        self.last_frame = getattr(req, "last_frame", None)
        raw_refs = getattr(req, "ref_images", None)
        self.ref_images = tuple(raw_refs) if raw_refs else ()
        self.no_audio = getattr(req, "no_audio", False)
        self.no_prompt_extend = getattr(req, "no_prompt_extend", False)
        self.watermark = getattr(req, "watermark", False)
        self.poll_timeout = getattr(req, "poll_timeout", POLL_TIMEOUT)
        self.submit_timeout = getattr(req, "submit_timeout", SUBMIT_TIMEOUT)
        self.poll_interval = getattr(req, "poll_interval", POLL_INTERVAL)


class ProductHooks:
    """Optional hooks injected into generate_for_product."""
    def before_submit(self, metadata: dict) -> None:
        """Called before any billable POST. metadata: model, kind, endpoint, billing_params only."""
    def on_task_id(self, task_id: str) -> None:
        """Called immediately after receiving task_id, before first poll."""
    def on_result(self, result: ProductResult) -> None:
        """Called with final result; failure here must not re-submit."""


class TaskIdWriteError(Exception):
    """Raised when on_task_id hook fails.
    Preserves task_id but strictly redacts any raw cause message, keys, prompts, or sentinels.
    """
    def __init__(self, task_id, cause_type_name="UnknownError"):
        self.task_id = str(task_id) if task_id is not None else ""
        self.cause_type = str(cause_type_name)
        super().__init__(f"Failed to record task_id [task_id={self.task_id}, cause_type={self.cause_type}]")


def _validate_product_request(snap, api_key):
    """Validate snapshot strictly. Raises ValueError on bad input.
    Error messages do NOT echo raw user prompt, key, or path.
    """
    if not api_key or not isinstance(api_key, str) or not api_key.strip():
        raise ValueError("api_key must be a non-empty string; no fallback to env or config")
    if not snap.model or not isinstance(snap.model, str):
        raise ValueError("model must be a non-empty string")
    if len(snap.model) > _MAX_MODEL_ID_LEN:
        raise ValueError(f"model ID exceeds maximum length of {_MAX_MODEL_ID_LEN}")
    if snap.model != snap.model.strip() or any(c.isspace() or ord(c) < 32 for c in snap.model):
        raise ValueError("model must be an exact identifier")
    if snap.model.lower() == "auto":
        raise ValueError("model='auto' not allowed in product API; caller must supply exact model ID")
    if not isinstance(snap.kind, str) or snap.kind not in _ALLOWED_KINDS:
        raise ValueError(f"kind must be one of {sorted(_ALLOWED_KINDS)}")

    # Duration & n type checks (guarding against bool disguised as int!)
    if isinstance(snap.duration, bool) or not isinstance(snap.duration, int):
        raise ValueError(f"duration must be an integer, got {type(snap.duration).__name__}")
    if not (_MIN_DURATION <= snap.duration <= _MAX_DURATION):
        raise ValueError(f"duration must be in [{_MIN_DURATION}, {_MAX_DURATION}]")

    if isinstance(snap.n, bool) or not isinstance(snap.n, int):
        raise ValueError(f"n must be an integer, got {type(snap.n).__name__}")
    if not (1 <= snap.n <= _MAX_N_IMAGES):
        raise ValueError(f"n must be in [1, {_MAX_N_IMAGES}]")

    # Timeouts & intervals (finite positive numbers, not bools)
    for name, val, lo, hi in [
        ("poll_timeout", snap.poll_timeout, 10, 7200),
        ("submit_timeout", snap.submit_timeout, 10, 600),
        ("poll_interval", snap.poll_interval, 1, 120),
    ]:
        if isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val):
            raise ValueError(f"{name} must be a finite number")
        if not (lo <= val <= hi):
            raise ValueError(f"{name} must be in [{lo}, {hi}]")

    # Prompt check
    if snap.prompt is not None:
        if not isinstance(snap.prompt, str):
            raise ValueError("prompt must be a string")
        if len(snap.prompt) > _MAX_PROMPT_LEN:
            raise ValueError(f"prompt exceeds maximum length of {_MAX_PROMPT_LEN}")

    # Seed check
    if snap.seed is not None:
        if isinstance(snap.seed, bool) or not isinstance(snap.seed, int):
            raise ValueError("seed must be an integer")
        if not (0 <= snap.seed <= 2147483647):
            raise ValueError("seed must be in [0, 2147483647]")

    # Booleans
    for b_name in ("no_audio", "no_prompt_extend", "watermark"):
        b_val = getattr(snap, b_name)
        if not isinstance(b_val, bool):
            raise ValueError(f"{b_name} must be a boolean")

    # ref_images check
    if not isinstance(snap.ref_images, (list, tuple)):
        raise ValueError("ref_images must be a list or tuple")
    if len(snap.ref_images) > _MAX_REF_IMAGES:
        raise ValueError(f"ref_images count exceeds maximum of {_MAX_REF_IMAGES}")

    for frame in (snap.first_frame, snap.last_frame):
        if frame is not None and (not isinstance(frame, str) or not frame):
            raise ValueError("Frame must be a non-empty string when supplied")
    # Media items collection
    media_items = [u for u in [snap.first_frame, snap.last_frame] if u] + list(snap.ref_images)

    # Empty prompt + empty media rejection
    has_text = bool(snap.prompt and snap.prompt.strip())
    if not has_text and not media_items:
        raise ValueError("Request must provide either non-empty prompt or at least one media input")

    # Image2image unsupported across ALL image models!
    if snap.kind == "image":
        if media_items:
            raise ValueError(
                "Image-to-image / subject reference is unsupported for all image models. "
                "Only text2image is supported. 0 POSTs made."
            )
        if not isinstance(snap.aspect_ratio, str):
            raise ValueError("aspect_ratio must be a string")
        if snap.aspect_ratio not in _ALLOWED_ASPECT_RATIOS:
            raise ValueError(f"aspect_ratio must be one of {sorted(_ALLOWED_ASPECT_RATIOS)}")

    if snap.kind in ("video", "seedance"):
        if not isinstance(snap.resolution, str):
            raise ValueError("resolution must be a string")
        if snap.resolution.upper() not in {r.upper() for r in _ALLOWED_RESOLUTIONS}:
            raise ValueError(f"resolution must be one of {sorted(_ALLOWED_RESOLUTIONS)}")
        if not isinstance(snap.ratio, str):
            raise ValueError("ratio must be a string")
        if snap.ratio not in _ALLOWED_RATIOS:
            raise ValueError(f"ratio must be one of {sorted(_ALLOWED_RATIOS)}")

    # Seedance media validation: strictly only asset:// format with fullmatch!
    if snap.kind == "seedance":
        for u in media_items:
            if not isinstance(u, str):
                raise ValueError("Seedance media item must be a string")
            if any(ord(c) < 32 or ord(c) == 127 for c in u) or not _SEEDANCE_ASSET_RE.fullmatch(u):
                raise ValueError(
                    "Seedance media URL must strictly follow asset://<asset_id> format. "
                    "http(s), file://, empty asset ID, control characters, or trailing newlines are rejected."
                )

    # Video media validation: http(s) or asset://
    if snap.kind == "video":
        for u in media_items:
            if not isinstance(u, str):
                raise ValueError("Video media item must be a string")
            if any(ord(c) < 32 or ord(c) == 127 for c in u):
                raise ValueError("Video media URL contains illegal control characters")
            if not (u.startswith("http://") or u.startswith("https://") or u.startswith("asset://")):
                raise ValueError("Video media URL must be http(s):// or asset:// format")

    for u in media_items:
        if len(u) > _MAX_ASSET_URL_LEN:
            raise ValueError(f"Media URL exceeds maximum length of {_MAX_ASSET_URL_LEN}")


def generate_for_product(request: ProductRequest, *, api_key: str,
                         hooks: ProductHooks = None,
                         _transport=None, _sleep=None, _clock=None,
                         _cancel: CancellationToken = None) -> ProductResult:
    """Stable product API entry point for Northstar host.
    R3 hardened:
    - Immutable snapshot captured before any processing or hook execution
    - Shared payload builders with CLI
    - Fully testable transport passing body
    - Monotonic clock with strict deadline checks
    - Image-to-image rejected for ALL image models
    - Seedance strictly asset:// (no trailing newlines)
    - True conservative POST error handling (SUBMISSION_OUTCOME_UNKNOWN, 1 POST only)
    - Full URL validation on all image results
    - Image cancellation after submit preserves results and marks completed_locally_cancelled
    - on_result failure distinguishes remote success vs local save failure
    - TaskIdWriteError completely sanitized
    """
    hooks = hooks or ProductHooks()
    _cancel = _cancel or _NOT_CANCELLED
    _clock = _clock or time.monotonic
    _sleep = _sleep or time.sleep
    if _transport is None:
        def call_fn(method, path, key, body, timeout):
            return _api_call(method, path, key, body, timeout, clock=_clock,
                             deadline=_clock() + timeout, cancel=_cancel)
    else:
        call_fn = _transport

    # 1. Capture immutable snapshot
    snap = _RequestSnapshot(request)

    # 2. Validate snapshot
    try:
        _validate_product_request(snap, api_key)
    except ValueError as e:
        return ProductResult(ok=False, error_code="INVALID_REQUEST",
                             error_hint=str(e), kind=snap.kind, model=snap.model)

    billing_params = {
        "model": snap.model,
        "kind": snap.kind,
        "duration_s": snap.duration if snap.kind != "image" else None,
        "resolution": snap.resolution if snap.kind != "image" else None,
        "n_images": snap.n if snap.kind == "image" else None,
        "aspect_ratio": snap.aspect_ratio if snap.kind == "image" else None,
    }

    # 3. before_submit hook (passed deepcopy so hook cannot mutate parameters)
    meta = {
        "model": snap.model,
        "kind": snap.kind,
        "endpoint": IMAGE_ENDPOINT if snap.kind == "image" else VIDEO_SUBMIT,
        "billing_params": copy.deepcopy(billing_params),
    }
    try:
        hooks.before_submit(copy.deepcopy(meta))
    except Exception as e:
        return ProductResult(ok=False, error_code="BEFORE_SUBMIT_REJECTED",
                             error_hint=f"before_submit hook rejected: {type(e).__name__}",
                             model=snap.model, kind=snap.kind)

    # 4. Check cancellation before submit
    if _cancel.is_cancelled:
        return ProductResult(ok=False, error_code="CANCELLED_BEFORE_SUBMIT",
                             error_hint="Cancelled before submit; 0 charges",
                             model=snap.model, kind=snap.kind)

    # 5. Handle IMAGE path (synchronous)
    if snap.kind == "image":
        body = build_image_payload(
            model=snap.model,
            prompt=snap.prompt,
            aspect_ratio=snap.aspect_ratio,
            n=snap.n,
            seed=snap.seed,
        )
        try:
            resp = call_fn("POST", IMAGE_ENDPOINT, api_key, body, snap.submit_timeout)
        except ApiError as e:
            if e.status in (408, 502, 503, 504) or e.status >= 500 or e.status == 0:
                return ProductResult(
                    ok=False,
                    error_code="SUBMISSION_OUTCOME_UNKNOWN",
                    error_hint=f"Image POST 未获得确定性响应 (HTTP {e.status})；上游受理状态未知，严禁自动重提或二次提交。",
                    status="submission_unknown",
                    model=snap.model,
                    kind="image",
                    billing_params=billing_params,
                )
            code, hint = classify_error(e)
            return ProductResult(ok=False, error_code=code, error_hint=hint,
                                 model=snap.model, kind="image", billing_params=billing_params)
        except Exception as e:
            return ProductResult(
                ok=False,
                error_code="SUBMISSION_OUTCOME_UNKNOWN",
                error_hint=f"Image POST 发生网络/传输异常 ({type(e).__name__})；受理状态未知，禁止重新提交。",
                status="submission_unknown",
                model=snap.model,
                kind="image",
                billing_params=billing_params,
            )

        # Validate response structure and error envelope
        if not isinstance(resp, dict):
            return ProductResult(ok=False, error_code="SUBMISSION_OUTCOME_UNKNOWN",
                                 error_hint="Image POST 响应非 JSON 字典结构；受理状态未知，严禁二次提交。",
                                 model=snap.model, kind="image", billing_params=billing_params)

        image_status = resp.get("status")
        image_status = image_status.lower() if isinstance(image_status, str) else image_status
        if image_status in ("failed", "cancelled", "error") or resp.get("error") or resp.get("code") not in (None, 200, 0):
            return ProductResult(ok=False, error_code="IMAGE_REMOTE_FAILED",
                                 status="failed",
                                 error_hint="图片生成被远端拒绝或失败；不自动重提。",
                                 model=snap.model, kind="image", billing_params=billing_params)

        if image_status is not None and image_status not in ("succeeded", "completed", "finished", "done", "ready"):
            return ProductResult(ok=False, error_code="SUBMISSION_OUTCOME_UNKNOWN", status="submission_unknown",
                                 error_hint="图片响应状态无法确认完成；不自动重提。",
                                 model=snap.model, kind="image", billing_params=billing_params)

        raw_data = resp.get("data")
        if not isinstance(raw_data, list):
            return ProductResult(ok=False, error_code="IMAGE_RESULT_EMPTY",
                                 error_hint="HTTP 200 但未返回合法的 data[] 列表",
                                 model=snap.model, kind="image", billing_params=billing_params)

        urls = []
        for item in raw_data:
            if not isinstance(item, dict):
                return ProductResult(ok=False, error_code="IMAGE_RESULT_INVALID_URL",
                                     error_hint="data[] 项非字典结构，拒绝混合结果",
                                     model=snap.model, kind="image", billing_params=billing_params)
            item_status = item.get("status")
            item_status = item_status.lower() if isinstance(item_status, str) else item_status
            if item_status in ("failed", "cancelled", "error") or item.get("error"):
                return ProductResult(ok=False, error_code="IMAGE_REMOTE_FAILED", status="failed",
                                     error_hint="图片结果包含失败项；不自动重提。",
                                     model=snap.model, kind="image", billing_params=billing_params)
            u = item.get("url")
            if not _is_safe_result_url(u) or api_key in u:
                return ProductResult(ok=False, error_code="IMAGE_RESULT_INVALID_URL",
                                     error_hint="图片结果 URL 方案非法或包含畸形主机/用户凭据",
                                     model=snap.model, kind="image", billing_params=billing_params)
            urls.append(u)

        if not urls:
            return ProductResult(ok=False, error_code="IMAGE_RESULT_EMPTY",
                                 error_hint="HTTP 200 但未返回任何有效结果 URL；cannot return ok:true",
                                 model=snap.model, kind="image", billing_params=billing_params)

        # Check local cancellation during or immediately after POST
        if _cancel.is_cancelled:
            result = ProductResult(
                ok=False,
                error_code="CANCELLED_AFTER_SUBMIT",
                error_hint="远端图片生成已受理/完成，但本地已被取消；结果URL已保留供核对，不再次提交。",
                model=snap.model,
                kind="image",
                status="completed_locally_cancelled",
                result_urls=urls,
                billing_params=billing_params,
            )
            try:
                hooks.on_result(result)
            except Exception:
                result.error_code = "ON_RESULT_FAILED"
                result.error_hint = "远端结果已产生，但本地保存失败；不自动重提。"
                result.status = "completed_local_save_failed"
            return result

        status = "completed" if len(urls) == snap.n else "completed_partial"
        result = ProductResult(ok=True, model=snap.model, kind="image",
                               status=status, result_urls=urls,
                               billing_params=billing_params)
        try:
            hooks.on_result(result)
        except Exception as e:
            return ProductResult(
                ok=False,
                error_code="ON_RESULT_FAILED",
                error_hint=f"Remote task succeeded, but on_result local persistence failed ({type(e).__name__})",
                model=result.model,
                kind=result.kind,
                status="completed_local_save_failed",
                result_urls=result.result_urls,
                billing_params=result.billing_params,
            )
        return result

    # 6. Handle VIDEO / SEEDANCE path (async POST + poll)
    is_seedance = (snap.kind == "seedance")
    media = []
    if snap.first_frame:
        media.append({"type": "first_frame", "url": snap.first_frame})
    if snap.last_frame:
        media.append({"type": "last_frame", "url": snap.last_frame})
    for u in snap.ref_images:
        media.append({"type": "reference_image", "url": u})

    body = build_video_payload(
        model=snap.model,
        duration=snap.duration,
        resolution=snap.resolution,
        ratio=snap.ratio,
        prompt=snap.prompt,
        media=media,
        seed=snap.seed,
        no_audio=snap.no_audio,
        no_prompt_extend=snap.no_prompt_extend,
        watermark=snap.watermark,
        is_seedance=is_seedance,
    )

    # Submit task (exactly once)
    task_id = None
    try:
        task_id, resp = submit_task(api_key, body, transport=call_fn, timeout=snap.submit_timeout)
    except ApiError as e:
        if e.status in (408, 502, 503, 504) or e.status >= 500 or e.status == 0:
            return ProductResult(
                ok=False,
                error_code="SUBMISSION_OUTCOME_UNKNOWN",
                error_hint=f"Video POST 未获得确定性响应 (HTTP {e.status})；上游受理状态未知，严禁自动重提或二次提交。",
                status="submission_unknown",
                model=snap.model,
                kind=snap.kind,
                billing_params=billing_params,
            )
        code, hint = classify_error(e)
        return ProductResult(ok=False, error_code=code, error_hint=hint,
                             model=snap.model, kind=snap.kind, billing_params=billing_params)
    except Exception as e:
        return ProductResult(
            ok=False,
            error_code="SUBMISSION_OUTCOME_UNKNOWN",
            error_hint=f"Video POST 发生网络/传输异常 ({type(e).__name__})；受理状态未知，禁止重新提交。",
            status="submission_unknown",
            model=snap.model,
            kind=snap.kind,
            billing_params=billing_params,
        )

    # on_task_id hook — must fire before first poll; sanitized on failure
    task_write_err = None
    try:
        hooks.on_task_id(task_id)
    except Exception as e:
        task_write_err = TaskIdWriteError(task_id, type(e).__name__)
    if task_write_err is not None:
        raise task_write_err

    # Poll task
    try:
        task = poll_task(
            api_key, task_id,
            interval=snap.poll_interval,
            timeout=snap.poll_timeout,
            _transport=call_fn,
            _sleep=_sleep,
            _clock=_clock,
            _cancel=_cancel,
        )
    except ApiError as e:
        reason = e.reason if isinstance(e, _PollOutcome) else None
        if reason == "POLL_CANCELLED":
            return ProductResult(ok=False, error_code="CANCELLED_DURING_POLL",
                                 error_hint=f"Cancelled during poll; task_id={task_id} retained for reconciliation",
                                 task_id=task_id, model=snap.model, kind=snap.kind,
                                 status="unknown_cancelled", billing_params=billing_params)
        if reason == "POLL_TIMEOUT":
            return ProductResult(ok=False, error_code="POLL_TIMEOUT",
                                 error_hint=f"Local poll timeout; task_id={task_id} retained. "
                                             f"DO NOT resubmit; check status manually.",
                                 task_id=task_id, model=snap.model, kind=snap.kind,
                                 status="unknown_timeout", billing_params=billing_params)
        if reason == "REMOTE_TERMINAL_FAILED":
            return ProductResult(ok=False, error_code="REMOTE_TASK_FAILED",
                                 error_hint="远端任务已明确执行失败；不自动重提。",
                                 task_id=task_id, model=snap.model, kind=snap.kind,
                                 status="failed", billing_params=billing_params)
        if reason == "REMOTE_TERMINAL_CANCELLED":
            return ProductResult(ok=False, error_code="REMOTE_TASK_CANCELLED",
                                 error_hint="远端任务已明确取消；不自动重提。",
                                 task_id=task_id, model=snap.model, kind=snap.kind,
                                 status="cancelled", billing_params=billing_params)
        return ProductResult(ok=False, error_code="POLL_QUERY_FAILED",
                             error_hint="任务已提交但查询失败；保留任务ID核对，不自动重提。",
                             task_id=task_id, model=snap.model, kind=snap.kind,
                             status="unknown_poll_error", billing_params=billing_params)
    except Exception as e:
        return ProductResult(ok=False, error_code="POLL_MALFORMED_OR_CIRCUIT_TRIP",
                             error_hint=f"轮询发生未受检异常或响应错型 ({type(e).__name__})；task_id={task_id} 保留待核对。",
                             task_id=task_id, model=snap.model, kind=snap.kind,
                             status="unknown_poll_error", billing_params=billing_params)

    url = result_url(task)
    if not _is_safe_result_url(url) or api_key in url:
        return ProductResult(ok=False, error_code="VIDEO_RESULT_EMPTY",
                             error_hint="Task succeeded but result URL absent or invalid; cannot return ok:true",
                             task_id=task_id, model=snap.model, kind=snap.kind,
                             status="unknown_result_missing", billing_params=billing_params)

    # Check local cancellation right after poll completed
    if _cancel.is_cancelled:
        result = ProductResult(
            ok=False,
            error_code="CANCELLED_AFTER_SUBMIT",
            error_hint="远端视频已生成，但本地已被取消；结果URL已保留供核对，不再次提交。",
            task_id=task_id,
            model=snap.model,
            kind=snap.kind,
            status="completed_locally_cancelled",
            result_urls=[url],
            billing_params=billing_params,
        )
        try:
            hooks.on_result(result)
        except Exception:
            result.error_code = "ON_RESULT_FAILED"
            result.error_hint = "远端结果已产生，但本地保存失败；不自动重提。"
            result.status = "completed_local_save_failed"
        return result

    result = ProductResult(ok=True, task_id=task_id, model=snap.model,
                           kind=snap.kind, status="completed",
                           result_urls=[url], billing_params=billing_params)

    # on_result hook
    try:
        hooks.on_result(result)
    except Exception as e:
        return ProductResult(
            ok=False,
            error_code="ON_RESULT_FAILED",
            error_hint=f"Remote task succeeded, but on_result local persistence failed ({type(e).__name__})",
            task_id=result.task_id,
            model=result.model,
            kind=result.kind,
            status="completed_local_save_failed",
            result_urls=result.result_urls,
            billing_params=result.billing_params,
        )

    return result


def cmd_generate(argv):
    parser = argparse.ArgumentParser(prog="pt_video.py generate")
    parser.add_argument("-m", "--model", default=None, help="模型 ID；省略或 auto = 按账号自动选")
    parser.add_argument("--type", default="auto", choices=["video", "image", "seedance", "auto"],
                        help="生成类型（默认 auto=按模型 ID 推断；video/image/seedance 三选一；"
                             "seedance 为独立类型，需签协议且素材走 asset://）")
    parser.add_argument("-p", "--prompt", default=None, help="文本提示词")
    # 视频参数
    parser.add_argument("-d", "--duration", type=int, default=5, help="时长秒数 2-30（默认 5）")
    parser.add_argument("-r", "--resolution", default="720p", help="480P/720P/1080P（视频，默认 720p）")
    parser.add_argument("--ratio", default="adaptive", help="视频比例 adaptive/16:9/4:3/1:1/3:4/9:16")
    # 图片参数
    parser.add_argument("--aspect-ratio", default="1:1", help="图片宽高比 1:1/16:9/4:3/...（图片，默认 1:1）")
    parser.add_argument("--n", type=int, default=1, help="图片数量 1-9（图片）")
    parser.add_argument("--response-format", default="url", choices=["url", "base64"], help="图片返回形式（图片）")
    # 共用
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--first-frame", default=None, help="首帧图 URL（图生视频/asset://）")
    parser.add_argument("--last-frame", default=None, help="尾帧图 URL（首尾帧）")
    parser.add_argument("--ref-image", action="append", default=[], help="参考图 URL（可重复）")
    parser.add_argument("--ref-video", action="append", default=[], help="参考视频 URL（可重复）")
    parser.add_argument("--ref-audio", action="append", default=[], help="参考音频 URL（可重复）")
    parser.add_argument("--no-audio", action="store_true", help="关闭输出音轨")
    parser.add_argument("--no-prompt-extend", action="store_true", help="关闭 prompt 智能改写")
    parser.add_argument("--watermark", action="store_true", help="添加 AI 生成水印")
    parser.add_argument("-o", "--output", default=None, help="下载保存路径")
    parser.add_argument("--no-download", action="store_true", help="只返回链接，不下载")
    parser.add_argument("--timeout", type=int, default=POLL_TIMEOUT, help=f"视频轮询总上限秒（默认 {POLL_TIMEOUT}）")
    parser.add_argument("--json", action="store_true", help="最终以 JSON 输出结果（便于 MCP 解析）")
    args = parser.parse_args(argv)

    key = resolve_key()
    if not key:
        sys.stderr.write(KEY_MISSING_MSG)
        return 2

    model_val = args.model
    # 确定类型
    kind = args.type
    if model_val and is_image_model(model_val):
        kind = "image"
    elif model_val and is_seedance(model_val):
        kind = "seedance"
    elif model_val and is_video_model(model_val):
        kind = "video"
    elif kind == "auto":
        kind = "video"   # 未指定模型且无法推断时，默认走视频 auto（兼容原行为）
    # 此后 kind ∈ {video, image, seedance}

    # 解析最终模型列表（auto / 默认模型 / 显式指定+预校验）
    if model_val is None or model_val.lower() == "auto":
        explicit_auto = model_val is not None and model_val.lower() == "auto"
        cands = auto_candidates(key, kind=kind, ignore_default=explicit_auto)[:AUTO_MAX_TRIES]
        if not cands:
            sys.stderr.write(f"[error] 拉不到可用{kind}模型列表，无法 auto；请显式 -m <id> 或检查 Key\n")
            return 1
        sys.stderr.write(f"[auto] {kind} 候选顺序：{cands}\n")
        last_err = None
        for i, cand in enumerate(cands):
            try:
                return _run_one(key, cand, kind, args)
            except ApiError as e:
                low = str(e.message).lower()
                last_err = e
                if i + 1 < len(cands) and ("not supported" in low or "not listed" in low
                                          or "model_not_found" in low or "model is not" in low):
                    sys.stderr.write(f"[auto] {cand} 不可用（{e.message}），换下一个\n")
                    continue
                # Seedance 协议未签：重置标记并弹开通引导后退出
                if kind == "seedance" and is_agreement_error(e):
                    reset_seedance_signed()
                    seedance_enable_flow(key, cand)
                sys.stderr.write(f"[error] 生成失败：{e.message}\n")
                return 1
        sys.stderr.write(f"[error] 全部候选失败，最后错误：{getattr(last_err, 'message', last_err)}\n")
        return 1
    else:
        ok, val = precheck_explicit_model(key, model_val, kind=kind)
        if not ok:
            sugg, total = val
            sys.stderr.write(
                f"[error] 模型 {model_val} 不在你账号的可用列表里（校验自 GET /v1/models，"
                f"未进入生成流程、未扣费）\n"
            )
            if sugg:
                sys.stderr.write("你是不是想用：" + " / ".join(sugg) + "\n")
            sys.stderr.write(f"跑 `models` 查看你账号当前可调用的 {total} 个模型\n")
            return 3
        try:
            return _run_one(key, val, kind, args)
        except ApiError as e:
            if kind == "seedance" and is_agreement_error(e):
                reset_seedance_signed()
                seedance_enable_flow(key, val)
            sys.stderr.write(f"[error] 生成失败：{e.message}\n")
            return 1


def _run_one(key, model, kind, args):
    if kind == "seedance":
        # 未签协议时弹开通引导（不阻断）；Seedance 文生视频把 prompt 放进 media 的 text 类型，
        # 若用户传了图/视频媒体则其 url 必须是资产库 asset://；成功生成后记为已签。
        seedance_enable_flow(key, model)
        url, output, tid = generate_video(key, model, args, args.timeout, force_asset=True)
        mark_seedance_signed()
        _finish_video(model, url, output, tid, args, kind="seedance")
        return 0
    if kind == "image":
        urls, outputs, _ = generate_image(key, model, args, IMAGE_HTTP_TIMEOUT)
        _finish_image(model, urls, outputs, args)
        return 0
    else:
        url, output, tid = generate_video(key, model, args, args.timeout)
        _finish_video(model, url, output, tid, args, kind="video")
        return 0


def _finish_video(model, url, output, tid, args, kind="video"):
    if args.json:
        print(json.dumps({"ok": True, "kind": kind, "task_id": tid, "model": model,
                          "url": url, "output": output,
                          "params": {"duration_s": args.duration, "resolution": args.resolution.upper(),
                                     "ratio": args.ratio, "seed": args.seed, "prompt": args.prompt}},
                         ensure_ascii=False))
    else:
        print_generation_summary(model, "video", args.duration, args.resolution.upper(),
                                 args.prompt, [output] if output else [], [url] if url else [],
                                 seed=args.seed, ratio=args.ratio)
        print(f"[done] task_id={tid}")


def _finish_image(model, urls, outputs, args):
    if args.json:
        print(json.dumps({"ok": True, "kind": "image", "model": model,
                          "urls": urls, "outputs": outputs,
                          "params": {"aspect_ratio": args.aspect_ratio, "n": args.n,
                                     "seed": args.seed, "prompt": args.prompt}},
                         ensure_ascii=False))
    else:
        print_generation_summary(model, "image", None, args.aspect_ratio, args.prompt,
                                 outputs, urls, seed=args.seed, ratio=args.aspect_ratio)
        print(f"[done] {len(urls)} 张")


def cmd_seedance(argv):
    """Seedance 协议标记管理（全系通用）：enable / disable / status（本地标记，无 API）。"""
    parser = argparse.ArgumentParser(prog="pt_video.py seedance")
    parser.add_argument("action", nargs="?", default="status", choices=["enable", "disable", "status"])
    args = parser.parse_args(argv)
    cfg = load_config()
    if args.action == "enable":
        cfg["seedance_agreement_signed"] = True
        save_config(cfg)
        print("[ok] 已标记 Seedance 协议为已签（本地）。之后使用 Seedance 不再弹开通引导。")
        print("     若实际提交仍报未签，跑：python pt_video.py seedance disable 再重试。")
    elif args.action == "disable":
        cfg["seedance_agreement_signed"] = False
        save_config(cfg)
        print("[ok] 已清除 Seedance 已签标记；下次使用会重新弹开通引导。")
    else:
        signed = bool(cfg.get("seedance_agreement_signed", False))
        print(json.dumps({"seedance_agreement_signed": signed,
                          "agreement_url": SEEDANCE_AGREEMENT_URL,
                          "note": "协议只能仪表盘手动签，无 API；签后素材以 asset:// 传入 media"},
                         ensure_ascii=False))
    return 0


def main():
    if len(sys.argv) > 1:
        sub = sys.argv[1]
        if sub == "config":
            return cmd_config(sys.argv[2:])
        if sub == "check":
            return cmd_check()
        if sub == "auto-model":
            return cmd_auto_model(sys.argv[2:])
        if sub == "models":
            return cmd_models(sys.argv[2:])
        if sub == "estimate":
            return cmd_estimate(sys.argv[2:])
        if sub == "seedance":
            return cmd_seedance(sys.argv[2:])
        if sub == "upload":
            return cmd_upload(sys.argv[2:])
        if sub == "generate":
            return cmd_generate(sys.argv[2:])
    # 无子命令：给用法
    sys.stderr.write("用法：pt_video.py <check|config|auto-model|models|estimate|seedance|generate> [参数]\n")
    sys.stderr.write("例：pt_video.py generate -m wan3.0-video -p \"一只猫在跳舞\" -d 5 -r 720p\n")
    sys.stderr.write("例：pt_video.py generate -m seedream-5-0-260128 -p \"赛博城市\" --type image --aspect-ratio 16:9\n")
    sys.stderr.write("例：pt_video.py generate --type seedance -m auto -p \"\" --first-frame asset://xxxx\n")
    sys.stderr.write("例：pt_video.py seedance enable   # 签好协议后标记，不再弹开通引导\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
