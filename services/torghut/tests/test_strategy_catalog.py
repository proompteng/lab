from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, Strategy
from app.strategies.catalog import StrategyCatalog, extract_catalog_metadata


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

    def test_catalog_persists_compiled_strategy_metadata_in_description_bridge(self) -> None:
        path = self._write_catalog(
            {
                "strategies": [
                    {
                        "name": "intraday-tsmom",
                        "strategy_id": "intraday_tsmom_v1@prod",
                        "strategy_type": "intraday_tsmom_v1",
                        "version": "1.1.0",
                        "params": {"qty": 3, "bullish_hist_min": "0.03"},
                        "description": "intraday compiled spec",
                        "enabled": True,
                        "base_timeframe": "1Min",
                        "symbols": ["NVDA", "AAPL"],
                    }
                ]
            }
        )
        catalog = StrategyCatalog(path=path, mode="merge", reload_seconds=0)

        try:
            with self.session_local() as session:
                changed = catalog.refresh(session)
                self.assertTrue(changed)

                strategy = session.execute(
                    select(Strategy).where(Strategy.name == "intraday-tsmom")
                ).scalar_one()
                metadata = extract_catalog_metadata(strategy.description)

                self.assertEqual(metadata["strategy_id"], "intraday_tsmom_v1@prod")
                self.assertEqual(metadata["strategy_type"], "intraday_tsmom_v1")
                self.assertEqual(metadata["version"], "1.1.0")
                self.assertEqual(metadata["params"]["qty"], 3)
                self.assertEqual(metadata["compiler_source"], "spec_v2")
                self.assertIn("strategy_spec_v2", metadata)
                self.assertIn("compiled_targets", metadata)
        finally:
            path.unlink(missing_ok=True)
