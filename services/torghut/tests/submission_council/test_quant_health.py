from __future__ import annotations

# ruff: noqa: F401,F403,F405

from tests.submission_council.support import (
    SubmissionCouncilTestCase,
    _FakeQuantHealthResponse,
    load_quant_evidence_status,
    patch,
    resolve_quant_health_url,
    settings,
)


class TestSubmissionCouncilQuantHealth(SubmissionCouncilTestCase):
    def test_resolve_quant_health_url_accepts_typed_endpoint_with_query(self) -> None:
        settings.trading_jangar_quant_health_url = " https://jangar.example/api/torghut/trading/control-plane/quant/health?window=1h "
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_market_context_url = "https://jangar.example/market/context"

        self.assertEqual(
            resolve_quant_health_url(),
            "https://jangar.example/api/torghut/trading/control-plane/quant/health?window=1h",
        )

    def test_resolve_quant_health_url_rejects_wrong_endpoint_path(self) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_market_context_url = "https://jangar.example/market/context"

        self.assertIsNone(resolve_quant_health_url())

    def test_resolve_quant_health_url_does_not_fallback_to_control_plane_status(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_market_context_url = (
            "https://jangar.example/api/torghut/market-context/health?symbol=NVDA"
        )

        self.assertIsNone(resolve_quant_health_url())

    def test_resolve_quant_health_url_does_not_fallback_to_market_context(self) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_control_plane_status_url = ""
        settings.trading_market_context_url = (
            "https://jangar.example/api/torghut/market-context/health?symbol=NVDA"
        )

        self.assertIsNone(resolve_quant_health_url())

    def test_load_quant_evidence_status_is_informational_when_quant_health_is_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_quant_health_required = False

        status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["status"], "not_required")
        self.assertEqual(status["reason"], "quant_health_not_configured")
        self.assertEqual(status["blocking_reasons"], [])

    def test_load_quant_evidence_status_blocks_when_quant_health_is_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_quant_health_required = True

        status = load_quant_evidence_status(account_label="paper")

        self.assertFalse(status["ok"])
        self.assertTrue(status["required"])
        self.assertEqual(status["status"], "unknown")
        self.assertEqual(status["reason"], "quant_health_not_configured")
        self.assertEqual(status["blocking_reasons"], ["quant_health_not_configured"])

    def test_load_quant_evidence_status_rejects_wrong_endpoint_authority(self) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_jangar_quant_health_required = True

        status = load_quant_evidence_status(account_label="paper")

        self.assertFalse(status["ok"])
        self.assertTrue(status["required"])
        self.assertEqual(status["reason"], "quant_health_invalid_endpoint")
        self.assertEqual(status["blocking_reasons"], ["quant_health_invalid_endpoint"])
        self.assertEqual(
            status["source_url"],
            "https://jangar.example/api/agents/control-plane/status?namespace=agents",
        )
        self.assertIn(
            "/api/torghut/trading/control-plane/quant/health",
            str(status["message"]),
        )

    def test_load_quant_evidence_status_keeps_invalid_endpoint_informational_when_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_jangar_quant_health_required = False

        status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["reason"], "quant_health_invalid_endpoint")
        self.assertEqual(status["blocking_reasons"], [])
        self.assertEqual(
            status["informational_reasons"], ["quant_health_invalid_endpoint"]
        )

    def test_load_quant_evidence_status_reads_typed_endpoint_and_uses_cache(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = "https://jangar.example/api/torghut/trading/control-plane/quant/health?source=typed"
        settings.trading_jangar_quant_health_required = True
        settings.trading_jangar_quant_window = "15m"
        settings.trading_jangar_control_plane_cache_ttl_seconds = 60
        calls: list[str] = []

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            calls.append(str(getattr(request, "full_url")))
            self.assertEqual(
                timeout, settings.trading_jangar_control_plane_timeout_seconds
            )
            return _FakeQuantHealthResponse(
                {
                    "ok": True,
                    "status": "healthy",
                    "latestMetricsCount": 4,
                    "emptyLatestStoreAlarm": False,
                    "missingUpdateAlarm": False,
                    "stages": [{"name": "metrics", "ok": "yes"}],
                    "latestMetricsUpdatedAt": "2026-04-30T20:59:00Z",
                    "metricsPipelineLagSeconds": 3,
                    "maxStageLagSeconds": 5,
                    "asOf": "2026-04-30T20:59:03Z",
                }
            )

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            status = load_quant_evidence_status(account_label="paper")
            cached_status = load_quant_evidence_status(account_label="paper")

        self.assertEqual(len(calls), 1)
        self.assertIn("source=typed", calls[0])
        self.assertIn("account=paper", calls[0])
        self.assertIn("window=15m", calls[0])
        self.assertTrue(status["ok"])
        self.assertTrue(status["required"])
        self.assertEqual(status["reason"], "ready")
        self.assertEqual(status["stage_count"], 1)
        self.assertEqual(cached_status, status)

    def test_load_quant_evidence_status_reports_quant_pipeline_blockers(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/torghut/trading/control-plane/quant/health"
        )
        settings.trading_jangar_quant_health_required = True
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        payloads = [
            {
                "ok": True,
                "status": "healthy",
                "latestMetricsCount": 0,
                "emptyLatestStoreAlarm": True,
                "missingUpdateAlarm": True,
                "stages": [],
            },
            {
                "ok": True,
                "status": "healthy",
                "latestMetricsCount": 1,
                "emptyLatestStoreAlarm": False,
                "missingUpdateAlarm": False,
                "stages": [{"name": "metrics", "ok": "false"}],
            },
            {
                "ok": True,
                "status": "stale",
                "latestMetricsCount": 1,
                "emptyLatestStoreAlarm": False,
                "missingUpdateAlarm": False,
                "stages": [{"name": "metrics", "ok": True}],
            },
        ]

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            del request, timeout
            return _FakeQuantHealthResponse(payloads.pop(0))

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            empty_status = load_quant_evidence_status(account_label="paper")
            stage_status = load_quant_evidence_status(account_label="paper")
            stale_status = load_quant_evidence_status(account_label="paper")

        self.assertEqual(
            empty_status["blocking_reasons"],
            [
                "quant_latest_metrics_empty",
                "quant_latest_store_alarm",
                "quant_metrics_update_missing",
                "quant_pipeline_stages_missing",
            ],
        )
        self.assertEqual(stage_status["blocking_reasons"], ["quant_pipeline_degraded"])
        self.assertEqual(stale_status["blocking_reasons"], ["quant_health_degraded"])

    def test_load_quant_evidence_status_keeps_configured_degraded_endpoint_informational_when_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/torghut/trading/control-plane/quant/health"
        )
        settings.trading_jangar_quant_health_required = False
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            del request, timeout
            return _FakeQuantHealthResponse(
                {
                    "ok": True,
                    "status": "healthy",
                    "latestMetricsCount": 0,
                    "emptyLatestStoreAlarm": True,
                    "missingUpdateAlarm": False,
                    "stages": [],
                }
            )

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["status"], "degraded")
        self.assertEqual(status["reason"], "quant_latest_metrics_empty")
        self.assertEqual(status["blocking_reasons"], [])
        self.assertEqual(
            status["informational_reasons"],
            [
                "quant_latest_metrics_empty",
                "quant_latest_store_alarm",
                "quant_pipeline_stages_missing",
            ],
        )

    def test_load_quant_evidence_status_keeps_configured_fetch_failure_informational_when_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/torghut/trading/control-plane/quant/health"
        )
        settings.trading_jangar_quant_health_required = False
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            del request, timeout
            raise RuntimeError("network unavailable")

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["status"], "unknown")
        self.assertEqual(status["reason"], "quant_health_fetch_failed")
        self.assertEqual(status["blocking_reasons"], [])
        self.assertEqual(status["informational_reasons"], ["quant_health_fetch_failed"])
        self.assertEqual(status["message"], "network unavailable")
