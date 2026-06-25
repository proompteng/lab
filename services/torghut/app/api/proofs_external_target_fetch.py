"""External paper-route target plan fetch helpers."""

from __future__ import annotations

from typing import Any
from urllib.parse import SplitResult

from .common import (
    HTTPConnection,
    HTTPSConnection,
    Mapping,
    cast,
    json,
    os,
    shared_paper_route_target_plan_from_payload,
    time,
    urlsplit,
)


def paper_route_target_plan_from_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    return shared_paper_route_target_plan_from_payload(payload)


def fetch_paper_route_target_plan_url(
    url: str,
    *,
    timeout_seconds: float,
    attempts: int = 1,
    retry_backoff_seconds: float = 0.25,
    http_connection_class: Any = HTTPConnection,
    https_connection_class: Any = HTTPSConnection,
) -> dict[str, Any]:
    max_attempts = max(int(attempts), 1)
    connection_classes = {
        "http": http_connection_class,
        "https": https_connection_class,
    }
    result: dict[str, Any] = {}
    for attempt in range(1, max_attempts + 1):
        result = _fetch_paper_route_target_plan_url_once(
            url,
            timeout_seconds=timeout_seconds,
            connection_classes=connection_classes,
        )
        if not str(result.get("load_error") or "").strip():
            if attempt > 1:
                result = dict(result)
                result["fetch_attempts"] = attempt
            return result
        if attempt < max_attempts:
            time.sleep(max(float(retry_backoff_seconds), 0.0))

    if max_attempts > 1:
        result = dict(result)
        result["fetch_attempts"] = max_attempts
    return result


def _fetch_paper_route_target_plan_url_once(
    url: str,
    *,
    timeout_seconds: float,
    connection_classes: Mapping[str, Any],
) -> dict[str, Any]:
    parsed, load_error = _parse_paper_route_target_plan_url(url)
    if load_error is not None:
        return {"load_error": load_error}

    raw, load_error = _read_paper_route_target_plan_url(
        parsed,
        timeout_seconds=timeout_seconds,
        connection_classes=connection_classes,
    )
    if load_error is not None:
        return {"load_error": load_error}

    payload, load_error = _decode_paper_route_target_plan_payload(raw)
    if load_error is not None:
        return {"load_error": load_error}

    plan = paper_route_target_plan_from_payload(payload)
    if not plan:
        return {"load_error": "paper_route_target_plan_missing"}

    plan = dict(plan)
    plan.setdefault("source", "external_paper_route_target_plan")
    return plan


def _parse_paper_route_target_plan_url(url: str) -> tuple[SplitResult, str | None]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return parsed, f"paper_route_target_plan_invalid_scheme:{scheme or 'missing'}"
    if not parsed.hostname:
        return parsed, "paper_route_target_plan_invalid_host"
    if (parsed.path or "").rstrip("/") != "/trading/proofs":
        return parsed, "paper_route_target_plan_invalid_path"
    if paper_route_target_plan_url_points_to_self(parsed):
        return parsed, "paper_route_target_plan_self_reference"
    return parsed, None


def _read_paper_route_target_plan_url(
    parsed: SplitResult,
    *,
    timeout_seconds: float,
    connection_classes: Mapping[str, Any],
) -> tuple[bytes, str | None]:
    connection = connection_classes[parsed.scheme.lower()](
        parsed.hostname,
        parsed.port,
        timeout=max(float(timeout_seconds), 0.1),
    )
    try:
        connection.request(
            "GET",
            _paper_route_target_plan_request_path(parsed),
            headers={
                "Accept": "application/json",
                "Connection": "close",
                "Host": parsed.netloc or parsed.hostname,
            },
        )
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            return (
                b"",
                f"paper_route_target_plan_http_status:{response.status}",
            )
        raw = response.read(5_000_001)
    except Exception as exc:  # pragma: no cover - depends on network
        return b"", f"paper_route_target_plan_fetch_failed:{exc}"
    finally:
        connection.close()

    if len(raw) > 5_000_000:
        return b"", "paper_route_target_plan_response_too_large"
    return raw, None


def _paper_route_target_plan_request_path(parsed: SplitResult) -> str:
    path = parsed.path or "/"
    if parsed.query:
        return f"{path}?{parsed.query}"
    return path


def _decode_paper_route_target_plan_payload(
    raw: bytes,
) -> tuple[Mapping[str, Any], str | None]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        return {}, f"paper_route_target_plan_invalid_json:{exc}"
    if not isinstance(payload, Mapping):
        return {}, "paper_route_target_plan_invalid_payload"
    return cast(Mapping[str, Any], payload), None


def paper_route_target_plan_url_points_to_self(parsed: Any) -> bool:
    path = str(getattr(parsed, "path", "") or "").rstrip("/")
    if path != "/trading/proofs":
        return False
    hostname = str(getattr(parsed, "hostname", "") or "").strip().lower()
    if not hostname:
        return False

    self_hosts = {"localhost", "127.0.0.1", "::1"}
    service_name = os.getenv("K_SERVICE", "").strip().lower()
    namespace = os.getenv("POD_NAMESPACE", os.getenv("NAMESPACE", "")).strip().lower()
    if service_name:
        if not namespace and service_name in {"torghut", "torghut-sim"}:
            namespace = "torghut"
        self_hosts.add(service_name)
        if namespace:
            self_hosts.update(
                {
                    f"{service_name}.{namespace}",
                    f"{service_name}.{namespace}.svc",
                    f"{service_name}.{namespace}.svc.cluster.local",
                }
            )
    return hostname in self_hosts


__all__ = [
    "paper_route_target_plan_from_payload",
    "fetch_paper_route_target_plan_url",
    "paper_route_target_plan_url_points_to_self",
]
