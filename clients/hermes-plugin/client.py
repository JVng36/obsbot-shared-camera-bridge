from __future__ import annotations

import ipaddress
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, "camera bridge redirects are forbidden", headers, fp)


def _build_no_proxy_opener():
    return build_opener(ProxyHandler({}), _NoRedirect())


_NO_REDIRECT_OPENER = _build_no_proxy_opener()

_ALLOWED_RESPONSE_FIELDS = {
    "/v1/status": {
        "active", "expiresAtMs", "reason", "ptzLeaseHolder", "ptzLeaseExpiresAtMs",
        "promptRevision", "promptUpdatedAtMs", "promptUpdatedBy", "promptAction",
        "promptChars", "promptSha256",
    },
    "/v1/look": {
        "viewer", "observedAtMs", "description", "width", "height", "remainingLooks",
        "promptRevision",
    },
    "/v1/ptz/move": {"yaw", "pitch", "leaseHolder", "leaseExpiresAtMs"},
    "/v1/ptz/recenter": {"recentered", "leaseHolder", "leaseExpiresAtMs"},
    "/v1/stop": {
        "active", "expiresAtMs", "reason", "ptzLeaseHolder", "ptzLeaseExpiresAtMs", "parked",
        "parkingVerification",
        "promptRevision", "promptUpdatedAtMs", "promptUpdatedBy", "promptAction",
        "promptChars", "promptSha256",
    },
    "/v1/prompt/status": {
        "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history",
    },
    "/v1/prompt/get": {
        "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history", "prompt",
    },
    "/v1/prompt/replace": {
        "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history",
    },
    "/v1/prompt/append": {
        "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history",
    },
    "/v1/prompt/reset": {
        "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history",
    },
}

_REQUIRED_RESPONSE_FIELDS = {
    "/v1/status": {
        "active", "expiresAtMs", "promptRevision", "promptUpdatedAtMs",
        "promptUpdatedBy", "promptAction", "promptChars", "promptSha256",
    },
    "/v1/look": {"viewer", "description", "width", "height", "promptRevision"},
    "/v1/ptz/move": {"yaw", "pitch", "leaseHolder", "leaseExpiresAtMs"},
    "/v1/ptz/recenter": {"recentered", "leaseHolder", "leaseExpiresAtMs"},
    "/v1/stop": {
        "active", "parked", "promptRevision", "promptUpdatedAtMs",
        "promptUpdatedBy", "promptAction", "promptChars", "promptSha256",
    },
    "/v1/prompt/status": {
        "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history",
    },
    "/v1/prompt/get": {
        "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history", "prompt",
    },
    "/v1/prompt/replace": {
        "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history",
    },
    "/v1/prompt/append": {
        "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history",
    },
    "/v1/prompt/reset": {
        "revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256", "history",
    },
}

_FORBIDDEN_RESPONSE_KEYS = {
    "base64", "image", "imagebase64", "media", "path", "content", "data", "url",
}

_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_PRINCIPAL_ID = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_URI_REFERENCE = re.compile(
    r"(?:^|[\s\"'`(])(?:data|blob|file|https?|ftp|cid|media)\s*:",
    re.IGNORECASE,
)
_NETWORK_PATH = re.compile(
    r"(?:^|[\s\"'`(])(?:\\\\|//)[^\s\\/\"'`]+[\\/][^\s\"'`]+"
)
_ABSOLUTE_PATH = re.compile(
    r"(?:^|[\s\"'`(])(?:[A-Za-z]:[\\/]|/(?!/))(?:[^\s\\/\"'`]+[\\/])+[^\s\"'`]+"
)
_DOT_RELATIVE_PATH = re.compile(
    r"(?:^|[\s\"'`(])\.{1,2}[\\/](?:[^\s\\/\"'`]+[\\/])*[^\s\"'`]+"
)
_LONG_BASE64_RUN = re.compile(r"[A-Za-z0-9+/_-]{256,}={0,2}")
_DISALLOWED_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _is_bool(value: Any) -> bool:
    return type(value) is bool


def _is_int(value: Any) -> bool:
    return type(value) is int


def _is_number(value: Any) -> bool:
    return type(value) in {int, float} and math.isfinite(value)


def _is_nonnegative_int(value: Any) -> bool:
    return _is_int(value) and 0 <= value <= _MAX_SAFE_INTEGER


def _is_positive_dimension(value: Any) -> bool:
    return _is_int(value) and 1 <= value <= 8_192


def _is_remaining_looks(value: Any) -> bool:
    return _is_int(value) and 0 <= value <= 30


def _is_prompt_chars(value: Any) -> bool:
    return _is_int(value) and 1 <= value <= 16_000


def _is_yaw(value: Any) -> bool:
    return _is_number(value) and -60 <= value <= 60


def _is_pitch(value: Any) -> bool:
    return _is_number(value) and -30 <= value <= 45


def _is_text(value: Any) -> bool:
    return isinstance(value, str)


def _is_nullable_text(value: Any) -> bool:
    return value is None or _is_text(value)


def _is_nullable_number(value: Any) -> bool:
    return value is None or _is_nonnegative_int(value)


def _is_agent(value: Any) -> bool:
    return isinstance(value, str) and bool(_PRINCIPAL_ID.fullmatch(value)) and value != "system"


def _is_nullable_agent(value: Any) -> bool:
    return value is None or _is_agent(value)


def _is_reason(value: Any) -> bool:
    return value is None or value in {"stopped", "expired", "operator", "failure"}


def _is_safe_observation(value: Any) -> bool:
    return (
        _is_text(value)
        and 0 < len(value.strip()) <= 2_000
        and not _URI_REFERENCE.search(value)
        and not _NETWORK_PATH.search(value)
        and not _ABSOLUTE_PATH.search(value)
        and not _DOT_RELATIVE_PATH.search(value)
        and not _LONG_BASE64_RUN.search(value)
        and not _DISALLOWED_CONTROL.search(value)
    )


def _is_sha256(value: Any) -> bool:
    return _is_text(value) and len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def _is_prompt_actor(value: Any) -> bool:
    return value == "system" or _is_agent(value)


def _is_prompt_action(value: Any) -> bool:
    return value in {"initial", "replace", "append", "reset"}


def _is_prompt_history(value: Any) -> bool:
    expected = {"revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256"}
    if not isinstance(value, list) or not 1 <= len(value) <= 20:
        return False
    if not all(
        isinstance(entry, dict)
        and set(entry) == expected
        and _is_nonnegative_int(entry["revision"])
        and _is_nonnegative_int(entry["updatedAtMs"])
        and _is_prompt_actor(entry["updatedBy"])
        and _is_prompt_action(entry["action"])
        and _is_prompt_chars(entry["chars"])
        and _is_sha256(entry["sha256"])
        for entry in value
    ):
        return False
    return all(
        previous["revision"] < current["revision"]
        and previous["updatedAtMs"] <= current["updatedAtMs"]
        for previous, current in zip(value, value[1:])
    )


_PROMPT_METADATA_VALIDATORS = {
    "revision": _is_nonnegative_int,
    "updatedAtMs": _is_nonnegative_int,
    "updatedBy": _is_prompt_actor,
    "action": _is_prompt_action,
    "chars": _is_prompt_chars,
    "sha256": _is_sha256,
    "history": _is_prompt_history,
}


_RESPONSE_VALIDATORS = {
    "/v1/status": {
        "active": _is_bool,
        "expiresAtMs": _is_nonnegative_int,
        "reason": _is_reason,
        "ptzLeaseHolder": _is_nullable_agent,
        "ptzLeaseExpiresAtMs": _is_nullable_number,
        "promptRevision": _is_nonnegative_int,
        "promptUpdatedAtMs": _is_nonnegative_int,
        "promptUpdatedBy": _is_prompt_actor,
        "promptAction": _is_prompt_action,
        "promptChars": _is_prompt_chars,
        "promptSha256": _is_sha256,
    },
    "/v1/look": {
        "viewer": _is_agent,
        "observedAtMs": _is_nonnegative_int,
        "description": _is_safe_observation,
        "width": _is_positive_dimension,
        "height": _is_positive_dimension,
        "remainingLooks": _is_remaining_looks,
        "promptRevision": _is_nonnegative_int,
    },
    "/v1/ptz/move": {
        "yaw": _is_yaw,
        "pitch": _is_pitch,
        "leaseHolder": _is_agent,
        "leaseExpiresAtMs": _is_nonnegative_int,
    },
    "/v1/ptz/recenter": {
        "recentered": _is_bool,
        "leaseHolder": _is_agent,
        "leaseExpiresAtMs": _is_nonnegative_int,
    },
    "/v1/stop": {
        "active": _is_bool,
        "expiresAtMs": _is_nonnegative_int,
        "reason": _is_reason,
        "ptzLeaseHolder": _is_nullable_agent,
        "ptzLeaseExpiresAtMs": _is_nullable_number,
        "parked": _is_bool,
        "parkingVerification": lambda value: value == "unverified",
        "promptRevision": _is_nonnegative_int,
        "promptUpdatedAtMs": _is_nonnegative_int,
        "promptUpdatedBy": _is_prompt_actor,
        "promptAction": _is_prompt_action,
        "promptChars": _is_prompt_chars,
        "promptSha256": _is_sha256,
    },
    "/v1/prompt/status": _PROMPT_METADATA_VALIDATORS,
    "/v1/prompt/get": {**_PROMPT_METADATA_VALIDATORS, "prompt": _is_text},
    "/v1/prompt/replace": _PROMPT_METADATA_VALIDATORS,
    "/v1/prompt/append": _PROMPT_METADATA_VALIDATORS,
    "/v1/prompt/reset": _PROMPT_METADATA_VALIDATORS,
}


def _contains_forbidden_response_key(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            str(key).lower() in _FORBIDDEN_RESPONSE_KEYS
            or _contains_forbidden_response_key(child)
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(_contains_forbidden_response_key(child) for child in value)
    return False


def _js_string_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _validate_response_consistency(
    path: str,
    value: dict[str, Any],
    expected_agent: str | None,
) -> bool:
    if path == "/v1/look" and expected_agent is not None:
        if value["viewer"] != expected_agent:
            return False
    if path in {"/v1/ptz/move", "/v1/ptz/recenter"} and expected_agent is not None:
        if value["leaseHolder"] != expected_agent:
            return False
    if path in {"/v1/status", "/v1/stop"}:
        if value["active"] != (value.get("reason") is None):
            return False
    if path.startswith("/v1/prompt/"):
        history = value["history"]
        latest = history[-1]
        for key in ("revision", "updatedAtMs", "updatedBy", "action", "chars", "sha256"):
            if value[key] != latest[key]:
                return False
        if path == "/v1/prompt/get":
            prompt = value["prompt"]
            prompt_chars = _js_string_length(prompt)
            if not 1 <= prompt_chars <= 16_000 or not prompt.strip():
                return False
            if value["chars"] != prompt_chars:
                return False
            if value["sha256"] != hashlib.sha256(prompt.encode("utf-8")).hexdigest():
                return False
    return True


def _reject_json_constant(value: str):
    raise ValueError(f"invalid JSON constant: {value}")


def _reject_duplicate_json_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _open_without_redirect(request: Request, timeout: int):
    return _NO_REDIRECT_OPENER.open(request, timeout=timeout)


def _is_private_camera_host(hostname: str | None) -> bool:
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        address = ipaddress.ip_address(hostname or "")
        return address in ipaddress.ip_network("100.64.0.0/10")
    except ValueError:
        return False


class CameraClient:
    def __init__(
        self,
        *,
        base_url: str,
        token_file: Path | str,
        open_impl: Callable[..., Any] = _open_without_redirect,
        timeout: int = 75,
        expected_agent: str | None = None,
    ) -> None:
        parsed = urlparse(base_url)
        if parsed.scheme != "http" or not _is_private_camera_host(parsed.hostname):
            raise ValueError("camera URL must use HTTP on a loopback or Tailscale address")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("camera URL must not contain credentials, query parameters, or fragments")
        if expected_agent is not None and not _is_agent(expected_agent):
            raise ValueError("expected camera agent must be a valid principal ID")
        self._base_url = base_url.rstrip("/")
        self._token_file = Path(token_file)
        self._open = open_impl
        self._timeout = timeout
        self._expected_agent = expected_agent

    def _token(self) -> str:
        if self._token_file.stat().st_size > 4_096:
            raise RuntimeError("camera token file is unexpectedly large")
        token = self._token_file.read_text(encoding="utf-8").strip()
        if len(token) < 32 or any(character.isspace() for character in token):
            raise RuntimeError("camera token file is invalid")
        return token

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if path not in _ALLOWED_RESPONSE_FIELDS:
            raise ValueError("camera client route is not allowlisted")
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(
            f"{self._base_url}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self._token()}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Connection": "close",
            },
        )
        try:
            with self._open(request, timeout=self._timeout) as response:
                headers = response.headers
                if hasattr(headers, "get_content_type"):
                    content_type = headers.get_content_type()
                else:
                    content_type = str(headers.get("Content-Type", "")).split(";", 1)[0].strip().lower()
                if content_type != "application/json":
                    raise RuntimeError("camera bridge returned an invalid content type")
                declared_length = headers.get("Content-Length")
                if declared_length is not None:
                    try:
                        declared_length = int(declared_length)
                    except (TypeError, ValueError):
                        raise RuntimeError("camera bridge returned an invalid content length") from None
                    if declared_length < 0 or declared_length > 131_072:
                        raise RuntimeError("camera bridge response exceeded the text-only limit")
                raw = response.read(131_073)
        except HTTPError as error:
            if error.fp:
                error.read(131_073)
            raise RuntimeError(f"camera bridge HTTP {error.code}: request rejected") from None
        if len(raw) > 131_072:
            raise RuntimeError("camera bridge response exceeded the text-only limit")
        try:
            parsed = json.loads(
                raw.decode("utf-8"),
                parse_constant=_reject_json_constant,
                object_pairs_hook=_reject_duplicate_json_keys,
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            raise RuntimeError("camera bridge returned invalid JSON") from None
        if not isinstance(parsed, dict):
            raise RuntimeError("camera bridge returned an invalid response")
        unexpected = set(parsed) - _ALLOWED_RESPONSE_FIELDS[path]
        if unexpected:
            raise RuntimeError("camera bridge returned unexpected response fields")
        missing = _REQUIRED_RESPONSE_FIELDS[path] - set(parsed)
        if missing:
            raise RuntimeError("camera bridge response is missing required fields")
        validators = _RESPONSE_VALIDATORS[path]
        if any(not validators[field](value) for field, value in parsed.items()):
            raise RuntimeError("camera bridge returned invalid response field types")
        if _contains_forbidden_response_key(parsed):
            raise RuntimeError("camera bridge returned forbidden nested response data")
        if not _validate_response_consistency(path, parsed, self._expected_agent):
            raise RuntimeError("camera bridge returned an inconsistent response")
        return parsed

    def get(self, path: str) -> dict[str, Any]:
        return self._request("GET", path)

    def post(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._request("POST", path, payload or {})
