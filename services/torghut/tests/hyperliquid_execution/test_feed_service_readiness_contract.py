"""Feed service readiness contract regressions."""

from __future__ import annotations

from pytest import MonkeyPatch

from app.hyperliquid_execution import feed_reader as feed_reader_module
from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.feed_reader import ClickHouseFeedReader
from app.hyperliquid_execution.models import RuntimeDependencyStatus


def test_feed_reader_requires_explicit_ready_true_from_feed_service(
    monkeypatch: MonkeyPatch,
) -> None:
    responses = iter(
        (
            (200, ""),
            (200, "{}"),
            (200, '{"ready":false}'),
            (200, '{"ready":true}'),
        )
    )

    def fake_request_http_get(*, url: str, timeout_seconds: int) -> tuple[int, str]:
        assert url == "http://feed/readyz"
        assert timeout_seconds == 3
        return next(responses)

    config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_FEED_READINESS_URL": "http://feed/readyz"}
    )
    monkeypatch.setattr(
        feed_reader_module,
        "_request_http_get",
        fake_request_http_get,
    )
    reader = _FeedStatusReader(config)

    for _ in range(3):
        status = reader.status()
        assert status.ready is False
        assert status.statuses[-1] == RuntimeDependencyStatus(
            "hyperliquid_feed_service",
            False,
            reason="feed_readiness_http_200",
            details={"http_status": 200},
        )

    status = reader.status()
    assert status.ready is True
    assert status.statuses[-1] == RuntimeDependencyStatus(
        "hyperliquid_feed_service",
        True,
        details={"http_status": 200},
    )


class _FeedStatusReader(ClickHouseFeedReader):
    def query_json_each_row(
        self,
        query: str,
        *,
        includes_format: bool = False,
    ) -> list[dict[str, object]]:
        if "UNION ALL" in query or includes_format:
            return [
                {
                    "name": "hyperliquid_candles",
                    "observed_at": "2026-06-19T12:00:00+00:00",
                    "lag_seconds": 1,
                },
                {
                    "name": "hyperliquid_ta_features",
                    "observed_at": "2026-06-19T12:00:00+00:00",
                    "lag_seconds": 2,
                },
            ]
        return []
