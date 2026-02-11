"""LLM client wrapper for trade reviews.

Torghut prefers calling Jangar's OpenAI-compatible gateway inside the cluster
so the service does not need direct OpenAI credentials.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
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
