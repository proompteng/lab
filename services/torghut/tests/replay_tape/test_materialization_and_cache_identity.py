from __future__ import annotations

from tests.replay_tape.support import (
    json,
    sys,
    date,
    datetime,
    timezone,
    Decimal,
    Path,
    TemporaryDirectory,
    patch,
    HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
    ReplayTapeManifest,
    build_hpairs_replay_tape_feature_schema_hash,
    hpairs_replay_tape_feature_versions,
    build_replay_tape_cache_identity_diagnostics,
    build_replay_tape_cache_key,
    build_source_query_digest,
    load_replay_tape,
    materialize_signal_tape,
    signal_from_tape_payload,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
    SignalEnvelope,
    FetchChunkRequest,
    materialize_cli,
    ReplayConfig,
    _iter_signal_rows,
    _TestReplayTapeBase,
)


class TestReplayTapeMaterializationAndCacheIdentity(_TestReplayTapeBase):
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
            next(
                parent
                for parent in Path(__file__).resolve().parents
                if (
                    parent / "argocd/applications/torghut/strategy-configmap.yaml"
                ).is_file()
            )
            / "argocd/applications/torghut/strategy-configmap.yaml"
        )
        self.assertEqual(args.strategy_configmap, expected)
        self.assertTrue(args.strategy_configmap.exists())

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

    def test_materialize_signal_tape_carries_hpairs_clusterlob_ofi_features(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 31, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=1,
            source="ta",
            payload={
                "price": Decimal("900.10"),
                "ofi_horizons": {
                    "3_events": Decimal("0.42"),
                    "12_events": Decimal("0.31"),
                },
                "ofi_decay_memory": {
                    "half_life_3": Decimal("0.55"),
                    "half_life_12": Decimal("0.21"),
                },
                "cluster_lob_label": "directional",
                "cluster_lob_bucket": "aggressive_buy_pressure",
                "regime_tags": ["opening_drive", "tight_spread"],
                "macro_event_window": True,
                "target_implied_notional": Decimal("125000"),
                "capacity_notional_lineage": {
                    "target_net_pnl_per_day": "500",
                    "formula": "target/expectancy",
                },
            },
            ingest_ts=datetime(2026, 3, 26, 14, 32, tzinfo=timezone.utc),
        )

        with TemporaryDirectory() as tmpdir:
            tape_path = Path(tmpdir) / "tape.jsonl"
            materialize_signal_tape(
                rows=[signal],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-hpairs",
                symbols=("NVDA",),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 26),
                source_query_digest=build_source_query_digest({"window": "hpairs"}),
            )
            raw_row = json.loads(tape_path.read_text(encoding="utf-8").splitlines()[0])
            restored = signal_from_tape_payload(raw_row)

        self.assertIn("hpairs_features", raw_row)
        hpairs_features = restored.payload["hpairs_replay_tape_features"]
        self.assertEqual(
            hpairs_features["schema_version"],
            HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
        )
        self.assertEqual(
            hpairs_features["order_flow_imbalance_horizons"],
            {"12_events": "0.31", "3_events": "0.42"},
        )
        self.assertEqual(
            hpairs_features["ofi_decay_memory"],
            {"half_life_12": "0.21", "half_life_3": "0.55"},
        )
        self.assertEqual(
            hpairs_features["feature_schema_hash"],
            build_hpairs_replay_tape_feature_schema_hash(),
        )
        self.assertEqual(
            hpairs_features["ofi_memory_regime_slices"]["schema_version"],
            "torghut.hpairs-ofi-memory-regime-slices.v1",
        )
        self.assertEqual(
            hpairs_features["ofi_memory_regime_slices"]["horizons"]["short"],
            "0.42",
        )
        self.assertEqual(
            hpairs_features["ofi_memory_regime_slices"]["regime_bucket"],
            "stress_veto_window",
        )
        self.assertEqual(hpairs_features["cluster_lob"]["label"], "directional")
        self.assertEqual(
            hpairs_features["cluster_lob"]["bucket"], "aggressive_buy_pressure"
        )
        self.assertEqual(
            hpairs_features["cluster_lob"]["behavior_bucket"],
            "aggressive_buy_pressure",
        )
        self.assertEqual(
            hpairs_features["cluster_lob"]["quote_behavior_bucket"],
            "quote_depth_missing",
        )
        self.assertEqual(
            hpairs_features["regime_tags"], ["opening_drive", "tight_spread"]
        )
        self.assertEqual(hpairs_features["stress_tags"], ["macro_event_window"])
        self.assertEqual(
            hpairs_features["capacity_notional_lineage"]["target_implied_notional"],
            "125000",
        )
        self.assertFalse(hpairs_features["promotion_allowed"])
        self.assertFalse(hpairs_features["proof_authority"])

    def test_materialize_signal_tape_coerces_loose_hpairs_feature_shapes(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 31, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=1,
            source="ta",
            payload={
                "price": Decimal("900.10"),
                "ofi_horizon_custom": "0.44",
                "order_flow_imbalance_horizon_bad": "not-a-decimal",
                "ofi_decay_score": "0.12",
                "macro_announcement_window": "yes",
                "regime_tags": "opening_drive",
                "stress_tag": "fed",
            },
            ingest_ts=datetime(2026, 3, 26, 14, 32, tzinfo=timezone.utc),
        )

        with TemporaryDirectory() as tmpdir:
            tape_path = Path(tmpdir) / "tape.jsonl"
            materialize_signal_tape(
                rows=[signal],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-hpairs-loose",
                symbols=("NVDA",),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 26),
                source_query_digest=build_source_query_digest(
                    {"window": "hpairs-loose"}
                ),
            )
            restored = signal_from_tape_payload(
                json.loads(tape_path.read_text(encoding="utf-8").splitlines()[0])
            )

        hpairs_features = restored.payload["hpairs_replay_tape_features"]
        self.assertEqual(
            hpairs_features["order_flow_imbalance_horizons"],
            {"custom": "0.44"},
        )
        self.assertEqual(
            hpairs_features["ofi_decay_memory"],
            {"ofi_decay_score": "0.12"},
        )
        self.assertEqual(hpairs_features["regime_tags"], ["opening_drive"])
        self.assertEqual(
            hpairs_features["stress_tags"],
            ["fed", "macro_announcement_window"],
        )
        self.assertEqual(
            hpairs_features["cluster_lob"]["bucket"],
            "unknown",
        )
        self.assertEqual(
            hpairs_features["ofi_memory_regime_slices"]["horizons"]["instant"],
            "0.44",
        )
        self.assertFalse(hpairs_features["proof_authority"])

    def test_hpairs_replay_tape_features_are_deterministic_and_hashable(
        self,
    ) -> None:
        def signal(seq: int) -> SignalEnvelope:
            return SignalEnvelope(
                event_ts=datetime(2026, 3, 26, 14, 31, seq, tzinfo=timezone.utc),
                symbol="NVDA",
                timeframe="1Sec",
                seq=seq,
                source="ta",
                payload={
                    "price": Decimal("900.10"),
                    "event_type": "cancel",
                    "bid_size": Decimal("900"),
                    "ask_size": Decimal("100"),
                    "ofi_horizons": {
                        "36_events": Decimal("0.10"),
                        "3_events": Decimal("0.40"),
                    },
                    "ofi_decay_memory": {"half_life_3": Decimal("0.30")},
                    "regime_tags": ["opening_drive"],
                },
                ingest_ts=datetime(2026, 3, 26, 14, 32, tzinfo=timezone.utc),
            )

        with TemporaryDirectory() as tmpdir:
            first_path = Path(tmpdir) / "first.jsonl"
            second_path = Path(tmpdir) / "second.jsonl"
            materialize_signal_tape(
                rows=[signal(1)],
                tape_path=first_path,
                dataset_snapshot_ref="snapshot-hpairs-deterministic",
                symbols=("NVDA",),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 26),
                source_query_digest=build_source_query_digest(
                    {"window": "hpairs-deterministic"}
                ),
                feature_schema_hash=build_hpairs_replay_tape_feature_schema_hash(),
            )
            materialize_signal_tape(
                rows=[signal(1)],
                tape_path=second_path,
                dataset_snapshot_ref="snapshot-hpairs-deterministic",
                symbols=("NVDA",),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 26),
                source_query_digest=build_source_query_digest(
                    {"window": "hpairs-deterministic"}
                ),
                feature_schema_hash=build_hpairs_replay_tape_feature_schema_hash(),
            )
            first_row = json.loads(first_path.read_text(encoding="utf-8"))
            second_row = json.loads(second_path.read_text(encoding="utf-8"))
            first_manifest = load_replay_tape(first_path).manifest

        self.assertEqual(first_row["hpairs_features"], second_row["hpairs_features"])
        self.assertEqual(
            first_row["hpairs_features"]["feature_schema_hash"],
            build_hpairs_replay_tape_feature_schema_hash(),
        )
        self.assertEqual(
            first_row["hpairs_features"]["cluster_lob"]["bucket"],
            "liquidity_withdrawal",
        )
        self.assertEqual(
            first_row["hpairs_features"]["cluster_lob"]["quote_behavior_bucket"],
            "bid_depth_dominant",
        )
        self.assertEqual(
            first_row["hpairs_features"]["ofi_memory_regime_slices"]["regime_bucket"],
            "positive_ofi_shock",
        )
        self.assertEqual(
            first_manifest.feature_schema_hash,
            build_hpairs_replay_tape_feature_schema_hash(),
        )

    def test_materialize_signal_tape_skips_nyse_full_day_holidays(self) -> None:
        with TemporaryDirectory() as tmpdir:
            tape_path = Path(tmpdir) / "tape.jsonl"
            manifest = materialize_signal_tape(
                rows=[
                    self._signal(day=22, seq=1, symbol="META", month=5),
                    self._signal(day=26, seq=2, symbol="META", month=5),
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-memorial-week",
                symbols=("META",),
                start_date=date(2026, 5, 22),
                end_date=date(2026, 5, 26),
                source_query_digest=build_source_query_digest({"window": "memorial"}),
                require_complete_coverage=True,
            )

        self.assertEqual(
            manifest.requested_trading_days,
            (date(2026, 5, 22), date(2026, 5, 26)),
        )
        self.assertEqual(manifest.missing_trading_days, ())

    def test_iter_signal_rows_skips_nyse_full_day_holidays(self) -> None:
        fetched_days: list[date] = []

        def fetch_chunk(request: FetchChunkRequest) -> list[SignalEnvelope]:
            fetched_days.append(request.chunk_start.date())
            return []

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategy.yaml"),
            clickhouse_http_url="http://clickhouse.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=date(2026, 5, 22),
            end_date=date(2026, 5, 26),
            chunk_minutes=390,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            symbols=("META",),
        )

        with patch(
            "scripts.intraday_tsmom_replay.signal_rows._fetch_chunk",
            fetch_chunk,
        ):
            rows = list(_iter_signal_rows(config))

        self.assertEqual(rows, [])
        self.assertEqual(fetched_days, [date(2026, 5, 22), date(2026, 5, 26)])

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
        changed_symbol_universe_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-a",
            symbols=("AAPL", "NVDA", "TSM"),
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
        changed_source_digest_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-a",
            symbols=("AAPL", "NVDA"),
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            source_query_digest=build_source_query_digest({"window": "b"}),
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
        changed_feature_versions_key = build_replay_tape_cache_key(
            dataset_snapshot_ref="snapshot-a",
            symbols=("AAPL", "NVDA"),
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            source_query_digest=first_digest,
            feature_versions={"hpairs": "torghut.hpairs-replay-tape-features.v2"},
            source_table_versions={"signals": "v1"},
        )

        self.assertEqual(first_key, reordered_key)
        self.assertNotEqual(first_key, changed_symbol_universe_key)
        self.assertNotEqual(first_key, changed_key)
        self.assertNotEqual(first_key, changed_source_digest_key)
        self.assertNotEqual(first_key, changed_dataset_key)
        self.assertNotEqual(first_key, changed_feature_schema_key)
        self.assertNotEqual(first_key, changed_cost_model_key)
        self.assertNotEqual(first_key, changed_family_key)
        self.assertNotEqual(first_key, changed_feature_versions_key)

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
                feature_versions=hpairs_replay_tape_feature_versions(),
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
            feature_versions=hpairs_replay_tape_feature_versions(),
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
        self.assertEqual(
            manifest.to_payload()["feature_versions"],
            hpairs_replay_tape_feature_versions(),
        )

        validation = validate_tape_freshness(
            manifest,
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            symbols=("NVDA",),
        )
        self.assertEqual(validation["replay_cache_key"], expected_materialized_key)
        self.assertEqual(validation["source_query_digest"], first_digest)
        self.assertEqual(validation["source_table_versions"], {"signals": "v1"})
        self.assertEqual(validation["feature_schema_hash"], "feature-schema-v1")
        self.assertEqual(validation["cost_model_hash"], "cost-model-v1")
        self.assertEqual(validation["strategy_family"], "hpairs-v1")
        self.assertEqual(
            validation["feature_versions"], hpairs_replay_tape_feature_versions()
        )
        self.assertEqual(validation["cache_identity"]["status"], "complete")
        self.assertEqual(
            validation["cache_identity"]["components"]["date_range"],
            {"start_date": "2026-03-27", "end_date": "2026-03-27"},
        )

    def test_replay_tape_cache_identity_mismatch_fails_closed(self) -> None:
        source_query_digest = build_source_query_digest(
            {"window": "a", "symbols": ["NVDA", "AAPL"]}
        )
        with TemporaryDirectory() as tmpdir:
            manifest = materialize_signal_tape(
                rows=[
                    self._signal(day=27, seq=1, symbol="NVDA"),
                    self._signal(day=27, seq=2, symbol="AAPL"),
                ],
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-a",
                symbols=("NVDA", "AAPL"),
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=source_query_digest,
                feature_schema_hash="feature-schema-v1",
                cost_model_hash="cost-model-v1",
                strategy_family="hpairs-v1",
                feature_versions=hpairs_replay_tape_feature_versions(),
            )

        validation = validate_tape_freshness(
            manifest,
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 27),
            symbols=("AAPL", "NVDA"),
            require_exact_cache_identity=True,
            expected_dataset_snapshot_ref="snapshot-a",
            expected_source_query_digest=source_query_digest,
            expected_feature_schema_hash="feature-schema-v1",
            expected_cost_model_hash="cost-model-v1",
            expected_strategy_family="hpairs-v1",
            expected_replay_cache_key=manifest.replay_cache_key,
            expected_feature_versions=hpairs_replay_tape_feature_versions(),
        )
        self.assertEqual(validation["status"], "valid")

        with self.assertRaisesRegex(
            ValueError,
            "replay_tape_cache_identity_mismatch:.*feature_schema_hash",
        ):
            validate_tape_freshness(
                manifest,
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                symbols=("AAPL", "NVDA"),
                allow_stale_tape=True,
                require_exact_cache_identity=True,
                expected_dataset_snapshot_ref="snapshot-a",
                expected_source_query_digest=source_query_digest,
                expected_feature_schema_hash="feature-schema-v2",
                expected_cost_model_hash="cost-model-v1",
                expected_strategy_family="hpairs-v1",
            )

        stale_key_payload = manifest.to_payload()
        stale_key_payload["replay_cache_key"] = "stale-cache-key"
        stale_key_manifest = ReplayTapeManifest.from_payload(stale_key_payload)
        with self.assertRaisesRegex(
            ValueError,
            "replay_tape_cache_identity_mismatch:.*replay_cache_key",
        ):
            validate_tape_freshness(
                stale_key_manifest,
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                symbols=("AAPL", "NVDA"),
                require_exact_cache_identity=True,
            )

    def test_replay_tape_exact_cache_identity_blocks_incomplete_or_version_mismatch(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            incomplete_manifest = materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, symbol="NVDA")],
                tape_path=Path(tmpdir) / "incomplete-tape.jsonl",
                dataset_snapshot_ref="snapshot-incomplete",
                symbols=(),
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "incomplete"}),
            )
            complete_manifest = materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, symbol="NVDA")],
                tape_path=Path(tmpdir) / "complete-tape.jsonl",
                dataset_snapshot_ref="snapshot-complete",
                symbols=("NVDA",),
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "complete"}),
                feature_schema_hash="feature-schema-v1",
                cost_model_hash="cost-model-v1",
                strategy_family="hpairs-v1",
                feature_versions=hpairs_replay_tape_feature_versions(),
                source_table_versions={"signals": "v1"},
            )

        with self.assertRaisesRegex(
            ValueError,
            "replay_tape_cache_identity_mismatch:"
            ".*missing_components.*date_range.*symbol_universe",
        ):
            validate_tape_freshness(
                incomplete_manifest,
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
                symbols=("AAPL",),
                allow_stale_tape=True,
                require_exact_cache_identity=True,
            )

        with self.assertRaisesRegex(
            ValueError,
            "replay_tape_cache_identity_mismatch:"
            ".*feature_versions.*source_table_versions",
        ):
            validate_tape_freshness(
                complete_manifest,
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                symbols=("NVDA",),
                require_exact_cache_identity=True,
                expected_feature_versions={
                    "hpairs": "torghut.hpairs-replay-tape-features.v2"
                },
                expected_source_table_versions={"signals": "v2"},
            )

    def test_replay_tape_cache_identity_reports_missing_components(self) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest = materialize_signal_tape(
                rows=[self._signal(day=27, seq=1, symbol="NVDA")],
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-missing-identity",
                symbols=(),
                start_date=date(2026, 3, 27),
                end_date=date(2026, 3, 27),
                source_query_digest=build_source_query_digest({"window": "identity"}),
            )

        diagnostics = manifest.cache_identity_diagnostics()
        self.assertEqual(diagnostics["status"], "incomplete")
        self.assertIn("symbol_universe", diagnostics["missing_components"])
        self.assertIn("feature_schema_hash", diagnostics["missing_components"])
        self.assertIn("cost_model_hash", diagnostics["missing_components"])
        self.assertIn("strategy_family", diagnostics["missing_components"])
        self.assertIn(
            "replay_tape_cache_identity_missing_feature_schema_hash",
            diagnostics["blockers"],
        )
        self.assertEqual(manifest.to_payload()["cache_identity"], diagnostics)

        complete = build_replay_tape_cache_identity_diagnostics(
            dataset_snapshot_ref="snapshot-complete",
            symbols=("nvda", "AAPL"),
            start_date=date(2026, 3, 27),
            end_date=date(2026, 3, 28),
            source_query_digest=build_source_query_digest({"window": "identity"}),
            feature_schema_hash="feature-schema-v1",
            cost_model_hash="cost-model-v1",
            strategy_family="hpairs-v1",
            feature_versions=hpairs_replay_tape_feature_versions(),
        )
        self.assertEqual(complete["status"], "complete")
        self.assertEqual(complete["missing_components"], [])
        self.assertEqual(complete["components"]["symbol_universe"], ["AAPL", "NVDA"])
        self.assertEqual(
            complete["components"]["feature_versions"],
            hpairs_replay_tape_feature_versions(),
        )
