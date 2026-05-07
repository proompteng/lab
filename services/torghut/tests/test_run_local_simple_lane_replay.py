from __future__ import annotations

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, Strategy
from app.trading.strategy_runtime import extract_catalog_metadata
from scripts import run_local_simple_lane_replay


def test_default_replay_universe_is_live_chip_coverage() -> None:
    assert run_local_simple_lane_replay.DEFAULT_SYMBOLS == [
        "NVDA",
        "TSM",
        "AVGO",
        "MU",
        "AMD",
        "ASML",
        "INTC",
        "LRCX",
        "AMAT",
        "TXN",
        "ARM",
        "KLAC",
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
                "universe_symbols": ["NVDA", "TSM"],
                "max_notional_per_trade": "5000",
                "params": {
                    "rank_feature": "cross_section_microbar_volume_rank",
                    "top_n": "2",
                    "universe_size": "12",
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
