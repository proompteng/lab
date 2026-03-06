from __future__ import annotations

import json
from tempfile import TemporaryDirectory
from unittest import TestCase

from fastapi.testclient import TestClient

import app.forecast_service as forecast_service
from app.config import settings


class TestForecastService(TestCase):
    def setUp(self) -> None:
        self.original_manifest_path = settings.trading_forecast_registry_manifest_path
        self.original_refresh_seconds = settings.trading_forecast_registry_refresh_seconds
        self.original_stale_after_seconds = settings.trading_forecast_calibration_stale_after_seconds
        forecast_service._registry._loaded_at = 0  # noqa: SLF001

    def tearDown(self) -> None:
        settings.trading_forecast_registry_manifest_path = self.original_manifest_path
        settings.trading_forecast_registry_refresh_seconds = self.original_refresh_seconds
        settings.trading_forecast_calibration_stale_after_seconds = self.original_stale_after_seconds
        forecast_service._registry._loaded_at = 0  # noqa: SLF001

    def test_forecast_service_emits_lineage_and_authority_fields(self) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest_path = f"{tmpdir}/registry.json"
            with open(manifest_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "schema_version": "torghut-forecast-registry.v1",
                        "registry_ref": "s3://torghut-forecast/registry/test.json",
                        "generated_at": "2026-03-06T00:00:00Z",
                        "models": [
                            {
                                "model_family": "chronos",
                                "model_version": "chronos-empirical-v1",
                                "model_registry_ref": "s3://models/chronos/model.json",
                                "training_run_ref": "train/chronos/1",
                                "dataset_snapshot_ref": "datasets/chronos/1",
                                "calibration_ref": "calibration/chronos/1",
                                "calibration_score": "0.95",
                                "calibration_updated_at": "2026-03-06T00:00:00Z",
                                "parameters": {
                                    "macd_weight": "0.9",
                                    "drift_bias_pct": "0.0001",
                                    "spread_penalty": "0.15",
                                },
                            }
                        ],
                    },
                    handle,
                )
            settings.trading_forecast_registry_manifest_path = manifest_path
            settings.trading_forecast_registry_refresh_seconds = 1
            settings.trading_forecast_calibration_stale_after_seconds = 86400

            client = TestClient(forecast_service.app)
            response = client.post(
                "/v1/forecasts",
                json={
                    "symbol": "AAPL",
                    "horizon": "1m",
                    "event_ts": "2026-03-06T00:00:00Z",
                    "model_family": "chronos",
                    "values": {
                        "price": "195.1",
                        "macd": "0.7",
                        "macd_signal": "0.2",
                        "vol_realized_w60s": "0.008",
                        "spread": "0.02",
                    },
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["model_registry_ref"], "s3://models/chronos/model.json")
        self.assertEqual(payload["training_run_ref"], "train/chronos/1")
        self.assertEqual(payload["dataset_snapshot_ref"], "datasets/chronos/1")
        self.assertEqual(payload["calibration_ref"], "calibration/chronos/1")
        self.assertTrue(payload["promotion_authority_eligible"])
        self.assertTrue(payload["artifact_authority"]["authoritative"])

    def test_readyz_fails_closed_when_registry_has_only_stale_calibration(self) -> None:
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
            settings.trading_forecast_registry_refresh_seconds = 1
            settings.trading_forecast_calibration_stale_after_seconds = 60

            client = TestClient(forecast_service.app)
            response = client.get("/readyz")

        self.assertEqual(response.status_code, 503)
