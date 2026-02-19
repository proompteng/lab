"""LLM client wrapper for trade reviews.

Torghut prefers calling Jangar's OpenAI-compatible gateway inside the cluster
so the service does not need direct OpenAI credentials.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from openai import OpenAI
from openai.types.chat import ChatCompletionMessageParam

from ...config import settings


@dataclass
class LLMClientResponse:
    content: str
    usage: Optional[dict[str, int]]


class RetryableJangarError(RuntimeError):
    """Raised when a Jangar bespoke stream can be retried safely."""


class LLMClient:
    """Thin wrapper around the OpenAI client to keep it mockable."""

    def __init__(self, model: str, timeout_seconds: int) -> None:
        self._provider = settings.llm_provider
        self._timeout_seconds = timeout_seconds
        self._model = model
        self._client = OpenAI(timeout=timeout_seconds) if self._provider == "openai" else None

    def request_review(
        self,
        messages: list[ChatCompletionMessageParam],
        temperature: float,
        max_tokens: int,
    ) -> LLMClientResponse:
        if self._provider == "jangar":
            try:
                return self._request_review_via_jangar(messages, temperature=temperature, max_tokens=max_tokens)
            except Exception as primary_exc:
                try:
                    return self._request_review_via_self_hosted(messages, temperature=temperature, max_tokens=max_tokens)
                except Exception as fallback_exc:
                    raise RuntimeError(
                        "llm_fallback_exhausted "
                        f"primary={type(primary_exc).__name__} "
                        f"fallback={type(fallback_exc).__name__}"
                    ) from fallback_exc

        if self._client is None:
            raise RuntimeError("LLM provider configured as openai but OpenAI client was not initialized")

        response = self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )

        content = response.choices[0].message.content or ""
        usage = cast(dict[str, int], response.usage.model_dump()) if response.usage else None

        return LLMClientResponse(content=content, usage=usage)

    def _request_review_via_self_hosted(
        self,
        messages: list[ChatCompletionMessageParam],
        temperature: float,
        max_tokens: int,
    ) -> LLMClientResponse:
        base_url = settings.llm_self_hosted_base_url
        if not base_url:
            raise RuntimeError("self-hosted LLM fallback requested but LLM_SELF_HOSTED_BASE_URL is not set")

        model = settings.llm_self_hosted_model or self._model
        api_key = settings.llm_self_hosted_api_key or "local"

        client = OpenAI(base_url=base_url, api_key=api_key, timeout=self._timeout_seconds)

        # Not all OpenAI-compatible servers implement `response_format`; try it first,
        # then retry without if rejected.
        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                response_format={"type": "json_object"},
            )
        except Exception:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )

        content = response.choices[0].message.content or ""
        usage = cast(dict[str, int], response.usage.model_dump()) if response.usage else None
        return LLMClientResponse(content=content, usage=usage)

    def _request_review_via_jangar(
        self,
        messages: list[ChatCompletionMessageParam],
        temperature: float,
        max_tokens: int,
    ) -> LLMClientResponse:
        if settings.llm_jangar_bespoke_decision_enabled:
            return self._request_review_via_jangar_bespoke(
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )

        base_url = settings.jangar_base_url
        if not base_url:
            raise RuntimeError("Jangar LLM provider selected but JANGAR_BASE_URL is not set")
        url = f"{base_url}/openai/v1/chat/completions"

        payload: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "stream": True,
            "temperature": temperature,
            "max_tokens": max_tokens,
            # Ask the gateway to enforce JSON-only output (mirrors the OpenAI client path).
            "response_format": {"type": "json_object"},
            # Torghut needs a JSON-only response; disabling plan deltas avoids markdown
            # injection into the stream that would break JSON parsing.
            "stream_options": {"include_usage": True, "include_plan": False},
        }

        headers: dict[str, str] = {"content-type": "application/json"}
        api_key = settings.jangar_api_key
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"

        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(url, method="POST", headers=headers, data=body)

        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                status = getattr(response, "status", 200)
                if status < 200 or status >= 300:
                    raw = response.read().decode("utf-8", errors="replace")
                    raise RuntimeError(f"jangar completion request failed ({status}): {raw}")
                content, usage = _parse_jangar_sse(response, timeout_seconds=self._timeout_seconds)
                return LLMClientResponse(content=content, usage=usage)
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else str(exc)
            raise RuntimeError(f"jangar completion request failed ({exc.code}): {raw}") from exc
        except URLError as exc:
            raise RuntimeError(f"jangar completion request failed (network): {exc}") from exc

    def _request_review_via_jangar_bespoke(
        self,
        messages: list[ChatCompletionMessageParam],
        temperature: float,
        max_tokens: int,
    ) -> LLMClientResponse:
        request_id = str(uuid.uuid4())
        max_attempts = max(1, settings.llm_jangar_bespoke_max_retries + 1)

        for attempt in range(max_attempts):
            try:
                return self._request_review_via_jangar_bespoke_once(
                    request_id=request_id,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            except Exception as exc:
                if attempt >= max_attempts - 1 or not _is_retryable_jangar_error(exc):
                    raise
                sleep_seconds = max(0.0, settings.llm_jangar_bespoke_retry_backoff_seconds * (2 ** attempt))
                if sleep_seconds > 0:
                    time.sleep(sleep_seconds)

        raise RuntimeError("jangar bespoke decision request failed after retries")

    def _request_review_via_jangar_bespoke_once(
        self,
        *,
        request_id: str,
        messages: list[ChatCompletionMessageParam],
        temperature: float,
        max_tokens: int,
    ) -> LLMClientResponse:
        base_url = settings.jangar_base_url
        if not base_url:
            raise RuntimeError("Jangar LLM provider selected but JANGAR_BASE_URL is not set")
        url = f"{base_url}/api/torghut/decision-engine/stream"

        now_iso = datetime.now(timezone.utc).isoformat()
        payload: dict[str, Any] = {
            "request_id": request_id,
            "symbol": "LLM",
            "strategy_id": "torghut-llm-review",
            "trigger": {
                "type": "llm_review",
                "event_ts": now_iso,
                "source": "torghut",
            },
            "portfolio": {
                "equity": "0",
                "buying_power": "0",
                "current_exposure": "0",
            },
            "risk_policy": {
                "max_notional_per_trade": str(settings.trading_max_notional_per_trade)
                if settings.trading_max_notional_per_trade is not None
                else None,
                "max_position_pct_equity": str(settings.trading_max_position_pct_equity)
                if settings.trading_max_position_pct_equity is not None
                else None,
                "kill_switch_enabled": settings.trading_kill_switch_enabled,
            },
            "execution_context": {
                "primary_adapter": settings.trading_execution_adapter,
                "lean_enabled": settings.trading_execution_adapter == "lean",
                "mode": settings.trading_mode,
            },
            "llm_review": {
                "model": self._model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
        }

        headers: dict[str, str] = {"content-type": "application/json"}
        api_key = settings.jangar_api_key
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"

        timeout_seconds = max(1, settings.llm_jangar_bespoke_timeout_seconds)
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(url, method="POST", headers=headers, data=body)

        try:
            with urlopen(request, timeout=timeout_seconds) as response:
                status = getattr(response, "status", 200)
                if status < 200 or status >= 300:
                    raw = response.read().decode("utf-8", errors="replace")
                    raise _http_status_error(status, raw)
                content, usage = _parse_jangar_decision_sse(response, timeout_seconds=timeout_seconds)
                return LLMClientResponse(content=content, usage=usage)
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else str(exc)
            raise _http_status_error(exc.code, raw) from exc
        except URLError as exc:
            raise RetryableJangarError(f"jangar decision request failed (network): {exc}") from exc


def _is_retryable_jangar_error(error: Exception) -> bool:
    return isinstance(error, (TimeoutError, URLError, RetryableJangarError))


def _http_status_error(status: int, body: str) -> RuntimeError:
    message = f"jangar decision request failed ({status}): {body}"
    if status >= 500 or status in {408, 409, 429}:
        return RetryableJangarError(message)
    return RuntimeError(message)


def _coerce_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_usage(usage: Any) -> Optional[dict[str, int]]:
    if not isinstance(usage, dict):
        return None
    usage_dict = cast(dict[str, Any], usage)
    out: dict[str, int] = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        maybe = _coerce_int(usage_dict.get(key))
        if maybe is not None:
            out[key] = maybe
    return out or None


def _coerce_text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned if cleaned else None


def _parse_jangar_sse(stream: Any, timeout_seconds: Optional[int] = None) -> tuple[str, Optional[dict[str, int]]]:
    """Parse Jangar's SSE stream and return the aggregated content + usage.

    Jangar emits OpenAI-like `data: {json}` frames plus a terminal `data: [DONE]`.
    It may emit an `error` frame (top-level `error` key) and an optional `usage` frame.
    When `timeout_seconds` is set, the parser enforces a total read deadline.
    """

    content_parts: list[str] = []
    usage: Optional[dict[str, int]] = None
    deadline = time.monotonic() + timeout_seconds if timeout_seconds is not None else None

    while True:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("jangar completion timed out")
        line_bytes = stream.readline()
        if not line_bytes:
            break

        line = line_bytes.decode("utf-8", errors="replace").strip()
        if not line or not line.startswith("data:"):
            continue

        data = line[5:].lstrip()
        if data == "[DONE]":
            break

        try:
            parsed = json.loads(data)
        except json.JSONDecodeError:
            # Ignore malformed frames; a later valid frame may still terminate the stream.
            continue

        if not isinstance(parsed, dict):
            continue

        frame = cast(dict[str, Any], parsed)

        if "error" in frame:
            err = frame.get("error")
            err_dict = cast(dict[str, Any], err) if isinstance(err, dict) else None
            if err_dict is not None:
                message = err_dict.get("message") or err_dict.get("code") or "unknown_error"
            else:
                message = str(cast(object, err))
            raise RuntimeError(f"jangar completion error: {message}")

        if "usage" in frame:
            usage = _coerce_usage(frame.get("usage")) or usage

        choices = frame.get("choices")
        if not isinstance(choices, list):
            continue

        for choice in cast(list[object], choices):
            if not isinstance(choice, dict):
                continue
            choice_dict = cast(dict[str, Any], choice)
            delta = choice_dict.get("delta")
            if isinstance(delta, dict):
                delta_dict = cast(dict[str, Any], delta)
                content = delta_dict.get("content")
                if isinstance(content, str) and content:
                    content_parts.append(content)
            message = choice_dict.get("message")
            if isinstance(message, dict):
                message_dict = cast(dict[str, Any], message)
                content = message_dict.get("content")
                if isinstance(content, str) and content:
                    content_parts.append(content)

    return ("".join(content_parts).strip(), usage)


def _parse_jangar_decision_sse(
    stream: Any,
    timeout_seconds: Optional[int] = None,
) -> tuple[str, Optional[dict[str, int]]]:
    """Parse Jangar bespoke decision-engine SSE stream.

    The stream emits named events (`decision.*`) with JSON payloads. We return the
    llm_response content from `decision.final` and usage when present.
    """

    deadline = time.monotonic() + timeout_seconds if timeout_seconds is not None else None
    content = ""
    usage: Optional[dict[str, int]] = None
    current_event = ""
    current_data_lines: list[str] = []

    def flush_event() -> Optional[tuple[str, Optional[dict[str, int]]]]:
        nonlocal current_event
        nonlocal current_data_lines
        nonlocal content
        nonlocal usage

        if not current_data_lines:
            current_event = ""
            return None

        data = "\n".join(current_data_lines).strip()
        event_name = current_event or "message"
        current_event = ""
        current_data_lines = []

        if not data:
            return None

        try:
            parsed = json.loads(data)
        except json.JSONDecodeError:
            return None

        if not isinstance(parsed, dict):
            return None

        parsed_record = cast(dict[str, Any], parsed)
        payload = parsed_record.get("payload") if isinstance(parsed_record.get("payload"), dict) else parsed_record
        payload_record = cast(dict[str, Any], payload)

        if event_name == "decision.error":
            message = _coerce_text(payload_record.get("message")) or _coerce_text(payload_record.get("code")) or "error"
            code = _coerce_text(payload_record.get("code"))
            if code == "timeout":
                raise TimeoutError("jangar decision timed out")
            raise RetryableJangarError(f"jangar decision error: {message}")

        if event_name != "decision.final":
            return None

        llm_response = payload_record.get("llm_response")
        if isinstance(llm_response, dict):
            llm_record = cast(dict[str, Any], llm_response)
            content = _coerce_text(llm_record.get("content")) or ""
            usage = _coerce_usage(llm_record.get("usage")) or usage

        return content, usage

    while True:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("jangar decision stream timed out")

        line_bytes = stream.readline()
        if not line_bytes:
            break

        line = line_bytes.decode("utf-8", errors="replace").rstrip("\r\n")

        if not line:
            maybe_final = flush_event()
            if maybe_final is not None:
                return maybe_final
            continue

        if line.startswith(":"):
            continue

        if line.startswith("event:"):
            current_event = line[6:].strip()
            continue

        if line.startswith("data:"):
            current_data_lines.append(line[5:].lstrip())
            continue

    maybe_final = flush_event()
    if maybe_final is not None:
        return maybe_final

    raise RetryableJangarError("jangar decision stream disconnected before final event")

