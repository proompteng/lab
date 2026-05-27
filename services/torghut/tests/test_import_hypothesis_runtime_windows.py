from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import json
from types import SimpleNamespace
from pathlib import Path
from tempfile import TemporaryDirectory
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
    _build_realized_strategy_pnl_rows,
    _first_lineage_digest,
    _load_json_artifact,
    _load_report_post_cost_expectancy_bps,
    _nonnegative_int,
    _parse_args,
    _parse_dt_or_none,
    _parse_target_metadata,
    _query_timestamps,
    _row_payloads,
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_event_type,
    _runtime_ledger_profit_proof_present,
    _runtime_observation_authority_payload,
    _runtime_ledger_target_metadata_blockers,
    _runtime_ledger_tca_row_from_bucket,
    _runtime_ledger_tca_materialization_metadata,
    _runtime_ledger_tca_rows_from_durable_buckets,
    _runtime_ledger_tca_rows_from_source_dsn,
    _runtime_ledger_tca_rows_from_artifacts,
    _runtime_window_import_proof_hygiene_blockers,
    _runtime_window_source_kind_is_informational,
    _source_kind_allows_runtime_ledger_materialization,
    _source_activity_missing_summary,
    _stable_payload_digest,
    _strategy_name_candidates,
    main,
)


class _FakeCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self._results = [
            [
                (
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
                )
            ],
            [
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    Decimal("1.25"),
                    Decimal("0.50"),
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
        "blockers": [],
    }
    payload.update(overrides)
    return payload


class TestImportHypothesisRuntimeWindows(TestCase):
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
                    payload_json={},
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
        self.assertFalse(
            _runtime_window_source_kind_is_informational(
                source_kind="paper_route_probe_runtime_observed",
                target_metadata={
                    "paper_probation_authorization_scope": "evidence_collection_only"
                },
            )
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
        )

        self.assertEqual(summary["proof_status"], "blocked")
        self.assertEqual(
            [item["blocker"] for item in summary["proof_blockers"]],
            [
                "runtime_window_source_activity_missing",
                "runtime_window_target_metadata_missing",
            ],
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

    def test_build_realized_strategy_pnl_rows_requires_costed_round_trip(
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
                    "shortfall_notional": Decimal("99"),
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
                    "shortfall_notional": Decimal("99"),
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
                    "execution_policy_hash": "policy-sha",
                    "cost_model_hash": "cost-sha",
                    "lineage_hash": "lineage-sha",
                },
            ],
            order_lifecycle_rows=[
                {
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
                },
                {
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
        self.assertEqual(bucket["source_materialization"], "execution_order_events")
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(bucket))

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
            ["execution_reconstruction_not_runtime_ledger_proof"],
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
        self.assertIn("runtime_decision_lifecycle_missing", bucket["blockers"])
        self.assertIn("submitted_order_lifecycle_missing", bucket["blockers"])
        self.assertIn("fill_order_submission_missing", bucket["blockers"])
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            bucket["blockers"],
        )
        self.assertEqual(
            bucket["cost_basis_counts"],
            {"decision_impact_assumptions_total_cost_bps": 2},
        )
        self.assertEqual(bucket["cost_amount"], "0.201")
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.799"))
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
        self.assertEqual(row["post_cost_promotion_eligible"], True)

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
            )

        self.assertEqual(decisions, [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)])
        self.assertEqual(
            executions, [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)]
        )
        self.assertEqual(len(tca_rows), 2)
        self.assertEqual(tca_rows[0]["abs_slippage_bps"], Decimal("1.25"))
        self.assertEqual(tca_rows[0]["post_cost_expectancy_bps"], Decimal("0.50"))
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
        self.assertIn("d.created_at >= %s", execution_query)
        self.assertIn("d.created_at < %s", execution_query)
        self.assertNotIn("e.created_at >= %s", execution_query)
        self.assertIn("from execution_order_events oe", order_event_query)
        self.assertIn("d.created_at >= %s", order_event_query)
        self.assertIn("d.created_at < %s", order_event_query)
        self.assertIn("select\n                    d.created_at", tca_query)
        self.assertIn("d.created_at >= %s", tca_query)
        self.assertIn("d.created_at < %s", tca_query)
        self.assertNotIn("e.created_at >= %s", tca_query)
        self.assertNotIn("t.computed_at >= %s", tca_query)

    def test_query_timestamps_filters_to_target_symbols_when_configured(
        self,
    ) -> None:
        cursor = _FakeCursor()
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

        self.assertEqual(len(cursor.executed), 4)
        decision_query, decision_params = cursor.executed[0]
        execution_query, execution_params = cursor.executed[1]
        order_event_query, order_event_params = cursor.executed[2]
        tca_query, tca_params = cursor.executed[3]
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
        self.assertIn("upper(d.symbol) = any(%s)", tca_query)
        self.assertIn("upper(e.symbol) = any(%s)", tca_query)
        self.assertEqual(tca_params[-2:], (["AAPL"], ["AAPL"]))

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

    def test_runtime_ledger_artifacts_build_promotion_grade_tca_rows(self) -> None:
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
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], True)
        ledger_bucket = tca_rows[0]["runtime_ledger_bucket"]
        assert isinstance(ledger_bucket, dict)
        self.assertEqual(
            ledger_bucket["ledger_schema_version"], "torghut.exact_replay_ledger.v1"
        )
        self.assertEqual(ledger_bucket["pnl_basis"], POST_COST_BASIS_RUNTIME_LEDGER)
        self.assertEqual(ledger_bucket["decision_count"], 2)
        self.assertEqual(ledger_bucket["submitted_order_count"], 2)
        self.assertEqual(ledger_bucket["closed_trade_count"], 1)
        self.assertEqual(ledger_bucket["blockers"], [])
        self.assertEqual(metadata["runtime_ledger_artifact_row_count"], 6)
        self.assertEqual(metadata["runtime_ledger_artifact_tca_row_count"], 1)
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
        self.assertEqual(tca_rows[0]["post_cost_promotion_eligible"], True)
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
            runtime_payload["authority_reason"], "runtime_ledger_profit_proof"
        )
        self.assertEqual(runtime_payload["promotion_authority"], "runtime_ledger")
        self.assertEqual(runtime_payload["runtime_ledger_profit_proof_present"], True)
        self.assertEqual(runtime_payload["authoritative"], True)

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
