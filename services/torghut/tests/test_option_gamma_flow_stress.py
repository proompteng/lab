from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.option_gamma_flow_stress import (
    build_option_gamma_flow_stress_schema_hash,
    extract_option_gamma_flow_stress,
    option_gamma_flow_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestOptionGammaFlowStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        gamma: str | None = None,
        option_flow: str | None = None,
        weekly_options: bool | None = None,
        dte: str | None = None,
        volume: str = "100000",
    ) -> SignalEnvelope:
        payload: dict[str, object] = {
            "price": Decimal(price),
            "microbar_volume": Decimal(volume),
        }
        if gamma is not None:
            payload["net_dealer_gamma_exposure"] = Decimal(gamma)
        if option_flow is not None:
            payload["zero_dte_option_volume"] = Decimal(option_flow)
        if weekly_options is not None:
            payload["weekly_option_availability"] = weekly_options
        if dte is not None:
            payload["option_days_to_expiry"] = Decimal(dte)
        return SignalEnvelope(
            event_ts=datetime(2026, 5, 4, 14, 30, tzinfo=timezone.utc)
            + timedelta(minutes=offset),
            symbol="GAMMA",
            timeframe="1Min",
            seq=offset,
            source="option-gamma-flow-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 5, 4, 14, 31, tzinfo=timezone.utc),
        )

    def test_negative_gamma_weekly_option_flow_penalizes_feedback_risk(self) -> None:
        benign = extract_option_gamma_flow_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    gamma="5000000",
                    option_flow="1000",
                    weekly_options=False,
                    dte="21",
                ),
                self._row(
                    offset=2,
                    price="100.04",
                    gamma="5200000",
                    option_flow="900",
                    weekly_options=False,
                    dte="20",
                ),
                self._row(
                    offset=3,
                    price="100.08",
                    gamma="5100000",
                    option_flow="950",
                    weekly_options=False,
                    dte="19",
                ),
                self._row(
                    offset=4,
                    price="100.12",
                    gamma="5300000",
                    option_flow="1000",
                    weekly_options=False,
                    dte="18",
                ),
            ),
            direction=1,
        )
        stressed = extract_option_gamma_flow_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    gamma="-9000000",
                    option_flow="80000",
                    weekly_options=True,
                    dte="0",
                ),
                self._row(
                    offset=2,
                    price="99.85",
                    gamma="-9500000",
                    option_flow="85000",
                    weekly_options=True,
                    dte="0",
                ),
                self._row(
                    offset=3,
                    price="99.60",
                    gamma="-10000000",
                    option_flow="90000",
                    weekly_options=True,
                    dte="1",
                ),
                self._row(
                    offset=4,
                    price="99.25",
                    gamma="-11000000",
                    option_flow="95000",
                    weekly_options=True,
                    dte="1",
                ),
            ),
            direction=1,
        )

        self.assertEqual(stressed.observed_gamma_count, 4)
        self.assertEqual(stressed.observed_option_flow_count, 4)
        self.assertGreater(
            stressed.negative_gamma_row_share, benign.negative_gamma_row_share
        )
        self.assertGreater(
            stressed.weekly_or_short_dte_share, benign.weekly_or_short_dte_share
        )
        self.assertGreater(
            stressed.option_flow_intensity_score, benign.option_flow_intensity_score
        )
        self.assertGreater(
            stressed.negative_gamma_momentum_share, benign.negative_gamma_momentum_share
        )
        self.assertGreater(
            stressed.adverse_gamma_feedback_share, benign.adverse_gamma_feedback_share
        )
        self.assertGreater(
            stressed.replay_rank_penalty_bps, benign.replay_rank_penalty_bps
        )
        payload = stressed.to_payload()
        self.assertEqual(
            payload["status"], "preview_only_option_gamma_flow_stress_ranking"
        )
        self.assertTrue(payload["option_gamma_exposure_preview"])
        self.assertTrue(payload["short_horizon_option_availability_preview"])
        self.assertTrue(payload["requires_options_provider_clock_downstream"])
        self.assertTrue(
            payload["requires_option_open_interest_or_dealer_gamma_source_downstream"]
        )
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_option_flow_without_gamma_fails_closed_as_source_gap(self) -> None:
        summary = extract_option_gamma_flow_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    option_flow="25000",
                    weekly_options=True,
                    dte="0",
                ),
                self._row(
                    offset=2,
                    price="100.10",
                    option_flow="30000",
                    weekly_options=True,
                    dte="0",
                ),
            )
        )
        payload = summary.to_payload()

        self.assertEqual(summary.observed_gamma_count, 0)
        self.assertGreater(summary.gamma_source_gap_score, 0.0)
        self.assertIn("missing_option_gamma_inputs", summary.warnings)
        self.assertIn("option_flow_without_dealer_gamma_source", summary.warnings)
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])

    def test_contract_embeds_sources_and_keeps_proof_neutral(self) -> None:
        contract = option_gamma_flow_stress_contract()
        payload = extract_option_gamma_flow_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    gamma="-1000000",
                    option_flow="10000",
                    weekly_options=True,
                    dte="0",
                ),
                self._row(
                    offset=2,
                    price="99.95",
                    gamma="-1000000",
                    option_flow="12000",
                    weekly_options=True,
                    dte="0",
                ),
            )
        ).to_payload()

        source_ids = {source["source_id"] for source in contract["source_papers"]}
        self.assertIn("ssrn-4692190", source_ids)
        self.assertIn("ssrn-6703098", source_ids)
        proof_neutrality = contract["proof_neutrality"]
        self.assertTrue(proof_neutrality["requires_exact_replay"])
        self.assertTrue(proof_neutrality["requires_route_tca"])
        self.assertTrue(proof_neutrality["requires_options_provider_clock"])
        self.assertTrue(
            proof_neutrality["requires_option_open_interest_or_dealer_gamma_source"]
        )
        self.assertTrue(proof_neutrality["requires_runtime_ledger"])
        self.assertTrue(
            proof_neutrality["rejects_gamma_proxy_as_realized_pnl_authority"]
        )
        self.assertTrue(
            proof_neutrality["rejects_missing_options_source_as_zero_gamma_assumption"]
        )
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertEqual(
            payload["feature_schema_hash"], build_option_gamma_flow_stress_schema_hash()
        )
