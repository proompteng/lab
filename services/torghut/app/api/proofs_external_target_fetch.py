"""External paper-route target plan fetch helpers."""

from __future__ import annotations

from typing import Any

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
    result: dict[str, Any] = {}
    for attempt in range(1, max_attempts + 1):
        parsed = urlsplit(url)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"}:
            return {
                "load_error": f"paper_route_target_plan_invalid_scheme:{scheme or 'missing'}"
            }
        if not parsed.hostname:
            return {"load_error": "paper_route_target_plan_invalid_host"}
        if paper_route_target_plan_url_points_to_self(parsed):
            return {"load_error": "paper_route_target_plan_self_reference"}

        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        connection_class = (
            https_connection_class if scheme == "https" else http_connection_class
        )
        connection = connection_class(
            parsed.hostname,
            parsed.port,
            timeout=max(float(timeout_seconds), 0.1),
        )
        try:
            host_header = parsed.netloc or parsed.hostname
            connection.request(
                "GET",
                path,
                headers={
                    "Accept": "application/json",
                    "Connection": "close",
                    "Host": host_header,
                },
            )
            response = connection.getresponse()
            if response.status < 200 or response.status >= 300:
                result = {
                    "load_error": f"paper_route_target_plan_http_status:{response.status}"
                }
            else:
                raw = response.read(5_000_001)
                if len(raw) > 5_000_000:
                    result = {
                        "load_error": "paper_route_target_plan_response_too_large"
                    }
                else:
                    try:
                        payload = json.loads(raw.decode("utf-8"))
                    except Exception as exc:
                        result = {
                            "load_error": f"paper_route_target_plan_invalid_json:{exc}"
                        }
                    else:
                        if not isinstance(payload, Mapping):
                            result = {
                                "load_error": "paper_route_target_plan_invalid_payload"
                            }
                        else:
                            plan = paper_route_target_plan_from_payload(
                                cast(Mapping[str, Any], payload)
                            )
                            if not plan:
                                result = {
                                    "load_error": "paper_route_target_plan_missing"
                                }
                            else:
                                result = dict(plan)
                                result.setdefault(
                                    "source", "external_paper_route_target_plan"
                                )
        except Exception as exc:  # pragma: no cover - depends on network
            result = {"load_error": f"paper_route_target_plan_fetch_failed:{exc}"}
        finally:
            connection.close()

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


def paper_route_target_plan_url_points_to_self(parsed: Any) -> bool:
    path = str(getattr(parsed, "path", "") or "").rstrip("/")
    if path not in {"/trading/paper-route-target-plan", "/trading/proofs"}:
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
