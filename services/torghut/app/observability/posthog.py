"""Best-effort PostHog domain telemetry for Torghut.

This module is intentionally non-blocking for trading paths: events are enqueued
to a bounded in-memory queue and sent by a background daemon thread.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from http.client import HTTPConnection, HTTPSConnection
from queue import Empty, Full, Queue
from threading import Event, Lock, Thread
from typing import Any, cast
from urllib.parse import urlsplit

from app.config import settings

logger = logging.getLogger(__name__)

_PROHIBITED_PROPERTY_SUBSTRINGS = (
    'api_key',
    'authorization',
    'password',
    'secret',
    'token',
)
_PROHIBITED_EXACT_KEYS = {
    'input_json',
    'response_json',
    'raw_order',
    'prompt',
    'prompt_text',
}
_MAX_SEQUENCE_ITEMS = 20
_DEFAULT_QUEUE_MAX_EVENTS = 2048
_QUEUE_GET_TIMEOUT_SECONDS = 0.2


def _normalize_scalar(value: object) -> object:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, (str, bool, int, float)):
        return value
    return str(value)


def _sanitize_property_value(value: object) -> object:
    if isinstance(value, Mapping):
        payload: dict[str, object] = {}
        for raw_key, raw_value in cast(Mapping[object, Any], value).items():
            key = str(raw_key).strip()
            if not key:
                continue
            lowered_key = key.lower()
            if lowered_key in _PROHIBITED_EXACT_KEYS:
                continue
            if any(chunk in lowered_key for chunk in _PROHIBITED_PROPERTY_SUBSTRINGS):
                continue
            payload[key] = _sanitize_property_value(raw_value)
        return payload
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        sanitized_items = [
            _sanitize_property_value(item)
            for item in cast(Sequence[object], value)[:_MAX_SEQUENCE_ITEMS]
        ]
        return sanitized_items
    return _normalize_scalar(value)


def _coerce_non_empty(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _post_capture_payload(
    *,
    event_name: str,
    severity: str,
    distinct_id: str,
    properties: Mapping[str, Any] | None,
    event_version: int,
) -> dict[str, object]:
    dynamic_properties = (
        cast(dict[str, object], _sanitize_property_value(properties))
        if isinstance(properties, Mapping)
        else {}
    )
    merged_properties: dict[str, object] = {
        'service': 'torghut',
        'env': settings.app_env,
        'event_version': event_version,
        'timestamp_utc': datetime.now(timezone.utc).isoformat(),
        'severity': severity,
        'distinct_id': distinct_id,
    }
    merged_properties.update(dynamic_properties)
    return {
        'api_key': settings.posthog_api_key,
        'event': event_name,
        'properties': merged_properties,
    }


def _posthog_capture_url() -> tuple[str | None, str | None]:
    host = _coerce_non_empty(settings.posthog_host)
    if host is None:
        return None, 'missing_host'
    parsed = urlsplit(host)
    scheme = parsed.scheme.lower()
    if scheme not in {'http', 'https'}:
        return None, 'invalid_host'
    if not parsed.hostname:
        return None, 'invalid_host'
    path = parsed.path.rstrip('/')
    capture_path = f'{path}/capture/' if path else '/capture/'
    if parsed.query:
        capture_path = f'{capture_path}?{parsed.query}'
    netloc = parsed.netloc
    return f'{scheme}://{netloc}{capture_path}', None


def _send_capture_request(url: str, payload: dict[str, object]) -> tuple[bool, str | None]:
    parsed = urlsplit(url)
    connection_type = HTTPSConnection if parsed.scheme.lower() == 'https' else HTTPConnection
    hostname = parsed.hostname
    if hostname is None:
        return False, 'invalid_host'
    request_path = parsed.path or '/capture/'
    if parsed.query:
        request_path = f'{request_path}?{parsed.query}'
    connection = connection_type(
        hostname,
        parsed.port,
        timeout=max(float(settings.posthog_timeout_seconds), 0.1),
    )
    try:
        body = json.dumps(payload).encode('utf-8')
        connection.request(
            'POST',
            request_path,
            body=body,
            headers={
                'content-type': 'application/json',
                'accept': 'application/json',
            },
        )
        response = connection.getresponse()
        response.read()
        status = int(getattr(response, 'status', 500))
        if 200 <= status < 300:
            return True, None
        return False, f'http_{status}'
    except Exception:
        logger.exception('PostHog capture failed event_url=%s', url)
        return False, 'send_failed'
    finally:
        connection.close()


class _AsyncPostHogEmitter:
    def __init__(self, *, queue_max_events: int = _DEFAULT_QUEUE_MAX_EVENTS) -> None:
        self._queue: Queue[tuple[str, dict[str, object]]] = Queue(
            maxsize=max(1, int(queue_max_events))
        )
        self._shutdown = Event()
        self._thread_lock = Lock()
        self._thread: Thread | None = None

    def _ensure_worker(self) -> None:
        with self._thread_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._shutdown.clear()
            self._thread = Thread(
                target=self._run,
                name='torghut-posthog-emitter',
                daemon=True,
            )
            self._thread.start()

    def enqueue(self, url: str, payload: dict[str, object]) -> tuple[bool, str | None]:
        self._ensure_worker()
        try:
            self._queue.put_nowait((url, payload))
            return True, None
        except Full:
            return False, 'queue_full'

    def _run(self) -> None:
        while not self._shutdown.is_set() or not self._queue.empty():
            try:
                url, payload = self._queue.get(timeout=_QUEUE_GET_TIMEOUT_SECONDS)
            except Empty:
                continue
            emitted, reason = _send_capture_request(url, payload)
            if not emitted and reason is not None:
                logger.warning(
                    'PostHog telemetry send failed in background worker reason=%s',
                    reason,
                )
            self._queue.task_done()

    def stop(self, *, timeout_seconds: float = 2.0) -> None:
        self._shutdown.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=max(0.1, timeout_seconds))


_ASYNC_EMITTER = _AsyncPostHogEmitter()


def capture_posthog_event(
    event_name: str,
    *,
    severity: str = 'info',
    distinct_id: str | None = None,
    properties: Mapping[str, Any] | None = None,
    event_version: int = 1,
) -> tuple[bool, str | None]:
    """Capture a PostHog event without impacting trading critical paths."""

    if not settings.posthog_enabled:
        return False, 'disabled'
    normalized_event = _coerce_non_empty(event_name)
    if normalized_event is None:
        return False, 'invalid_event'
    if _coerce_non_empty(settings.posthog_api_key) is None:
        return False, 'missing_api_key'
    capture_url, capture_url_error = _posthog_capture_url()
    if capture_url_error is not None:
        return False, capture_url_error
    resolved_distinct_id = _coerce_non_empty(distinct_id) or settings.posthog_distinct_id
    payload = _post_capture_payload(
        event_name=normalized_event,
        severity=str(severity).strip() or 'info',
        distinct_id=resolved_distinct_id,
        properties=properties,
        event_version=max(1, int(event_version)),
    )
    emitted, reason = _ASYNC_EMITTER.enqueue(cast(str, capture_url), payload)
    if not emitted and reason is not None:
        logger.warning(
            'PostHog telemetry dropped event=%s reason=%s',
            normalized_event,
            reason,
        )
    return emitted, reason


def shutdown_posthog_telemetry(timeout_seconds: float = 2.0) -> None:
    """Stop the background telemetry worker gracefully."""

    _ASYNC_EMITTER.stop(timeout_seconds=timeout_seconds)
