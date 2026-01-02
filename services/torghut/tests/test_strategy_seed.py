from __future__ import annotations

from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Base
from scripts import seed_strategy


class TestStrategySeed(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def test_upsert_strategy(self) -> None:
        seed_strategy.ensure_schema = lambda: None  # type: ignore[assignment]
        with self.session_local() as session:
            strategy = seed_strategy.upsert_strategy(
                name="demo",
                description="demo",
                base_timeframe="1Min",
                symbols=["AAPL"],
                enabled=True,
                max_notional=None,
                max_position_pct=None,
                session=session,
            )
            self.assertEqual(strategy.name, "demo")

            updated = seed_strategy.upsert_strategy(
                name="demo",
                description="updated",
                base_timeframe="5Min",
                symbols=["AAPL", "MSFT"],
                enabled=False,
                max_notional=None,
                max_position_pct=None,
                session=session,
            )
            self.assertEqual(updated.description, "updated")
            self.assertFalse(updated.enabled)
