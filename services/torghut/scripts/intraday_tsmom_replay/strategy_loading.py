from __future__ import annotations

import http.client

import subprocess

import time as time_mod

import uuid

import yaml

from app.models import Strategy

from app.strategies.catalog import (
    StrategyCatalogConfig,
    _compose_strategy_description,
)

from pathlib import Path

from urllib import (
    error,
    parse,
    request,
)

from .replay_types import DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS


def _load_strategies(path: Path) -> list[Strategy]:
    root_payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(root_payload, dict):
        raise RuntimeError("strategy_configmap_not_mapping")
    data = root_payload.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("strategy_configmap_missing_data")
    strategies_yaml = data.get("strategies.yaml")
    if not isinstance(strategies_yaml, str):
        raise RuntimeError("strategy_configmap_missing_strategies_yaml")
    catalog = StrategyCatalogConfig.model_validate(yaml.safe_load(strategies_yaml))
    strategies: list[Strategy] = []
    for item in catalog.strategies:
        if item.name is None:
            continue
        strategies.append(
            Strategy(
                id=uuid.uuid4(),
                name=item.name,
                description=_compose_strategy_description(item),
                enabled=item.enabled,
                base_timeframe=item.base_timeframe,
                universe_type=item.universe_type,
                universe_symbols=item.universe_symbols or None,
                max_position_pct_equity=item.max_position_pct_equity,
                max_notional_per_trade=item.max_notional_per_trade,
            )
        )
    return strategies


def _http_query(
    *,
    url: str,
    username: str | None,
    password: str | None,
    query: str,
    timeout_seconds: int = DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
) -> str:
    timeout_seconds = max(1, int(timeout_seconds))
    if url.startswith("kubectl://"):
        return _kubectl_clickhouse_query(
            url=url,
            username=username,
            password=password,
            query=query,
            timeout_seconds=timeout_seconds,
        )
    body = query.encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(3):
        req = request.Request(url=url.rstrip("/") + "/", data=body, method="POST")
        if username:
            credentials = f"{username}:{password or ''}".encode("utf-8")
            req.add_header("Authorization", "Basic " + _b64(credentials))
        try:
            with request.urlopen(req, timeout=timeout_seconds) as resp:
                return resp.read().decode("utf-8")
        except error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"clickhouse_http_error: {exc.code}: {payload}") from exc
        except http.client.IncompleteRead as exc:
            if exc.partial:
                return exc.partial.decode("utf-8", errors="replace")
            last_error = exc
        except Exception as exc:  # pragma: no cover - retry path for flaky transport
            last_error = exc
        time_mod.sleep(0.5 * (attempt + 1))
    if last_error is None:
        raise RuntimeError("clickhouse_http_query_failed")
    raise RuntimeError(f"clickhouse_http_query_failed: {last_error}") from last_error


def _kubectl_clickhouse_query(
    *,
    url: str,
    username: str | None,
    password: str | None,
    query: str,
    timeout_seconds: int = DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
) -> str:
    target = parse.urlparse(url)
    context = parse.unquote(target.netloc).strip()
    parts = [parse.unquote(part) for part in target.path.split("/") if part]
    if len(parts) != 2 or not context:
        raise RuntimeError(
            "clickhouse_kubectl_url_invalid: expected kubectl://<context>/<namespace>/<pod>"
        )
    namespace, pod = parts
    command = [
        "kubectl",
        "--context",
        context,
        "exec",
        "-n",
        namespace,
        pod,
        "--",
        "clickhouse-client",
    ]
    if username:
        command.extend(["--user", username])
    if password:
        command.extend(["--password", password])
    command.extend(["--query", query])
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=max(1, int(timeout_seconds)),
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"clickhouse_kubectl_query_timeout:{max(1, int(timeout_seconds))}s"
        ) from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"clickhouse_kubectl_query_failed: {detail[:400]}")
    return result.stdout


def _b64(raw: bytes) -> str:
    import base64

    return base64.b64encode(raw).decode("ascii")
