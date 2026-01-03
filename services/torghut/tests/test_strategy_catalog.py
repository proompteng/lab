from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, Strategy
from app.strategies.catalog import StrategyCatalog


class TestStrategyCatalog(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def _write_catalog(self, payload: dict) -> Path:
        handle, path = tempfile.mkstemp(suffix=".json")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as file:
                json.dump(payload, file)
        except Exception:
            os.unlink(path)
            raise
        return Path(path)

    def test_merge_keeps_unlisted_strategies(self) -> None:
        path = self._write_catalog(
            {
                "strategies": [
                    {
                        "name": "demo",
                        "description": "demo",
                        "enabled": True,
                        "base_timeframe": "1Min",
                        "symbols": ["AAPL"],
                    }
                ]
            }
        )
        catalog = StrategyCatalog(path=path, mode="merge", reload_seconds=0)

        try:
            with self.session_local() as session:
                session.add(
                    Strategy(
                        name="legacy",
                        description="legacy",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["MSFT"],
                    )
                )
                session.commit()

                changed = catalog.refresh(session)
                self.assertTrue(changed)

                demo = session.execute(select(Strategy).where(Strategy.name == "demo")).scalar_one_or_none()
                self.assertIsNotNone(demo)

                legacy = session.execute(select(Strategy).where(Strategy.name == "legacy")).scalar_one_or_none()
                self.assertIsNotNone(legacy)
                self.assertTrue(legacy.enabled)
        finally:
            path.unlink(missing_ok=True)

    def test_sync_disables_missing_strategies(self) -> None:
        path = self._write_catalog(
            {
                "strategies": [
                    {
                        "name": "demo",
                        "description": "demo",
                        "enabled": True,
                        "base_timeframe": "1Min",
                        "symbols": ["AAPL"],
                    }
                ]
            }
        )
        catalog = StrategyCatalog(path=path, mode="sync", reload_seconds=0)

        try:
            with self.session_local() as session:
                session.add(
                    Strategy(
                        name="legacy",
                        description="legacy",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["MSFT"],
                    )
                )
                session.commit()

                changed = catalog.refresh(session)
                self.assertTrue(changed)

                legacy = session.execute(select(Strategy).where(Strategy.name == "legacy")).scalar_one_or_none()
                self.assertIsNotNone(legacy)
                self.assertFalse(legacy.enabled)
        finally:
            path.unlink(missing_ok=True)
