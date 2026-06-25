from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from scripts import verify_trading_loop_status as verifier
from scripts.verify_trading_loop_status import evaluate_loop_status


def _restored_payload() -> dict[str, object]:
    return {
        "restored": True,
        "blocker_reasons": [],
        "runtime": {"status": "ok"},
        "market_data": {"fresh": True},
        "alpha_model": {
            "present": True,
            "factor_snapshot_present": True,
            "forecast_present": True,
            "expected_edge_above_cost": True,
        },
        "risk_forecast": {"present": True},
        "portfolio_target": {
            "present": True,
            "target_notional_positive": True,
        },
        "execution_intent": {"present": True},
        "submitted_order": {"present": True},
        "exchange_order_state": {"ack_seen": True},
        "fills": {"recent_count": 3},
        "position": {"account_snapshot_fresh": True, "reconciled": True},
        "stale_open_orders": {"count": 0},
        "alpaca_guard": {"unexpected_live_order_count_24h": 0},
    }


def test_verifier_accepts_hard_proof_payload() -> None:
    assert evaluate_loop_status(_restored_payload()) == []


def test_verifier_rejects_green_runtime_without_fills() -> None:
    payload = _restored_payload()
    payload["restored"] = False
    payload["fills"] = {"recent_count": 0}

    failures = evaluate_loop_status(payload)

    assert "loop_status_not_restored" in failures
    assert "recent_fills_below_floor" in failures


def test_verifier_rejects_missing_multifactor_proof() -> None:
    payload = _restored_payload()
    payload["alpha_model"] = {"present": False}
    payload["portfolio_target"] = {"present": True, "target_notional_positive": False}

    failures = evaluate_loop_status(payload)

    assert "multifactor_alpha_model_missing" in failures
    assert "multifactor_target_notional_not_positive" in failures


def test_verifier_main_reads_status_file_and_reports_json(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    status_file = tmp_path / "status.json"
    status_file.write_text(json.dumps(_restored_payload()), encoding="utf-8")

    assert verifier.main(["--status-file", str(status_file)]) == 0

    report = json.loads(capsys.readouterr().out)
    assert report["schema_version"] == "torghut.trading-loop-status-verifier.v1"
    assert report["ok"] is True


def test_verifier_loads_url_payload_and_rejects_non_object(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class _Response:
        def __enter__(self) -> "_Response":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(_restored_payload()).encode("utf-8")

    def fake_urlopen(request: Any, *, timeout: float) -> _Response:
        captured["request"] = request
        captured["timeout"] = timeout
        return _Response()

    monkeypatch.setattr(verifier, "urlopen", fake_urlopen)

    payload = verifier._load_payload(None, "http://example.test/status", 2.5)

    assert payload["restored"] is True
    assert captured["timeout"] == 2.5

    bad_file = tmp_path / "bad.json"
    bad_file.write_text("[]", encoding="utf-8")
    with pytest.raises(SystemExit, match="status payload must be a JSON object"):
        verifier._load_payload(bad_file, "http://unused", 1.0)


def test_verifier_int_parser_handles_unusable_values() -> None:
    assert verifier._int(True) == 0
    assert verifier._int(None) == 0
    assert verifier._int("bad") == 0
