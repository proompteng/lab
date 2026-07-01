from __future__ import annotations


import io
import json
import os
import tempfile
from argparse import Namespace
from decimal import Decimal
from pathlib import Path
from typing import Any, cast
from urllib.error import HTTPError
from unittest import TestCase
from unittest.mock import patch

from scripts import assemble_runtime_ledger_proof_packet as packet


class _FakeObjectStoreClient:
    def __init__(self) -> None:
        self.uploads: list[dict[str, object]] = []

    def put_object(
        self,
        *,
        bucket: str,
        key: str,
        body: bytes,
        content_type: str,
    ) -> dict[str, object]:
        self.uploads.append(
            {
                "bucket": bucket,
                "key": key,
                "body": body,
                "content_type": content_type,
            }
        )
        return {
            "bucket": bucket,
            "key": key,
            "uri": f"s3://{bucket}/{key}",
        }


class _IncompleteReceiptObjectStoreClient(_FakeObjectStoreClient):
    def put_object(
        self,
        *,
        bucket: str,
        key: str,
        body: bytes,
        content_type: str,
    ) -> dict[str, object]:
        super().put_object(
            bucket=bucket,
            key=key,
            body=body,
            content_type=content_type,
        )
        return {"bucket": bucket, "key": key}


_DEFAULT_TIGERBEETLE_LEDGER = object()


def _status(
    *,
    blockers: list[str] | None = None,
    tigerbeetle_ledger: dict[str, object] | None | object = (
        _DEFAULT_TIGERBEETLE_LEDGER
    ),
) -> dict[str, object]:
    payload: dict[str, object] = {
        "mode": "paper",
        "running": True,
        "live_submission_gate": {
            "allowed": not blockers,
            "reason": "allowed" if not blockers else blockers[0],
            "blocked_reasons": blockers or [],
        },
        "proof_floor": {
            "blocking_reasons": [],
        },
    }
    if tigerbeetle_ledger is _DEFAULT_TIGERBEETLE_LEDGER:
        payload["tigerbeetle_ledger"] = _tigerbeetle_ledger_status()
    elif tigerbeetle_ledger is not None:
        payload["tigerbeetle_ledger"] = tigerbeetle_ledger
    return payload


def _tigerbeetle_ledger_status(
    *,
    ok: bool = True,
    runtime_ledger_ref_count: int = 1,
    signed_ref_count: int = 1,
    blockers: list[str] | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.tigerbeetle-ledger-status.v1",
        "enabled": True,
        "journal_enabled": True,
        "required": False,
        "reconcile_required": True,
        "ok": ok and not blockers,
        "protocol_ok": True,
        "reconciliation_ok": ok and not blockers,
        "ref_counts": {
            "runtime_ledger_ref_count": runtime_ledger_ref_count,
        },
        "latest_reconciliation": {
            "schema_version": "torghut.tigerbeetle-reconciliation.v1",
            "ok": ok and not blockers,
            "runtime_ledger_checked_transfer_count": runtime_ledger_ref_count,
            "runtime_ledger_signed_transfer_count": signed_ref_count,
            "ref_counts": {
                "runtime_ledger_ref_count": runtime_ledger_ref_count,
            },
            "blockers": blockers or [],
        },
        "blockers": blockers or [],
    }


def _paper_route_evidence(
    *,
    import_ready: bool = True,
    import_blockers: list[str] | None = None,
    import_audit: dict[str, object] | None = None,
) -> dict[str, object]:
    blockers = import_blockers if import_blockers is not None else []
    payload: dict[str, object] = {
        "schema_version": "torghut.paper-route-evidence.v1",
        "next_paper_route_runtime_window_targets": {
            "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
            "target_count": 1,
            "session_window": {
                "start": "2026-05-26T13:30:00+00:00",
                "end": "2026-05-26T20:00:00+00:00",
            },
            "session_readiness": {
                "import_ready": import_ready,
                "import_blockers": blockers,
            },
            "runtime_window_import_handoff": {
                "runner": "removed_runtime_window_import_handoff",
                "import_ready": import_ready,
                "import_blockers": blockers,
                "promotion_allowed": False,
                "final_promotion_authorized": False,
            },
            "targets": [
                {
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "hypothesis_id": "H-PAIRS-01",
                    "observed_stage": "paper",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "strategy_name": "microbar-pairs-vwap-cap-safe",
                    "account_label": "TORGHUT_SIM",
                    "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                    "window_start": "2026-05-26T13:30:00+00:00",
                    "window_end": "2026-05-26T20:00:00+00:00",
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
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
            ],
        },
    }
    if import_audit is not None:
        payload["runtime_window_import_audit"] = import_audit
    else:
        payload["runtime_window_import_audit"] = {
            "schema_version": "torghut.paper-route-runtime-window-import-audit.v1",
            "state": "runtime_ledger_ready_for_gate_review"
            if import_ready
            else "waiting_for_session_open",
            "next_action": "review_runtime_ledger_profit_gates"
            if import_ready
            else "wait_for_regular_session_open",
            "import_ready": import_ready,
            "blockers": blockers,
            "counts": {
                "source_plan_target_count": 1,
                "next_runtime_window_target_count": 1,
                "targets_with_source_activity": 1 if import_ready else 0,
                "targets_with_runtime_ledger": 1 if import_ready else 0,
                "targets_with_evidence_grade_runtime_ledger": 1 if import_ready else 0,
                "targets_with_promotion_decision": 1 if import_ready else 0,
            },
            "promotion_authority": {
                "allowed": False,
                "reason": "runtime_window_import_audit_observability_only",
            },
        }
    return payload


def _proofs_payload(
    *,
    state: str = "import_due",
    blockers: list[str] | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.proofs.v1",
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
                    "target_symbol_actions": {"AAPL": "buy", "AMZN": "sell"},
                    "target_symbol_quantities": {"AAPL": "1", "AMZN": "1"},
                },
                "window": {
                    "start": "2026-05-26T13:30:00+00:00",
                    "end": "2026-05-26T20:00:00+00:00",
                },
                "symbols": ["AAPL", "AMZN"],
                "health": {
                    "dependency_quorum_ok": True,
                    "continuity_ok": True,
                    "drift_ok": True,
                    "blockers": [],
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


def _runtime_import(
    *,
    proof_status: str = "ok",
    proof_blockers: list[str] | None = None,
    authoritative: bool = True,
    materialization_target: bool = True,
    readback: bool = True,
) -> dict[str, object]:
    blocker_payloads = [{"blocker": blocker} for blocker in proof_blockers or []]
    target_payload: dict[str, object] = {
        "candidate_id": "c88421d619759b2cfaa6f4d0",
        "hypothesis_id": "H-PAIRS-01",
        "observed_stage": "paper",
        "strategy_family": "microbar_cross_sectional_pairs",
        "strategy_name": "microbar-pairs-vwap-cap-safe",
        "account_label": "TORGHUT_SIM",
        "window_start": "2026-05-26T13:30:00+00:00",
        "window_end": "2026-05-26T20:00:00+00:00",
        "runtime_ledger_profit_proof_present": authoritative,
        "runtime_ledger_notional_weighted_sample_count": 1 if authoritative else 0,
        "runtime_ledger_filled_notional": "50000" if authoritative else "0",
        "runtime_ledger_net_strategy_pnl_after_costs": "650" if authoritative else "0",
        "metric_window_count": 1,
        "promotion_decision_count": 1,
        "runtime_ledger_bucket_count": 1 if authoritative else 0,
        "evidence_grade_runtime_ledger_bucket_count": 1 if authoritative else 0,
        "metric_window_ids": ["metric-window-1"],
        "promotion_decision_id": "promotion-decision-1",
        "runtime_ledger_bucket_ids": ["runtime-ledger-bucket-1"]
        if authoritative
        else [],
        "evidence_grade_runtime_ledger_bucket_ids": ["runtime-ledger-bucket-1"]
        if authoritative
        else [],
        "materialization_blockers": []
        if authoritative
        else ["runtime_window_import_runtime_ledger_bucket_missing"],
        "proof_status": proof_status,
        "proof_blockers": blocker_payloads,
        "materialized": authoritative and proof_status == "ok" and not blocker_payloads,
    }
    if readback:
        target_payload["readback"] = {
            "schema_version": "torghut.runtime-window-import-readback.v1",
            "run_id": "runtime-import-run-1",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "window_start": "2026-05-26T13:30:00+00:00",
            "window_end": "2026-05-26T20:00:00+00:00",
            "metric_window_count": 1,
            "promotion_decision_count": 1,
            "runtime_ledger_bucket_count": 1 if authoritative else 0,
            "evidence_grade_runtime_ledger_bucket_count": 1 if authoritative else 0,
            "metric_window_refs": [
                "strategy_hypothesis_metric_windows:metric-window-1"
            ],
            "promotion_decision_refs": [
                "strategy_promotion_decisions:promotion-decision-1"
            ],
            "runtime_ledger_bucket_refs": [
                "strategy_runtime_ledger_buckets:runtime-ledger-bucket-1"
            ]
            if authoritative
            else [],
            "evidence_grade_runtime_ledger_bucket_refs": [
                "strategy_runtime_ledger_buckets:runtime-ledger-bucket-1"
            ]
            if authoritative
            else [],
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ]
            if authoritative
            else [],
            "runtime_ledger_source_window_ids": ["source-window-1"]
            if authoritative
            else [],
            "runtime_ledger_execution_order_event_ids": ["event-1"]
            if authoritative
            else [],
            "execution_ids": ["execution-1"] if authoritative else [],
            "execution_tca_metric_ids": ["tca-1"] if authoritative else [],
            "trade_decision_ids": ["decision-1"] if authoritative else [],
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
            ]
            if authoritative
            else [],
            "runtime_ledger_cost_amount": "25" if authoritative else "0",
            "authority_classes": ["runtime_order_feed_execution_source"]
            if authoritative
            else [],
            "authority_reasons": ["event_sourced_runtime_ledger_profit_proof"]
            if authoritative
            else [],
            "source_materializations": ["execution_order_events"]
            if authoritative
            else [],
            "cost_basis_counts": {"broker_reported_commission_and_fees": 1}
            if authoritative
            else {},
            "runtime_ledger_profit_distance_readback": {
                "schema_version": "torghut.runtime-ledger-profit-distance-readback.v1",
                "required_daily_net_pnl": "500",
                "observed_mean_daily_net_pnl": "650" if authoritative else "0",
                "observed_median_daily_net_pnl": "650" if authoritative else "0",
                "observed_p10_daily_net_pnl": "650" if authoritative else "0",
                "observed_worst_day_net_pnl": "650" if authoritative else "0",
                "daily_post_cost_distribution": {
                    "2026-05-26": "650" if authoritative else "0"
                },
                "max_drawdown": {"absolute": "0"},
                "best_day_share": "1" if authoritative else None,
                "symbol_concentration": {"share": None, "basis": None},
                "pair_concentration": {"share": None, "basis": None},
                "filled_notional": {
                    "total": "50000" if authoritative else "0",
                    "average_daily": "50000" if authoritative else "0",
                    "by_trading_day": {"2026-05-26": "50000" if authoritative else "0"},
                },
                "closed_trade_count": 1 if authoritative else 0,
                "open_position_count": 0,
                "source_authority": {
                    "bucket_count": 1 if authoritative else 0,
                    "evidence_grade_bucket_count": 1 if authoritative else 0,
                    "source_backed_bucket_count": 1 if authoritative else 0,
                    "blocked_bucket_count": 0,
                    "blockers": [],
                },
                "blockers": [],
                "missing_to_target": {"daily_net_pnl": "0" if authoritative else "500"},
                "next_blocking_reason": None,
            },
        }
    if authoritative:
        target_payload["tigerbeetle"] = {
            "schema_version": "torghut.tigerbeetle-runtime-ledger-proof-refs.v1",
            "cluster_ids": [2001],
            "account_count": 2,
            "transfer_count": 1,
            "account_ids": ["100100100100100100100100100100100101"],
            "account_keys": ["TORGHUT_SIM:cash", "TORGHUT_SIM:AAPL:position"],
            "transfer_ids": ["340282366920938463463374607431768211"],
            "missing_account_ids": [],
            "source_refs": [
                "postgres:tigerbeetle_account_refs",
                "postgres:tigerbeetle_transfer_refs",
            ],
            "runtime_ledger_buckets": [
                {
                    "runtime_ledger_bucket_id": "runtime-ledger-bucket-1",
                    "transfer_ids": ["340282366920938463463374607431768211"],
                }
            ],
        }
    summary: dict[str, object] = {
        "promotion_allowed": authoritative,
        "runtime_observation": {
            "authoritative": authoritative,
            "authority_reason": "runtime_ledger_profit_proof"
            if authoritative
            else "runtime_without_runtime_ledger_profit_proof",
            "runtime_ledger_profit_proof_present": authoritative,
            "runtime_ledger_tca_profit_proof_count": 1 if authoritative else 0,
            "runtime_ledger_tca_runtime_bucket_row_count": 1 if authoritative else 0,
            "runtime_ledger_tca_authoritative_bucket_count": 1 if authoritative else 0,
            "runtime_ledger_source_execution_materialized_bucket_count": 1
            if authoritative
            else 0,
            "runtime_ledger_source_bucket_profit_proof_count": 1
            if authoritative
            else 0,
            "runtime_ledger_source_materializations": ["execution_order_events"]
            if authoritative
            else [],
            "runtime_ledger_materialization_pnl_derivations": [
                "execution_order_events_runtime_ledger"
            ]
            if authoritative
            else [],
            "runtime_ledger_profit_proof_blockers": [],
            "runtime_ledger_filled_notional": "50000" if authoritative else "0",
            "runtime_ledger_net_strategy_pnl_after_costs": "650"
            if authoritative
            else "0",
        },
    }
    if materialization_target:
        summary["runtime_materialization_target"] = target_payload
    if readback:
        summary["runtime_window_import_readback"] = target_payload["readback"]
    return {
        "status": "ok",
        "proof_status": proof_status,
        "proof_blockers": blocker_payloads,
        "target_count": 1,
        "imports": [
            {
                "status": "ok",
                "proof_status": proof_status,
                "proof_blockers": blocker_payloads,
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "hypothesis_id": "H-PAIRS-01",
                "observed_stage": "paper",
                "strategy_family": "microbar_cross_sectional_pairs",
                "strategy_name": "microbar-pairs-vwap-cap-safe",
                "account_label": "TORGHUT_SIM",
                "window_start": "2026-05-26T13:30:00+00:00",
                "window_end": "2026-05-26T20:00:00+00:00",
                "summary": summary,
            }
        ],
    }


def _completion(
    *,
    status: str = "satisfied",
    net_pnl: str = "10000",
    trading_days: int = 20,
    expectancy_bps: str = "13",
    filled_notional: str = "10000000",
    avg_daily_filled_notional: str | None = "500000",
    median_daily_net_pnl: str | None = "500",
    p10_daily_net_pnl: str | None = "500",
    worst_day_net_pnl: str | None = "500",
    max_intraday_drawdown: str | None = "500",
    drawdown_pct: str | None = "0.02",
    best_day_share: str | None = "0.20",
    symbol_concentration_share: str | None = "0.35",
    ledger_refs: list[str] | None = None,
    unbacked_refs: list[str] | None = None,
    summary_overrides: dict[str, object] | None = None,
) -> dict[str, object]:
    runtime_ledger_summary: dict[str, object] = {
        "runtime_ledger_bucket_count": 1,
        "runtime_ledger_fill_count": 4,
        "runtime_ledger_closed_trade_count": 300,
        "runtime_ledger_closed_round_trip_count": 300,
        "runtime_ledger_open_position_count": 0,
        "runtime_ledger_filled_notional": filled_notional,
        "runtime_ledger_cost_amount": "1250",
        "runtime_ledger_cost_basis_counts": {
            "alpaca_2026_equity_fee_schedule": 300,
        },
        "runtime_ledger_cost_model_hash_count": 1,
        "runtime_ledger_net_strategy_pnl_after_costs": net_pnl,
        "runtime_ledger_post_cost_expectancy_bps": expectancy_bps,
        "runtime_ledger_observed_trading_day_count": trading_days,
        "runtime_ledger_schema_versions": ["torghut.runtime-ledger-bucket.v1"],
        "runtime_ledger_source_authority_bucket_count": 1,
        "runtime_ledger_source_authority_blockers": [],
        "runtime_ledger_authority_blockers": [],
    }
    if avg_daily_filled_notional is not None:
        runtime_ledger_summary["runtime_ledger_avg_daily_filled_notional"] = (
            avg_daily_filled_notional
        )
    if median_daily_net_pnl is not None:
        runtime_ledger_summary["runtime_ledger_median_daily_net_pnl_after_costs"] = (
            median_daily_net_pnl
        )
    if p10_daily_net_pnl is not None:
        runtime_ledger_summary["runtime_ledger_p10_daily_net_pnl_after_costs"] = (
            p10_daily_net_pnl
        )
    if worst_day_net_pnl is not None:
        runtime_ledger_summary["runtime_ledger_worst_day_net_pnl_after_costs"] = (
            worst_day_net_pnl
        )
    if max_intraday_drawdown is not None:
        runtime_ledger_summary["runtime_ledger_max_intraday_drawdown"] = (
            max_intraday_drawdown
        )
    if drawdown_pct is not None:
        runtime_ledger_summary["runtime_ledger_max_drawdown_pct_equity"] = drawdown_pct
    if best_day_share is not None:
        runtime_ledger_summary["runtime_ledger_best_day_share"] = best_day_share
    if symbol_concentration_share is not None:
        runtime_ledger_summary["runtime_ledger_symbol_concentration_share"] = (
            symbol_concentration_share
        )
    if summary_overrides:
        runtime_ledger_summary.update(summary_overrides)
    return {
        "doc_id": "doc29",
        "summary": {"all_satisfied": status == "satisfied"},
        "gates": [
            {
                "gate_id": packet.DOC29_LIVE_SCALE_GATE,
                "status": status,
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "runtime_ledger_summary": runtime_ledger_summary,
                "db_row_refs": {
                    "strategy_runtime_ledger_buckets": ledger_refs
                    if ledger_refs is not None
                    else ["strategy-runtime-ledger-buckets:H-PAIRS-01:2026-05-26"],
                    "runtime_ledger_unbacked_hypothesis_metric_windows": unbacked_refs
                    if unbacked_refs is not None
                    else [],
                },
            }
        ],
    }


def _hpairs_source_proof_census(
    *,
    blockers: list[str] | None = None,
    final_authority_ok: bool = True,
) -> dict[str, object]:
    blocker_list = blockers or []
    return {
        "schema_version": "torghut.hpairs-source-proof-census.v1",
        "identity": {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "account_label": "TORGHUT_SIM",
            "observed_stage": "paper",
        },
        "window": {
            "started_at": "2026-05-01T14:00:00+00:00",
            "ended_at": "2026-05-29T21:00:00+00:00",
        },
        "source": {
            "kind": "fixture_json",
            "read_only": True,
            "writes_proof": False,
            "modifies_rows": False,
            "runtime_stage": "paper",
            "replay_outputs_count_as_runtime_proof": False,
            "synthetic_proof_created": False,
        },
        "runtime_authority": {
            "final_authority_ok": final_authority_ok,
            "blockers": blocker_list,
            "aggregate": {},
        },
        "missing_requirement_categories": {
            "submitted_orders": "submitted_orders_missing" in blocker_list,
        },
        "missing_source_ref_categories": {},
        "blocker_ladder": [
            {
                "step": "submitted_orders_present",
                "status": "blocked" if blocker_list else "pass",
                "blocker_codes": blocker_list,
                "next_action": (
                    "route selected H-PAIRS decisions as submitted paper/live orders "
                    "before proof review"
                )
                if blocker_list
                else None,
            }
        ],
        "blockers": blocker_list,
        "verdict": {
            "classification": "authority_candidate_ready"
            if not blocker_list
            else "lifecycle_missing",
            "authority_candidate_ready": not blocker_list,
            "next_blocker": None
            if not blocker_list
            else {
                "step": "submitted_orders_present",
                "status": "blocked",
                "blocker_codes": blocker_list,
                "next_action": (
                    "route selected H-PAIRS decisions as submitted paper/live orders "
                    "before proof review"
                ),
            },
            "next_action": (
                "assemble authority proof packet from the same source-backed runtime rows"
            )
            if not blocker_list
            else (
                "materialize linked decisions, executions, order events, fills, "
                "and closed round trips"
            ),
        },
        "totals": {"runtime_submitted_order_count": 0 if blocker_list else 20},
    }


class _TestRuntimeLedgerProofPacketBase(TestCase):
    pass


__all__: tuple[str, ...] = (
    "Any",
    "Decimal",
    "HTTPError",
    "Namespace",
    "Path",
    "TestCase",
    "_DEFAULT_TIGERBEETLE_LEDGER",
    "_FakeObjectStoreClient",
    "_IncompleteReceiptObjectStoreClient",
    "_TestRuntimeLedgerProofPacketBase",
    "_completion",
    "_hpairs_source_proof_census",
    "_paper_route_evidence",
    "_proofs_payload",
    "_runtime_import",
    "_status",
    "_tigerbeetle_ledger_status",
    "cast",
    "io",
    "json",
    "os",
    "packet",
    "patch",
    "tempfile",
)
