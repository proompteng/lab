from __future__ import annotations

from datetime import datetime, timezone

from torghut_forwarder.envelope import build_envelope, payload_to_dict


def test_build_envelope_includes_fields():
    now = datetime(2024, 1, 1, tzinfo=timezone.utc)
    payload = {"t": now, "price": 10}
    env = build_envelope(
        channel="trades",
        symbol="SPY",
        seq=1,
        payload=payload,
        event_ts=now,
        is_final=True,
        key="k1",
    )
    assert env["symbol"] == "SPY"
    assert env["channel"] == "trades"
    assert env["is_final"] is True
    assert env["event_ts"].startswith("2024-01-01T00:00:00")
    assert env["key"] == "k1"


def test_payload_to_dict_handles_objects():
    class Obj:
        def __init__(self) -> None:
            self.value = 1

    data = payload_to_dict(Obj())
    assert data == {"value": 1}
