from __future__ import annotations

import io
import json
import sys
from argparse import Namespace
from contextlib import redirect_stdout
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from app.trading.discovery.replay_tape import (
    REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
    ReplayTapeCoverageError,
    ReplayTapeManifest,
    build_replay_tape_cache_key,
    build_source_query_digest,
    default_manifest_path,
    load_replay_tape,
    materialize_signal_tape,
    signal_from_tape_payload,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)
from app.trading.models import SignalEnvelope
from scripts import materialize_replay_tape as materialize_cli
from scripts.local_intraday_tsmom_replay import (
    ReplayConfig,
    _iter_signal_rows,
    _iter_signal_rows_from_replay_tape,
)


class TestReplayTape(TestCase):
    def test_materialize_cli_default_strategy_configmap_is_repo_rooted(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with patch.object(
                sys,
                "argv",
                [
                    "materialize_replay_tape.py",
                    "--start-date",
                    "2026-05-13",
                    "--end-date",
                    "2026-05-13",
                    "--dataset-snapshot-ref",
                    "snapshot-a",
                    "--output",
                    str(Path(tmpdir) / "tape.jsonl"),
                ],
            ):
                args = materialize_cli._parse_args()

        expected = (
            Path(__file__).resolve().parents[3]
            / "argocd/applications/torghut/strategy-configmap.yaml"
        )
        self.assertEqual(args.strategy_configmap, expected)
        self.assertTrue(args.strategy_configmap.exists())

    def _signal(
        self,
        *,
        day: int,
        seq: int,
        symbol: str = "META",
        price: str = "100.25",
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 3, day, 17, 30, seq, tzinfo=timezone.utc),
            symbol=symbol,
            timeframe="1Sec",
            seq=seq,
            source="ta",
            payload={
                "price": Decimal(price),
                "spread": Decimal("0.02"),
                "nested": {"bid_px": Decimal("100.24"), "label": "keep-string"},
                "levels": [Decimal("100.24"), Decimal("100.26")],
                "computed_at": datetime(2026, 3, day, 17, 30, tzinfo=timezone.utc),
                "window_size": "PT1S",
            },
            ingest_ts=datetime(2026, 3, day, 17, 31, tzinfo=timezone.utc),
        )

    def test_materialize_load_and_slice_preserves_order_and_decimal_payloads(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            tape_path = Path(tmpdir) / "tape.jsonl"
            materialize_signal_tape(
                rows=[
                    self._signal(day=27, seq=2, symbol="AAPL", price="190.10"),
                    self._signal(day=26, seq=1, symbol="META", price="100.25"),
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-a",
                symbols=("META", "AAPL"),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )

            tape = load_replay_tape(tape_path)

        self.assertEqual(tape.manifest.row_count, 2)
        self.assertEqual(
            tape.manifest.requested_trading_days,
            (date(2026, 3, 26), date(2026, 3, 27)),
        )
        self.assertEqual(
            tape.manifest.observed_trading_days,
            (date(2026, 3, 26), date(2026, 3, 27)),
        )
        self.assertEqual(tape.manifest.missing_trading_days, ())
        self.assertEqual(
            tape.manifest.row_count_by_trading_day,
            {"2026-03-26": 1, "2026-03-27": 1},
        )
        self.assertEqual(
            tape.manifest.missing_symbol_trading_days,
            ("AAPL:2026-03-26", "META:2026-03-27"),
        )
        self.assertEqual(
            tape.manifest.row_count_by_symbol_trading_day,
            {
                "AAPL": {"2026-03-27": 1},
                "META": {"2026-03-26": 1},
            },
        )
        self.assertEqual([row.symbol for row in tape.rows], ["META", "AAPL"])
        self.assertEqual(tape.rows[0].payload["price"], Decimal("100.25"))
        self.assertEqual(tape.rows[0].payload["nested"]["label"], "keep-string")
        self.assertEqual(
            tape.rows[0].payload["computed_at"],
            datetime(2026, 3, 26, 17, 30, tzinfo=timezone.utc),
        )
        self.assertEqual(tape.rows[0].payload["levels"][0], Decimal("100.24"))
        self.assertEqual(
            [row.symbol for row in slice_tape_by_symbols(tape.rows, symbols=())],
            ["META", "AAPL"],
        )
        self.assertEqual(
            [row.symbol for row in slice_tape_by_symbols(tape.rows, symbols=("AAPL",))],
            ["AAPL"],
        )
        self.assertEqual(
            [
                row.seq
                for row in slice_tape_by_window(
                    tape.rows, start_date=date(2026, 3, 27), end_date=date(2026, 3, 27)
                )
            ],
            [2],
        )

    def test_manifest_digest_changes_when_source_rows_change(self) -> None:
        with TemporaryDirectory() as tmpdir:
            first = Path(tmpdir) / "first.jsonl"
            second = Path(tmpdir) / "second.jsonl"
            first_manifest = materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, price="100.25")],
                tape_path=first,
                dataset_snapshot_ref="snapshot-a",
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )
            second_manifest = materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, price="100.30")],
                tape_path=second,
                dataset_snapshot_ref="snapshot-a",
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )

        self.assertNotEqual(
            first_manifest.content_sha256, second_manifest.content_sha256
        )

    def test_replay_tape_cache_key_is_stable_for_same_query_inputs(self) -> None:
        first_digest = build_source_query_digest({"window": "a", "symbols": ["NVDA"]})
        first_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-a",
            symbols=("NVDA", "AAPL"),
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            source_query_digest=first_digest,
            source_table_versions={"signals": "v1"},
        )
        reordered_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-a",
            symbols=("aapl", "nvda"),
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            source_query_digest=first_digest,
            source_table_versions={"signals": "v1"},
        )
        changed_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-a",
            symbols=("AAPL", "NVDA"),
            start_date=date(2026, 3, 28),
            end_date=date(2026, 3, 28),
            source_query_digest=first_digest,
            source_table_versions={"signals": "v1"},
        )
        changed_dataset_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-b",
            symbols=("AAPL", "NVDA"),
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            source_query_digest=first_digest,
            source_table_versions={"signals": "v1"},
        )
        changed_feature_schema_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-a",
            symbols=("AAPL", "NVDA"),
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            source_query_digest=first_digest,
            feature_schema_hash="feature-schema-v2",
            source_table_versions={"signals": "v1"},
        )
        changed_cost_model_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-a",
            symbols=("AAPL", "NVDA"),
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            source_query_digest=first_digest,
            cost_model_hash="cost-model-v2",
            source_table_versions={"signals": "v1"},
        )
        changed_family_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-a",
            symbols=("AAPL", "NVDA"),
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            source_query_digest=first_digest,
            strategy_family="hpairs-v2",
            source_table_versions={"signals": "v1"},
        )

        self.assertEqual(first_key, reordered_key)
        self.assertNotEqual(first_key, changed_key)
        self.assertNotEqual(first_key, changed_dataset_key)
        self.assertNotEqual(first_key, changed_feature_schema_key)
        self.assertNotEqual(first_key, changed_cost_model_key)
        self.assertNotEqual(first_key, changed_family_key)

        with TemporaryDirectory() as tmpdir:
            manifest = materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, symbol="NVDA")],
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-a",
                symbols=("NVDA", "AAPL"),
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=first_digest,
                feature_schema_hash="feature-schema-v1",
                cost_model_hash="cost-model-v1",
                strategy_family="hpairs-v1",
                source_table_versions={"signals": "v1"},
            )

        expected_materialized_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-a",
            symbols=("NVDA", "AAPL"),
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            source_query_digest=first_digest,
            feature_schema_hash="feature-schema-v1",
            cost_model_hash="cost-model-v1",
            strategy_family="hpairs-v1",
            source_table_versions={"signals": "v1"},
        )
        self.assertEqual(manifest.replay_cache_key, expected_materialized_key)
        self.assertEqual(
            manifest.to_payload()["replay_cache_key"], expected_materialized_key
        )
        self.assertEqual(
            manifest.to_payload()["feature_schema_hash"], "feature-schema-v1"
        )
        self.assertEqual(manifest.to_payload()["cost_model_hash"], "cost-model-v1")
        self.assertEqual(manifest.to_payload()["strategy_family"], "hpairs-v1")

    def test_materialize_manifest_session_window_follows_new_york_dst(self) -> None:
        with TemporaryDirectory() as tmpdir:
            winter_manifest = materialize_signal_tape(
                rows=[],
                tape_path=Path(tmpdir) / "winter.jsonl",
                dataset_snapshot_ref="snapshot-a",
                start_date=date(2026, 1, 5),
                end_date=date(2026, 1, 5),
                source_query_digest=build_source_query_digest({"window": "winter"}),
            )
            summer_manifest = materialize_signal_tape(
                rows=[],
                tape_path=Path(tmpdir) / "summer.jsonl",
                dataset_snapshot_ref="snapshot-a",
                start_date=date(2026, 5, 29),
                end_date=date(2026, 5, 29),
                source_query_digest=build_source_query_digest({"window": "summer"}),
            )

        self.assertEqual(
            winter_manifest.start_ts,
            datetime(2026, 1, 5, 14, 30, tzinfo=timezone.utc),
        )
        self.assertEqual(
            winter_manifest.end_ts,
            datetime(2026, 1, 5, 21, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(
            summer_manifest.start_ts,
            datetime(2026, 5, 29, 13, 30, tzinfo=timezone.utc),
        )
        self.assertEqual(
            summer_manifest.end_ts,
            datetime(2026, 5, 29, 20, 0, tzinfo=timezone.utc),
        )

    def test_manifest_payload_rejects_wrong_schema_and_coerces_loose_metadata(
        self,
    ) -> None:
        with self.assertRaisesRegex(ValueError, "replay_tape_manifest_schema_invalid"):
            ReplayTapeManifest.from_payload({"schema_version": "old"})

        manifest = ReplayTapeManifest.from_payload(
            {
                "schema_version": REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
                "dataset_snapshot_ref": "snapshot-a",
                "symbols": "META",
                "row_symbols": b"META",
                "start_date": "2026-03-27",
                "end_date": "2026-03-27",
                "start_ts": "2026-03-27T13:30:00",
                "end_ts": "2026-03-27T20:00:00Z",
                "min_event_ts": None,
                "max_event_ts": None,
                "trading_day_count": 0,
                "row_count": 0,
                "source_query_digest": "digest",
                "content_sha256": "sha",
                "artifact_refs": [],
                "source_table_versions": [],
                "created_at": "2026-03-27T21:00:00Z",
            }
        )

        self.assertEqual(manifest.symbols, ())
        self.assertEqual(manifest.row_symbols, ())
        self.assertEqual(manifest.artifact_refs, {})
        self.assertEqual(manifest.source_table_versions, {})
        self.assertEqual(manifest.start_ts.tzinfo, timezone.utc)
        self.assertEqual(manifest.missing_symbol_trading_days, ())
        self.assertEqual(manifest.row_count_by_symbol_trading_day, {})

    def test_load_replay_tape_rejects_digest_and_row_count_mismatches(self) -> None:
        with TemporaryDirectory() as tmpdir:
            tape_path = Path(tmpdir) / "tape.jsonl"
            manifest = materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, price="100.25")],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-a",
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )
            manifest_path = default_manifest_path(tape_path)
            tape_path.write_text(
                tape_path.read_text(encoding="utf-8").replace("100.25", "100.26"),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "replay_tape_digest_mismatch"):
                load_replay_tape(tape_path, manifest_path=manifest_path)

            materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, price="100.25")],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-a",
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )
            payload = manifest.to_payload()
            payload["row_count"] = 2
            manifest_path.write_text(
                json.dumps(payload, sort_keys=True), encoding="utf-8"
            )

            with self.assertRaisesRegex(ValueError, "replay_tape_row_count_mismatch"):
                load_replay_tape(tape_path, manifest_path=manifest_path)

    def test_gzip_tape_round_trips_and_row_schema_fails_closed(self) -> None:
        with TemporaryDirectory() as tmpdir:
            tape_path = Path(tmpdir) / "tape.jsonl.gz"
            materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, price="100.25")],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-a",
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )

            tape = load_replay_tape(tape_path)

        self.assertEqual(tape.manifest.row_count, 1)
        self.assertEqual(tape.rows[0].symbol, "META")
        with self.assertRaisesRegex(ValueError, "replay_tape_row_schema_invalid"):
            signal_from_tape_payload({"schema_version": "old"})

    def test_stale_tape_fails_closed_unless_explicitly_allowed(self) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest = materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, symbol="META")],
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-a",
                symbols=("META",),
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )

        with self.assertRaisesRegex(ValueError, "replay_tape_stale"):
            validate_tape_freshness(
                manifest,
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                symbols=("META",),
            )

        receipt = validate_tape_freshness(
            manifest,
            start_date=date(2026, 3, 26),
            end_date=date(2026, 3, 27),
            symbols=("META",),
            allow_stale_tape=True,
        )
        self.assertEqual(receipt["status"], "stale_override")
        self.assertTrue(receipt["stale_override_used"])

        with self.assertRaisesRegex(ValueError, "symbols_not_covered:AAPL"):
            validate_tape_freshness(
                manifest,
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                symbols=("AAPL",),
            )

    def test_manifest_records_and_validates_missing_trading_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest = materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, symbol="META")],
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-a",
                symbols=("META",),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )

        self.assertEqual(
            manifest.requested_trading_days,
            (date(2026, 3, 26), date(2026, 3, 27)),
        )
        self.assertEqual(manifest.observed_trading_days, (date(2026, 3, 27),))
        self.assertEqual(manifest.missing_trading_days, (date(2026, 3, 26),))
        self.assertEqual(manifest.to_payload()["coverage_status"], "missing_days")

        with self.assertRaisesRegex(ValueError, "trading_days_missing:2026-03-26"):
            validate_tape_freshness(
                manifest,
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                symbols=("META",),
            )

        receipt = validate_tape_freshness(
            manifest,
            start_date=date(2026, 3, 26),
            end_date=date(2026, 3, 27),
            symbols=("META",),
            allow_stale_tape=True,
        )
        self.assertEqual(receipt["status"], "stale_override")
        self.assertEqual(receipt["missing_trading_days"], ["2026-03-26"])

    def test_manifest_records_and_validates_missing_symbol_trading_days(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest = materialize_signal_tape(
                rows=[
                    self._signal(day=26, seq=1, symbol="META"),
                    self._signal(day=27, seq=2, symbol="META"),
                    self._signal(day=26, seq=3, symbol="AAPL"),
                ],
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-a",
                symbols=("META", "AAPL"),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )

        self.assertEqual(manifest.missing_trading_days, ())
        self.assertEqual(
            manifest.missing_symbol_trading_days,
            ("AAPL:2026-03-27",),
        )
        self.assertEqual(
            manifest.to_payload()["coverage_status"], "missing_symbol_days"
        )

        with self.assertRaisesRegex(
            ValueError,
            "symbol_trading_days_missing:AAPL:2026-03-27",
        ):
            validate_tape_freshness(
                manifest,
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                symbols=("META", "AAPL"),
            )

        receipt = validate_tape_freshness(
            manifest,
            start_date=date(2026, 3, 26),
            end_date=date(2026, 3, 27),
            symbols=("AAPL",),
            allow_stale_tape=True,
        )
        self.assertEqual(receipt["status"], "stale_override")
        self.assertEqual(receipt["coverage_status"], "missing_symbol_days")
        self.assertEqual(
            receipt["missing_symbol_trading_days"],
            ["AAPL:2026-03-27"],
        )

    def test_validate_tape_freshness_rejects_requested_symbol_absent_from_unscoped_manifest(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest = materialize_signal_tape(
                rows=[
                    self._signal(day=26, seq=1, symbol="META"),
                    self._signal(day=27, seq=2, symbol="META"),
                ],
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-a",
                symbols=(),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )

        with self.assertRaisesRegex(ValueError, "symbols_not_covered:AAPL"):
            validate_tape_freshness(
                manifest,
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                symbols=("AAPL",),
            )

        receipt = validate_tape_freshness(
            manifest,
            start_date=date(2026, 3, 26),
            end_date=date(2026, 3, 27),
            symbols=("AAPL",),
            allow_stale_tape=True,
        )
        self.assertEqual(receipt["status"], "stale_override")
        self.assertEqual(receipt["requested_symbols"], ["AAPL"])
        self.assertIn("symbols_not_covered:AAPL", receipt["reasons"])
        self.assertEqual(
            receipt["missing_symbol_trading_days"],
            ["AAPL:2026-03-26", "AAPL:2026-03-27"],
        )

    def test_materialize_tape_requires_symbol_day_coverage_when_strict(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            with self.assertRaises(ReplayTapeCoverageError) as raised:
                materialize_signal_tape(
                    rows=[
                        self._signal(day=26, seq=1, symbol="META"),
                        self._signal(day=27, seq=2, symbol="META"),
                        self._signal(day=26, seq=3, symbol="AAPL"),
                    ],
                    tape_path=Path(tmpdir) / "tape.jsonl",
                    dataset_snapshot_ref="snapshot-a",
                    symbols=("META", "AAPL"),
                    start_date=date(2026, 3, 26),
                    end_date=date(2026, 3, 27),
                    source_query_digest=build_source_query_digest({"window": "a"}),
                    require_complete_coverage=True,
                )

            self.assertRegex(
                str(raised.exception),
                "replay_tape_incomplete_coverage:missing_symbol_days=AAPL:2026-03-27",
            )
            self.assertEqual(
                raised.exception.diagnostics[
                    "materialized_executable_rows_by_trading_day"
                ],
                {"2026-03-26": 2, "2026-03-27": 1},
            )
            self.assertEqual(
                raised.exception.diagnostics["missing_symbol_trading_days"],
                ["AAPL:2026-03-27"],
            )
            self.assertFalse((Path(tmpdir) / "tape.jsonl").exists())

    def test_source_query_digest_normalizes_dates_decimals_and_lists(self) -> None:
        digest = build_source_query_digest(
            {
                "day": date(2026, 3, 27),
                "threshold": Decimal("1.25"),
                "items": [date(2026, 3, 26), Decimal("2.50")],
            }
        )

        self.assertEqual(len(digest), 64)

    def test_local_replay_tape_iterator_is_empty_without_tape_path(self) -> None:
        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategy.yaml"),
            clickhouse_http_url="http://clickhouse.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=date(2026, 3, 26),
            end_date=date(2026, 3, 27),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
        )

        self.assertEqual(list(_iter_signal_rows_from_replay_tape(config)), [])

    def test_local_replay_iter_signal_rows_reads_tape_without_clickhouse(self) -> None:
        with TemporaryDirectory() as tmpdir:
            tape_path = Path(tmpdir) / "tape.jsonl"
            materialize_signal_tape(
                rows=[
                    self._signal(day=26, seq=1, symbol="META"),
                    self._signal(day=26, seq=2, symbol="AAPL"),
                    self._signal(day=27, seq=3, symbol="AAPL"),
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-a",
                symbols=("META", "AAPL"),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "a"}),
            )
            config = ReplayConfig(
                strategy_configmap_path=Path("/tmp/strategy.yaml"),
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username=None,
                clickhouse_password=None,
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                chunk_minutes=10,
                flatten_eod=True,
                start_equity=Decimal("10000"),
                symbols=("AAPL",),
                replay_tape_path=tape_path,
            )

            with patch(
                "scripts.local_intraday_tsmom_replay._fetch_chunk",
                side_effect=AssertionError("clickhouse should not be queried"),
            ):
                rows = list(_iter_signal_rows(config))

        self.assertEqual([row.symbol for row in rows], ["AAPL", "AAPL"])
        self.assertEqual(rows[0].payload["price"], Decimal("100.25"))


class TestMaterializeReplayTapeCli(TestCase):
    def _coverage_row(
        self,
        *,
        raw: int,
        executable: int,
        microbar: int,
        symbols: int = 1,
        quote_valid_ratio: str = "1",
        max_gap_seconds: int = 1,
    ) -> dict[str, object]:
        return {
            "raw_signal_rows": raw,
            "executable_signal_rows": executable,
            "quote_sane_signal_rows": executable,
            "spread_sane_signal_rows": executable,
            "microbar_rows": microbar,
            "raw_signal_symbol_count": symbols,
            "executable_signal_symbol_count": symbols if executable > 0 else 0,
            "microbar_symbol_count": symbols,
            "min_executable_rows_per_symbol_day": executable,
            "min_spread_sane_rows_per_symbol_day": executable,
            "quote_valid_ratio": quote_valid_ratio,
            "min_quote_valid_ratio_by_symbol_day": quote_valid_ratio,
            "max_executable_gap_seconds": max_gap_seconds,
        }

    def _signal(self, *, day: int, seq: int) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 3, day, 17, 30, seq, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=seq,
            source="ta",
            payload={
                "price": Decimal("100.25"),
                "spread": Decimal("0.02"),
                "window_size": "PT1S",
            },
            ingest_ts=datetime(2026, 3, day, 17, 31, tzinfo=timezone.utc),
        )

    def test_parse_args_and_helpers_normalize_cli_inputs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "tape.jsonl"
            with patch.object(
                sys,
                "argv",
                [
                    "prog",
                    "--start-date",
                    "2026-03-26",
                    "--end-date",
                    "2026-03-27",
                    "--dataset-snapshot-ref",
                    "snapshot-cli",
                    "--output",
                    str(output),
                    "--symbols",
                    " nvda, META ",
                    "--coverage-diagnostic-output",
                    str(output.with_suffix(".coverage.json")),
                    "--latest-complete-window-min-days",
                    "2",
                    "--latest-complete-window-receipt-output",
                    str(output.with_suffix(".window.json")),
                    "--source-table-version",
                    "ta_signals=v1",
                    "--clickhouse-query-timeout-seconds",
                    "9",
                ],
            ):
                args = materialize_cli._parse_args()

        symbols = materialize_cli._parse_symbols(str(args.symbols))
        self.assertEqual(symbols, ("NVDA", "META"))
        self.assertEqual(args.clickhouse_query_timeout_seconds, 9)
        self.assertEqual(args.min_executable_rows_per_symbol_day, 18000)
        self.assertEqual(args.min_quote_valid_ratio, "0.90")
        self.assertEqual(args.max_coverage_spread_bps, "50")
        self.assertEqual(args.max_executable_gap_seconds, 120)
        self.assertEqual(
            args.coverage_diagnostic_output,
            output.with_suffix(".coverage.json"),
        )
        self.assertEqual(args.latest_complete_window_min_days, 2)
        self.assertEqual(
            args.latest_complete_window_receipt_output,
            output.with_suffix(".window.json"),
        )
        self.assertFalse(args.allow_incomplete_coverage)
        self.assertEqual(
            materialize_cli._parse_source_table_versions(args.source_table_version),
            {"ta_signals": "v1"},
        )
        self.assertEqual(
            materialize_cli._source_query_payload(args=args, symbols=symbols)[
                "symbols"
            ],
            ["NVDA", "META"],
        )
        with patch.object(
            sys,
            "argv",
            [
                "prog",
                "--start-date",
                "2026-03-26",
                "--end-date",
                "2026-03-27",
                "--dataset-snapshot-ref",
                "snapshot-cli",
                "--output",
                str(args.output),
                "--allow-incomplete-coverage",
            ],
        ):
            self.assertTrue(materialize_cli._parse_args().allow_incomplete_coverage)
        with self.assertRaisesRegex(ValueError, "source_table_version_invalid"):
            materialize_cli._parse_source_table_versions(["broken"])

    def test_coverage_diagnostics_parse_day_level_counts(self) -> None:
        diagnostics = materialize_cli._parse_coverage_diagnostics(
            "bad\trow\n2026-03-26\t10\t5\t7\t2\t1\t2\n"
        )

        self.assertEqual(
            diagnostics,
            {
                "2026-03-26": {
                    "raw_signal_rows": 10,
                    "executable_signal_rows": 5,
                    "quote_sane_signal_rows": 5,
                    "spread_sane_signal_rows": 5,
                    "microbar_rows": 7,
                    "raw_signal_symbol_count": 2,
                    "executable_signal_symbol_count": 1,
                    "microbar_symbol_count": 2,
                    "min_executable_rows_per_symbol_day": 5,
                    "min_spread_sane_rows_per_symbol_day": 5,
                    "quote_valid_ratio": "1",
                    "min_quote_valid_ratio_by_symbol_day": "1",
                    "max_executable_gap_seconds": 0,
                },
            },
        )

        diagnostics = materialize_cli._parse_coverage_diagnostics(
            "2026-03-27\t100\t90\t89\t88\t95\t2\t2\t2\t44\t43\t0.9777777778\t0.95\t7\n"
        )
        self.assertEqual(diagnostics["2026-03-27"]["spread_sane_signal_rows"], 88)
        self.assertEqual(
            diagnostics["2026-03-27"]["min_quote_valid_ratio_by_symbol_day"],
            "0.95",
        )
        self.assertEqual(diagnostics["2026-03-27"]["max_executable_gap_seconds"], 7)

    def test_fetch_coverage_diagnostics_marks_missing_source_layers(self) -> None:
        args = Namespace(
            clickhouse_http_url="http://clickhouse.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            clickhouse_query_timeout_seconds=7,
        )
        with patch(
            "scripts.materialize_replay_tape.replay_mod._http_query",
            return_value="2026-03-26\t10\t5\t7\t2\t1\t2\n",
        ) as query:
            diagnostics = materialize_cli._fetch_coverage_diagnostics(
                args=args,
                symbols=("META",),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
            )

        self.assertEqual(
            materialize_cli._business_days(date(2026, 3, 27), date(2026, 3, 26)),
            (),
        )
        query_payload = str(query.call_args.kwargs["query"])
        self.assertIn("symbol IN ('META')", query_payload)
        self.assertIn("toUInt64OrZero(toString(raw_signal_rows))", query_payload)
        self.assertEqual(query.call_args.kwargs["timeout_seconds"], 7)
        self.assertEqual(diagnostics["missing_raw_signal_days"], ["2026-03-27"])
        self.assertEqual(diagnostics["missing_executable_signal_days"], ["2026-03-27"])
        self.assertEqual(diagnostics["missing_microbar_days"], ["2026-03-27"])

    def test_latest_complete_window_selects_latest_consecutive_complete_days(
        self,
    ) -> None:
        diagnostics = {
            "requested_trading_days": [
                "2026-03-26",
                "2026-03-27",
                "2026-03-30",
                "2026-03-31",
            ],
            "rows_by_trading_day": {
                "2026-03-26": self._coverage_row(
                    raw=10, executable=10, microbar=10, symbols=2
                ),
                "2026-03-27": self._coverage_row(
                    raw=10, executable=0, microbar=10, symbols=2
                ),
                "2026-03-30": self._coverage_row(
                    raw=10, executable=10, microbar=10, symbols=2
                ),
                "2026-03-31": self._coverage_row(
                    raw=11, executable=11, microbar=11, symbols=2
                ),
            },
        }

        selected_start, selected_end, selected_days = (
            materialize_cli._latest_complete_window(
                diagnostics,
                min_days=2,
                expected_symbol_count=2,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio=Decimal("0.90"),
                max_executable_gap_seconds=120,
            )
        )

        self.assertEqual(selected_start, date(2026, 3, 30))
        self.assertEqual(selected_end, date(2026, 3, 31))
        self.assertEqual(selected_days, ("2026-03-30", "2026-03-31"))
        with self.assertRaisesRegex(
            ValueError,
            "latest_complete_replay_window_missing:min_days=3",
        ):
            materialize_cli._latest_complete_window(
                diagnostics,
                min_days=3,
                expected_symbol_count=2,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio=Decimal("0.90"),
                max_executable_gap_seconds=120,
            )

        stale_gap_diagnostics = {
            "requested_trading_days": ["2026-03-30", "2026-03-31"],
            "rows_by_trading_day": {
                "2026-03-30": self._coverage_row(
                    raw=10, executable=10, microbar=10, max_gap_seconds=121
                ),
                "2026-03-31": self._coverage_row(
                    raw=10, executable=10, microbar=10, quote_valid_ratio="0.89"
                ),
            },
        }
        with self.assertRaisesRegex(
            ValueError,
            "latest_complete_replay_window_missing:min_days=1",
        ):
            materialize_cli._latest_complete_window(
                stale_gap_diagnostics,
                min_days=1,
                expected_symbol_count=1,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio=Decimal("0.90"),
                max_executable_gap_seconds=120,
            )

    def test_main_materializes_manifest_from_replay_rows(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            diagnostic_output = root / "coverage.json"
            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=diagnostic_output,
                source_table_version=["ta_signals=v1"],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    return_value=(
                        self._signal(day=26, seq=1),
                        self._signal(day=27, seq=2),
                    ),
                ),
                patch(
                    "scripts.materialize_replay_tape._fetch_coverage_diagnostics",
                    return_value={
                        "schema_version": "torghut.replay-coverage-diagnostic.v1",
                        "requested_trading_days": ["2026-03-26", "2026-03-27"],
                        "missing_executable_signal_days": [],
                    },
                ),
                redirect_stdout(stdout),
            ):
                exit_code = materialize_cli.main()

            payload = json.loads(stdout.getvalue())
            output_exists = output.exists()
            manifest_exists = manifest_output.exists()
            diagnostic_payload = json.loads(
                diagnostic_output.read_text(encoding="utf-8")
            )

        self.assertEqual(exit_code, 0)
        self.assertTrue(output_exists)
        self.assertTrue(manifest_exists)
        self.assertEqual(payload["dataset_snapshot_ref"], "snapshot-cli")
        self.assertEqual(payload["row_count"], 2)
        self.assertEqual(payload["source_table_versions"], {"ta_signals": "v1"})
        self.assertEqual(payload["observed_trading_days"], ["2026-03-26", "2026-03-27"])
        self.assertEqual(payload["missing_trading_days"], [])
        self.assertEqual(
            payload["row_count_by_trading_day"],
            {"2026-03-26": 1, "2026-03-27": 1},
        )
        self.assertEqual(payload["missing_symbol_trading_days"], [])
        self.assertEqual(
            payload["row_count_by_symbol_trading_day"],
            {"META": {"2026-03-26": 1, "2026-03-27": 1}},
        )
        self.assertEqual(diagnostic_payload["missing_executable_signal_days"], [])

    def test_main_can_materialize_latest_complete_source_window(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            diagnostic_output = root / "coverage.json"
            receipt_output = root / "window.json"
            captured_windows: list[tuple[date, date]] = []

            def iter_rows(config: ReplayConfig) -> tuple[SignalEnvelope, ...]:
                captured_windows.append((config.start_date, config.end_date))
                return (
                    self._signal(day=30, seq=1),
                    self._signal(day=31, seq=2),
                )

            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-31",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=diagnostic_output,
                latest_complete_window_min_days=2,
                latest_complete_window_receipt_output=receipt_output,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio="0.90",
                max_coverage_spread_bps="50",
                max_executable_gap_seconds=120,
                source_table_version=[],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            coverage = {
                "schema_version": "torghut.replay-coverage-diagnostic.v1",
                "requested_trading_days": [
                    "2026-03-26",
                    "2026-03-27",
                    "2026-03-30",
                    "2026-03-31",
                ],
                "rows_by_trading_day": {
                    "2026-03-26": self._coverage_row(
                        raw=10, executable=10, microbar=10
                    ),
                    "2026-03-27": self._coverage_row(raw=10, executable=0, microbar=10),
                    "2026-03-30": self._coverage_row(
                        raw=10, executable=10, microbar=10
                    ),
                    "2026-03-31": self._coverage_row(
                        raw=11, executable=11, microbar=11
                    ),
                },
                "missing_executable_signal_days": ["2026-03-27"],
            }
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape._fetch_coverage_diagnostics",
                    return_value=coverage,
                ) as fetch,
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    side_effect=iter_rows,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = materialize_cli.main()

            payload = json.loads(stdout.getvalue())
            diagnostic_payload = json.loads(
                diagnostic_output.read_text(encoding="utf-8")
            )
            receipt_payload = json.loads(receipt_output.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured_windows, [(date(2026, 3, 30), date(2026, 3, 31))])
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(payload["start_date"], "2026-03-30")
        self.assertEqual(payload["end_date"], "2026-03-31")
        self.assertEqual(
            payload["requested_trading_days"], ["2026-03-30", "2026-03-31"]
        )
        self.assertEqual(
            diagnostic_payload["latest_complete_window"]["selected_trading_days"],
            ["2026-03-30", "2026-03-31"],
        )
        self.assertEqual(receipt_payload["requested_start_date"], "2026-03-26")
        self.assertEqual(receipt_payload["effective_start_date"], "2026-03-30")
        self.assertEqual(
            receipt_payload["materialized_manifest"]["row_count"],
            2,
        )

    def test_latest_complete_window_failure_writes_diagnostics(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            diagnostic_output = root / "coverage.json"
            receipt_output = root / "window.json"
            args = Namespace(
                coverage_diagnostic_output=diagnostic_output,
                latest_complete_window_receipt_output=receipt_output,
                latest_complete_window_min_days=2,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio="0.90",
                max_executable_gap_seconds=120,
            )
            coverage = {
                "schema_version": "torghut.replay-coverage-diagnostic.v1",
                "requested_trading_days": ["2026-03-26", "2026-03-27"],
                "rows_by_trading_day": {
                    "2026-03-26": self._coverage_row(
                        raw=10,
                        executable=0,
                        microbar=10,
                    ),
                    "2026-03-27": self._coverage_row(
                        raw=10,
                        executable=10,
                        microbar=10,
                    ),
                },
            }
            with patch(
                "scripts.materialize_replay_tape._fetch_coverage_diagnostics",
                return_value=coverage,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "latest_complete_replay_window_missing:min_days=2",
                ):
                    materialize_cli._select_effective_window(
                        args=args,
                        symbols=("META",),
                        requested_start_date=date(2026, 3, 26),
                        requested_end_date=date(2026, 3, 27),
                    )

            diagnostic_payload = json.loads(
                diagnostic_output.read_text(encoding="utf-8")
            )
            receipt_payload = json.loads(receipt_output.read_text(encoding="utf-8"))

        self.assertEqual(receipt_payload["status"], "missing")
        self.assertEqual(receipt_payload["selected_trading_days"], [])
        self.assertEqual(
            diagnostic_payload["latest_complete_window"]["failure_reason"],
            "latest_complete_replay_window_missing:min_days=2",
        )

    def test_main_fails_closed_on_incomplete_coverage_by_default(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=None,
                source_table_version=[],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    return_value=(self._signal(day=26, seq=1),),
                ),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_days=2026-03-27",
                ):
                    materialize_cli.main()

            self.assertFalse(output.exists())
            self.assertFalse(manifest_output.exists())

    def test_main_writes_coverage_diagnostics_when_strict_coverage_fails(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            diagnostic_output = root / "coverage.json"
            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=diagnostic_output,
                source_table_version=[],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    return_value=(self._signal(day=26, seq=1),),
                ),
                patch(
                    "scripts.materialize_replay_tape._fetch_coverage_diagnostics",
                    return_value={
                        "schema_version": "torghut.replay-coverage-diagnostic.v1",
                        "requested_trading_days": ["2026-03-26", "2026-03-27"],
                        "rows_by_trading_day": {
                            "2026-03-26": {
                                "raw_signal_rows": 10,
                                "executable_signal_rows": 1,
                                "microbar_rows": 10,
                            },
                            "2026-03-27": {
                                "raw_signal_rows": 11,
                                "executable_signal_rows": 0,
                                "microbar_rows": 11,
                            },
                        },
                        "missing_executable_signal_days": ["2026-03-27"],
                    },
                ),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_days=2026-03-27",
                ):
                    materialize_cli.main()

            payload = json.loads(diagnostic_output.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["materialization_failure_reason"],
                "replay_tape_incomplete_coverage:missing_days=2026-03-27",
            )
            self.assertEqual(payload["missing_executable_signal_days"], ["2026-03-27"])
            self.assertEqual(
                payload["materialization_diagnostics"][
                    "materialized_executable_rows_by_trading_day"
                ],
                {"2026-03-26": 1},
            )
            self.assertFalse(output.exists())
            self.assertFalse(manifest_output.exists())

    def test_main_fails_closed_on_missing_symbol_days_by_default(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta,aapl",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=None,
                source_table_version=[],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    return_value=(
                        self._signal(day=26, seq=1),
                        self._signal(day=27, seq=2),
                    ),
                ),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_symbol_days=AAPL:2026-03-26,AAPL:2026-03-27",
                ):
                    materialize_cli.main()

            self.assertFalse(output.exists())
            self.assertFalse(manifest_output.exists())
