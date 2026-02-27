from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from tempfile import TemporaryDirectory
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, LLMDecisionReview, Strategy, TradeDecision
from app.trading.llm.dspy_compile.dataset import build_dspy_dataset_artifacts


class TestLLMDSPyDatasetBuilder(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_build_dataset_artifacts_writes_canonical_files(self) -> None:
        now = datetime(2026, 2, 27, 9, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            strategy = self._create_strategy(session)
            self._insert_reviewed_decision(
                session=session,
                strategy_id=str(strategy.id),
                symbol="AAPL",
                created_at=now - timedelta(days=1),
                verdict="approve",
                include_market_context=True,
            )
            self._insert_reviewed_decision(
                session=session,
                strategy_id=str(strategy.id),
                symbol="MSFT",
                created_at=now - timedelta(days=2),
                verdict="veto",
                include_market_context=False,
            )
            self._insert_reviewed_decision(
                session=session,
                strategy_id=str(strategy.id),
                symbol="TSLA",
                created_at=now - timedelta(days=40),
                verdict="adjust",
                include_market_context=True,
            )

            with TemporaryDirectory() as tmp:
                result = build_dspy_dataset_artifacts(
                    session,
                    repository="proompteng/lab",
                    base="main",
                    head="codex/dspy-dataset",
                    artifact_path=tmp,
                    dataset_window="P10D",
                    universe_ref="symbols:AAPL,MSFT",
                    source_refs=["custom.source.test"],
                    sampling_seed="seed-17",
                    window_end=now,
                )

                self.assertEqual(result.total_rows, 2)
                self.assertTrue(result.dataset_path.exists())
                self.assertTrue(result.metadata_path.exists())
                self.assertEqual(
                    sum(result.row_counts_by_split.values()), result.total_rows
                )

                dataset_payload = json.loads(
                    result.dataset_path.read_text(encoding="utf-8")
                )
                metadata_payload = json.loads(
                    result.metadata_path.read_text(encoding="utf-8")
                )

                self.assertEqual(
                    dataset_payload.get("schemaVersion"), "torghut.dspy.dataset.v1"
                )
                rows = dataset_payload.get("rows")
                self.assertIsInstance(rows, list)
                assert isinstance(rows, list)
                self.assertEqual(len(rows), 2)
                symbols = {str(row["decision"]["symbol"]) for row in rows}
                self.assertEqual(symbols, {"AAPL", "MSFT"})
                for row in rows:
                    self.assertIn(row.get("split"), {"train", "eval", "test"})
                    self.assertIn("marketContext", row.get("input", {}))

                self.assertEqual(
                    metadata_payload.get("datasetHash"), result.dataset_hash
                )
                self.assertEqual(
                    metadata_payload.get("stats", {}).get("reviewCount"),
                    result.total_rows,
                )
                self.assertIn(
                    "custom.source.test", metadata_payload.get("sourceRefs", [])
                )

    def test_build_dataset_artifacts_is_deterministic_for_fixed_inputs(self) -> None:
        now = datetime(2026, 2, 27, 9, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            strategy = self._create_strategy(session)
            self._insert_reviewed_decision(
                session=session,
                strategy_id=str(strategy.id),
                symbol="AAPL",
                created_at=now - timedelta(hours=2),
                verdict="approve",
                include_market_context=True,
            )

            with TemporaryDirectory() as tmp:
                first = build_dspy_dataset_artifacts(
                    session,
                    repository="proompteng/lab",
                    base="main",
                    head="codex/dspy-dataset",
                    artifact_path=f"{tmp}/first",
                    dataset_window="PT12H",
                    universe_ref="all",
                    sampling_seed="seed-42",
                    window_end=now,
                )
                second = build_dspy_dataset_artifacts(
                    session,
                    repository="proompteng/lab",
                    base="main",
                    head="codex/dspy-dataset",
                    artifact_path=f"{tmp}/second",
                    dataset_window="PT12H",
                    universe_ref="all",
                    sampling_seed="seed-42",
                    window_end=now,
                )

                self.assertEqual(first.dataset_hash, second.dataset_hash)
                self.assertEqual(first.row_counts_by_split, second.row_counts_by_split)
                self.assertEqual(first.total_rows, second.total_rows)
                self.assertEqual(
                    first.dataset_path.read_text(encoding="utf-8"),
                    second.dataset_path.read_text(encoding="utf-8"),
                )

    def test_build_dataset_artifacts_filters_torghut_equity_enabled_symbols(self) -> None:
        now = datetime(2026, 2, 27, 9, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            enabled_strategy = self._create_strategy(
                session,
                name="enabled-strategy",
                universe_symbols=["AAPL", "MSFT"],
                enabled=True,
            )
            disabled_strategy = self._create_strategy(
                session,
                name="disabled-strategy",
                universe_symbols=["GOOG"],
                enabled=False,
            )

            self._insert_reviewed_decision(
                session=session,
                strategy_id=str(enabled_strategy.id),
                symbol="AAPL",
                created_at=now - timedelta(hours=1),
                verdict="approve",
                include_market_context=True,
            )
            self._insert_reviewed_decision(
                session=session,
                strategy_id=str(enabled_strategy.id),
                symbol="MSFT",
                created_at=now - timedelta(hours=2),
                verdict="approve",
                include_market_context=True,
            )
            self._insert_reviewed_decision(
                session=session,
                strategy_id=str(disabled_strategy.id),
                symbol="GOOG",
                created_at=now - timedelta(hours=3),
                verdict="approve",
                include_market_context=True,
            )

            with TemporaryDirectory() as tmp:
                result = build_dspy_dataset_artifacts(
                    session,
                    repository="proompteng/lab",
                    base="main",
                    head="codex/dspy-dataset",
                    artifact_path=tmp,
                    dataset_window="P10D",
                    universe_ref="torghut:equity:enabled",
                    window_end=now,
                )

                self.assertEqual(result.total_rows, 2)
                dataset_payload = json.loads(
                    result.dataset_path.read_text(encoding="utf-8")
                )
                rows = dataset_payload.get("rows")
                self.assertIsInstance(rows, list)
                assert isinstance(rows, list)
                symbols = {str(row["decision"]["symbol"]) for row in rows}
                self.assertEqual(symbols, {"AAPL", "MSFT"})

    def test_build_dataset_artifacts_rejects_empty_explicit_symbol_filter(self) -> None:
        now = datetime(2026, 2, 27, 9, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            strategy = self._create_strategy(session)
            self._insert_reviewed_decision(
                session=session,
                strategy_id=str(strategy.id),
                symbol="AAPL",
                created_at=now - timedelta(hours=1),
                verdict="approve",
                include_market_context=True,
            )

            with TemporaryDirectory() as tmp:
                with self.assertRaisesRegex(ValueError, "universe_ref_symbols_empty"):
                    build_dspy_dataset_artifacts(
                        session,
                        repository="proompteng/lab",
                        base="main",
                        head="codex/dspy-dataset",
                        artifact_path=tmp,
                        dataset_window="P10D",
                        universe_ref="symbols:   ,  ",
                        window_end=now,
                    )

    def _create_strategy(
        self,
        session: Session,
        *,
        name: str = "test-strategy",
        enabled: bool = True,
        universe_type: str = "equity",
        universe_symbols: list[str] | None = None,
    ) -> Strategy:
        strategy = Strategy(
            name=name,
            description="dataset test strategy",
            enabled=enabled,
            base_timeframe="1m",
            universe_type=universe_type,
            universe_symbols=universe_symbols or ["AAPL", "MSFT", "TSLA"],
        )
        session.add(strategy)
        session.commit()
        return strategy

    def _insert_reviewed_decision(
        self,
        *,
        session: Session,
        strategy_id: str,
        symbol: str,
        created_at: datetime,
        verdict: str,
        include_market_context: bool,
    ) -> None:
        decision = TradeDecision(
            strategy_id=strategy_id,
            alpaca_account_label="paper",
            symbol=symbol,
            timeframe="1m",
            decision_json={
                "action": "buy",
                "qty": "1",
                "order_type": "market",
                "time_in_force": "day",
                "params": {"price": "100"},
            },
            rationale="test decision rationale",
            decision_hash=f"hash-{symbol.lower()}",
            status="planned",
            created_at=created_at,
        )
        session.add(decision)
        session.flush()

        request_json = {
            "decision": {"symbol": symbol, "action": "buy"},
            "policy": {"adjustment_allowed": True},
        }
        if include_market_context:
            request_json["market_context"] = {
                "contextVersion": "torghut.market-context.v1",
                "symbol": symbol,
                "asOfUtc": created_at.isoformat().replace("+00:00", "Z"),
                "domains": {
                    "fundamentals": {
                        "domain": "fundamentals",
                        "state": "ok",
                        "sourceCount": 2,
                        "qualityScore": 0.8,
                        "riskFlags": [],
                    }
                },
            }

        review = LLMDecisionReview(
            trade_decision_id=decision.id,
            model="gpt-5.3-codex",
            prompt_version="v1",
            input_json=request_json,
            response_json={"verdict": verdict, "rationale": "ok"},
            verdict=verdict,
            confidence=Decimal("0.85"),
            adjusted_qty=None,
            adjusted_order_type=None,
            rationale="review rationale",
            risk_flags=["risk_a"],
            tokens_prompt=120,
            tokens_completion=80,
            created_at=created_at + timedelta(seconds=1),
        )
        session.add(review)
        session.commit()
