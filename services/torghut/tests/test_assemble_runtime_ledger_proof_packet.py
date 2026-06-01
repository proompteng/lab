from __future__ import annotations

import json
import os
import tempfile
from argparse import Namespace
from decimal import Decimal
from pathlib import Path
from typing import Any, cast
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


def _status(
    *,
    blockers: list[str] | None = None,
    tigerbeetle_ledger: dict[str, object] | None = None,
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
    if tigerbeetle_ledger is not None:
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
                "runner": "scripts/renew_latest_empirical_promotion_jobs.py",
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


def _runtime_import(
    *,
    proof_status: str = "ok",
    proof_blockers: list[str] | None = None,
    authoritative: bool = True,
    materialization_target: bool = True,
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
            "authority_reason": "runtime_ledger_profit_proof_present"
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
) -> dict[str, object]:
    runtime_ledger_summary: dict[str, object] = {
        "runtime_ledger_bucket_count": 1,
        "runtime_ledger_fill_count": 4,
        "runtime_ledger_closed_trade_count": 2,
        "runtime_ledger_filled_notional": filled_notional,
        "runtime_ledger_net_strategy_pnl_after_costs": net_pnl,
        "runtime_ledger_post_cost_expectancy_bps": expectancy_bps,
        "runtime_ledger_observed_trading_day_count": trading_days,
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


class TestRuntimeLedgerProofPacket(TestCase):
    def test_scalar_normalizers_handle_runtime_json_variants(self) -> None:
        self.assertTrue(packet._bool(Decimal("1")))
        self.assertFalse(packet._bool(0))
        self.assertTrue(packet._bool("allowed"))
        self.assertFalse(packet._bool(object()))

        self.assertEqual(packet._int(True), 1)
        self.assertEqual(packet._int(4.9), 4)
        self.assertEqual(packet._int(Decimal("7")), 7)
        self.assertEqual(packet._int("8.0"), 8)
        self.assertEqual(packet._int("bad", default=-1), -1)

        self.assertEqual(packet._decimal(Decimal("12.5")), Decimal("12.5"))
        self.assertIsNone(packet._decimal("not-a-number"))

    def test_ceph_client_from_env_uses_direct_empirical_endpoint(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TORGHUT_EMPIRICAL_CEPH_ENDPOINT": "https://rgw.torghut.internal/",
                "TORGHUT_EMPIRICAL_CEPH_ACCESS_KEY": "direct-access",
                "TORGHUT_EMPIRICAL_CEPH_SECRET_KEY": "direct-secret",
                "TORGHUT_EMPIRICAL_CEPH_BUCKET": "direct-bucket",
                "TORGHUT_EMPIRICAL_CEPH_REGION": "us-west-2",
                "TORGHUT_EMPIRICAL_CEPH_TIMEOUT_SECONDS": "35",
            },
            clear=True,
        ):
            client, bucket = packet._ceph_client_from_env()

        self.assertEqual(bucket, "direct-bucket")
        self.assertIsNotNone(client)
        assert client is not None
        concrete_client = cast(Any, client)
        self.assertEqual(concrete_client.endpoint, "https://rgw.torghut.internal")
        self.assertEqual(concrete_client.access_key, "direct-access")
        self.assertEqual(concrete_client.secret_key, "direct-secret")
        self.assertEqual(concrete_client.region, "us-west-2")
        self.assertEqual(concrete_client.timeout_seconds, 35)

    def test_ceph_client_from_env_uses_bucket_host_fallbacks(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TORGHUT_EMPIRICAL_CEPH_BUCKET_HOST": "rook-ceph-rgw",
                "TORGHUT_EMPIRICAL_CEPH_BUCKET_PORT": "8080",
                "TORGHUT_EMPIRICAL_CEPH_USE_TLS": "true",
                "AWS_ACCESS_KEY_ID": "aws-access",
                "AWS_SECRET_ACCESS_KEY": "aws-secret",
                "BUCKET_NAME": "fallback-bucket",
                "TORGHUT_EMPIRICAL_CEPH_TIMEOUT_SECONDS": "0",
            },
            clear=True,
        ):
            client, bucket = packet._ceph_client_from_env()

        self.assertEqual(bucket, "fallback-bucket")
        self.assertIsNotNone(client)
        assert client is not None
        concrete_client = cast(Any, client)
        self.assertEqual(concrete_client.endpoint, "https://rook-ceph-rgw:8080")
        self.assertEqual(concrete_client.access_key, "aws-access")
        self.assertEqual(concrete_client.secret_key, "aws-secret")
        self.assertEqual(concrete_client.region, "us-east-1")
        self.assertEqual(concrete_client.timeout_seconds, 1)

    def test_ceph_client_from_env_returns_bucket_without_credentials(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TORGHUT_EMPIRICAL_CEPH_BUCKET_HOST": "rook-ceph-rgw",
                "TORGHUT_EMPIRICAL_CEPH_BUCKET": "configured-bucket",
            },
            clear=True,
        ):
            client, bucket = packet._ceph_client_from_env()

        self.assertIsNone(client)
        self.assertEqual(bucket, "configured-bucket")

    def test_resolve_artifact_prefix_defaults_missing_runtime_run_id(self) -> None:
        self.assertEqual(
            packet._resolve_artifact_prefix(
                "runtime-ledger-proof-packets/{run_id}/{generated_at}",
                runtime_window_import=None,
                generated_at="2026-05-26T21:30:00+00:00",
            ),
            "runtime-ledger-proof-packets/unknown-run/2026-05-26T21-30-00-00-00",
        )

    def test_packet_allows_only_complete_post_cost_runtime_ledger_proof(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["schema_version"], packet.SCHEMA_VERSION)
        self.assertEqual(result["verdict"], "promotion_authority_allowed")
        self.assertEqual(result["promotion_authority"]["blocking_reasons"], [])
        self.assertEqual(result["candidate"]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(
            result["checks"]["runtime_ledger_post_cost_profit_target"]["observed"][
                "daily_net_pnl_after_costs"
            ],
            "500",
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_risk_quality"]["observed"][
                "drawdown_pct_equity"
            ],
            "0.02",
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_daily_distribution_authority"]["observed"][
                "median_daily_net_pnl_after_costs"
            ],
            "500",
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_target_implied_scale"]["observed"][
                "target_implied_avg_daily_filled_notional"
            ],
            "384615.3846153846153846153846",
        )
        self.assertEqual(
            result["target"]["max_runtime_ledger_drawdown_pct_equity"],
            "0.03",
        )
        self.assertEqual(
            result["target"]["min_runtime_ledger_median_daily_net_pnl_after_costs"],
            "250",
        )
        self.assertEqual(
            result["target"]["max_runtime_ledger_intraday_drawdown"], "1500"
        )
        self.assertEqual(
            result["target"]["target_implied_avg_daily_filled_notional"],
            "384615.3846153846153846153846",
        )
        self.assertEqual(result["proof_mode"], "authority")
        self.assertTrue(result["final_authority_ok"])
        self.assertFalse(result["evidence_collection_only"])
        tigerbeetle_refs = result["evidence"]["runtime_window_import"][
            "materialization"
        ]["materialized_targets"][0]["tigerbeetle"]
        self.assertEqual(
            tigerbeetle_refs["schema_version"],
            "torghut.tigerbeetle-runtime-ledger-proof-refs.v1",
        )
        self.assertEqual(tigerbeetle_refs["transfer_count"], 1)
        self.assertEqual(
            tigerbeetle_refs["source_refs"],
            [
                "postgres:tigerbeetle_account_refs",
                "postgres:tigerbeetle_transfer_refs",
            ],
        )

    def test_packet_prefers_importable_paper_route_plan_over_next_session_plan(
        self,
    ) -> None:
        evidence = _paper_route_evidence()
        import_plan = cast(
            dict[str, object],
            evidence["next_paper_route_runtime_window_targets"],
        )
        import_plan["purpose"] = (
            "latest_closed_session_paper_route_runtime_window_import"
        )
        evidence["runtime_window_import_plan"] = import_plan
        evidence["next_paper_route_runtime_window_targets"] = {
            "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
            "target_count": 1,
            "purpose": "next_session_paper_route_runtime_window_evidence_collection",
            "session_readiness": {
                "import_ready": False,
                "import_blockers": ["paper_route_session_window_not_open"],
            },
            "runtime_window_import_handoff": {
                "import_ready": False,
                "import_blockers": ["paper_route_session_window_not_open"],
            },
            "targets": [
                {
                    "candidate_id": "future-candidate",
                    "hypothesis_id": "H-FUTURE",
                    "observed_stage": "paper",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "strategy_name": "future-paper-route-candidate",
                    "account_label": "TORGHUT_SIM",
                    "source_manifest_ref": "config/trading/hypotheses/h-future.json",
                    "window_start": "2026-05-27T13:30:00+00:00",
                    "window_end": "2026-05-27T20:00:00+00:00",
                    "dependency_quorum_decision": "allow",
                    "continuity_ok": "true",
                    "drift_ok": "true",
                    "runtime_window_import_health_gate": {
                        "dependency_quorum_decision": "allow",
                        "continuity_ok": "true",
                        "drift_ok": "true",
                        "blockers": [],
                    },
                }
            ],
        }

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=evidence,
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["evidence"]["paper_route_target_plan"]["session_window"]["start"],
            "2026-05-26T13:30:00+00:00",
        )
        self.assertEqual(
            result["candidate"]["candidate_id"],
            "c88421d619759b2cfaa6f4d0",
        )

    def test_authority_packet_allows_reconciled_tigerbeetle_runtime_refs(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(tigerbeetle_ledger=_tigerbeetle_ledger_status()),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["promotion_authority"]["allowed"], result)
        check = result["checks"]["tigerbeetle_runtime_pnl_authority_refs"]
        self.assertTrue(check["passed"], check)
        self.assertTrue(check["observed"]["required_for_authority"])
        self.assertEqual(check["observed"]["runtime_ledger_signed_transfer_count"], 1)

    def test_authority_packet_blocks_claimed_tigerbeetle_without_signed_refs(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(
                tigerbeetle_ledger=_tigerbeetle_ledger_status(
                    runtime_ledger_ref_count=1,
                    signed_ref_count=0,
                )
            ),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["promotion_authority"]["allowed"])
        self.assertIn(
            "tigerbeetle_runtime_ledger_signed_refs_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "tigerbeetle_runtime_pnl_authority_refs",
            result["promotion_authority"]["failed_checks"],
        )

    def test_authority_packet_requires_daily_distribution_and_scale(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(
                avg_daily_filled_notional="200000",
                median_daily_net_pnl="200",
                p10_daily_net_pnl="-300",
                worst_day_net_pnl="-800",
                max_intraday_drawdown="1600",
            ),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["final_authority_ok"])
        daily_blockers = result["checks"][
            "runtime_ledger_daily_distribution_authority"
        ]["blockers"]
        self.assertIn(
            "runtime_ledger_median_daily_net_pnl_after_costs_below_floor",
            daily_blockers,
        )
        self.assertIn(
            "runtime_ledger_p10_daily_net_pnl_after_costs_below_floor",
            daily_blockers,
        )
        self.assertIn(
            "runtime_ledger_worst_day_net_pnl_after_costs_below_floor",
            daily_blockers,
        )
        self.assertIn(
            "runtime_ledger_avg_daily_filled_notional_below_target_implied_floor",
            result["checks"]["runtime_ledger_target_implied_scale"]["blockers"],
        )
        self.assertIn(
            "runtime_ledger_max_intraday_drawdown_above_limit",
            result["checks"]["runtime_ledger_risk_quality"]["blockers"],
        )
        self.assertEqual(result["verdict"], "blocked")

    def test_authority_packet_requires_daily_distribution_fields(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(
                avg_daily_filled_notional=None,
                median_daily_net_pnl=None,
                p10_daily_net_pnl=None,
                worst_day_net_pnl=None,
                max_intraday_drawdown=None,
            ),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "runtime_ledger_median_daily_net_pnl_after_costs_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_p10_daily_net_pnl_after_costs_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_worst_day_net_pnl_after_costs_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_avg_daily_filled_notional_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_max_intraday_drawdown_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_smoke_packet_cannot_grant_promotion_authority(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="smoke",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertFalse(result["final_authority_ok"])
        self.assertEqual(result["proof_mode"], "smoke")
        self.assertEqual(
            result["verdict"],
            "smoke_proof_satisfied_evidence_collection_only",
        )
        self.assertFalse(result["promotion_authority"]["allowed"])
        self.assertEqual(
            result["target"]["max_runtime_ledger_drawdown_pct_equity"], "0.08"
        )
        self.assertEqual(
            result["target"]["max_runtime_ledger_symbol_concentration_share"],
            "0.5",
        )
        self.assertIn(
            "runtime_ledger_proof_mode_not_authority",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "rerun_proof_packet_in_authority_mode",
            result["required_actions"],
        )

    def test_packet_splits_post_cost_proof_from_capital_promotion_gate(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(
                blockers=[
                    "simple_submit_disabled",
                    "order_feed_lifecycle_disabled",
                    "promotion_decision_not_allowed",
                    "promotion_certificate_shadow_only",
                ]
            ),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["verdict"],
            "post_cost_proof_authority_allowed_capital_promotion_blocked",
        )
        self.assertTrue(result["post_cost_proof_authority"]["allowed"])
        self.assertEqual(result["post_cost_proof_authority"]["blocking_reasons"], [])
        self.assertFalse(result["capital_promotion_authority"]["allowed"])
        self.assertEqual(
            result["capital_promotion_authority"]["blocking_reasons"],
            [
                "simple_submit_disabled",
                "order_feed_lifecycle_disabled",
                "promotion_decision_not_allowed",
                "promotion_certificate_shadow_only",
            ],
        )
        self.assertFalse(result["promotion_authority"]["allowed"])
        self.assertEqual(
            result["promotion_authority"]["failed_checks"],
            ["capital_promotion_gate"],
        )
        self.assertEqual(
            result["checks"]["live_status_gate"]["observed"]["proof_blockers"],
            [],
        )
        self.assertEqual(
            result["checks"]["live_status_gate"]["observed"][
                "capital_promotion_blockers"
            ],
            [
                "simple_submit_disabled",
                "order_feed_lifecycle_disabled",
                "promotion_decision_not_allowed",
                "promotion_certificate_shadow_only",
            ],
        )
        self.assertIn(
            "keep_promotion_blocked_until_live_gate_and_proof_floor_pass",
            result["required_actions"],
        )

    def test_packet_splits_post_cost_proof_from_paper_route_promotion_gate(
        self,
    ) -> None:
        evidence = _paper_route_evidence()
        plan = evidence["next_paper_route_runtime_window_targets"]
        assert isinstance(plan, dict)
        target = plan["targets"][0]
        assert isinstance(target, dict)
        target["drift_ok"] = "false"
        target["drift_reason"] = "drift_live_promotion_ineligible"
        target["runtime_window_import_health_gate"] = {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "dependency_quorum_decision": "allow",
            "continuity_ok": "true",
            "drift_ok": "false",
            "drift_reason": "drift_live_promotion_ineligible",
            "blockers": [],
            "promotion_blockers": ["drift_checks_not_ok"],
        }
        target["runtime_window_import_health_gate_blockers"] = []

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=evidence,
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["post_cost_proof_authority"]["allowed"], result)
        self.assertEqual(result["post_cost_proof_authority"]["blocking_reasons"], [])
        self.assertEqual(
            result["verdict"],
            "post_cost_proof_authority_allowed_capital_promotion_blocked",
        )
        self.assertFalse(result["capital_promotion_authority"]["allowed"])
        self.assertEqual(
            result["capital_promotion_authority"]["blocking_reasons"],
            ["drift_checks_not_ok"],
        )
        self.assertFalse(result["promotion_authority"]["allowed"])
        self.assertEqual(
            result["promotion_authority"]["failed_checks"],
            ["paper_route_promotion_health_gate"],
        )
        self.assertIn(
            "drift_checks_not_ok",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_cli_uploads_durable_proof_packet_artifact_with_runtime_run_id(
        self,
    ) -> None:
        fake_client = _FakeObjectStoreClient()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            status_path = root / "status.json"
            paper_path = root / "paper.json"
            runtime_path = root / "runtime.json"
            completion_path = root / "completion.json"
            output_path = root / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")
            runtime_path.write_text(
                json.dumps(
                    {
                        "run_id": "sim-2026-05-05-chip-renew-20260526T212300Z",
                        "manifest_path": (
                            "/tmp/torghut-empirical-renewal/"
                            "sim-2026-05-05-chip-renew-20260526T212300Z/"
                            "empirical-promotion-manifest.yaml"
                        ),
                        "output_dir": (
                            "/tmp/torghut-empirical-renewal/"
                            "sim-2026-05-05-chip-renew-20260526T212300Z"
                        ),
                        "status": "ok",
                        "empirical_promotion": {"status": "ok"},
                        "runtime_window_import": _runtime_import(),
                    }
                ),
                encoding="utf-8",
            )
            completion_path.write_text(json.dumps(_completion()), encoding="utf-8")

            with patch.object(
                packet,
                "_ceph_client_from_env",
                return_value=(fake_client, "torghut-empirical-artifacts"),
            ):
                exit_code = packet.main(
                    [
                        "--status-file",
                        str(status_path),
                        "--paper-route-evidence-file",
                        str(paper_path),
                        "--runtime-window-import-file",
                        str(runtime_path),
                        "--completion-file",
                        str(completion_path),
                        "--proof-mode",
                        "authority",
                        "--output-file",
                        str(output_path),
                        "--generated-at",
                        "2026-05-26T21:30:00+00:00",
                        "--artifact-prefix",
                        "runtime-ledger-proof-packets/{run_id}",
                        "--artifact-name",
                        "authority-packet.json",
                        "--require-artifact-upload",
                    ]
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(len(fake_client.uploads), 1)
            upload = fake_client.uploads[0]
            self.assertEqual(upload["bucket"], "torghut-empirical-artifacts")
            self.assertEqual(
                upload["key"],
                "runtime-ledger-proof-packets/"
                "sim-2026-05-05-chip-renew-20260526T212300Z/"
                "authority-packet.json",
            )
            uploaded_payload = json.loads(cast(bytes, upload["body"]).decode("utf-8"))
            local_payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(uploaded_payload, local_payload)
            self.assertEqual(
                local_payload["artifact"]["runtime_window_import_run_id"],
                "sim-2026-05-05-chip-renew-20260526T212300Z",
            )
            self.assertEqual(
                local_payload["artifact"]["prefix"],
                "runtime-ledger-proof-packets/"
                "sim-2026-05-05-chip-renew-20260526T212300Z",
            )
            self.assertEqual(
                local_payload["artifact"]["uri"],
                "s3://torghut-empirical-artifacts/"
                "runtime-ledger-proof-packets/"
                "sim-2026-05-05-chip-renew-20260526T212300Z/"
                "authority-packet.json",
            )
            self.assertTrue(local_payload["artifact"]["uploaded"])
            self.assertTrue(local_payload["artifact"]["upload_required"])
            lineage = local_payload["evidence"]["runtime_window_import"]["lineage"]
            self.assertEqual(
                lineage["run_id"],
                "sim-2026-05-05-chip-renew-20260526T212300Z",
            )
            self.assertEqual(lineage["status"], "ok")
            self.assertEqual(lineage["empirical_promotion_status"], "ok")
            self.assertEqual(
                lineage["manifest_path"],
                "/tmp/torghut-empirical-renewal/"
                "sim-2026-05-05-chip-renew-20260526T212300Z/"
                "empirical-promotion-manifest.yaml",
            )
            self.assertEqual(
                lineage["output_dir"],
                "/tmp/torghut-empirical-renewal/"
                "sim-2026-05-05-chip-renew-20260526T212300Z",
            )
            self.assertTrue(lineage["nested_runtime_window_import_present"])
            self.assertEqual(lineage["runtime_window_import_item_count"], 1)

    def test_cli_fails_closed_when_required_artifact_upload_is_not_configured(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            status_path = root / "status.json"
            paper_path = root / "paper.json"
            output_path = root / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(
                json.dumps(
                    _paper_route_evidence(
                        import_ready=False,
                        import_blockers=["paper_route_session_window_not_open"],
                    )
                ),
                encoding="utf-8",
            )

            with patch.object(
                packet,
                "_ceph_client_from_env",
                return_value=(None, "torghut-empirical-artifacts"),
            ):
                with self.assertRaisesRegex(
                    SystemExit,
                    "runtime_ledger_proof_artifact_upload_not_configured",
                ):
                    packet.main(
                        [
                            "--status-file",
                            str(status_path),
                            "--paper-route-evidence-file",
                            str(paper_path),
                            "--output-file",
                            str(output_path),
                            "--artifact-prefix",
                            "runtime-ledger-proof-packets/{run_id}",
                            "--require-artifact-upload",
                            "--allow-blocked-exit-zero",
                        ]
                    )

            self.assertFalse(output_path.exists())

    def test_packet_waits_before_paper_route_window_is_importable(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=False,
                import_blockers=["paper_route_session_window_not_open"],
            ),
            generated_at="2026-05-25T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "waiting_for_runtime_window")
        self.assertEqual(
            result["promotion_authority"]["blocking_reasons"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(
            result["required_actions"],
            ["wait_for_regular_session_runtime_window"],
        )
        self.assertFalse(
            result["checks"]["runtime_window_import_proof"]["observed"][
                "runtime_import_due"
            ]
        )

    def test_waiting_packet_prioritizes_wait_action_over_drift_repair(
        self,
    ) -> None:
        evidence = _paper_route_evidence(
            import_ready=False,
            import_blockers=["paper_route_session_window_not_open"],
        )
        plan = evidence["next_paper_route_runtime_window_targets"]
        assert isinstance(plan, dict)
        target = plan["targets"][0]
        assert isinstance(target, dict)
        target["drift_ok"] = "false"
        target["drift_reason"] = "drift_live_promotion_ineligible"
        target["runtime_window_import_health_gate"] = {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "dependency_quorum_decision": "allow",
            "continuity_ok": "true",
            "drift_ok": "false",
            "drift_reason": "drift_live_promotion_ineligible",
            "blockers": [],
            "promotion_blockers": ["drift_checks_not_ok"],
        }
        target["runtime_window_import_health_gate_blockers"] = []

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=evidence,
            generated_at="2026-05-25T21:05:00+00:00",
        )

        self.assertEqual(result["verdict"], "waiting_for_runtime_window")
        self.assertIn(
            "drift_checks_not_ok",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertEqual(
            result["required_actions"],
            ["wait_for_regular_session_runtime_window"],
        )
        self.assertNotIn(
            "repair_runtime_window_import_health_gate",
            result["required_actions"],
        )

    def test_waiting_packet_defers_doc29_completion_blockers_until_import_due(
        self,
    ) -> None:
        completion = _completion(status="blocked")
        gate = completion["gates"][0]
        assert isinstance(gate, dict)
        gate["blocking_reasons"] = ["live_scale_runtime_ledger_summary_incomplete"]
        gate["blocked_reason"] = "live_canary_not_satisfied"

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=False,
                import_blockers=["paper_route_session_window_not_open"],
            ),
            completion_status=completion,
            generated_at="2026-05-25T21:05:00+00:00",
        )

        self.assertEqual(result["verdict"], "waiting_for_runtime_window")
        self.assertEqual(
            result["post_cost_proof_authority"]["blocking_reasons"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(
            result["required_actions"],
            ["wait_for_regular_session_runtime_window"],
        )
        self.assertEqual(
            result["checks"]["doc29_live_scale_gate"]["status"],
            "deferred_until_paper_route_runtime_window_import_is_due",
        )
        self.assertEqual(
            result["checks"]["doc29_live_scale_gate"]["observed"]["blockers"],
            [
                "live_scale_runtime_ledger_summary_incomplete",
                "live_canary_not_satisfied",
            ],
        )
        self.assertNotIn(
            "live_canary_not_satisfied",
            result["post_cost_proof_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_with_source_activity_audit_before_generic_import_missing(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=True,
                import_audit={
                    "schema_version": (
                        "torghut.paper-route-runtime-window-import-audit.v1"
                    ),
                    "state": "import_due_source_activity_missing",
                    "next_action": "inspect_paper_route_source_activity_before_import",
                    "import_ready": True,
                    "blockers": [
                        "paper_route_source_activity_missing",
                        "source_decisions_missing",
                        "source_executions_missing",
                        "source_tca_missing",
                    ],
                    "target_blockers": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "c88421d619759b2cfaa6f4d0",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                            "blockers": [
                                "source_decisions_missing",
                                "runtime_ledger_bucket_missing",
                            ],
                        }
                    ],
                    "counts": {
                        "source_plan_target_count": 1,
                        "next_runtime_window_target_count": 1,
                        "targets_with_source_activity": 0,
                        "targets_with_runtime_ledger": 0,
                        "targets_with_evidence_grade_runtime_ledger": 0,
                        "targets_with_promotion_decision": 0,
                    },
                },
            ),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "paper_route_source_activity",
            result["promotion_authority"]["failed_checks"],
        )
        self.assertIn(
            "paper_route_source_activity_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "source_decisions_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "inspect_paper_route_source_activity_before_import",
            result["required_actions"],
        )
        self.assertEqual(
            result["checks"]["runtime_window_import_proof"]["observed"][
                "import_audit_state"
            ],
            "import_due_source_activity_missing",
        )
        self.assertEqual(
            result["evidence"]["paper_route_runtime_window_import_audit"]["state"],
            "import_due_source_activity_missing",
        )
        self.assertEqual(
            result["evidence"]["paper_route_runtime_window_import_audit"][
                "target_blockers"
            ][0]["candidate_id"],
            "c88421d619759b2cfaa6f4d0",
        )
        self.assertEqual(
            result["checks"]["paper_route_runtime_window_import_audit"]["observed"][
                "target_blockers"
            ][0]["paper_route_probe_symbols"],
            ["AAPL", "AMZN"],
        )

    def test_packet_requires_import_audit_when_paper_route_import_is_due(
        self,
    ) -> None:
        paper = _paper_route_evidence(import_ready=True)
        paper.pop("runtime_window_import_audit")

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=paper,
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "runtime_window_import_audit_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "inspect_paper_route_evidence_audit",
            result["required_actions"],
        )

    def test_packet_blocks_when_paper_route_import_health_gate_is_not_ready(
        self,
    ) -> None:
        evidence = _paper_route_evidence(import_ready=True)
        plan = evidence["next_paper_route_runtime_window_targets"]
        assert isinstance(plan, dict)
        target = plan["targets"][0]
        assert isinstance(target, dict)
        target["dependency_quorum_decision"] = "missing"
        target["continuity_ok"] = "false"
        target["runtime_window_import_health_gate"] = {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "dependency_quorum_decision": "missing",
            "continuity_ok": "false",
            "drift_ok": "true",
            "blockers": ["dependency_quorum_not_allow", "continuity_not_ok"],
        }
        target["runtime_window_import_health_gate_blockers"] = [
            "dependency_quorum_not_allow",
            "continuity_not_ok",
        ]

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=evidence,
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "paper_route_import_health_gate",
            result["promotion_authority"]["failed_checks"],
        )
        self.assertIn(
            "dependency_quorum_not_allow",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "repair_runtime_window_import_health_gate",
            result["required_actions"],
        )
        health_gate = result["evidence"]["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertEqual(health_gate["ready_target_count"], 0)
        self.assertEqual(health_gate["blocked_target_count"], 1)

    def test_packet_treats_drift_only_as_promotion_not_import_blocker(self) -> None:
        evidence = _paper_route_evidence(import_ready=True)
        plan = evidence["next_paper_route_runtime_window_targets"]
        assert isinstance(plan, dict)
        target = plan["targets"][0]
        assert isinstance(target, dict)
        target["continuity_reason"] = "signal_continuity_nominal"
        target["drift_ok"] = "false"
        target["drift_reason"] = "drift_live_promotion_ineligible"
        target["runtime_window_import_health_gate"] = {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "dependency_quorum_decision": "allow",
            "continuity_ok": "true",
            "continuity_reason": "signal_continuity_nominal",
            "drift_ok": "false",
            "drift_reason": "drift_live_promotion_ineligible",
            "blockers": [],
            "promotion_blockers": [],
        }
        target["runtime_window_import_health_gate_blockers"] = []

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=evidence,
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["post_cost_proof_authority"]["allowed"], result)
        self.assertFalse(result["promotion_authority"]["allowed"], result)
        self.assertFalse(result["capital_promotion_authority"]["allowed"], result)
        self.assertIn(
            "paper_route_promotion_health_gate",
            result["promotion_authority"]["failed_checks"],
        )
        self.assertIn(
            "drift_not_ok",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "repair_runtime_window_import_health_gate",
            result["required_actions"],
        )
        health_gate = result["evidence"]["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertTrue(health_gate["ready"])
        self.assertEqual(health_gate["ready_target_count"], 1)
        self.assertEqual(health_gate["blocked_target_count"], 0)
        self.assertEqual(health_gate["blockers"], [])
        self.assertEqual(health_gate["promotion_blockers"], ["drift_not_ok"])
        self.assertEqual(
            health_gate["continuity_reasons"], ["signal_continuity_nominal"]
        )
        self.assertEqual(
            health_gate["drift_reasons"], ["drift_live_promotion_ineligible"]
        )
        self.assertEqual(
            health_gate["targets"][0]["drift_reason"],
            "drift_live_promotion_ineligible",
        )

    def test_packet_blocks_non_authoritative_import_and_weak_daily_profit(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(
                proof_status="blocked",
                proof_blockers=["runtime_without_runtime_ledger_profit_proof"],
                authoritative=False,
            ),
            completion_status=_completion(net_pnl="600", trading_days=3),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "runtime_without_runtime_ledger_profit_proof",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_daily_net_pnl_below_target",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_missing_runtime_ledger_risk_quality_when_import_due(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(
                drawdown_pct=None,
                best_day_share=None,
                symbol_concentration_share=None,
            ),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "runtime_ledger_risk_quality",
            result["promotion_authority"]["failed_checks"],
        )
        self.assertIn(
            "runtime_ledger_drawdown_pct_equity_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_best_day_share_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_symbol_concentration_share_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "improve_runtime_ledger_drawdown_concentration_or_position_sizing",
            result["required_actions"],
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_risk_quality"]["observed"][
                "drawdown_pct_equity"
            ],
            None,
        )

    def test_packet_blocks_excessive_runtime_ledger_risk_quality(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(
                drawdown_pct="0.13",
                best_day_share="0.40",
                symbol_concentration_share="0.75",
            ),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "runtime_ledger_drawdown_pct_equity_above_limit",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_best_day_share_above_limit",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_symbol_concentration_share_above_limit",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_risk_quality"]["expected"],
            {
                "max_drawdown_pct_equity": "0.03",
                "max_intraday_drawdown": "1500",
                "max_best_day_share": "0.25",
                "max_symbol_concentration_share": "0.35",
            },
        )

    def test_packet_blocks_incomplete_identity_unbacked_refs_and_lifecycle_gaps(
        self,
    ) -> None:
        paper = _paper_route_evidence()
        target = paper["next_paper_route_runtime_window_targets"]["targets"][0]
        assert isinstance(target, dict)
        target["candidate_id"] = ""
        completion = _completion(
            status="blocked",
            net_pnl="bad",
            trading_days=0,
            expectancy_bps="0",
            ledger_refs=[],
            unbacked_refs=["hypothesis_metric_windows:H-PAIRS-01:2026-05-26"],
        )
        gate = completion["gates"][0]
        assert isinstance(gate, dict)
        gate["blocking_reasons"] = ["live_scale_runtime_ledger_summary_incomplete"]
        gate["blocked_reason"] = "live_canary_not_satisfied"
        summary = gate["runtime_ledger_summary"]
        assert isinstance(summary, dict)
        summary["runtime_ledger_bucket_count"] = 0
        summary["runtime_ledger_fill_count"] = 0
        summary["runtime_ledger_closed_trade_count"] = 0
        summary["runtime_ledger_filled_notional"] = "0"

        result = packet.build_runtime_ledger_proof_packet(
            _status(blockers=["simple_submit_disabled"]),
            paper_route_evidence=paper,
            runtime_window_import={"runtime_window_import": _runtime_import()},
            completion_status=completion,
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        blockers = result["promotion_authority"]["blocking_reasons"]
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn("simple_submit_disabled", blockers)
        self.assertIn("paper_route_target_identity_incomplete", blockers)
        self.assertIn("live_scale_runtime_ledger_summary_incomplete", blockers)
        self.assertIn("live_canary_not_satisfied", blockers)
        self.assertIn("runtime_ledger_db_refs_missing_or_unbacked", blockers)
        self.assertIn("runtime_ledger_bucket_count_zero", blockers)
        self.assertIn("runtime_ledger_fill_count_zero", blockers)
        self.assertIn("runtime_ledger_closed_trade_count_zero", blockers)
        self.assertIn("runtime_ledger_filled_notional_missing", blockers)
        self.assertIn("runtime_ledger_post_cost_expectancy_not_positive", blockers)
        self.assertIn("runtime_ledger_net_pnl_below_target", blockers)
        self.assertIn("runtime_ledger_trading_days_below_target", blockers)
        self.assertIn("runtime_ledger_daily_net_pnl_below_target", blockers)
        self.assertIn(
            "keep_promotion_blocked_until_live_gate_and_proof_floor_pass",
            result["required_actions"],
        )
        self.assertIn(
            "repair_runtime_ledger_lifecycle_cost_or_lineage_evidence",
            result["required_actions"],
        )
        self.assertIn(
            "collect_or_improve_post_cost_runtime_profit_evidence",
            result["required_actions"],
        )

    def test_packet_surfaces_runtime_import_materialization_summary(self) -> None:
        runtime_import = _runtime_import()
        observation = runtime_import["imports"][0]["summary"]["runtime_observation"]
        assert isinstance(observation, dict)
        observation.update(
            {
                "runtime_ledger_tca_row_count": 2,
                "runtime_ledger_tca_runtime_bucket_row_count": 1,
                "runtime_ledger_tca_profit_proof_count": 1,
                "runtime_ledger_tca_authoritative_bucket_count": 1,
                "runtime_ledger_source_execution_materialized_bucket_count": 1,
                "runtime_ledger_execution_reconstruction_bucket_count": 0,
                "runtime_ledger_materialization_pnl_derivations": [
                    "source_execution_lifecycle_materialized_runtime_ledger"
                ],
                "runtime_ledger_materialization_blockers": [],
            }
        )

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertTrue(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(
            materialization[
                "runtime_ledger_source_execution_materialized_bucket_count"
            ],
            1,
        )
        self.assertEqual(
            materialization["authoritative_runtime_ledger_profit_proof_count"],
            1,
        )
        self.assertEqual(
            materialization["non_authoritative_runtime_ledger_profit_proof_count"],
            0,
        )
        self.assertEqual(
            materialization["pnl_derivations"],
            ["source_execution_lifecycle_materialized_runtime_ledger"],
        )
        self.assertEqual(materialization["materialized_target_count"], 1)
        self.assertEqual(materialization["unmaterialized_target_count"], 0)
        self.assertEqual(
            materialization["materialized_targets"][0]["candidate_id"],
            "c88421d619759b2cfaa6f4d0",
        )
        self.assertTrue(materialization["materialized_targets"][0]["materialized"])

    def test_packet_blocks_runtime_import_profit_proof_blockers(self) -> None:
        runtime_import = _runtime_import()
        observation = runtime_import["imports"][0]["summary"]["runtime_observation"]
        assert isinstance(observation, dict)
        observation["runtime_ledger_profit_proof_blockers"] = [
            "runtime_ledger_source_window_missing",
            "runtime_ledger_source_refs_missing",
        ]

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertIn(
            "runtime_ledger_source_window_missing", materialization["blockers"]
        )
        self.assertIn("runtime_ledger_source_refs_missing", materialization["blockers"])
        self.assertIn(
            "runtime_ledger_source_window_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_does_not_treat_promotion_only_import_metadata_as_unmaterialized(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        observation = runtime_import["imports"][0]["summary"]["runtime_observation"]
        assert isinstance(observation, dict)
        observation["runtime_ledger_target_metadata_blockers"] = [
            "paper_route_runtime_ledger_import_pending",
            "live_runtime_ledger_required",
            "paper_probation_evidence_collection_only",
        ]

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertTrue(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 1)
        self.assertEqual(materialization["unmaterialized_target_count"], 0)
        self.assertNotIn("live_runtime_ledger_required", materialization["blockers"])
        self.assertNotIn(
            "paper_probation_evidence_collection_only",
            materialization["blockers"],
        )

    def test_packet_blocks_when_any_runtime_import_target_lacks_materialization(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        runtime_import["imports"].append(
            {
                "status": "ok",
                "proof_status": "ok",
                "proof_blockers": [],
                "candidate_id": "cand-missing-proof",
                "hypothesis_id": "H-PAIRS-01",
                "observed_stage": "paper",
                "strategy_family": "microbar_cross_sectional_pairs",
                "strategy_name": "microbar-pairs-vwap-cap-safe",
                "account_label": "TORGHUT_SIM",
                "window_start": "2026-05-26T13:30:00+00:00",
                "window_end": "2026-05-26T20:00:00+00:00",
                "summary": {
                    "promotion_allowed": False,
                    "runtime_observation": {
                        "authoritative": True,
                        "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                        "runtime_ledger_profit_proof_present": False,
                        "runtime_ledger_tca_profit_proof_count": 0,
                        "runtime_ledger_tca_authoritative_bucket_count": 0,
                    },
                },
            }
        )
        runtime_import["target_count"] = 2

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(result["ok"])
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 1)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertEqual(
            materialization["unmaterialized_targets"][0]["candidate_id"],
            "cand-missing-proof",
        )
        self.assertIn(
            "runtime_window_import_target_materialization_missing",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_materialization_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_when_runtime_import_target_has_no_observation(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        runtime_import["imports"][0]["summary"].pop("runtime_observation")

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(result["ok"])
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertEqual(
            materialization["unmaterialized_targets"][0]["candidate_id"],
            "c88421d619759b2cfaa6f4d0",
        )
        self.assertIn(
            "runtime_window_import_runtime_observation_missing",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_window_import_runtime_observation_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_when_runtime_import_target_lacks_db_materialization_verdict(
        self,
    ) -> None:
        runtime_import = _runtime_import(materialization_target=False)

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(result["ok"])
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertIn(
            "runtime_window_import_materialization_target_missing",
            materialization["unmaterialized_targets"][0]["blockers"],
        )
        self.assertIn(
            "runtime_window_import_materialization_target_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_when_runtime_import_target_count_is_incomplete(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        observation = runtime_import["imports"][0]["summary"]["runtime_observation"]
        assert isinstance(observation, dict)
        observation.update(
            {
                "runtime_ledger_profit_proof_present": True,
                "runtime_ledger_tca_profit_proof_count": 1,
                "runtime_ledger_tca_authoritative_bucket_count": 1,
            }
        )
        runtime_import["target_count"] = 2

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(result["ok"])
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 1)
        self.assertEqual(materialization["missing_target_import_count"], 1)
        self.assertIn(
            "runtime_window_import_target_count_mismatch",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_count_mismatch",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_when_runtime_import_target_lacks_observation(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        first_import = runtime_import["imports"][0]
        assert isinstance(first_import, dict)
        first_summary = first_import["summary"]
        assert isinstance(first_summary, dict)
        first_summary.pop("runtime_observation")
        runtime_import["target_count"] = 2

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(result["ok"])
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertEqual(materialization["missing_target_import_count"], 1)
        self.assertIn(
            "runtime_window_import_runtime_observation_missing",
            materialization["unmaterialized_targets"][0]["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_count_mismatch",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_materialization_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_when_profit_proof_is_only_non_authoritative(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        first_observation = runtime_import["imports"][0]["summary"][
            "runtime_observation"
        ]
        assert isinstance(first_observation, dict)
        first_observation.update(
            {
                "authoritative": True,
                "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                "runtime_ledger_profit_proof_present": False,
                "runtime_ledger_tca_profit_proof_count": 0,
                "runtime_ledger_tca_authoritative_bucket_count": 0,
                "runtime_ledger_source_execution_materialized_bucket_count": 0,
                "runtime_ledger_source_bucket_profit_proof_count": 0,
            }
        )
        runtime_import["imports"].append(
            {
                "status": "ok",
                "proof_status": "ok",
                "proof_blockers": [],
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "hypothesis_id": "H-PAIRS-01",
                "observed_stage": "paper",
                "strategy_family": "microbar_cross_sectional_pairs",
                "strategy_name": "microbar-pairs-vwap-cap-safe",
                "account_label": "TORGHUT_SIM",
                "window_start": "2026-05-26T13:30:00+00:00",
                "window_end": "2026-05-26T20:00:00+00:00",
                "summary": {
                    "promotion_allowed": False,
                    "runtime_observation": {
                        "authoritative": False,
                        "authority_reason": "simulation_source_replay_only",
                        "runtime_ledger_profit_proof_present": True,
                        "runtime_ledger_tca_profit_proof_count": 1,
                    },
                },
            }
        )
        runtime_import["target_count"] = 2

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(result["ok"])
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(
            materialization["authoritative_observation_count"],
            1,
        )
        self.assertEqual(
            materialization["runtime_ledger_profit_proof_count"],
            1,
        )
        self.assertEqual(
            materialization["authoritative_runtime_ledger_profit_proof_count"],
            0,
        )
        self.assertEqual(
            materialization["non_authoritative_runtime_ledger_profit_proof_count"],
            1,
        )
        self.assertIn(
            "runtime_window_import_runtime_ledger_materialization_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_runtime_import_without_materialized_runtime_ledger(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(authoritative=False),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "runtime_window_import_runtime_ledger_materialization_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertIn(
            "run_runtime_window_import_from_paper_route_target_plan",
            result["required_actions"],
        )

    def test_packet_materialization_marks_non_authoritative_empty_target(
        self,
    ) -> None:
        runtime_import = _runtime_import(authoritative=False)

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(result["ok"])
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertIn(
            "runtime_window_import_observation_not_authoritative",
            materialization["unmaterialized_targets"][0]["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_profit_proof_missing",
            materialization["unmaterialized_targets"][0]["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_materialization_missing",
            materialization["blockers"],
        )

    def test_packet_surfaces_target_materialization_count_and_string_blockers(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        first_import = runtime_import["imports"][0]
        assert isinstance(first_import, dict)
        first_summary = first_import["summary"]
        assert isinstance(first_summary, dict)
        target = first_summary["runtime_materialization_target"]
        assert isinstance(target, dict)
        target.update(
            {
                "metric_window_count": 0,
                "promotion_decision_count": 0,
                "runtime_ledger_bucket_count": 0,
                "evidence_grade_runtime_ledger_bucket_count": 0,
                "materialization_blockers": [],
                "proof_blockers": ["source_runtime_ledger_missing"],
                "materialized": False,
            }
        )

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(result["ok"])
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        target_blockers = materialization["unmaterialized_targets"][0]["blockers"]
        self.assertIn("runtime_window_import_metric_window_missing", target_blockers)
        self.assertIn(
            "runtime_window_import_promotion_decision_missing",
            target_blockers,
        )
        self.assertIn(
            "runtime_window_import_runtime_ledger_bucket_missing",
            target_blockers,
        )
        self.assertIn(
            "runtime_window_import_evidence_grade_runtime_ledger_bucket_missing",
            target_blockers,
        )
        self.assertIn("source_runtime_ledger_missing", target_blockers)

    def test_packet_waits_on_target_level_settlement_blocker(self) -> None:
        paper = _paper_route_evidence()
        target = paper["next_paper_route_runtime_window_targets"]["targets"][0]
        assert isinstance(target, dict)
        target["paper_route_session_import_blockers"] = [
            "paper_route_session_settlement_pending"
        ]

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=paper,
            generated_at="2026-05-26T20:01:00+00:00",
        )

        self.assertEqual(result["verdict"], "waiting_for_runtime_window")
        self.assertEqual(
            result["promotion_authority"]["blocking_reasons"],
            ["paper_route_session_settlement_pending"],
        )
        self.assertEqual(
            result["required_actions"],
            ["wait_for_paper_route_settlement_grace"],
        )

    def test_packet_accepts_alternate_runtime_plan_and_completion_gate_shapes(
        self,
    ) -> None:
        paper = _paper_route_evidence()
        plan = paper.pop("next_paper_route_runtime_window_targets")
        assert isinstance(plan, dict)
        paper["runtime_window_import_plan"] = plan
        completion_gate = _completion()["gates"][0]

        result = packet.build_runtime_ledger_proof_packet(
            {"mode": "paper", "running": True, "live_gate": {"allowed": True}},
            paper_route_evidence=paper,
            runtime_window_import={
                "status": "ok",
                "proof_status": "ok",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "summary": {
                    "runtime_observation": {
                        "authoritative": True,
                        "runtime_ledger_profit_proof_present": True,
                    },
                    "runtime_materialization_target": {
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "observed_stage": "paper",
                        "account_label": "TORGHUT_SIM",
                        "runtime_ledger_profit_proof_present": True,
                        "metric_window_count": 1,
                        "promotion_decision_count": 1,
                        "runtime_ledger_bucket_count": 1,
                        "evidence_grade_runtime_ledger_bucket_count": 1,
                        "materialized": True,
                        "materialization_blockers": [],
                        "metric_window_ids": ["metric-window-1"],
                        "promotion_decision_id": "promotion-decision-1",
                        "runtime_ledger_bucket_ids": ["runtime-ledger-bucket-1"],
                        "evidence_grade_runtime_ledger_bucket_ids": [
                            "runtime-ledger-bucket-1"
                        ],
                    },
                },
            },
            completion_status={
                "gates_by_id": {
                    packet.DOC29_LIVE_SCALE_GATE: completion_gate,
                },
            },
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["evidence"]["paper_route_target_plan"]["target_count"], 1
        )
        self.assertEqual(
            result["evidence"]["runtime_window_import"][
                "authoritative_observation_count"
            ],
            1,
        )

    def test_packet_preserves_string_proof_blockers_from_runtime_imports(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import={
                "proof_status": "blocked",
                "proof_blockers": ["runtime_ledger_bucket_missing"],
                "imports": [
                    {
                        "proof_status": "blocked",
                        "proof_blockers": ["runtime_ledger_pnl_basis_missing"],
                        "summary": {
                            "runtime_observation": {
                                "authoritative": False,
                            },
                        },
                    }
                ],
            },
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "runtime_ledger_bucket_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_pnl_basis_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "run_runtime_window_import_from_paper_route_target_plan",
            result["required_actions"],
        )

    def test_cli_writes_packet_and_returns_nonzero_for_blocked_packet(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / "status.json"
            paper_path = tmp_path / "paper.json"
            import_path = tmp_path / "import.json"
            completion_path = tmp_path / "completion.json"
            output_path = tmp_path / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")
            import_path.write_text(
                json.dumps(
                    _runtime_import(
                        proof_status="blocked",
                        proof_blockers=["runtime_ledger_pnl_basis_missing"],
                    )
                ),
                encoding="utf-8",
            )
            completion_path.write_text(json.dumps(_completion()), encoding="utf-8")

            exit_code = packet.main(
                [
                    "--status-file",
                    str(status_path),
                    "--paper-route-evidence-file",
                    str(paper_path),
                    "--runtime-window-import-file",
                    str(import_path),
                    "--completion-file",
                    str(completion_path),
                    "--output-file",
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 1)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "blocked")
            self.assertIn(
                "runtime_ledger_pnl_basis_missing",
                payload["promotion_authority"]["blocking_reasons"],
            )

    def test_cli_can_write_blocked_packet_without_failing_scheduled_collection(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / "status.json"
            paper_path = tmp_path / "paper.json"
            import_path = tmp_path / "import.json"
            completion_path = tmp_path / "completion.json"
            output_path = tmp_path / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")
            import_path.write_text(
                json.dumps(
                    _runtime_import(
                        proof_status="blocked",
                        proof_blockers=["runtime_ledger_pnl_basis_missing"],
                    )
                ),
                encoding="utf-8",
            )
            completion_path.write_text(json.dumps(_completion()), encoding="utf-8")

            exit_code = packet.main(
                [
                    "--status-file",
                    str(status_path),
                    "--paper-route-evidence-file",
                    str(paper_path),
                    "--runtime-window-import-file",
                    str(import_path),
                    "--completion-file",
                    str(completion_path),
                    "--output-file",
                    str(output_path),
                    "--allow-blocked-exit-zero",
                ]
            )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "blocked")
            self.assertFalse(payload["promotion_authority"]["allowed"])

    def test_cli_can_emit_waiting_packet_before_import_outputs_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / "status.json"
            paper_path = tmp_path / "paper.json"
            output_path = tmp_path / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(
                json.dumps(
                    _paper_route_evidence(
                        import_ready=False,
                        import_blockers=["paper_route_session_window_not_open"],
                    )
                ),
                encoding="utf-8",
            )

            exit_code = packet.main(
                [
                    "--status-file",
                    str(status_path),
                    "--paper-route-evidence-file",
                    str(paper_path),
                    "--output-file",
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 1)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "waiting_for_runtime_window")
            self.assertEqual(
                payload["checks"]["runtime_window_import_proof"]["status"],
                "waiting_for_paper_route_runtime_window_import",
            )
            self.assertEqual(
                payload["checks"]["runtime_ledger_post_cost_profit_target"]["status"],
                "deferred_until_paper_route_runtime_window_import_is_due",
            )
            self.assertTrue(
                payload["checks"]["runtime_ledger_post_cost_profit_target"]["observed"][
                    "runtime_import_due"
                ]
                is False
            )
            self.assertEqual(
                payload["checks"]["runtime_ledger_lifecycle_counts"]["status"],
                "deferred_until_paper_route_runtime_window_import_is_due",
            )

    def test_cli_can_assemble_from_service_base_url(self) -> None:
        class _Response:
            def __init__(self, body: object) -> None:
                self.body = body

            def __enter__(self) -> "_Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self.body).encode("utf-8")

        def open_url(url: str, *, timeout: float) -> _Response:
            self.assertEqual(timeout, 10.0)
            payloads = {
                "http://torghut.local/trading/status": _status(),
                "http://torghut.local/trading/paper-route-evidence": (
                    _paper_route_evidence()
                ),
                "http://torghut.local/trading/completion/doc29": _completion(),
            }
            return _Response(payloads[url])

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            import_path = tmp_path / "import.json"
            output_path = tmp_path / "packet.json"
            import_path.write_text(json.dumps(_runtime_import()), encoding="utf-8")

            with patch.object(packet, "urlopen", side_effect=open_url):
                exit_code = packet.main(
                    [
                        "--service-base-url",
                        "http://torghut.local/",
                        "--runtime-window-import-file",
                        str(import_path),
                        "--proof-mode",
                        "authority",
                        "--output-file",
                        str(output_path),
                    ]
                )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "promotion_authority_allowed")
            self.assertEqual(
                payload["assembly"]["defaulted_urls"],
                {
                    "status_url": "http://torghut.local/trading/status",
                    "paper_route_evidence_url": (
                        "http://torghut.local/trading/paper-route-evidence"
                    ),
                    "completion_url": ("http://torghut.local/trading/completion/doc29"),
                },
            )
            self.assertEqual(payload["assembly"]["status_source"], "url")
            self.assertEqual(
                payload["assembly"]["runtime_window_import_source"],
                "file",
            )

    def test_cli_can_assemble_from_split_live_and_paper_route_services(self) -> None:
        class _Response:
            def __init__(self, body: object) -> None:
                self.body = body

            def __enter__(self) -> "_Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self.body).encode("utf-8")

        def open_url(url: str, *, timeout: float) -> _Response:
            self.assertEqual(timeout, 10.0)
            payloads = {
                "http://torghut-live.local/trading/status": _status(),
                "http://torghut-sim.local/trading/paper-route-evidence": (
                    _paper_route_evidence()
                ),
                "http://torghut-live.local/trading/completion/doc29": _completion(),
            }
            return _Response(payloads[url])

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            import_path = tmp_path / "import.json"
            output_path = tmp_path / "packet.json"
            import_path.write_text(json.dumps(_runtime_import()), encoding="utf-8")

            with patch.object(packet, "urlopen", side_effect=open_url):
                exit_code = packet.main(
                    [
                        "--status-service-base-url",
                        "http://torghut-live.local/",
                        "--paper-route-service-base-url",
                        "http://torghut-sim.local/",
                        "--completion-service-base-url",
                        "http://torghut-live.local/",
                        "--runtime-window-import-file",
                        str(import_path),
                        "--proof-mode",
                        "authority",
                        "--output-file",
                        str(output_path),
                    ]
                )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "promotion_authority_allowed")
            self.assertEqual(
                payload["assembly"]["service_base_urls"],
                {
                    "status": "http://torghut-live.local/",
                    "paper_route_evidence": "http://torghut-sim.local/",
                    "completion": "http://torghut-live.local/",
                },
            )
            self.assertEqual(
                payload["assembly"]["defaulted_urls"],
                {
                    "status_url": "http://torghut-live.local/trading/status",
                    "paper_route_evidence_url": (
                        "http://torghut-sim.local/trading/paper-route-evidence"
                    ),
                    "completion_url": (
                        "http://torghut-live.local/trading/completion/doc29"
                    ),
                },
            )

    def test_cli_rejects_missing_duplicate_and_invalid_sources(self) -> None:
        with self.assertRaisesRegex(SystemExit, "exactly_one_status_source_required"):
            packet.main([])

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / "status.json"
            paper_path = tmp_path / "paper.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")

            with self.assertRaisesRegex(
                SystemExit, "--min-runtime-ledger-net-pnl must be decimal"
            ):
                packet.main(
                    [
                        "--status-file",
                        str(status_path),
                        "--paper-route-evidence-file",
                        str(paper_path),
                        "--min-runtime-ledger-net-pnl",
                        "bad",
                    ]
                )
            with self.assertRaisesRegex(
                SystemExit, "--min-runtime-ledger-daily-net-pnl must be decimal"
            ):
                packet.main(
                    [
                        "--status-file",
                        str(status_path),
                        "--paper-route-evidence-file",
                        str(paper_path),
                        "--min-runtime-ledger-daily-net-pnl",
                        "bad",
                    ]
                )
            with self.assertRaisesRegex(
                SystemExit, "exactly_one_paper_route_evidence_source_required"
            ):
                packet._required_source_args(
                    Namespace(
                        service_base_url=None,
                        status_file=status_path,
                        status_url=None,
                        paper_route_evidence_file=paper_path,
                        paper_route_evidence_url="http://example.invalid/paper.json",
                        completion_file=None,
                        completion_url=None,
                    )
                )

    def test_json_loaders_require_objects_and_support_urls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            bad_path = Path(tmp_dir) / "bad.json"
            bad_path.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "json_object_required"):
                packet._load_json_object(bad_path)

        class _Response:
            def __init__(self, body: object) -> None:
                self.body = body

            def __enter__(self) -> "_Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self.body).encode("utf-8")

        with patch.object(packet, "urlopen", return_value=_Response({"ok": True})):
            self.assertEqual(
                packet._load_json_url(
                    "http://example.invalid/status.json", timeout_seconds=1
                ),
                {"ok": True},
            )
        with patch.object(packet, "urlopen", return_value=_Response(["bad"])):
            with self.assertRaisesRegex(ValueError, "json_object_required"):
                packet._load_json_url(
                    "http://example.invalid/status.json",
                    timeout_seconds=1,
                )
