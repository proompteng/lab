from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest import TestCase

from app.trading.renewal_bond_profit_escrow import (
    RENEWAL_BOND_PROFIT_ESCROW_SCHEMA_VERSION,
    build_renewal_bond_profit_escrow,
)


NOW = datetime(2026, 5, 7, 12, 0, tzinfo=timezone.utc)


def _hypotheses(*, promotion_eligible_total: int = 1) -> dict[str, object]:
    return {
        "summary": {
            "promotion_eligible_total": promotion_eligible_total,
            "rollback_required_total": 0,
        },
        "items": [
            {
                "hypothesis_id": "H-CONT-01",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "promotion_eligible": promotion_eligible_total > 0,
                "promotion_contract": {
                    "max_avg_abs_slippage_bps": "8",
                },
            }
        ],
    }


def _live_gate(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "allowed": True,
        "reason": "promotion_certificate_valid",
        "blocked_reasons": [],
        "capital_stage": "0.10x canary",
        "capital_state": "0.10x canary",
    }
    payload.update(overrides)
    return payload


def _proof_floor(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": "torghut.profitability-proof-floor.v1",
        "route_state": "paper_candidate",
        "capital_state": "paper_allowed",
        "blocking_reasons": [],
        "repair_ladder": [],
    }
    payload.update(overrides)
    return payload


def _empirical(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "ready": True,
        "status": "healthy",
        "candidate_ids": ["chip-paper-microbar-composite@execution-proof"],
        "dataset_snapshot_refs": ["torghut-chip-full-day-20260505-5e447b6d-r1"],
        "last_completed_at": (NOW - timedelta(minutes=15)).isoformat(),
        "fresh_until": (NOW + timedelta(hours=1)).isoformat(),
    }
    payload.update(overrides)
    return payload


def _quant(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "required": True,
        "ok": True,
        "status": "healthy",
        "reason": "ready",
        "blocking_reasons": [],
        "latest_metrics_count": 144,
        "latest_metrics_updated_at": (NOW - timedelta(seconds=3)).isoformat(),
        "max_stage_lag_seconds": 12,
    }
    payload.update(overrides)
    return payload


def _market(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "last_freshness_seconds": 30,
        "last_domain_states": {"technicals": "healthy", "regime": "healthy"},
        "alert_active": False,
        "health": {"overallState": "up"},
    }
    payload.update(overrides)
    return payload


def _tca(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "order_count": 120,
        "last_computed_at": (NOW - timedelta(minutes=5)).isoformat(),
        "avg_abs_slippage_bps": "3.2",
    }
    payload.update(overrides)
    return payload


def _escrow(
    *,
    quorum: dict[str, object] | None = None,
    proof_floor: dict[str, object] | None = None,
    empirical: dict[str, object] | None = None,
    quant: dict[str, object] | None = None,
    market: dict[str, object] | None = None,
    tca: dict[str, object] | None = None,
    hypotheses: dict[str, object] | None = None,
) -> dict[str, object]:
    return build_renewal_bond_profit_escrow(
        account_label="paper",
        torghut_revision="test-rev",
        trading_mode="live",
        market_session_open=True,
        jangar_dependency_quorum=quorum
        or {"decision": "allow", "reasons": [], "message": "ready"},
        live_submission_gate=_live_gate(),
        proof_floor=proof_floor or _proof_floor(),
        hypothesis_payload=hypotheses or _hypotheses(),
        empirical_jobs_status=empirical or _empirical(),
        quant_evidence=quant or _quant(),
        market_context_status=market or _market(),
        tca_summary=tca or _tca(),
        now=NOW,
    )


class TestRenewalBondProfitEscrow(TestCase):
    def test_renewing_jangar_stage_keeps_zero_notional_and_selects_stage_repair(
        self,
    ) -> None:
        escrow = _escrow(
            quorum={
                "decision": "delay",
                "reasons": ["execution_trust_renewing"],
                "message": "renewal in flight",
                "stage_trust": {
                    "required_stages": ["discover", "implement"],
                    "stages": [
                        {
                            "stage": "implement",
                            "state": "renewing",
                            "reason_codes": ["agentrun_active"],
                            "fresh_until": (NOW + timedelta(minutes=20)).isoformat(),
                        }
                    ],
                },
                "stage_renewal_bonds": [
                    {
                        "bond_id": "bond-implement-1",
                        "stage": "implement",
                        "state": "renewing",
                    }
                ],
            }
        )

        self.assertEqual(
            escrow["schema_version"], RENEWAL_BOND_PROFIT_ESCROW_SCHEMA_VERSION
        )
        self.assertEqual(escrow["capital_state"], "zero_notional")
        self.assertEqual(escrow["max_notional"], "0")
        self.assertIn("jangar_stage_renewing", escrow["blocking_reason_codes"])
        self.assertEqual(escrow["jangar_stage_trust_ref"]["state"], "renewing")
        self.assertEqual(
            escrow["jangar_stage_trust_ref"]["active_renewal_bond_refs"],
            ["bond-implement-1"],
        )
        self.assertEqual(
            escrow["selected_zero_notional_repairs"][0]["code"],
            "settle_jangar_stage_renewal",
        )

    def test_empirical_carry_does_not_bypass_stale_tca(self) -> None:
        escrow = _escrow(
            proof_floor=_proof_floor(
                route_state="repair_only",
                capital_state="zero_notional",
                blocking_reasons=["execution_tca_stale"],
                repair_ladder=[
                    {
                        "code": "repair_execution_tca",
                        "dimension": "execution_tca",
                        "action": "refresh_execution_tca_settlement",
                        "reason": "execution_tca_stale",
                        "priority": 65,
                        "expected_unblock_value": 2,
                    }
                ],
            ),
            tca=_tca(last_computed_at=(NOW - timedelta(days=40)).isoformat()),
        )

        self.assertFalse(escrow["capital_reentry_eligible"])
        self.assertEqual(escrow["capital_state"], "zero_notional")
        self.assertIn("execution_tca_stale", escrow["blocking_reason_codes"])
        self.assertEqual(escrow["evidence_carry_accounts"][0]["max_notional"], "0")
        self.assertIn(
            "execution_tca_stale", escrow["evidence_carry_accounts"][0]["blocked_by"]
        )
        self.assertEqual(
            escrow["selected_zero_notional_repairs"][0]["code"],
            "refresh_execution_tca_settlement",
        )

    def test_market_context_contradiction_blocks_capital(self) -> None:
        escrow = _escrow(
            market={
                "last_freshness_seconds": None,
                "last_domain_states": {},
                "alert_active": False,
                "health": {"overallState": "down"},
            }
        )

        self.assertIn("market_context_contradiction", escrow["blocking_reason_codes"])
        self.assertEqual(
            escrow["contradiction_refs"][0]["type"], "market_context_health_mismatch"
        )
        self.assertEqual(escrow["market_context_refs"]["local_state"], "unknown")
        self.assertEqual(escrow["market_context_refs"]["jangar_health_state"], "down")

    def test_repair_ranking_prices_execution_tca_above_quant_lag(self) -> None:
        escrow = _escrow(
            quant=_quant(max_stage_lag_seconds=41138),
            tca=_tca(last_computed_at=(NOW - timedelta(days=35)).isoformat()),
        )

        repairs = escrow["selected_zero_notional_repairs"]
        self.assertEqual(repairs[0]["code"], "refresh_execution_tca_settlement")
        self.assertEqual(repairs[1]["code"], "repair_quant_ingestion")
        self.assertIn("quant_ingestion_lag_exceeded", escrow["blocking_reason_codes"])
        self.assertIn("execution_tca_stale", escrow["blocking_reason_codes"])
