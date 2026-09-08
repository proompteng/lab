from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.lead_lag_cross_asset_stress import (
    LEAD_LAG_CROSS_ASSET_STRESS_PRIMARY_SOURCES,
    extract_lead_lag_cross_asset_stress,
    lead_lag_cross_asset_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestLeadLagCrossAssetStress(TestCase):
    def _row(
        self,
        *,
        symbol: str,
        offset: int,
        return_bps: float | None,
        ofi: float | None = None,
    ) -> SignalEnvelope:
        payload: dict[str, Decimal] = {}
        if return_bps is not None:
            payload["return_bps"] = Decimal(str(return_bps))
        if ofi is not None:
            payload["ofi"] = Decimal(str(ofi))
        return SignalEnvelope(
            event_ts=datetime(2026, 5, 4, 13, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol=symbol,
            timeframe="1S",
            seq=offset,
            source="fixture",
            payload=payload,
            ingest_ts=datetime(2026, 5, 4, 13, 30, 1, tzinfo=timezone.utc),
        )

    def test_lagged_cross_asset_alignment_downranks_more_than_synchronous_flow(
        self,
    ) -> None:
        base_returns = [1.0, -2.0, 0.5, 3.0, -1.0, 2.0, -3.0, 1.5]
        synchronous_rows: list[SignalEnvelope] = []
        for index, value in enumerate(base_returns):
            synchronous_rows.append(
                self._row(symbol="AAA", offset=index, return_bps=value, ofi=value)
            )
            synchronous_rows.append(
                self._row(symbol="BBB", offset=index, return_bps=value * 0.9, ofi=value)
            )

        lagged_rows: list[SignalEnvelope] = []
        lagger_returns = [0.0] + base_returns[:-1]
        for index, value in enumerate(base_returns):
            lagged_rows.append(
                self._row(symbol="AAA", offset=index, return_bps=value, ofi=0.1)
            )
            lagged_rows.append(
                self._row(
                    symbol="BBB",
                    offset=index,
                    return_bps=lagger_returns[index],
                    ofi=0.1,
                )
            )

        synchronous = extract_lead_lag_cross_asset_stress(synchronous_rows).to_payload()
        lagged = extract_lead_lag_cross_asset_stress(lagged_rows).to_payload()

        self.assertGreater(
            float(lagged["lag_correlation_uplift"]),
            float(synchronous["lag_correlation_uplift"]),
        )
        self.assertGreater(
            float(lagged["stale_alignment_score"]),
            float(synchronous["stale_alignment_score"]),
        )
        self.assertGreater(
            float(lagged["replay_rank_penalty_bps"]),
            float(synchronous["replay_rank_penalty_bps"]),
        )
        self.assertEqual(lagged["best_lead_lag_pair"]["leader_symbol"], "AAA")
        self.assertEqual(lagged["best_lead_lag_pair"]["lagger_symbol"], "BBB")
        self.assertEqual(lagged["best_lead_lag_pair"]["lag_steps"], 1)
        self.assertTrue(lagged["dynamic_pair_specific_lead_lag_preview"])
        self.assertTrue(lagged["cross_asset_causality_guard_preview"])
        self.assertFalse(lagged["proof_authority"])
        self.assertFalse(lagged["promotion_authority"])

    def test_lead_lag_reversal_and_short_direction_stress_are_reported(
        self,
    ) -> None:
        first_half_leader = [1.0, -1.0, 2.0, -2.0, 1.5, -1.5, 2.5]
        second_half_leader = [1.2, -0.8, 2.2, -1.7, 1.4, -1.2, 2.4]
        rows: list[SignalEnvelope] = []
        for index, value in enumerate(first_half_leader):
            rows.append(
                self._row(symbol="AAA", offset=index, return_bps=value, ofi=value)
            )
            rows.append(
                self._row(
                    symbol="BBB",
                    offset=index,
                    return_bps=([0.0] + first_half_leader[:-1])[index],
                    ofi=value,
                )
            )
        for local_index, value in enumerate(second_half_leader):
            offset = local_index + len(first_half_leader)
            rows.append(
                self._row(
                    symbol="BBB",
                    offset=offset,
                    return_bps=value,
                    ofi=value,
                )
            )
            rows.append(
                self._row(
                    symbol="AAA",
                    offset=offset,
                    return_bps=([0.0] + second_half_leader[:-1])[local_index],
                    ofi=value,
                )
            )

        payload = extract_lead_lag_cross_asset_stress(rows, direction=-1).to_payload()

        self.assertGreater(float(payload["lag_direction_reversal_share"]), 0.0)
        self.assertGreater(float(payload["replay_rank_penalty_bps"]), 0.0)
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["final_promotion_allowed"])

    def test_missing_cross_asset_inputs_fail_closed_as_source_gap(self) -> None:
        rows = [
            self._row(symbol="AAA", offset=index, return_bps=None, ofi=None)
            for index in range(3)
        ]

        payload = extract_lead_lag_cross_asset_stress(rows).to_payload()

        self.assertEqual(payload["symbol_count"], 0)
        self.assertGreater(float(payload["source_gap_score"]), 0.0)
        self.assertGreater(float(payload["replay_rank_penalty_bps"]), 0.0)
        self.assertIn("insufficient_cross_asset_symbols", payload["warnings"])
        self.assertIn("missing_cross_asset_return_observations", payload["warnings"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])

    def test_contract_records_primary_sources_without_promotion_authority(self) -> None:
        contract = lead_lag_cross_asset_stress_contract()

        self.assertEqual(
            [item["source_id"] for item in contract["source_papers"]],
            [item["source_id"] for item in LEAD_LAG_CROSS_ASSET_STRESS_PRIMARY_SOURCES],
        )
        self.assertTrue(contract["proof_neutrality"]["requires_exact_tick_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            contract["proof_neutrality"]["lead_lag_is_not_directional_alpha_proof"]
        )
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
        self.assertFalse(contract["proof_neutrality"]["promotion_authority"])
