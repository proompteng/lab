from __future__ import annotations

import subprocess
import sys
import threading
import time
from pathlib import Path

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
        contender_resolved=threading.Event(),
        contender_fenced=threading.Event(),
        call_counter=_BrokerCallCounter(),
    )


def test_contender_failure_does_not_open_broker_gate() -> None:
    state = _new_race_state()
    # Exercise contender failure independently of thread-start latency.
    state.broker_started.set()
    broker_gate_opened = threading.Event()

    def submit(component: str) -> _WorkerResult:
        if component == "validation-contender":
            raise RuntimeError("contender_database_failure")
        state.broker_started.set()
        if (
            state.contender_resolved.wait(timeout=0.1)
            and state.contender_fenced.is_set()
        ):
            broker_gate_opened.set()
        return _WorkerResult("submitted")

    with pytest.raises(RuntimeError, match="contender_database_failure"):
        _race_validation_submissions(
            submit,
            state=state,
            timeout_seconds=2.0,
        )

    assert state.contender_resolved.is_set()
    assert not state.contender_fenced.is_set()
    assert not broker_gate_opened.is_set()


def test_contender_timeout_does_not_open_broker_gate() -> None:
    state = _new_race_state()
    # Exercise the contender deadline independently of thread-start latency.
    state.broker_started.set()
    broker_gate_opened = threading.Event()
    hold_contender = threading.Event()

    def submit(component: str) -> _WorkerResult:
        if component == "validation-contender":
            hold_contender.wait(timeout=0.5)
            return _WorkerResult("deferred")
        state.broker_started.set()
        if (
            state.contender_resolved.wait(timeout=0.1)
            and state.contender_fenced.is_set()
        ):
            broker_gate_opened.set()
        return _WorkerResult("submitted")

    started_at = time.monotonic()
    try:
        with pytest.raises(TimeoutError):
            _race_validation_submissions(
                submit,
                state=state,
                timeout_seconds=0.01,
            )
    finally:
        hold_contender.set()
    elapsed = time.monotonic() - started_at

    assert elapsed < 1.0
    assert state.contender_resolved.is_set()
    assert not state.contender_fenced.is_set()
    assert not broker_gate_opened.is_set()


def test_timeout_does_not_keep_cli_process_alive() -> None:
    script = r"""
import threading
import time

from app.trading.infrastructure_validation_submit import (
    _BrokerCallCounter,
    _SubmissionRaceState,
    _WorkerResult,
    _race_validation_submissions,
)

state = _SubmissionRaceState(
    broker_started=threading.Event(),
    contender_resolved=threading.Event(),
    contender_fenced=threading.Event(),
    call_counter=_BrokerCallCounter(),
)
# The process-exit assertion targets a hung contender, not worker scheduling.
state.broker_started.set()

def submit(component: str) -> _WorkerResult:
    if component == "validation-contender":
        threading.Event().wait()
        raise AssertionError("unreachable")
    state.broker_started.set()
    state.contender_resolved.wait(timeout=1.0)
    return _WorkerResult("failed")

started_at = time.monotonic()
try:
    _race_validation_submissions(submit, state=state, timeout_seconds=0.01)
except TimeoutError:
    pass
else:
    raise AssertionError("race did not time out")
if time.monotonic() - started_at >= 1.0:
    raise AssertionError("race exceeded its process-local deadline bound")
"""

    subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).resolve().parents[1],
        check=True,
        timeout=15.0,
    )


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
