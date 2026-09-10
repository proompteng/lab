from __future__ import annotations


import ast
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.discovery import fast_replay
from app.trading.discovery.candidate_specs import (
    CANDIDATE_SPEC_SCHEMA_VERSION,
    CandidateSpec,
)
from app.trading.discovery.fast_replay import (
    FAST_REPLAY_PROOF_SEMANTICS_LABEL,
    build_fast_replay_preview,
)
from app.trading.discovery.fast_replay.extract_price import (
    extract_microprice_bias_bps,
    extract_ofi_memory_regime_score,
    extract_ofi_pressure,
    extract_price,
    extract_quote_depth_imbalance,
    extract_spread_bps,
    extract_volume,
    float_or_none,
    mapping,
)
from app.trading.discovery.fast_replay.frontier_selection_blockers_for_row import (
    candidate_direction,
    candidate_symbols,
)
from app.trading.discovery.fast_replay.preview_rank_key import (
    preview_rank_key,
    row_with_rank_and_selection,
    select_frontier_buckets,
)
from app.trading.discovery.replay_tape import (
    build_source_query_digest,
    load_replay_tape,
    materialize_signal_tape,
)
from app.trading.models import SignalEnvelope


class _TestFastReplayPreviewBase(TestCase):
    def _spec(
        self,
        candidate_spec_id: str,
        *,
        symbols: list[str],
        selection_mode: str = "continuation",
        max_notional_per_trade: str = "2500",
    ) -> CandidateSpec:
        return CandidateSpec(
            schema_version=CANDIDATE_SPEC_SCHEMA_VERSION,
            candidate_spec_id=candidate_spec_id,
            hypothesis_id=f"hyp-{candidate_spec_id}",
            family_template_id="microbar_cross_sectional_pairs_v1",
            candidate_kind="sleeve",
            runtime_family="microbar_cross_sectional_pairs",
            runtime_strategy_name="microbar-cross-sectional-pairs-v1",
            feature_contract={"mechanism": "test hpairs", "required_features": ["ofi"]},
            parameter_space={},
            strategy_overrides={
                "max_notional_per_trade": max_notional_per_trade,
                "params": {
                    "selection_mode": selection_mode,
                    "signal_motif": "ofi_lob_response_continuation",
                    "rank_feature": "cross_section_session_open_rank",
                },
                "universe_symbols": symbols,
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={"promotion_policy": "research_only"},
        )

    def _signal(
        self,
        *,
        symbol: str,
        offset: int,
        price: str,
        ofi: str,
        volume: str = "100000",
        stress: bool = False,
        event_type: str = "trade",
        queue_ratio: str = "0.15",
        feed_delay_ms: str = "40",
    ) -> SignalEnvelope:
        mid = Decimal(price)
        fill_qty = Decimal("100") if event_type == "trade" else Decimal("0")
        order_type = "market" if event_type == "trade" else "limit"
        fill_status = "filled" if fill_qty > 0 else "unfilled"
        return SignalEnvelope(
            event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc)
            + timedelta(minutes=offset),
            symbol=symbol,
            timeframe="1Min",
            seq=offset,
            source="test",
            payload={
                "price": mid,
                "bid": mid - Decimal("0.01"),
                "ask": mid + Decimal("0.01"),
                "spread_bps": Decimal("2"),
                "ofi": Decimal(ofi),
                "order_book_imbalance": Decimal(ofi),
                "microbar_volume": Decimal(volume),
                "event_type": event_type,
                "order_type": order_type,
                "fill_status": fill_status,
                "order_qty": Decimal("100"),
                "queue_ratio": Decimal(queue_ratio),
                "fill_qty": fill_qty,
                "feed_delay_ms": Decimal(feed_delay_ms),
                "feed_trade_direction": "buy",
                "authoritative_trade_direction": "buy",
                "trade_direction": "buy",
                "trade_size": Decimal("100"),
                "round_trip_latency_ms": Decimal("2.0"),
                "odd_lot_bid_size": Decimal("20"),
                "odd_lot_ask_size": Decimal("18"),
                "off_exchange_trade": stress,
                "algo_activity_score": Decimal("0.80") if stress else Decimal("0.20"),
                "model_inference_latency_ms": Decimal("120")
                if stress
                else Decimal("5"),
                "bid_size": Decimal("700"),
                "ask_size": Decimal("300"),
                "macro_event_window": stress,
                "net_dealer_gamma_exposure": Decimal("-9000000")
                if stress
                else Decimal("5000000"),
                "zero_dte_option_volume": Decimal("80000")
                if stress
                else Decimal("1000"),
                "weekly_option_availability": stress,
                "option_days_to_expiry": Decimal("0") if stress else Decimal("21"),
                "jump_bps": Decimal("120") if stress else Decimal("2"),
                "news_event_window": stress,
                "session_open_window": stress,
                "forecast_return_bps": Decimal("1.0") if stress else Decimal("12.0"),
                "transaction_cost_bps": Decimal("4.0"),
                "cost_filtered_action": "buy",
                "walk_forward_fold_id": f"wf-{offset}",
                "multi_scale_trend_score": Decimal("0.60")
                if stress
                else Decimal("0.85"),
                "dynamic_variable_weights": {
                    "ofi": "0.35",
                    "spread": "0.20",
                    "volume": "0.15",
                },
            },
            ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
        )


__all__: tuple[str, ...] = (
    "CANDIDATE_SPEC_SCHEMA_VERSION",
    "CandidateSpec",
    "Decimal",
    "FAST_REPLAY_PROOF_SEMANTICS_LABEL",
    "Path",
    "SignalEnvelope",
    "TemporaryDirectory",
    "TestCase",
    "_TestFastReplayPreviewBase",
    "ast",
    "build_fast_replay_preview",
    "build_source_query_digest",
    "candidate_direction",
    "candidate_symbols",
    "date",
    "datetime",
    "extract_microprice_bias_bps",
    "extract_ofi_memory_regime_score",
    "extract_ofi_pressure",
    "extract_price",
    "extract_quote_depth_imbalance",
    "extract_spread_bps",
    "extract_volume",
    "fast_replay",
    "float_or_none",
    "load_replay_tape",
    "mapping",
    "materialize_signal_tape",
    "preview_rank_key",
    "row_with_rank_and_selection",
    "select_frontier_buckets",
    "timedelta",
    "timezone",
)
