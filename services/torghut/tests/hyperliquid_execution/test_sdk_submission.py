from __future__ import annotations

import pytest
from requests.exceptions import Timeout

from app.trading.broker_mutation_receipts import BrokerMutationBrokerIoError
from app.hyperliquid_execution.sdk_submission import (
    MarketOpenRequest,
    submit_market_open,
)


def _request() -> MarketOpenRequest:
    return MarketOpenRequest(
        market_name="BTC",
        is_buy=True,
        size=0.01,
        limit_price=50_000.0,
        cloid="0x" + "1" * 32,
    )


class _RecordingClient:
    def __init__(self, response: object) -> None:
        self.response = response
        self.calls: list[dict[str, object]] = []

    def market_open(self, **kwargs: object) -> object:
        self.calls.append(dict(kwargs))
        return self.response


class _TimeoutClient:
    def market_open(self, **_kwargs: object) -> object:
        raise Timeout("ambiguous response")


def test_market_open_boundary_makes_one_exact_sdk_call() -> None:
    client = _RecordingClient({"status": "ok"})

    result = submit_market_open(client, _request())

    assert result == {"status": "ok"}
    assert client.calls == [
        {
            "name": "BTC",
            "is_buy": True,
            "sz": 0.01,
            "px": 50_000.0,
            "slippage": 0.0,
            "cloid": "0x" + "1" * 32,
        }
    ]


@pytest.mark.parametrize("response", [None, {1: "non-string-key"}])
def test_market_open_boundary_rejects_malformed_responses(response: object) -> None:
    with pytest.raises(BrokerMutationBrokerIoError, match="response_invalid"):
        submit_market_open(_RecordingClient(response), _request())


def test_market_open_boundary_classifies_network_timeout() -> None:
    with pytest.raises(BrokerMutationBrokerIoError, match="Timeout"):
        submit_market_open(_TimeoutClient(), _request())
