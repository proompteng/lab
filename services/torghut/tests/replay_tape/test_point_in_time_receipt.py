from __future__ import annotations

import json
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.discovery.replay_tape import (
    PointInTimeReceiptSpec,
    build_point_in_time_data_receipt,
    load_replay_tape,
    materialize_signal_tape,
    validate_tape_freshness,
)
from app.trading.models import SignalEnvelope
from scripts.verify_point_in_time_replay_tape import verify_replay_tape


_FEATURE_SCHEMA_HASH = "1" * 64
_SOURCE_TABLE_VERSIONS = {
    "torghut.ta_signals": "schema-v1",
    "torghut.ta_microbars": "schema-v1",
}


class TestPointInTimeReplayTapeReceipt(TestCase):
    def _spec(self, **overrides: object) -> PointInTimeReceiptSpec:
        spec = PointInTimeReceiptSpec(
            observation_cutoff=datetime(2026, 3, 26, 18, 0, tzinfo=timezone.utc),
            feed_identity="alpaca-iex",
            session_calendar_version="nyse-v1",
            session_calendar_sha256="sha256:" + "2" * 64,
            universe_version="research-universe-v1",
            universe_sha256="sha256:" + "3" * 64,
            universe_symbols=("META",),
            corporate_actions_version="alpaca-announcements-v1",
            corporate_actions_sha256="sha256:" + "4" * 64,
            adjustment_policy="split-and-dividend-restatement-v1",
            adjustment_policy_sha256="sha256:" + "5" * 64,
            code_digest="6" * 40,
            economic_policy_digest="sha256:" + "7" * 64,
            feature_pipeline_sha256="sha256:" + "8" * 64,
        )
        return replace(spec, **overrides)

    def _row(
        self,
        *,
        seq: int = 1,
        symbol: str = "META",
        event_ts: datetime | None = None,
        signal_arrival: datetime | None = None,
        microbar_arrival: datetime | None = None,
        price: str = "100.25",
    ) -> SignalEnvelope:
        event = event_ts or datetime(2026, 3, 26, 17, 30, tzinfo=timezone.utc)
        signal_ingest = signal_arrival or event + timedelta(seconds=1)
        microbar_ingest = microbar_arrival or event + timedelta(seconds=2)
        return SignalEnvelope(
            event_ts=event,
            ingest_ts=max(signal_ingest, microbar_ingest),
            symbol=symbol,
            timeframe="1Sec",
            seq=seq,
            source="ta",
            payload={
                "_source_ingest_ts": {
                    "ta_signals": signal_ingest,
                    "ta_microbars": microbar_ingest,
                },
                "_source_versions": {
                    "ta_signals": 7,
                    "ta_microbars": 9,
                },
                "price": Decimal(price),
                "spread": Decimal("0.02"),
                "window_size": "PT1S",
            },
        )

    def _materialize(
        self,
        root: Path,
        *,
        name: str,
        rows: tuple[SignalEnvelope, ...],
        spec: PointInTimeReceiptSpec | None,
    ):
        return materialize_signal_tape(
            rows=rows,
            tape_path=root / f"{name}.jsonl",
            manifest_path=root / f"{name}.manifest.json",
            dataset_snapshot_ref="snapshot-v1",
            symbols=("META",),
            start_date=date(2026, 3, 26),
            end_date=date(2026, 3, 26),
            source_query_digest="9" * 64,
            feature_schema_hash=_FEATURE_SCHEMA_HASH,
            source_table_versions=_SOURCE_TABLE_VERSIONS,
            point_in_time_spec=spec,
            require_point_in_time_receipt=spec is not None,
        )

    def test_spec_round_trips_without_losing_causal_metadata(self) -> None:
        spec = self._spec()

        decoded = PointInTimeReceiptSpec.from_payload(spec.to_payload())

        self.assertEqual(decoded, spec)

    def test_same_rows_and_lineage_reproduce_exact_receipt_hashes(self) -> None:
        rows = (self._row(seq=2), self._row(seq=1, price="100.20"))
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            first = self._materialize(root, name="first", rows=rows, spec=self._spec())
            second = self._materialize(
                root, name="second", rows=rows, spec=self._spec()
            )

        first_receipt = first.point_in_time_receipt
        second_receipt = second.point_in_time_receipt
        self.assertIsNotNone(first_receipt)
        self.assertIsNotNone(second_receipt)
        assert first_receipt is not None and second_receipt is not None
        self.assertEqual(first_receipt.receipt_sha256, second_receipt.receipt_sha256)
        self.assertEqual(
            first_receipt.input_row_set_sha256,
            second_receipt.input_row_set_sha256,
        )
        self.assertEqual(
            first_receipt.feature_matrix_sha256,
            second_receipt.feature_matrix_sha256,
        )

    def test_receipt_rejects_lookahead_late_revisions_and_duplicate_identity(
        self,
    ) -> None:
        event = datetime(2026, 3, 26, 17, 30, tzinfo=timezone.utc)
        cutoff = self._spec().observation_cutoff
        cases = {
            "point_in_time_source_arrival_before_event": (
                self._row(
                    event_ts=event,
                    signal_arrival=event - timedelta(seconds=1),
                    microbar_arrival=event + timedelta(seconds=1),
                ),
            ),
            "point_in_time_arrival_after_observation_cutoff": (
                self._row(
                    event_ts=event,
                    signal_arrival=cutoff + timedelta(seconds=1),
                    microbar_arrival=cutoff + timedelta(seconds=2),
                ),
            ),
            "point_in_time_duplicate_input_identity": (
                self._row(price="100.20"),
                self._row(price="101.20"),
            ),
        }
        for expected_reason, rows in cases.items():
            with self.subTest(expected_reason=expected_reason):
                with self.assertRaisesRegex(ValueError, expected_reason):
                    build_point_in_time_data_receipt(
                        rows=rows,
                        content_sha256="a" * 64,
                        feature_schema_hash=_FEATURE_SCHEMA_HASH,
                        source_table_versions=_SOURCE_TABLE_VERSIONS,
                        spec=self._spec(),
                    )

    def test_receipt_rejects_delisted_symbol_missing_timezone_and_source_arrival(
        self,
    ) -> None:
        cases = {
            "point_in_time_symbol_outside_universe:OLD": self._row(symbol="OLD"),
            "point_in_time_event_timezone_missing": self._row(
                event_ts=datetime(2026, 3, 26, 17, 30)
            ),
        }
        missing_source = self._row()
        missing_source.payload["_source_ingest_ts"] = {
            "ta_signals": missing_source.ingest_ts
        }
        cases["point_in_time_row_source_arrival_missing:ta_microbars"] = missing_source
        for expected_reason, row in cases.items():
            with self.subTest(expected_reason=expected_reason):
                with self.assertRaisesRegex(ValueError, expected_reason):
                    build_point_in_time_data_receipt(
                        rows=(row,),
                        content_sha256="a" * 64,
                        feature_schema_hash=_FEATURE_SCHEMA_HASH,
                        source_table_versions=_SOURCE_TABLE_VERSIONS,
                        spec=self._spec(),
                    )

    def test_corporate_action_restatement_changes_receipt_identity(self) -> None:
        row = self._row()
        first = build_point_in_time_data_receipt(
            rows=(row,),
            content_sha256="a" * 64,
            feature_schema_hash=_FEATURE_SCHEMA_HASH,
            source_table_versions=_SOURCE_TABLE_VERSIONS,
            spec=self._spec(),
        )
        second = build_point_in_time_data_receipt(
            rows=(row,),
            content_sha256="a" * 64,
            feature_schema_hash=_FEATURE_SCHEMA_HASH,
            source_table_versions=_SOURCE_TABLE_VERSIONS,
            spec=replace(
                self._spec(),
                corporate_actions_sha256="sha256:" + "b" * 64,
            ),
        )

        self.assertNotEqual(first.receipt_sha256, second.receipt_sha256)

    def test_selected_source_revision_changes_input_and_receipt_identity(self) -> None:
        original = self._row()
        revised = self._row()
        revised.payload["_source_versions"] = {
            "ta_signals": 8,
            "ta_microbars": 9,
        }
        first = build_point_in_time_data_receipt(
            rows=(original,),
            content_sha256="a" * 64,
            feature_schema_hash=_FEATURE_SCHEMA_HASH,
            source_table_versions=_SOURCE_TABLE_VERSIONS,
            spec=self._spec(),
        )
        second = build_point_in_time_data_receipt(
            rows=(revised,),
            content_sha256="a" * 64,
            feature_schema_hash=_FEATURE_SCHEMA_HASH,
            source_table_versions=_SOURCE_TABLE_VERSIONS,
            spec=self._spec(),
        )

        self.assertNotEqual(first.input_row_set_sha256, second.input_row_set_sha256)
        self.assertNotEqual(first.receipt_sha256, second.receipt_sha256)

    def test_receipt_rejects_missing_selected_source_revision(self) -> None:
        row = self._row()
        row.payload["_source_versions"] = {"ta_signals": 7}

        with self.assertRaisesRegex(
            ValueError,
            "point_in_time_row_source_revision_missing:ta_microbars",
        ):
            build_point_in_time_data_receipt(
                rows=(row,),
                content_sha256="a" * 64,
                feature_schema_hash=_FEATURE_SCHEMA_HASH,
                source_table_versions=_SOURCE_TABLE_VERSIONS,
                spec=self._spec(),
            )

    def test_receipt_rejects_invalid_source_identity_and_window(self) -> None:
        cases = {
            "point_in_time_sequence_invalid": self._row().model_copy(
                update={"seq": None}
            ),
            "point_in_time_source_invalid": self._row().model_copy(
                update={"source": "other"}
            ),
            "point_in_time_window_invalid": self._row().model_copy(
                update={"timeframe": "5Sec"}
            ),
        }
        for expected_reason, row in cases.items():
            with self.subTest(expected_reason=expected_reason):
                with self.assertRaisesRegex(ValueError, expected_reason):
                    build_point_in_time_data_receipt(
                        rows=(row,),
                        content_sha256="a" * 64,
                        feature_schema_hash=_FEATURE_SCHEMA_HASH,
                        source_table_versions=_SOURCE_TABLE_VERSIONS,
                        spec=self._spec(),
                    )

    def test_receipt_rejects_blank_source_table_version(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "point_in_time_source_table_version_missing:ta_microbars",
        ):
            build_point_in_time_data_receipt(
                rows=(self._row(),),
                content_sha256="a" * 64,
                feature_schema_hash=_FEATURE_SCHEMA_HASH,
                source_table_versions={
                    "torghut.ta_signals": "schema-v1",
                    "torghut.ta_microbars": "",
                },
                spec=self._spec(),
            )

    def test_promotion_validation_rejects_legacy_unreceipted_tape(self) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest = self._materialize(
                Path(tmpdir),
                name="legacy",
                rows=(self._row(),),
                spec=None,
            )

        with self.assertRaisesRegex(
            ValueError,
            "replay_tape_point_in_time_receipt_required",
        ):
            validate_tape_freshness(
                manifest,
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 26),
                symbols=("META",),
                allow_stale_tape=True,
                require_point_in_time_receipt=True,
            )

    def test_incomplete_receipt_does_not_replace_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            row = self._row()
            row.payload["_source_ingest_ts"] = {"ta_signals": row.ingest_ts}
            with self.assertRaisesRegex(
                ValueError,
                "point_in_time_row_source_arrival_missing:ta_microbars",
            ):
                self._materialize(
                    root,
                    name="rejected",
                    rows=(row,),
                    spec=self._spec(),
                )

            self.assertFalse((root / "rejected.jsonl").exists())
            self.assertFalse((root / "rejected.manifest.json").exists())

    def test_load_rejects_tampered_receipt(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tape_path = root / "tape.jsonl"
            manifest_path = root / "tape.manifest.json"
            self._materialize(
                root,
                name="tape",
                rows=(self._row(),),
                spec=self._spec(),
            )
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            payload["point_in_time_receipt"]["input_row_set_sha256"] = (
                "sha256:" + "0" * 64
            )
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")

            with self.assertRaisesRegex(
                ValueError,
                "point_in_time_receipt_invalid",
            ):
                load_replay_tape(tape_path, manifest_path=manifest_path)

    def test_load_rejects_manifest_receipt_table_version_disagreement(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tape_path = root / "tape.jsonl"
            manifest_path = root / "tape.manifest.json"
            self._materialize(
                root,
                name="tape",
                rows=(self._row(),),
                spec=self._spec(),
            )
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            payload["source_table_versions"]["torghut.ta_signals"] = "schema-v2"
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")

            with self.assertRaisesRegex(
                ValueError,
                "point_in_time_source_table_versions_mismatch",
            ):
                load_replay_tape(tape_path, manifest_path=manifest_path)

    def test_load_rejects_receipt_boundary_disagreement(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tape_path = root / "tape.jsonl"
            manifest_path = root / "tape.manifest.json"
            self._materialize(
                root,
                name="tape",
                rows=(self._row(),),
                spec=self._spec(),
            )
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            payload["point_in_time_receipt"]["event_time_boundary"]["min"] = (
                "2026-03-26T17:00:00+00:00"
            )
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")

            with self.assertRaisesRegex(
                ValueError,
                "point_in_time_event_boundary_mismatch",
            ):
                load_replay_tape(tape_path, manifest_path=manifest_path)

    def test_independent_verifier_checks_expected_hash_anchors(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            manifest = self._materialize(
                root,
                name="verified",
                rows=(self._row(),),
                spec=self._spec(),
            )
            receipt = manifest.point_in_time_receipt
            assert receipt is not None
            verified = verify_replay_tape(
                tape_path=root / "verified.jsonl",
                manifest_path=root / "verified.manifest.json",
                expected_hashes={
                    "content_sha256": manifest.content_sha256,
                    "receipt_sha256": receipt.receipt_sha256,
                    "input_row_set_sha256": receipt.input_row_set_sha256,
                    "feature_matrix_sha256": receipt.feature_matrix_sha256,
                },
            )
            rejected = verify_replay_tape(
                tape_path=root / "verified.jsonl",
                manifest_path=root / "verified.manifest.json",
                expected_hashes={
                    "input_row_set_sha256": "sha256:" + "0" * 64,
                },
            )

        self.assertEqual(verified["status"], "verified")
        self.assertEqual(rejected["status"], "rejected")
        self.assertEqual(
            rejected["reason_codes"],
            ["expected_input_row_set_sha256_mismatch"],
        )
