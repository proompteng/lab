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
                "target_plan_endpoint": "/trading/proofs?kind=runtime_window&window=next&limit=20",
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


def _proofs_evidence(
    *,
    state: str = "import_due",
    blockers: list[str] | None = None,
    account_blockers: list[str] | None = None,
    health_blockers: list[str] | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.proofs.v1",
        "window": {
            "selector": "latest_closed",
            "start": "2026-05-26T13:30:00+00:00",
            "end": "2026-05-26T20:00:00+00:00",
            "closed": True,
        },
        "proofs": [
            {
                "identity": {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "strategy_name": "microbar-pairs-vwap-cap-safe",
                    "runtime_strategy_name": "microbar-pairs-vwap-cap-safe",
                    "account_label": "TORGHUT_SIM",
                    "source_account_label": "TORGHUT_SIM",
                    "source_kind": "runtime_window",
                    "source_plan_ref": "proof-plan:c88421d619759b2cfaa6f4d0",
                    "target_notional": "25",
                },
                "window": {
                    "start": "2026-05-26T13:30:00+00:00",
                    "end": "2026-05-26T20:00:00+00:00",
                    "closed": True,
                },
                "symbols": ["AAPL", "AMZN"],
                "account_state": {
                    "clean_baseline": not account_blockers,
                    "blockers": account_blockers or [],
                },
                "health": {
                    "dependency_quorum_ok": not health_blockers,
                    "continuity_ok": not health_blockers,
                    "drift_ok": not health_blockers,
                    "blockers": health_blockers or [],
                },
                "source_counts": {
                    "decisions": 1,
                    "executions": 1,
                    "execution_tca_metrics": 1,
                    "rejected_signal_events": 0,
                },
                "state": state,
                "blockers": blockers or ["runtime_ledger_materialization_missing"],
            }
        ],
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


class _TestVerifyTradingReadinessBase(TestCase):
    pass


__all__: tuple[str, ...] = (
    "Any",
    "BaseHTTPRequestHandler",
    "ClassVar",
    "Decimal",
    "HTTPServer",
    "Path",
    "TestCase",
    "Thread",
    "_JsonHandler",
    "_TestVerifyTradingReadinessBase",
    "_completion_status",
    "_load_from_test_server",
    "_paper_route_evidence",
    "_proofs_evidence",
    "_ready_status",
    "_runtime_ledger_proof_packet",
    "_tigerbeetle_parity",
    "evaluate_trading_readiness",
    "json",
    "main",
    "tempfile",
    "verifier",
)
