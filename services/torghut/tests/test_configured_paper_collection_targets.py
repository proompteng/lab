from __future__ import annotations

from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.proofs_configured_collection import (
    configured_strategy_paper_collection_targets,
)
from app.config import settings
from app.models import Base, Strategy


def test_configured_collection_targets_use_runtime_account_and_buy_actions(
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "trading_account_label", "PA3SX7FYNUTF")
    monkeypatch.setattr(
        settings,
        "trading_static_symbols_raw",
        "NVDA,AVGO,AMD,MRVL,MU,COHR,LITE,WDC,STX,TSM",
    )
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    with session_factory() as session:
        session.add(
            Strategy(
                name="breakout-continuation-long-v1",
                description="configured AI collection fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["nvda", "avgo", "unused"],
                max_notional_per_trade=Decimal("100"),
            )
        )
        session.commit()

        targets = configured_strategy_paper_collection_targets(
            session,
            max_notional="100",
        )

    assert len(targets) == 1
    target = targets[0]
    assert target["account_label"] == "PA3SX7FYNUTF"
    assert target["source_account_label"] == "PA3SX7FYNUTF"
    assert target["execution_account_label"] == "PA3SX7FYNUTF"
    assert target["bounded_collection_account_label"] == "TORGHUT_SIM"
    assert target["paper_route_probe_symbols"] == ["NVDA", "AVGO"]
    assert target["target_symbol_actions"] == {"NVDA": "buy", "AVGO": "buy"}
    assert target["paper_route_probe_symbol_actions"] == {
        "NVDA": "buy",
        "AVGO": "buy",
    }
    assert target["promotion_allowed"] is False
    assert target["final_promotion_allowed"] is False
    assert target["capital_promotion_allowed"] is False
