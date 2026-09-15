from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from unittest import TestCase

import yaml
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, Strategy, StrategyCapitalAuthorityRecord
from app.strategies.catalog import (
    StrategyCatalog,
    StrategyCatalogConfig,
    StrategyConfig,
    extract_catalog_metadata,
)


class TestStrategyCatalog(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )

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

                demo = session.execute(
                    select(Strategy).where(Strategy.name == "demo")
                ).scalar_one_or_none()
                self.assertIsNotNone(demo)
                self.assertIsNotNone(demo.active_capital_authority_id)
                authority = session.get(
                    StrategyCapitalAuthorityRecord,
                    demo.active_capital_authority_id,
                )
                self.assertIsNotNone(authority)
                assert authority is not None
                self.assertEqual(authority.stage, "quarantined")
                self.assertEqual(
                    authority.payload_json["blockers"],
                    ["catalog_authority_missing"],
                )

                legacy = session.execute(
                    select(Strategy).where(Strategy.name == "legacy")
                ).scalar_one_or_none()
                self.assertIsNotNone(legacy)
                self.assertTrue(legacy.enabled)
        finally:
            path.unlink(missing_ok=True)

    def test_catalog_activates_explicit_safe_authority_without_suffix_inference(
        self,
    ) -> None:
        path = self._write_catalog(
            {
                "strategies": [
                    {
                        "name": "demo",
                        "strategy_id": "misleading@prod",
                        "enabled": True,
                        "base_timeframe": "1Min",
                        "symbols": ["AAPL"],
                        "capital_authority": {
                            "authority_id": "catalog-demo-shadow-v1",
                            "strategy_ref": "demo",
                            "stage": "shadow_allowed",
                            "blockers": ["p0_capital_freeze"],
                        },
                    }
                ]
            }
        )
        catalog = StrategyCatalog(path=path, mode="merge", reload_seconds=0)

        try:
            with self.session_local() as session:
                self.assertTrue(catalog.refresh(session))
                strategy = session.execute(
                    select(Strategy).where(Strategy.name == "demo")
                ).scalar_one()
                authority = session.get(
                    StrategyCapitalAuthorityRecord,
                    strategy.active_capital_authority_id,
                )
                self.assertIsNotNone(authority)
                assert authority is not None
                self.assertEqual(authority.stage, "shadow_allowed")
                self.assertEqual(authority.payload_json["strategy_ref"], "demo")
                self.assertTrue(authority.payload_json["reduce_only"])
        finally:
            path.unlink(missing_ok=True)

    def test_catalog_redefinition_quarantines_then_restores_same_valid_digest(
        self,
    ) -> None:
        payload = {
            "strategies": [
                {
                    "name": "demo",
                    "enabled": True,
                    "base_timeframe": "1Min",
                    "symbols": ["AAPL"],
                    "capital_authority": {
                        "authority_id": "catalog-demo-safe-v1",
                        "strategy_ref": "demo",
                        "stage": "shadow_allowed",
                    },
                }
            ]
        }
        path = self._write_catalog(payload)
        catalog = StrategyCatalog(path=path, mode="merge", reload_seconds=0)

        try:
            with self.session_local() as session:
                self.assertTrue(catalog.refresh(session))
                payload["strategies"][0]["capital_authority"]["stage"] = "research_only"
                path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertTrue(catalog.refresh(session))
                strategy = session.execute(
                    select(Strategy).where(Strategy.name == "demo")
                ).scalar_one()
                authority = session.get(
                    StrategyCapitalAuthorityRecord,
                    strategy.active_capital_authority_id,
                )
                self.assertIsNotNone(authority)
                assert authority is not None
                self.assertEqual(authority.stage, "quarantined")
                self.assertEqual(
                    authority.payload_json["blockers"],
                    ["catalog_authority_refresh_failed"],
                )

                payload["strategies"][0]["capital_authority"]["stage"] = (
                    "shadow_allowed"
                )
                path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertTrue(catalog.refresh(session))
                session.refresh(strategy)
                authority = session.get(
                    StrategyCapitalAuthorityRecord,
                    strategy.active_capital_authority_id,
                )
                assert authority is not None
                self.assertEqual(authority.stage, "shadow_allowed")
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

                legacy = session.execute(
                    select(Strategy).where(Strategy.name == "legacy")
                ).scalar_one_or_none()
                self.assertIsNotNone(legacy)
                self.assertFalse(legacy.enabled)
                authority = session.get(
                    StrategyCapitalAuthorityRecord,
                    legacy.active_capital_authority_id,
                )
                self.assertIsNotNone(authority)
                assert authority is not None
                self.assertEqual(authority.stage, "disabled")
                self.assertEqual(
                    authority.payload_json["blockers"],
                    ["catalog_sync_disabled"],
                )
        finally:
            path.unlink(missing_ok=True)

    def test_disabled_strategy_cannot_hide_broker_authority(self) -> None:
        with self.assertRaisesRegex(
            ValidationError,
            "disabled strategy cannot carry broker capital authority",
        ):
            StrategyConfig.model_validate(
                {
                    "name": "disabled-live",
                    "enabled": False,
                    "capital_authority": {
                        "authority_id": "disabled-live-v1",
                        "strategy_ref": "disabled-live",
                        "candidate_ref": "candidate-1",
                        "evidence_epoch_id": "tee-candidate-1",
                        "stage": "capital_allowed",
                        "account_label": "live",
                        "account_mode": "live",
                        "venue": "alpaca",
                        "allowed_symbols": ["AAPL"],
                        "max_order_notional": "1",
                        "max_gross_notional": "1",
                        "max_net_notional": "1",
                        "max_loss": "1",
                        "max_orders_per_minute": 1,
                        "max_orders_per_session": 1,
                        "session": {
                            "timezone_name": "UTC",
                            "weekdays": [0],
                            "start": "00:00:00",
                            "end": "23:59:00",
                        },
                        "issued_at": "2026-07-13T00:00:00Z",
                        "expires_at": "2026-07-14T00:00:00Z",
                        "proofs": {
                            "policy_digest": "sha256:" + "a" * 64,
                            "evidence_digest": "sha256:" + "a" * 64,
                            "code_commit": "a" * 40,
                            "image_digest": "sha256:" + "a" * 64,
                            "data_digest": "sha256:" + "a" * 64,
                            "execution_digest": "sha256:" + "a" * 64,
                        },
                        "issued_by": "research-owner",
                        "approved_by": "risk-owner",
                        "reduce_only": False,
                    },
                }
            )

    def test_production_catalog_has_only_explicit_safe_authorities(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        manifest = yaml.safe_load(
            (
                repo_root / "argocd/applications/torghut/strategy-configmap.yaml"
            ).read_text(encoding="utf-8")
        )
        embedded = yaml.safe_load(manifest["data"]["strategies.yaml"])
        catalog = StrategyCatalogConfig.model_validate(embedded)

        self.assertEqual(len(catalog.strategies), 14)
        stage_counts: dict[str, int] = {}
        for strategy in catalog.strategies:
            authority = strategy.capital_authority
            self.assertIsNotNone(authority)
            assert authority is not None
            self.assertEqual(authority.strategy_ref, strategy.name)
            self.assertTrue(authority.reduce_only)
            self.assertEqual(authority.account_mode.value, "none")
            self.assertEqual(authority.venue.value, "none")
            stage_counts[authority.stage.value] = (
                stage_counts.get(authority.stage.value, 0) + 1
            )
        self.assertEqual(
            stage_counts,
            {"disabled": 5, "research_only": 6, "shadow_allowed": 3},
        )

    def test_catalog_persists_compiled_strategy_metadata_in_description_bridge(
        self,
    ) -> None:
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
