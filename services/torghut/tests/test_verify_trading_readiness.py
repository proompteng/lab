from __future__ import annotations

import json
import tempfile
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from typing import Any, ClassVar
from unittest import TestCase

from scripts import verify_trading_readiness as verifier
from scripts.verify_trading_readiness import evaluate_trading_readiness, main


def _ready_status() -> dict[str, object]:
    return {
        "mode": "paper",
        "running": True,
        "last_error": None,
        "metrics": {
            "market_session_open": 1,
            "decisions_total": 3,
            "orders_submitted_total": 2,
        },
        "proof_floor": {
            "floor_state": "paper_ready",
            "route_state": "paper_candidate",
            "capital_state": "paper_allowed",
            "max_notional": "250",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "alpha_readiness",
                    "state": "pass",
                    "reason": "promotion_eligible",
                },
                {
                    "dimension": "market_context",
                    "state": "pass",
                    "reason": "fresh",
                },
                {
                    "dimension": "quant_ingestion",
                    "state": "pass",
                    "reason": "fresh",
                },
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "fresh",
                    "source_ref": {
                        "symbol_routes": {
                            "scope_symbols": ["NVDA", "AVGO"],
                            "routeable_symbol_count": 2,
                            "blocked_symbol_count": 0,
                            "missing_symbol_count": 0,
                            "routeable_symbols": [
                                {"symbol": "NVDA", "avg_abs_slippage_bps": "4.2"},
                                {"symbol": "AVGO", "avg_abs_slippage_bps": "5.1"},
                            ],
                            "blocked_symbols": [],
                            "missing_symbols": [],
                        },
                        "runtime_ledger_lineage": {
                            "schema_version": "torghut.execution-tca-cost-lineage.v1",
                            "status": "source_backed",
                            "promotion_authority": False,
                            "promotion_authority_reason": (
                                "lineage_dimension_only_not_promotion_authority"
                            ),
                            "execution_count": 2,
                            "source_backed_count": 2,
                            "blocked_count": 0,
                            "filled_notional_count": 2,
                            "explicit_cost_count": 2,
                            "execution_policy_hash_count": 2,
                            "cost_model_hash_count": 2,
                            "post_cost_pnl_basis_count": 2,
                            "blockers": [],
                            "blocker_counts": {},
                            "sample_blockers": [],
                        },
                    },
                },
            ],
        },
        "route_reacquisition_board": {
            "schema_version": "torghut.route-reacquisition-board.v1",
            "state": "candidate",
            "capital_state": "paper_allowed",
            "jangar_continuity": {
                "epoch_id": "truth-settlement:paper_canary:ready",
                "state": "present",
                "decision": "allow",
                "fresh_until": "2026-05-08T12:00:00+00:00",
                "blocking_reasons": [],
            },
            "summary": {
                "row_count": 2,
                "state_counts": {"routeable": 2},
                "zero_notional_row_count": 0,
                "expected_unblock_value": 8,
                "top_repair_symbols": [],
                "capital_eligible_symbol_count": 2,
            },
            "rows": [
                {
                    "symbol": "NVDA",
                    "state": "routeable",
                    "max_notional": "250",
                },
                {
                    "symbol": "AVGO",
                    "state": "routeable",
                    "max_notional": "250",
                },
            ],
        },
        "route_reacquisition_book": {
            "schema_version": "torghut.route-reacquisition-book.v1",
            "state": "paper_candidate",
            "summary": {
                "paper_route_probe_eligible_symbols": ["NVDA"],
                "paper_route_probe_active_symbols": ["NVDA"],
            },
            "paper_route_probe": {
                "configured_enabled": True,
                "configured_max_notional": "25",
                "active": True,
                "effective_max_notional": "25",
                "next_session_max_notional": "25",
                "eligible_symbol_count": 1,
                "eligible_symbols": ["NVDA"],
                "active_symbols": ["NVDA"],
                "blocking_reasons": [],
                "capital_authority": "none",
            },
        },
    }


def _completion_status(
    *,
    gate_status: str = "satisfied",
    blocked_reason: str | None = None,
    net_pnl: str = "600",
    expectancy_bps: str = "12.5",
    trading_day_count: int | None = 25,
    mean_daily_net_pnl: str | None = None,
    ledger_refs: list[str] | None = None,
    unbacked_refs: list[str] | None = None,
) -> dict[str, object]:
    runtime_ledger_summary: dict[str, object] = {
        "runtime_ledger_bucket_count": 1,
        "runtime_ledger_fill_count": 4,
        "runtime_ledger_closed_trade_count": 2,
        "runtime_ledger_filled_notional": "50000",
        "runtime_ledger_net_strategy_pnl_after_costs": net_pnl,
        "runtime_ledger_post_cost_expectancy_bps": expectancy_bps,
    }
    if trading_day_count is not None:
        runtime_ledger_summary["runtime_ledger_observed_trading_day_count"] = (
            trading_day_count
        )
    if mean_daily_net_pnl is not None:
        runtime_ledger_summary["runtime_ledger_mean_daily_net_pnl_after_costs"] = (
            mean_daily_net_pnl
        )
    return {
        "doc_id": "doc29",
        "summary": {"all_satisfied": gate_status == "satisfied"},
        "gates": [
            {
                "gate_id": verifier.DOC29_LIVE_SCALE_GATE,
                "status": gate_status,
                "blocked_reason": blocked_reason,
                "candidate_id": "cand-1",
                "db_row_refs": {
                    "strategy_runtime_ledger_buckets": ledger_refs
                    if ledger_refs is not None
                    else ["bucket-1"],
                    "runtime_ledger_unbacked_hypothesis_metric_windows": unbacked_refs
                    if unbacked_refs is not None
                    else [],
                },
                "runtime_ledger_summary": runtime_ledger_summary,
            }
        ],
    }


def _paper_route_evidence(
    *,
    import_ready: bool = False,
    import_blockers: list[str] | None = None,
    required_flags: list[str] | None = None,
    target_overrides: dict[str, object] | None = None,
    account_state_blockers: list[str] | None = None,
    account_contamination_blockers: list[str] | None = None,
) -> dict[str, object]:
    blockers = (
        import_blockers
        if import_blockers is not None
        else ([] if import_ready else ["paper_route_session_window_not_open"])
    )
    target = {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": "c88421d619759b2cfaa6f4d0",
        "observed_stage": "paper",
        "strategy_family": "microbar_cross_sectional_pairs",
        "strategy_name": "microbar-pairs-vwap-cap-safe",
        "account_label": "TORGHUT_SIM",
        "source_account_label": "TORGHUT_REPLAY",
        "source_dsn_env": "SIM_DB_DSN",
        "source_kind": "paper_route_probe_runtime_observed",
        "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
        "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
        "window_start": "2026-05-26T13:30:00+00:00",
        "window_end": "2026-05-26T20:00:00+00:00",
        "paper_route_probe_symbols": ["AAPL", "AMZN"],
        "paper_route_probe_next_session_max_notional": "25",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "max_notional": "0",
        "dependency_quorum_decision": "allow",
        "continuity_ok": "true",
        "drift_ok": "true",
        "runtime_window_import_health_gate": {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "dependency_quorum_decision": "allow",
            "continuity_ok": "true",
            "drift_ok": "true",
            "blockers": [],
        },
        "runtime_window_import_health_gate_blockers": [],
    }
    if target_overrides:
        target.update(target_overrides)
    flags = required_flags or list(verifier.REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS)
    return {
        "schema_version": "torghut.paper-route-evidence.v1",
        "next_paper_route_runtime_window_targets": {
            "schema_version": verifier.NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION,
            "target_count": 1,
            "skipped_target_count": 0,
            "session_window": {
                "start": "2026-05-26T13:30:00+00:00",
                "end": "2026-05-26T20:00:00+00:00",
            },
            "session_readiness": {
                "state": "import_ready" if import_ready else "waiting_for_session_open",
                "import_ready": import_ready,
                "import_blockers": blockers,
            },
            "runtime_window_import_handoff": {
                "runner": "scripts/renew_latest_empirical_promotion_jobs.py",
                "target_plan_endpoint": "/trading/paper-route-target-plan",
                "required_flags": flags,
                "source_dsn_env": "SIM_DB_DSN",
                "account_label": "TORGHUT_SIM",
                "observed_stage": "paper",
                "import_ready": import_ready,
                "import_blockers": blockers,
                "promotion_allowed": False,
                "final_promotion_authorized": False,
            },
            "targets": [target],
        },
        "runtime_window_import_audit": {
            "diagnostics": {
                "account_state_blockers": account_state_blockers or [],
                "account_contamination_blockers": (
                    account_contamination_blockers or []
                ),
            }
        },
    }


def _runtime_ledger_proof_packet(
    *,
    allowed: bool = True,
    blockers: list[str] | None = None,
) -> dict[str, object]:
    blocking_reasons = blockers or (
        [] if allowed else ["runtime_ledger_daily_net_pnl_below_target"]
    )
    return {
        "schema_version": verifier.RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION,
        "proof_mode": "authority",
        "proof_mode_contract": {
            "proof_mode": "authority",
            "default_proof_mode": "smoke",
            "authority_scope": "final_promotion_authority_candidate",
            "mode_can_grant_final_authority": True,
            "mode_can_grant_promotion_authority": True,
            "requires_explicit_authority_mode_for_final_promotion": True,
            "implicit_default_final_authority": False,
        },
        "ok": allowed,
        "final_authority_ok": allowed,
        "promotion_allowed": allowed,
        "capital_promotion_allowed": allowed,
        "final_promotion_allowed": allowed,
        "evidence_collection_ok": False,
        "authority_blockers": blocking_reasons,
        "blockers": blocking_reasons,
        "target": {
            "proof_mode": "authority",
            "final_authority": True,
            "source_backed_runtime_ledger_proof_required": True,
            "non_empty_runtime_ledger_source_refs_required": True,
            "min_runtime_ledger_trading_days": 20,
            "min_runtime_ledger_net_pnl_after_costs": "10000",
            "min_runtime_ledger_daily_net_pnl_after_costs": "500",
        },
        "next_action": "none"
        if allowed
        else "collect_or_improve_post_cost_runtime_profit_evidence",
        "capital_promotion_authority": {
            "allowed": allowed,
            "reason": "live_capital_promotion_gate_clear"
            if allowed
            else "post_cost_proof_not_satisfied",
            "blocking_reasons": blocking_reasons,
            "failed_checks": []
            if allowed
            else ["runtime_ledger_post_cost_profit_target"],
        },
        "verdict": "promotion_authority_allowed" if allowed else "blocked",
        "promotion_authority": {
            "allowed": allowed,
            "reason": "runtime_ledger_live_paper_post_cost_proof_satisfied"
            if allowed
            else "runtime_ledger_live_paper_post_cost_proof_blocked",
            "blocking_reasons": blocking_reasons,
            "failed_checks": []
            if allowed
            else ["runtime_ledger_post_cost_profit_target"],
        },
    }


def _tigerbeetle_parity(
    *,
    ok: bool = True,
    parity_status: str = "pass",
    source_count: int = 3,
    blockers: list[str] | None = None,
    overrides_runtime_ledger_authority: bool = False,
) -> dict[str, object]:
    return {
        "schema_version": verifier.TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION,
        "ok": ok,
        "parity_status": parity_status,
        "blockers": blockers or [],
        "totals": {
            "checked_source_count": source_count,
            "checked_ref_count": source_count,
            "checked_actual_transfer_count": source_count,
        },
        "read_only_contract": {
            "generates_proof": False,
            "synthesizes_fills": False,
            "overrides_runtime_ledger_authority": (overrides_runtime_ledger_authority),
            "writes_database": False,
        },
    }


class _JsonHandler(BaseHTTPRequestHandler):
    payload: ClassVar[object] = {}

    def do_GET(self) -> None:
        body = json.dumps(self.payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


def _load_from_test_server(payload: object) -> dict[str, object]:
    response_payload = payload

    class Handler(_JsonHandler):
        payload: ClassVar[object] = response_payload

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        host, port = server.server_address
        return verifier._load_status_url(
            f"http://{host}:{port}/status", timeout_seconds=2.0
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class TestVerifyTradingReadiness(TestCase):
    def test_ready_paper_status_passes_strict_gate(self) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            profile="paper",
            min_routeable_symbols=2,
            min_decisions=1,
            min_orders=1,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["failed_checks"], [])

    def test_runtime_ledger_profit_proof_can_be_required_from_completion_status(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(),
            profile="paper",
            min_routeable_symbols=2,
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal("20"),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["failed_checks"], [])
        self.assertEqual(
            result["completion_profit_proof"]["gate_id"],
            verifier.DOC29_LIVE_SCALE_GATE,
        )

    def test_runtime_ledger_profit_proof_fails_closed_on_missing_or_weak_completion(
        self,
    ) -> None:
        missing = evaluate_trading_readiness(
            _ready_status(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )
        self.assertFalse(missing["ok"])
        self.assertIn("completion_status_present", missing["failed_checks"])

        weak = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                gate_status="blocked",
                blocked_reason="runtime_ledger_profit_proof_missing",
                net_pnl="499.99",
                expectancy_bps="0",
                trading_day_count=2,
                ledger_refs=[],
                unbacked_refs=["window-1"],
            ),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertFalse(weak["ok"])
        for check_name in (
            "doc29_live_scale_gate_satisfied",
            "runtime_ledger_db_refs_present",
            "runtime_ledger_unbacked_windows_empty",
            "runtime_ledger_observed_trading_days",
            "runtime_ledger_net_pnl_target",
            "runtime_ledger_daily_net_pnl_target",
            "runtime_ledger_post_cost_expectancy_positive",
        ):
            self.assertIn(check_name, weak["failed_checks"])

    def test_runtime_ledger_profit_proof_requires_tca_cost_lineage_readback(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get("dimension") == "execution_tca"
            ):
                source_ref = dimension["source_ref"]
                assert isinstance(source_ref, dict)
                source_ref["runtime_ledger_lineage"] = {
                    "schema_version": "torghut.execution-tca-cost-lineage.v1",
                    "status": "blocked",
                    "promotion_authority": False,
                    "execution_count": 1,
                    "source_backed_count": 0,
                    "blocked_count": 1,
                    "filled_notional_count": 1,
                    "explicit_cost_count": 0,
                    "execution_policy_hash_count": 1,
                    "cost_model_hash_count": 1,
                    "post_cost_pnl_basis_count": 1,
                    "blockers": ["explicit_cost_missing"],
                    "blocker_counts": {"explicit_cost_missing": 1},
                    "sample_blockers": [
                        {
                            "execution_id": "exec-1",
                            "blockers": ["explicit_cost_missing"],
                        }
                    ],
                }

        result = evaluate_trading_readiness(
            status,
            completion_status=_completion_status(),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "execution_tca_cost_lineage_source_backed",
            result["failed_checks"],
        )
        self.assertEqual(
            result["execution_tca_lineage"]["blockers"],
            ["explicit_cost_missing"],
        )

    def test_tca_cost_lineage_readback_does_not_replace_runtime_authority(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("completion_status_present", result["failed_checks"])
        self.assertNotIn(
            "execution_tca_cost_lineage_source_backed",
            result["failed_checks"],
        )

    def test_runtime_ledger_proof_packet_can_be_required_as_final_authority(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=_runtime_ledger_proof_packet(),
            require_runtime_ledger_proof_packet=True,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["failed_checks"], [])
        self.assertEqual(
            result["runtime_ledger_proof_packet"]["schema_version"],
            verifier.RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION,
        )
        self.assertEqual(
            result["runtime_ledger_proof_packet"]["proof_mode"], "authority"
        )
        self.assertTrue(result["runtime_ledger_proof_packet"]["final_authority_ok"])
        self.assertFalse(
            result["runtime_ledger_proof_packet"]["evidence_collection_ok"]
        )
        packet_summary = result["runtime_ledger_proof_packet"]
        self.assertTrue(packet_summary["promotion_allowed"])
        self.assertTrue(packet_summary["final_promotion_allowed"])
        self.assertEqual(packet_summary["min_runtime_ledger_trading_days"], 20)
        self.assertEqual(
            packet_summary["min_runtime_ledger_daily_net_pnl_after_costs"], "500"
        )
        self.assertEqual(
            packet_summary["min_runtime_ledger_net_pnl_after_costs"], "10000"
        )
        self.assertTrue(packet_summary["source_backed_runtime_ledger_proof_required"])
        self.assertTrue(packet_summary["non_empty_runtime_ledger_source_refs_required"])
        self.assertEqual(packet_summary["blockers"], [])
        self.assertEqual(packet_summary["authority_blockers"], [])

    def test_tigerbeetle_parity_can_be_required_as_accounting_only_gate(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            tigerbeetle_parity=_tigerbeetle_parity(),
            require_tigerbeetle_parity=True,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["failed_checks"], [])
        self.assertEqual(result["tigerbeetle_parity"]["parity_status"], "pass")

    def test_tigerbeetle_parity_requirement_fails_closed_on_degraded_or_authority_claim(
        self,
    ) -> None:
        degraded = evaluate_trading_readiness(
            _ready_status(),
            tigerbeetle_parity=_tigerbeetle_parity(
                ok=False,
                parity_status="blocked",
                blockers=["tigerbeetle_parity_entry_missing"],
            ),
            require_tigerbeetle_parity=True,
        )

        self.assertFalse(degraded["ok"])
        self.assertIn(
            "tigerbeetle_runtime_ledger_parity",
            degraded["failed_checks"],
        )
        self.assertEqual(
            degraded["next_action"],
            "repair_tigerbeetle_journal_parity_without_using_as_profit_authority",
        )

        synthetic = evaluate_trading_readiness(
            _ready_status(),
            tigerbeetle_parity=_tigerbeetle_parity(
                overrides_runtime_ledger_authority=True
            ),
            require_tigerbeetle_parity=True,
        )
        self.assertFalse(synthetic["ok"])
        self.assertIn("tigerbeetle_runtime_ledger_parity", synthetic["failed_checks"])

    def test_tigerbeetle_parity_does_not_replace_runtime_ledger_authority(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            tigerbeetle_parity=_tigerbeetle_parity(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
            require_tigerbeetle_parity=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("completion_status_present", result["failed_checks"])
        self.assertNotIn("tigerbeetle_runtime_ledger_parity", result["failed_checks"])

    def test_runtime_ledger_proof_packet_fails_closed_when_blocked(self) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=_runtime_ledger_proof_packet(
                allowed=False,
                blockers=["runtime_ledger_daily_net_pnl_below_target"],
            ),
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "runtime_ledger_proof_packet_authority",
            result["failed_checks"],
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_proof_packet_authority"]["observed"][
                "blocking_reasons"
            ],
            ["runtime_ledger_daily_net_pnl_below_target"],
        )

    def test_runtime_ledger_proof_packet_rejects_smoke_mode_as_final_authority(
        self,
    ) -> None:
        packet = _runtime_ledger_proof_packet()
        packet["proof_mode"] = "smoke"
        packet["proof_mode_contract"] = {
            "proof_mode": "smoke",
            "default_proof_mode": "smoke",
            "authority_scope": "plumbing_only",
            "mode_can_grant_final_authority": False,
            "mode_can_grant_promotion_authority": False,
            "requires_explicit_authority_mode_for_final_promotion": True,
            "implicit_default_final_authority": False,
        }
        packet["final_authority_ok"] = False
        packet["evidence_collection_only"] = True
        packet["capital_promotion_allowed"] = False
        packet["promotion_allowed"] = False
        packet["final_promotion_allowed"] = False
        packet["evidence_collection_ok"] = True
        packet["next_action"] = "rerun_proof_packet_in_authority_mode"
        packet["promotion_authority"] = {
            "allowed": False,
            "reason": "runtime_ledger_proof_mode_not_authority",
            "blocking_reasons": ["runtime_ledger_proof_mode_not_authority"],
            "failed_checks": ["runtime_ledger_proof_mode_authority_required"],
        }

        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=packet,
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        observed = result["checks"]["runtime_ledger_proof_packet_authority"]["observed"]
        self.assertEqual(observed["proof_mode"], "smoke")
        self.assertFalse(observed["authority_allowed"])
        self.assertFalse(observed["mode_contract_allows_authority"])
        packet_summary = result["runtime_ledger_proof_packet"]
        self.assertEqual(packet_summary["proof_mode"], "smoke")
        self.assertEqual(
            packet_summary["proof_mode_contract"]["authority_scope"],
            "plumbing_only",
        )
        self.assertFalse(packet_summary["final_authority_ok"])
        self.assertTrue(packet_summary["evidence_collection_ok"])
        self.assertFalse(packet_summary["promotion_allowed"])
        self.assertFalse(packet_summary["final_promotion_allowed"])
        self.assertEqual(result["next_action"], "rerun_proof_packet_in_authority_mode")

    def test_runtime_ledger_proof_packet_readback_separates_probation_collection(
        self,
    ) -> None:
        proof_packet = _runtime_ledger_proof_packet()
        proof_packet["proof_mode"] = "probation"
        proof_packet["proof_mode_contract"] = {
            "proof_mode": "probation",
            "default_proof_mode": "smoke",
            "authority_scope": "bounded_evidence_collection_only",
            "mode_can_grant_final_authority": False,
            "mode_can_grant_promotion_authority": False,
            "requires_explicit_authority_mode_for_final_promotion": True,
            "implicit_default_final_authority": False,
        }
        proof_packet["final_authority_ok"] = False
        proof_packet["evidence_collection_only"] = True
        proof_packet["evidence_collection_ok"] = True
        proof_packet["canary_collection_authorized"] = True
        proof_packet["promotion_allowed"] = False
        proof_packet["capital_promotion_allowed"] = False
        proof_packet["final_promotion_allowed"] = False
        proof_packet["next_action"] = "rerun_proof_packet_in_authority_mode"
        proof_packet["promotion_authority"] = {
            "allowed": False,
            "reason": "runtime_ledger_proof_mode_not_authority",
            "blocking_reasons": ["runtime_ledger_proof_mode_not_authority"],
            "failed_checks": ["runtime_ledger_proof_mode_authority_required"],
        }

        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=proof_packet,
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        packet_summary = result["runtime_ledger_proof_packet"]
        self.assertEqual(packet_summary["proof_mode"], "probation")
        self.assertEqual(
            packet_summary["proof_mode_contract"]["authority_scope"],
            "bounded_evidence_collection_only",
        )
        self.assertFalse(packet_summary["final_authority_ok"])
        self.assertTrue(packet_summary["evidence_collection_only"])
        self.assertTrue(packet_summary["evidence_collection_ok"])
        self.assertTrue(packet_summary["canary_collection_authorized"])
        self.assertFalse(packet_summary["promotion_allowed"])
        self.assertFalse(packet_summary["capital_promotion_allowed"])
        self.assertFalse(packet_summary["final_promotion_allowed"])

    def test_runtime_ledger_proof_packet_requires_explicit_authority_mode_contract(
        self,
    ) -> None:
        packet = _runtime_ledger_proof_packet(allowed=True)
        packet.pop("proof_mode_contract")

        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=packet,
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        observed = result["checks"]["runtime_ledger_proof_packet_authority"]["observed"]
        self.assertEqual(observed["proof_mode"], "authority")
        self.assertEqual(observed["proof_mode_contract"], {})
        self.assertFalse(observed["mode_contract_allows_authority"])
        self.assertIn(
            "runtime_ledger_proof_packet_authority",
            result["failed_checks"],
        )

    def test_runtime_ledger_proof_packet_requires_authority_target_contract(
        self,
    ) -> None:
        packet = _runtime_ledger_proof_packet(allowed=True)
        target = packet["target"]
        assert isinstance(target, dict)
        target["min_runtime_ledger_trading_days"] = 1
        target["source_backed_runtime_ledger_proof_required"] = False

        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=packet,
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        observed = result["checks"]["runtime_ledger_proof_packet_authority"]["observed"]
        self.assertFalse(observed["authority_target_contract_ok"])
        self.assertEqual(observed["min_runtime_ledger_trading_days"], 1)
        self.assertFalse(observed["source_backed_runtime_ledger_proof_required"])
        self.assertIn(
            "runtime_ledger_proof_packet_authority",
            result["failed_checks"],
        )

    def test_runtime_ledger_proof_packet_rejects_mislabeled_smoke_authority(
        self,
    ) -> None:
        packet = _runtime_ledger_proof_packet(allowed=True)
        packet["proof_mode"] = "smoke"

        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=packet,
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        observed = result["checks"]["runtime_ledger_proof_packet_authority"]["observed"]
        self.assertEqual(observed["proof_mode"], "smoke")
        self.assertTrue(observed["promotion_allowed"])
        self.assertTrue(observed["final_promotion_allowed"])
        self.assertIn(
            "runtime_ledger_proof_packet_authority",
            result["failed_checks"],
        )

    def test_runtime_ledger_blockers_map_to_concrete_next_actions(self) -> None:
        cases = [
            (
                "runtime_window_import_missing",
                "run_runtime_window_import_from_paper_route_target_plan",
            ),
            (
                "runtime_ledger_source_authority_missing",
                "inspect_runtime_ledger_source_activity",
            ),
            (
                "runtime_ledger_trading_days_below_target",
                "collect_more_runtime_ledger_trading_days",
            ),
            (
                "runtime_ledger_closed_round_trips_below_authority_floor",
                "collect_more_closed_runtime_round_trips",
            ),
            (
                "runtime_ledger_filled_notional_below_authority_floor",
                "collect_more_runtime_ledger_filled_notional",
            ),
            (
                "runtime_ledger_explicit_costs_missing",
                "repair_runtime_ledger_lifecycle_cost_or_lineage_evidence",
            ),
        ]
        for blocker, expected_action in cases:
            with self.subTest(blocker=blocker):
                action = verifier._readiness_next_action(
                    failed_checks=["runtime_ledger_proof_packet_authority"],
                    checks={
                        "runtime_ledger_proof_packet_authority": {
                            "observed": {"blocking_reasons": [blocker]}
                        }
                    },
                    runtime_ledger_proof_packet={},
                )

                self.assertEqual(action, expected_action)

    def test_runtime_ledger_profit_proof_requires_observed_days_and_daily_pnl(
        self,
    ) -> None:
        short_window = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                net_pnl="15000",
                trading_day_count=3,
            ),
            min_runtime_ledger_net_pnl=Decimal("12500"),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )
        self.assertFalse(short_window["ok"])
        self.assertIn(
            "runtime_ledger_observed_trading_days",
            short_window["failed_checks"],
        )

        weak_daily = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                net_pnl="600",
                trading_day_count=25,
            ),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )
        self.assertFalse(weak_daily["ok"])
        self.assertIn(
            "runtime_ledger_daily_net_pnl_target",
            weak_daily["failed_checks"],
        )

    def test_runtime_ledger_profit_proof_prefers_persisted_daily_mean(self) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                net_pnl="15000",
                trading_day_count=25,
                mean_daily_net_pnl="300",
            ),
            min_runtime_ledger_net_pnl=Decimal("12500"),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("runtime_ledger_daily_net_pnl_target", result["failed_checks"])
        self.assertEqual(
            result["checks"]["runtime_ledger_daily_net_pnl_target"]["detail"][
                "source_key"
            ],
            "runtime_ledger_mean_daily_net_pnl_after_costs",
        )

    def test_runtime_ledger_daily_net_pnl_reports_missing_without_inputs(self) -> None:
        self.assertEqual(
            verifier._runtime_ledger_daily_net_pnl(
                {},
                net_pnl=None,
                trading_day_count=0,
            ),
            (None, "missing"),
        )

    def test_live_and_either_profiles_use_live_floor_states_and_market_window(
        self,
    ) -> None:
        status = _ready_status()
        status["mode"] = "live"
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics.pop("market_session_open")
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                "floor_state": "live_micro_ready",
                "route_state": "live_micro_candidate",
                "capital_state": "live_allowed",
                "market_window": {"session_open": "open"},
            }
        )

        live = evaluate_trading_readiness(
            status, profile="live", min_routeable_symbols=2
        )
        either = evaluate_trading_readiness(
            status, profile="either", min_routeable_symbols=2
        )

        self.assertTrue(live["ok"], live)
        self.assertTrue(either["ok"], either)

    def test_repair_only_route_universe_fails_with_actionable_checks(self) -> None:
        status = _ready_status()
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "execution_tca_route_universe_empty",
                    "market_context_stale",
                ],
            }
        )
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if not isinstance(dimension, dict):
                continue
            if dimension.get("dimension") == "alpha_readiness":
                dimension["state"] = "fail"
                dimension["reason"] = "alpha_readiness_not_promotion_eligible"
            if dimension.get("dimension") == "market_context":
                dimension["state"] = "stale"
                dimension["reason"] = "market_context_stale"
            if dimension.get("dimension") == "execution_tca":
                dimension["state"] = "fail"
                dimension["reason"] = "execution_tca_route_universe_empty"
                source_ref = dimension["source_ref"]
                assert isinstance(source_ref, dict)
                symbol_routes = source_ref["symbol_routes"]
                assert isinstance(symbol_routes, dict)
                symbol_routes.update(
                    {
                        "routeable_symbol_count": 0,
                        "blocked_symbol_count": 1,
                        "missing_symbol_count": 1,
                        "routeable_symbols": [],
                        "blocked_symbols": [{"symbol": "NVDA"}],
                        "missing_symbols": ["AVGO"],
                    }
                )

        status["route_reacquisition_board"] = {
            "schema_version": "torghut.route-reacquisition-board.v1",
            "state": "repair_only",
            "capital_state": "zero_notional",
            "summary": {
                "row_count": 2,
                "state_counts": {"blocked": 1, "missing": 1},
                "zero_notional_row_count": 2,
                "expected_unblock_value": 3,
                "top_repair_symbols": ["NVDA", "AVGO"],
                "capital_eligible_symbol_count": 0,
            },
            "rows": [
                {"symbol": "NVDA", "state": "blocked", "max_notional": "0"},
                {"symbol": "AVGO", "state": "missing", "max_notional": "0"},
            ],
        }

        result = evaluate_trading_readiness(
            status,
            profile="paper",
            min_routeable_symbols=2,
            min_decisions=1,
            min_orders=1,
        )

        self.assertFalse(result["ok"])
        self.assertIn("proof_floor_state", result["failed_checks"])
        self.assertIn("capital_state", result["failed_checks"])
        self.assertIn("alpha_readiness_pass", result["failed_checks"])
        self.assertIn("market_context_pass", result["failed_checks"])
        self.assertIn("execution_tca_pass", result["failed_checks"])
        self.assertIn("routeable_symbol_count", result["failed_checks"])
        self.assertIn("blocked_symbol_count", result["failed_checks"])
        self.assertIn("missing_symbol_count", result["failed_checks"])
        self.assertIn("route_board_jangar_continuity_ready", result["failed_checks"])
        self.assertIn("route_board_capital_eligible_symbols", result["failed_checks"])
        self.assertIn("route_board_zero_notional_rows", result["failed_checks"])

    def test_optional_quant_empty_fails_unless_informational_quant_is_allowed(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get("dimension") == "quant_ingestion"
            ):
                dimension["state"] = "informational"
                dimension["reason"] = "quant_latest_metrics_empty"
                dimension["source_ref"] = {"required": False}

        strict = evaluate_trading_readiness(status, require_quant_fresh=True)
        permissive = evaluate_trading_readiness(status, require_quant_fresh=False)

        self.assertFalse(strict["ok"])
        self.assertIn("quant_ingestion_ready", strict["failed_checks"])
        self.assertTrue(permissive["ok"])

    def test_required_quant_empty_fails_even_when_informational_quant_is_allowed(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get("dimension") == "quant_ingestion"
            ):
                dimension["state"] = "informational"
                dimension["reason"] = "quant_latest_metrics_empty"
                dimension["source_ref"] = {"required": True}

        result = evaluate_trading_readiness(status, require_quant_fresh=False)

        self.assertFalse(result["ok"])
        self.assertIn("quant_ingestion_ready", result["failed_checks"])

    def test_legacy_evidence_required_quant_empty_fails_when_informational_quant_is_allowed(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get("dimension") == "quant_ingestion"
            ):
                dimension["state"] = "informational"
                dimension["reason"] = "quant_latest_metrics_empty"
                dimension["source_ref"] = {"evidence_required": True}

        result = evaluate_trading_readiness(status, require_quant_fresh=False)

        self.assertFalse(result["ok"])
        self.assertIn("quant_ingestion_ready", result["failed_checks"])

    def test_closed_session_paper_route_probe_candidate_can_be_required_for_next_session(
        self,
    ) -> None:
        status = _ready_status()
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics["market_session_open"] = 0
        route_book = status["route_reacquisition_book"]
        assert isinstance(route_book, dict)
        probe = route_book["paper_route_probe"]
        assert isinstance(probe, dict)
        probe.update(
            {
                "active": False,
                "effective_max_notional": "0",
                "next_session_max_notional": "25",
                "active_symbols": [],
                "blocking_reasons": ["market_session_closed"],
            }
        )
        summary = route_book["summary"]
        assert isinstance(summary, dict)
        summary["paper_route_probe_active_symbols"] = []

        result = evaluate_trading_readiness(
            status,
            require_market_open=False,
            require_paper_route_probe_candidate=True,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["paper_route_probe"]["eligible_symbols"], ["NVDA"])
        self.assertEqual(
            result["paper_route_probe"]["blocking_reasons"], ["market_session_closed"]
        )

    def test_paper_route_target_plan_can_be_required_before_session_open(self) -> None:
        status = _ready_status()
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics["market_session_open"] = 0

        result = evaluate_trading_readiness(
            status,
            paper_route_evidence=_paper_route_evidence(),
            require_market_open=False,
            require_paper_route_target_plan=True,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["paper_route_target_plan"]["target_count"], 1)
        self.assertEqual(
            result["paper_route_target_plan"]["import_blockers"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(
            result["paper_route_target_plan"]["missing_required_flags"], []
        )
        self.assertEqual(result["paper_route_target_plan"]["missing_identity_count"], 0)

    def test_paper_route_target_plan_fails_closed_on_dirty_account(self) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(
                account_state_blockers=["paper_route_account_window_start_not_flat"],
                account_contamination_blockers=[
                    "paper_route_account_contamination_detected"
                ],
            ),
            require_paper_route_target_plan=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("paper_route_target_plan_account_clean", result["failed_checks"])
        self.assertEqual(
            result["paper_route_target_plan"]["account_clean_blockers"],
            [
                "paper_route_account_contamination_detected",
                "paper_route_account_window_start_not_flat",
            ],
        )

    def test_preopen_paper_route_evidence_collection_softens_current_route_failures(
        self,
    ) -> None:
        status = _ready_status()
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics["market_session_open"] = 0
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "degraded",
                    "execution_tca_slippage_guardrail_exceeded",
                ],
            }
        )
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if not isinstance(dimension, dict):
                continue
            if dimension.get("dimension") == "alpha_readiness":
                dimension["state"] = "fail"
                dimension["reason"] = "alpha_readiness_not_promotion_eligible"
            if dimension.get("dimension") == "execution_tca":
                dimension["state"] = "fail"
                dimension["reason"] = "execution_tca_slippage_guardrail_exceeded"
                source_ref = dimension["source_ref"]
                assert isinstance(source_ref, dict)
                symbol_routes = source_ref["symbol_routes"]
                assert isinstance(symbol_routes, dict)
                symbol_routes.update(
                    {
                        "routeable_symbol_count": 0,
                        "routeable_symbols": [],
                    }
                )

        status["route_reacquisition_board"] = {
            "schema_version": "torghut.route-reacquisition-board.v1",
            "state": "repair_only",
            "capital_state": "zero_notional",
            "jangar_continuity": {
                "epoch_id": "truth-settlement:paper_canary:preopen",
                "state": "present",
                "decision": "allow",
                "fresh_until": "2026-05-29T13:30:00+00:00",
                "blocking_reasons": [],
            },
            "summary": {
                "row_count": 4,
                "state_counts": {"probing": 4},
                "zero_notional_row_count": 4,
                "expected_unblock_value": 12,
                "top_repair_symbols": ["AAPL", "AMZN", "INTC", "NVDA"],
                "capital_eligible_symbol_count": 0,
            },
            "rows": [
                {"symbol": "AAPL", "state": "probing", "max_notional": "0"},
                {"symbol": "AMZN", "state": "probing", "max_notional": "0"},
            ],
        }
        route_book = status["route_reacquisition_book"]
        assert isinstance(route_book, dict)
        route_book["state"] = "repair_only"
        probe = route_book["paper_route_probe"]
        assert isinstance(probe, dict)
        probe.update(
            {
                "active": False,
                "effective_max_notional": "0",
                "next_session_max_notional": "63180.0",
                "eligible_symbol_count": 2,
                "eligible_symbols": ["AAPL", "AMZN"],
                "active_symbols": [],
                "blocking_reasons": ["market_session_closed"],
            }
        )
        summary = route_book["summary"]
        assert isinstance(summary, dict)
        summary["paper_route_probe_eligible_symbols"] = ["AAPL", "AMZN"]
        summary["paper_route_probe_active_symbols"] = []

        strict = evaluate_trading_readiness(
            status,
            paper_route_evidence=_paper_route_evidence(),
            require_market_open=False,
            require_quant_fresh=False,
            require_paper_route_probe_candidate=True,
            require_paper_route_target_plan=True,
        )
        preopen = evaluate_trading_readiness(
            status,
            paper_route_evidence=_paper_route_evidence(),
            require_market_open=False,
            require_quant_fresh=False,
            require_paper_route_probe_candidate=True,
            require_paper_route_target_plan=True,
            allow_paper_route_preopen_evidence_collection=True,
        )

        self.assertFalse(strict["ok"])
        self.assertIn("max_notional_positive", strict["failed_checks"])
        self.assertTrue(preopen["ok"], preopen)
        preopen_summary = preopen["paper_route_preopen_evidence_collection"]
        self.assertTrue(preopen_summary["ready"])
        self.assertIn(
            "max_notional_positive",
            preopen_summary["softened_checks"],
        )
        self.assertTrue(
            preopen["checks"]["max_notional_positive"]["detail"][
                "preopen_evidence_collection_override"
            ]
        )

    def test_preopen_target_plan_check_does_not_require_separate_probe_flag(
        self,
    ) -> None:
        status = _ready_status()
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics["market_session_open"] = 0
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "execution_tca_slippage_guardrail_exceeded",
                ],
            }
        )
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if not isinstance(dimension, dict):
                continue
            if dimension.get("dimension") == "alpha_readiness":
                dimension["state"] = "fail"
                dimension["reason"] = "alpha_readiness_not_promotion_eligible"
            if dimension.get("dimension") == "execution_tca":
                dimension["state"] = "fail"
                dimension["reason"] = "execution_tca_slippage_guardrail_exceeded"

        route_book = status["route_reacquisition_book"]
        assert isinstance(route_book, dict)
        route_book["state"] = "repair_only"
        probe = route_book["paper_route_probe"]
        assert isinstance(probe, dict)
        probe.update(
            {
                "active": False,
                "effective_max_notional": "0",
                "next_session_max_notional": "63180.0",
                "eligible_symbol_count": 2,
                "eligible_symbols": ["AAPL", "AMZN"],
                "active_symbols": [],
                "blocking_reasons": ["market_session_closed"],
            }
        )
        summary = route_book["summary"]
        assert isinstance(summary, dict)
        summary["paper_route_probe_eligible_symbols"] = ["AAPL", "AMZN"]
        summary["paper_route_probe_active_symbols"] = []

        result = evaluate_trading_readiness(
            status,
            paper_route_evidence=_paper_route_evidence(),
            require_market_open=False,
            require_quant_fresh=False,
            require_paper_route_target_plan=True,
            allow_paper_route_preopen_evidence_collection=True,
        )

        self.assertTrue(result["ok"], result)
        preopen_summary = result["paper_route_preopen_evidence_collection"]
        self.assertTrue(preopen_summary["ready"])
        self.assertTrue(
            preopen_summary["conditions"]["probe_candidate_requirement_satisfied"]
        )

    def test_preopen_softening_requires_clean_paper_account(self) -> None:
        status = _ready_status()
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics["market_session_open"] = 0
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "execution_tca_slippage_guardrail_exceeded",
                ],
            }
        )
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if not isinstance(dimension, dict):
                continue
            if dimension.get("dimension") == "alpha_readiness":
                dimension["state"] = "fail"
                dimension["reason"] = "alpha_readiness_not_promotion_eligible"
            if dimension.get("dimension") == "execution_tca":
                dimension["state"] = "fail"
                dimension["reason"] = "execution_tca_slippage_guardrail_exceeded"

        route_book = status["route_reacquisition_book"]
        assert isinstance(route_book, dict)
        route_book["state"] = "repair_only"
        probe = route_book["paper_route_probe"]
        assert isinstance(probe, dict)
        probe.update(
            {
                "active": False,
                "effective_max_notional": "0",
                "next_session_max_notional": "63180.0",
                "eligible_symbol_count": 2,
                "eligible_symbols": ["AAPL", "AMZN"],
                "active_symbols": [],
                "blocking_reasons": ["market_session_closed"],
            }
        )
        summary = route_book["summary"]
        assert isinstance(summary, dict)
        summary["paper_route_probe_eligible_symbols"] = ["AAPL", "AMZN"]
        summary["paper_route_probe_active_symbols"] = []

        result = evaluate_trading_readiness(
            status,
            paper_route_evidence=_paper_route_evidence(
                account_state_blockers=["paper_route_account_window_start_not_flat"],
            ),
            require_market_open=False,
            require_quant_fresh=False,
            require_paper_route_target_plan=True,
            allow_paper_route_preopen_evidence_collection=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("paper_route_target_plan_account_clean", result["failed_checks"])
        preopen_summary = result["paper_route_preopen_evidence_collection"]
        self.assertFalse(preopen_summary["ready"])
        self.assertFalse(preopen_summary["conditions"]["target_plan_account_clean"])

    def test_paper_route_target_plan_fails_closed_on_missing_handoff_or_identity(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(
                required_flags=["--runtime-window-import"],
                target_overrides={
                    "strategy_name": "",
                    "paper_route_probe_symbols": [],
                    "promotion_allowed": True,
                    "max_notional": "25",
                },
            ),
            require_paper_route_target_plan=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("paper_route_target_plan_handoff_flags", result["failed_checks"])
        self.assertIn(
            "paper_route_target_plan_target_identity", result["failed_checks"]
        )
        self.assertIn("paper_route_target_plan_probe_contract", result["failed_checks"])
        self.assertIn(
            "paper_route_target_plan_promotion_blocked", result["failed_checks"]
        )

    def test_paper_route_import_ready_is_separate_from_target_plan_presence(
        self,
    ) -> None:
        waiting = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(),
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )
        self.assertFalse(waiting["ok"])
        self.assertIn("paper_route_target_plan_import_ready", waiting["failed_checks"])

        ready = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(import_ready=True),
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )
        self.assertTrue(ready["ok"], ready)

    def test_paper_route_readiness_surfaces_quote_fillability_blockers(
        self,
    ) -> None:
        evidence = _paper_route_evidence(import_ready=True)
        runtime_window_audit = evidence["runtime_window_import_audit"]
        assert isinstance(runtime_window_audit, dict)
        diagnostics = runtime_window_audit["diagnostics"]
        assert isinstance(diagnostics, dict)
        diagnostics["rejected_signal_diagnostic_reasons"] = [
            "source_signal_rejected_by_quote_quality",
            "source_reject_missing_bid",
            "source_reject_spread_bps_exceeded",
        ]

        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=evidence,
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "paper_route_target_plan_quote_fillability", result["failed_checks"]
        )
        self.assertEqual(
            result["next_action"],
            "repair_quote_quality_or_fillability_before_runtime_ledger_collection",
        )
        quote_fillability = result["paper_route_target_plan"]["quote_fillability"]
        self.assertTrue(quote_fillability["blocked"])
        self.assertEqual(quote_fillability["state"], "blocked")
        self.assertEqual(
            quote_fillability["repair_action"],
            "collect_bid_quote_before_routeability_claim",
        )
        self.assertEqual(
            quote_fillability["blocking_reasons"],
            [
                "source_reject_missing_bid",
                "source_reject_spread_bps_exceeded",
                "source_signal_rejected_by_quote_quality",
            ],
        )

    def test_paper_route_readiness_surfaces_target_quote_fillability_context(
        self,
    ) -> None:
        evidence = _paper_route_evidence(
            import_ready=True,
            target_overrides={
                "symbol": "AAPL",
                "quote_routeability": {
                    "symbol": "AAPL",
                    "status": "blocked",
                    "reason": "quote_feed_gap",
                    "reason_codes": ["quote_temporarily_unavailable"],
                    "quote_age_seconds": "61",
                    "spread_bps": "24.5",
                    "source": "paper_route_nbbo",
                },
            },
        )
        runtime_window_audit = evidence["runtime_window_import_audit"]
        assert isinstance(runtime_window_audit, dict)
        runtime_window_audit["blockers"] = ["spread_bps_exceeded"]
        runtime_window_audit["target_blockers"] = [
            {"blockers": ["source_reject_missing_ask"]}
        ]
        evidence["target_audits"] = [
            {
                "target": {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_name": "microbar-pairs-vwap-cap-safe",
                },
                "rejected_signal_activity": {
                    "blocking_reasons": ["source_reject_non_positive_ask"],
                    "reason_counts": [
                        {"reason": "source_reject_crossed_quote", "count": 2}
                    ],
                    "max_spread_bps": "98.1",
                },
            }
        ]

        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=evidence,
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertFalse(result["ok"])
        quote_fillability = result["paper_route_target_plan"]["quote_fillability"]
        self.assertTrue(quote_fillability["blocked"])
        self.assertEqual(
            quote_fillability["blocking_reasons"],
            [
                "quote_feed_gap",
                "quote_temporarily_unavailable",
                "source_reject_crossed_quote",
                "source_reject_missing_ask",
                "source_reject_non_positive_ask",
                "spread_bps_exceeded",
            ],
        )
        self.assertEqual(len(quote_fillability["targets"]), 2)
        self.assertEqual(
            quote_fillability["targets"][0]["repair_action"],
            "repair_quote_quality_or_fillability_before_runtime_ledger_collection",
        )
        self.assertEqual(
            quote_fillability["targets"][1]["repair_action"],
            "refresh_ask_quote_before_routeability_claim",
        )

    def test_quote_fillability_summary_reads_routeability_and_audit_shapes(
        self,
    ) -> None:
        evidence = _paper_route_evidence(import_ready=True)
        target_plan = evidence["next_paper_route_runtime_window_targets"]
        assert isinstance(target_plan, dict)
        targets = target_plan["targets"]
        assert isinstance(targets, list)
        target = targets[0]
        assert isinstance(target, dict)
        target["paper_route_quote_routeability"] = {
            "status": "blocked",
            "symbol": "AAPL",
            "reason": "stale_quote",
            "blocking_reasons": ["routeability_spread_guardrail_exceeded"],
            "quote_age_seconds": "61",
            "spread_bps": "75",
            "source": "paper_route_h_pairs_quote",
        }
        runtime_window_audit = evidence["runtime_window_import_audit"]
        assert isinstance(runtime_window_audit, dict)
        runtime_window_audit["blockers"] = ["fillability_receipt_missing"]
        runtime_window_audit["target_blockers"] = [
            {
                "hypothesis_id": "H-PAIRS-01",
                "blockers": ["source_reject_missing_ask"],
            }
        ]
        evidence["target_audits"] = [
            {
                "target": target,
                "rejected_signal_activity": {
                    "blocking_reasons": ["source_signal_rejected_by_quote_quality"],
                    "reason_counts": [{"reason": "spread_bps_exceeded", "count": 2}],
                    "max_spread_bps": "90",
                },
            }
        ]

        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=evidence,
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertFalse(result["ok"])
        quote_fillability = result["paper_route_target_plan"]["quote_fillability"]
        self.assertTrue(quote_fillability["present"])
        self.assertTrue(quote_fillability["blocked"])
        self.assertIn("stale_quote", quote_fillability["blocking_reasons"])
        self.assertIn(
            "routeability_spread_guardrail_exceeded",
            quote_fillability["blocking_reasons"],
        )
        self.assertIn(
            "source_signal_rejected_by_quote_quality",
            quote_fillability["blocking_reasons"],
        )
        self.assertEqual(quote_fillability["targets"][0]["symbol"], "AAPL")
        self.assertEqual(
            quote_fillability["targets"][0]["repair_action"],
            "refresh_quote_snapshot_and_recompute_route_fillability",
        )
        self.assertEqual(
            quote_fillability["targets"][1]["source"], "rejected_signal_activity"
        )

    def test_quote_fillability_helpers_keep_generic_repair_fallback(
        self,
    ) -> None:
        self.assertEqual(
            verifier._quote_fillability_reason("routeability_depth_missing"),
            "routeability_depth_missing",
        )
        self.assertEqual(
            verifier._quote_fillability_repair_action(["routeability_depth_missing"]),
            "repair_quote_quality_or_fillability_before_runtime_ledger_collection",
        )
        self.assertEqual(
            verifier._readiness_next_action(
                failed_checks=["paper_route_target_plan_quote_fillability"],
                checks={
                    "paper_route_target_plan_quote_fillability": {
                        "observed": {"blocking_reasons": []}
                    }
                },
                runtime_ledger_proof_packet=None,
            ),
            "repair_quote_quality_or_fillability_before_runtime_ledger_collection",
        )

    def test_paper_route_target_plan_allows_drift_only_evidence_collection(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=True,
                target_overrides={
                    "continuity_reason": "signal_continuity_nominal",
                    "drift_ok": "false",
                    "drift_reason": "drift_live_promotion_ineligible",
                    "runtime_window_import_health_gate": {
                        "schema_version": "torghut.runtime-window-import-health-gate.v1",
                        "dependency_quorum_decision": "allow",
                        "continuity_ok": "true",
                        "continuity_reason": "signal_continuity_nominal",
                        "drift_ok": "false",
                        "drift_reason": "drift_live_promotion_ineligible",
                        "blockers": [],
                        "promotion_blockers": ["drift_checks_not_ok"],
                    },
                    "runtime_window_import_health_gate_blockers": [],
                },
            ),
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertTrue(result["ok"], result)
        health_gate = result["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertEqual(health_gate["ready_target_count"], 1)
        self.assertEqual(health_gate["blocked_target_count"], 0)
        self.assertEqual(health_gate["blockers"], [])
        self.assertEqual(health_gate["promotion_blockers"], ["drift_checks_not_ok"])
        self.assertEqual(
            health_gate["continuity_reasons"], ["signal_continuity_nominal"]
        )
        self.assertEqual(
            health_gate["drift_reasons"], ["drift_live_promotion_ineligible"]
        )
        target = result["paper_route_target_plan"]["targets"][0]
        self.assertEqual(target["continuity_reason"], "signal_continuity_nominal")
        self.assertEqual(target["drift_reason"], "drift_live_promotion_ineligible")

    def test_paper_route_target_plan_synthesizes_drift_promotion_blocker(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=True,
                target_overrides={
                    "drift_ok": "false",
                    "runtime_window_import_health_gate": {
                        "schema_version": "torghut.runtime-window-import-health-gate.v1",
                        "dependency_quorum_decision": "allow",
                        "continuity_ok": "true",
                        "drift_ok": "false",
                        "blockers": [],
                        "promotion_blockers": [],
                    },
                    "runtime_window_import_health_gate_blockers": [],
                },
            ),
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertTrue(result["ok"], result)
        health_gate = result["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertEqual(health_gate["ready_target_count"], 1)
        self.assertEqual(health_gate["blocked_target_count"], 0)
        self.assertEqual(health_gate["blockers"], [])
        self.assertEqual(health_gate["promotion_blockers"], ["drift_not_ok"])

    def test_paper_route_target_plan_requires_runtime_import_health_gate(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=True,
                target_overrides={
                    "dependency_quorum_decision": "missing",
                    "continuity_ok": "false",
                    "runtime_window_import_health_gate": {
                        "schema_version": "torghut.runtime-window-import-health-gate.v1",
                        "dependency_quorum_decision": "missing",
                        "continuity_ok": "false",
                        "drift_ok": "true",
                        "blockers": [
                            "dependency_quorum_not_allow",
                            "continuity_not_ok",
                        ],
                    },
                    "runtime_window_import_health_gate_blockers": [
                        "dependency_quorum_not_allow",
                        "continuity_not_ok",
                    ],
                },
            ),
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "paper_route_target_plan_import_health_gate", result["failed_checks"]
        )
        health_gate = result["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertEqual(health_gate["ready_target_count"], 0)
        self.assertEqual(health_gate["blocked_target_count"], 1)
        self.assertEqual(
            health_gate["blockers"],
            ["continuity_not_ok", "dependency_quorum_not_allow"],
        )

    def test_required_paper_route_probe_candidate_fails_without_bounded_candidate(
        self,
    ) -> None:
        status = _ready_status()
        route_book = status["route_reacquisition_book"]
        assert isinstance(route_book, dict)
        probe = route_book["paper_route_probe"]
        assert isinstance(probe, dict)
        probe.update(
            {
                "configured_enabled": False,
                "effective_max_notional": "0",
                "next_session_max_notional": "0",
                "eligible_symbol_count": 0,
                "eligible_symbols": [],
                "active_symbols": [],
                "blocking_reasons": ["paper_route_probe_disabled"],
            }
        )
        summary = route_book["summary"]
        assert isinstance(summary, dict)
        summary["paper_route_probe_eligible_symbols"] = []
        summary["paper_route_probe_active_symbols"] = []

        result = evaluate_trading_readiness(
            status, require_paper_route_probe_candidate=True
        )

        self.assertFalse(result["ok"])
        self.assertIn("paper_route_probe_configured", result["failed_checks"])
        self.assertIn("paper_route_probe_candidate_symbols", result["failed_checks"])
        self.assertIn("paper_route_probe_notional_positive", result["failed_checks"])
        self.assertIn("paper_route_probe_blockers", result["failed_checks"])

    def test_payload_helpers_handle_runtime_payload_shapes(self) -> None:
        self.assertTrue(verifier._bool("open"))
        self.assertFalse(verifier._bool(object()))
        self.assertEqual(verifier._int(True), 1)
        self.assertEqual(verifier._int(3.8), 3)
        self.assertEqual(verifier._int("7.9"), 7)
        self.assertEqual(verifier._int("not-a-number", default=4), 4)
        self.assertEqual(verifier._int("", default=4), 4)
        self.assertIsNone(verifier._decimal(None))
        self.assertIsNone(verifier._decimal("not-a-number"))
        self.assertEqual(verifier._mapping(object()), {})
        self.assertEqual(verifier._sequence("NVDA"), [])

    def test_status_loaders_require_json_objects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "status.json"
            status_path.write_text(
                json.dumps(["not", "an", "object"]), encoding="utf-8"
            )

            with self.assertRaisesRegex(ValueError, "json_object_required"):
                verifier._load_json_object(status_path)

        self.assertEqual(_load_from_test_server({"ok": True}), {"ok": True})
        with self.assertRaisesRegex(ValueError, "json_object_required"):
            _load_from_test_server(["not", "an", "object"])

    def test_cli_returns_nonzero_for_failed_status_file(self) -> None:
        status = _ready_status()
        status["running"] = False
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "status.json"
            status_path.write_text(json.dumps(status), encoding="utf-8")

            exit_code = main(["--status-file", str(status_path)])

        self.assertEqual(exit_code, 1)

    def test_cli_accepts_completion_file_for_runtime_ledger_profit_proof(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "status.json"
            completion_path = Path(tmp_dir) / "completion.json"
            status_path.write_text(json.dumps(_ready_status()), encoding="utf-8")
            completion_path.write_text(
                json.dumps(_completion_status()), encoding="utf-8"
            )

            exit_code = main(
                [
                    "--status-file",
                    str(status_path),
                    "--completion-file",
                    str(completion_path),
                    "--require-runtime-ledger-profit-proof",
                    "--min-runtime-ledger-net-pnl",
                    "500",
                    "--min-runtime-ledger-trading-days",
                    "25",
                    "--min-runtime-ledger-daily-net-pnl",
                    "20",
                ]
            )

        self.assertEqual(exit_code, 0)

    def test_cli_rejects_non_decimal_runtime_ledger_profit_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "status.json"
            status_path.write_text(json.dumps(_ready_status()), encoding="utf-8")

            with self.assertRaisesRegex(SystemExit, "must be decimal"):
                main(
                    [
                        "--status-file",
                        str(status_path),
                        "--require-runtime-ledger-profit-proof",
                        "--min-runtime-ledger-net-pnl",
                        "not-a-number",
                    ]
                )

            with self.assertRaisesRegex(SystemExit, "daily-net-pnl must be decimal"):
                main(
                    [
                        "--status-file",
                        str(status_path),
                        "--require-runtime-ledger-profit-proof",
                        "--min-runtime-ledger-daily-net-pnl",
                        "not-a-number",
                    ]
                )
