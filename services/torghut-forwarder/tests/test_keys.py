from __future__ import annotations

from torghut_forwarder.app import _dedup_key, _event_timestamp


def test_dedup_key_trade_prefers_id():
    payload = {"i": "trade123", "t": "2024-01-01T00:00:00Z"}
    assert _dedup_key("trades", "SPY", payload) == "trade123"


def test_dedup_key_bar_includes_symbol_and_final():
    payload = {"t": "2024-01-01T00:00:00Z", "is_final": True}
    assert _dedup_key("bars", "SPY", payload) == (
        "2024-01-01T00:00:00Z",
        "SPY",
        True,
    )


def test_event_timestamp_parses_strings():
    payload = {"t": "2024-01-01T00:00:00"}
    ts = _event_timestamp(payload)
    assert ts is not None
    assert ts.year == 2024
