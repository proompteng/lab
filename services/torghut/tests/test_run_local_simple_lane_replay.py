from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import config
from app.models import Base, Strategy, TradeDecision
from app.trading.strategy_runtime import extract_catalog_metadata
from scripts import run_local_simple_lane_replay


def test_default_replay_universe_is_live_chip_coverage() -> None:
    assert run_local_simple_lane_replay.DEFAULT_SYMBOLS == [
        "NVDA",
        "AAPL",
        "AMZN",
        "GOOGL",
        "AVGO",
        "AMD",
        "ORCL",
        "INTC",
    ]


def test_seed_strategies_preserves_catalog_runtime_metadata() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session_local = sessionmaker(bind=engine)

    run_local_simple_lane_replay._seed_strategies(
        session_local,
        [
            {
                "name": "chip-volume",
                "strategy_id": "chip-volume@prod",
                "strategy_type": "microbar_cross_sectional_long_v1",
                "version": "1.0.0",
                "base_timeframe": "1Sec",
                "universe_type": "microbar_cross_sectional_long_v1",
                "universe_symbols": ["NVDA", "AAPL"],
                "max_notional_per_trade": "5000",
                "params": {
                    "rank_feature": "cross_section_microbar_volume_rank",
                    "top_n": "2",
                    "universe_size": "8",
                },
            }
        ],
    )

    with session_local() as session:
        strategy = session.scalars(select(Strategy)).one()

    metadata = extract_catalog_metadata(strategy.description)
    assert metadata["strategy_id"] == "chip-volume@prod"
    assert metadata["strategy_type"] == "microbar_cross_sectional_long_v1"
    assert metadata["params"]["rank_feature"] == "cross_section_microbar_volume_rank"


def test_fetch_rows_via_kubectl_accepts_explicit_context() -> None:
    completed = type(
        "Completed",
        (),
        {
            "returncode": 0,
            "stdout": (
                '{"event_ts":"2026-03-30 13:30:00.000","ingest_ts":"2026-03-30 13:30:00.000",'
                '"symbol":"NVDA","seq":1}\n'
            ),
            "stderr": "",
        },
    )()

    with patch(
        "scripts.run_local_simple_lane_replay.subprocess.run",
        return_value=completed,
    ) as run_mock:
        rows = run_local_simple_lane_replay._fetch_rows_via_kubectl(
            symbol="NVDA",
            start=datetime(2026, 3, 30, 13, 30, tzinfo=timezone.utc),
            end=datetime(2026, 3, 30, 13, 31, tzinfo=timezone.utc),
            clickhouse_namespace="torghut",
            clickhouse_pod="chi-torghut-clickhouse-default-0-0-0",
            kubectl_context="galactic-lan",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            clickhouse_table="torghut.ta_signals",
        )

    assert rows[0]["symbol"] == "NVDA"
    cmd = run_mock.call_args.args[0]
    assert cmd[:3] == ["kubectl", "--context", "galactic-lan"]
    assert cmd[3:7] == ["exec", "-n", "torghut", "chi-torghut-clickhouse-default-0-0-0"]
    query = cmd[-1]
    assert "imbalance_bid_px" in query
    assert "imbalance_ask_px" in query
    assert "imbalance_bid_sz" in query
    assert "imbalance_ask_sz" in query


def test_configure_replay_settings_enables_bounded_paper_route_probe() -> None:
    original = {
        "trading_simple_paper_route_probe_enabled": config.settings.trading_simple_paper_route_probe_enabled,
        "trading_simple_paper_route_probe_max_notional": config.settings.trading_simple_paper_route_probe_max_notional,
    }
    try:
        run_local_simple_lane_replay._configure_replay_settings(
            symbols=["NVDA"],
            max_notional_per_order=Decimal("1000"),
            max_notional_per_symbol=Decimal("2000"),
            allow_shorts=False,
        )

        assert config.settings.trading_mode == "paper"
        assert config.settings.trading_simple_paper_route_probe_enabled is True
        assert config.settings.trading_simple_paper_route_probe_max_notional == 25.0
    finally:
        config.settings.trading_simple_paper_route_probe_enabled = original[
            "trading_simple_paper_route_probe_enabled"
        ]
        config.settings.trading_simple_paper_route_probe_max_notional = original[
            "trading_simple_paper_route_probe_max_notional"
        ]


def test_build_artifacts_exposes_proof_floor_blocker_evidence() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session_local = sessionmaker(bind=engine)
    run_local_simple_lane_replay._seed_strategies(
        session_local,
        [
            {
                "name": "intraday-tsmom-profit-v3",
                "strategy_id": "intraday_tsmom_v1@paper",
                "strategy_type": "intraday_tsmom_v1",
                "enabled": True,
                "params": {},
            }
        ],
    )
    with session_local() as session:
        strategy = session.scalars(select(Strategy)).one()
        session.add(
            TradeDecision(
                strategy_id=strategy.id,
                symbol="NVDA",
                timeframe="1Sec",
                status="blocked",
                decision_json={
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "params": {
                        "execution_lane": "simple",
                        "submit_path": "direct_alpaca",
                    },
                    "profitability_proof_floor": {
                        "blocking_reasons": [
                            "alpha_readiness_not_promotion_eligible",
                            "market_context_stale",
                        ],
                        "proof_dimensions": [
                            {
                                "dimension": "alpha_readiness",
                                "state": "fail",
                                "reason": "alpha_readiness_not_promotion_eligible",
                                "source_ref": {
                                    "reason_totals": {
                                        "sample_count_below_canary_minimum": 3
                                    },
                                    "repair_targets": [
                                        {
                                            "hypothesis_id": "H-TSMOM-01",
                                            "candidate_id": "spec-83161",
                                            "strategy_family": "intraday_tsmom_consistent",
                                            "promotion_eligible": False,
                                            "reasons": [
                                                "sample_count_below_canary_minimum"
                                            ],
                                        }
                                    ],
                                },
                            },
                            {
                                "dimension": "execution_tca",
                                "state": "pass",
                                "reason": "execution_tca_route_universe_exclusions_applied",
                                "source_ref": {
                                    "symbol_routes": {
                                        "routeable_symbols": [{"symbol": "NVDA"}],
                                        "missing_symbols": ["AAPL", "AMD"],
                                        "blocked_symbols": [],
                                    }
                                },
                            },
                        ],
                        "repair_ladder": [
                            {
                                "code": "repair_alpha_readiness",
                                "priority": 70,
                                "reason": "alpha_readiness_not_promotion_eligible",
                            }
                        ],
                    },
                },
            )
        )
        session.commit()

    pipeline = SimpleNamespace(
        state=SimpleNamespace(
            metrics=SimpleNamespace(
                orders_submitted_total=0,
                orders_rejected_total=0,
                decisions_total=1,
                reconcile_updates_total=0,
            )
        )
    )
    with TemporaryDirectory() as tmpdir:
        artifacts = run_local_simple_lane_replay._build_artifacts(
            session_local=session_local,
            pipeline=pipeline,
            output_dir=Path(tmpdir),
            start=datetime(2026, 5, 18, 18, 30, tzinfo=timezone.utc),
            end=datetime(2026, 5, 18, 18, 45, tzinfo=timezone.utc),
            symbols=["NVDA"],
            strategies=[],
            signal_fetch_counts={"NVDA": 1},
            total_signals=1,
            replay_buckets=1,
            reconcile_updates=0,
        )

    evidence = artifacts.decision_activity["proof_floor_blocker_evidence"]
    assert artifacts.run_summary["acceptance"]["passed"] is False
    assert evidence["blocking_reason_totals"] == {
        "alpha_readiness_not_promotion_eligible": 1,
        "market_context_stale": 1,
    }
    assert evidence["alpha_reason_totals"] == {"sample_count_below_canary_minimum": 3}
    assert evidence["alpha_repair_targets"][0]["hypothesis_id"] == "H-TSMOM-01"
    assert evidence["execution_tca"]["routeable_symbols"] == ["NVDA"]
    assert evidence["execution_tca"]["missing_symbols"] == ["AAPL", "AMD"]
    assert (
        artifacts.run_summary["proof_floor_blocker_evidence"]
        == artifacts.decision_activity["proof_floor_blocker_evidence"]
    )
