from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import json
from types import SimpleNamespace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Mapping, cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, StrategyRuntimeLedgerBucket
from app.trading.runtime_ledger import RuntimeLedgerBucket
from scripts.import_hypothesis_runtime_windows import (
    EXECUTION_ELIGIBLE_DECISION_STATUSES,
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    POST_COST_BASIS_RUNTIME_LEDGER,
    POST_COST_BASIS_SIMULATION_REPORT,
    POST_COST_BASIS_TCA_PROXY,
    _alpaca_2026_equity_fee_schedule_hash,
    _build_realized_strategy_pnl_rows,
    _execution_signed_qty,
    _fill_quantity_basis,
    _first_bool,
    _first_lineage_digest,
    _load_json_artifact,
    _load_report_post_cost_expectancy_bps,
    _order_feed_fill_delta_blockers,
    _nonnegative_int,
    _order_lifecycle_query_row,
    _parse_args,
    _parse_dt_or_none,
    _parse_target_metadata,
    _query_timestamps,
    _row_payloads,
    _runtime_ledger_bucket_profit_proof_blockers,
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_event_type,
    _runtime_lifecycle_ledger_row,
    _runtime_ledger_profit_proof_present,
    _runtime_observation_authority_payload,
    _runtime_decision_rows_before_bucket,
    _runtime_execution_ledger_fill_from_row,
    _runtime_ledger_target_metadata_blockers,
    _runtime_ledger_tca_row_from_bucket,
    _runtime_ledger_tca_materialization_metadata,
    _runtime_ledger_tca_rows_from_durable_buckets,
    _runtime_ledger_tca_rows_from_source_dsn,
    _runtime_ledger_tca_rows_from_artifacts,
    _runtime_window_import_proof_hygiene_blockers,
    _runtime_window_source_kind_is_informational,
    _source_kind_allows_runtime_ledger_materialization,
    _source_activity_diagnostics_blockers,
    _source_row_matches_lineage,
    _persistence_session,
    _source_activity_missing_summary,
    _source_backed_fill_lifecycle_rows,
    _source_backed_order_lifecycle_rows,
    _source_decision_mode,
    _source_decision_mode_counts,
    _source_decision_rows_profit_proof_eligible,
    _source_order_feed_payload_delta_fill,
    _required_order_lifecycle_source_row_count,
    _stable_payload_digest,
    _strategy_name_candidates,
    _sqlalchemy_dsn,
    _target_persistence_dsn,
    main,
)


class _FakeCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self._results = [
            [
                (
                    "decision-id-1",
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "intraday_tsmom_v1@paper",
                    "decision-sha",
                    {},
                )
            ],
            [
                (
                    "execution-id-1",
                    "decision-id-1",
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "AAPL",
                    "buy",
                    Decimal("1"),
                    Decimal("100"),
                    Decimal("0.01"),
                    {
                        "cost_amount": "0.01",
                        "cost_basis": "broker_reported_commission_and_fees",
                    },
                    {},
                    "TORGHUT_SIM",
                    "intraday_tsmom_v1@paper",
                    "decision-sha",
                    {},
                    "alpaca-order-1",
                    "client-order-1",
                    "filled",
                )
            ],
            [
                (
                    "event-id-1",
                    "decision-id-1",
                    "execution-id-1",
                    datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "intraday_tsmom_v1@paper",
                    "decision-sha",
                    {},
                    "alpaca-order-1",
                    "client-order-1",
                    "new",
                    "new",
                    "event-fingerprint-1",
                    "alpaca-trade-updates",
                    0,
                    1,
                    {
                        "execution_policy": {"selected_order_type": "market"},
                        "cost_model": {"source": "broker_reported"},
                    },
                    {
                        "cost_amount": "0.01",
                        "cost_basis": "broker_reported_commission_and_fees",
                    },
                    {
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                    },
                )
            ],
            [
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
                    Decimal("1.25"),
                    Decimal("0.50"),
                    "decision-sha",
                    {},
                )
            ],
        ]

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.executed.append((query, params))

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._results.pop(0)


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> _FakeConnection:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        return self._cursor


class _SourceLedgerCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self._results = [
            [
                (
                    "runtime-proof-source",
                    "H-TSMOM-LIQ-01",
                    "H-TSMOM-LIQ-01",
                    "paper",
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    "TORGHUT_SIM",
                    "intraday-tsmom-profit-v3",
                    "intraday_tsmom_consistent",
                    2,
                    2,
                    2,
                    0,
                    0,
                    0,
                    1,
                    0,
                    Decimal("200"),
                    Decimal("1"),
                    Decimal("0.20"),
                    Decimal("0.80"),
                    Decimal("40"),
                    {"policy-sha": 2},
                    {"cost-sha": 2},
                    {"lineage-sha": 2},
                    [],
                    "torghut.exact_replay_ledger.v1",
                    POST_COST_BASIS_RUNTIME_LEDGER,
                    {
                        "cost_basis_counts": {"broker_reported_commission_and_fees": 2},
                        "source_decision_mode_counts": {"strategy_signal_paper": 2},
                        "source_window_start": "2026-03-06T14:30:00+00:00",
                        "source_window_end": "2026-03-06T15:00:00+00:00",
                        "source_refs": [
                            "postgres:trade_decisions",
                            "postgres:executions",
                            "postgres:execution_order_events",
                            "postgres:order_feed_source_windows",
                        ],
                        "source_row_counts": {
                            "trade_decisions": 2,
                            "executions": 2,
                            "execution_order_events": 4,
                            "order_feed_source_windows": 4,
                        },
                        "source_window_ids": [
                            "source-window-new-buy",
                            "source-window-fill-buy",
                            "source-window-new-sell",
                            "source-window-fill-sell",
                        ],
                        "trade_decision_ids": ["decision-buy", "decision-sell"],
                        "execution_ids": ["execution-buy", "execution-sell"],
                        "execution_order_event_ids": [
                            "event-new-buy",
                            "event-fill-buy",
                            "event-new-sell",
                            "event-fill-sell",
                        ],
                        "source_offsets": [
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 100,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 101,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 102,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 103,
                            },
                        ],
                        "source_materialization": "execution_order_events",
                        "authority_class": "runtime_order_feed_execution_source",
                        "profit_proof_eligible": True,
                    },
                )
            ]
        ]

    def __enter__(self) -> _SourceLedgerCursor:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.executed.append((query, params))

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._results.pop(0)


class _SourceLedgerConnection:
    def __init__(self, cursor: _SourceLedgerCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> _SourceLedgerConnection:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def cursor(self) -> _SourceLedgerCursor:
        return self._cursor


class _FakeSession:
    def __init__(self) -> None:
        self.committed = False

    def __enter__(self) -> _FakeSession:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def commit(self) -> None:
        self.committed = True


def _complete_runtime_ledger_bucket(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "fill_count": 2,
        "decision_count": 2,
        "submitted_order_count": 2,
        "closed_trade_count": 1,
        "open_position_count": 0,
        "filled_notional": "200",
        "gross_strategy_pnl": "1",
        "cost_amount": "0.20",
        "net_strategy_pnl_after_costs": "0.80",
        "post_cost_expectancy_bps": "40",
        "ledger_schema_version": "torghut.exact_replay_ledger.v1",
        "pnl_basis": POST_COST_BASIS_RUNTIME_LEDGER,
        "execution_policy_hash_counts": {"policy-sha": 2},
        "cost_model_hash_counts": {"cost-sha": 2},
        "lineage_hash_counts": {"lineage-sha": 2},
        "source_decision_mode_counts": {"strategy_signal_paper": 2},
        "source_window_start": "2026-03-06T14:30:00+00:00",
        "source_window_end": "2026-03-06T15:00:00+00:00",
        "source_refs": [
            "postgres:trade_decisions",
            "postgres:executions",
            "postgres:execution_order_events",
            "postgres:order_feed_source_windows",
        ],
        "source_row_counts": {
            "trade_decisions": 2,
            "executions": 2,
            "execution_order_events": 4,
            "order_feed_source_windows": 4,
        },
        "source_window_ids": [
            "source-window-new-buy",
            "source-window-fill-buy",
            "source-window-new-sell",
            "source-window-fill-sell",
        ],
        "trade_decision_ids": ["decision-buy", "decision-sell"],
        "execution_ids": ["execution-buy", "execution-sell"],
        "execution_order_event_ids": [
            "event-new-buy",
            "event-fill-buy",
            "event-new-sell",
            "event-fill-sell",
        ],
        "source_offsets": [
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 102},
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": 103},
        ],
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
        "authority_reason": "event_sourced_runtime_ledger_profit_proof",
        "pnl_derivation": "execution_order_events_runtime_ledger",
        "profit_proof_eligible": True,
        "blockers": [],
    }
    payload.update(overrides)
    return payload


class TestImportHypothesisRuntimeWindows(TestCase):
    def test_sqlalchemy_dsn_normalizes_postgres_urls(self) -> None:
        self.assertEqual(
            _sqlalchemy_dsn("postgresql://user:pass@postgres:5432/torghut_sim_default"),
            "postgresql+psycopg://user:pass@postgres:5432/torghut_sim_default",
        )
        self.assertEqual(
            _sqlalchemy_dsn("postgres://user:pass@postgres:5432/torghut"),
            "postgresql+psycopg://user:pass@postgres:5432/torghut",
        )

    def test_target_persistence_dsn_requires_configured_env(self) -> None:
        args = SimpleNamespace(target_dsn="", target_dsn_env="SIM_DB_DSN")

        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(
                RuntimeError, "target_dsn_not_configured:SIM_DB_DSN"
            ):
                _target_persistence_dsn(args)

    def test_persistence_session_uses_target_dsn_env(self) -> None:
        class _FakeEngine:
            def __init__(self) -> None:
                self.disposed = False

            def dispose(self) -> None:
                self.disposed = True

        fake_engine = _FakeEngine()
        fake_session = _FakeSession()
        sessionmaker_calls: list[dict[str, object]] = []

        def fake_sessionmaker(**kwargs: object):
            sessionmaker_calls.append(dict(kwargs))

            def factory() -> _FakeSession:
                return fake_session

            return factory

        args = SimpleNamespace(target_dsn="", target_dsn_env="SIM_DB_DSN")

        with (
            patch.dict(
                "os.environ",
                {
                    "SIM_DB_DSN": "postgresql://user:pass@postgres:5432/torghut_sim_default"
                },
                clear=True,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.create_engine",
                return_value=fake_engine,
            ) as create_engine_mock,
            patch(
                "scripts.import_hypothesis_runtime_windows.sessionmaker",
                side_effect=fake_sessionmaker,
            ),
        ):
            with _persistence_session(args) as session:
                self.assertIs(session, fake_session)

        create_engine_mock.assert_called_once_with(
            "postgresql+psycopg://user:pass@postgres:5432/torghut_sim_default",
            pool_pre_ping=True,
            future=True,
        )
        self.assertEqual(sessionmaker_calls[0]["bind"], fake_engine)
        self.assertTrue(fake_engine.disposed)

    def test_runtime_observation_authority_requires_runtime_ledger_profit_proof(
        self,
    ) -> None:
        payload = _runtime_observation_authority_payload(
            source_kind="live_runtime_observed",
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("12"),
                    "post_cost_expectancy_basis": POST_COST_BASIS_TCA_PROXY,
                    "post_cost_promotion_eligible": False,
                }
            ],
        )

        self.assertEqual(payload["authoritative"], False)
        self.assertEqual(
            payload["authority_reason"],
            "runtime_without_runtime_ledger_profit_proof",
        )
        self.assertEqual(payload["promotion_authority"], "blocked")
        self.assertEqual(payload["runtime_ledger_profit_proof_present"], False)

    def test_runtime_observation_authority_accepts_runtime_ledger_profit_proof(
        self,
    ) -> None:
        payload = _runtime_observation_authority_payload(
            source_kind="live_runtime_observed",
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "post_cost_expectancy_bps": Decimal("40"),
                    "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                    "post_cost_promotion_eligible": True,
                    "runtime_ledger_bucket": _complete_runtime_ledger_bucket(),
                }
            ],
        )

        self.assertEqual(payload["authoritative"], True)
        self.assertEqual(payload["authority_reason"], "runtime_ledger_profit_proof")
        self.assertEqual(payload["promotion_authority"], "runtime_ledger")
        self.assertEqual(payload["runtime_ledger_profit_proof_present"], True)

    def test_runtime_observation_authority_keeps_simulation_replay_only(
        self,
    ) -> None:
        payload = _runtime_observation_authority_payload(
            source_kind="simulation_paper_runtime",
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "post_cost_expectancy_bps": Decimal("40"),
                    "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                    "post_cost_promotion_eligible": True,
                    "runtime_ledger_bucket": _complete_runtime_ledger_bucket(),
                }
            ],
        )

        self.assertEqual(payload["authoritative"], False)
        self.assertEqual(payload["authority_reason"], "simulation_source_replay_only")
        self.assertEqual(payload["promotion_authority"], "blocked")
        self.assertEqual(payload["runtime_ledger_profit_proof_present"], True)

    def test_parse_args_accepts_dataset_snapshot_ref(self) -> None:
        with patch(
            "sys.argv",
            [
                "import_hypothesis_runtime_windows.py",
                "--run-id",
                "run-1",
                "--candidate-id",
                "cand-1",
                "--hypothesis-id",
                "H-CONT-01",
                "--observed-stage",
                "paper",
                "--source-dsn",
                "postgresql://example",
                "--strategy-name",
                "intraday-tsmom-profit-v2",
                "--account-label",
                "TORGHUT_SIM",
                "--window-start",
                "2026-03-06T14:30:00Z",
                "--window-end",
                "2026-03-06T15:00:00Z",
                "--dataset-snapshot-ref",
                "torghut-runtime-window-cand-1",
                "--artifact-ref",
                "s3://torghut-runtime/cand-1/report.json",
                "--target-metadata-json",
                '{"paper_probation_authorized":true}',
                "--json",
            ],
        ):
            args = _parse_args()

        self.assertEqual(args.run_id, "run-1")
        self.assertEqual(args.dataset_snapshot_ref, "torghut-runtime-window-cand-1")
        self.assertEqual(args.artifact_ref, ["s3://torghut-runtime/cand-1/report.json"])
        self.assertEqual(
            args.target_metadata_json, '{"paper_probation_authorized":true}'
        )
        self.assertEqual(args.json, True)

    def test_source_row_lineage_accepts_plural_target_plan_ids(self) -> None:
        row = {
            "decision_json": {
                "params": {
                    "paper_route_probe": {
                        "source_candidate_ids": ["candidate-pairs-a"],
                        "source_hypothesis_ids": ["H-PAIRS-01"],
                    }
                }
            }
        }

        self.assertTrue(
            _source_row_matches_lineage(
                row,
                candidate_id="candidate-pairs-a",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )
        )
        self.assertFalse(
            _source_row_matches_lineage(
                row,
                candidate_id="candidate-other",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )
        )

    def test_runtime_ledger_profit_proof_rejects_malformed_bucket_payload(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_ledger_profit_proof_present(
                [
                    {
                        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                        "runtime_ledger_bucket": "not-a-bucket",
                    }
                ]
            ),
            False,
        )

    def test_runtime_ledger_profit_proof_rejects_incomplete_bucket_payload(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_ledger_profit_proof_present(
                [
                    {
                        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                        "runtime_ledger_bucket": {
                            "fill_count": 0,
                            "filled_notional": "0",
                            "post_cost_expectancy_bps": None,
                            "blockers": ["runtime_ledger_filled_notional_zero"],
                        },
                    }
                ]
            ),
            False,
        )

    def test_runtime_ledger_profit_proof_requires_lifecycle_and_lineage(
        self,
    ) -> None:
        incomplete = _complete_runtime_ledger_bucket(lineage_hash_counts={})
        complete = _complete_runtime_ledger_bucket()

        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(incomplete))
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(complete))
        self.assertFalse(
            _runtime_ledger_profit_proof_present(
                [
                    {
                        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                        "runtime_ledger_bucket": incomplete,
                    }
                ]
            )
        )
        self.assertTrue(
            _runtime_ledger_profit_proof_present(
                [
                    {
                        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                        "runtime_ledger_bucket": complete,
                    }
                ]
            )
        )

    def test_runtime_ledger_profit_proof_rejects_each_incomplete_proof_field(
        self,
    ) -> None:
        invalid_cases = {
            "invalid_pnl_basis": {"pnl_basis": POST_COST_BASIS_SIMULATION_REPORT},
            "invalid_schema": {"ledger_schema_version": "torghut.loose_ledger.v0"},
            "explicit_blocker": {"blockers": ["runtime_ledger_incomplete"]},
            "missing_fills": {"fill_count": 0},
            "missing_decisions": {"decision_count": 0},
            "missing_submitted_orders": {"submitted_order_count": 0},
            "missing_closed_trades": {"closed_trade_count": 0},
            "missing_open_position_count": {"open_position_count": None},
            "unclosed_position": {"open_position_count": 1},
            "missing_filled_notional": {"filled_notional": "0"},
            "missing_cost": {"cost_amount": None},
            "negative_cost": {"cost_amount": "-0.01"},
            "missing_expectancy": {"post_cost_expectancy_bps": None},
            "missing_execution_hash": {"execution_policy_hash_counts": "bad-shape"},
            "missing_cost_hash": {"cost_model_hash_counts": {}},
            "missing_lineage_hash": {"lineage_hash_counts": {}},
        }

        for name, overrides in invalid_cases.items():
            with self.subTest(name=name):
                self.assertFalse(
                    _runtime_ledger_bucket_profit_proof_present(
                        _complete_runtime_ledger_bucket(**overrides)
                    )
                )

    def test_runtime_ledger_profit_proof_blockers_name_missing_dimensions(
        self,
    ) -> None:
        blockers = _runtime_ledger_bucket_profit_proof_blockers(
            _complete_runtime_ledger_bucket(
                fill_count=0,
                submitted_order_count=0,
                closed_trade_count=0,
                open_position_count=1,
                cost_amount=None,
                cost_model_hash_counts={},
                lineage_hash_counts={},
                source_decision_mode_counts={"route_acquisition_probe": 2},
            )
        )

        self.assertIn("runtime_fills_missing", blockers)
        self.assertIn("submitted_order_lifecycle_missing", blockers)
        self.assertIn("closed_round_trip_missing", blockers)
        self.assertIn("unclosed_position", blockers)
        self.assertIn("runtime_ledger_cost_amount_missing", blockers)
        self.assertIn("runtime_ledger_cost_model_hash_missing", blockers)
        self.assertIn("runtime_ledger_lineage_hash_missing", blockers)
        self.assertIn("source_decision_mode_not_profit_proof_eligible", blockers)

    def test_runtime_ledger_profit_proof_distinguishes_diagnostic_expectancy(
        self,
    ) -> None:
        blockers = _runtime_ledger_bucket_profit_proof_blockers(
            _complete_runtime_ledger_bucket(
                open_position_count=1,
                post_cost_expectancy_bps=None,
                diagnostic_closed_trade_expectancy_bps="282.5",
                diagnostic_closed_trade_expectancy_basis=(
                    "realized_closed_trips_after_explicit_costs_not_promotion_grade"
                ),
            )
        )

        self.assertIn("unclosed_position", blockers)
        self.assertIn(
            "runtime_ledger_post_cost_expectancy_not_promotion_grade", blockers
        )
        self.assertNotIn("runtime_ledger_post_cost_expectancy_missing", blockers)
        self.assertFalse(
            _runtime_ledger_bucket_profit_proof_present(
                _complete_runtime_ledger_bucket(
                    open_position_count=1,
                    post_cost_expectancy_bps=None,
                    diagnostic_closed_trade_expectancy_bps="282.5",
                )
            )
        )

    def test_runtime_ledger_profit_proof_rejects_missing_source_decision_evidence(
        self,
    ) -> None:
        bucket = _complete_runtime_ledger_bucket(
            source_decision_mode_counts={},
            profit_proof_eligible=None,
        )

        self.assertIn(
            "source_decision_mode_profit_proof_missing",
            _runtime_ledger_bucket_profit_proof_blockers(bucket),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_runtime_ledger_profit_proof_rejects_missing_source_window_or_refs(
        self,
    ) -> None:
        missing_window = _complete_runtime_ledger_bucket(
            source_window_start=None,
            source_window_end=None,
        )
        missing_refs = _complete_runtime_ledger_bucket(
            source_refs=[],
            source_ref=None,
            source_row_counts={},
        )

        self.assertIn(
            "runtime_ledger_source_window_missing",
            _runtime_ledger_bucket_profit_proof_blockers(missing_window),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(missing_window))
        self.assertIn(
            "runtime_ledger_source_refs_missing",
            _runtime_ledger_bucket_profit_proof_blockers(missing_refs),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(missing_refs))

    def test_runtime_ledger_profit_proof_rejects_aggregate_only_source_refs(
        self,
    ) -> None:
        aggregate_only = _complete_runtime_ledger_bucket(
            source_window_ids=[],
            trade_decision_ids=[],
            execution_ids=[],
            execution_order_event_ids=[],
            source_offsets=[],
            source_materialization=None,
            authority_class=None,
            authority_reason=None,
            pnl_derivation=None,
        )

        blockers = _runtime_ledger_bucket_profit_proof_blockers(aggregate_only)

        self.assertIn("runtime_ledger_trade_decision_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_order_event_refs_missing", blockers)
        self.assertIn("runtime_ledger_source_window_ids_missing", blockers)
        self.assertIn("runtime_ledger_source_offsets_missing", blockers)
        self.assertIn("runtime_ledger_source_materialization_missing", blockers)
        self.assertIn("runtime_ledger_authority_class_missing", blockers)
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(aggregate_only))

    def test_runtime_ledger_profit_proof_rejects_modeled_cost_basis(
        self,
    ) -> None:
        for overrides in (
            {"cost_basis": "modeled_paper_cost_budget"},
            {"cost_basis_counts": {"modeled_paper_cost_budget": 1}},
            {"cost_basis_counts": {"decision_impact_assumptions_total_cost_bps": 2}},
        ):
            with self.subTest(overrides=overrides):
                self.assertFalse(
                    _runtime_ledger_bucket_profit_proof_present(
                        _complete_runtime_ledger_bucket(**overrides)
                    )
                )

    def test_runtime_ledger_profit_proof_rejects_route_acquisition_source_mode(
        self,
    ) -> None:
        self.assertFalse(
            _runtime_ledger_bucket_profit_proof_present(
                _complete_runtime_ledger_bucket(
                    source_decision_mode_counts={"route_acquisition_probe": 2}
                )
            )
        )
        self.assertFalse(
            _runtime_ledger_bucket_profit_proof_present(
                _complete_runtime_ledger_bucket(
                    source_decision_mode="route_acquisition_probe"
                )
            )
        )
        self.assertFalse(
            _runtime_ledger_bucket_profit_proof_present(
                _complete_runtime_ledger_bucket(profit_proof_eligible=False)
            )
        )
        self.assertTrue(
            _runtime_ledger_bucket_profit_proof_present(
                _complete_runtime_ledger_bucket(
                    source_decision_mode_counts={"strategy_signal_paper": 2}
                )
            )
        )

    def test_source_decision_helpers_normalize_counts_and_profit_proof_flags(
        self,
    ) -> None:
        self.assertTrue(
            _first_bool(
                {"profit_proof_eligible": Decimal("1")}, "profit_proof_eligible"
            )
        )
        self.assertTrue(
            _first_bool({"profit_proof_eligible": "yes"}, "profit_proof_eligible")
        )
        self.assertFalse(
            _first_bool({"profit_proof_eligible": "blocked"}, "profit_proof_eligible")
        )
        self.assertEqual(
            _source_decision_mode(
                {"source_decision_mode": "paper-route-target-plan-source-decision"}
            ),
            "route_acquisition_probe",
        )
        self.assertEqual(
            _source_decision_mode({"mode": "strategy_signal_paper"}),
            "strategy_signal_paper",
        )
        self.assertIsNone(
            _source_decision_mode(
                {
                    "decision_json": {
                        "params": {"strategy_runtime": {"mode": "scheduler_v3"}}
                    }
                }
            )
        )
        self.assertEqual(
            _source_decision_mode_counts(
                [
                    {"source_decision_mode": "route_acquisition_probe"},
                    {"mode": "strategy_signal_paper"},
                    {"source_decision_mode": ""},
                ]
            ),
            {"route_acquisition_probe": 1, "strategy_signal_paper": 1},
        )
        self.assertFalse(
            _source_decision_rows_profit_proof_eligible(
                [{"source_decision_mode": "route_acquisition_probe"}]
            )
        )
        self.assertFalse(
            _source_decision_rows_profit_proof_eligible(
                [{"profit_proof_eligible": "failed"}]
            )
        )
        self.assertTrue(
            _source_decision_rows_profit_proof_eligible(
                [
                    {
                        "source_decision_mode": "strategy_signal_paper",
                        "profit_proof_eligible": True,
                    }
                ]
            )
        )

    def test_source_decision_helpers_prefer_strategy_signal_over_nested_probe(
        self,
    ) -> None:
        row = {
            "decision_json": {
                "params": {
                    "paper_route_probe": {
                        "source_decision_mode": "route_acquisition_probe",
                        "profit_proof_eligible": False,
                    }
                },
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
                "source_candidate_ids": ["c88421d619759b2cfaa6f4d0"],
                "source_hypothesis_ids": ["H-PAIRS-01"],
                "strategy_signal_paper": {
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                },
            }
        }

        self.assertEqual(_source_decision_mode(row), "strategy_signal_paper")
        self.assertEqual(
            _source_decision_mode_counts([row]),
            {"strategy_signal_paper": 1},
        )
        self.assertTrue(_source_decision_rows_profit_proof_eligible([row]))
        self.assertTrue(
            _source_row_matches_lineage(
                row,
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )
        )

    def test_source_decision_helpers_prefer_params_signal_over_nested_probe(
        self,
    ) -> None:
        row = {
            "decision_json": {
                "params": {
                    "strategy_runtime": {"mode": "scheduler_v3"},
                    "paper_route_probe": {
                        "source_decision_mode": "route_acquisition_probe",
                        "profit_proof_eligible": False,
                    },
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "source_candidate_ids": ["c88421d619759b2cfaa6f4d0"],
                    "source_hypothesis_ids": ["H-PAIRS-01"],
                    "strategy_signal_paper": {
                        "source_decision_mode": "strategy_signal_paper",
                        "profit_proof_eligible": True,
                    },
                }
            }
        }

        self.assertEqual(_source_decision_mode(row), "strategy_signal_paper")
        self.assertEqual(
            _source_decision_mode_counts([row]),
            {"strategy_signal_paper": 1},
        )
        self.assertTrue(_source_decision_rows_profit_proof_eligible([row]))
        self.assertTrue(
            _source_row_matches_lineage(
                row,
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )
        )

    def test_runtime_ledger_tca_rows_from_durable_buckets_queries_matching_proof(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with session_local() as session:
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="runtime-proof-1",
                    candidate_id="H-TSMOM-LIQ-01",
                    hypothesis_id="H-TSMOM-LIQ-01",
                    observed_stage="paper",
                    bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    account_label="TORGHUT_SIM",
                    runtime_strategy_name="intraday-tsmom-profit-v3",
                    strategy_family="intraday_tsmom_consistent",
                    fill_count=2,
                    decision_count=2,
                    submitted_order_count=2,
                    cancelled_order_count=0,
                    rejected_order_count=0,
                    unfilled_order_count=0,
                    closed_trade_count=1,
                    open_position_count=0,
                    filled_notional=Decimal("200"),
                    gross_strategy_pnl=Decimal("1"),
                    cost_amount=Decimal("0.20"),
                    net_strategy_pnl_after_costs=Decimal("0.80"),
                    post_cost_expectancy_bps=Decimal("40"),
                    ledger_schema_version="torghut.exact_replay_ledger.v1",
                    pnl_basis=POST_COST_BASIS_RUNTIME_LEDGER,
                    execution_policy_hash_counts={"policy-sha": 2},
                    cost_model_hash_counts={"cost-sha": 2},
                    lineage_hash_counts={"lineage-sha": 2},
                    blockers_json=[],
                    payload_json={
                        "source_decision_mode_counts": {"strategy_signal_paper": 2},
                        "source_window_start": "2026-03-06T14:30:00+00:00",
                        "source_window_end": "2026-03-06T15:00:00+00:00",
                        "source_refs": [
                            "postgres:trade_decisions",
                            "postgres:executions",
                            "postgres:execution_order_events",
                            "postgres:order_feed_source_windows",
                        ],
                        "source_row_counts": {
                            "trade_decisions": 2,
                            "executions": 2,
                            "execution_order_events": 4,
                            "order_feed_source_windows": 4,
                        },
                        "source_window_ids": [
                            "source-window-new-buy",
                            "source-window-fill-buy",
                            "source-window-new-sell",
                            "source-window-fill-sell",
                        ],
                        "trade_decision_ids": ["decision-buy", "decision-sell"],
                        "execution_ids": ["execution-buy", "execution-sell"],
                        "execution_order_event_ids": [
                            "event-new-buy",
                            "event-fill-buy",
                            "event-new-sell",
                            "event-fill-sell",
                        ],
                        "source_offsets": [
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 100,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 101,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 102,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 103,
                            },
                        ],
                        "source_materialization": "execution_order_events",
                        "authority_class": "runtime_order_feed_execution_source",
                        "profit_proof_eligible": True,
                    },
                )
            )
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="runtime-proof-other",
                    candidate_id="other-candidate",
                    hypothesis_id="H-TSMOM-LIQ-01",
                    observed_stage="paper",
                    bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    runtime_strategy_name="intraday-tsmom-profit-v3",
                    fill_count=2,
                    decision_count=2,
                    submitted_order_count=2,
                    closed_trade_count=1,
                    open_position_count=0,
                    filled_notional=Decimal("200"),
                    gross_strategy_pnl=Decimal("1"),
                    cost_amount=Decimal("0.20"),
                    net_strategy_pnl_after_costs=Decimal("0.80"),
                    post_cost_expectancy_bps=Decimal("40"),
                    ledger_schema_version="torghut.exact_replay_ledger.v1",
                    pnl_basis=POST_COST_BASIS_RUNTIME_LEDGER,
                )
            )
            session.commit()

            rows, metadata = _runtime_ledger_tca_rows_from_durable_buckets(
                session=session,
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_names=["intraday-tsmom-profit-v3"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(metadata["runtime_ledger_durable_bucket_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_durable_bucket_run_ids"],
            ["runtime-proof-1"],
        )
        self.assertEqual(metadata["runtime_ledger_durable_bucket_fill_count"], 2)
        self.assertEqual(
            metadata["runtime_ledger_durable_bucket_profit_proof_count"],
            1,
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["run_id"], "runtime-proof-1")
        self.assertEqual(bucket["closed_trade_count"], 1)

    def test_runtime_ledger_tca_rows_from_durable_buckets_block_aggregate_only_proof(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with session_local() as session:
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="runtime-aggregate-only",
                    candidate_id="H-TSMOM-LIQ-01",
                    hypothesis_id="H-TSMOM-LIQ-01",
                    observed_stage="paper",
                    bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    account_label="TORGHUT_SIM",
                    runtime_strategy_name="intraday-tsmom-profit-v3",
                    strategy_family="intraday_tsmom_consistent",
                    fill_count=2,
                    decision_count=2,
                    submitted_order_count=2,
                    cancelled_order_count=0,
                    rejected_order_count=0,
                    unfilled_order_count=0,
                    closed_trade_count=1,
                    open_position_count=0,
                    filled_notional=Decimal("200"),
                    gross_strategy_pnl=Decimal("1"),
                    cost_amount=Decimal("0.20"),
                    net_strategy_pnl_after_costs=Decimal("0.80"),
                    post_cost_expectancy_bps=Decimal("40"),
                    ledger_schema_version="torghut.exact_replay_ledger.v1",
                    pnl_basis=POST_COST_BASIS_RUNTIME_LEDGER,
                    execution_policy_hash_counts={"policy-sha": 2},
                    cost_model_hash_counts={"cost-sha": 2},
                    lineage_hash_counts={"lineage-sha": 2},
                    blockers_json=[],
                    payload_json={
                        "source_decision_mode_counts": {"strategy_signal_paper": 2},
                        "source_window_start": "2026-03-06T14:30:00+00:00",
                        "source_window_end": "2026-03-06T15:00:00+00:00",
                        "source_refs": [
                            "postgres:trade_decisions",
                            "postgres:executions",
                            "postgres:execution_order_events",
                        ],
                        "source_row_counts": {
                            "trade_decisions": 2,
                            "executions": 2,
                            "execution_order_events": 4,
                        },
                        "profit_proof_eligible": True,
                    },
                )
            )
            session.commit()

            rows, metadata = _runtime_ledger_tca_rows_from_durable_buckets(
                session=session,
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_names=["intraday-tsmom-profit-v3"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(metadata["runtime_ledger_durable_bucket_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_durable_bucket_profit_proof_count"],
            0,
        )
        self.assertIn(
            "runtime_ledger_execution_order_event_refs_missing",
            metadata["runtime_ledger_durable_bucket_profit_proof_blockers"],
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertIn(
            "runtime_ledger_authority_class_missing",
            rows[0]["runtime_ledger_blockers"],
        )

    def test_runtime_ledger_tca_rows_from_source_dsn_queries_matching_proof(
        self,
    ) -> None:
        cursor = _SourceLedgerCursor()
        connection = _SourceLedgerConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            rows, metadata = _runtime_ledger_tca_rows_from_source_dsn(
                dsn="postgresql://source",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_names=["intraday-tsmom-profit-v3"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(metadata["runtime_ledger_source_bucket_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_source_bucket_run_ids"],
            ["runtime-proof-source"],
        )
        self.assertEqual(metadata["runtime_ledger_source_bucket_fill_count"], 2)
        self.assertEqual(metadata["runtime_ledger_source_bucket_profit_proof_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_source_bucket_profit_proof_blockers"],
            [],
        )
        self.assertEqual(
            metadata["runtime_ledger_source_bucket_candidate_id"],
            "H-TSMOM-LIQ-01",
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_RUNTIME_LEDGER,
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["run_id"], "runtime-proof-source")
        self.assertEqual(
            bucket["cost_basis_counts"], {"broker_reported_commission_and_fees": 2}
        )
        self.assertEqual(
            bucket["source_decision_mode_counts"], {"strategy_signal_paper": 2}
        )
        self.assertEqual(bucket["profit_proof_eligible"], True)
        self.assertEqual(bucket["bucket_started_at"], "2026-03-06T14:30:00+00:00")
        query, params = cursor.executed[0]
        self.assertIn("from strategy_runtime_ledger_buckets", query)
        self.assertIn("runtime_strategy_name = any(%s)", query)
        self.assertEqual(
            params,
            (
                "H-TSMOM-LIQ-01",
                "paper",
                window_end,
                window_start,
                "H-TSMOM-LIQ-01",
                "TORGHUT_SIM",
                ["intraday-tsmom-profit-v3"],
            ),
        )

    def test_parse_target_metadata_requires_json_mapping(self) -> None:
        self.assertEqual(_parse_target_metadata(""), {})
        self.assertEqual(
            _parse_target_metadata('{"paper_probation_authorized": true}'),
            {"paper_probation_authorized": True},
        )
        with self.assertRaisesRegex(RuntimeError, "target_metadata_json_invalid"):
            _parse_target_metadata("{")
        with self.assertRaisesRegex(RuntimeError, "target_metadata_json_not_mapping"):
            _parse_target_metadata("[]")

    def test_runtime_ledger_target_metadata_blockers_fail_closed_on_mismatch(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        artifact_metadata = {
            "runtime_ledger_artifact_refs": ["exact-ledger.json"],
            "runtime_ledger_artifact_authority_class": (
                "exact_replay_artifact_only_not_live"
            ),
            "runtime_ledger_artifact_candidate_id": "cand-one",
            "runtime_ledger_artifact_row_count": 6,
            "runtime_ledger_artifact_fill_count": 2,
            "runtime_ledger_artifact_window_weekday_count": 5,
        }

        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata={
                    "runtime_ledger_artifact_refs": ["exact-ledger.json"],
                    "candidate_id": "cand-one",
                    "runtime_ledger_artifact_row_count": 6,
                    "runtime_ledger_artifact_fill_count": 2,
                    "replay_window_weekday_count": 5,
                    "replay_min_window_weekday_count": 5,
                    "window_start": "2026-03-06T14:30:00+00:00",
                    "window_end": "2026-03-06T15:00:00+00:00",
                },
                runtime_ledger_artifact_metadata=artifact_metadata,
                window_start=window_start,
                window_end=window_end,
            ),
            [],
        )
        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata={
                    "runtime_ledger_artifact_refs": ["different-ledger.json"],
                    "candidate_id": "different-cand",
                    "runtime_ledger_artifact_row_count": 7,
                    "runtime_ledger_artifact_fill_count": 3,
                    "replay_window_weekday_count": 4,
                    "replay_min_window_weekday_count": 20,
                    "window_start": "2026-03-06T14:35:00+00:00",
                    "window_end": "2026-03-06T15:00:00+00:00",
                },
                runtime_ledger_artifact_metadata=artifact_metadata,
                window_start=window_start,
                window_end=window_end,
            ),
            [
                "runtime_ledger_artifact_refs_mismatch",
                "runtime_ledger_artifact_row_count_mismatch",
                "runtime_ledger_artifact_fill_count_mismatch",
                "runtime_ledger_window_bounds_mismatch",
                "runtime_ledger_artifact_candidate_id_mismatch",
                "runtime_ledger_artifact_window_weekday_count_mismatch",
                "runtime_ledger_artifact_window_weekday_count_below_min",
            ],
        )
        artifact_metadata_without_class = {
            key: value
            for key, value in artifact_metadata.items()
            if key != "runtime_ledger_artifact_authority_class"
        }
        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata={
                    "runtime_ledger_artifact_refs": ["exact-ledger.json"],
                    "candidate_id": "cand-one",
                },
                runtime_ledger_artifact_metadata=artifact_metadata_without_class,
                window_start=window_start,
                window_end=window_end,
            ),
            ["runtime_ledger_artifact_authority_class_missing"],
        )

    def test_runtime_ledger_target_metadata_blocks_missing_or_mixed_candidate_ids(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        target_metadata = {
            "runtime_ledger_artifact_refs": ["exact-ledger.json"],
            "candidate_id": "cand-one",
        }

        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata=target_metadata,
                runtime_ledger_artifact_metadata={
                    "runtime_ledger_artifact_refs": ["exact-ledger.json"],
                    "runtime_ledger_artifact_authority_class": (
                        "exact_replay_artifact_only_not_live"
                    ),
                    "runtime_ledger_artifact_row_count": 6,
                },
                window_start=window_start,
                window_end=window_end,
            ),
            ["runtime_ledger_artifact_candidate_id_missing"],
        )
        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata=target_metadata,
                runtime_ledger_artifact_metadata={
                    "runtime_ledger_artifact_refs": ["exact-ledger.json"],
                    "runtime_ledger_artifact_authority_class": (
                        "exact_replay_artifact_only_not_live"
                    ),
                    "runtime_ledger_artifact_candidate_ids": [
                        "cand-one",
                        "cand-two",
                    ],
                    "runtime_ledger_artifact_row_count": 6,
                },
                window_start=window_start,
                window_end=window_end,
            ),
            ["runtime_ledger_artifact_candidate_id_ambiguous"],
        )
        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata=target_metadata,
                runtime_ledger_artifact_metadata={
                    "runtime_ledger_artifact_refs": ["exact-ledger.json"],
                    "runtime_ledger_artifact_authority_class": (
                        "exact_replay_artifact_only_not_live"
                    ),
                    "runtime_ledger_artifact_candidate_ids": ["different-cand"],
                    "runtime_ledger_artifact_row_count": 6,
                },
                window_start=window_start,
                window_end=window_end,
            ),
            ["runtime_ledger_artifact_candidate_id_mismatch"],
        )

    def test_runtime_window_proof_hygiene_blocks_missing_authoritative_gates(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="paper_runtime_observed",
                target_metadata={},
                dependency_quorum_decision="",
                continuity_ok="",
                drift_ok="",
            ),
            [
                "runtime_window_target_metadata_missing",
                "dependency_quorum_decision_missing",
                "continuity_gate_missing",
                "drift_gate_missing",
            ],
        )
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="simulation_paper_runtime",
                target_metadata={},
                dependency_quorum_decision="",
                continuity_ok="",
                drift_ok="",
            ),
            [
                "dependency_quorum_decision_missing",
                "continuity_gate_missing",
                "drift_gate_missing",
            ],
        )
        self.assertTrue(
            _runtime_window_source_kind_is_informational(
                source_kind="non-authoritative-selection",
                target_metadata={},
            )
        )

    def test_runtime_window_proof_hygiene_carries_target_metadata_blockers(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="paper_runtime_observed",
                target_metadata={
                    "runtime_ledger_target_metadata_blockers": [
                        "existing_target_blocker"
                    ],
                    "runtime_window_import_health_gate_blockers": [
                        "health_gate_blocker"
                    ],
                    "candidate_blockers": ["candidate_blocker"],
                    "runtime_window_import_audit_blockers": [
                        "paper_route_account_contamination_detected",
                        "unlinked_order_events_present",
                    ],
                    "runtime_window_import_audit_target_blockers": [
                        "runtime_ledger_evidence_grade_bucket_missing"
                    ],
                },
                dependency_quorum_decision="allow",
                continuity_ok="ok",
                drift_ok="ok",
            ),
            [
                "existing_target_blocker",
                "health_gate_blocker",
                "candidate_blocker",
                "paper_route_account_contamination_detected",
                "unlinked_order_events_present",
                "runtime_ledger_evidence_grade_bucket_missing",
            ],
        )

    def test_source_kind_allows_authoritative_materialization_only_for_observed_runtime(
        self,
    ) -> None:
        self.assertTrue(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="paper_route_probe_runtime_observed",
                target_metadata={"paper_route_probe_symbols": ["AAPL"]},
            )
        )
        self.assertFalse(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="simulation_paper_runtime",
                target_metadata={"paper_route_probe_symbols": ["AAPL"]},
            )
        )
        self.assertTrue(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="paper_runtime_observed",
                target_metadata={"evidence_scope": "evidence_collection_only"},
            )
        )
        self.assertTrue(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={
                    "source_collection_authorized": True,
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    ),
                    "runtime_ledger_target_metadata_blockers": [
                        "runtime_ledger_source_window_evidence_pending"
                    ],
                },
            )
        )
        self.assertFalse(
            _runtime_window_source_kind_is_informational(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={
                    "source_collection_authorized": True,
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    ),
                },
            )
        )
        self.assertFalse(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    )
                },
            )
        )
        self.assertFalse(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={"source_collection_authorized": True},
            )
        )
        self.assertFalse(
            _runtime_window_source_kind_is_informational(
                source_kind="paper_route_probe_runtime_observed",
                target_metadata={
                    "paper_probation_authorization_scope": "evidence_collection_only"
                },
            )
        )

    def test_runtime_window_proof_hygiene_requires_source_collection_authorization(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    )
                },
                dependency_quorum_decision="allow",
                continuity_ok="ok",
                drift_ok="ok",
            ),
            ["source_collection_authorization_missing"],
        )
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={"source_collection_authorized": True},
                dependency_quorum_decision="allow",
                continuity_ok="ok",
                drift_ok="ok",
            ),
            ["source_collection_authorization_scope_invalid"],
        )

    def test_source_activity_missing_summary_includes_proof_hygiene_blockers(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        summary = _source_activity_missing_summary(
            run_id="run-source-missing",
            candidate_id="cand-1",
            hypothesis_id="H-PAIRS-01",
            observed_stage="paper",
            strategy_name="microbar-cross-sectional-pairs-v1",
            strategy_names=["microbar-cross-sectional-pairs-v1"],
            account_label="TORGHUT_SIM",
            window_start=window_start,
            window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
            source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
            source_kind="paper_runtime_observed",
            dataset_snapshot_ref="snapshot-1",
            proof_hygiene_blockers=("runtime_window_target_metadata_missing",),
            source_activity_diagnostics={
                "strategy_name_candidates": ["microbar-cross-sectional-pairs-v1"],
                "account_label": "TORGHUT_SIM",
                "source_activity_symbol_filter": ["AAPL"],
                "decision_rows_before_lineage_filter": 2,
                "decision_rows_after_lineage_filter": 0,
                "execution_rows_before_lineage_filter": 1,
                "execution_rows_after_lineage_filter": 0,
                "runtime_ledger_source_bucket_count": 0,
            },
        )

        self.assertEqual(summary["proof_status"], "blocked")
        self.assertEqual(
            [item["blocker"] for item in summary["proof_blockers"]],
            [
                "runtime_window_source_activity_missing",
                "runtime_window_target_metadata_missing",
            ],
        )
        self.assertEqual(
            summary["source_activity_diagnostics"][
                "decision_rows_before_lineage_filter"
            ],
            2,
        )
        self.assertIn(
            "source_lineage_filter_excluded_activity",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_source_bucket_missing",
            summary["runtime_observation"]["source_activity_diagnostic_blockers"],
        )

    def test_main_requires_source_dsn_or_durable_runtime_ledger_bucket(self) -> None:
        args = SimpleNamespace(
            run_id="run-missing-source",
            candidate_id="cand-missing-source",
            hypothesis_id="H-CONT-01",
            observed_stage="paper",
            strategy_family="",
            source_dsn="",
            source_dsn_env="TORGHUT_TEST_MISSING_DSN",
            strategy_name="intraday-tsmom-profit-v2",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="",
            source_kind="",
            artifact_ref=[],
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="",
            target_metadata_json="",
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        manifest = SimpleNamespace(
            strategy_family="intraday_continuation",
            strategy_id="intraday_tsmom_v2@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_durable_buckets",
                return_value=(
                    [],
                    {
                        "runtime_ledger_durable_bucket_count": 0,
                        "runtime_ledger_durable_bucket_run_ids": [],
                        "runtime_ledger_durable_bucket_fill_count": 0,
                        "runtime_ledger_durable_bucket_tca_row_count": 0,
                        "runtime_ledger_durable_bucket_profit_proof_count": 0,
                    },
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.SessionLocal",
                return_value=_FakeSession(),
            ),
            patch.dict("os.environ", {}, clear=True),
        ):
            with self.assertRaisesRegex(RuntimeError, "source_dsn_not_configured"):
                main()

    def test_load_report_post_cost_expectancy_bps_uses_simulation_report(self) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "simulation-report.json"
            report_path.write_text(
                '{"pnl":{"net_pnl_estimated":"66.16","execution_notional_total":"200061.4"}}',
                encoding="utf-8",
            )

            value = _load_report_post_cost_expectancy_bps([str(report_path)])

        self.assertEqual(value, Decimal("3.306984755680006238084907933"))

    def test_load_report_post_cost_expectancy_bps_rejects_gross_only_report(
        self,
    ) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "simulation-report.json"
            report_path.write_text(
                '{"pnl":{"gross_pnl":"66.16","execution_notional_total":"200061.4"}}',
                encoding="utf-8",
            )

            value = _load_report_post_cost_expectancy_bps([str(report_path)])

        self.assertEqual(value, None)

    def test_json_artifact_and_nonnegative_int_helpers_fail_closed(self) -> None:
        with TemporaryDirectory() as temp_dir:
            missing_path = Path(temp_dir) / "missing.json"
            invalid_path = Path(temp_dir) / "invalid.json"
            valid_path = Path(temp_dir) / "valid.json"
            invalid_path.write_text("{", encoding="utf-8")
            valid_path.write_text('{"case_count": 2}', encoding="utf-8")

            self.assertEqual(_load_json_artifact(""), {})
            self.assertEqual(_load_json_artifact(str(missing_path)), {})
            self.assertEqual(_load_json_artifact(str(invalid_path)), {})
            self.assertEqual(_load_json_artifact(str(valid_path)), {"case_count": 2})

        self.assertEqual(_nonnegative_int("3.9"), 3)
        self.assertEqual(_nonnegative_int("-2"), 0)
        self.assertEqual(_nonnegative_int("bad"), 0)

    def test_strategy_name_candidates_include_catalog_aliases(self) -> None:
        candidates = _strategy_name_candidates(
            "microbar_volume_continuation_long_top2_chip_v1@paper",
            "microbar-volume-continuation-long-top2-chip-v1",
            "",
            None,
        )

        self.assertEqual(
            candidates,
            [
                "microbar_volume_continuation_long_top2_chip_v1@paper",
                "microbar_volume_continuation_long_top2_chip_v1",
                "microbar-volume-continuation-long-top2-chip-v1@paper",
                "microbar-volume-continuation-long-top2-chip-v1",
            ],
        )

    def test_strategy_name_candidates_drop_blank_values(self) -> None:
        self.assertEqual(_strategy_name_candidates("", "   ", None), [])

    def test_row_payloads_recurses_to_limit_and_ignores_non_mappings(self) -> None:
        self.assertEqual(_row_payloads("not-a-row"), [])

        payloads = _row_payloads(
            {
                "level_1": {
                    "level_2": {
                        "level_3": {
                            "level_4": {
                                "level_5": {"ignored": True},
                            },
                        },
                    },
                },
                "scalar": "ignored",
            }
        )

        self.assertEqual(len(payloads), 5)
        self.assertIn("level_5", payloads[-1])
        self.assertNotIn({"ignored": True}, payloads)

    def test_stable_payload_digest_normalizes_runtime_payload_values(self) -> None:
        class CustomValue:
            def __str__(self) -> str:
                return "custom-value"

        payload = {
            "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
            "notional": Decimal("100.25"),
            "custom": CustomValue(),
        }

        self.assertEqual(
            _stable_payload_digest(payload),
            _stable_payload_digest(
                {
                    "custom": CustomValue(),
                    "notional": Decimal("100.25"),
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                }
            ),
        )

    def test_first_lineage_digest_prefers_explicit_lineage_payload(self) -> None:
        lineage_payload = {"source": "runtime-ledger", "snapshot": "sim-run-1"}

        self.assertEqual(
            _first_lineage_digest(
                {
                    "source_lineage": lineage_payload,
                    "simulation_context": {"simulation_run_id": "ignored-context"},
                }
            ),
            _stable_payload_digest(lineage_payload),
        )

    def test_execution_signed_qty_accepts_short_and_cover_sides(self) -> None:
        self.assertEqual(
            _execution_signed_qty(side="sell_short", qty=Decimal("3")),
            Decimal("-3"),
        )
        self.assertEqual(
            _execution_signed_qty(side="SELL-SHORT", qty=Decimal("3")),
            Decimal("-3"),
        )
        self.assertEqual(
            _execution_signed_qty(side="buy_to_cover", qty=Decimal("3")),
            Decimal("3"),
        )
        self.assertEqual(
            _execution_signed_qty(side="BUY-TO-COVER", qty=Decimal("3")),
            Decimal("3"),
        )

    def test_build_realized_strategy_pnl_rows_requires_costed_round_trip(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "execution-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "shortfall_notional": Decimal("99"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_id": "execution-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "shortfall_notional": Decimal("99"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(
            rows[0]["promotion_blocker"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        self.assertIsNone(rows[0]["post_cost_expectancy_bps"])
        self.assertEqual(rows[0]["authoritative"], False)
        self.assertEqual(
            rows[0]["authority_reason"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        self.assertIn(
            "runtime_decision_lifecycle_missing",
            rows[0]["runtime_ledger_blockers"],
        )
        self.assertIn(
            "submitted_order_lifecycle_missing",
            rows[0]["runtime_ledger_blockers"],
        )
        self.assertIn(
            "fill_order_submission_missing",
            rows[0]["runtime_ledger_blockers"],
        )

    def test_build_realized_strategy_pnl_rows_cannot_materialize_source_lifecycle(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "filled_notional_delta": Decimal("101"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "lineage_hash": "lineage-sha",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(rows[0]["authoritative"], False)
        self.assertEqual(
            rows[0]["authority_reason"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["pnl_basis"], POST_COST_BASIS_EXECUTION_RECONSTRUCTION)
        self.assertEqual(bucket["authoritative"], False)
        self.assertNotIn("source_materialization", bucket)
        self.assertIn("runtime_decision_lifecycle_missing", bucket["blockers"])
        self.assertIn("submitted_order_lifecycle_missing", bucket["blockers"])
        self.assertIn("fill_order_submission_missing", bucket["blockers"])
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            bucket["blockers"],
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_authorizes_event_sourced_lifecycle(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "filled_notional_delta": Decimal("101"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "decision-buy-id",
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
                {
                    "trade_decision_id": "decision-sell-id",
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-buy",
                    "trade_decision_id": "decision-buy-id",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 100,
                    "source_window_id": "source-window-new-buy",
                },
                {
                    "execution_order_event_id": "event-new-sell",
                    "trade_decision_id": "decision-sell-id",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 101,
                    "source_window_id": "source-window-new-sell",
                },
                {
                    "execution_order_event_id": "event-fill-buy",
                    "trade_decision_id": "decision-buy-id",
                    "execution_id": "execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 102,
                    "source_window_id": "source-window-fill-buy",
                },
                {
                    "execution_order_event_id": "event-fill-sell",
                    "trade_decision_id": "decision-sell-id",
                    "execution_id": "execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "filled_notional_delta": Decimal("101"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 103,
                    "source_window_id": "source-window-fill-sell",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"], POST_COST_BASIS_RUNTIME_LEDGER
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        self.assertEqual(rows[0]["authoritative"], True)
        self.assertEqual(
            rows[0]["authority_reason"],
            "event_sourced_runtime_ledger_profit_proof",
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["pnl_basis"], POST_COST_BASIS_RUNTIME_LEDGER)
        self.assertEqual(bucket["cost_amount"], "0.30")
        self.assertEqual(
            bucket["cost_basis_counts"], {"broker_reported_commission_and_fees": 2}
        )
        self.assertEqual(bucket["cost_model_hash_counts"], {"cost-sha": 2})
        self.assertEqual(
            bucket["execution_policy_hash_counts"],
            {"policy-buy": 2, "policy-sell": 2},
        )
        self.assertEqual(bucket["source_materialization"], "execution_order_events")
        self.assertEqual(bucket["account_equity"], "10000")
        self.assertEqual(bucket["account_equity_source"], "equity")
        self.assertEqual(bucket["source_window_start"], "2026-03-06T14:34:01+00:00")
        self.assertEqual(
            bucket["source_window_end"], "2026-03-06T14:40:01.000001+00:00"
        )
        self.assertEqual(
            bucket["source_refs"],
            [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
        )
        self.assertEqual(
            bucket["source_row_counts"],
            {
                "executions": 2,
                "execution_order_events": 4,
                "order_feed_source_windows": 4,
                "trade_decisions": 2,
            },
        )
        self.assertEqual(
            bucket["source_window_ids"],
            [
                "source-window-new-buy",
                "source-window-new-sell",
                "source-window-fill-buy",
                "source-window-fill-sell",
            ],
        )
        self.assertEqual(
            bucket["execution_order_event_ids"],
            [
                "event-new-buy",
                "event-new-sell",
                "event-fill-buy",
                "event-fill-sell",
            ],
        )
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_uses_source_backed_carry_in(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "execution-sell",
                    "trade_decision_id": "decision-sell-id",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "decision-sell-id",
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-sell",
                    "trade_decision_id": "decision-sell-id",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 201,
                    "source_window_id": "source-window-new-sell",
                },
                {
                    "execution_order_event_id": "event-fill-sell",
                    "trade_decision_id": "decision-sell-id",
                    "execution_id": "execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 202,
                    "source_window_id": "source-window-fill-sell",
                },
            ],
            carry_in_execution_rows=[
                {
                    "execution_id": "execution-buy",
                    "trade_decision_id": "decision-buy-id",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                },
            ],
            carry_in_decision_lifecycle_rows=[
                {
                    "trade_decision_id": "decision-buy-id",
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
            ],
            carry_in_order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-buy",
                    "trade_decision_id": "decision-buy-id",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 199,
                    "source_window_id": "source-window-new-buy",
                },
                {
                    "execution_order_event_id": "event-fill-buy",
                    "trade_decision_id": "decision-buy-id",
                    "execution_id": "execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 200,
                    "source_window_id": "source-window-fill-buy",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["post_cost_promotion_eligible"])
        self.assertTrue(rows[0]["authoritative"])
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertEqual(bucket["cost_amount"], "0.30")
        self.assertEqual(bucket["net_strategy_pnl_after_costs"], "0.70")
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["source_window_start"], "2026-03-06T14:34:01+00:00")
        self.assertEqual(
            bucket["source_window_end"], "2026-03-06T14:40:01.000001+00:00"
        )
        self.assertEqual(
            bucket["source_window_ids"],
            [
                "source-window-new-buy",
                "source-window-fill-buy",
                "source-window-new-sell",
                "source-window-fill-sell",
            ],
        )
        self.assertEqual(
            bucket["source_row_counts"],
            {
                "executions": 2,
                "execution_order_events": 4,
                "order_feed_source_windows": 4,
                "trade_decisions": 2,
            },
        )
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_authorizes_source_backed_short_round_trip(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "execution-short",
                    "trade_decision_id": "decision-short-id",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc
                    ),
                    "symbol": "AMZN",
                    "side": "sell_short",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-short",
                    "alpaca_order_id": "order-short",
                    "execution_policy_hash": "policy-short",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "source_topic": "alpaca.trade_updates",
                    "asset_class": "us_equity",
                },
                {
                    "execution_id": "execution-cover",
                    "trade_decision_id": "decision-cover-id",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc
                    ),
                    "symbol": "AMZN",
                    "side": "buy_to_cover",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-cover",
                    "alpaca_order_id": "order-cover",
                    "execution_policy_hash": "policy-cover",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "source_topic": "alpaca.trade_updates",
                    "asset_class": "us_equity",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "decision-short-id",
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-short",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
                {
                    "trade_decision_id": "decision-cover-id",
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-cover",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-short",
                    "trade_decision_id": "decision-short-id",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-short",
                    "alpaca_order_id": "order-short",
                    "execution_policy_hash": "policy-short",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 300,
                    "source_window_id": "source-window-new-short",
                },
                {
                    "execution_order_event_id": "event-new-cover",
                    "trade_decision_id": "decision-cover-id",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-cover",
                    "alpaca_order_id": "order-cover",
                    "execution_policy_hash": "policy-cover",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 301,
                    "source_window_id": "source-window-new-cover",
                },
                {
                    "execution_order_event_id": "event-fill-short",
                    "trade_decision_id": "decision-short-id",
                    "execution_id": "execution-short",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-short",
                    "alpaca_order_id": "order-short",
                    "execution_policy_hash": "policy-short",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 302,
                    "source_window_id": "source-window-fill-short",
                },
                {
                    "execution_order_event_id": "event-fill-cover",
                    "trade_decision_id": "decision-cover-id",
                    "execution_id": "execution-cover",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AMZN",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-cover",
                    "alpaca_order_id": "order-cover",
                    "execution_policy_hash": "policy-cover",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 303,
                    "source_window_id": "source-window-fill-cover",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["post_cost_promotion_eligible"])
        self.assertTrue(rows[0]["authoritative"])
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertEqual(bucket["gross_strategy_pnl"], "1")
        self.assertEqual(bucket["cost_amount"], "0.02")
        self.assertEqual(bucket["net_strategy_pnl_after_costs"], "0.98")
        self.assertEqual(
            bucket["cost_basis_counts"],
            {
                "alpaca_2026_equity_sec_taf_cat_fee_schedule": 1,
                "alpaca_2026_equity_zero_commission_and_cat_fee_schedule": 1,
            },
        )
        self.assertEqual(
            bucket["cost_model_hash_counts"],
            {_alpaca_2026_equity_fee_schedule_hash(): 2},
        )
        self.assertEqual(
            bucket["source_decision_mode_counts"],
            {"strategy_signal_paper": 4},
        )
        self.assertEqual(bucket["source_materialization"], "source_execution_lifecycle")
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_runtime_carry_in_source_filters_reject_wrong_symbol_and_decision(
        self,
    ) -> None:
        bucket = RuntimeLedgerBucket(
            bucket_started_at=datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 14, 45, tzinfo=timezone.utc),
            account_label="TORGHUT_SIM",
            strategy_id="microbar-cross-sectional-pairs-v1",
            symbol="AAPL",
            fill_count=0,
            decision_count=0,
            submitted_order_count=0,
            cancelled_order_count=0,
            rejected_order_count=0,
            unfilled_order_count=0,
            closed_trade_count=0,
            open_position_count=0,
            filled_notional=Decimal("0"),
            gross_strategy_pnl=Decimal("0"),
            cost_amount=Decimal("0"),
            net_strategy_pnl_after_costs=Decimal("0"),
            post_cost_expectancy_bps=None,
            cost_basis_counts={},
            execution_policy_hash_counts={},
            cost_model_hash_counts={},
            lineage_hash_counts={},
            blockers=[],
        )

        rows = _runtime_decision_rows_before_bucket(
            bucket=bucket,
            decision_lifecycle_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "symbol": "MSFT",
                    "decision_hash": "wanted",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 46, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "decision_hash": "wanted",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "decision_hash": "other",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "decision_hash": "wanted",
                },
            ],
            source_rows=[{"decision_hash": "wanted"}],
        )

        self.assertEqual(
            rows,
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "decision_hash": "wanted",
                }
            ],
        )

    def test_runtime_execution_ledger_fill_helper_validates_and_hashes_cost_model(
        self,
    ) -> None:
        invalid_fill, invalid_times = _runtime_execution_ledger_fill_from_row(
            {
                "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "side": "buy",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("0"),
            },
            order_lifecycle_rows=None,
        )

        self.assertIsNone(invalid_fill)
        self.assertEqual(invalid_times, [])

        fill, event_times = _runtime_execution_ledger_fill_from_row(
            {
                "execution_id": "execution-sell",
                "trade_decision_id": "decision-sell-id",
                "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                "execution_event_at": datetime(
                    2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc
                ),
                "symbol": "AAPL",
                "side": "sell",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("101"),
                "cost_amount": Decimal("0.02"),
                "cost_basis": "alpaca_2026_equity_fee_schedule",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
            },
            order_lifecycle_rows=None,
        )

        self.assertIsNotNone(fill)
        assert fill is not None
        self.assertEqual(fill.cost_model_hash, _alpaca_2026_equity_fee_schedule_hash())
        self.assertEqual(
            event_times,
            [
                datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
            ],
        )

    def test_build_realized_strategy_pnl_rows_uses_carry_in_execution_economics(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "execution-sell",
                    "trade_decision_id": "decision-sell-id",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "execution_policy_hash": "policy-sell",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            carry_in_execution_rows=[
                {
                    "execution_id": "execution-buy",
                    "trade_decision_id": "decision-buy-id",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "execution_policy_hash": "policy-buy",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            split_mixed_source_decision_modes=False,
        )

        self.assertEqual(len(rows), 1)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertEqual(bucket["net_strategy_pnl_after_costs"], "0.70")

    def test_build_realized_strategy_pnl_rows_does_not_borrow_source_refs_from_other_symbol(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "aapl-execution-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "aapl-decision-buy",
                    "alpaca_order_id": "aapl-order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_id": "aapl-execution-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "aapl-decision-sell",
                    "alpaca_order_id": "aapl-order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "aapl-decision-buy-id",
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-buy",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "trade_decision_id": "aapl-decision-sell-id",
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-sell",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "aapl-event-new-buy",
                    "trade_decision_id": "aapl-decision-buy-id",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-buy",
                    "alpaca_order_id": "aapl-order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_order_event_id": "aapl-event-fill-buy",
                    "trade_decision_id": "aapl-decision-buy-id",
                    "execution_id": "aapl-execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-buy",
                    "alpaca_order_id": "aapl-order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_order_event_id": "aapl-event-new-sell",
                    "trade_decision_id": "aapl-decision-sell-id",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-sell",
                    "alpaca_order_id": "aapl-order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_order_event_id": "aapl-event-fill-sell",
                    "trade_decision_id": "aapl-decision-sell-id",
                    "execution_id": "aapl-execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "aapl-decision-sell",
                    "alpaca_order_id": "aapl-order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_order_event_id": "msft-event-fill",
                    "trade_decision_id": "msft-decision-id",
                    "execution_id": "msft-execution",
                    "event_ts": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "MSFT",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "msft-decision",
                    "alpaca_order_id": "msft-order",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 999,
                    "source_window_id": "msft-source-window",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["authoritative"], False)
        self.assertEqual(
            rows[0]["authority_reason"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["symbol"], "AAPL")
        self.assertNotIn("msft-source-window", bucket.get("source_window_ids", []))
        self.assertIn("runtime_ledger_source_window_ids_missing", bucket["blockers"])
        self.assertIn("runtime_ledger_source_offsets_missing", bucket["blockers"])
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_requires_order_feed_fill_lifecycle(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "dedupe-event-new-buy",
                    "trade_decision_id": "decision-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 110,
                    "source_window_id": "source-window-dedupe-new-buy",
                },
                {
                    "execution_order_event_id": "dedupe-event-new-sell",
                    "trade_decision_id": "decision-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 111,
                    "source_window_id": "source-window-dedupe-new-sell",
                },
                {
                    "execution_order_event_id": "dedupe-event-fill-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "dedupe-execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 112,
                    "source_window_id": "source-window-dedupe-fill-buy",
                },
                {
                    "execution_order_event_id": "dedupe-event-fill-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "dedupe-execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-unmatched",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 113,
                    "source_window_id": "source-window-dedupe-fill-sell",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(rows[0]["authoritative"], False)
        self.assertEqual(
            rows[0]["authority_reason"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        self.assertIn(
            "order_feed_fill_lifecycle_incomplete",
            rows[0]["runtime_ledger_blockers"],
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertIn("order_feed_fill_lifecycle_incomplete", bucket["blockers"])
        self.assertEqual(bucket["pnl_basis"], POST_COST_BASIS_EXECUTION_RECONSTRUCTION)
        self.assertEqual(bucket["authoritative"], False)

    def test_build_realized_strategy_pnl_rows_counts_order_feed_fill_economics(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 31, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "modeled_paper_cost_budget",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 32, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "modeled_paper_cost_budget",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "dedupe-event-new-buy",
                    "trade_decision_id": "decision-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 110,
                    "source_window_id": "source-window-dedupe-new-buy",
                },
                {
                    "execution_order_event_id": "dedupe-event-new-sell",
                    "trade_decision_id": "decision-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 111,
                    "source_window_id": "source-window-dedupe-new-sell",
                },
                {
                    "execution_order_event_id": "dedupe-event-fill-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "dedupe-execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 112,
                    "source_window_id": "source-window-dedupe-fill-buy",
                },
                {
                    "execution_order_event_id": "dedupe-event-fill-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "dedupe-execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "filled_notional_delta": Decimal("101"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 113,
                    "source_window_id": "source-window-dedupe-fill-sell",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["computed_at"],
            datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        self.assertEqual(rows[0]["authoritative"], True)
        self.assertEqual(
            rows[0]["authority_reason"],
            "event_sourced_runtime_ledger_profit_proof",
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["fill_count"], 2)
        self.assertEqual(
            bucket["cost_basis_counts"], {"broker_reported_commission_and_fees": 2}
        )
        self.assertEqual(bucket["cost_amount"], "0.30")
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["source_materialization"], "execution_order_events")

    def test_build_realized_strategy_pnl_rows_does_not_borrow_source_refs_from_non_fill_lifecycle(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 31, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "modeled_paper_cost_budget",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 32, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "modeled_paper_cost_budget",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "decision_json": {"account": {"equity": "10000"}},
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-buy",
                    "trade_decision_id": "decision-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 34, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 110,
                    "source_window_id": "source-window-new-buy",
                },
                {
                    "execution_order_event_id": "event-new-sell",
                    "trade_decision_id": "decision-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 39, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 111,
                    "source_window_id": "source-window-new-sell",
                },
                {
                    "execution_order_event_id": "event-fill-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_order_event_id": "event-fill-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(rows[0]["authoritative"], False)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertNotIn("source-window-new-buy", bucket.get("source_window_ids", []))
        self.assertNotIn("source-window-new-sell", bucket.get("source_window_ids", []))
        self.assertIn("runtime_ledger_source_window_ids_missing", bucket["blockers"])
        self.assertIn("runtime_ledger_source_offsets_missing", bucket["blockers"])
        self.assertIn(
            "runtime_ledger_source_materialization_missing",
            bucket["blockers"],
        )
        self.assertIn("runtime_ledger_authority_class_missing", bucket["blockers"])
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_source_backed_fill_lifecycle_rows_require_order_event_and_offset_refs(
        self,
    ) -> None:
        rows = _source_backed_fill_lifecycle_rows(
            [
                {
                    "execution_order_event_id": "missing-order-id-event",
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 110,
                    "source_window_id": "source-window-missing-order",
                },
                {
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "alpaca_order_id": "order-missing-event-ref",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 111,
                    "source_window_id": "source-window-missing-event-ref",
                },
                {
                    "execution_order_event_id": "missing-source-offset-event",
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "alpaca_order_id": "order-missing-source-offset",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_window_id": "source-window-missing-offset",
                },
                {
                    "execution_order_event_id": "source-backed-fill-event",
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "alpaca_order_id": "order-source-backed",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 112,
                    "source_window_id": "source-window-backed",
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["execution_order_event_id"], "source-backed-fill-event"
        )

    def test_source_backed_order_lifecycle_rows_require_row_level_refs(
        self,
    ) -> None:
        rows = _source_backed_order_lifecycle_rows(
            [
                {
                    "execution_order_event_id": "decision-event",
                    "event_type": "decision",
                    "alpaca_order_id": "order-decision",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 120,
                    "source_window_id": "source-window-decision",
                },
                {
                    "execution_order_event_id": "missing-order-id-event",
                    "event_type": "new",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 121,
                    "source_window_id": "source-window-missing-order",
                },
                {
                    "event_type": "new",
                    "alpaca_order_id": "order-missing-event-ref",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 122,
                    "source_window_id": "source-window-missing-event-ref",
                },
                {
                    "execution_order_event_id": "missing-source-window-event",
                    "event_type": "new",
                    "alpaca_order_id": "order-missing-source-window",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 123,
                },
                {
                    "execution_order_event_id": "missing-source-offset-event",
                    "event_type": "new",
                    "alpaca_order_id": "order-missing-source-offset",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_window_id": "source-window-missing-offset",
                },
                {
                    "execution_order_event_id": "source-backed-new-event",
                    "event_type": "new",
                    "alpaca_order_id": "order-source-backed",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 124,
                    "source_window_id": "source-window-backed",
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["execution_order_event_id"], "source-backed-new-event")
        self.assertEqual(
            _required_order_lifecycle_source_row_count(
                rows,
                expected_order_ids={"order-source-backed", "order-missing"},
            ),
            2,
        )
        self.assertEqual(
            _required_order_lifecycle_source_row_count(
                [
                    {
                        "event_type": "decision",
                        "alpaca_order_id": "order-source-backed",
                    },
                    {
                        "event_type": "new",
                        "alpaca_order_id": "order-other",
                    },
                ],
                expected_order_ids={"order-source-backed"},
            ),
            1,
        )

    def test_build_realized_strategy_pnl_rows_accepts_execution_economics_with_order_feed_lifecycle(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "execution-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 31, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "execution_id": "execution-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 32, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 31, tzinfo=timezone.utc),
                    "event_type": "decision",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-buy",
                    "trade_decision_id": "decision-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 30, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 210,
                    "source_window_id": "source-window-new-buy",
                },
                {
                    "execution_order_event_id": "event-new-sell",
                    "trade_decision_id": "decision-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 31, 1, tzinfo=timezone.utc),
                    "event_type": "new",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 211,
                    "source_window_id": "source-window-new-sell",
                },
                {
                    "execution_order_event_id": "event-fill-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "execution-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 31, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 212,
                    "source_window_id": "source-window-fill-buy",
                },
                {
                    "execution_order_event_id": "event-fill-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "execution-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 32, 1, tzinfo=timezone.utc),
                    "event_type": "filled",
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 213,
                    "source_window_id": "source-window-fill-sell",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        self.assertEqual(rows[0]["authoritative"], True)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["source_materialization"], "source_execution_lifecycle")
        self.assertEqual(
            bucket["source_window_start"],
            "2026-03-06T14:30:01+00:00",
        )
        self.assertEqual(
            bucket["source_window_end"],
            "2026-03-06T14:32:01.000001+00:00",
        )
        self.assertEqual(
            bucket["source_window_ids"],
            [
                "source-window-new-buy",
                "source-window-new-sell",
                "source-window-fill-buy",
                "source-window-fill-sell",
            ],
        )
        self.assertEqual(
            bucket["cost_basis_counts"],
            {"broker_reported_commission_and_fees": 2},
        )

    def test_order_event_lifecycle_uses_execution_raw_order_metadata(self) -> None:
        row = {
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-buy",
            "alpaca_order_id": "order-buy",
            "raw_event": {
                "event": "fill",
                "order": {
                    "id": "order-buy",
                    "status": "filled",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                },
            },
            "execution_audit_json": {
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
            },
            "raw_order": {
                "side": "buy",
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "modeled_paper_cost_budget",
                },
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["side"], "buy")
        self.assertEqual(ledger_row["filled_qty"], Decimal("1"))
        self.assertEqual(ledger_row["avg_fill_price"], Decimal("100"))
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.20"))
        self.assertEqual(ledger_row["cost_basis"], "modeled_paper_cost_budget")
        self.assertEqual(ledger_row["execution_policy_hash"], "policy-sha")
        self.assertEqual(ledger_row["cost_model_hash"], "cost-sha")
        self.assertEqual(ledger_row["lineage_hash"], "lineage-sha")

    def test_order_event_lifecycle_uses_nested_positive_fill_economics_over_zero_placeholders(
        self,
    ) -> None:
        row = {
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-buy",
            "alpaca_order_id": "order-buy",
            "filled_qty": Decimal("0"),
            "avg_fill_price": Decimal("0"),
            "filled_notional": Decimal("0"),
            "raw_event": {
                "event": "fill",
                "order": {
                    "id": "order-buy",
                    "status": "filled",
                    "side": "buy",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                },
            },
            "execution_audit_json": {
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
            },
            "raw_order": {
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["side"], "buy")
        self.assertEqual(ledger_row["filled_qty"], Decimal("1"))
        self.assertEqual(ledger_row["avg_fill_price"], Decimal("100"))
        self.assertEqual(ledger_row["filled_notional"], Decimal("100"))
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.20"))
        self.assertEqual(
            ledger_row["cost_basis"], "broker_reported_commission_and_fees"
        )

    def test_order_event_lifecycle_does_not_hash_raw_event_as_policy_or_cost(
        self,
    ) -> None:
        row = {
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-buy",
            "alpaca_order_id": "order-buy",
            "execution_idempotency_key": "order-specific-idempotency-key",
            "decision_json": {
                "candidate_id": "candidate-1",
                "decision_nonce": "changes-every-order",
            },
            "raw_event": {
                "event": "fill",
                "sequence": 25,
                "order": {
                    "id": "order-buy",
                    "status": "filled",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                },
            },
            "lineage_hash": "lineage-sha",
            "raw_order": {
                "side": "buy",
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertIsNone(ledger_row["execution_policy_hash"])
        self.assertIsNone(ledger_row["cost_model_hash"])
        self.assertEqual(ledger_row["lineage_hash"], "lineage-sha")
        self.assertEqual(ledger_row["filled_qty"], Decimal("1"))
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.20"))

    def test_source_authority_order_event_lifecycle_requires_fill_delta_basis(
        self,
    ) -> None:
        row = {
            "execution_order_event_id": "event-buy",
            "source_window_id": "source-window-buy",
            "source_offset": 10,
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-buy",
            "alpaca_order_id": "order-buy",
            "filled_qty": Decimal("2"),
            "avg_fill_price": Decimal("100"),
            "raw_order": {
                "side": "buy",
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNone(ledger_row)

    def test_source_authority_order_event_lifecycle_uses_alpaca_payload_delta(
        self,
    ) -> None:
        row = {
            "execution_order_event_id": "event-sell",
            "source_window_id": "source-window-sell",
            "source_offset": 22007,
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "partial_fill",
            "symbol": "AMZN",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-sell",
            "alpaca_order_id": "order-sell",
            "source_topic": "torghut.trade-updates.v1",
            "qty": Decimal("41"),
            "filled_qty": Decimal("25"),
            "avg_fill_price": Decimal("271.75"),
            "raw_event": {
                "channel": "trade_updates",
                "payload": {
                    "event": "partial_fill",
                    "qty": "25",
                    "price": "271.75",
                    "order": {
                        "id": "order-sell",
                        "asset_class": "us_equity",
                        "side": "sell",
                        "symbol": "AMZN",
                        "status": "partially_filled",
                        "filled_qty": "25",
                        "filled_avg_price": "271.75",
                    },
                },
            },
            "execution_audit_json": {
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="partial_fill",
            require_complete_fill=True,
        )

        self.assertEqual(_order_feed_fill_delta_blockers(row), [])
        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["side"], "sell")
        self.assertEqual(ledger_row["filled_qty"], Decimal("25"))
        self.assertEqual(ledger_row["filled_qty_delta"], Decimal("25"))
        self.assertEqual(ledger_row["avg_fill_price"], Decimal("271.75"))
        self.assertEqual(ledger_row["filled_notional"], Decimal("6793.75"))
        self.assertEqual(ledger_row["filled_notional_delta"], Decimal("6793.75"))
        self.assertEqual(ledger_row["fill_quantity_basis"], "delta")
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.15"))
        self.assertEqual(
            ledger_row["cost_basis"],
            "alpaca_2026_equity_sec_taf_cat_fee_schedule",
        )
        self.assertEqual(
            ledger_row["cost_model_hash"],
            _alpaca_2026_equity_fee_schedule_hash(),
        )

    def test_source_order_feed_payload_delta_fill_rejects_non_delta_payloads(
        self,
    ) -> None:
        self.assertIsNone(
            _source_order_feed_payload_delta_fill(
                {
                    "raw_event": {
                        "payload": {
                            "event": "fill",
                            "qty": "2",
                            "price": "101.25",
                            "order": {"side": "buy"},
                        }
                    }
                },
                event_type="new",
            )
        )
        self.assertIsNone(
            _source_order_feed_payload_delta_fill(
                {
                    "raw_event": {
                        "payload": {
                            "event": "new",
                            "qty": "2",
                            "price": "101.25",
                            "order": {"side": "buy"},
                        }
                    }
                },
                event_type="fill",
            )
        )
        self.assertIsNone(
            _source_order_feed_payload_delta_fill(
                {
                    "raw_event": {
                        "payload": {
                            "event": "fill",
                            "qty": "0",
                            "price": "101.25",
                            "order": {"side": "buy"},
                        }
                    }
                },
                event_type="fill",
            )
        )

    def test_source_order_feed_payload_delta_fill_accepts_top_level_order_payload(
        self,
    ) -> None:
        self.assertEqual(
            _source_order_feed_payload_delta_fill(
                {
                    "raw_event": {
                        "event": "fill",
                        "qty": "2",
                        "price": "101.25",
                        "order": {"side": "buy"},
                    }
                },
                event_type="fill",
            ),
            (Decimal("2"), Decimal("101.25"), "buy"),
        )

    def test_source_authority_order_event_lifecycle_uses_fill_delta(
        self,
    ) -> None:
        row = {
            "execution_order_event_id": "event-buy",
            "source_window_id": "source-window-buy",
            "source_offset": 10,
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-buy",
            "alpaca_order_id": "order-buy",
            "filled_qty": Decimal("2"),
            "filled_qty_delta": Decimal("1"),
            "filled_notional_delta": Decimal("100"),
            "fill_quantity_basis": "cumulative_to_delta",
            "avg_fill_price": Decimal("100"),
            "raw_order": {
                "side": "buy",
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["filled_qty"], Decimal("1"))
        self.assertEqual(ledger_row["filled_notional"], Decimal("100"))
        self.assertEqual(ledger_row["filled_qty_delta"], Decimal("1"))
        self.assertEqual(ledger_row["fill_quantity_basis"], "cumulative_to_delta")

    def test_order_event_lifecycle_materializes_alpaca_fee_schedule_costs(self) -> None:
        row = {
            "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "event_type": "filled",
            "symbol": "AAPL",
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "decision_hash": "decision-sell",
            "alpaca_order_id": "order-sell",
            "source_topic": "alpaca-trade-updates",
            "raw_event": {
                "event": "fill",
                "feed": "alpaca",
                "channel": "trade_updates",
                "payload": {
                    "qty": "10",
                    "price": "100",
                    "order": {
                        "id": "order-sell",
                        "asset_class": "us_equity",
                        "side": "sell",
                        "symbol": "AAPL",
                        "status": "filled",
                        "filled_qty": "10",
                        "filled_avg_price": "100",
                    },
                },
            },
            "execution_audit_json": {
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
        }

        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="filled",
            require_complete_fill=True,
        )

        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["side"], "sell")
        self.assertEqual(ledger_row["filled_qty"], Decimal("10"))
        self.assertEqual(ledger_row["avg_fill_price"], Decimal("100"))
        self.assertEqual(ledger_row["filled_notional"], Decimal("1000"))
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.04"))
        self.assertEqual(
            ledger_row["cost_basis"],
            "alpaca_2026_equity_sec_taf_cat_fee_schedule",
        )
        self.assertEqual(
            ledger_row["cost_model_hash"],
            _alpaca_2026_equity_fee_schedule_hash(),
        )

    def test_order_lifecycle_query_row_preserves_fill_economics_columns(
        self,
    ) -> None:
        query_row = (
            "event-1",
            "decision-1",
            "execution-1",
            datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
            "AAPL",
            "TORGHUT_SIM",
            "microbar-cross-sectional-pairs-v1",
            "decision-hash",
            {"source_decision_mode": "strategy_signal_paper"},
            "alpaca-order-1",
            "client-order-1",
            "fill",
            "filled",
            "sell",
            Decimal("10"),
            Decimal("10"),
            Decimal("10"),
            Decimal("100"),
            Decimal("1000"),
            "cumulative_to_delta",
            "fingerprint-1",
            "torghut.trade-updates.v1",
            2,
            22124,
            "source-window-1",
            {"event": "fill"},
            {
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
            {
                "runtime_ledger_cost": {
                    "cost_amount": "0.04",
                    "cost_basis": "broker_reported_commission_and_fees",
                }
            },
        )

        row = _order_lifecycle_query_row(query_row)
        ledger_row = _runtime_lifecycle_ledger_row(
            row,
            event_type="fill",
            require_complete_fill=True,
        )

        self.assertEqual(row["side"], "sell")
        self.assertEqual(row["filled_qty"], Decimal("10"))
        self.assertEqual(row["avg_fill_price"], Decimal("100"))
        self.assertEqual(row["source_window_id"], "source-window-1")
        self.assertIsNotNone(ledger_row)
        assert ledger_row is not None
        self.assertEqual(ledger_row["filled_notional"], Decimal("1000"))
        self.assertEqual(ledger_row["cost_amount"], Decimal("0.04"))
        self.assertEqual(ledger_row["source"], "execution_order_event")

    def test_source_backed_round_trip_materializes_nested_fill_economics_over_zero_placeholders(
        self,
    ) -> None:
        common = {
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "symbol": "AAPL",
            "lineage_hash": "lineage-sha",
            "source_topic": "alpaca.trade_updates",
            "source_partition": 0,
            "source_window_id": "source-window",
            "source_decision_mode": "strategy_signal_paper",
            "profit_proof_eligible": True,
        }

        def order_row(
            *,
            event_id: str,
            decision_id: str,
            order_id: str,
            event_ts: datetime,
            event_type: str,
            side: str,
            nested_filled_qty: str | None = None,
            nested_avg_price: str | None = None,
            source_offset: int,
        ) -> dict[str, object]:
            raw_order: dict[str, object] = {
                "side": side,
                "runtime_ledger_cost": {
                    "cost_amount": "0.10",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
            }
            raw_event_order: dict[str, object] = {
                "id": order_id,
                "status": "filled" if nested_filled_qty is not None else "new",
                "side": side,
            }
            if nested_filled_qty is not None:
                raw_event_order.update(
                    {
                        "filled_qty": nested_filled_qty,
                        "filled_avg_price": nested_avg_price,
                    }
                )
            row: dict[str, object] = {
                **common,
                "execution_order_event_id": event_id,
                "trade_decision_id": decision_id,
                "decision_hash": decision_id,
                "event_ts": event_ts,
                "event_type": event_type,
                "alpaca_order_id": order_id,
                "execution_policy_hash": f"policy-{side}",
                "cost_model_hash": "cost-sha",
                "source_offset": source_offset,
                "filled_qty": Decimal("0"),
                "avg_fill_price": Decimal("0"),
                "filled_notional": Decimal("0"),
                "raw_event": {"event": event_type, "order": raw_event_order},
                "raw_order": raw_order,
            }
            if nested_filled_qty is not None and nested_avg_price is not None:
                row.update(
                    {
                        "filled_qty_delta": Decimal(nested_filled_qty),
                        "filled_notional_delta": Decimal(nested_filled_qty)
                        * Decimal(nested_avg_price),
                        "fill_quantity_basis": "cumulative_to_delta",
                    }
                )
            return row

        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    **common,
                    "execution_id": "execution-buy",
                    "trade_decision_id": "decision-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc
                    ),
                    "side": "buy",
                    "filled_qty": Decimal("0"),
                    "avg_fill_price": Decimal("0"),
                    "alpaca_order_id": "order-buy",
                    "raw_order": {
                        "side": "buy",
                        "filled_qty": "1",
                        "filled_avg_price": "100",
                        "runtime_ledger_cost": {
                            "cost_amount": "0.10",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                    },
                },
                {
                    **common,
                    "execution_id": "execution-sell",
                    "trade_decision_id": "decision-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc
                    ),
                    "side": "sell",
                    "filled_qty": Decimal("0"),
                    "avg_fill_price": Decimal("0"),
                    "alpaca_order_id": "order-sell",
                    "raw_order": {
                        "side": "sell",
                        "filled_qty": "1",
                        "filled_avg_price": "101",
                        "runtime_ledger_cost": {
                            "cost_amount": "0.10",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                    },
                },
            ],
            decision_lifecycle_rows=[
                {
                    **common,
                    "trade_decision_id": "decision-buy",
                    "decision_hash": "decision-buy",
                    "event_type": "decision",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                },
                {
                    **common,
                    "trade_decision_id": "decision-sell",
                    "decision_hash": "decision-sell",
                    "event_type": "decision",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                },
            ],
            order_lifecycle_rows=[
                order_row(
                    event_id="event-new-buy",
                    decision_id="decision-buy",
                    order_id="order-buy",
                    event_ts=datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    event_type="new",
                    side="buy",
                    source_offset=1,
                ),
                order_row(
                    event_id="event-fill-buy",
                    decision_id="decision-buy",
                    order_id="order-buy",
                    event_ts=datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    event_type="filled",
                    side="buy",
                    nested_filled_qty="1",
                    nested_avg_price="100",
                    source_offset=2,
                ),
                order_row(
                    event_id="event-new-sell",
                    decision_id="decision-sell",
                    order_id="order-sell",
                    event_ts=datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    event_type="new",
                    side="sell",
                    source_offset=3,
                ),
                order_row(
                    event_id="event-fill-sell",
                    decision_id="decision-sell",
                    order_id="order-sell",
                    event_ts=datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                    event_type="filled",
                    side="sell",
                    nested_filled_qty="1",
                    nested_avg_price="101",
                    source_offset=4,
                ),
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["authoritative"])
        self.assertTrue(rows[0]["post_cost_promotion_eligible"])
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(
            bucket["source_refs"],
            [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
        )
        self.assertEqual(bucket["source_materialization"], "execution_order_events")

    def test_source_backed_round_trip_materializes_alpaca_payload_delta_when_columns_missing(
        self,
    ) -> None:
        common = {
            "account_label": "TORGHUT_SIM",
            "strategy_id": "microbar-cross-sectional-pairs-v1",
            "symbol": "AAPL",
            "lineage_hash": "lineage-sha",
            "source_topic": "torghut.trade-updates.v1",
            "source_partition": 0,
            "source_window_id": "source-window",
            "source_decision_mode": "strategy_signal_paper",
            "profit_proof_eligible": True,
            "execution_policy_hash": "policy-sha",
        }

        def order_row(
            *,
            event_id: str,
            decision_id: str,
            order_id: str,
            event_ts: datetime,
            event_type: str,
            side: str,
            payload_qty: str | None,
            payload_price: str | None,
            source_offset: int,
        ) -> dict[str, object]:
            raw_event_payload: dict[str, object] = {
                "event": event_type,
                "order": {
                    "id": order_id,
                    "asset_class": "us_equity",
                    "status": "filled" if payload_qty is not None else "new",
                    "side": side,
                    "symbol": "AAPL",
                },
            }
            if payload_qty is not None and payload_price is not None:
                raw_event_payload.update({"qty": payload_qty, "price": payload_price})
                cast(dict[str, object], raw_event_payload["order"]).update(
                    {
                        "filled_qty": payload_qty,
                        "filled_avg_price": payload_price,
                    }
                )
            return {
                **common,
                "execution_order_event_id": event_id,
                "trade_decision_id": decision_id,
                "decision_hash": decision_id,
                "event_ts": event_ts,
                "event_type": event_type,
                "alpaca_order_id": order_id,
                "source_offset": source_offset,
                "qty": Decimal("2"),
                "filled_qty": Decimal(payload_qty or "0"),
                "avg_fill_price": Decimal(payload_price or "0"),
                "raw_event": {
                    "channel": "trade_updates",
                    "payload": raw_event_payload,
                },
            }

        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    **common,
                    "execution_id": "execution-buy",
                    "trade_decision_id": "decision-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc
                    ),
                    "side": "buy",
                    "filled_qty": Decimal("0"),
                    "avg_fill_price": Decimal("0"),
                    "alpaca_order_id": "order-buy",
                    "raw_order": {
                        "side": "buy",
                        "filled_qty": "1",
                        "filled_avg_price": "100",
                    },
                },
                {
                    **common,
                    "execution_id": "execution-sell",
                    "trade_decision_id": "decision-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc
                    ),
                    "side": "sell",
                    "filled_qty": Decimal("0"),
                    "avg_fill_price": Decimal("0"),
                    "alpaca_order_id": "order-sell",
                    "raw_order": {
                        "side": "sell",
                        "filled_qty": "1",
                        "filled_avg_price": "101",
                    },
                },
            ],
            decision_lifecycle_rows=[
                {
                    **common,
                    "trade_decision_id": "decision-buy",
                    "decision_hash": "decision-buy",
                    "event_type": "decision",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                },
                {
                    **common,
                    "trade_decision_id": "decision-sell",
                    "decision_hash": "decision-sell",
                    "event_type": "decision",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                },
            ],
            order_lifecycle_rows=[
                order_row(
                    event_id="event-new-buy",
                    decision_id="decision-buy",
                    order_id="order-buy",
                    event_ts=datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    event_type="new",
                    side="buy",
                    payload_qty=None,
                    payload_price=None,
                    source_offset=1,
                ),
                order_row(
                    event_id="event-fill-buy",
                    decision_id="decision-buy",
                    order_id="order-buy",
                    event_ts=datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    event_type="filled",
                    side="buy",
                    payload_qty="1",
                    payload_price="100",
                    source_offset=2,
                ),
                order_row(
                    event_id="event-new-sell",
                    decision_id="decision-sell",
                    order_id="order-sell",
                    event_ts=datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    event_type="new",
                    side="sell",
                    payload_qty=None,
                    payload_price=None,
                    source_offset=3,
                ),
                order_row(
                    event_id="event-fill-sell",
                    decision_id="decision-sell",
                    order_id="order-sell",
                    event_ts=datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                    event_type="filled",
                    side="sell",
                    payload_qty="1",
                    payload_price="101",
                    source_offset=4,
                ),
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["authoritative"])
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["source_materialization"], "execution_order_events")

    def test_build_realized_strategy_pnl_rows_does_not_use_idempotency_key_as_policy_hash(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_idempotency_key": "buy-order-key",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_idempotency_key": "sell-order-key",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["execution_policy_hash_counts"], {})
        self.assertIn("execution_policy_hash_missing", bucket["blockers"])
        self.assertNotIn("execution_policy_hash_ambiguous", bucket["blockers"])
        self.assertEqual(bucket["cost_model_hash_counts"], {"cost-sha": 2})

    def test_runtime_ledger_tca_materialization_metadata_separates_authority(
        self,
    ) -> None:
        metadata = _runtime_ledger_tca_materialization_metadata(
            [
                {
                    "authoritative": True,
                    "authority_reason": "source_execution_runtime_ledger_materialized",
                    "pnl_derivation": (
                        "source_execution_lifecycle_materialized_runtime_ledger"
                    ),
                    "runtime_ledger_bucket": _complete_runtime_ledger_bucket(
                        source_materialization="source_execution_lifecycle",
                        authoritative=True,
                    ),
                },
                {
                    "authoritative": False,
                    "authority_reason": (
                        "execution_reconstruction_not_runtime_ledger_proof"
                    ),
                    "runtime_ledger_blockers": [
                        "execution_reconstruction_not_runtime_ledger_proof"
                    ],
                    "runtime_ledger_bucket": _complete_runtime_ledger_bucket(
                        pnl_basis=POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
                        blockers=["execution_reconstruction_not_runtime_ledger_proof"],
                        source_materialization=None,
                        authority_class=None,
                        authority_reason=None,
                        pnl_derivation=None,
                    ),
                },
            ]
        )

        self.assertEqual(metadata["runtime_ledger_tca_runtime_bucket_row_count"], 2)
        self.assertEqual(metadata["runtime_ledger_tca_profit_proof_count"], 1)
        self.assertEqual(metadata["runtime_ledger_tca_authoritative_bucket_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_source_execution_materialized_bucket_count"],
            1,
        )
        self.assertEqual(
            metadata["runtime_ledger_execution_reconstruction_bucket_count"],
            1,
        )
        self.assertEqual(
            metadata["runtime_ledger_materialization_blockers"],
            [
                "execution_reconstruction_not_runtime_ledger_proof",
                "runtime_ledger_authority_class_missing",
                "runtime_ledger_pnl_basis_not_runtime_ledger",
                "runtime_ledger_source_materialization_missing",
            ],
        )
        self.assertEqual(
            metadata["runtime_ledger_profit_proof_blockers"],
            [
                "execution_reconstruction_not_runtime_ledger_proof",
                "runtime_ledger_authority_class_missing",
                "runtime_ledger_pnl_basis_not_runtime_ledger",
                "runtime_ledger_source_materialization_missing",
            ],
        )

    def test_build_realized_strategy_pnl_rows_normalizes_nested_runtime_payloads(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_audit_json": {
                        "fees": {
                            "cost_amount": "0.20",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                        "simulation_context": {
                            "simulation_run_id": "sim-run-1",
                            "dataset_event_id": "evt-buy",
                        },
                    },
                    "raw_order": {
                        "execution_policy": {
                            "selected_order_type": "limit",
                            "adaptive": {"max_participation_rate": "0.05"},
                        },
                        "cost_model": {"commission_bps": "0", "min_commission": "0"},
                    },
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_audit_json": {
                        "fees": {
                            "cost_amount": "0.10",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                        "simulation_context": {
                            "simulation_run_id": "sim-run-1",
                            "dataset_event_id": "evt-sell",
                        },
                    },
                    "raw_order": {
                        "execution_policy": {
                            "selected_order_type": "limit",
                            "adaptive": {"max_participation_rate": "0.05"},
                        },
                        "cost_model": {"commission_bps": "0", "min_commission": "0"},
                    },
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertIn("runtime_decision_lifecycle_missing", bucket["blockers"])
        self.assertIn("submitted_order_lifecycle_missing", bucket["blockers"])
        self.assertIn("fill_order_submission_missing", bucket["blockers"])
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            bucket["blockers"],
        )
        self.assertEqual(bucket["pnl_basis"], POST_COST_BASIS_EXECUTION_RECONSTRUCTION)
        self.assertEqual(bucket["authoritative"], False)
        self.assertGreaterEqual(len(bucket["execution_policy_hash_counts"]), 1)
        self.assertGreaterEqual(len(bucket["cost_model_hash_counts"]), 1)
        self.assertGreaterEqual(len(bucket["lineage_hash_counts"]), 1)

    def test_build_realized_strategy_pnl_rows_uses_raw_order_fill_fields(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "execution_created_at": datetime(
                        2026, 3, 6, 15, 45, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_audit_json": {
                        "fees": {
                            "cost_amount": "0.20",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                        "lineage": {"runtime_window_id": "paper-route-session"},
                    },
                    "raw_order": {
                        "side": "buy",
                        "filled_qty": "1",
                        "filled_avg_price": "100",
                        "execution_policy": {"selected_order_type": "limit"},
                        "cost_model": {"source": "broker_reported"},
                    },
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 50, tzinfo=timezone.utc),
                    "execution_created_at": datetime(
                        2026, 3, 6, 15, 55, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_audit_json": {
                        "fees": {
                            "cost_amount": "0.10",
                            "cost_basis": "broker_reported_commission_and_fees",
                        },
                        "lineage": {"runtime_window_id": "paper-route-session"},
                    },
                    "raw_order": {
                        "side": "sell",
                        "filled_qty": "1",
                        "filled_avg_price": "101",
                        "execution_policy": {"selected_order_type": "limit"},
                        "cost_model": {"source": "broker_reported"},
                    },
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["authoritative"], False)
        self.assertEqual(
            rows[0]["authority_reason"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        self.assertEqual(
            rows[0]["computed_at"], datetime(2026, 3, 6, 15, 55, tzinfo=timezone.utc)
        )
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["fill_count"], 2)
        self.assertEqual(bucket["filled_notional"], "201")
        self.assertNotIn("runtime_fills_missing", bucket["blockers"])
        self.assertNotIn("filled_notional_missing", bucket["blockers"])
        self.assertNotIn("explicit_cost_missing", bucket["blockers"])
        self.assertIn("runtime_decision_lifecycle_missing", bucket["blockers"])
        self.assertIn("submitted_order_lifecycle_missing", bucket["blockers"])
        self.assertIn("fill_order_submission_missing", bucket["blockers"])
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            bucket["blockers"],
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_prefers_execution_event_time(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_created_at": datetime(
                        2026, 3, 6, 14, 30, 5, tzinfo=timezone.utc
                    ),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 35, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    "execution_created_at": datetime(
                        2026, 3, 6, 14, 30, 10, tzinfo=timezone.utc
                    ),
                    "execution_event_at": datetime(
                        2026, 3, 6, 14, 40, tzinfo=timezone.utc
                    ),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["computed_at"], datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc)
        )
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))

    def test_build_realized_strategy_pnl_rows_materializes_audit_only_runtime_metadata(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_audit_json": {
                        "execution_policy": {
                            "selected_order_type": "limit",
                            "adaptive": {"max_participation_rate": "0.05"},
                        },
                        "cost_model": {
                            "source": "broker_reported",
                            "commission_bps": "0",
                        },
                        "lineage": {
                            "candidate_id": "H-PAIRS-LIVE-PAPER",
                            "runtime_window_id": "2026-03-06-paper",
                        },
                        "runtime_ledger_cost": {
                            "cost_amount": "0.20",
                            "cost_basis": "broker_reported_commission",
                        },
                    },
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_audit_json": {
                        "execution_policy": {
                            "selected_order_type": "limit",
                            "adaptive": {"max_participation_rate": "0.05"},
                        },
                        "cost_model": {
                            "source": "broker_reported",
                            "commission_bps": "0",
                        },
                        "lineage": {
                            "candidate_id": "H-PAIRS-LIVE-PAPER",
                            "runtime_window_id": "2026-03-06-paper",
                        },
                        "runtime_ledger_cost": {
                            "cost_amount": "0.10",
                            "cost_basis": "broker_reported_commission",
                        },
                    },
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["authoritative"], False)
        self.assertEqual(
            rows[0]["authority_reason"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertIn("runtime_decision_lifecycle_missing", bucket["blockers"])
        self.assertIn("submitted_order_lifecycle_missing", bucket["blockers"])
        self.assertIn("fill_order_submission_missing", bucket["blockers"])
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            bucket["blockers"],
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_uses_decision_impact_cost_model(
        self,
    ) -> None:
        decision_json = {
            "params": {
                "execution_policy": {"selected_order_type": "market"},
                "impact_assumptions": {
                    "model": {
                        "commission_bps": "0",
                        "impact_bps_at_full_participation": "50",
                    },
                    "estimate": {"total_cost_bps": "10"},
                },
                "simulation_context": {"dataset_id": "runtime-paper-session"},
            }
        }
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "decision_json": decision_json,
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "decision_json": decision_json,
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["authoritative"], False)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertIn(
            "runtime_ledger_cost_basis_non_promotion_grade", bucket["blockers"]
        )
        self.assertIn("runtime_fills_missing", bucket["blockers"])
        self.assertIn("runtime_decision_lifecycle_missing", bucket["blockers"])
        self.assertIn("submitted_order_lifecycle_missing", bucket["blockers"])
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            bucket["blockers"],
        )
        self.assertEqual(
            bucket["cost_basis_counts"],
            {},
        )
        self.assertEqual(bucket["cost_amount"], "0")
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0"))

    def test_build_realized_strategy_pnl_rows_marks_route_acquisition_not_profit_proof(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(
            row["source_decision_mode_counts"], {"route_acquisition_probe": 2}
        )
        self.assertFalse(row["profit_proof_eligible"])
        self.assertFalse(row["post_cost_promotion_eligible"])
        self.assertIn(
            "source_decision_mode_not_profit_proof_eligible",
            row["runtime_ledger_blockers"],
        )
        self.assertEqual(
            row["promotion_blocker"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        bucket = row["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(
            bucket["source_decision_mode_counts"], {"route_acquisition_probe": 2}
        )
        self.assertFalse(bucket["profit_proof_eligible"])
        self.assertIn(
            "source_decision_mode_not_profit_proof_eligible", bucket["blockers"]
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_partitions_mixed_source_decision_modes(
        self,
    ) -> None:
        def execution_row(
            *,
            decision_id: str,
            execution_id: str,
            mode: str,
            side: str,
            price: str,
            minute: int,
        ) -> dict[str, object]:
            return {
                "execution_id": execution_id,
                "trade_decision_id": decision_id,
                "computed_at": datetime(2026, 3, 6, 14, minute, tzinfo=timezone.utc),
                "execution_event_at": datetime(
                    2026,
                    3,
                    6,
                    14,
                    minute,
                    tzinfo=timezone.utc,
                ),
                "symbol": "AAPL",
                "side": side,
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal(price),
                "cost_amount": Decimal("0.10"),
                "cost_basis": "broker_reported_commission_and_fees",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": f"{decision_id}-hash",
                "alpaca_order_id": f"{execution_id}-order",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": mode,
            }

        def decision_row(
            *,
            decision_id: str,
            mode: str,
            minute: int,
        ) -> dict[str, object]:
            return {
                "trade_decision_id": decision_id,
                "computed_at": datetime(2026, 3, 6, 14, minute, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": f"{decision_id}-hash",
                "event_type": "decision",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": mode,
            }

        def order_event_row(
            *,
            decision_id: str,
            execution_id: str,
            mode: str,
            event_id: str,
            event_type: str,
            offset: int,
            minute: int,
        ) -> dict[str, object]:
            row: dict[str, object] = {
                "execution_order_event_id": event_id,
                "trade_decision_id": decision_id,
                "execution_id": execution_id,
                "event_ts": datetime(2026, 3, 6, 14, minute, 1, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": f"{decision_id}-hash",
                "alpaca_order_id": f"{execution_id}-order",
                "event_type": event_type,
                "source_topic": "alpaca-trade-updates",
                "source_partition": 0,
                "source_offset": offset,
                "source_window_id": f"source-window-{mode}",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": mode,
            }
            if event_type in {"fill", "filled", "partial_fill"}:
                avg_fill_price = Decimal(
                    {
                        "route-buy": "100",
                        "route-sell": "101",
                        "signal-buy": "110",
                        "signal-sell": "112",
                    }[decision_id]
                )
                row.update(
                    {
                        "side": "sell" if "sell" in decision_id else "buy",
                        "filled_qty": Decimal("1"),
                        "filled_qty_delta": Decimal("1"),
                        "avg_fill_price": avg_fill_price,
                        "filled_notional_delta": avg_fill_price,
                        "fill_quantity_basis": "cumulative_to_delta",
                        "cost_amount": Decimal("0.10"),
                        "cost_basis": "broker_reported_commission_and_fees",
                    }
                )
            return row

        rows = _build_realized_strategy_pnl_rows(
            [
                execution_row(
                    decision_id="route-buy",
                    execution_id="route-buy-exec",
                    mode="route_acquisition_probe",
                    side="buy",
                    price="100",
                    minute=35,
                ),
                execution_row(
                    decision_id="route-sell",
                    execution_id="route-sell-exec",
                    mode="route_acquisition_probe",
                    side="sell",
                    price="101",
                    minute=36,
                ),
                execution_row(
                    decision_id="signal-buy",
                    execution_id="signal-buy-exec",
                    mode="strategy_signal_paper",
                    side="buy",
                    price="110",
                    minute=45,
                ),
                execution_row(
                    decision_id="signal-sell",
                    execution_id="signal-sell-exec",
                    mode="strategy_signal_paper",
                    side="sell",
                    price="112",
                    minute=50,
                ),
            ],
            decision_lifecycle_rows=[
                decision_row(
                    decision_id="route-buy",
                    mode="route_acquisition_probe",
                    minute=35,
                ),
                decision_row(
                    decision_id="route-sell",
                    mode="route_acquisition_probe",
                    minute=36,
                ),
                decision_row(
                    decision_id="signal-buy",
                    mode="strategy_signal_paper",
                    minute=45,
                ),
                decision_row(
                    decision_id="signal-sell",
                    mode="strategy_signal_paper",
                    minute=50,
                ),
            ],
            order_lifecycle_rows=[
                order_event_row(
                    decision_id="route-buy",
                    execution_id="route-buy-exec",
                    mode="route_acquisition_probe",
                    event_id="route-buy-new",
                    event_type="new",
                    offset=11,
                    minute=35,
                ),
                order_event_row(
                    decision_id="route-buy",
                    execution_id="route-buy-exec",
                    mode="route_acquisition_probe",
                    event_id="route-buy-fill",
                    event_type="fill",
                    offset=12,
                    minute=35,
                ),
                order_event_row(
                    decision_id="route-sell",
                    execution_id="route-sell-exec",
                    mode="route_acquisition_probe",
                    event_id="route-sell-new",
                    event_type="new",
                    offset=13,
                    minute=36,
                ),
                order_event_row(
                    decision_id="route-sell",
                    execution_id="route-sell-exec",
                    mode="route_acquisition_probe",
                    event_id="route-sell-fill",
                    event_type="fill",
                    offset=14,
                    minute=36,
                ),
                order_event_row(
                    decision_id="signal-buy",
                    execution_id="signal-buy-exec",
                    mode="strategy_signal_paper",
                    event_id="signal-buy-new",
                    event_type="new",
                    offset=21,
                    minute=45,
                ),
                order_event_row(
                    decision_id="signal-buy",
                    execution_id="signal-buy-exec",
                    mode="strategy_signal_paper",
                    event_id="signal-buy-fill",
                    event_type="fill",
                    offset=22,
                    minute=45,
                ),
                order_event_row(
                    decision_id="signal-sell",
                    execution_id="signal-sell-exec",
                    mode="strategy_signal_paper",
                    event_id="signal-sell-new",
                    event_type="new",
                    offset=23,
                    minute=50,
                ),
                order_event_row(
                    decision_id="signal-sell",
                    execution_id="signal-sell-exec",
                    mode="strategy_signal_paper",
                    event_id="signal-sell-fill",
                    event_type="fill",
                    offset=24,
                    minute=50,
                ),
            ],
            unlinked_order_lifecycle_rows=[
                order_event_row(
                    decision_id="route-buy",
                    execution_id="route-unlinked-exec",
                    mode="route_acquisition_probe",
                    event_id="route-unlinked-fill",
                    event_type="fill",
                    offset=31,
                    minute=46,
                )
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 2)
        rows_by_mode = {str(row["source_decision_mode"]): row for row in rows}
        self.assertEqual(
            sorted(rows_by_mode),
            ["route_acquisition_probe", "strategy_signal_paper"],
        )

        route_row = rows_by_mode["route_acquisition_probe"]
        self.assertFalse(route_row["post_cost_promotion_eligible"])
        self.assertIn(
            "source_decision_mode_not_profit_proof_eligible",
            route_row["runtime_ledger_blockers"],
        )

        signal_row = rows_by_mode["strategy_signal_paper"]
        self.assertTrue(signal_row["post_cost_promotion_eligible"])
        self.assertEqual(
            signal_row["authority_reason"],
            "event_sourced_runtime_ledger_profit_proof",
        )
        signal_bucket = cast(Mapping[str, object], signal_row["runtime_ledger_bucket"])
        self.assertEqual(
            signal_bucket["source_decision_mode_counts"],
            {"strategy_signal_paper": 8},
        )
        self.assertNotIn(
            "order_feed_unlinked_fill_lifecycle_present",
            signal_bucket["blockers"],
        )
        self.assertEqual(
            signal_bucket["source_materialization"], "execution_order_events"
        )
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(signal_bucket))

    def test_build_realized_strategy_pnl_rows_blocks_unlinked_fill_lifecycle(
        self,
    ) -> None:
        execution_rows = [
            {
                "execution_id": "exec-buy",
                "trade_decision_id": "decision-buy",
                "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                "execution_event_at": datetime(
                    2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc
                ),
                "symbol": "AAPL",
                "side": "buy",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("100"),
                "cost_amount": Decimal("0.10"),
                "cost_basis": "broker_reported_commission_and_fees",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-buy-hash",
                "alpaca_order_id": "order-buy",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
            {
                "execution_id": "exec-sell",
                "trade_decision_id": "decision-sell",
                "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                "execution_event_at": datetime(
                    2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc
                ),
                "symbol": "AAPL",
                "side": "sell",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("101"),
                "cost_amount": Decimal("0.10"),
                "cost_basis": "broker_reported_commission_and_fees",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-sell-hash",
                "alpaca_order_id": "order-sell",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
        ]
        order_lifecycle_rows = [
            {
                "execution_order_event_id": "event-new-buy",
                "trade_decision_id": "decision-buy",
                "execution_id": "exec-buy",
                "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-buy-hash",
                "alpaca_order_id": "order-buy",
                "event_type": "new",
                "source_topic": "alpaca-trade-updates",
                "source_partition": 0,
                "source_offset": 11,
                "source_window_id": "source-window-buy",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
            {
                "execution_order_event_id": "event-fill-buy",
                "trade_decision_id": "decision-buy",
                "execution_id": "exec-buy",
                "event_ts": datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-buy-hash",
                "alpaca_order_id": "order-buy",
                "event_type": "fill",
                "source_topic": "alpaca-trade-updates",
                "source_partition": 0,
                "source_offset": 12,
                "source_window_id": "source-window-buy",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
            {
                "execution_order_event_id": "event-new-sell",
                "trade_decision_id": "decision-sell",
                "execution_id": "exec-sell",
                "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-sell-hash",
                "alpaca_order_id": "order-sell",
                "event_type": "new",
                "source_topic": "alpaca-trade-updates",
                "source_partition": 0,
                "source_offset": 13,
                "source_window_id": "source-window-sell",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
            {
                "execution_order_event_id": "event-fill-sell",
                "trade_decision_id": "decision-sell",
                "execution_id": "exec-sell",
                "event_ts": datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-sell-hash",
                "alpaca_order_id": "order-sell",
                "event_type": "fill",
                "source_topic": "alpaca-trade-updates",
                "source_partition": 0,
                "source_offset": 14,
                "source_window_id": "source-window-sell",
                "lineage_hash": "lineage-sha",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
            },
        ]

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=[
                {
                    "execution_order_event_id": "unlinked-fill",
                    "event_ts": datetime(2026, 3, 6, 14, 41, 2, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "alpaca_order_id": "order-sell",
                    "event_type": "fill",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 15,
                    "source_window_id": "source-window-external",
                }
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertFalse(row["post_cost_promotion_eligible"])
        self.assertFalse(row["authoritative"])
        self.assertIn(
            "order_feed_unlinked_fill_lifecycle_present",
            row["runtime_ledger_blockers"],
        )
        self.assertEqual(
            row["promotion_blocker"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        bucket = cast(Mapping[str, object], row["runtime_ledger_bucket"])
        self.assertIn("order_feed_unlinked_fill_lifecycle_present", bucket["blockers"])
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

        rows = _build_realized_strategy_pnl_rows(
            execution_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=[
                {
                    "execution_order_event_id": "external-fill",
                    "event_ts": datetime(2026, 3, 6, 14, 41, 2, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "alpaca_order_id": "external-close-order",
                    "event_type": "fill",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 16,
                    "source_window_id": "source-window-external",
                }
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertNotIn(
            "order_feed_unlinked_fill_lifecycle_present",
            row["runtime_ledger_blockers"],
        )
        bucket = cast(Mapping[str, object], row["runtime_ledger_bucket"])
        self.assertNotIn(
            "order_feed_unlinked_fill_lifecycle_present", bucket["blockers"]
        )

    def test_build_realized_strategy_pnl_rows_preserves_source_backed_blocked_basis(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "execution_id": "exec-buy",
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "execution_id": "exec-sell",
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
            ],
            decision_lifecycle_rows=[
                {
                    "trade_decision_id": "decision-buy",
                    "executed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "event_type": "decision",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "trade_decision_id": "decision-sell",
                    "executed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "event_type": "decision",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
            ],
            order_lifecycle_rows=[
                {
                    "execution_order_event_id": "event-new-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "exec-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "event_type": "new",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 11,
                    "source_window_id": "source-window-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "execution_order_event_id": "event-fill-buy",
                    "trade_decision_id": "decision-buy",
                    "execution_id": "exec-buy",
                    "event_ts": datetime(2026, 3, 6, 14, 35, 2, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "event_type": "fill",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 12,
                    "source_window_id": "source-window-buy",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "execution_order_event_id": "event-new-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "exec-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 1, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "event_type": "new",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 13,
                    "source_window_id": "source-window-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
                {
                    "execution_order_event_id": "event-fill-sell",
                    "trade_decision_id": "decision-sell",
                    "execution_id": "exec-sell",
                    "event_ts": datetime(2026, 3, 6, 14, 40, 2, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "account_label": "TORGHUT_SIM",
                    "strategy_id": "microbar-cross-sectional-pairs-v1",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "event_type": "fill",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "filled_notional_delta": Decimal("101"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "source_topic": "alpaca-trade-updates",
                    "source_partition": 0,
                    "source_offset": 14,
                    "source_window_id": "source-window-sell",
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                    "source_decision_mode": "route_acquisition_probe",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertFalse(row["post_cost_promotion_eligible"])
        self.assertFalse(row["authoritative"])
        self.assertEqual(
            row["authority_reason"],
            "source_execution_lifecycle_materialized_runtime_ledger",
        )
        self.assertEqual(row["pnl_derivation"], "execution_order_events_runtime_ledger")
        self.assertEqual(
            row["promotion_blocker"],
            "source_decision_mode_not_profit_proof_eligible",
        )
        self.assertNotIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            row["runtime_ledger_blockers"],
        )

        bucket = row["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["pnl_basis"], POST_COST_BASIS_RUNTIME_LEDGER)
        self.assertEqual(bucket["source_materialization"], "execution_order_events")
        self.assertEqual(
            bucket["authority_reason"],
            "source_execution_lifecycle_materialized_runtime_ledger",
        )
        self.assertEqual(
            bucket["source_decision_mode_counts"], {"route_acquisition_probe": 8}
        )
        self.assertIn(
            "source_decision_mode_not_profit_proof_eligible", bucket["blockers"]
        )
        self.assertNotIn(
            "runtime_ledger_pnl_basis_not_runtime_ledger",
            _runtime_ledger_bucket_profit_proof_blockers(bucket),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_runtime_ledger_tca_row_separates_explicit_cost_from_slippage(
        self,
    ) -> None:
        bucket = RuntimeLedgerBucket(
            bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
            account_label="TORGHUT_SIM",
            strategy_id="intraday-tsmom-profit-v3",
            symbol="AAPL",
            fill_count=2,
            decision_count=2,
            submitted_order_count=2,
            cancelled_order_count=0,
            rejected_order_count=0,
            unfilled_order_count=0,
            closed_trade_count=1,
            open_position_count=0,
            filled_notional=Decimal("200"),
            gross_strategy_pnl=Decimal("1"),
            cost_amount=Decimal("0.25"),
            net_strategy_pnl_after_costs=Decimal("0.75"),
            post_cost_expectancy_bps=Decimal("37.5"),
            cost_basis_counts={"broker_reported_commission_and_fees": 2},
            execution_policy_hash_counts={"policy-sha": 2},
            cost_model_hash_counts={"cost-sha": 2},
            lineage_hash_counts={"lineage-sha": 2},
            blockers=[],
        )

        row = _runtime_ledger_tca_row_from_bucket(bucket=bucket)

        self.assertIsNone(row["abs_slippage_bps"])
        self.assertEqual(row["explicit_cost_bps"], Decimal("12.50000"))
        self.assertEqual(row["post_cost_promotion_eligible"], False)
        self.assertIn(
            "source_decision_mode_profit_proof_missing",
            _runtime_ledger_bucket_profit_proof_blockers(
                cast(Mapping[str, object], row["runtime_ledger_bucket"])
            ),
        )

    def test_runtime_lifecycle_row_requires_delta_when_source_backed(self) -> None:
        row = _runtime_lifecycle_ledger_row(
            {
                "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "side": "buy",
                "filled_qty": Decimal("3"),
                "avg_fill_price": Decimal("100"),
                "cost_amount": Decimal("0"),
                "cost_basis": "broker_reported_zero_cost",
                "source_offset": 14,
                "fill_quantity_basis": "delta",
            },
            event_type="fill",
        )

        self.assertIsNotNone(row)
        assert row is not None
        self.assertNotIn("filled_qty", row)
        self.assertNotIn("filled_notional", row)
        self.assertEqual(row["fill_quantity_basis"], "delta")

    def test_order_feed_fill_delta_blockers_name_missing_basis_and_delta(
        self,
    ) -> None:
        self.assertEqual(
            _order_feed_fill_delta_blockers(
                {
                    "symbol": "AAPL",
                    "source_offset": 14,
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                }
            ),
            ["order_feed_fill_delta_basis_missing"],
        )
        self.assertEqual(
            _order_feed_fill_delta_blockers(
                {
                    "symbol": "AAPL",
                    "source_offset": 14,
                    "fill_quantity_basis": "delta",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                }
            ),
            ["order_feed_fill_delta_missing"],
        )
        self.assertEqual(
            _order_feed_fill_delta_blockers(
                {
                    "symbol": "AAPL",
                    "fill_quantity_basis": "delta",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                }
            ),
            [],
        )
        self.assertEqual(
            _order_feed_fill_delta_blockers(
                {
                    "symbol": "AAPL",
                    "source_offset": 14,
                    "fill_quantity_basis": "delta",
                    "filled_qty_delta": Decimal("1"),
                    "filled_qty": Decimal("2"),
                    "avg_fill_price": Decimal("100"),
                }
            ),
            [],
        )

    def test_fill_quantity_basis_aliases_are_normalized_for_import(self) -> None:
        self.assertEqual(
            _fill_quantity_basis({"fill_quantity_basis": "filled-delta"}), "delta"
        )
        self.assertEqual(
            _fill_quantity_basis({"fill_quantity_basis": "cum"}),
            "cumulative",
        )
        self.assertEqual(
            _fill_quantity_basis({"fill_quantity_basis": "unknown"}),
            "unknown",
        )
        self.assertEqual(
            _fill_quantity_basis({"fill_quantity_basis": "cumulative-non-increasing"}),
            "cumulative_non_increasing",
        )
        self.assertEqual(
            _fill_quantity_basis({"fill_quantity_basis": "broker custom"}),
            "broker_custom",
        )

    def test_build_realized_strategy_pnl_rows_rejects_shortfall_only_costs(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "shortfall_notional": Decimal("0.20"),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "shortfall_notional": Decimal("0.10"),
                },
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertIsNone(rows[0]["post_cost_expectancy_bps"])
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
        )
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            rows[0]["runtime_ledger_blockers"],
        )
        self.assertIn("explicit_cost_missing", rows[0]["runtime_ledger_blockers"])
        self.assertIn("cost_basis_missing", rows[0]["runtime_ledger_blockers"])

    def test_build_realized_strategy_pnl_rows_returns_empty_without_event_times(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": None,
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "shortfall_notional": Decimal("0.20"),
                }
            ]
        )

        self.assertEqual(rows, [])

    def test_query_timestamps_filters_to_execution_eligible_decisions(self) -> None:
        cursor = _FakeCursor()
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            decisions, executions, tca_rows = _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["intraday_tsmom_v1@paper", "intraday-tsmom-profit-v2"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                source_activity_diagnostics=diagnostics,
            )

        self.assertEqual(decisions, [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)])
        self.assertEqual(
            executions, [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)]
        )
        self.assertEqual(len(tca_rows), 2)
        self.assertEqual(tca_rows[0]["abs_slippage_bps"], Decimal("1.25"))
        self.assertEqual(tca_rows[0]["post_cost_expectancy_bps"], Decimal("0.50"))
        self.assertEqual(
            tca_rows[0]["computed_at"],
            datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
        )
        self.assertEqual(
            tca_rows[0]["tca_computed_at"],
            datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
        )
        self.assertEqual(
            tca_rows[0]["post_cost_expectancy_basis"], POST_COST_BASIS_TCA_PROXY
        )
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(tca_rows[1]["post_cost_promotion_eligible"], False)
        self.assertIn("unclosed_position", tca_rows[1]["runtime_ledger_blockers"])
        self.assertEqual(len(cursor.executed), 4)
        decision_query, decision_params = cursor.executed[0]
        self.assertIn("s.name = any(%s)", decision_query)
        self.assertIn("d.status = any(%s)", decision_query)
        self.assertEqual(
            decision_params[0],
            ["intraday_tsmom_v1@paper", "intraday-tsmom-profit-v2"],
        )
        self.assertEqual(
            decision_params[2],
            list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
        )
        order_event_query, _ = cursor.executed[2]
        tca_query, _ = cursor.executed[3]
        execution_query, _ = cursor.executed[1]
        self.assertIn("left join execution_tca_metrics", execution_query)
        self.assertIn("e.alpaca_account_label = %s", execution_query)
        self.assertIn("e.order_feed_last_event_ts", execution_query)
        self.assertIn("e.last_update_at", execution_query)
        self.assertIn("e.updated_at", execution_query)
        self.assertIn("e.created_at", execution_query)
        self.assertNotIn("and d.created_at >= %s", execution_query)
        self.assertNotIn("and d.created_at < %s", execution_query)
        self.assertIn("from execution_order_events oe", order_event_query)
        self.assertIn("oe.alpaca_account_label = %s", order_event_query)
        self.assertIn("e.execution_audit_json", order_event_query)
        self.assertIn("e.raw_order", order_event_query)
        self.assertIn("coalesce(oe.event_ts, oe.created_at) >= %s", order_event_query)
        self.assertIn("coalesce(oe.event_ts, oe.created_at) < %s", order_event_query)
        self.assertNotIn("and d.created_at >= %s", order_event_query)
        self.assertNotIn("and d.created_at < %s", order_event_query)
        self.assertIn("as execution_event_at", tca_query)
        self.assertIn("t.computed_at as tca_computed_at", tca_query)
        self.assertIn(
            "coalesce(t.alpaca_account_label, e.alpaca_account_label, d.alpaca_account_label) = %s",
            tca_query,
        )
        self.assertIn("e.order_feed_last_event_ts", tca_query)
        self.assertIn("e.last_update_at", tca_query)
        self.assertIn("e.updated_at", tca_query)
        self.assertIn("e.created_at", tca_query)
        self.assertNotIn("t.computed_at >= %s", tca_query)
        self.assertNotIn("t.computed_at < %s", tca_query)
        self.assertNotIn("and d.created_at >= %s", tca_query)
        self.assertNotIn("and d.created_at < %s", tca_query)
        self.assertEqual(diagnostics["decision_rows_before_lineage_filter"], 1)
        self.assertEqual(diagnostics["decision_rows_after_lineage_filter"], 1)
        self.assertEqual(diagnostics["execution_rows_before_lineage_filter"], 1)
        self.assertEqual(diagnostics["execution_rows_after_lineage_filter"], 1)
        self.assertEqual(diagnostics["order_lifecycle_rows_before_lineage_filter"], 1)
        self.assertEqual(diagnostics["tca_rows_before_lineage_filter"], 1)

    def test_query_timestamps_records_unattributed_fill_lifecycle_diagnostics(
        self,
    ) -> None:
        cursor = _FakeCursor()
        cursor._results = [
            [],
            [],
            [],
            [
                (
                    "unlinked-event-id",
                    None,
                    None,
                    datetime(2026, 3, 6, 14, 41, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    None,
                    None,
                    None,
                    "external-close-order",
                    "external-close-client",
                    "fill",
                    "filled",
                    "unlinked-event-fingerprint",
                    "alpaca-trade-updates",
                    0,
                    42,
                    "source-window-external",
                    {},
                    None,
                    None,
                )
            ],
            [],
        ]
        connection = _FakeConnection(cursor)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["microbar-cross-sectional-pairs-v1"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                symbols=["AAPL"],
                source_activity_diagnostics=diagnostics,
            )

        self.assertEqual(len(cursor.executed), 5)
        unlinked_query, unlinked_params = cursor.executed[3]
        self.assertIn("from execution_order_events oe", unlinked_query)
        self.assertIn("left join lateral", unlinked_query)
        self.assertIn("exact_match.match_count = 1", unlinked_query)
        self.assertIn(
            "or coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id) is null",
            unlinked_query,
        )
        self.assertIn("exact_decision_match.match_count = 1", unlinked_query)
        self.assertIn("d_match.decision_hash = oe.client_order_id", unlinked_query)
        self.assertIn("upper(oe.symbol) = any(%s)", unlinked_query)
        self.assertEqual(unlinked_params[-1], ["AAPL"])
        self.assertEqual(diagnostics["order_feed_unlinked_fill_lifecycle_count"], 1)
        self.assertEqual(
            diagnostics["order_feed_unlinked_fill_lifecycle_event_ids"],
            ["unlinked-event-id"],
        )
        self.assertEqual(
            diagnostics["order_feed_unlinked_strategy_fill_lifecycle_count"], 0
        )
        self.assertEqual(
            diagnostics["order_feed_unlinked_strategy_fill_lifecycle_event_ids"],
            [],
        )
        self.assertEqual(diagnostics["order_feed_unattributed_fill_lifecycle_count"], 1)
        self.assertEqual(
            diagnostics["order_feed_unattributed_fill_lifecycle_event_ids"],
            ["unlinked-event-id"],
        )
        self.assertNotIn(
            "order_feed_unlinked_fill_lifecycle_present",
            _source_activity_diagnostics_blockers(diagnostics),
        )

    def test_query_timestamps_blocks_strategy_matching_unlinked_fill_lifecycle(
        self,
    ) -> None:
        cursor = _FakeCursor()
        execution_row = _FakeCursor()._results[1][0]
        cursor._results = [
            [],
            [execution_row],
            [],
            [
                (
                    "unlinked-event-id",
                    None,
                    None,
                    datetime(2026, 3, 6, 14, 41, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    None,
                    None,
                    None,
                    "alpaca-order-1",
                    "client-order-1",
                    "fill",
                    "filled",
                    "unlinked-event-fingerprint",
                    "alpaca-trade-updates",
                    0,
                    42,
                    "source-window-external",
                    {},
                    None,
                    None,
                )
            ],
            [],
        ]
        connection = _FakeConnection(cursor)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["microbar-cross-sectional-pairs-v1"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                symbols=["AAPL"],
                source_activity_diagnostics=diagnostics,
            )

        self.assertEqual(diagnostics["order_feed_unlinked_fill_lifecycle_count"], 1)
        self.assertEqual(
            diagnostics["order_feed_unlinked_strategy_fill_lifecycle_count"], 1
        )
        self.assertEqual(
            diagnostics["order_feed_unlinked_strategy_fill_lifecycle_event_ids"],
            ["unlinked-event-id"],
        )
        self.assertEqual(diagnostics["order_feed_unattributed_fill_lifecycle_count"], 0)
        self.assertIn(
            "order_feed_unlinked_fill_lifecycle_present",
            _source_activity_diagnostics_blockers(diagnostics),
        )

    def test_query_timestamps_materializes_exact_order_identity_lifecycle(
        self,
    ) -> None:
        cursor = _FakeCursor()
        cursor._results = [
            [
                (
                    "decision-id-1",
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-sha",
                    {},
                )
            ],
            [_FakeCursor()._results[1][0]],
            [
                (
                    "source-event-id-1",
                    "decision-id-1",
                    "execution-id-1",
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-sha",
                    {},
                    "alpaca-order-1",
                    "client-order-1",
                    "fill",
                    "filled",
                    "buy",
                    Decimal("1"),
                    Decimal("1"),
                    Decimal("100"),
                    "source-event-fingerprint-1",
                    "torghut.trade-updates.v1",
                    0,
                    35803,
                    "source-window-1",
                    {},
                    {
                        "cost_amount": "0.01",
                        "cost_basis": "broker_reported_commission_and_fees",
                    },
                    {
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                    },
                )
            ],
            [],
            [],
        ]
        connection = _FakeConnection(cursor)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["microbar-cross-sectional-pairs-v1"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                symbols=["AAPL"],
                source_activity_diagnostics=diagnostics,
            )

        order_event_query, _ = cursor.executed[2]
        unlinked_query, _ = cursor.executed[3]
        self.assertIn("left join lateral", order_event_query)
        self.assertIn("exact_match.match_count = 1", order_event_query)
        self.assertIn(
            "coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id)",
            order_event_query,
        )
        self.assertIn("exact_decision_match.match_count = 1", order_event_query)
        self.assertIn("d_match.decision_hash = oe.client_order_id", order_event_query)
        self.assertIn("left join lateral", unlinked_query)
        self.assertIn("exact_match.match_count = 1", unlinked_query)
        self.assertIn("exact_decision_match.match_count = 1", unlinked_query)
        self.assertIn("d_match.decision_hash = oe.client_order_id", unlinked_query)
        self.assertEqual(diagnostics["order_feed_unlinked_fill_lifecycle_count"], 0)
        self.assertEqual(
            diagnostics["order_feed_unlinked_strategy_fill_lifecycle_count"], 0
        )
        self.assertEqual(
            diagnostics["fill_order_lifecycle_rows_after_lineage_filter"], 1
        )
        self.assertNotIn(
            "order_feed_unlinked_fill_lifecycle_present",
            _source_activity_diagnostics_blockers(diagnostics),
        )

    def test_query_timestamps_uses_source_account_but_materializes_target_account(
        self,
    ) -> None:
        cursor = _FakeCursor()
        cursor._results = [
            [
                tuple(
                    "TORGHUT_REPLAY" if item == "TORGHUT_SIM" else item for item in row
                )
                for row in rows
            ]
            for rows in cursor._results
        ]
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _, _, tca_rows = _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["intraday_tsmom_v1@paper"],
                account_label="TORGHUT_REPLAY",
                target_account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                source_activity_diagnostics=diagnostics,
            )

        for _, params in cursor.executed:
            self.assertIn("TORGHUT_REPLAY", params)
            self.assertNotIn("TORGHUT_SIM", params)
        self.assertEqual(diagnostics["account_label"], "TORGHUT_SIM")
        self.assertEqual(diagnostics["source_account_label"], "TORGHUT_REPLAY")
        runtime_bucket = tca_rows[1]["runtime_ledger_bucket"]
        self.assertEqual(runtime_bucket["account_label"], "TORGHUT_SIM")
        self.assertEqual(runtime_bucket["source_account_label"], "TORGHUT_REPLAY")
        self.assertEqual(
            diagnostics["order_feed_fill_lifecycle_blockers"],
            ["order_feed_fill_lifecycle_missing"],
        )

    def test_query_timestamps_materializes_source_backed_carry_in(
        self,
    ) -> None:
        def decision_row(
            decision_id: str,
            created_at: datetime,
            decision_hash: str,
        ) -> tuple[object, ...]:
            return (
                decision_id,
                created_at,
                "AAPL",
                "TORGHUT_SIM",
                "microbar-cross-sectional-pairs-v1",
                decision_hash,
                {},
            )

        def execution_row(
            execution_id: str,
            decision_id: str,
            decision_created_at: datetime,
            event_at: datetime,
            side: str,
            qty: str,
            price: str,
            order_id: str,
            decision_hash: str,
        ) -> tuple[object, ...]:
            return (
                execution_id,
                decision_id,
                decision_created_at,
                event_at,
                event_at,
                "AAPL",
                side,
                Decimal(qty),
                Decimal(price),
                Decimal("0.01"),
                {
                    "cost_amount": "0.01",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
                {},
                "TORGHUT_SIM",
                "microbar-cross-sectional-pairs-v1",
                decision_hash,
                {},
                order_id,
                f"client-{order_id}",
                "filled",
            )

        def order_event_row(
            event_id: str,
            decision_id: str,
            execution_id: str,
            event_at: datetime,
            event_type: str,
            side: str,
            qty: str,
            price: str,
            order_id: str,
            decision_hash: str,
            source_offset: int,
        ) -> tuple[object, ...]:
            return (
                event_id,
                decision_id,
                execution_id,
                event_at,
                "AAPL",
                "TORGHUT_SIM",
                "microbar-cross-sectional-pairs-v1",
                decision_hash,
                {},
                order_id,
                f"client-{order_id}",
                event_type,
                "filled" if event_type == "filled" else "new",
                side,
                Decimal(qty),
                Decimal(qty) if event_type == "filled" else Decimal("0"),
                Decimal(price),
                f"fingerprint-{event_id}",
                "alpaca.trade_updates",
                0,
                source_offset,
                f"source-window-{event_id}",
                {},
                {
                    "cost_amount": "0.01",
                    "cost_basis": "broker_reported_commission_and_fees",
                },
                {},
            )

        cursor = _FakeCursor()
        cursor._results = [
            [
                decision_row(
                    "decision-sell-id",
                    datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    "decision-sell",
                )
            ],
            [
                execution_row(
                    "execution-sell",
                    "decision-sell-id",
                    datetime(2026, 3, 6, 14, 39, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "sell",
                    "1",
                    "101",
                    "order-sell",
                    "decision-sell",
                )
            ],
            [
                order_event_row(
                    "event-fill-sell",
                    "decision-sell-id",
                    "execution-sell",
                    datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                    "filled",
                    "sell",
                    "1",
                    "101",
                    "order-sell",
                    "decision-sell",
                    202,
                )
            ],
            [
                decision_row(
                    "decision-buy-id",
                    datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    "decision-buy",
                )
            ],
            [
                execution_row(
                    "execution-buy",
                    "decision-buy-id",
                    datetime(2026, 3, 6, 14, 34, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "buy",
                    "1",
                    "100",
                    "order-buy",
                    "decision-buy",
                )
            ],
            [
                order_event_row(
                    "event-fill-buy",
                    "decision-buy-id",
                    "execution-buy",
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "filled",
                    "buy",
                    "1",
                    "100",
                    "order-buy",
                    "decision-buy",
                    200,
                )
            ],
            [],
            [],
        ]
        connection = _FakeConnection(cursor)
        diagnostics: dict[str, object] = {}

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _, _, tca_rows = _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["microbar-cross-sectional-pairs-v1"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 14, 45, tzinfo=timezone.utc),
                symbols=["AAPL"],
                allow_authoritative_runtime_ledger_materialization=True,
                source_activity_diagnostics=diagnostics,
            )

        self.assertEqual(len(cursor.executed), 8)
        carry_decision_query, carry_decision_params = cursor.executed[3]
        carry_execution_query, carry_execution_params = cursor.executed[4]
        carry_order_query, carry_order_params = cursor.executed[5]
        self.assertIn("d.created_at >= %s", carry_decision_query)
        self.assertIn("d.created_at < %s", carry_decision_query)
        self.assertIn("from executions e", carry_execution_query)
        self.assertIn("from execution_order_events oe", carry_order_query)
        self.assertEqual(
            carry_decision_params[3],
            datetime(2026, 3, 1, 14, 40, tzinfo=timezone.utc),
        )
        self.assertEqual(
            carry_execution_params[3],
            datetime(2026, 3, 1, 14, 40, tzinfo=timezone.utc),
        )
        self.assertEqual(
            carry_order_params[3],
            datetime(2026, 3, 1, 14, 40, tzinfo=timezone.utc),
        )
        self.assertEqual(diagnostics["carry_in_decision_rows_before_lineage_filter"], 1)
        self.assertEqual(diagnostics["carry_in_decision_rows_after_lineage_filter"], 1)
        self.assertEqual(
            diagnostics["carry_in_execution_rows_before_lineage_filter"], 1
        )
        self.assertEqual(diagnostics["carry_in_execution_rows_after_lineage_filter"], 1)
        self.assertEqual(
            diagnostics["carry_in_fill_execution_rows_before_lineage_filter"], 1
        )
        self.assertEqual(
            diagnostics["carry_in_fill_execution_rows_after_lineage_filter"], 1
        )
        self.assertEqual(
            diagnostics["carry_in_order_lifecycle_rows_before_lineage_filter"], 1
        )
        self.assertEqual(
            diagnostics["carry_in_order_lifecycle_rows_after_lineage_filter"], 1
        )
        self.assertEqual(
            diagnostics["carry_in_fill_order_lifecycle_rows_before_lineage_filter"], 1
        )
        self.assertEqual(
            diagnostics["carry_in_fill_order_lifecycle_rows_after_lineage_filter"], 1
        )
        runtime_rows = [
            row
            for row in tca_rows
            if row.get("post_cost_expectancy_basis") == POST_COST_BASIS_RUNTIME_LEDGER
        ]
        self.assertEqual(len(runtime_rows), 1)
        bucket = runtime_rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["closed_trade_count"], 1)
        self.assertEqual(bucket["open_position_count"], 0)
        self.assertEqual(bucket["source_window_start"], "2026-03-06T14:35:00+00:00")
        self.assertEqual(
            bucket["source_window_end"], "2026-03-06T14:40:00.000001+00:00"
        )

    def test_source_activity_diagnostic_blockers_classify_materialization_gap(
        self,
    ) -> None:
        self.assertEqual(
            _source_activity_diagnostics_blockers(
                {
                    "decision_rows_before_lineage_filter": 2,
                    "decision_rows_after_lineage_filter": 0,
                    "execution_rows_before_lineage_filter": 1,
                    "execution_rows_after_lineage_filter": 0,
                    "runtime_ledger_source_bucket_count": 0,
                }
            ),
            [
                "source_lineage_filter_excluded_activity",
                "runtime_ledger_source_bucket_missing",
            ],
        )
        self.assertEqual(
            _source_activity_diagnostics_blockers(
                {
                    "decision_rows_before_lineage_filter": 1,
                    "decision_rows_after_lineage_filter": 1,
                    "execution_rows_before_lineage_filter": 0,
                    "execution_rows_after_lineage_filter": 0,
                    "runtime_ledger_source_bucket_count": 0,
                }
            ),
            [
                "execution_rows_missing_for_matched_decisions",
                "runtime_ledger_source_bucket_missing",
            ],
        )
        self.assertEqual(
            _source_activity_diagnostics_blockers(
                {
                    "decision_rows_before_lineage_filter": 1,
                    "decision_rows_after_lineage_filter": 1,
                    "execution_rows_before_lineage_filter": 1,
                    "execution_rows_after_lineage_filter": 1,
                    "order_lifecycle_rows_before_lineage_filter": 1,
                    "tca_rows_after_lineage_filter": 1,
                    "runtime_ledger_source_bucket_count": 1,
                    "runtime_ledger_source_bucket_profit_proof_count": 0,
                    "runtime_ledger_source_bucket_profit_proof_blockers": [
                        "runtime_ledger_lineage_hash_missing"
                    ],
                }
            ),
            [
                "runtime_ledger_source_bucket_profit_proof_missing",
                "runtime_ledger_lineage_hash_missing",
            ],
        )

    def test_query_timestamps_filters_to_target_symbols_when_configured(
        self,
    ) -> None:
        cursor = _FakeCursor()
        cursor._results.insert(3, [])
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["intraday_tsmom_v1@paper"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                symbols=[" aapl ", "AAPL"],
            )

        self.assertEqual(len(cursor.executed), 5)
        decision_query, decision_params = cursor.executed[0]
        execution_query, execution_params = cursor.executed[1]
        order_event_query, order_event_params = cursor.executed[2]
        unlinked_query, unlinked_params = cursor.executed[3]
        tca_query, tca_params = cursor.executed[4]
        self.assertIn("upper(d.symbol) = any(%s)", decision_query)
        self.assertEqual(decision_params[-1], ["AAPL"])
        self.assertIn("upper(d.symbol) = any(%s)", execution_query)
        self.assertIn("upper(e.symbol) = any(%s)", execution_query)
        self.assertEqual(execution_params[-2:], (["AAPL"], ["AAPL"]))
        self.assertIn("upper(d.symbol) = any(%s)", order_event_query)
        self.assertIn(
            "upper(coalesce(oe.symbol, e.symbol, d.symbol)) = any(%s)",
            order_event_query,
        )
        self.assertEqual(order_event_params[-2:], (["AAPL"], ["AAPL"]))
        self.assertIn("from execution_order_events oe", unlinked_query)
        self.assertIn("left join lateral", unlinked_query)
        self.assertIn("exact_match.match_count = 1", unlinked_query)
        self.assertIn(
            "or coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id) is null",
            unlinked_query,
        )
        self.assertIn("exact_decision_match.match_count = 1", unlinked_query)
        self.assertIn("d_match.decision_hash = oe.client_order_id", unlinked_query)
        self.assertIn("upper(oe.symbol) = any(%s)", unlinked_query)
        self.assertEqual(unlinked_params[-1], ["AAPL"])
        self.assertIn("upper(d.symbol) = any(%s)", tca_query)
        self.assertIn("upper(e.symbol) = any(%s)", tca_query)
        self.assertEqual(tca_params[-2:], (["AAPL"], ["AAPL"]))

    def test_query_timestamps_requires_source_lineage_for_candidate_import(
        self,
    ) -> None:
        cursor = _FakeCursor()
        matched_json = {"candidate_id": "cand-a", "hypothesis_id": "H-A"}
        unscoped_json: dict[str, object] = {}
        cursor._results = [
            [
                (
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-matched",
                    matched_json,
                ),
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-unscoped",
                    unscoped_json,
                ),
            ],
            [
                (
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 35, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 35, 30, tzinfo=timezone.utc),
                    "AAPL",
                    "buy",
                    Decimal("1"),
                    Decimal("100"),
                    Decimal("0.01"),
                    {
                        "cost_amount": "0.01",
                        "cost_basis": "broker_reported_commission_and_fees",
                    },
                    {},
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-matched",
                    matched_json,
                    "alpaca-order-matched",
                    "client-order-matched",
                    "filled",
                ),
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 36, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 14, 36, 30, tzinfo=timezone.utc),
                    "AAPL",
                    "buy",
                    Decimal("1"),
                    Decimal("100"),
                    Decimal("0.01"),
                    {},
                    {},
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-unscoped",
                    unscoped_json,
                    "alpaca-order-unscoped",
                    "client-order-unscoped",
                    "filled",
                ),
            ],
            [
                (
                    datetime(2026, 3, 6, 14, 35, 1, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-matched",
                    matched_json,
                    "alpaca-order-matched",
                    "client-order-matched",
                    "new",
                    "new",
                    "event-fingerprint-matched",
                    "alpaca-trade-updates",
                    0,
                    1,
                    {
                        "execution_policy": {"selected_order_type": "market"},
                        "cost_model": {"source": "broker_reported"},
                    },
                    {
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                    },
                    {
                        "cost_amount": "0.01",
                        "cost_basis": "broker_reported_commission_and_fees",
                    },
                ),
                (
                    datetime(2026, 3, 6, 14, 36, 1, tzinfo=timezone.utc),
                    "AAPL",
                    "TORGHUT_SIM",
                    "microbar-cross-sectional-pairs-v1",
                    "decision-unscoped",
                    unscoped_json,
                    "alpaca-order-unscoped",
                    "client-order-unscoped",
                    "new",
                    "new",
                    "event-fingerprint-unscoped",
                    "alpaca-trade-updates",
                    0,
                    2,
                    {},
                    {},
                    {},
                ),
            ],
            [
                (
                    datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
                    Decimal("1.25"),
                    Decimal("0.50"),
                    "decision-matched",
                    matched_json,
                ),
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    Decimal("9.99"),
                    Decimal("-9.99"),
                    "decision-unscoped",
                    unscoped_json,
                ),
            ],
        ]
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            decisions, executions, tca_rows = _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["microbar-cross-sectional-pairs-v1"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                candidate_id="cand-a",
                hypothesis_id="H-A",
                require_source_lineage=True,
            )

        self.assertEqual(decisions, [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)])
        self.assertEqual(
            executions, [datetime(2026, 3, 6, 14, 35, 30, tzinfo=timezone.utc)]
        )
        proxy_rows = [
            row
            for row in tca_rows
            if row.get("post_cost_expectancy_basis") == POST_COST_BASIS_TCA_PROXY
        ]
        self.assertEqual(len(proxy_rows), 1)
        self.assertEqual(proxy_rows[0]["decision_hash"], "decision-matched")
        self.assertEqual(proxy_rows[0]["post_cost_expectancy_bps"], Decimal("0.50"))

    def test_query_timestamps_requires_strategy_name_candidates(self) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with self.assertRaisesRegex(RuntimeError, "strategy_name_not_configured"):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=[],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
            )

    def test_runtime_ledger_artifacts_build_non_authoritative_tca_rows(self) -> None:
        with TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "exact-ledger.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "candidate_id": "artifact-candidate-1",
                        "window_start": "2026-03-06",
                        "window_end": "2026-03-06",
                        "account_label": "TORGHUT_SIM",
                        "strategy_id": "intraday-tsmom-profit-v3",
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                        "runtime_ledger_rows": [
                            {
                                "event_type": "decision",
                                "executed_at": "2026-03-06T14:35:00Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                            },
                            {
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-06T14:35:01Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                            },
                            {
                                "event_type": "fill",
                                "executed_at": "2026-03-06T14:35:02Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                                "symbol": "AAPL",
                                "side": "buy",
                                "filled_qty": "1",
                                "avg_fill_price": "100",
                                "cost_amount": "0.10",
                                "cost_basis": "broker_reported_commission_and_fees",
                            },
                            {
                                "event_type": "decision",
                                "executed_at": "2026-03-06T14:40:00Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                            },
                            {
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-06T14:40:01Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                            },
                            {
                                "event_type": "fill",
                                "executed_at": "2026-03-06T14:40:02Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                                "symbol": "AAPL",
                                "side": "sell",
                                "filled_qty": "1",
                                "avg_fill_price": "101",
                                "cost_amount": "0.10",
                                "cost_basis": "broker_reported_commission_and_fees",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )

            decisions, executions, tca_rows, metadata = (
                _runtime_ledger_tca_rows_from_artifacts(
                    artifact_refs=[str(artifact_path)],
                    bucket_ranges=[
                        (
                            datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                            datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                            6,
                        )
                    ],
                )
            )

        self.assertEqual(
            decisions,
            [
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
            ],
        )
        self.assertEqual(len(executions), 2)
        self.assertEqual(len(tca_rows), 1)
        self.assertEqual(
            tca_rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_RUNTIME_LEDGER,
        )
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(tca_rows[0]["authoritative"], False)
        self.assertEqual(
            tca_rows[0]["authority_reason"],
            "exact_replay_artifact_not_runtime_proof",
        )
        self.assertEqual(
            tca_rows[0]["pnl_derivation"], "exact_replay_artifact_only_not_live"
        )
        self.assertIn(
            "exact_replay_artifact_not_runtime_proof",
            tca_rows[0]["runtime_ledger_blockers"],
        )
        self.assertIn(
            "runtime_ledger_source_window_missing",
            tca_rows[0]["runtime_ledger_blockers"],
        )
        self.assertIn(
            "runtime_ledger_source_refs_missing",
            tca_rows[0]["runtime_ledger_blockers"],
        )
        ledger_bucket = tca_rows[0]["runtime_ledger_bucket"]
        assert isinstance(ledger_bucket, dict)
        self.assertEqual(
            ledger_bucket["ledger_schema_version"], "torghut.exact_replay_ledger.v1"
        )
        self.assertEqual(ledger_bucket["pnl_basis"], POST_COST_BASIS_RUNTIME_LEDGER)
        self.assertEqual(ledger_bucket["decision_count"], 2)
        self.assertEqual(ledger_bucket["submitted_order_count"], 2)
        self.assertEqual(ledger_bucket["closed_trade_count"], 1)
        self.assertIn(
            "exact_replay_artifact_not_runtime_proof", ledger_bucket["blockers"]
        )
        self.assertEqual(metadata["runtime_ledger_artifact_row_count"], 6)
        self.assertEqual(metadata["runtime_ledger_artifact_tca_row_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_artifact_authority_class"],
            "exact_replay_artifact_only_not_live",
        )
        self.assertEqual(
            metadata["runtime_ledger_artifact_authority_blockers"],
            [
                "exact_replay_artifact_not_runtime_proof",
                "runtime_ledger_source_window_missing",
                "runtime_ledger_source_refs_missing",
            ],
        )
        self.assertEqual(
            metadata["runtime_ledger_artifact_candidate_id"], "artifact-candidate-1"
        )
        self.assertEqual(
            metadata["runtime_ledger_artifact_candidate_ids"],
            ["artifact-candidate-1"],
        )
        self.assertEqual(metadata["runtime_ledger_artifact_window_weekday_count"], 1)

    def test_runtime_ledger_artifacts_derive_candidate_ids_from_rows(self) -> None:
        with TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "exact-ledger-row-candidates.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "account_label": "TORGHUT_SIM",
                        "strategy_id": "intraday-tsmom-profit-v3",
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                        "runtime_ledger_rows": [
                            {
                                "candidate_id": "row-candidate-1",
                                "event_type": "decision",
                                "executed_at": "2026-03-06T14:35:00Z",
                                "decision_id": "decision-buy",
                            },
                            {
                                "candidate_id": "row-candidate-1",
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-06T14:35:01Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                            },
                            {
                                "candidate_id": "row-candidate-1",
                                "event_type": "fill",
                                "executed_at": "2026-03-06T14:35:02Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                                "symbol": "AAPL",
                                "side": "buy",
                                "filled_qty": "1",
                                "avg_fill_price": "100",
                                "cost_amount": "0.10",
                                "cost_basis": "broker_reported_commission_and_fees",
                            },
                            {
                                "candidate_id": "row-candidate-2",
                                "event_type": "decision",
                                "executed_at": "2026-03-06T14:40:00Z",
                                "decision_id": "decision-sell",
                            },
                            {
                                "candidate_id": "row-candidate-2",
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-06T14:40:01Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                            },
                            {
                                "candidate_id": "row-candidate-2",
                                "event_type": "fill",
                                "executed_at": "2026-03-06T14:40:02Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                                "symbol": "AAPL",
                                "side": "sell",
                                "filled_qty": "1",
                                "avg_fill_price": "101",
                                "cost_amount": "0.10",
                                "cost_basis": "broker_reported_commission_and_fees",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )

            _, _, tca_rows, metadata = _runtime_ledger_tca_rows_from_artifacts(
                artifact_refs=[str(artifact_path)],
                bucket_ranges=[
                    (
                        datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                        datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                        6,
                    )
                ],
            )

        self.assertEqual(
            metadata["runtime_ledger_artifact_candidate_ids"],
            ["row-candidate-1", "row-candidate-2"],
        )
        self.assertNotIn("runtime_ledger_artifact_candidate_id", metadata)
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], False)
        self.assertIn(
            "runtime_ledger_artifact_candidate_id_ambiguous",
            tca_rows[0]["runtime_ledger_blockers"],
        )

    def test_runtime_ledger_artifact_helpers_fail_closed_on_loose_rows(self) -> None:
        aware_time = datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)
        naive_time = datetime(2026, 3, 6, 14, 35)

        self.assertEqual(_parse_dt_or_none(aware_time), aware_time)
        self.assertEqual(_parse_dt_or_none(naive_time), aware_time)
        self.assertEqual(_parse_dt_or_none(""), None)
        self.assertEqual(_parse_dt_or_none("not-a-date"), None)
        self.assertEqual(_runtime_ledger_event_type({"filled_qty": "1"}), "fill")
        self.assertEqual(
            _runtime_ledger_event_type({"order_id": "alpaca-order-1"}),
            "order_submitted",
        )
        self.assertEqual(
            _runtime_ledger_event_type({"decision_id": "decision-1"}),
            "decision",
        )
        self.assertEqual(_runtime_ledger_event_type({}), "diagnostic")

        with TemporaryDirectory() as temp_dir:
            missing_path = Path(temp_dir) / "missing.json"
            malformed_rows_path = Path(temp_dir) / "malformed-rows.json"
            diagnostic_path = Path(temp_dir) / "diagnostic.json"
            malformed_rows_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "runtime_ledger_rows": {"bad": "shape"},
                    }
                ),
                encoding="utf-8",
            )
            diagnostic_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "runtime_ledger_rows": [
                            {"event_type": "diagnostic"},
                            {
                                "event_type": "diagnostic",
                                "executed_at": "2026-03-06T14:35:00Z",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )

            decisions, executions, tca_rows, metadata = (
                _runtime_ledger_tca_rows_from_artifacts(
                    artifact_refs=[
                        str(missing_path),
                        str(malformed_rows_path),
                        str(diagnostic_path),
                    ],
                    bucket_ranges=[
                        (
                            datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                            datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                            6,
                        )
                    ],
                )
            )

        self.assertEqual(decisions, [])
        self.assertEqual(executions, [])
        self.assertEqual(tca_rows, [])
        self.assertEqual(
            metadata["runtime_ledger_artifact_refs"], [str(diagnostic_path)]
        )
        self.assertEqual(
            metadata["runtime_ledger_ignored_artifact_refs"],
            [str(malformed_rows_path)],
        )
        self.assertEqual(metadata["runtime_ledger_artifact_row_count"], 2)
        self.assertEqual(metadata["runtime_ledger_artifact_tca_row_count"], 0)

    def test_main_rejects_artifact_refs_without_exact_runtime_ledger_rows(self) -> None:
        with TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "malformed-rows.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "runtime_ledger_rows": {"bad": "shape"},
                    }
                ),
                encoding="utf-8",
            )
            args = SimpleNamespace(
                run_id="run-empty-ledger-artifact",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_family="intraday_tsmom_consistent",
                source_dsn="",
                source_dsn_env="DB_DSN",
                strategy_name="intraday-tsmom-profit-v3",
                account_label="TORGHUT_SIM",
                window_start="2026-03-06T14:30:00Z",
                window_end="2026-03-06T15:00:00Z",
                bucket_minutes=30,
                sample_minutes=5,
                source_manifest_ref="config/trading/hypotheses/h-tsmom-liq-01.json",
                source_kind="paper_runtime_observed",
                artifact_ref=[str(artifact_path)],
                delay_adjusted_depth_stress_report_ref="",
                dataset_snapshot_ref="runtime-ledger-empty-artifact-snapshot",
                target_metadata_json="",
                dependency_quorum_decision="allow",
                continuity_ok="true",
                drift_ok="true",
                json=False,
            )
            manifest = SimpleNamespace(
                strategy_family="intraday_tsmom_consistent",
                strategy_id="intraday_tsmom_v2@research",
                max_allowed_slippage_bps=Decimal("6"),
            )

            with (
                patch(
                    "scripts.import_hypothesis_runtime_windows._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                    return_value=(
                        SimpleNamespace(
                            path="config/trading/hypotheses/h-tsmom-liq-01.json"
                        ),
                        manifest,
                    ),
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_durable_buckets",
                    return_value=(
                        [],
                        {
                            "runtime_ledger_durable_bucket_count": 0,
                            "runtime_ledger_durable_bucket_run_ids": [],
                            "runtime_ledger_durable_bucket_fill_count": 0,
                            "runtime_ledger_durable_bucket_tca_row_count": 0,
                            "runtime_ledger_durable_bucket_profit_proof_count": 0,
                        },
                    ),
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.SessionLocal",
                    return_value=_FakeSession(),
                ),
                patch.dict("os.environ", {}, clear=True),
            ):
                with self.assertRaisesRegex(RuntimeError, "source_dsn_not_configured"):
                    main()

    def test_main_preserves_registry_manifest_fallback_when_source_manifest_ref_missing(
        self,
    ) -> None:
        args = SimpleNamespace(
            run_id="run-1",
            candidate_id="cand-1",
            hypothesis_id="H-CONT-01",
            observed_stage="paper",
            strategy_family="",
            source_dsn="postgresql://example",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v2",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="",
            source_kind="simulation_paper_runtime",
            artifact_ref=[],
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        fake_session = _FakeSession()
        manifest = SimpleNamespace(
            strategy_family="intraday_continuation",
            strategy_id="intraday_tsmom_v1@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=(
                    [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                    [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                    [],
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                return_value=[],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-1"},
            ) as persist_windows,
            patch(
                "scripts.import_hypothesis_runtime_windows.SessionLocal",
                return_value=fake_session,
            ),
            patch("builtins.print"),
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        self.assertTrue(fake_session.committed)
        self.assertEqual(persist_windows.call_args.kwargs["source_manifest_ref"], None)
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(runtime_payload["dataset_snapshot_ref"], None)
        self.assertEqual(
            runtime_payload["strategy_name_candidates"],
            [
                "intraday-tsmom-profit-v2",
                "intraday_tsmom_v1@paper",
                "intraday_tsmom_v1",
                "intraday-tsmom-v1@paper",
                "intraday-tsmom-v1",
            ],
        )

    def test_main_audit_only_reports_source_to_ledger_path_without_persisting(
        self,
    ) -> None:
        args = SimpleNamespace(
            run_id="run-audit",
            candidate_id="cand-audit",
            hypothesis_id="H-CONT-01",
            observed_stage="paper",
            strategy_family="",
            source_dsn="postgresql://example",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v2",
            account_label="TORGHUT_SIM",
            source_account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="",
            source_kind="paper_runtime_observed",
            artifact_ref=[],
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="runtime-audit-snapshot",
            target_metadata_json="",
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            audit_only=True,
            json=True,
        )
        manifest = SimpleNamespace(
            strategy_family="intraday_continuation",
            strategy_id="intraday_tsmom_v1@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )
        runtime_bucket = _complete_runtime_ledger_bucket()
        tca_row = {
            "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
            "abs_slippage_bps": Decimal("1"),
            "post_cost_expectancy_bps": Decimal("40"),
            "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
            "post_cost_promotion_eligible": True,
            "source_decision_mode": "strategy_signal_paper",
            "runtime_ledger_bucket": runtime_bucket,
        }

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=(
                    [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                    [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                    [tca_row],
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_source_dsn",
                return_value=(
                    [],
                    {
                        "runtime_ledger_source_bucket_count": 0,
                        "runtime_ledger_source_bucket_run_ids": [],
                        "runtime_ledger_source_bucket_fill_count": 0,
                        "runtime_ledger_source_bucket_tca_row_count": 0,
                        "runtime_ledger_source_bucket_profit_proof_count": 0,
                    },
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                return_value=[
                    (
                        datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                        datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                        6,
                    )
                ],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[
                    SimpleNamespace(
                        payload_json={
                            "runtime_ledger_profit_proof_present": True,
                            "runtime_ledger_profit_proof_blockers": [],
                        }
                    )
                ],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-audit"},
            ) as persist_windows,
            patch("builtins.print") as print_result,
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        persist_windows.assert_not_called()
        summary = json.loads(print_result.call_args.args[0])
        self.assertEqual(
            summary["schema_version"],
            "torghut.runtime-window-import-source-audit.v1",
        )
        self.assertEqual(summary["verdict"], "profit_proof_present")
        self.assertEqual(summary["decision_count"], 1)
        self.assertEqual(summary["execution_count"], 1)
        self.assertEqual(summary["tca_row_count"], 1)
        self.assertEqual(summary["runtime_ledger_bucket_row_count"], 1)
        self.assertTrue(summary["runtime_ledger_profit_proof_present"])
        self.assertFalse(summary["would_persist"])

        args_plain = SimpleNamespace(**vars(args))
        args_plain.json = False
        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args_plain,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=(
                    [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                    [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                    [tca_row],
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_source_dsn",
                return_value=(
                    [],
                    {
                        "runtime_ledger_source_bucket_count": 0,
                        "runtime_ledger_source_bucket_run_ids": [],
                        "runtime_ledger_source_bucket_fill_count": 0,
                        "runtime_ledger_source_bucket_tca_row_count": 0,
                        "runtime_ledger_source_bucket_profit_proof_count": 0,
                    },
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                return_value=[
                    (
                        datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                        datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                        6,
                    )
                ],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[
                    SimpleNamespace(
                        payload_json={
                            "runtime_ledger_profit_proof_present": True,
                            "runtime_ledger_profit_proof_blockers": [],
                        }
                    )
                ],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-audit"},
            ) as plain_persist_windows,
            patch("builtins.print") as print_plain,
        ):
            plain_exit_code = main()
        self.assertEqual(plain_exit_code, 0)
        plain_persist_windows.assert_not_called()
        self.assertEqual(
            print_plain.call_args.args[0]["schema_version"],
            "torghut.runtime-window-import-source-audit.v1",
        )

    def test_main_attaches_target_metadata_to_runtime_payload(self) -> None:
        args = SimpleNamespace(
            run_id="run-probation",
            candidate_id="cand-paper-probation",
            hypothesis_id="H-MICRO-01",
            observed_stage="paper",
            strategy_family="microstructure_breakout",
            source_dsn="postgresql://example",
            source_dsn_env="DB_DSN",
            strategy_name="microbar-volume-continuation-long-top2-chip-v1",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="config/trading/hypotheses/h-micro-01.json",
            source_kind="paper_runtime_observed",
            artifact_ref=[],
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="runtime-probation-snapshot",
            target_metadata_json=json.dumps(
                {
                    "paper_probation_authorized": True,
                    "evidence_collection_stage": "paper",
                    "paper_route_probe_symbols": ["aapl", "AAPL"],
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                }
            ),
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        fake_session = _FakeSession()
        manifest = SimpleNamespace(
            strategy_family="microstructure_breakout",
            strategy_id="microbar_volume_continuation_long_top2_chip_v1@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-micro-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=(
                    [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                    [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                    [],
                ),
            ) as query_timestamps,
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                return_value=[],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-probation"},
            ) as persist_windows,
            patch(
                "scripts.import_hypothesis_runtime_windows.SessionLocal",
                return_value=fake_session,
            ),
            patch("builtins.print"),
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(
            runtime_payload["target_metadata"],
            {
                "paper_probation_authorized": True,
                "evidence_collection_stage": "paper",
                "paper_route_probe_symbols": ["aapl", "AAPL"],
                "promotion_allowed": False,
                "final_promotion_authorized": False,
            },
        )
        self.assertEqual(query_timestamps.call_args.kwargs["symbols"], ["AAPL"])
        self.assertEqual(runtime_payload["source_activity_symbol_filter"], ["AAPL"])

    def test_main_skips_persist_when_source_activity_is_empty(self) -> None:
        args = SimpleNamespace(
            run_id="run-empty",
            candidate_id="cand-empty",
            hypothesis_id="H-CONT-01",
            observed_stage="paper",
            strategy_family="",
            source_dsn="postgresql://example",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v2",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="",
            source_kind="simulation_paper_runtime",
            artifact_ref=[],
            dataset_snapshot_ref="runtime-empty-snapshot",
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            audit_only=True,
            json=False,
        )
        manifest = SimpleNamespace(
            strategy_family="intraday_continuation",
            strategy_id="intraday_tsmom_v1@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=([], [], []),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
            ) as build_buckets,
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
            ) as persist_windows,
            patch(
                "scripts.import_hypothesis_runtime_windows.SessionLocal",
            ) as session_local,
            patch("builtins.print") as print_mock,
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        build_buckets.assert_not_called()
        persist_windows.assert_not_called()
        session_local.assert_not_called()
        summary = print_mock.call_args.args[0]
        self.assertEqual(summary["status"], "skipped")
        self.assertEqual(summary["proof_status"], "blocked")
        self.assertEqual(summary["decision_count"], 0)
        self.assertTrue(summary["audit_only"])
        self.assertFalse(summary["would_persist"])
        self.assertEqual(
            summary["proof_blockers"][0]["blocker"],
            "runtime_window_source_activity_missing",
        )
        self.assertFalse(summary["runtime_observation"]["authoritative"])

    def test_main_imports_exact_runtime_ledger_artifact_without_db_activity(
        self,
    ) -> None:
        with TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "exact-ledger.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "candidate_id": "H-TSMOM-LIQ-01",
                        "account_label": "TORGHUT_SIM",
                        "strategy_id": "intraday-tsmom-profit-v3",
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                        "runtime_ledger_rows": [
                            {
                                "event_type": "decision",
                                "executed_at": "2026-03-06T14:35:00Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                            },
                            {
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-06T14:35:01Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                            },
                            {
                                "event_type": "fill",
                                "executed_at": "2026-03-06T14:35:02Z",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                                "symbol": "AAPL",
                                "side": "buy",
                                "filled_qty": "1",
                                "avg_fill_price": "100",
                                "cost_amount": "0.10",
                                "cost_basis": "broker_reported_commission_and_fees",
                            },
                            {
                                "event_type": "decision",
                                "executed_at": "2026-03-06T14:40:00Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                            },
                            {
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-06T14:40:01Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                            },
                            {
                                "event_type": "fill",
                                "executed_at": "2026-03-06T14:40:02Z",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                                "symbol": "AAPL",
                                "side": "sell",
                                "filled_qty": "1",
                                "avg_fill_price": "101",
                                "cost_amount": "0.10",
                                "cost_basis": "broker_reported_commission_and_fees",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            args = SimpleNamespace(
                run_id="run-ledger-artifact",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_family="intraday_tsmom_consistent",
                source_dsn="",
                source_dsn_env="DB_DSN",
                strategy_name="intraday-tsmom-profit-v3",
                account_label="TORGHUT_SIM",
                window_start="2026-03-06T14:30:00Z",
                window_end="2026-03-06T15:00:00Z",
                bucket_minutes=30,
                sample_minutes=5,
                source_manifest_ref="config/trading/hypotheses/h-tsmom-liq-01.json",
                source_kind="paper_runtime_observed",
                artifact_ref=[str(artifact_path)],
                delay_adjusted_depth_stress_report_ref="",
                dataset_snapshot_ref="runtime-ledger-artifact-snapshot",
                target_metadata_json=json.dumps(
                    {
                        "runtime_ledger_artifact_refs": [str(artifact_path)],
                        "candidate_id": "H-TSMOM-LIQ-01",
                        "runtime_ledger_artifact_row_count": 6,
                        "runtime_ledger_artifact_fill_count": 2,
                        "window_start": "2026-03-06T14:30:00+00:00",
                        "window_end": "2026-03-06T15:00:00+00:00",
                    }
                ),
                dependency_quorum_decision="allow",
                continuity_ok="true",
                drift_ok="true",
                json=False,
            )
            fake_session = _FakeSession()
            manifest = SimpleNamespace(
                strategy_family="intraday_tsmom_consistent",
                strategy_id="intraday_tsmom_v2@research",
                max_allowed_slippage_bps=Decimal("6"),
            )

            with (
                patch(
                    "scripts.import_hypothesis_runtime_windows._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                    return_value=(
                        SimpleNamespace(
                            path="config/trading/hypotheses/h-tsmom-liq-01.json"
                        ),
                        manifest,
                    ),
                ),
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "scripts.import_hypothesis_runtime_windows._query_timestamps",
                ) as query_timestamps,
                patch(
                    "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                    return_value=[],
                ) as build_buckets,
                patch(
                    "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                    return_value={"run_id": "run-ledger-artifact"},
                ) as persist_windows,
                patch(
                    "scripts.import_hypothesis_runtime_windows.SessionLocal",
                    return_value=fake_session,
                ),
                patch("builtins.print"),
            ):
                exit_code = main()

        self.assertEqual(exit_code, 0)
        query_timestamps.assert_not_called()
        self.assertEqual(len(build_buckets.call_args.kwargs["decision_times"]), 2)
        self.assertEqual(len(build_buckets.call_args.kwargs["execution_times"]), 2)
        tca_rows = build_buckets.call_args.kwargs["tca_rows"]
        self.assertEqual(len(tca_rows), 1)
        self.assertEqual(
            tca_rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_RUNTIME_LEDGER,
        )
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(
            tca_rows[0]["authority_reason"],
            "exact_replay_artifact_not_runtime_proof",
        )
        self.assertIn(
            "runtime_ledger_source_window_missing",
            tca_rows[0]["runtime_ledger_blockers"],
        )
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(
            runtime_payload["runtime_ledger_artifact_refs"], [str(artifact_path)]
        )
        self.assertEqual(runtime_payload["runtime_ledger_artifact_row_count"], 6)
        self.assertEqual(runtime_payload["runtime_ledger_artifact_fill_count"], 2)
        self.assertEqual(
            runtime_payload["runtime_ledger_artifact_candidate_id"],
            "H-TSMOM-LIQ-01",
        )
        self.assertEqual(runtime_payload["runtime_ledger_target_metadata_blockers"], [])
        self.assertEqual(
            runtime_payload["authority_reason"],
            "exact_replay_artifact_not_runtime_proof",
        )
        self.assertEqual(runtime_payload["promotion_authority"], "blocked")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], False)
        self.assertEqual(runtime_payload["authoritative"], False)
        self.assertEqual(
            runtime_payload["runtime_ledger_artifact_authority_class"],
            "exact_replay_artifact_only_not_live",
        )
        self.assertEqual(
            runtime_payload["runtime_ledger_artifact_authority_blockers"],
            [
                "exact_replay_artifact_not_runtime_proof",
                "runtime_ledger_source_window_missing",
                "runtime_ledger_source_refs_missing",
            ],
        )
        self.assertIn(
            "exact_replay_artifact_not_runtime_proof",
            runtime_payload["runtime_ledger_materialization_blockers"],
        )

    def test_main_imports_durable_runtime_ledger_bucket_without_source_dsn(
        self,
    ) -> None:
        args = SimpleNamespace(
            run_id="run-durable-ledger",
            candidate_id="H-TSMOM-LIQ-01",
            hypothesis_id="H-TSMOM-LIQ-01",
            observed_stage="paper",
            strategy_family="intraday_tsmom_consistent",
            source_dsn="",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v3",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="config/trading/hypotheses/h-tsmom-liq-01.json",
            source_kind="paper_runtime_observed",
            artifact_ref=[],
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="durable-runtime-ledger-snapshot",
            target_metadata_json="",
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        fake_session = _FakeSession()
        manifest = SimpleNamespace(
            strategy_family="intraday_tsmom_consistent",
            strategy_id="intraday_tsmom_v2@research",
            max_allowed_slippage_bps=Decimal("6"),
        )
        durable_tca_row = {
            "computed_at": datetime(2026, 3, 6, 14, 59, 59, tzinfo=timezone.utc),
            "abs_slippage_bps": Decimal("10"),
            "post_cost_expectancy_bps": Decimal("40"),
            "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
            "post_cost_promotion_eligible": True,
            "runtime_ledger_bucket": _complete_runtime_ledger_bucket(
                run_id="runtime-proof-1",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                account_label="TORGHUT_SIM",
                strategy_id="intraday-tsmom-profit-v3",
                bucket_started_at="2026-03-06T14:30:00+00:00",
                bucket_ended_at="2026-03-06T15:00:00+00:00",
            ),
        }

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(
                        path="config/trading/hypotheses/h-tsmom-liq-01.json"
                    ),
                    manifest,
                ),
            ),
            patch.dict("os.environ", {}, clear=True),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
            ) as query_timestamps,
            patch(
                "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_durable_buckets",
                return_value=(
                    [durable_tca_row],
                    {
                        "runtime_ledger_durable_bucket_count": 1,
                        "runtime_ledger_durable_bucket_run_ids": ["runtime-proof-1"],
                        "runtime_ledger_durable_bucket_fill_count": 2,
                        "runtime_ledger_durable_bucket_tca_row_count": 1,
                        "runtime_ledger_durable_bucket_profit_proof_count": 1,
                    },
                ),
            ) as durable_buckets,
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[],
            ) as build_buckets,
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-durable-ledger"},
            ) as persist_windows,
            patch(
                "scripts.import_hypothesis_runtime_windows.SessionLocal",
                return_value=fake_session,
            ),
            patch("builtins.print"),
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        query_timestamps.assert_not_called()
        durable_buckets.assert_called_once()
        tca_rows = build_buckets.call_args.kwargs["tca_rows"]
        self.assertEqual(tca_rows, [durable_tca_row])
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(runtime_payload["runtime_ledger_durable_bucket_count"], 1)
        self.assertEqual(
            runtime_payload["runtime_ledger_durable_bucket_run_ids"],
            ["runtime-proof-1"],
        )
        self.assertEqual(
            runtime_payload["runtime_ledger_durable_bucket_profit_proof_count"],
            1,
        )
        self.assertEqual(
            runtime_payload["authority_reason"], "runtime_ledger_profit_proof"
        )
        self.assertEqual(runtime_payload["promotion_authority"], "runtime_ledger")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], True)

    def test_main_imports_source_runtime_ledger_bucket_with_source_dsn(
        self,
    ) -> None:
        args = SimpleNamespace(
            run_id="run-source-ledger",
            candidate_id="H-TSMOM-LIQ-01",
            hypothesis_id="H-TSMOM-LIQ-01",
            observed_stage="paper",
            strategy_family="intraday_tsmom_consistent",
            source_dsn="postgresql://source",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v3",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="config/trading/hypotheses/h-tsmom-liq-01.json",
            source_kind="paper_route_probe_runtime_observed",
            artifact_ref=[],
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="source-runtime-ledger-snapshot",
            target_metadata_json=json.dumps(
                {
                    "paper_probation_authorized": True,
                    "paper_probation_authorization_scope": ("evidence_collection_only"),
                    "evidence_collection_stage": "paper",
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_promotion_allowed": False,
                    "runtime_ledger_target_metadata_blockers": [
                        "paper_route_runtime_ledger_import_pending"
                    ],
                }
            ),
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        fake_session = _FakeSession()
        manifest = SimpleNamespace(
            strategy_family="intraday_tsmom_consistent",
            strategy_id="intraday_tsmom_v2@research",
            max_allowed_slippage_bps=Decimal("6"),
        )
        source_tca_row = {
            "computed_at": datetime(2026, 3, 6, 14, 59, 59, tzinfo=timezone.utc),
            "abs_slippage_bps": Decimal("10"),
            "post_cost_expectancy_bps": Decimal("40"),
            "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
            "post_cost_promotion_eligible": True,
            "runtime_ledger_bucket": _complete_runtime_ledger_bucket(
                run_id="runtime-proof-source",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                account_label="TORGHUT_SIM",
                strategy_id="intraday-tsmom-profit-v3",
                bucket_started_at="2026-03-06T14:30:00+00:00",
                bucket_ended_at="2026-03-06T15:00:00+00:00",
            ),
        }

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(
                        path="config/trading/hypotheses/h-tsmom-liq-01.json"
                    ),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=([], [], []),
            ) as query_timestamps,
            patch(
                "scripts.import_hypothesis_runtime_windows._runtime_ledger_tca_rows_from_source_dsn",
                return_value=(
                    [source_tca_row],
                    {
                        "runtime_ledger_source_bucket_count": 1,
                        "runtime_ledger_source_bucket_run_ids": [
                            "runtime-proof-source"
                        ],
                        "runtime_ledger_source_bucket_fill_count": 2,
                        "runtime_ledger_source_bucket_tca_row_count": 1,
                        "runtime_ledger_source_bucket_profit_proof_count": 1,
                    },
                ),
            ) as source_buckets,
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[],
            ) as build_buckets,
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-source-ledger"},
            ) as persist_windows,
            patch(
                "scripts.import_hypothesis_runtime_windows.SessionLocal",
                return_value=fake_session,
            ),
            patch("builtins.print"),
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        query_timestamps.assert_called_once()
        self.assertEqual(
            query_timestamps.call_args.kwargs[
                "allow_authoritative_runtime_ledger_materialization"
            ],
            True,
        )
        source_buckets.assert_called_once()
        tca_rows = build_buckets.call_args.kwargs["tca_rows"]
        self.assertEqual(tca_rows, [source_tca_row])
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(runtime_payload["runtime_ledger_source_bucket_count"], 1)
        self.assertEqual(
            runtime_payload["runtime_ledger_source_bucket_run_ids"],
            ["runtime-proof-source"],
        )
        self.assertEqual(
            runtime_payload["runtime_ledger_source_bucket_profit_proof_count"],
            1,
        )
        self.assertEqual(
            runtime_payload["authority_reason"], "runtime_ledger_profit_proof"
        )
        self.assertEqual(runtime_payload["promotion_authority"], "runtime_ledger")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], True)

    def test_main_attaches_delay_adjusted_depth_report_to_runtime_payload(
        self,
    ) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "delay-depth.json"
            report_path.write_text(
                '{"passed": true, "case_count": 2, "checked_at": "2026-03-06T15:20:00Z"}',
                encoding="utf-8",
            )
            args = SimpleNamespace(
                run_id="run-depth",
                candidate_id="chip-paper-microbar-composite@execution-proof",
                hypothesis_id="H-MICRO-01",
                observed_stage="paper",
                strategy_family="microstructure_breakout",
                source_dsn="postgresql://example",
                source_dsn_env="DB_DSN",
                strategy_name="microbar_volume_continuation_long_top2_chip_v1@paper",
                account_label="TORGHUT_SIM",
                window_start="2026-03-06T14:30:00Z",
                window_end="2026-03-06T15:00:00Z",
                bucket_minutes=30,
                sample_minutes=5,
                source_manifest_ref="config/trading/hypotheses/h-micro-01.json",
                source_kind="simulation_paper_runtime",
                dataset_snapshot_ref="runtime-depth-snapshot",
                artifact_ref=[],
                delay_adjusted_depth_stress_report_ref=str(report_path),
                dependency_quorum_decision="allow",
                continuity_ok="true",
                drift_ok="true",
                json=False,
            )
            fake_session = _FakeSession()
            manifest = SimpleNamespace(
                strategy_family="microstructure_breakout",
                strategy_id="microbar_volume_continuation_long_top2_chip_v1@paper",
                max_allowed_slippage_bps=Decimal("12"),
            )

            with (
                patch(
                    "scripts.import_hypothesis_runtime_windows._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                    return_value=(
                        SimpleNamespace(
                            path="config/trading/hypotheses/h-micro-01.json"
                        ),
                        manifest,
                    ),
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows._query_timestamps",
                    return_value=(
                        [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                        [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                        [],
                    ),
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                    return_value=[],
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                    return_value=[],
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                    return_value={"run_id": "run-depth"},
                ) as persist_windows,
                patch(
                    "scripts.import_hypothesis_runtime_windows.SessionLocal",
                    return_value=fake_session,
                ),
                patch("builtins.print"),
            ):
                exit_code = main()

        self.assertEqual(exit_code, 0)
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(
            runtime_payload["delay_adjusted_depth_stress_artifact_ref"],
            str(report_path),
        )
        self.assertEqual(runtime_payload["delay_adjusted_depth_stress_checks_total"], 2)
        self.assertEqual(runtime_payload["delay_adjusted_depth_stress_passed"], True)
        self.assertEqual(
            runtime_payload["delay_adjusted_depth_stress_checked_at"],
            "2026-03-06T15:20:00Z",
        )
        self.assertIn(str(report_path), runtime_payload["artifact_refs"])
        self.assertEqual(runtime_payload["authoritative"], False)
        self.assertEqual(
            runtime_payload["authority_reason"],
            "simulation_source_replay_only",
        )
        self.assertEqual(runtime_payload["promotion_authority"], "blocked")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], False)

    def test_main_quarantines_report_runtime_pnl_when_tca_rows_are_empty(self) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "simulation-report.json"
            report_path.write_text(
                '{"pnl":{"net_pnl_estimated":"50","execution_notional_total":"10000"}}',
                encoding="utf-8",
            )
            args = SimpleNamespace(
                run_id="run-report-pnl",
                candidate_id="cand-report-pnl",
                hypothesis_id="H-CONT-01",
                observed_stage="paper",
                strategy_family="",
                source_dsn="postgresql://example",
                source_dsn_env="DB_DSN",
                strategy_name="intraday-tsmom-profit-v2",
                account_label="TORGHUT_SIM",
                window_start="2026-03-06T14:30:00Z",
                window_end="2026-03-06T15:00:00Z",
                bucket_minutes=30,
                sample_minutes=5,
                source_manifest_ref="",
                source_kind="simulation_paper_runtime",
                artifact_ref=[str(report_path)],
                delay_adjusted_depth_stress_report_ref="",
                dataset_snapshot_ref="runtime-report-snapshot",
                dependency_quorum_decision="allow",
                continuity_ok="true",
                drift_ok="true",
                json=False,
            )
            fake_session = _FakeSession()
            manifest = SimpleNamespace(
                strategy_family="intraday_continuation",
                strategy_id="intraday_tsmom_v1@paper",
                max_allowed_slippage_bps=Decimal("12"),
            )

            with (
                patch(
                    "scripts.import_hypothesis_runtime_windows._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                    return_value=(
                        SimpleNamespace(
                            path="config/trading/hypotheses/h-cont-01.json"
                        ),
                        manifest,
                    ),
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows._query_timestamps",
                    return_value=(
                        [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
                        [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
                        [],
                    ),
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                    return_value=[],
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                    return_value=[],
                ) as build_buckets,
                patch(
                    "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                    return_value={"run_id": "run-report-pnl"},
                ) as persist_windows,
                patch(
                    "scripts.import_hypothesis_runtime_windows.SessionLocal",
                    return_value=fake_session,
                ),
                patch("builtins.print"),
            ):
                exit_code = main()

        self.assertEqual(exit_code, 0)
        tca_rows = build_buckets.call_args.kwargs["tca_rows"]
        self.assertEqual(
            tca_rows,
            [
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "post_cost_expectancy_bps": Decimal("50.000"),
                    "post_cost_expectancy_basis": POST_COST_BASIS_SIMULATION_REPORT,
                    "post_cost_promotion_eligible": False,
                    "promotion_blocker": "simulation_report_not_runtime_ledger_proof",
                }
            ],
        )
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(
            runtime_payload["report_post_cost_expectancy_basis"],
            POST_COST_BASIS_SIMULATION_REPORT,
        )
        self.assertEqual(runtime_payload["authoritative"], False)
        self.assertEqual(
            runtime_payload["authority_reason"],
            "simulation_source_replay_only",
        )
        self.assertEqual(runtime_payload["promotion_authority"], "blocked")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], False)
