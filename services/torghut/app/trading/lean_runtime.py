"""In-process LEAN authority and backtest helpers."""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ..config import settings
from .evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)

SCAFFOLD_BLOCKED_STATUS = "blocked_missing_empirical_authority"


@dataclass
class _BacktestRecord:
    backtest_id: str
    lane: str
    config: dict[str, Any]
    reproducibility_hash: str
    status: str
    created_at: float
    due_at: float
    result: dict[str, Any] | None = None


_cache_lock = threading.Lock()
_backtests: dict[str, _BacktestRecord] = {}
_DEFAULT_UPSTREAM_TIMEOUT_SECONDS = 10


def _normalize_backtest_lane(value: str) -> str:
    normalized = value.strip().lower().replace("-", "_")
    aliases = {
        "research": "research_backtest",
        "research_backtest": "research_backtest",
        "shadow": "shadow_replay",
        "shadow_replay": "shadow_replay",
        "deterministic_scaffold": "deterministic_scaffold",
    }
    return aliases.get(normalized, normalized or "research_backtest")


def _proxy_json_request(
    *,
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    request_headers = dict(headers or {})
    body: bytes | None = None
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request_headers["content-type"] = "application/json"
    request = Request(url, data=body, headers=request_headers, method=method)
    try:
        with urlopen(request, timeout=_DEFAULT_UPSTREAM_TIMEOUT_SECONDS) as response:
            raw_body = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")[:200]
        raise RuntimeError(f"lean_upstream_http_{exc.code}:{detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"lean_upstream_network_error:{exc.reason}") from exc
    if not raw_body:
        return {}
    try:
        decoded = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"lean_upstream_invalid_json:{raw_body[:200]}") from exc
    if not isinstance(decoded, dict):
        raise RuntimeError("lean_upstream_invalid_payload")
    return cast(dict[str, Any], decoded)


def _canonical_json(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def lean_authority_status() -> dict[str, Any]:
    authoritative_modes: list[str] = []
    if settings.trading_lean_backtest_upstream_url:
        authoritative_modes.append("research_backtest")
    if settings.trading_lean_shadow_upstream_url or settings.trading_lean_strategy_shadow_upstream_url:
        authoritative_modes.append("shadow_replay")
    if settings.trading_lean_lane_disable_switch:
        return {
            "configured": False,
            "endpoint": None,
            "status": "disabled",
            "authority": "blocked",
            "message": "LEAN lane disabled",
            "authoritative_modes": [],
            "deterministic_scaffold_enabled": False,
        }
    return {
        "configured": True,
        "endpoint": None,
        "status": "healthy" if authoritative_modes else "disabled",
        "authority": "empirical" if authoritative_modes else "blocked",
        "message": "ok" if authoritative_modes else "deterministic scaffold only",
        "authoritative_modes": authoritative_modes,
        "deterministic_scaffold_enabled": True,
    }


def submit_backtest(
    *,
    lane: str,
    config: Mapping[str, Any],
    correlation_id: str,
) -> dict[str, Any]:
    normalized_lane = _normalize_backtest_lane(lane)
    upstream_url = (settings.trading_lean_backtest_upstream_url or "").strip()
    if upstream_url:
        payload = _proxy_json_request(
            method="POST",
            url=f"{upstream_url.rstrip('/')}/submit",
            payload={
                "lane": normalized_lane,
                "config": dict(config),
            },
            headers={"accept": "application/json", "X-Correlation-ID": correlation_id},
        )
        return payload

    canonical = _canonical_json(dict(config))
    reproducibility_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    backtest_id = hashlib.sha256(f"{normalized_lane}:{reproducibility_hash}".encode("utf-8")).hexdigest()[:20]

    with _cache_lock:
        existing = _backtests.get(backtest_id)
        if existing is None:
            _backtests[backtest_id] = _BacktestRecord(
                backtest_id=backtest_id,
                lane=normalized_lane,
                config=dict(config),
                reproducibility_hash=reproducibility_hash,
                status="queued",
                created_at=time.time(),
                due_at=time.time() + 1.0,
            )

    return {
        "backtest_id": backtest_id,
        "status": _backtests[backtest_id].status,
        "lane": normalized_lane,
        "reproducibility_hash": reproducibility_hash,
        "authority_mode": normalized_lane,
    }


def get_backtest(backtest_id: str) -> dict[str, Any]:
    upstream_url = (settings.trading_lean_backtest_upstream_url or "").strip()
    if upstream_url:
        payload = _proxy_json_request(
            method="GET",
            url=f"{upstream_url.rstrip('/')}/{backtest_id}",
            headers={"accept": "application/json"},
        )
        result = payload.get("result")
        if isinstance(result, dict) and "artifact_authority" not in result:
            cast(dict[str, Any], result)["artifact_authority"] = evidence_contract_payload(
                provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
                maturity=EvidenceMaturity.EMPIRICALLY_VALIDATED,
                notes="LEAN backtest result returned from configured upstream integration.",
            )
        return payload

    with _cache_lock:
        record = _backtests.get(backtest_id)
        if record is None:
            raise RuntimeError("lean_backtest_not_found")
        if record.status in {"queued", "running"} and time.time() >= record.due_at:
            record.result = _deterministic_backtest_result(record)
            record.status = "completed"
        elif record.status == "queued":
            record.status = "running"

        return {
            "backtest_id": record.backtest_id,
            "lane": record.lane,
            "status": record.status,
            "reproducibility_hash": record.reproducibility_hash,
            "result": record.result,
        }


def evaluate_strategy_shadow(
    *,
    strategy_id: str,
    symbol: str,
    intent: Mapping[str, Any],
    correlation_id: str,
) -> dict[str, Any]:
    upstream_url = (settings.trading_lean_strategy_shadow_upstream_url or "").strip()
    payload = {
        "strategy_id": strategy_id,
        "symbol": symbol,
        "intent": dict(intent),
    }
    if upstream_url:
        return _proxy_json_request(
            method="POST",
            url=upstream_url.rstrip("/"),
            payload=payload,
            headers={"accept": "application/json", "X-Correlation-ID": correlation_id},
        )
    signature = hashlib.sha256(
        f"{strategy_id}:{symbol}:{_canonical_json(payload['intent'])}".encode("utf-8")
    ).hexdigest()
    score = (int(signature[:8], 16) % 1000) / 1000.0
    governance = {
        "parity_score": score,
        "promotion_ready": False,
        "blocking_reason": SCAFFOLD_BLOCKED_STATUS,
        "checks": {
            "parity_minimum": False,
            "governance_minimum": False,
        },
    }
    return {
        "run_id": signature[:24],
        "strategy_id": strategy_id,
        "symbol": symbol,
        "authority_mode": "deterministic_scaffold",
        "promotion_authority_eligible": False,
        "blocking_reason": SCAFFOLD_BLOCKED_STATUS,
        "parity_status": SCAFFOLD_BLOCKED_STATUS,
        "governance": governance,
        "artifact_authority": evidence_contract_payload(
            provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
            maturity=EvidenceMaturity.STUB,
            authoritative=False,
            placeholder=True,
            notes="LEAN strategy shadow evaluation is using deterministic scaffold simulation.",
        ),
    }


def shadow_simulate(
    *,
    symbol: str,
    side: str,
    qty: float,
    order_type: str = "market",
    time_in_force: str = "day",
    limit_price: float | None = None,
    intent_price: float | None = None,
    correlation_id: str,
) -> dict[str, Any]:
    upstream_url = (settings.trading_lean_shadow_upstream_url or "").strip()
    payload = {
        "symbol": symbol,
        "side": side,
        "qty": qty,
        "order_type": order_type,
        "time_in_force": time_in_force,
        "limit_price": limit_price,
        "intent_price": intent_price,
    }
    if upstream_url:
        return _proxy_json_request(
            method="POST",
            url=upstream_url.rstrip("/"),
            payload=payload,
            headers={"accept": "application/json", "X-Correlation-ID": correlation_id},
        )
    seed = hashlib.sha256(f"{symbol}:{side}:{qty}:{order_type}".encode("utf-8")).hexdigest()
    basis = int(seed[:8], 16)
    slippage_bps = ((basis % 29) - 14) / 10.0
    base_price = intent_price or limit_price or max(qty, 1.0)
    simulated_fill = base_price * (1.0 + (slippage_bps / 10000.0))
    return {
        "symbol": symbol,
        "side": side,
        "qty": qty,
        "authority_mode": "deterministic_scaffold",
        "promotion_authority_eligible": False,
        "blocking_reason": SCAFFOLD_BLOCKED_STATUS,
        "replay_dataset_ref": None,
        "simulated_fill_price": round(simulated_fill, 8),
        "simulated_slippage_bps": round(slippage_bps, 4),
        "parity_status": SCAFFOLD_BLOCKED_STATUS,
        "failure_taxonomy": "missing_empirical_shadow_replay",
        "artifact_authority": evidence_contract_payload(
            provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
            maturity=EvidenceMaturity.STUB,
            authoritative=False,
            placeholder=True,
            notes="LEAN shadow replay is using deterministic scaffold simulation.",
        ),
    }


def _deterministic_backtest_result(record: _BacktestRecord) -> dict[str, Any]:
    seed = int(record.reproducibility_hash[:8], 16)
    gross_pnl = ((seed % 20000) - 10000) / 100.0
    drawdown = (seed % 900) / 10000.0
    trades = (seed % 250) + 25
    replay_hash = hashlib.sha256(
        f"{record.reproducibility_hash}:{gross_pnl}:{drawdown}:{trades}".encode("utf-8")
    ).hexdigest()
    return {
        "integration_mode": "deterministic_scaffold",
        "authority_mode": "deterministic_scaffold",
        "promotion_authority_eligible": False,
        "blocking_reason": SCAFFOLD_BLOCKED_STATUS,
        "summary": {
            "gross_pnl": gross_pnl,
            "net_pnl": round(gross_pnl * 0.93, 4),
            "max_drawdown": round(drawdown, 6),
            "trade_count": trades,
        },
        "execution_assumptions": {
            "mode": record.lane,
            "venue": "deterministic_scaffold",
            "partial_fill_model": "scaffold-fill-v1",
        },
        "calibration_inputs": {
            "status": "missing",
            "reason": "deterministic_scaffold_mode",
        },
        "artifacts": {
            "report_uri": f"s3://torghut/lean/backtests/{record.backtest_id}/report.json",
            "trades_uri": f"s3://torghut/lean/backtests/{record.backtest_id}/trades.parquet",
            "replay_dataset_ref": f"s3://torghut/lean/backtests/{record.backtest_id}/replay-dataset.parquet",
            "fees_model_ref": "fees/scaffold-v1",
            "spread_model_ref": "spread/scaffold-v1",
            "slippage_model_ref": "slippage/scaffold-v1",
        },
        "replay_hash": replay_hash,
        "deterministic_replay_passed": False,
        "artifact_authority": evidence_contract_payload(
            provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
            maturity=EvidenceMaturity.STUB,
            authoritative=False,
            placeholder=True,
            notes="LEAN backtest result is currently deterministic scaffold output.",
        ),
    }


__all__ = [
    "SCAFFOLD_BLOCKED_STATUS",
    "_backtests",
    "_cache_lock",
    "_normalize_backtest_lane",
    "evaluate_strategy_shadow",
    "get_backtest",
    "lean_authority_status",
    "shadow_simulate",
    "submit_backtest",
]
