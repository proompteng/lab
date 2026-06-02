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
        "order_count": 2,
        "avg_abs_slippage_bps": "24.34",
        "avg_realized_shortfall_bps": "24.34",
        "last_computed_at": "2026-06-01T19:16:00+00:00",
        "scope_symbols": ["AAPL", "AMZN"],
        "symbol_breakdown": [
            {
                "symbol": "AAPL",
                "order_count": 1,
                "avg_abs_slippage_bps": "24.34",
                "avg_realized_shortfall_bps": "24.34",
                "last_computed_at": "2026-06-01T19:16:00+00:00",
                "hypothesis_id": "H-PAIRS-01",
                "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                "account_label": "TORGHUT_SIM",
                "source_kind": "live_paper_execution_tca",
            },
            {
                "symbol": "AMZN",
                "order_count": 1,
                "avg_abs_slippage_bps": "24.34",
                "avg_realized_shortfall_bps": "24.34",
                "last_computed_at": "2026-06-01T19:16:00+00:00",
                "hypothesis_id": "H-PAIRS-01",
                "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                "account_label": "TORGHUT_SIM",
                "source_kind": "live_paper_execution_tca",
            },
        ],
    }


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


class TestHypothesisReadiness(TestCase):
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

    def test_route_tca_helper_edge_cases_are_defensive(self) -> None:
        self.assertIsNone(_optional_decimal(None))
        self.assertEqual(_optional_decimal(Decimal("1.25")), Decimal("1.25"))
        self.assertEqual(_optional_decimal("2.50"), Decimal("2.50"))
        self.assertIsNone(_optional_decimal("not-a-decimal"))
        self.assertIsNone(_optional_decimal([]))
        self.assertIsNone(_optional_bool(None))
        self.assertTrue(_optional_bool(True))
        self.assertFalse(_optional_bool(False))
        self.assertTrue(_optional_bool(1))
        self.assertFalse(_optional_bool(0))
        self.assertTrue(_optional_bool("passed"))
        self.assertFalse(_optional_bool("blocked"))
        self.assertIsNone(_optional_bool("unknown"))
        self.assertEqual(_sequence("AAPL"), ())
        self.assertIsNone(
            _weighted_decimal_average(
                [{"order_count": 0, "avg_abs_slippage_bps": Decimal("4")}],
                "avg_abs_slippage_bps",
            )
        )
        self.assertIsNone(
            _weighted_decimal_average(
                [{"order_count": 2, "avg_abs_slippage_bps": None}],
                "avg_abs_slippage_bps",
            )
        )

    def test_load_hypothesis_registry_reads_directory_payloads(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-cont-01.json").write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.hypothesis-manifest.v1",
                        "hypothesis_id": "H-CONT-01",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "paper_probation_candidate_ids": [
                            " secondary-candidate ",
                            "primary-candidate",
                            "primary-candidate",
                        ],
                        "initial_state": "shadow",
                        "expected_gross_edge_bps": "6",
                        "max_allowed_slippage_bps": "12",
                        "min_sample_count_for_live_canary": 40,
                        "min_sample_count_for_scale_up": 80,
                        "max_rolling_drawdown_bps": "150",
                    }
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)

            result = load_hypothesis_registry()

        self.assertTrue(result.loaded)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].hypothesis_id, "H-CONT-01")
        self.assertEqual(
            result.items[0].paper_probation_candidate_ids,
            ["primary-candidate", "secondary-candidate"],
        )
        self.assertEqual(result.errors, [])

    def test_compile_hypothesis_runtime_statuses_stays_shadow_without_feature_and_evidence(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(),
            tca_summary={
                "order_count": 0,
                "avg_abs_slippage_bps": 0,
                "avg_realized_shortfall_bps": 0,
            },
            market_context_status={"last_freshness_seconds": None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertEqual(cont["state"], "shadow")
        self.assertIn("signal_lag_exceeded", cont["reasons"])
        self.assertNotIn("feature_rows_missing", cont["reasons"])
        self.assertNotIn("evidence_continuity_missing", cont["reasons"])
        self.assertNotIn("drift_checks_missing", cont["reasons"])
        self.assertEqual(micro["state"], "blocked")
        self.assertIn("required_feature_set_unavailable", micro["reasons"])

    def test_compile_hypothesis_runtime_statuses_uses_persisted_feature_readiness(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(feature_rows=0),
            tca_summary={
                "order_count": 0,
                "avg_abs_slippage_bps": 0,
                "avg_realized_shortfall_bps": 0,
            },
            market_context_status={"last_freshness_seconds": None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={"equity_ta_rows": 12, "equity_ta_symbols": 6},
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertNotIn("signal_lag_exceeded", cont["reasons"])
        self.assertNotIn("feature_rows_missing", micro["reasons"])
        self.assertNotIn("required_feature_set_unavailable", micro["reasons"])
        self.assertNotIn("signal_lag_exceeded", micro["reasons"])
        self.assertEqual(cont["observed"]["signal_lag_seconds"], None)
        self.assertEqual(cont["observed"]["feature_batch_rows_total"], 12)

    def test_compile_hypothesis_runtime_statuses_uses_persisted_drift_readiness(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(feature_rows=12, drift_checks=0),
            tca_summary={
                "order_count": 0,
                "avg_abs_slippage_bps": 0,
                "avg_realized_shortfall_bps": 0,
            },
            market_context_status={"last_freshness_seconds": None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={"drift_detection_checks_total": 3},
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertNotIn("drift_checks_missing", micro["reasons"])
        self.assertEqual(micro["observed"]["drift_detection_checks_total"], 3)

    def test_compile_hypothesis_runtime_statuses_promotes_canary_when_thresholds_are_met(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=45,
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertEqual(cont["state"], "canary_live")
        self.assertEqual(cont["capital_stage"], "0.25x canary")
        self.assertEqual(cont["capital_multiplier"], "0.25")
        self.assertTrue(cont["promotion_eligible"])
        self.assertEqual(cont["observed"]["tca_age_minutes"], 10)

    def test_compile_hypothesis_runtime_statuses_requires_live_runtime_ledger_profit_authority(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=45,
                observed_stage="paper",
                post_cost_expectancy_bps="8",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertEqual(cont["state"], "shadow")
        self.assertIn("runtime_ledger_stage_not_live", cont["reasons"])
        self.assertEqual(cont["observed"]["runtime_ledger_observed_stage"], "paper")
        self.assertNotIn("post_cost_expectancy_non_positive", cont["reasons"])

    def test_compile_hypothesis_runtime_statuses_blocks_stale_runtime_ledger_profit_authority(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T16:35:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T16:35:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=45,
                post_cost_expectancy_bps="8",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 40, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertEqual(cont["state"], "shadow")
        self.assertIn("runtime_ledger_evidence_stale", cont["reasons"])
        self.assertEqual(cont["observed"]["runtime_ledger_age_minutes"], 45)

    def test_compile_hypothesis_runtime_statuses_blocks_runtime_ledger_missing_window_bounds(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary={
                "by_hypothesis": {
                    "H-CONT-01": {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-CONT-01"],
                        "observed_stage": "live",
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-CONT-01"],
                        "submitted_order_count": 45,
                        "closed_trade_count": 8,
                        "filled_notional": "100000",
                        "post_cost_expectancy_bps": "8",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                        "pnl_basis": POST_COST_PNL_BASIS,
                        "execution_policy_hash_counts": {"policy-sha": 1},
                        "cost_model_hash_counts": {"cost-sha": 1},
                        "lineage_hash_counts": {"lineage-sha": 1},
                    }
                }
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertIn("runtime_ledger_window_bounds_missing", cont["reasons"])
        self.assertIsNone(cont["observed"]["runtime_ledger_bucket_started_at"])
        self.assertIsNone(cont["observed"]["runtime_ledger_bucket_ended_at"])

    def test_htsmom_liq_manifest_keeps_candidate_identity_but_blocks_paper_ledger(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        liq_manifest = next(
            item for item in registry.items if item.hypothesis_id == "H-TSMOM-LIQ-01"
        )
        self.assertEqual(liq_manifest.candidate_id, "H-TSMOM-LIQ-01")
        self.assertEqual(liq_manifest.strategy_family, "intraday_tsmom_consistent")

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=5,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=15,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-03-06T15:45:00+00:00",
                },
            ),
            tca_summary={
                "order_count": 90,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-TSMOM-LIQ-01",
                submitted_order_count=90,
                observed_stage="paper",
                post_cost_expectancy_bps="8",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        liq = next(
            item for item in statuses if item["hypothesis_id"] == "H-TSMOM-LIQ-01"
        )
        self.assertFalse(liq["promotion_eligible"])
        self.assertIn("runtime_ledger_stage_not_live", liq["reasons"])
        self.assertNotIn("runtime_ledger_candidate_id_mismatch", liq["reasons"])

    def test_hpairs_manifest_declares_balanced_evidence_universe(self) -> None:
        registry = load_hypothesis_registry()
        hpairs_manifest = next(
            item for item in registry.items if item.hypothesis_id == "H-PAIRS-01"
        )

        self.assertEqual(hpairs_manifest.evidence_universe_symbols, ["AAPL", "AMZN"])
        self.assertTrue(hpairs_manifest.require_pair_balance)

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=5,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=15,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:45:00+00:00",
                },
            ),
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 2,
                "avg_abs_slippage_bps": "3",
                "last_computed_at": "2026-06-01T19:50:00+00:00",
                "scope_symbols": ["AAPL", "AMZN"],
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "3",
                        "last_computed_at": "2026-06-01T19:50:00+00:00",
                    },
                    {
                        "symbol": "AMZN",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "3",
                        "last_computed_at": "2026-06-01T19:50:00+00:00",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 55, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )
        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )

        self.assertEqual(
            hpairs["lineage_ref"]["evidence_universe_symbols"], ["AAPL", "AMZN"]
        )
        self.assertTrue(hpairs["lineage_ref"]["require_pair_balance"])
        observed = hpairs["observed"]
        self.assertEqual(observed["evidence_universe_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(observed["evidence_universe_symbol_count"], 2)
        self.assertEqual(observed["pair_contract_blockers"], [])

    def test_hpairs_route_tca_ignores_unrelated_tsmom_symbols_without_lineage(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=2770,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=14,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:15:00+00:00",
                },
            ),
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 4,
                "avg_abs_slippage_bps": "12",
                "avg_realized_shortfall_bps": "1",
                "last_computed_at": "2026-06-01T19:16:00+00:00",
                "scope_symbols": ["AAPL", "AMZN", "INTC", "NVDA"],
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "4",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                    },
                    {
                        "symbol": "AMZN",
                        "order_count": 0,
                        "avg_abs_slippage_bps": None,
                        "avg_realized_shortfall_bps": None,
                        "last_computed_at": None,
                    },
                    {
                        "symbol": "INTC",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "2",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                    },
                    {
                        "symbol": "NVDA",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "2",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 17, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertEqual(observed["route_tca_symbols"], ["AAPL"])
        self.assertEqual(observed["route_tca_repair_symbols"], ["AMZN"])
        self.assertEqual(observed["route_tca_excluded_symbol_count"], 2)
        self.assertIn(
            "route_tca_out_of_scope_symbol",
            observed["route_tca_blocking_reason_codes"],
        )
        diagnostic_symbols = [
            diagnostic["symbol"]
            for diagnostic in observed["route_tca_symbol_diagnostics"]
        ]
        self.assertEqual(diagnostic_symbols, ["AAPL", "AMZN"])

    def test_pairs_manifest_fails_closed_without_balanced_evidence_universe(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest_path = Path(tmpdir) / "h-pairs-incomplete.json"
            manifest_path.write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-PAIRS-INCOMPLETE",
                        lane_id="microbar-cross-sectional-pairs",
                        strategy_family="microbar_cross_sectional_pairs",
                        required_dependency_capabilities=[],
                        candidate_id="candidate-h-pairs-incomplete",
                        strategy_id="microbar_cross_sectional_pairs_v1@research",
                        initial_state="blocked",
                    )
                ),
                encoding="utf-8",
            )
            registry = load_hypothesis_registry(path_value=str(manifest_path))

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=5,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=15,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:45:00+00:00",
                },
            ),
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 2,
                "avg_abs_slippage_bps": "3",
                "last_computed_at": "2026-06-01T19:50:00+00:00",
                "scope_symbols": ["AAPL", "AMZN"],
            },
            runtime_ledger_summary={
                "by_hypothesis": {
                    "H-PAIRS-INCOMPLETE": {
                        "hypothesis_id": "H-PAIRS-INCOMPLETE",
                        "candidate_id": "candidate-h-pairs-incomplete",
                        "observed_stage": "live",
                        "bucket_started_at": "2026-06-01T19:00:00+00:00",
                        "bucket_ended_at": "2026-06-01T19:45:00+00:00",
                        "strategy_family": "microbar_cross_sectional_pairs",
                        "fill_count": 120,
                        "submitted_order_count": 120,
                        "closed_trade_count": 60,
                        "open_position_count": 0,
                        "filled_notional": "100000",
                        "net_strategy_pnl_after_costs": "100",
                        "post_cost_expectancy_bps": "12",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                        "pnl_basis": POST_COST_PNL_BASIS,
                        "execution_policy_hash_counts": {"policy-sha": 1},
                        "cost_model_hash_counts": {"cost-sha": 1},
                        "lineage_hash_counts": {"lineage-sha": 1},
                    }
                }
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 55, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = statuses[0]
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertEqual(hpairs["state"], "blocked")
        self.assertIn("evidence_universe_symbols_missing", hpairs["reasons"])
        self.assertIn("pair_balance_not_declared", hpairs["reasons"])
        self.assertEqual(
            hpairs["observed"]["pair_contract_blockers"],
            ["evidence_universe_symbols_missing", "pair_balance_not_declared"],
        )

    def test_compile_hypothesis_runtime_statuses_prefers_target_live_bucket_over_newer_paper(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        candidate_id = _MANIFEST_CANDIDATE_IDS["H-CONT-01"]
        strategy_family = _MANIFEST_STRATEGY_FAMILIES["H-CONT-01"]
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary={
                "by_hypothesis": {
                    "H-CONT-01": {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": candidate_id,
                        "observed_stage": "paper",
                        "strategy_family": strategy_family,
                        "bucket_started_at": "2026-03-06T15:45:00+00:00",
                        "bucket_ended_at": "2026-03-06T15:55:00+00:00",
                        "submitted_order_count": 45,
                        "post_cost_expectancy_bps": "8",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                        "pnl_basis": POST_COST_PNL_BASIS,
                        "execution_policy_hash_counts": {"policy-sha": 1},
                        "cost_model_hash_counts": {"cost-sha": 1},
                        "lineage_hash_counts": {"lineage-sha": 1},
                    }
                },
                "runtime_ledger_buckets": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": candidate_id,
                        "observed_stage": "live",
                        "strategy_family": strategy_family,
                        "bucket_started_at": "2026-03-06T15:15:00+00:00",
                        "bucket_ended_at": "2026-03-06T15:30:00+00:00",
                        "submitted_order_count": 45,
                        "closed_trade_count": 8,
                        "post_cost_expectancy_bps": "8",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                        "pnl_basis": POST_COST_PNL_BASIS,
                        "execution_policy_hash_counts": {"policy-sha": 1},
                        "cost_model_hash_counts": {"cost-sha": 1},
                        "lineage_hash_counts": {"lineage-sha": 1},
                    }
                ],
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertTrue(cont["promotion_eligible"])
        self.assertEqual(cont["observed"]["runtime_ledger_observed_stage"], "live")
        self.assertEqual(
            cont["observed"]["runtime_ledger_bucket_ended_at"],
            "2026-03-06T15:30:00+00:00",
        )

    def test_compile_hypothesis_runtime_statuses_blocks_mismatched_runtime_ledger_candidate(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                candidate_id="unrelated-candidate",
                submitted_order_count=45,
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertIn("runtime_ledger_candidate_id_mismatch", cont["reasons"])
        self.assertEqual(
            cont["observed"]["runtime_ledger_candidate_id"], "unrelated-candidate"
        )

    def test_compile_hypothesis_runtime_statuses_blocks_runtime_ledger_weak_provenance(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary={
                "by_hypothesis": {
                    "H-CONT-01": {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-CONT-01"],
                        "observed_stage": "live",
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-CONT-01"],
                        "bucket_started_at": "2026-03-06T15:45:00+00:00",
                        "bucket_ended_at": "2026-03-06T15:55:00+00:00",
                        "submitted_order_count": 45,
                        "post_cost_expectancy_bps": "8",
                        "ledger_schema_version": "unknown",
                        "pnl_basis": "tca_shortfall_proxy",
                        "execution_policy_hash_counts": {},
                        "cost_model_hash_counts": {},
                        "lineage_hash_counts": {},
                    }
                }
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertIn("runtime_ledger_schema_version_invalid", cont["reasons"])
        self.assertIn("runtime_ledger_pnl_basis_invalid", cont["reasons"])
        self.assertIn("runtime_ledger_execution_policy_hash_missing", cont["reasons"])
        self.assertIn("runtime_ledger_cost_model_hash_missing", cont["reasons"])
        self.assertIn("runtime_ledger_lineage_hash_missing", cont["reasons"])

    def test_compile_hypothesis_runtime_statuses_blocks_runtime_ledger_lifecycle_blockers(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary={
                "hypothesis_id": "H-CONT-01",
                "observed_stage": "live",
                "bucket_ended_at": "2026-03-06T15:10:00+00:00",
                "submitted_order_count": 45,
                "post_cost_expectancy_bps": "8",
                "items": [
                    "ignored",
                    {
                        "hypothesis_id": "H-IGNORED-01",
                        "observed_stage": "live",
                    },
                    {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-CONT-01"],
                        "observed_stage": "live",
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-CONT-01"],
                        "bucket_started_at": "2026-03-06T15:45:00+00:00",
                        "bucket_ended_at": "2026-03-06T15:55:00+00:00",
                        "submitted_order_count": 45,
                        "closed_trade_count": 5,
                        "post_cost_expectancy_bps": "8",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                        "pnl_basis": POST_COST_PNL_BASIS,
                        "execution_policy_hash_counts": {"policy-sha": 1},
                        "cost_model_hash_counts": {"cost-sha": 1},
                        "lineage_hash_counts": {"lineage-sha": 1},
                        "blockers": [
                            "unclosed_position",
                            "",
                            "unclosed_position",
                        ],
                    },
                ],
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertEqual(cont["reasons"], ["unclosed_position"])
        observed = cont["observed"]
        self.assertEqual(observed["runtime_ledger_blockers"], ["unclosed_position"])
        self.assertEqual(
            observed["runtime_ledger_bucket_ended_at"], "2026-03-06T15:55:00+00:00"
        )
        self.assertEqual(observed["runtime_ledger_execution_policy_hash_count"], 1)
        self.assertEqual(observed["runtime_ledger_cost_model_hash_count"], 1)
        self.assertEqual(observed["runtime_ledger_lineage_hash_count"], 1)

    def test_compile_hypothesis_runtime_statuses_blocks_missing_runtime_ledger_expectancy(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=45,
                post_cost_expectancy_bps=None,
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertIn("runtime_ledger_expectancy_missing", cont["reasons"])
        self.assertIsNone(cont["observed"]["runtime_ledger_post_cost_expectancy_bps"])

    def test_compile_hypothesis_runtime_statuses_blocks_h_micro_without_delay_depth_stress(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 80,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-MICRO-01",
                submitted_order_count=80,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={"order_book_liquidity_rows": 5},
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertFalse(micro["promotion_eligible"])
        self.assertEqual(micro["state"], "blocked")
        self.assertIn("delay_adjusted_depth_stress_missing", micro["reasons"])
        self.assertEqual(
            micro["observed"]["delay_adjusted_depth_stress_checks_total"],
            0,
        )
        self.assertEqual(
            micro["entry_contract"]["max_delay_adjusted_depth_stress_age_minutes"],
            30,
        )

    def test_compile_hypothesis_runtime_statuses_promotes_h_micro_with_delay_depth_stress(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 80,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-MICRO-01",
                submitted_order_count=80,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={
                "order_book_liquidity_rows": 5,
                "delay_adjusted_depth_stress_checks_total": 1,
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_stress_checked_at": "2026-03-06T15:55:00+00:00",
                "delay_adjusted_depth_stress_artifact_ref": "proof/h-micro-delay-depth.json",
            },
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertTrue(micro["promotion_eligible"])
        self.assertEqual(micro["state"], "canary_live")
        self.assertEqual(micro["capital_stage"], "0.25x canary")
        self.assertEqual(micro["capital_multiplier"], "0.25")
        self.assertNotIn("delay_adjusted_depth_stress_missing", micro["reasons"])
        self.assertEqual(
            micro["observed"]["delay_adjusted_depth_stress_age_minutes"],
            5,
        )
        self.assertEqual(
            micro["observed"]["delay_adjusted_depth_stress_report_id"],
            "proof/h-micro-delay-depth.json",
        )

    def test_compile_hypothesis_runtime_statuses_blocks_h_micro_on_failed_or_stale_delay_depth_stress(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 80,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={
                "order_book_liquidity_rows": 5,
                "delay_adjusted_depth_stress_report": {
                    "case_count": 1,
                    "passed": "failed",
                    "generated_at": "2026-03-06T15:00:00+00:00",
                    "report_id": "proof/h-micro-delay-depth-failed.json",
                },
            },
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertFalse(micro["promotion_eligible"])
        self.assertEqual(micro["state"], "blocked")
        self.assertIn("delay_adjusted_depth_stress_failed", micro["reasons"])
        self.assertIn("delay_adjusted_depth_stress_stale", micro["reasons"])
        self.assertEqual(micro["observed"]["delay_adjusted_depth_stress_passed"], False)
        self.assertEqual(
            micro["observed"]["delay_adjusted_depth_stress_report_id"],
            "proof/h-micro-delay-depth-failed.json",
        )

    def test_compile_hypothesis_runtime_statuses_blocks_h_micro_on_untimed_delay_depth_stress(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 80,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={
                "order_book_liquidity_rows": 5,
                "delay_adjusted_depth_stress_report": {
                    "case_count": 1,
                    "passed": True,
                    "report_id": "proof/h-micro-delay-depth-untimed.json",
                },
            },
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertFalse(micro["promotion_eligible"])
        self.assertEqual(micro["state"], "blocked")
        self.assertIn("delay_adjusted_depth_stress_missing", micro["reasons"])
        self.assertEqual(micro["observed"]["delay_adjusted_depth_stress_passed"], True)
        self.assertEqual(
            micro["observed"]["delay_adjusted_depth_stress_age_minutes"], None
        )

    def test_compile_hypothesis_runtime_statuses_uses_route_filtered_tca_when_enabled(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 145,
                "avg_abs_slippage_bps": 25,
                "avg_realized_shortfall_bps": 4,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 90,
                        "avg_abs_slippage_bps": 6,
                        "avg_realized_shortfall_bps": -8,
                        "last_computed_at": "2026-03-06T15:50:00+00:00",
                    },
                    {
                        "symbol": "NVDA",
                        "order_count": 55,
                        "avg_abs_slippage_bps": 25,
                        "avg_realized_shortfall_bps": 5,
                        "last_computed_at": "2026-03-06T15:50:00+00:00",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=90,
                post_cost_expectancy_bps="8",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertEqual(cont["state"], "scaled_live")
        self.assertEqual(cont["capital_stage"], "1.00x live")
        self.assertEqual(cont["capital_multiplier"], "1")
        self.assertTrue(cont["promotion_eligible"])
        self.assertNotIn("slippage_budget_exceeded", cont["reasons"])
        observed = cont["observed"]
        self.assertEqual(observed["tca_order_count"], 90)
        self.assertEqual(observed["avg_abs_slippage_bps"], "6")
        self.assertEqual(observed["runtime_ledger_post_cost_expectancy_bps"], "8")
        self.assertEqual(observed["runtime_ledger_submitted_order_count"], 90)
        self.assertEqual(observed["route_tca_symbols"], ["AAPL"])
        self.assertEqual(observed["route_tca_excluded_symbol_count"], 1)

    def test_compile_hypothesis_runtime_statuses_blocks_empty_route_universe(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 100,
                "avg_abs_slippage_bps": 25,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 0,
                        "avg_abs_slippage_bps": None,
                        "avg_realized_shortfall_bps": None,
                        "last_computed_at": None,
                    },
                    {
                        "symbol": "ORCL",
                        "order_count": 0,
                        "avg_abs_slippage_bps": None,
                        "avg_realized_shortfall_bps": None,
                        "last_computed_at": None,
                    },
                ],
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertEqual(cont["state"], "shadow")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertIn("route_universe_empty", cont["reasons"])
        observed = cont["observed"]
        self.assertEqual(observed["route_tca_symbols"], [])
        self.assertEqual(observed["route_tca_symbol_count"], 0)
        self.assertEqual(observed["route_tca_missing_symbol_count"], 2)

    def test_compile_hypothesis_runtime_statuses_keeps_route_negative_expectancy_blocked(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 100,
                "avg_abs_slippage_bps": 25,
                "avg_realized_shortfall_bps": 4,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 45,
                        "avg_abs_slippage_bps": 6,
                        "avg_realized_shortfall_bps": 1,
                        "last_computed_at": "2026-03-06T15:50:00+00:00",
                    },
                    {
                        "symbol": "NVDA",
                        "order_count": 55,
                        "avg_abs_slippage_bps": 25,
                        "avg_realized_shortfall_bps": 5,
                        "last_computed_at": "2026-03-06T15:50:00+00:00",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=45,
                net_strategy_pnl_after_costs="-10",
                post_cost_expectancy_bps="-1",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertEqual(cont["state"], "shadow")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertNotIn("slippage_budget_exceeded", cont["reasons"])
        self.assertIn("post_cost_expectancy_non_positive", cont["reasons"])
        observed = cont["observed"]
        self.assertEqual(observed["avg_abs_slippage_bps"], "6")
        self.assertEqual(observed["runtime_ledger_post_cost_expectancy_bps"], "-1")
        self.assertEqual(observed["route_tca_symbols"], ["AAPL"])

    def test_compile_hypothesis_runtime_statuses_keeps_non_authority_route_tca_out_of_final_authority(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=2770,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=14,
            evidence_report={
                "ok": True,
                "checked_at": "2026-06-01T19:15:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 2,
                "avg_abs_slippage_bps": "4",
                "avg_realized_shortfall_bps": "1",
                "last_computed_at": "2026-06-01T19:16:00+00:00",
                "scope_symbols": ["AAPL", "AMZN"],
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "4",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                    },
                    {
                        "symbol": "AMZN",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "4",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "source_decision_mode": "bounded_paper_route_collection_only",
                        "source_decision_mode_profit_proof_eligible": False,
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 17, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertIn("route_universe_empty", hpairs["reasons"])
        self.assertEqual(observed["tca_order_count"], 0)
        self.assertEqual(observed["route_tca_symbols"], [])
        self.assertEqual(observed["route_tca_repair_symbols"], ["AAPL", "AMZN"])
        self.assertTrue(observed["bounded_route_evidence_collection_eligible"])
        self.assertEqual(
            observed["bounded_route_evidence_collection_authority"],
            "repair_only_non_authority",
        )
        self.assertIn(
            "route_tca_non_authority_source",
            observed["route_tca_blocking_reason_codes"],
        )
        self.assertIn(
            "route_tca_non_authority_source_decision_mode",
            observed["route_tca_blocking_reason_codes"],
        )
        self.assertTrue(observed["bounded_route_evidence_collection_ready"])
        self.assertEqual(
            observed["bounded_route_evidence_collection_next_action"],
            "collect_bounded_paper_route_source_rows",
        )
        self.assertEqual(observed["bounded_route_evidence_collection_blockers"], [])

    def test_compile_hypothesis_runtime_statuses_blocks_bounded_hpairs_collection_when_drift_missing(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=2770,
                drift_checks=0,
                evidence_checks=2,
                signal_lag_seconds=14,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:15:00+00:00",
                },
            ),
            tca_summary=_hpairs_route_repair_tca_summary(),
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 17, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertIn("drift_checks_missing", hpairs["reasons"])
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertTrue(observed["bounded_route_evidence_collection_eligible"])
        self.assertFalse(observed["bounded_route_evidence_collection_ready"])
        self.assertEqual(
            observed["bounded_route_evidence_collection_next_action"],
            "materialize_drift_checks",
        )
        self.assertEqual(
            observed["bounded_route_evidence_collection_blockers"],
            ["drift_checks_missing"],
        )

    def test_compile_hypothesis_runtime_statuses_blocks_bounded_hpairs_collection_on_stale_signal_lag(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=2770,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=9_958,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:15:00+00:00",
                },
            ),
            tca_summary=_hpairs_route_repair_tca_summary(),
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 17, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertIn("signal_lag_exceeded", hpairs["reasons"])
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertTrue(observed["bounded_route_evidence_collection_eligible"])
        self.assertFalse(observed["bounded_route_evidence_collection_ready"])
        self.assertEqual(
            observed["bounded_route_evidence_collection_next_action"],
            "wait_for_fresh_signal_window",
        )
        self.assertEqual(
            observed["bounded_route_evidence_collection_blockers"],
            ["signal_lag_exceeded"],
        )
        self.assertEqual(
            observed["bounded_route_evidence_collection_liveness"][
                "fresh_signal_window"
            ],
            False,
        )

    def test_compile_hypothesis_runtime_statuses_does_not_ready_bounded_hpairs_collection_while_market_closed(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=2770,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=14,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:15:00+00:00",
                },
            ),
            tca_summary=_hpairs_route_repair_tca_summary(),
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 23, 17, tzinfo=timezone.utc),
            market_session_open=False,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertTrue(observed["bounded_route_evidence_collection_eligible"])
        self.assertFalse(observed["bounded_route_evidence_collection_ready"])
        self.assertEqual(
            observed["bounded_route_evidence_collection_next_action"],
            "wait_for_market_session_open",
        )
        self.assertEqual(
            observed["bounded_route_evidence_collection_blockers"],
            ["market_session_closed"],
        )

    def test_compile_hypothesis_runtime_statuses_selects_clean_current_hpairs_route_tca(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=2770,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=14,
            evidence_report={
                "ok": True,
                "checked_at": "2026-06-01T19:15:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 2,
                "avg_abs_slippage_bps": "4",
                "avg_realized_shortfall_bps": "1",
                "last_computed_at": "2026-06-01T19:16:00+00:00",
                "scope_symbols": ["AAPL", "AMZN"],
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "4",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "source_kind": "live_paper_execution_tca",
                    },
                    {
                        "symbol": "AMZN",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "4",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "source_kind": "live_paper_execution_tca",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 17, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertEqual(observed["tca_order_count"], 2)
        self.assertEqual(observed["route_tca_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(observed["route_tca_repair_symbols"], [])
        self.assertNotIn("route_universe_empty", hpairs["reasons"])

    def test_compile_hypothesis_runtime_statuses_keeps_high_slippage_hpairs_tca_repair_only(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=2770,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=14,
            evidence_report={
                "ok": True,
                "checked_at": "2026-06-01T19:15:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 2,
                "avg_abs_slippage_bps": "24.34",
                "avg_realized_shortfall_bps": "24.34",
                "last_computed_at": "2026-06-01T19:16:00+00:00",
                "scope_symbols": ["AAPL", "AMZN"],
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "24.34",
                        "avg_realized_shortfall_bps": "24.34",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "source_kind": "live_paper_execution_tca",
                    },
                    {
                        "symbol": "AMZN",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "24.34",
                        "avg_realized_shortfall_bps": "24.34",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "source_kind": "live_paper_execution_tca",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 17, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertEqual(hpairs["promotion_contract"]["max_avg_abs_slippage_bps"], "8")
        self.assertIn("route_universe_empty", hpairs["reasons"])
        self.assertEqual(observed["tca_order_count"], 0)
        self.assertEqual(observed["route_tca_symbols"], [])
        self.assertEqual(observed["route_tca_repair_symbols"], ["AAPL", "AMZN"])
        self.assertIn(
            "route_tca_avg_abs_slippage_above_guardrail",
            observed["route_tca_blocking_reason_codes"],
        )

    def test_compile_hypothesis_runtime_statuses_blocks_stale_tca_evidence(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:00:00+00:00",
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertEqual(cont["state"], "shadow")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertIn("tca_evidence_stale", cont["reasons"])
        self.assertEqual(cont["observed"]["tca_age_minutes"], 60)

    def test_compile_hypothesis_runtime_statuses_demotes_closed_session_freshness_holds(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=9_900,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 120,
                "avg_abs_slippage_bps": 20,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:00:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                "H-MICRO-01",
                "H-BREAKOUT-01",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 10_000},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 23, 0, tzinfo=timezone.utc),
            market_session_open=False,
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertNotIn("signal_lag_exceeded", cont["reasons"])
        self.assertNotIn("tca_evidence_stale", cont["reasons"])
        self.assertIn("slippage_budget_exceeded", cont["reasons"])
        self.assertIn("closed_session_signal_hold", cont["informational_reasons"])
        self.assertIn("closed_session_tca_evidence_hold", cont["informational_reasons"])
        self.assertIn(
            "closed_session_runtime_ledger_evidence_hold",
            cont["informational_reasons"],
        )
        self.assertEqual(cont["observed"]["market_session_open"], False)

        summary = summarize_hypothesis_runtime_statuses(
            statuses,
            registry=registry,
            dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
        )
        self.assertEqual(summary["reason_totals"]["slippage_budget_exceeded"], 1)
        self.assertEqual(
            summary["informational_reason_totals"]["closed_session_signal_hold"], 5
        )

    def test_compile_hypothesis_runtime_statuses_reports_closed_session_market_context_hold_for_context_manifest(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-context-01.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-CONTEXT-01",
                        lane_id="context-dependent",
                        strategy_family="context_dependent",
                        required_dependency_capabilities=["market_context_freshness"],
                        candidate_id="candidate-context",
                        strategy_id="context_strategy@paper",
                        max_market_context_freshness_seconds=120,
                    )
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)
            registry = load_hypothesis_registry()

            statuses = compile_hypothesis_runtime_statuses(
                registry=registry,
                state=_state(
                    feature_rows=5,
                    drift_checks=3,
                    evidence_checks=2,
                    signal_lag_seconds=15,
                    evidence_report={
                        "ok": True,
                        "checked_at": "2026-03-06T15:45:00+00:00",
                    },
                ),
                tca_summary={
                    "order_count": 120,
                    "avg_abs_slippage_bps": 4,
                    "avg_realized_shortfall_bps": -12,
                    "last_computed_at": "2026-03-06T15:00:00+00:00",
                },
                runtime_ledger_summary=_runtime_ledger_summary(
                    "H-CONTEXT-01",
                    candidate_id="candidate-context",
                    submitted_order_count=120,
                    post_cost_expectancy_bps="12",
                ),
                market_context_status={"last_freshness_seconds": 10_000},
                jangar_dependency_quorum=JangarDependencyQuorumStatus(
                    decision="allow",
                    reasons=[],
                    message="ok",
                ),
                now=datetime(2026, 3, 6, 23, 0, tzinfo=timezone.utc),
                market_session_open=False,
            )

        context_status = statuses[0]
        self.assertEqual(context_status["hypothesis_id"], "H-CONTEXT-01")
        self.assertNotIn("market_context_stale", context_status["reasons"])
        self.assertIn(
            "closed_session_market_context_hold",
            context_status["informational_reasons"],
        )

    def test_compile_hypothesis_runtime_statuses_isolates_dependency_capabilities_between_hypotheses(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-a.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-A-01",
                        lane_id="lane-a",
                        strategy_family="lanes-scope-a",
                        required_dependency_capabilities=[
                            "jangar_dependency_quorum",
                            "signal_continuity",
                        ],
                        required_feature_rows=True,
                    ),
                ),
                encoding="utf-8",
            )
            (root / "h-b.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-B-01",
                        lane_id="lane-b",
                        strategy_family="lanes-scope-b",
                        required_dependency_capabilities=["feature_coverage"],
                        required_feature_rows=True,
                        initial_state="blocked",
                    ),
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)

            registry = load_hypothesis_registry()
            self.assertTrue(registry.loaded)
            self.assertEqual(len(registry.items), 2)
            self.assertEqual(len(registry.errors), 0)

            statuses = compile_hypothesis_runtime_statuses(
                registry=registry,
                state=_state(
                    feature_rows=5,
                    drift_checks=3,
                    evidence_checks=2,
                    signal_lag_seconds=15,
                    signal_continuity_alert_active=True,
                    evidence_report={
                        "ok": True,
                        "checked_at": "2026-03-06T15:45:00+00:00",
                    },
                ),
                tca_summary={
                    "order_count": 45,
                    "avg_abs_slippage_bps": 4,
                    "avg_realized_shortfall_bps": -8,
                    "last_computed_at": "2026-03-06T15:50:00+00:00",
                },
                market_context_status={"last_freshness_seconds": 60},
                jangar_dependency_quorum=JangarDependencyQuorumStatus(
                    decision="delay",
                    reasons=["workflow_backoff_warning"],
                    message="degraded",
                ),
                now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
            )

        status_a = next(item for item in statuses if item["hypothesis_id"] == "H-A-01")
        status_b = next(item for item in statuses if item["hypothesis_id"] == "H-B-01")
        self.assertIn("jangar_dependency_delay", status_a["reasons"])
        self.assertIn("signal_continuity_alert_active", status_a["reasons"])
        self.assertNotIn("jangar_dependency_delay", status_b["reasons"])
        self.assertNotIn("signal_continuity_alert_active", status_b["reasons"])
        self.assertIn("dependency_capabilities", status_a)
        self.assertIn("required", status_a["dependency_capabilities"])
        self.assertEqual(
            status_a["dependency_capabilities"]["required"],
            ["jangar_dependency_quorum", "signal_continuity"],
        )

    def test_compile_hypothesis_runtime_statuses_projects_manifest_lineage(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-micro.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-MICRO-01",
                        lane_id="microstructure-breakout",
                        strategy_family="microstructure_breakout",
                        candidate_id="chip-paper-microbar-composite@execution-proof",
                        strategy_id="microbar_volume_continuation_long_top2_chip_v1@paper",
                        dataset_snapshot_ref="torghut-chip-full-day-20260505-4c330ce9-r1",
                        required_dependency_capabilities=[],
                        required_feature_rows=False,
                        require_drift_checks=False,
                        require_evidence_continuity=False,
                    )
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)
            registry = load_hypothesis_registry()

            statuses = compile_hypothesis_runtime_statuses(
                registry=registry,
                state=_state(signal_lag_seconds=15),
                tca_summary={
                    "order_count": 0,
                    "avg_abs_slippage_bps": 0,
                    "avg_realized_shortfall_bps": 0,
                },
                market_context_status={"last_freshness_seconds": None},
                jangar_dependency_quorum=JangarDependencyQuorumStatus(
                    decision="allow",
                    reasons=[],
                    message="ok",
                ),
                now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
            )

        micro = statuses[0]
        self.assertEqual(
            micro["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(
            micro["strategy_id"],
            "microbar_volume_continuation_long_top2_chip_v1@paper",
        )
        self.assertEqual(
            micro["dataset_snapshot_ref"],
            "torghut-chip-full-day-20260505-4c330ce9-r1",
        )
        self.assertEqual(
            micro["lineage_ref"],
            {
                "status": "manifest_declared",
                "candidate_id": "chip-paper-microbar-composite@execution-proof",
                "hypothesis_id": "H-MICRO-01",
                "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
                "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
                "lane_id": "microstructure-breakout",
                "strategy_family": "microstructure_breakout",
            },
        )

    def test_summarize_hypothesis_runtime_statuses_reports_state_totals(self) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(),
            tca_summary={
                "order_count": 0,
                "avg_abs_slippage_bps": 0,
                "avg_realized_shortfall_bps": 0,
            },
            market_context_status={"last_freshness_seconds": None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="unknown",
                reasons=["jangar_control_plane_status_url_missing"],
                message="not configured",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        summary = summarize_hypothesis_runtime_statuses(
            statuses,
            registry=registry,
            dependency_quorum=JangarDependencyQuorumStatus(
                decision="unknown",
                reasons=["jangar_control_plane_status_url_missing"],
                message="not configured",
            ),
        )

        self.assertEqual(summary["hypotheses_total"], 5)
        self.assertEqual(
            summary["candidate_dossier_version"],
            "torghut.hypothesis-candidate-dossier.v1",
        )
        self.assertEqual(len(summary["ranked_candidates"]), 5)
        self.assertIsNotNone(summary["selected_candidate"])
        self.assertEqual(summary["selected_candidate"]["hypothesis_id"], "H-MICRO-01")
        self.assertEqual(
            summary["selected_candidate"]["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(
            summary["selected_candidate"]["next_blocker"],
            "delay_adjusted_depth_stress_missing",
        )
        self.assertEqual(summary["state_totals"], {"blocked": 4, "shadow": 1})
        self.assertEqual(summary["capital_stage_totals"], {"shadow": 5})
        self.assertEqual(summary["promotion_eligible_total"], 0)
        self.assertEqual(summary["rollback_required_total"], 0)
        self.assertEqual(
            summary["dependency_quorum"],
            {
                "decision": "unknown",
                "reasons": ["jangar_control_plane_status_url_missing"],
                "message": "not configured",
            },
        )

    def test_load_hypothesis_registry_fails_closed_on_duplicate_ids(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            duplicate_payload = {
                "schema_version": "torghut.hypothesis-manifest.v1",
                "hypothesis_id": "H-CONT-01",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "initial_state": "shadow",
                "expected_gross_edge_bps": "6",
                "max_allowed_slippage_bps": "12",
                "min_sample_count_for_live_canary": 40,
                "min_sample_count_for_scale_up": 80,
                "max_rolling_drawdown_bps": "150",
            }
            (root / "one.json").write_text(
                json.dumps(duplicate_payload), encoding="utf-8"
            )
            (root / "two.json").write_text(
                json.dumps(duplicate_payload), encoding="utf-8"
            )
            settings.trading_hypothesis_registry_path = str(root)

            result = load_hypothesis_registry()

        self.assertFalse(result.loaded)
        self.assertEqual(result.items, [])
        self.assertEqual(len(result.errors), 1)
        self.assertIn("duplicate hypothesis_id H-CONT-01", result.errors[0])

    def test_default_hypothesis_registry_self_governs_without_jangar_quorum(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        registry = load_hypothesis_registry()

        self.assertTrue(registry.loaded)
        self.assertFalse(
            hypothesis_registry_requires_dependency_capability(
                registry,
                "jangar_dependency_quorum",
            )
        )
        with patch("app.trading.hypotheses.urlopen") as urlopen_mock:
            status = resolve_hypothesis_dependency_quorum(registry)

        urlopen_mock.assert_not_called()
        self.assertEqual(status.decision, "allow")
        self.assertEqual(status.reasons, ["torghut_dependency_quorum_not_required"])

    def test_hypothesis_registry_dependency_check_rejects_blank_capability(
        self,
    ) -> None:
        registry = load_hypothesis_registry()

        self.assertFalse(
            hypothesis_registry_requires_dependency_capability(registry, "")
        )

    def test_resolve_hypothesis_dependency_quorum_fetches_when_manifest_requires_it(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-cont-01.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-CONT-01",
                        lane_id="continuation",
                        strategy_family="intraday_continuation",
                        required_dependency_capabilities=[
                            "jangar_dependency_quorum",
                            "signal_continuity",
                        ],
                    )
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)
            registry = load_hypothesis_registry()

        self.assertTrue(
            hypothesis_registry_requires_dependency_capability(
                registry,
                "jangar_dependency_quorum",
            )
        )
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "dependency_quorum": {
                        "decision": "delay",
                        "reasons": ["workflow_backoff_warning"],
                        "message": "degraded",
                    }
                }
            ),
        ) as urlopen_mock:
            status = resolve_hypothesis_dependency_quorum(registry)

        urlopen_mock.assert_called_once()
        self.assertEqual(status.decision, "delay")
        self.assertEqual(status.reasons, ["workflow_backoff_warning"])

    def test_load_jangar_dependency_quorum_prefers_dependency_quorum_contract(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "dependency_quorum": {
                        "decision": "delay",
                        "reasons": ["workflow_backoff_warning"],
                        "message": "degraded",
                    },
                    "stage_trust": {
                        "stages": [
                            {
                                "stage": "implement",
                                "state": "renewing",
                                "reason_codes": ["agentrun_active"],
                            }
                        ]
                    },
                    "stage_renewal_bonds": [
                        {
                            "bond_id": "bond-implement-1",
                            "stage": "implement",
                            "state": "renewing",
                        }
                    ],
                    "controller_ingestion_settlement": {
                        "decision": "current",
                        "settlement_id": "ingest-1",
                    },
                    "generated_at": "2026-05-07T12:00:00Z",
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "delay")
        self.assertEqual(status.reasons, ["workflow_backoff_warning"])
        self.assertEqual(status.message, "degraded")
        self.assertEqual(
            status.stage_trust["stages"],
            [
                {
                    "stage": "implement",
                    "state": "renewing",
                    "reason_codes": ["agentrun_active"],
                }
            ],
        )
        self.assertEqual(status.stage_renewal_bonds[0]["bond_id"], "bond-implement-1")
        self.assertEqual(status.controller_ingestion_settlement["decision"], "current")
        self.assertEqual(status.as_payload()["generated_at"], "2026-05-07T12:00:00Z")

    def test_load_jangar_dependency_quorum_preserves_verify_foreclosure_board(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        board = {
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:agents:test",
            "fresh_until": "2026-05-14T16:30:00Z",
            "execution_trust_status": "degraded",
            "source_rollout_truth_state": "converged",
            "foreclosure_tickets": [
                {
                    "ticket_id": "verify-trust-foreclosure-ticket:test",
                    "state": "open",
                    "required_output_receipt": (
                        "jangar.verify-trust-foreclosure-ticket.v1"
                    ),
                }
            ],
        }
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "generated_at": "2026-05-14T16:10:00Z",
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ok",
                    },
                    "verify_trust_foreclosure_board": board,
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "allow")
        self.assertEqual(status.message, "ok")
        payload = status.as_payload()
        self.assertEqual(payload["verify_trust_foreclosure_board"], board)

    def test_load_jangar_dependency_quorum_preserves_repair_slot_carry(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        repair_slot_escrow = {
            "schema_version": "jangar.repair-slot-escrow.v1",
            "escrow_id": "repair-slot-escrow:test",
            "status": "block",
            "reason_codes": ["selected_receipt_source_revenue_repair_ref_mismatch"],
        }
        rollout_witness = {
            "schema_version": "jangar.foreclosure-carry-rollout-witness.v1",
            "witness_id": "foreclosure-carry-rollout-witness:test",
            "fresh_until": "2026-05-14T16:30:00Z",
        }
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "generated_at": "2026-05-14T16:10:00Z",
                    "dependency_quorum": {
                        "decision": "block",
                        "reasons": ["empirical_jobs_degraded"],
                        "message": "blocked",
                    },
                    "repair_slot_escrow": repair_slot_escrow,
                    "foreclosure_carry_rollout_witness": rollout_witness,
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        payload = status.as_payload()
        self.assertEqual(status.decision, "block")
        self.assertEqual(payload["repair_slot_escrow"], repair_slot_escrow)
        self.assertEqual(
            payload["foreclosure_carry_rollout_witness"],
            rollout_witness,
        )

    def test_load_jangar_dependency_quorum_can_omit_torghut_consumer_evidence(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ok",
                    }
                }
            ),
        ) as urlopen_mock:
            status = load_jangar_dependency_quorum(
                omit_torghut_consumer_evidence=True,
            )

        self.assertEqual(status.decision, "allow")
        request = urlopen_mock.call_args.args[0]
        self.assertEqual(
            request.get_header("X-torghut-consumer-evidence-mode"),
            "omit",
        )

    def test_load_jangar_dependency_quorum_caches_by_consumer_evidence_mode(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 30
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "dependency_quorum": {
                        "decision": "delay",
                        "reasons": ["workflow_backoff_warning"],
                        "message": "degraded",
                    }
                }
            ),
        ) as urlopen_mock:
            first = load_jangar_dependency_quorum(
                omit_torghut_consumer_evidence=True,
            )
            second = load_jangar_dependency_quorum(
                omit_torghut_consumer_evidence=True,
            )

        self.assertEqual(first.decision, "delay")
        self.assertIs(first, second)
        urlopen_mock.assert_called_once()

    def test_load_jangar_dependency_quorum_falls_back_to_legacy_status_when_needed(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "workflows": {
                        "data_confidence": "unknown",
                        "backoff_limit_exceeded_jobs": 0,
                    }
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "block")
        self.assertEqual(status.reasons, ["workflows_data_unknown"])

    def test_load_jangar_dependency_quorum_preserves_ready_controller_ingestion_settlement(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/ready"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settlement = {
            "schema_version": "jangar.controller-ingestion-settlement.v1",
            "settlement_id": "controller-ingestion-settlement:ready-test",
            "decision": "hold",
            "agentrun_ingestion_current": False,
            "reason_codes": ["source_serving_hold"],
        }
        board = {
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:ready-test",
        }
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "status": "ok",
                    "controller_ingestion_settlement": settlement,
                    "verify_trust_foreclosure_board": board,
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "unknown")
        self.assertEqual(status.reasons, ["jangar_dependency_quorum_missing"])
        payload = status.as_payload()
        self.assertEqual(payload["controller_ingestion_settlement"], settlement)
        self.assertEqual(payload["verify_trust_foreclosure_board"], board)

    def test_load_jangar_dependency_quorum_handles_malformed_url(self) -> None:
        settings.trading_jangar_control_plane_status_url = "jangar.example/status"
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "unknown")
        self.assertEqual(status.reasons, ["jangar_status_fetch_failed"])
        self.assertIn("fetch failed", status.message)
