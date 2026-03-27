from __future__ import annotations

import json
from datetime import datetime, timezone
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.config import settings
from app.trading.forecast_runtime import (
    forecast_calibration_report,
    forecast_registry,
    forecast_status,
)


class TestForecastRuntime(TestCase):
    def setUp(self) -> None:
        self.original_manifest_path = settings.trading_forecast_registry_manifest_path
        self.original_manifest_url = settings.trading_forecast_registry_manifest_url
        self.original_refresh_seconds = settings.trading_forecast_registry_refresh_seconds
        self.original_stale_after_seconds = (
            settings.trading_forecast_calibration_stale_after_seconds
        )
        forecast_registry.reset()

    def tearDown(self) -> None:
        settings.trading_forecast_registry_manifest_path = self.original_manifest_path
        settings.trading_forecast_registry_manifest_url = self.original_manifest_url
        settings.trading_forecast_registry_refresh_seconds = self.original_refresh_seconds
        settings.trading_forecast_calibration_stale_after_seconds = (
            self.original_stale_after_seconds
        )
        forecast_registry.reset()

    def test_forecast_report_emits_lineage_and_authority_fields(self) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest_path = f"{tmpdir}/registry.json"
            now_iso = (
                datetime.now(timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z")
            )
            with open(manifest_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "schema_version": "torghut-forecast-registry.v1",
                        "registry_ref": "s3://torghut-forecast/registry/test.json",
                        "generated_at": now_iso,
                        "models": [
                            {
                                "model_family": "chronos",
                                "model_version": "chronos-empirical-v1",
                                "model_registry_ref": "s3://models/chronos/model.json",
                                "training_run_ref": "train/chronos/1",
                                "dataset_snapshot_ref": "datasets/chronos/1",
                                "calibration_ref": "calibration/chronos/1",
                                "calibration_score": "0.95",
                                "calibration_updated_at": now_iso,
                                "parameters": {
                                    "macd_weight": "0.9",
                                },
                            }
                        ],
                    },
                    handle,
                )
            settings.trading_forecast_registry_manifest_path = manifest_path
            settings.trading_forecast_registry_manifest_url = None
            settings.trading_forecast_registry_refresh_seconds = 1
            settings.trading_forecast_calibration_stale_after_seconds = 86400

            report = forecast_calibration_report(model_family="chronos")

        self.assertEqual(report["status"], "ready")
        model = report["models"][0]
        self.assertEqual(model["model_registry_ref"], "s3://models/chronos/model.json")
        self.assertEqual(model["training_run_ref"], "train/chronos/1")
        self.assertEqual(model["dataset_snapshot_ref"], "datasets/chronos/1")
        self.assertEqual(model["calibration_ref"], "calibration/chronos/1")
        self.assertTrue(model["promotion_authority_eligible"])
        self.assertTrue(model["artifact_authority"]["authoritative"])

    def test_forecast_status_marks_stale_registry_as_degraded(self) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest_path = f"{tmpdir}/registry.json"
            with open(manifest_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "schema_version": "torghut-forecast-registry.v1",
                        "models": [
                            {
                                "model_family": "moment",
                                "model_version": "moment-empirical-v1",
                                "model_registry_ref": "s3://models/moment/model.json",
                                "training_run_ref": "train/moment/1",
                                "dataset_snapshot_ref": "datasets/moment/1",
                                "calibration_ref": "calibration/moment/1",
                                "calibration_score": "0.91",
                                "calibration_updated_at": "2026-01-01T00:00:00Z",
                                "parameters": {},
                            }
                        ],
                    },
                    handle,
                )
            settings.trading_forecast_registry_manifest_path = manifest_path
            settings.trading_forecast_registry_manifest_url = None
            settings.trading_forecast_registry_refresh_seconds = 1
            settings.trading_forecast_calibration_stale_after_seconds = 60

            status = forecast_status()

        self.assertEqual(status["status"], "degraded")
        self.assertEqual(status["message"], "calibration_stale")
        self.assertEqual(status["calibration_status"], "degraded")

    def test_forecast_report_honors_as_of_for_replay_freshness(self) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest_path = f"{tmpdir}/registry.json"
            with open(manifest_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "schema_version": "torghut-forecast-registry.v1",
                        "models": [
                            {
                                "model_family": "moment",
                                "model_version": "moment-empirical-v1",
                                "model_registry_ref": "s3://models/moment/model.json",
                                "training_run_ref": "train/moment/1",
                                "dataset_snapshot_ref": "datasets/moment/1",
                                "calibration_ref": "calibration/moment/1",
                                "calibration_score": "0.91",
                                "calibration_updated_at": "2026-03-06T00:00:00Z",
                                "parameters": {},
                            }
                        ],
                    },
                    handle,
                )
            settings.trading_forecast_registry_manifest_path = manifest_path
            settings.trading_forecast_registry_manifest_url = None
            settings.trading_forecast_registry_refresh_seconds = 1
            settings.trading_forecast_calibration_stale_after_seconds = 60

            stale_report = forecast_calibration_report(model_family="moment")
            replay_report = forecast_calibration_report(
                model_family="moment",
                as_of="2026-03-06T00:00:30Z",
            )

        self.assertEqual(stale_report["status"], "degraded")
        self.assertEqual(replay_report["status"], "ready")
        self.assertTrue(replay_report["models"][0]["promotion_authority_eligible"])
