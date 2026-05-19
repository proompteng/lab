from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import config
from app.models import Base, Strategy
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
        assert config.settings.trading_live_enabled is False
        assert config.settings.trading_simple_paper_route_probe_enabled is True
        assert config.settings.trading_simple_paper_route_probe_max_notional == 25.0
    finally:
        config.settings.trading_simple_paper_route_probe_enabled = original[
            "trading_simple_paper_route_probe_enabled"
        ]
        config.settings.trading_simple_paper_route_probe_max_notional = original[
            "trading_simple_paper_route_probe_max_notional"
        ]
