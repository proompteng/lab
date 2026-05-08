from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from app.config import settings
from app.trading import jangar_continuity
from app.trading.jangar_continuity import (
    build_jangar_route_continuity_packet,
    load_jangar_route_continuity_packet,
)


NOW = datetime(2026, 5, 8, 1, 30, tzinfo=timezone.utc)


class _FakeStatusResponse:
    def __init__(self, status: int, payload: object) -> None:
        self.status = status
        self._payload = payload

    def __enter__(self) -> "_FakeStatusResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")


def test_source_rollout_truth_paper_hold_blocks_route_capital() -> None:
    packet = build_jangar_route_continuity_packet(
        {
            "source_rollout_truth_exchange": {
                "exchange_id": "source-rollout-truth-exchange:abc",
                "fresh_until": "2026-05-08T01:35:00+00:00",
                "receipts": [
                    {
                        "receipt_id": "truth-settlement:paper_canary:123",
                        "action_class": "paper_canary",
                        "action_decision": "hold",
                        "fresh_until": "2026-05-08T01:35:00+00:00",
                        "settlement_state": "proof_floor_repair_only",
                        "blocking_reasons": [
                            "torghut_consumer_evidence_missing",
                            "paper_settlement_required",
                        ],
                    }
                ],
            }
        },
        now=NOW,
    )

    assert packet["epoch_id"] == "truth-settlement:paper_canary:123"
    assert packet["state"] == "present"
    assert packet["decision"] == "hold"
    assert packet["source"] == "source_rollout_truth_exchange"
    assert packet["blocking_reasons"] == [
        "torghut_consumer_evidence_missing",
        "paper_settlement_required",
    ]


def test_continuity_ledger_allow_packet_can_admit_paper_candidate() -> None:
    packet = build_jangar_route_continuity_packet(
        {
            "continuity_witness_ledger": {
                "epoch_id": "continuity:epoch:1",
                "state": "present",
                "continuity_decision": "allow",
                "fresh_until": "2026-05-08T01:35:00+00:00",
                "blocking_reasons": [],
            }
        },
        now=NOW,
    )

    assert packet == {
        "epoch_id": "continuity:epoch:1",
        "state": "present",
        "decision": "allow",
        "fresh_until": "2026-05-08T01:35:00+00:00",
        "blocking_reasons": [],
        "source": "continuity_witness_ledger",
        "action_class": "paper_canary",
    }


def test_expired_jangar_packet_is_reduced_to_hold() -> None:
    packet = build_jangar_route_continuity_packet(
        {
            "source_rollout_truth_exchange": {
                "receipts": [
                    {
                        "receipt_id": "truth-settlement:paper_canary:expired",
                        "action_class": "paper_canary",
                        "action_decision": "allow",
                        "fresh_until": "2026-05-08T01:29:59+00:00",
                    }
                ]
            }
        },
        now=NOW,
    )

    assert packet["epoch_id"] == "truth-settlement:paper_canary:expired"
    assert packet["state"] == "stale"
    assert packet["decision"] == "hold"
    assert packet["blocking_reasons"] == ["jangar_continuity_epoch_stale"]


def test_missing_action_receipt_names_blocking_reason() -> None:
    packet = build_jangar_route_continuity_packet(
        {
            "source_rollout_truth_exchange": {
                "exchange_id": "source-rollout-truth-exchange:abc",
                "fresh_until": "2026-05-08T01:35:00+00:00",
                "receipts": [],
            }
        },
        now=NOW,
    )

    assert packet["epoch_id"] == "source-rollout-truth-exchange:abc"
    assert packet["state"] == "missing"
    assert packet["decision"] == "missing"
    assert packet["blocking_reasons"] == ["jangar_paper_canary_receipt_missing"]


def test_continuity_ledger_falls_back_to_current_epoch_and_naive_freshness() -> None:
    packet = build_jangar_route_continuity_packet(
        {
            "continuity_witness_ledger": {
                "current_epoch_id": "continuity:epoch:fallback",
                "state": "present",
                "decision": "allow",
                "fresh_until": "2026-05-08T01:35:00",
            }
        },
        now=NOW,
    )

    assert packet["epoch_id"] == "continuity:epoch:fallback"
    assert packet["decision"] == "allow"
    assert packet["blocking_reasons"] == []


def test_invalid_freshness_and_missing_epoch_keep_packet_blocked() -> None:
    packet = build_jangar_route_continuity_packet(
        {
            "continuity_witness_ledger": {
                "state": "present",
                "action_decision": "hold",
                "fresh_until": "not-a-date",
            }
        },
        now=NOW,
    )

    assert packet["epoch_id"] is None
    assert packet["decision"] == "hold"
    assert packet["blocking_reasons"] == ["jangar_continuity_epoch_missing"]


def test_missing_truth_exchange_marks_status_source_and_epoch_missing() -> None:
    packet = build_jangar_route_continuity_packet({}, now=NOW)

    assert packet["epoch_id"] is None
    assert packet["state"] == "missing"
    assert packet["decision"] == "missing"
    assert packet["source"] == "jangar_control_plane_status"
    assert packet["blocking_reasons"] == [
        "jangar_paper_canary_receipt_missing",
        "jangar_continuity_epoch_missing",
    ]


def test_load_continuity_packet_reports_missing_status_url(monkeypatch: Any) -> None:
    monkeypatch.setattr(settings, "trading_jangar_control_plane_status_url", "")

    packet = load_jangar_route_continuity_packet()

    assert packet["state"] == "missing"
    assert packet["decision"] == "missing"
    assert packet["blocking_reasons"] == ["jangar_control_plane_status_url_missing"]


def test_load_continuity_packet_fetches_status_and_uses_cache(monkeypatch: Any) -> None:
    jangar_continuity._STATUS_CACHE.clear()
    monkeypatch.setattr(
        settings,
        "trading_jangar_control_plane_status_url",
        "https://jangar.example/api/agents/control-plane/status",
    )
    monkeypatch.setattr(settings, "trading_jangar_control_plane_cache_ttl_seconds", 60)
    calls: list[str] = []

    def fake_urlopen(request: object, timeout: object) -> _FakeStatusResponse:
        calls.append(str(getattr(request, "full_url")))
        assert timeout == settings.trading_jangar_control_plane_timeout_seconds
        return _FakeStatusResponse(
            200,
            {
                "continuity_witness_ledger": {
                    "ledger_id": "continuity:ledger:1",
                    "state": "present",
                    "decision": "allow",
                    "fresh_until": "2099-05-08T01:35:00Z",
                }
            },
        )

    monkeypatch.setattr(jangar_continuity, "urlopen", fake_urlopen)

    first = load_jangar_route_continuity_packet()
    second = load_jangar_route_continuity_packet()

    assert len(calls) == 1
    assert first == second
    assert first["epoch_id"] == "continuity:ledger:1"
    assert first["decision"] == "allow"


def test_load_continuity_packet_reports_fetch_failure(monkeypatch: Any) -> None:
    jangar_continuity._STATUS_CACHE.clear()
    monkeypatch.setattr(
        settings,
        "trading_jangar_control_plane_status_url",
        "https://jangar.example/api/agents/control-plane/status",
    )
    monkeypatch.setattr(settings, "trading_jangar_control_plane_cache_ttl_seconds", 0)

    def fake_urlopen(_request: object, timeout: object = None) -> _FakeStatusResponse:
        assert timeout == settings.trading_jangar_control_plane_timeout_seconds
        return _FakeStatusResponse(503, {"error": "not ready"})

    monkeypatch.setattr(jangar_continuity, "urlopen", fake_urlopen)

    packet = load_jangar_route_continuity_packet()

    assert packet["state"] == "missing"
    assert packet["decision"] == "missing"
    assert packet["blocking_reasons"] == ["jangar_continuity_status_fetch_failed"]
    assert "jangar_status_http_503" in str(packet["message"])


def test_load_continuity_packet_reports_invalid_payload(monkeypatch: Any) -> None:
    jangar_continuity._STATUS_CACHE.clear()
    monkeypatch.setattr(
        settings,
        "trading_jangar_control_plane_status_url",
        "https://jangar.example/api/agents/control-plane/status",
    )
    monkeypatch.setattr(settings, "trading_jangar_control_plane_cache_ttl_seconds", 0)

    def fake_urlopen(_request: object, timeout: object = None) -> _FakeStatusResponse:
        assert timeout == settings.trading_jangar_control_plane_timeout_seconds
        return _FakeStatusResponse(200, ["not", "an", "object"])

    monkeypatch.setattr(jangar_continuity, "urlopen", fake_urlopen)

    packet = load_jangar_route_continuity_packet()

    assert packet["blocking_reasons"] == ["jangar_continuity_status_payload_invalid"]
