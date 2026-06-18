"""Broker-neutral execution adapters for trading order flow."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from typing import Any
from urllib.parse import urlsplit


def float_to_order_text(value: float) -> str:
    normalized = max(float(value), 0.0)
    rendered = f"{normalized:.8f}".rstrip("0").rstrip(".")
    if not rendered:
        return "0"
    return rendered


def decimal_to_order_text(value: Decimal) -> str:
    normalized = abs(value)
    rendered = format(normalized, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if not rendered:
        return "0"
    return rendered


def signed_decimal_to_text(value: Decimal) -> str:
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if rendered in {"", "-0"}:
        return "0"
    return rendered


def optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def positive_decimal(value: Any) -> Decimal | None:
    parsed = optional_decimal(value)
    if parsed is None:
        return None
    if parsed.is_finite() and parsed > 0:
        return parsed
    return None


def signed_position_market_value(
    position: Mapping[str, Any], *, side: str
) -> Decimal | None:
    market_value = optional_decimal(position.get("market_value"))
    if market_value is None:
        return None
    normalized_side = side.strip().lower()
    if normalized_side == "short":
        return -abs(market_value)
    if normalized_side == "long":
        return abs(market_value)
    return market_value


def resolve_simulation_context_payload(
    *,
    simulation_run_id: str | None,
    dataset_id: str | None,
    symbol: str,
    source: Mapping[str, Any] | None,
) -> dict[str, Any]:
    context: dict[str, Any] = {}
    if isinstance(source, Mapping):
        context.update({str(key): value for key, value in source.items()})
    if context.get("simulation_run_id") in (None, ""):
        context["simulation_run_id"] = (simulation_run_id or "").strip() or "simulation"
    if context.get("dataset_id") in (None, ""):
        context["dataset_id"] = (dataset_id or "").strip() or "unknown"
    if context.get("symbol") in (None, "") and symbol.strip():
        context["symbol"] = symbol.strip().upper()
    return context


def error_summary(exc: Exception) -> str:
    message = str(exc).strip()
    if message:
        return message
    return exc.__class__.__name__


def is_http_status_error(exc: Exception, status_code: int) -> bool:
    message = str(exc).strip().lower()
    return message.startswith(f"lean_runner_http_{status_code}")


def classify_fallback_reason(*, op: str, exc: Exception) -> str:
    message = str(exc).strip().lower()
    if "lean_order_payload_" in message or "lean_read_order_payload_" in message:
        return f"lean_{op}_contract_violation"
    if isinstance(exc, TimeoutError) or "timed out" in message:
        return f"lean_{op}_timeout"
    if "network_error" in message:
        return f"lean_{op}_network_error"
    if message.startswith("lean_runner_http_") or "_http_" in message:
        if message.startswith("lean_runner_http_"):
            code = message.split(":", 1)[0].replace("lean_runner_http_", "")
            if code.isdigit():
                return f"lean_{op}_http_{code}"
        return f"lean_{op}_http_error"
    return f"lean_{op}_failed"


def classify_failure_taxonomy(exc: Exception) -> str:
    if isinstance(exc, TimeoutError):
        return "timeout"
    message = str(exc).lower().strip()
    taxonomy = "unknown_error"
    if "network_error" in message:
        taxonomy = "network_error"
    elif message.startswith("lean_runner_http_"):
        code = message.split(":", 1)[0].replace("lean_runner_http_", "")
        if code.isdigit():
            taxonomy = f"http_{code}"
        else:
            taxonomy = "http_error"
    elif "contract" in message:
        taxonomy = "contract_violation"
    elif "invalid_json" in message:
        taxonomy = "invalid_json"
    return taxonomy


def http_request_text(
    *,
    url: str,
    method: str,
    headers: Mapping[str, str],
    body: bytes | None,
    timeout_seconds: int,
) -> tuple[int, str]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise RuntimeError(f"unsupported_url_scheme:{scheme or 'missing'}")
    if not parsed.hostname:
        raise RuntimeError("invalid_url_host")

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
    connection = connection_class(
        parsed.hostname, parsed.port, timeout=max(timeout_seconds, 1)
    )
    try:
        connection.request(method, path, body=body, headers=dict(headers))
        response = connection.getresponse()
        raw = response.read().decode("utf-8", errors="replace").strip()
        return response.status, raw
    except OSError as exc:
        raise RuntimeError(f"network_error:{exc}") from exc
    finally:
        connection.close()


__all__ = [
    "classify_failure_taxonomy",
    "classify_fallback_reason",
    "decimal_to_order_text",
    "error_summary",
    "float_to_order_text",
    "http_request_text",
    "is_http_status_error",
    "optional_decimal",
    "positive_decimal",
    "resolve_simulation_context_payload",
    "signed_decimal_to_text",
    "signed_position_market_value",
]
