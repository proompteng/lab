from __future__ import annotations


import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.trading.hypotheses import (
    _JANGAR_QUORUM_CACHE,
    JangarDependencyQuorumStatus,
    compile_hypothesis_runtime_statuses,
    hypothesis_registry_requires_dependency_capability,
    load_hypothesis_registry,
    load_jangar_dependency_quorum,
    _optional_bool,
    _optional_decimal,
    _sequence,
    _weighted_decimal_average,
    resolve_hypothesis_dependency_quorum,
    summarize_hypothesis_runtime_statuses,
)
from app.trading.runtime_ledger import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
)


_MANIFEST_CANDIDATE_IDS = {
    "H-CONT-01": "chip-paper-microbar-composite@execution-proof",
    "H-MICRO-01": "chip-paper-microbar-composite@execution-proof",
    "H-PAIRS-01": "c88421d619759b2cfaa6f4d0",
    "H-TSMOM-01": "spec-83161ae16d17828eabcc58cc",
    "H-TSMOM-LIQ-01": "H-TSMOM-LIQ-01",
}

_MANIFEST_STRATEGY_FAMILIES = {
    "H-CONT-01": "intraday_continuation",
    "H-MICRO-01": "microstructure_breakout",
    "H-PAIRS-01": "microbar_cross_sectional_pairs",
    "H-TSMOM-01": "intraday_tsmom_consistent",
    "H-TSMOM-LIQ-01": "intraday_tsmom_consistent",
}

_HPAIRS_AI_HARDWARE_UNIVERSE = [
    "NVDA",
    "AVGO",
    "AMD",
    "MU",
    "MRVL",
    "CRDO",
    "COHR",
    "LITE",
    "SNDK",
    "WDC",
]


def _state(
    *,
    feature_rows: int = 0,
    drift_checks: int = 0,
    evidence_checks: int = 0,
    signal_lag_seconds: int | None = None,
    autonomy_no_signal_streak: int = 0,
    signal_continuity_alert_active: bool = False,
    evidence_report: dict[str, object] | None = None,
) -> SimpleNamespace:
    metrics = SimpleNamespace(
        feature_batch_rows_total=feature_rows,
        drift_detection_checks_total=drift_checks,
        evidence_continuity_checks_total=evidence_checks,
        signal_lag_seconds=signal_lag_seconds,
    )
    return SimpleNamespace(
        metrics=metrics,
        autonomy_no_signal_streak=autonomy_no_signal_streak,
        signal_continuity_alert_active=signal_continuity_alert_active,
        last_evidence_continuity_report=evidence_report,
    )


def _hypothesis_manifest_payload(
    *,
    hypothesis_id: str,
    lane_id: str,
    strategy_family: str,
    required_dependency_capabilities: list[str],
    initial_state: str = "shadow",
    candidate_id: str | None = None,
    strategy_id: str | None = None,
    dataset_snapshot_ref: str | None = None,
    required_feature_rows: bool = True,
    require_drift_checks: bool = True,
    require_evidence_continuity: bool = True,
    max_market_context_freshness_seconds: int | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": "torghut.hypothesis-manifest.v1",
        "hypothesis_id": hypothesis_id,
        "lane_id": lane_id,
        "strategy_family": strategy_family,
        "initial_state": initial_state,
        "required_feature_sets": ["signal_feed", "tca"],
        "required_dependency_capabilities": required_dependency_capabilities,
        "expected_gross_edge_bps": "6",
        "max_allowed_slippage_bps": "12",
        "min_sample_count_for_live_canary": 40,
        "min_sample_count_for_scale_up": 80,
        "max_rolling_drawdown_bps": "150",
        "entry_requirements": {
            "max_signal_lag_seconds": 90,
            "max_market_context_freshness_seconds": max_market_context_freshness_seconds,
            "max_evidence_age_minutes": 30,
            "min_feature_batch_rows": 1,
            "require_feature_rows": required_feature_rows,
            "require_drift_checks": require_drift_checks,
            "require_evidence_continuity": require_evidence_continuity,
            "required_dependency_quorum": "allow",
        },
    }
    if candidate_id is not None:
        payload["candidate_id"] = candidate_id
    if strategy_id is not None:
        payload["strategy_id"] = strategy_id
    if dataset_snapshot_ref is not None:
        payload["dataset_snapshot_ref"] = dataset_snapshot_ref
    return payload


def _runtime_ledger_summary(
    *hypothesis_ids: str,
    candidate_id: str | None = None,
    bucket_started_at: str = "2026-03-06T15:00:00+00:00",
    bucket_ended_at: str = "2026-03-06T15:55:00+00:00",
    submitted_order_count: int = 45,
    fill_count: int | None = None,
    closed_trade_count: int = 12,
    open_position_count: int = 0,
    filled_notional: str = "100000",
    net_strategy_pnl_after_costs: str = "80",
    post_cost_expectancy_bps: str | None = "8",
    observed_stage: str = "live",
    blockers: list[str] | None = None,
) -> dict[str, object]:
    return {
        "by_hypothesis": {
            hypothesis_id: {
                "hypothesis_id": hypothesis_id,
                "candidate_id": candidate_id
                or _MANIFEST_CANDIDATE_IDS.get(hypothesis_id)
                or f"candidate-{hypothesis_id.lower()}",
                "observed_stage": observed_stage,
                "bucket_started_at": bucket_started_at,
                "bucket_ended_at": bucket_ended_at,
                "strategy_family": _MANIFEST_STRATEGY_FAMILIES.get(hypothesis_id),
                "fill_count": fill_count
                if fill_count is not None
                else submitted_order_count,
                "submitted_order_count": submitted_order_count,
                "closed_trade_count": closed_trade_count,
                "open_position_count": open_position_count,
                "filled_notional": filled_notional,
                "net_strategy_pnl_after_costs": net_strategy_pnl_after_costs,
                "post_cost_expectancy_bps": post_cost_expectancy_bps,
                "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                "pnl_basis": POST_COST_PNL_BASIS,
                "execution_policy_hash_counts": {"policy-sha": 1},
                "cost_model_hash_counts": {"cost-sha": 1},
                "lineage_hash_counts": {"lineage-sha": 1},
                "blockers": blockers or [],
            }
            for hypothesis_id in hypothesis_ids
        }
    }


def _hpairs_route_repair_tca_summary() -> dict[str, object]:
    return {
        "account_label": "TORGHUT_SIM",
        "order_count": len(_HPAIRS_AI_HARDWARE_UNIVERSE),
        "avg_abs_slippage_bps": "24.34",
        "avg_realized_shortfall_bps": "24.34",
        "last_computed_at": "2026-06-01T19:16:00+00:00",
        "scope_symbols": list(_HPAIRS_AI_HARDWARE_UNIVERSE),
        "symbol_breakdown": _hpairs_tca_symbol_breakdown(
            avg_abs_slippage_bps="24.34",
            avg_realized_shortfall_bps="24.34",
        ),
    }


def _hpairs_tca_symbol_breakdown(
    *,
    avg_abs_slippage_bps: str,
    avg_realized_shortfall_bps: str,
) -> list[dict[str, object]]:
    return [
        {
            "symbol": symbol,
            "order_count": 1,
            "avg_abs_slippage_bps": avg_abs_slippage_bps,
            "avg_realized_shortfall_bps": avg_realized_shortfall_bps,
            "last_computed_at": "2026-06-01T19:16:00+00:00",
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
            "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
            "account_label": "TORGHUT_SIM",
            "source_kind": "live_paper_execution_tca",
        }
        for symbol in _HPAIRS_AI_HARDWARE_UNIVERSE
    ]


class _FakeHttpResponse:
    def __init__(self, payload: dict[str, object], status: int = 200) -> None:
        self.status = status
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def close(self) -> None:
        return None

    def __enter__(self) -> "_FakeHttpResponse":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return False


class _TestHypothesisReadinessBase(TestCase):
    def setUp(self) -> None:
        self._settings_snapshot = {
            "trading_hypothesis_registry_path": settings.trading_hypothesis_registry_path,
            "trading_jangar_control_plane_status_url": settings.trading_jangar_control_plane_status_url,
            "trading_jangar_control_plane_cache_ttl_seconds": settings.trading_jangar_control_plane_cache_ttl_seconds,
            "trading_jangar_control_plane_timeout_seconds": settings.trading_jangar_control_plane_timeout_seconds,
        }

    def tearDown(self) -> None:
        settings.trading_hypothesis_registry_path = self._settings_snapshot[
            "trading_hypothesis_registry_path"
        ]
        settings.trading_jangar_control_plane_status_url = self._settings_snapshot[
            "trading_jangar_control_plane_status_url"
        ]
        settings.trading_jangar_control_plane_cache_ttl_seconds = (
            self._settings_snapshot["trading_jangar_control_plane_cache_ttl_seconds"]
        )
        settings.trading_jangar_control_plane_timeout_seconds = self._settings_snapshot[
            "trading_jangar_control_plane_timeout_seconds"
        ]
        _JANGAR_QUORUM_CACHE.clear()


__all__: tuple[str, ...] = ()

__all__: tuple[str, ...] = (
    "Decimal",
    "EXACT_REPLAY_LEDGER_SCHEMA_VERSION",
    "JangarDependencyQuorumStatus",
    "POST_COST_PNL_BASIS",
    "Path",
    "SimpleNamespace",
    "TemporaryDirectory",
    "TestCase",
    "_FakeHttpResponse",
    "_HPAIRS_AI_HARDWARE_UNIVERSE",
    "_JANGAR_QUORUM_CACHE",
    "_MANIFEST_CANDIDATE_IDS",
    "_MANIFEST_STRATEGY_FAMILIES",
    "_TestHypothesisReadinessBase",
    "_hpairs_route_repair_tca_summary",
    "_hpairs_tca_symbol_breakdown",
    "_hypothesis_manifest_payload",
    "_optional_bool",
    "_optional_decimal",
    "_runtime_ledger_summary",
    "_sequence",
    "_state",
    "_weighted_decimal_average",
    "compile_hypothesis_runtime_statuses",
    "datetime",
    "hypothesis_registry_requires_dependency_capability",
    "json",
    "load_hypothesis_registry",
    "load_jangar_dependency_quorum",
    "patch",
    "resolve_hypothesis_dependency_quorum",
    "settings",
    "summarize_hypothesis_runtime_statuses",
    "timezone",
)
