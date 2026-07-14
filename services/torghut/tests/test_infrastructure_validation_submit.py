from __future__ import annotations

import threading

import pytest

from app.trading.infrastructure_validation_submit import (
    _BrokerCallCounter,
    _SubmissionRaceState,
    _WorkerResult,
    _race_validation_submissions,
    _require_known_null_terminal_order,
)


def _new_race_state() -> _SubmissionRaceState:
    return _SubmissionRaceState(
        broker_started=threading.Event(),
        contender_finished=threading.Event(),
        call_counter=_BrokerCallCounter(),
    )


def test_contender_failure_does_not_open_broker_gate() -> None:
    state = _new_race_state()
    broker_gate_opened = threading.Event()

    def submit(component: str) -> _WorkerResult:
        if component == "validation-contender":
            raise RuntimeError("contender_database_failure")
        state.broker_started.set()
        if state.contender_finished.wait(timeout=0.1):
            broker_gate_opened.set()
        return _WorkerResult("submitted")

    with pytest.raises(RuntimeError, match="contender_database_failure"):
        _race_validation_submissions(
            submit,
            state=state,
            timeout_seconds=0.1,
        )

    assert not state.contender_finished.is_set()
    assert not broker_gate_opened.is_set()


def test_contender_timeout_does_not_open_broker_gate() -> None:
    state = _new_race_state()
    broker_gate_opened = threading.Event()
    hold_contender = threading.Event()

    def submit(component: str) -> _WorkerResult:
        if component == "validation-contender":
            hold_contender.wait(timeout=0.1)
            return _WorkerResult("deferred")
        state.broker_started.set()
        if state.contender_finished.wait(timeout=0.1):
            broker_gate_opened.set()
        return _WorkerResult("submitted")

    with pytest.raises(TimeoutError):
        _race_validation_submissions(
            submit,
            state=state,
            timeout_seconds=0.01,
        )

    assert not state.contender_finished.is_set()
    assert not broker_gate_opened.is_set()


@pytest.mark.parametrize("status", ["canceled", "cancelled", "expired", "rejected"])
def test_known_null_terminal_order_requires_exact_identity_and_zero_fill(
    status: str,
) -> None:
    order = {
        "id": "paper-order-1",
        "client_order_id": "ivp-" + "a" * 44,
        "status": status,
        "filled_qty": "0",
    }

    _require_known_null_terminal_order(
        order,
        client_order_id="ivp-" + "a" * 44,
    )


@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"client_order_id": "ivp-" + "b" * 44}, "identity_mismatch"),
        ({"id": ""}, "identity_missing"),
        ({"status": "filled", "filled_qty": "1"}, "status_invalid"),
        ({"status": "canceled", "filled_qty": "0.01"}, "fill_observed"),
        ({"status": "canceled", "filled_qty": None}, "filled_qty_invalid"),
    ],
)
def test_terminal_order_rejects_wrong_identity_or_any_fill(
    overrides: dict[str, object],
    error: str,
) -> None:
    order: dict[str, object] = {
        "id": "paper-order-1",
        "client_order_id": "ivp-" + "a" * 44,
        "status": "canceled",
        "filled_qty": "0",
    }
    order.update(overrides)

    with pytest.raises(RuntimeError, match=error):
        _require_known_null_terminal_order(
            order,
            client_order_id="ivp-" + "a" * 44,
        )
