from __future__ import annotations

from tests.replay_tape.support import (
    json,
    date,
    datetime,
    timezone,
    Decimal,
    Path,
    TemporaryDirectory,
    patch,
    REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
    ReplayTapeCoverageError,
    ReplayTapeManifest,
    build_source_query_digest,
    default_manifest_path,
    load_replay_tape,
    materialize_signal_tape,
    signal_from_tape_payload,
    validate_tape_freshness,
    ReplayConfig,
    _iter_signal_rows,
    _iter_signal_rows_from_replay_tape,
    _TestReplayTapeBase,
)


class TestReplayTapeManifestFreshnessAndLocalIterator(_TestReplayTapeBase):
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
                "scripts.intraday_tsmom_replay.signal_rows._fetch_chunk",
                side_effect=AssertionError("clickhouse should not be queried"),
            ):
                rows = list(_iter_signal_rows(config))

        self.assertEqual([row.symbol for row in rows], ["AAPL", "AAPL"])
        self.assertEqual(rows[0].payload["price"], Decimal("100.25"))
