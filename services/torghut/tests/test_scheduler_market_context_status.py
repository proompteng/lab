from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, cast
from unittest import TestCase
from unittest.mock import patch

from app import config
from app.trading.llm.schema import MarketContextBundle
from app.trading.scheduler.runtime import TradingScheduler


class _FakeResponse:
    status = 200

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> bool:
        return False


class _BrokenUniverseResolver:
    def get_resolution(self) -> object:
        raise RuntimeError("universe unavailable")


class _PipelineWithBrokenUniverse:
    universe_resolver = _BrokenUniverseResolver()


class _CircuitBreakerStub:
    def snapshot(self) -> dict[str, str]:
        return {"state": "closed"}


class _LlmReviewEngineStub:
    circuit_breaker = _CircuitBreakerStub()


class _PipelineWithLlmReview:
    llm_review_engine = _LlmReviewEngineStub()


class _PipelineLabelStub:
    account_label = "live"


class TestTradingSchedulerMarketContextStatus(TestCase):
    def setUp(self) -> None:
        self._original_url = config.settings.trading_market_context_url
        self._original_timeout = config.settings.trading_market_context_timeout_seconds
        self._original_static_symbols = config.settings.trading_static_symbols_raw
        self._original_min_quality = config.settings.trading_market_context_min_quality
        self._original_max_staleness = (
            config.settings.trading_market_context_max_staleness_seconds
        )
        self._original_autonomy_enabled = config.settings.trading_autonomy_enabled
        self._original_evidence_enabled = (
            config.settings.trading_evidence_continuity_enabled
        )

    def tearDown(self) -> None:
        config.settings.trading_market_context_url = self._original_url
        config.settings.trading_market_context_timeout_seconds = self._original_timeout
        config.settings.trading_static_symbols_raw = self._original_static_symbols
        config.settings.trading_market_context_min_quality = self._original_min_quality
        config.settings.trading_market_context_max_staleness_seconds = (
            self._original_max_staleness
        )
        config.settings.trading_autonomy_enabled = self._original_autonomy_enabled
        config.settings.trading_evidence_continuity_enabled = (
            self._original_evidence_enabled
        )

    def test_status_fetches_jangar_context_when_runtime_state_is_empty(self) -> None:
        config.settings.trading_market_context_url = (
            "http://jangar.test/api/torghut/market-context"
        )
        config.settings.trading_market_context_timeout_seconds = 2
        config.settings.trading_static_symbols_raw = "AAPL,NVDA"
        config.settings.trading_market_context_min_quality = 0.4
        config.settings.trading_market_context_max_staleness_seconds = 300

        bundle = MarketContextBundle.model_validate(
            {
                "contextVersion": "torghut.market-context.v1",
                "symbol": "AAPL",
                "asOfUtc": "2026-05-14T13:35:00Z",
                "freshnessSeconds": 20,
                "qualityScore": 0.82,
                "sourceCount": 4,
                "riskFlags": [],
                "domains": {
                    "technicals": {
                        "domain": "technicals",
                        "state": "ok",
                        "asOf": "2026-05-14T13:35:00Z",
                        "freshnessSeconds": 20,
                        "maxFreshnessSeconds": 60,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "fundamentals": {
                        "domain": "fundamentals",
                        "state": "ok",
                        "asOf": "2026-05-14T13:20:00Z",
                        "freshnessSeconds": 920,
                        "maxFreshnessSeconds": 86400,
                        "sourceCount": 3,
                        "qualityScore": 0.95,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "news": {
                        "domain": "news",
                        "state": "ok",
                        "asOf": "2026-05-14T13:34:00Z",
                        "freshnessSeconds": 80,
                        "maxFreshnessSeconds": 600,
                        "sourceCount": 3,
                        "qualityScore": 0.9,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "regime": {
                        "domain": "regime",
                        "state": "ok",
                        "asOf": "2026-05-14T13:35:00Z",
                        "freshnessSeconds": 20,
                        "maxFreshnessSeconds": 120,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                },
            }
        )
        responses = iter(
            [
                _FakeResponse({"ok": True, "health": {"ok": True}}),
                _FakeResponse(
                    {
                        "ok": True,
                        "context": bundle.model_dump(mode="json", by_alias=True),
                    }
                ),
            ]
        )
        request_urls: list[str] = []

        def fake_urlopen(request: Any, _timeout: int) -> _FakeResponse:
            request_urls.append(str(request.full_url))
            return next(responses)

        scheduler = TradingScheduler()
        with patch("app.trading.market_context.urlopen", side_effect=fake_urlopen):
            status = scheduler.market_context_status()

        self.assertIn("/api/torghut/market-context/health?symbol=AAPL", request_urls[0])
        self.assertIn("/api/torghut/market-context?symbol=AAPL", request_urls[1])
        self.assertEqual(status["last_symbol"], "AAPL")
        self.assertEqual(scheduler.state.last_market_context_symbol, "AAPL")
        self.assertEqual(status["last_freshness_seconds"], 20)
        self.assertEqual(scheduler.state.last_market_context_freshness_seconds, 20)
        self.assertEqual(status["last_quality_score"], 0.82)
        self.assertEqual(
            status["last_domain_states"],
            {
                "technicals": "ok",
                "regime": "ok",
            },
        )
        self.assertFalse(status["alert_active"])
        self.assertFalse(scheduler.state.market_context_alert_active)

    def test_status_refetches_when_cached_domain_state_is_stale(self) -> None:
        config.settings.trading_market_context_url = (
            "http://jangar.test/api/torghut/market-context"
        )
        config.settings.trading_market_context_timeout_seconds = 2
        config.settings.trading_static_symbols_raw = "AAPL,AVGO,NVDA"
        config.settings.trading_market_context_min_quality = 0.4
        config.settings.trading_market_context_max_staleness_seconds = 300

        bundle = MarketContextBundle.model_validate(
            {
                "contextVersion": "torghut.market-context.v1",
                "symbol": "AVGO",
                "asOfUtc": "2026-05-14T15:01:12Z",
                "freshnessSeconds": 20,
                "qualityScore": 0.93,
                "sourceCount": 10,
                "riskFlags": [],
                "domains": {
                    "technicals": {
                        "domain": "technicals",
                        "state": "ok",
                        "asOf": "2026-05-14T15:01:12Z",
                        "freshnessSeconds": 20,
                        "maxFreshnessSeconds": 60,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "fundamentals": {
                        "domain": "fundamentals",
                        "state": "ok",
                        "asOf": "2026-05-13T15:45:29Z",
                        "freshnessSeconds": 83750,
                        "maxFreshnessSeconds": 86400,
                        "sourceCount": 3,
                        "qualityScore": 0.91,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "news": {
                        "domain": "news",
                        "state": "ok",
                        "asOf": "2026-05-14T14:57:44Z",
                        "freshnessSeconds": 215,
                        "maxFreshnessSeconds": 600,
                        "sourceCount": 5,
                        "qualityScore": 0.8,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "regime": {
                        "domain": "regime",
                        "state": "ok",
                        "asOf": "2026-05-14T15:01:12Z",
                        "freshnessSeconds": 20,
                        "maxFreshnessSeconds": 120,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                },
            }
        )
        responses = iter(
            [
                _FakeResponse({"ok": True, "health": {"overallState": "ok"}}),
                _FakeResponse(
                    {
                        "ok": True,
                        "context": bundle.model_dump(mode="json", by_alias=True),
                    }
                ),
            ]
        )
        request_urls: list[str] = []

        def fake_urlopen(request: Any, _timeout: int) -> _FakeResponse:
            request_urls.append(str(request.full_url))
            return next(responses)

        scheduler = TradingScheduler()
        scheduler.state.last_market_context_symbol = "AVGO"
        scheduler.state.last_market_context_checked_at = datetime(
            2026, 5, 14, 14, 57, 53, tzinfo=timezone.utc
        )
        scheduler.state.last_market_context_as_of = datetime(
            2026, 5, 14, 14, 57, 12, tzinfo=timezone.utc
        )
        scheduler.state.last_market_context_freshness_seconds = 239
        scheduler.state.last_market_context_quality_score = 0.93
        scheduler.state.last_market_context_domain_states = {
            "technicals": "ok",
            "fundamentals": "ok",
            "news": "ok",
            "regime": "stale",
        }
        scheduler.state.last_market_context_risk_flags = ["regime_stale"]
        scheduler.state.market_context_alert_active = True
        scheduler.state.market_context_alert_reason = (
            "market_context_domain_regime_stale"
        )

        with patch("app.trading.market_context.urlopen", side_effect=fake_urlopen):
            status = scheduler.market_context_status()

        self.assertIn("/api/torghut/market-context/health?symbol=AVGO", request_urls[0])
        self.assertIn("/api/torghut/market-context?symbol=AVGO", request_urls[1])
        self.assertEqual(status["last_symbol"], "AVGO")
        self.assertEqual(status["last_freshness_seconds"], 20)
        self.assertEqual(
            status["last_domain_states"],
            {
                "technicals": "ok",
                "regime": "ok",
            },
        )
        self.assertFalse(status["alert_active"])
        self.assertFalse(scheduler.state.market_context_alert_active)
        self.assertIsNone(scheduler.state.market_context_alert_reason)

    def test_status_clears_retired_market_context_alert_reason(self) -> None:
        config.settings.trading_market_context_url = ""
        config.settings.trading_static_symbols_raw = ""

        scheduler = TradingScheduler()
        scheduler.state.market_context_alert_active = True
        scheduler.state.market_context_alert_reason = "market_context_domain_news_stale"

        status = scheduler.market_context_status()

        self.assertFalse(status["alert_active"])
        self.assertIsNone(status["alert_reason"])

    def test_status_records_context_fetch_error(self) -> None:
        config.settings.trading_market_context_url = (
            "http://jangar.test/api/torghut/market-context"
        )
        config.settings.trading_market_context_timeout_seconds = 2
        config.settings.trading_static_symbols_raw = "AAPL"

        request_urls: list[str] = []

        def fake_urlopen(request: Any, _timeout: int) -> _FakeResponse:
            request_urls.append(str(request.full_url))
            if len(request_urls) == 1:
                return _FakeResponse({"ok": True, "health": {"ok": True}})
            raise RuntimeError("context unavailable")

        scheduler = TradingScheduler()
        with patch("app.trading.market_context.urlopen", side_effect=fake_urlopen):
            status = scheduler.market_context_status()

        self.assertIn("/api/torghut/market-context/health?symbol=AAPL", request_urls[0])
        self.assertIn("/api/torghut/market-context?symbol=AAPL", request_urls[1])
        self.assertEqual(status["last_fetch_error"], "context unavailable")
        self.assertEqual(
            scheduler.state.last_market_context_fetch_error,
            "context unavailable",
        )

    def test_probe_symbol_falls_back_when_universe_resolution_fails(self) -> None:
        config.settings.trading_static_symbols_raw = "MSFT,AAPL"

        scheduler = TradingScheduler()
        cast(Any, scheduler)._pipeline = _PipelineWithBrokenUniverse()

        self.assertEqual(
            cast(Any, scheduler)._market_context_probe_symbol(),
            "MSFT",
        )

    def test_llm_status_includes_review_engine_circuit_snapshot(self) -> None:
        scheduler = TradingScheduler()
        cast(Any, scheduler)._pipeline = _PipelineWithLlmReview()
        guardrails = SimpleNamespace(
            rollout_stage="shadow",
            effective_fail_mode="shadow",
            reasons=[],
            shadow_mode=True,
            allow_requests=True,
            governance_evidence_complete=True,
            adjustment_allowed=False,
            committee_enabled=False,
        )

        with (
            patch(
                "app.trading.scheduler.runtime.evaluate_llm_guardrails",
                return_value=guardrails,
            ),
            patch(
                "app.trading.scheduler.runtime._build_llm_policy_resolution",
                return_value={"mode": "shadow"},
            ),
        ):
            status = scheduler.llm_status()

        self.assertEqual(status["circuit"], {"state": "closed"})

    def test_start_reports_existing_pipeline_labels(self) -> None:
        async def run_once() -> None:
            scheduler = TradingScheduler()
            pipeline = _PipelineLabelStub()
            cast(Any, scheduler)._pipelines = [pipeline]
            cast(Any, scheduler)._pipeline = pipeline

            async def fake_run_loop() -> None:
                return None

            with (
                patch.object(scheduler, "_assert_trading_shorts_startup_policy"),
                patch.object(scheduler, "_run_loop", side_effect=fake_run_loop),
            ):
                await scheduler.start()
                task = scheduler._task
                self.assertIsNotNone(task)
                await cast(asyncio.Task[None], task)

        asyncio.run(run_once())

    def test_run_loop_executes_enabled_evidence_continuity_check(self) -> None:
        config.settings.trading_autonomy_enabled = False
        config.settings.trading_evidence_continuity_enabled = True
        scheduler = TradingScheduler()
        calls = {"trading": 0, "reconcile": 0, "evidence": 0}

        async def fake_trading_iteration() -> None:
            calls["trading"] += 1
            scheduler._stop_event.set()

        async def fake_reconcile_iteration() -> None:
            calls["reconcile"] += 1

        async def fake_evidence_iteration() -> None:
            calls["evidence"] += 1

        async def fake_sleep(_delay: float) -> None:
            return None

        cast(Any, scheduler)._run_trading_iteration = fake_trading_iteration
        cast(Any, scheduler)._run_reconcile_iteration = fake_reconcile_iteration
        cast(Any, scheduler)._run_evidence_iteration = fake_evidence_iteration
        cast(Any, scheduler)._sync_simulation_run_context = lambda: None
        cast(Any, scheduler)._interval_elapsed = lambda *_args, **_kwargs: True

        with patch(
            "app.trading.scheduler.runtime.asyncio.sleep", side_effect=fake_sleep
        ):
            asyncio.run(scheduler._run_loop())

        self.assertEqual(calls, {"trading": 1, "reconcile": 1, "evidence": 1})
        self.assertFalse(scheduler.state.running)
