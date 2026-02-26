from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.autonomy.janus_q import (
    JanusHgrmRewardConfigV1,
    build_janus_event_car_artifact_v1,
    build_janus_hgrm_reward_artifact_v1,
    build_janus_q_evidence_summary_v1,
)
from app.trading.evaluation import WalkForwardDecision
from app.trading.features import SignalFeatures
from app.trading.models import SignalEnvelope, StrategyDecision


class TestJanusQScaffold(TestCase):
    def test_event_car_artifact_is_deterministic(self) -> None:
        signals = _signals_fixture()
        generated_at = datetime(2026, 2, 25, tzinfo=timezone.utc)

        first = build_janus_event_car_artifact_v1(
            run_id="run-janus",
            signals=signals,
            generated_at=generated_at,
        )
        second = build_janus_event_car_artifact_v1(
            run_id="run-janus",
            signals=signals,
            generated_at=generated_at,
        )

        self.assertEqual(first.schema_version, "janus-event-car-v1")
        self.assertEqual(first.summary["event_count"], 4)
        self.assertEqual(first.manifest_hash, second.manifest_hash)
        self.assertNotEqual(first.records[0].car, "0")
        self.assertIn("dataset_snapshot_hash", first.lineage)
        self.assertIn("run_config_hash", first.lineage)
        self.assertEqual(first.summary["unknown_event_type_count"], 0)

    def test_hgrm_reward_scaffold_and_summary_contract(self) -> None:
        signals = _signals_fixture()
        walk_decisions = _decisions_fixture()
        generated_at = datetime(2026, 2, 25, tzinfo=timezone.utc)

        event_car = build_janus_event_car_artifact_v1(
            run_id="run-janus",
            signals=signals,
            generated_at=generated_at,
        )
        hgrm = build_janus_hgrm_reward_artifact_v1(
            run_id="run-janus",
            candidate_id="cand-janus",
            event_car=event_car,
            walk_decisions=walk_decisions,
            generated_at=generated_at,
        )
        summary = build_janus_q_evidence_summary_v1(
            event_car=event_car,
            hgrm_reward=hgrm,
            event_car_artifact_ref="/tmp/janus-event-car-v1.json",
            hgrm_reward_artifact_ref="/tmp/janus-hgrm-reward-v1.json",
        )

        self.assertEqual(hgrm.schema_version, "janus-hgrm-reward-v1")
        self.assertEqual(hgrm.summary["reward_count"], 2)
        self.assertEqual(hgrm.summary["event_mapped_count"], 2)
        self.assertTrue(summary["evidence_complete"])
        self.assertEqual(summary["schema_version"], "janus-q-evidence-v1")
        self.assertIn("decision_snapshot_hash", hgrm.lineage)
        self.assertEqual(hgrm.summary["clipped_final_reward_count"], 0)

    def test_hgrm_reward_maps_by_seq_for_same_symbol_and_timestamp(self) -> None:
        generated_at = datetime(2026, 2, 25, tzinfo=timezone.utc)
        event_car = build_janus_event_car_artifact_v1(
            run_id="run-janus-collision",
            signals=_collision_signals_fixture(),
            generated_at=generated_at,
        )
        hgrm = build_janus_hgrm_reward_artifact_v1(
            run_id="run-janus-collision",
            candidate_id="cand-janus-collision",
            event_car=event_car,
            walk_decisions=_collision_decisions_fixture(with_seq=True),
            generated_at=generated_at,
        )

        self.assertEqual(hgrm.summary["event_mapped_count"], 2)
        self.assertEqual(hgrm.summary["event_ambiguous_unmapped_count"], 0)
        self.assertEqual(len({item.event_id for item in hgrm.rewards}), 2)

    def test_hgrm_reward_unmaps_ambiguous_event_without_seq(self) -> None:
        generated_at = datetime(2026, 2, 25, tzinfo=timezone.utc)
        event_car = build_janus_event_car_artifact_v1(
            run_id="run-janus-collision",
            signals=_collision_signals_fixture(),
            generated_at=generated_at,
        )
        hgrm = build_janus_hgrm_reward_artifact_v1(
            run_id="run-janus-collision",
            candidate_id="cand-janus-collision",
            event_car=event_car,
            walk_decisions=_collision_decisions_fixture(with_seq=False),
            generated_at=generated_at,
        )

        self.assertEqual(hgrm.summary["event_mapped_count"], 0)
        self.assertEqual(hgrm.summary["event_ambiguous_unmapped_count"], 2)
        self.assertEqual([item.event_id for item in hgrm.rewards], ["unmapped", "unmapped"])

    def test_hgrm_reward_applies_configured_clipping(self) -> None:
        generated_at = datetime(2026, 2, 25, tzinfo=timezone.utc)
        event_car = build_janus_event_car_artifact_v1(
            run_id="run-janus-clip",
            signals=_high_return_signal_fixture(),
            generated_at=generated_at,
        )
        hgrm = build_janus_hgrm_reward_artifact_v1(
            run_id="run-janus-clip",
            candidate_id="cand-janus-clip",
            event_car=event_car,
            walk_decisions=_high_return_decision_fixture(),
            generated_at=generated_at,
            reward_config=JanusHgrmRewardConfigV1(
                final_reward_clip_floor=Decimal("-0.05"),
                final_reward_clip_ceil=Decimal("0.05"),
            ),
        )

        self.assertEqual(hgrm.summary["reward_count"], 1)
        self.assertEqual(hgrm.summary["clipped_final_reward_count"], 1)
        self.assertEqual(hgrm.rewards[0].final_reward, "0.05")
        self.assertTrue(hgrm.rewards[0].clipped)


def _signals_fixture() -> list[SignalEnvelope]:
    return [
        SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={"price": "100", "event_type": "earnings"},
            seq=1,
            source="fixture",
        ),
        SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
            symbol="MSFT",
            timeframe="1Min",
            payload={"price": "200", "event_type": "guidance"},
            seq=1,
            source="fixture",
        ),
        SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 2, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={"price": "102", "event_type": "earnings"},
            seq=2,
            source="fixture",
        ),
        SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 2, tzinfo=timezone.utc),
            symbol="MSFT",
            timeframe="1Min",
            payload={"price": "198", "event_type": "guidance"},
            seq=2,
            source="fixture",
        ),
    ]


def _decisions_fixture() -> list[WalkForwardDecision]:
    return [
        WalkForwardDecision(
            decision=StrategyDecision(
                strategy_id="s-1",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={"event_type": "earnings"},
            ),
            features=SignalFeatures(
                macd=Decimal("0.5"),
                macd_signal=Decimal("0.2"),
                rsi=Decimal("60"),
                price=Decimal("100"),
                volatility=Decimal("0.1"),
            ),
        ),
        WalkForwardDecision(
            decision=StrategyDecision(
                strategy_id="s-1",
                symbol="MSFT",
                event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"event_type": "guidance"},
            ),
            features=SignalFeatures(
                macd=Decimal("-0.5"),
                macd_signal=Decimal("-0.2"),
                rsi=Decimal("40"),
                price=Decimal("200"),
                volatility=Decimal("0.1"),
            ),
        ),
    ]


def _collision_signals_fixture() -> list[SignalEnvelope]:
    ts = datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc)
    return [
        SignalEnvelope(
            event_ts=ts,
            symbol="AAPL",
            timeframe="1Min",
            payload={"price": "100", "event_type": "earnings"},
            seq=1,
            source="fixture",
        ),
        SignalEnvelope(
            event_ts=ts,
            symbol="AAPL",
            timeframe="1Min",
            payload={"price": "101", "event_type": "guidance"},
            seq=2,
            source="fixture",
        ),
    ]


def _collision_decisions_fixture(*, with_seq: bool) -> list[WalkForwardDecision]:
    ts = datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc)
    first_params: dict[str, object] = {"event_type": "earnings"}
    second_params: dict[str, object] = {"event_type": "guidance"}
    if with_seq:
        first_params["signal_seq"] = 1
        second_params["signal_seq"] = 2
    return [
        WalkForwardDecision(
            decision=StrategyDecision(
                strategy_id="s-1",
                symbol="AAPL",
                event_ts=ts,
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params=first_params,
            ),
            features=SignalFeatures(
                macd=Decimal("0.5"),
                macd_signal=Decimal("0.2"),
                rsi=Decimal("60"),
                price=Decimal("100"),
                volatility=Decimal("0.1"),
            ),
        ),
        WalkForwardDecision(
            decision=StrategyDecision(
                strategy_id="s-2",
                symbol="AAPL",
                event_ts=ts,
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params=second_params,
            ),
            features=SignalFeatures(
                macd=Decimal("-0.5"),
                macd_signal=Decimal("-0.2"),
                rsi=Decimal("40"),
                price=Decimal("101"),
                volatility=Decimal("0.1"),
            ),
        ),
    ]


def _high_return_signal_fixture() -> list[SignalEnvelope]:
    return [
        SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={
                "price": "100",
                "event_type": "earnings",
                "market_return": "0.001",
                "beta_market": "1",
            },
            seq=1,
            source="fixture",
        ),
        SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 0, 2, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={"price": "200", "event_type": "earnings"},
            seq=2,
            source="fixture",
        ),
    ]


def _high_return_decision_fixture() -> list[WalkForwardDecision]:
    return [
        WalkForwardDecision(
            decision=StrategyDecision(
                strategy_id="s-clip",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={"event_type": "earnings", "signal_seq": 1},
            ),
            features=SignalFeatures(
                macd=Decimal("0.5"),
                macd_signal=Decimal("0.2"),
                rsi=Decimal("60"),
                price=Decimal("100"),
                volatility=Decimal("0.1"),
            ),
        )
    ]
