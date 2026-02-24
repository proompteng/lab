"""LLM client wrapper for trade reviews.

Torghut prefers calling Jangar's OpenAI-compatible gateway inside the cluster
so the service does not need direct OpenAI credentials.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Optional, cast
from urllib.parse import urlsplit

from openai import OpenAI
from openai.types.chat import ChatCompletionMessageParam

from ...config import settings


@dataclass
class LLMClientResponse:
    content: str
    usage: Optional[dict[str, int]]


class _HttpRequest:
    def __init__(
        self,
        *,
        full_url: str,
        method: str,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.full_url = full_url
        self.method = method
        self.data = data
        self._headers = dict(headers or {})

    def header_items(self) -> list[tuple[str, str]]:
        return list(self._headers.items())

    @property
    def headers(self) -> dict[str, str]:
        return dict(self._headers)


class _HttpResponseHandle:
    def __init__(self, connection: HTTPConnection | HTTPSConnection, response: Any) -> None:
        self._connection = connection
        self._response = response
        self.status = int(getattr(response, 'status', 200))

    def read(self) -> bytes:
        return cast(bytes, self._response.read())

    def readline(self) -> bytes:
        return cast(bytes, self._response.readline())

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "_HttpResponseHandle":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self.close()
        return False


def _http_connection_for_url(
    url: str, *, timeout_seconds: int
) -> tuple[HTTPConnection | HTTPSConnection, str]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {'http', 'https'}:
        raise RuntimeError(f'jangar completion request failed (scheme): {scheme or "missing"}')
    if not parsed.hostname:
        raise RuntimeError('jangar completion request failed (host): missing')
    request_path = parsed.path or '/'
    if parsed.query:
        request_path = f'{request_path}?{parsed.query}'
    connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
    connection = connection_class(
        parsed.hostname,
        parsed.port,
        timeout=max(timeout_seconds, 1),
    )
    return connection, request_path


def urlopen(request: _HttpRequest, timeout: int) -> _HttpResponseHandle:
    connection, request_path = _http_connection_for_url(request.full_url, timeout_seconds=timeout)
    try:
        connection.request(request.method, request_path, body=request.data, headers=request.headers)
        response = connection.getresponse()
    except Exception:
        connection.close()
        raise
    return _HttpResponseHandle(connection, response)


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

        headers: dict[str, str] = {
            "content-type": "application/json",
            "x-trade-execution": "torghut",
        }
        api_key = settings.jangar_api_key
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"

        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = _HttpRequest(
            full_url=url,
            method='POST',
            data=body,
            headers=headers,
        )

        try:
            with urlopen(request, max(self._timeout_seconds, 1)) as response:
                status = getattr(response, "status", 200)
                if status < 200 or status >= 300:
                    raw = response.read().decode("utf-8", errors="replace")
                    raise RuntimeError(f"jangar completion request failed ({status}): {raw}")
                content, usage = _parse_jangar_sse(response, timeout_seconds=self._timeout_seconds)
                return LLMClientResponse(content=content, usage=usage)
        except OSError as exc:
            raise RuntimeError(f"jangar completion request failed (network): {exc}") from exc
        raise RuntimeError("jangar completion request failed (no response)")


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
        data = _next_jangar_sse_data(stream, deadline=deadline)
        if data is None or data == "[DONE]":
            break

        frame = _decode_jangar_sse_frame(data)
        if frame is None:
            continue
        _raise_if_jangar_sse_error(frame)

        usage = _coerce_usage(frame.get("usage")) or usage
        content_parts.extend(_jangar_sse_content_parts(frame))

    return ("".join(content_parts).strip(), usage)


def _next_jangar_sse_data(stream: Any, *, deadline: Optional[float]) -> Optional[str]:
    while True:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("jangar completion timed out")
        line_bytes = stream.readline()
        if not line_bytes:
            return None

        line = line_bytes.decode("utf-8", errors="replace").strip()
        if not line or not line.startswith("data:"):
            continue
        return line[5:].lstrip()


def _decode_jangar_sse_frame(data: str) -> Optional[dict[str, Any]]:
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError:
        # Ignore malformed frames; a later valid frame may still terminate the stream.
        return None
    if not isinstance(parsed, dict):
        return None
    return cast(dict[str, Any], parsed)


def _raise_if_jangar_sse_error(frame: dict[str, Any]) -> None:
    if "error" not in frame:
        return
    err = frame.get("error")
    if isinstance(err, dict):
        err_dict = cast(dict[str, Any], err)
        message = err_dict.get("message") or err_dict.get("code") or "unknown_error"
    else:
        message = str(cast(object, err))
    raise RuntimeError(f"jangar completion error: {message}")


def _jangar_sse_content_parts(frame: dict[str, Any]) -> list[str]:
    choices = frame.get("choices")
    if not isinstance(choices, list):
        return []

    content_parts: list[str] = []
    for choice in cast(list[object], choices):
        if not isinstance(choice, dict):
            continue
        choice_dict = cast(dict[str, Any], choice)
        content_parts.extend(_jangar_choice_content(choice_dict))
    return content_parts


def _jangar_choice_content(choice: dict[str, Any]) -> list[str]:
    content_parts: list[str] = []
    for field in ("delta", "message"):
        payload = choice.get(field)
        if not isinstance(payload, dict):
            continue
        payload_dict = cast(dict[str, Any], payload)
        content = payload_dict.get("content")
        if isinstance(content, str) and content:
            content_parts.append(content)
    return content_parts
