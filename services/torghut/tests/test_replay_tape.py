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
    ReplayTapeManifest,
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
                    self._signal(day=27, seq=2, symbol="AAPL"),
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

        self.assertEqual([row.symbol for row in rows], ["AAPL"])
        self.assertEqual(rows[0].payload["price"], Decimal("100.25"))


class TestMaterializeReplayTapeCli(TestCase):
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
                    "--source-table-version",
                    "ta_signals=v1",
                ],
            ):
                args = materialize_cli._parse_args()

        symbols = materialize_cli._parse_symbols(str(args.symbols))
        self.assertEqual(symbols, ("NVDA", "META"))
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
        with self.assertRaisesRegex(ValueError, "source_table_version_invalid"):
            materialize_cli._parse_source_table_versions(["broken"])

    def test_main_materializes_manifest_from_replay_rows(self) -> None:
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
                source_table_version=["ta_signals=v1"],
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
                    return_value=(self._signal(day=26, seq=1),),
                ),
                redirect_stdout(stdout),
            ):
                exit_code = materialize_cli.main()

            payload = json.loads(stdout.getvalue())
            output_exists = output.exists()
            manifest_exists = manifest_output.exists()

        self.assertEqual(exit_code, 0)
        self.assertTrue(output_exists)
        self.assertTrue(manifest_exists)
        self.assertEqual(payload["dataset_snapshot_ref"], "snapshot-cli")
        self.assertEqual(payload["row_count"], 1)
        self.assertEqual(payload["source_table_versions"], {"ta_signals": "v1"})
