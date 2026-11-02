from __future__ import annotations

import json
from email.message import Message
from urllib.error import URLError
from unittest import TestCase
from unittest.mock import patch

from app.api.scheduler_proxy import proxy_scheduler_response
from app.config import settings


class _UpstreamResponse:
    def __init__(self, body: bytes, *, status: int, content_type: str) -> None:
        self._body = body
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = content_type

    def __enter__(self) -> _UpstreamResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class SchedulerRuntimeProxyTests(TestCase):
    def test_returns_scheduler_payload_without_reinterpreting_runtime_truth(
        self,
    ) -> None:
        upstream = _UpstreamResponse(
            b'{"running":true}',
            status=200,
            content_type="application/json",
        )
        with (
            patch.object(
                settings,
                "trading_scheduler_runtime_base_url",
                "http://scheduler.internal/",
            ),
            patch.object(
                settings,
                "trading_scheduler_runtime_timeout_seconds",
                1.5,
            ),
            patch(
                "app.api.scheduler_proxy.urlopen",
                return_value=upstream,
            ) as mocked_open,
        ):
            response = proxy_scheduler_response(
                path="/trading/status",
                accept="application/json",
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.body, b'{"running":true}')
        request = mocked_open.call_args.args[0]
        self.assertEqual(request.full_url, "http://scheduler.internal/trading/status")
        self.assertEqual(mocked_open.call_args.kwargs["timeout"], 1.5)

    def test_returns_explicit_unavailable_instead_of_inert_api_state(self) -> None:
        with patch(
            "app.api.scheduler_proxy.urlopen",
            side_effect=URLError("scheduler down"),
        ):
            response = proxy_scheduler_response(
                path="metrics",
                accept="text/plain",
            )

        self.assertEqual(response.status_code, 503)
        payload = json.loads(response.body)
        self.assertEqual(payload["detail"], "scheduler_runtime_unavailable")
        self.assertEqual(payload["owner"], "torghut-scheduler")


__all__ = ["SchedulerRuntimeProxyTests"]
