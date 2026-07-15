from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.exchange import HyperliquidSdkExecutionExchange


_CLOID = "0x" + "a" * 32
_ACCOUNT = "0x" + "1" * 40


def _historical_order(
    *,
    oid: int = 123,
    cloid: str = _CLOID,
    status: str = "open",
) -> dict[str, object]:
    return {
        "order": {
            "coin": "BTC",
            "side": "B",
            "limitPx": "100",
            "sz": "1",
            "origSz": "1",
            "oid": oid,
            "tif": "Ioc",
            "cloid": cloid,
        },
        "status": status,
        "statusTimestamp": 1_725_000_000_000,
    }


def _exact_order(*, oid: int = 123, status: str = "open") -> dict[str, object]:
    return {
        "status": "order",
        "order": _historical_order(oid=oid, status=status),
    }


class _RecoveryInfo:
    def __init__(
        self,
        *,
        exact: object,
        history: object,
        fills: object,
    ) -> None:
        self.exact = exact
        self.history = history
        self.fills = fills
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def query_order_by_cloid(self, *args: object) -> object:
        self.calls.append(("orderStatus", args))
        return self.exact

    def historical_orders(self, *args: object) -> object:
        self.calls.append(("historicalOrders", args))
        return self.history

    def user_fills_by_time(self, *args: object) -> object:
        self.calls.append(("userFillsByTime", args))
        return self.fills


class _RecoveryExchange(HyperliquidSdkExecutionExchange):
    def __init__(
        self,
        config: HyperliquidExecutionConfig,
        info: _RecoveryInfo,
    ) -> None:
        super().__init__(config)
        self._fake_recovery_info = info

    def _recovery_info(self) -> _RecoveryInfo:
        return self._fake_recovery_info

    def _cloid(self, raw: str) -> str:
        return raw


def _config(**overrides: str) -> HyperliquidExecutionConfig:
    return HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": _ACCOUNT,
            **overrides,
        }
    )


def _window() -> tuple[datetime, datetime]:
    until = datetime.now(timezone.utc)
    return until - timedelta(minutes=5), until


def test_exact_lookup_avoids_high_weight_history_and_fill_reads() -> None:
    info = _RecoveryInfo(exact=_exact_order(), history=[], fills=[])
    exchange = _RecoveryExchange(_config(), info)
    after, until = _window()

    lookup = exchange.recover_order_by_cloid(_CLOID, after=after, until=until)

    assert lookup.outcome == "found"
    assert lookup.order == _historical_order()
    assert lookup.evidence["exact_order_status"] == "found"
    assert lookup.evidence["history_checked"] is False
    assert lookup.evidence["fill_checked"] is False
    assert lookup.evidence["absence_proof_complete"] is False
    assert [name for name, _ in info.calls] == ["orderStatus"]
    assert info.calls[0][1] == (_ACCOUNT, _CLOID)


def test_historical_order_recovers_when_exact_lookup_reports_unknown_oid() -> None:
    historical = _historical_order()
    info = _RecoveryInfo(
        exact={"status": "unknownOid"},
        history=[historical],
        fills=[],
    )
    exchange = _RecoveryExchange(_config(), info)
    after, until = _window()

    lookup = exchange.recover_order_by_cloid(_CLOID, after=after, until=until)

    assert lookup.outcome == "found"
    assert lookup.order == historical
    assert lookup.evidence["exact_order_status"] == "not_found"
    assert lookup.evidence["history_match_count"] == 1


def test_conflicting_exchange_order_ids_are_indeterminate() -> None:
    conflicting_fill = {
        "coin": "BTC",
        "side": "B",
        "px": "100",
        "sz": "0.25",
        "oid": 456,
        "cloid": _CLOID,
    }
    info = _RecoveryInfo(
        exact={"status": "unknownOid"},
        history=[_historical_order(oid=123)],
        fills=[conflicting_fill],
    )
    exchange = _RecoveryExchange(_config(), info)
    after, until = _window()

    lookup = exchange.recover_order_by_cloid(_CLOID, after=after, until=until)

    assert lookup.outcome == "indeterminate"
    assert lookup.evidence["reason"] == "conflicting_exchange_order_ids"
    assert lookup.evidence["absence_proof_complete"] is False


def test_exact_and_bounded_history_absence_is_complete() -> None:
    info = _RecoveryInfo(
        exact={"status": "unknownOid"},
        history=[],
        fills=[],
    )
    exchange = _RecoveryExchange(_config(), info)
    after, until = _window()

    lookup = exchange.recover_order_by_cloid(_CLOID, after=after, until=until)

    assert lookup.outcome == "not_found"
    assert lookup.order is None
    assert lookup.evidence["absence_proof_complete"] is True


def test_full_history_page_cannot_prove_absence() -> None:
    unrelated = _historical_order(cloid="0x" + "b" * 32)
    info = _RecoveryInfo(
        exact={"status": "unknownOid"},
        history=[unrelated] * 2000,
        fills=[],
    )
    exchange = _RecoveryExchange(_config(), info)
    after, until = _window()

    lookup = exchange.recover_order_by_cloid(_CLOID, after=after, until=until)

    assert lookup.outcome == "indeterminate"
    assert lookup.evidence["history_complete"] is False
    assert lookup.evidence["reason"] == "bounded_history_incomplete"


def test_matching_fill_proves_submission_without_claiming_terminal_fill() -> None:
    fill = {
        "coin": "BTC",
        "side": "B",
        "px": "99",
        "sz": "0.25",
        "oid": 123,
        "cloid": _CLOID,
    }
    info = _RecoveryInfo(
        exact={"status": "unknownOid"},
        history=[],
        fills=[fill],
    )
    exchange = _RecoveryExchange(_config(), info)
    after, until = _window()

    lookup = exchange.recover_order_by_cloid(_CLOID, after=after, until=until)

    assert lookup.outcome == "found"
    assert lookup.order is not None
    assert lookup.order["source"] == "user_fills_by_time"
    assert lookup.order["status"] == "accepted"
    assert lookup.evidence["fill_match_count"] == 1


def test_recovery_sdk_client_uses_dedicated_bounded_timeout() -> None:
    info_instance = Mock()
    info_class = Mock(return_value=info_instance)
    module = Mock(Info=info_class)
    exchange = HyperliquidSdkExecutionExchange(
        _config(
            HYPERLIQUID_EXECUTION_BROKER_MUTATION_RECOVERY_REQUEST_TIMEOUT_SECONDS="7"
        )
    )

    with patch(
        "app.hyperliquid_execution.exchange.importlib.import_module",
        return_value=module,
    ):
        first = exchange._recovery_info()
        second = exchange._recovery_info()

    assert first is second is info_instance
    info_class.assert_called_once_with(
        "https://api.hyperliquid-testnet.xyz",
        skip_ws=True,
        perp_dexs=[""],
        timeout=7.0,
    )
