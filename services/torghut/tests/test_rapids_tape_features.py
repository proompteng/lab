from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from app.trading.discovery.gpu_backends import GpuResearchBackendReport
from app.trading.discovery.rapids_tape_features import build_rapids_tape_feature_panel
from app.trading.discovery.replay_tape import (
    REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
    ReplayTapeManifest,
)
from app.trading.models import SignalEnvelope


class TestRapidsTapeFeatures(TestCase):
    def test_pandas_reference_builds_preview_feature_panel(self) -> None:
        panel = build_rapids_tape_feature_panel(
            rows=_feature_rows(),
            replay_tape_manifest=_manifest(),
            backend_preference="pandas",
        )

        payload = panel.to_payload()
        self.assertEqual(payload["schema_version"], "torghut.rapids-tape-feature-panel.v1")
        self.assertFalse(payload["promotion_proof"])
        self.assertEqual(payload["dataset_snapshot_ref"], "feature-snapshot")
        self.assertEqual(payload["source_query_digest"], "feature-source-digest")
        self.assertEqual(payload["replay_tape_digest"], "feature-content-digest")
        self.assertEqual(payload["row_count"], 3)
        self.assertEqual(payload["trading_day_count"], 2)
        self.assertEqual(
            payload["feature_names"],
            [
                "return_bps_mean",
                "return_bps_std",
                "spread_bps_p50",
                "spread_bps_p95",
                "ofi_mean",
                "microprice_bias_bps_mean",
                "volume_p50",
            ],
        )
        self.assertEqual(payload["research_backend"]["requested_backend"], "pandas")
        self.assertEqual(payload["research_backend"]["selected_backend"], "pandas")
        self.assertFalse(payload["research_backend"]["promotion_proof"])
        self.assertIn("runtime_ledger_proof_required", payload["research_backend"]["blockers"])

        rows_by_key = {
            (str(row["symbol"]), str(row["trading_day"])): row
            for row in payload["rows"]
        }
        nvda = rows_by_key[("NVDA", "2026-02-23")]
        self.assertEqual(nvda["row_count"], 2)
        self.assertEqual(Decimal(nvda["return_bps_mean"]), Decimal("100"))
        self.assertEqual(Decimal(nvda["return_bps_std"]), Decimal("0"))
        self.assertEqual(Decimal(nvda["spread_bps_p50"]), Decimal("4"))
        self.assertEqual(Decimal(nvda["spread_bps_p95"]), Decimal("5.8"))
        self.assertEqual(Decimal(nvda["ofi_mean"]), Decimal("0.3"))
        self.assertEqual(Decimal(nvda["microprice_bias_bps_mean"]), Decimal("7.5"))
        self.assertEqual(Decimal(nvda["volume_p50"]), Decimal("1500"))

        aapl = rows_by_key[("AAPL", "2026-02-24")]
        self.assertEqual(aapl["row_count"], 1)
        self.assertEqual(Decimal(aapl["return_bps_mean"]), Decimal("0"))
        self.assertEqual(Decimal(aapl["return_bps_std"]), Decimal("0"))
        self.assertEqual(Decimal(aapl["spread_bps_p95"]), Decimal("3"))

    def test_explicit_rapids_backend_fails_closed_when_unavailable(self) -> None:
        unavailable = GpuResearchBackendReport(
            backend="rapids-cudf",
            available=False,
            module="cudf",
            reason="module_not_installed",
        )

        with (
            patch(
                "app.trading.discovery.rapids_tape_features.probe_gpu_research_backend",
                return_value=unavailable,
            ),
            self.assertRaisesRegex(ValueError, "rapids_cudf_unavailable:module_not_installed"),
        ):
            build_rapids_tape_feature_panel(
                rows=_feature_rows(),
                replay_tape_manifest=_manifest(),
                backend_preference="rapids-cudf",
            )

    def test_auto_falls_back_to_pandas_when_rapids_unavailable(self) -> None:
        unavailable = GpuResearchBackendReport(
            backend="rapids-cudf",
            available=False,
            module="cudf",
            reason="module_not_installed",
        )

        with patch(
            "app.trading.discovery.rapids_tape_features.probe_gpu_research_backend",
            return_value=unavailable,
        ):
            panel = build_rapids_tape_feature_panel(
                rows=_feature_rows(),
                replay_tape_manifest=_manifest(),
                backend_preference="auto",
            )

        payload = panel.to_payload()
        self.assertEqual(payload["research_backend"]["requested_backend"], "auto")
        self.assertEqual(payload["research_backend"]["selected_backend"], "pandas-fallback")
        self.assertEqual(
            payload["research_backend"]["backend"]["reason"],
            "auto_fallback:module_not_installed",
        )

    def test_rapids_path_uses_cudf_frame_when_available(self) -> None:
        class FakeCudf:
            __version__ = "26.04.00-test"
            frames: list[Any] = []

            @classmethod
            def from_pandas(cls, frame: Any) -> Any:
                cls.frames.append(frame)
                return frame.copy()

        available = GpuResearchBackendReport(
            backend="rapids-cudf",
            available=True,
            module="cudf",
            version="26.04.00-test",
            device_name="NVIDIA GeForce RTX 5090",
            compute_capability="12.0",
        )

        with (
            patch(
                "app.trading.discovery.rapids_tape_features.probe_gpu_research_backend",
                return_value=available,
            ),
            patch(
                "app.trading.discovery.rapids_tape_features.importlib.import_module",
                return_value=FakeCudf,
            ),
        ):
            panel = build_rapids_tape_feature_panel(
                rows=_feature_rows(),
                replay_tape_manifest=_manifest(),
                backend_preference="rapids-cudf",
            )

        self.assertEqual(len(FakeCudf.frames), 1)
        payload = panel.to_payload()
        self.assertEqual(payload["research_backend"]["selected_backend"], "rapids-cudf")
        self.assertEqual(payload["research_backend"]["backend"]["device_name"], "NVIDIA GeForce RTX 5090")
        self.assertEqual(payload["rows"][0]["schema_version"], "torghut.rapids-tape-feature-row.v1")


def _feature_rows() -> tuple[SignalEnvelope, ...]:
    return (
        SignalEnvelope(
            event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=1,
            source="ta",
            payload={
                "price": Decimal("100"),
                "spread_bps": Decimal("2"),
                "order_flow_imbalance": Decimal("0.2"),
                "microprice": Decimal("100.05"),
                "microbar_volume": Decimal("1000"),
            },
        ),
        SignalEnvelope(
            event_ts=datetime(2026, 2, 23, 15, 31, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=2,
            source="ta",
            payload={
                "price": Decimal("101"),
                "spread_bps": Decimal("6"),
                "order_flow_imbalance": Decimal("0.4"),
                "microprice": Decimal("101.101"),
                "microbar_volume": Decimal("2000"),
            },
        ),
        SignalEnvelope(
            event_ts=datetime(2026, 2, 24, 15, 30, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=3,
            source="ta",
            payload={
                "price": Decimal("200"),
                "spread_bps": Decimal("3"),
                "order_flow_imbalance": Decimal("-0.2"),
                "microprice": Decimal("199.9"),
                "microbar_volume": Decimal("3000"),
            },
        ),
    )


def _manifest() -> ReplayTapeManifest:
    return ReplayTapeManifest(
        schema_version=REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
        dataset_snapshot_ref="feature-snapshot",
        symbols=("AAPL", "NVDA"),
        row_symbols=("AAPL", "NVDA"),
        start_date=date(2026, 2, 23),
        end_date=date(2026, 2, 24),
        start_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc),
        end_ts=datetime(2026, 2, 24, 21, 0, tzinfo=timezone.utc),
        min_event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
        max_event_ts=datetime(2026, 2, 24, 15, 30, tzinfo=timezone.utc),
        trading_day_count=2,
        row_count=3,
        source_query_digest="feature-source-digest",
        content_sha256="feature-content-digest",
        artifact_refs={"tape_path": "feature-tape.jsonl"},
        source_table_versions={"ta_signals": "v1"},
        created_at=datetime(2026, 2, 25, tzinfo=timezone.utc),
    )
