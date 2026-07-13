from __future__ import annotations

import uuid
from dataclasses import dataclass
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.trading.broker_mutation_receipts.canonicalization import (
    build_broker_mutation_intent,
)
from app.trading.broker_mutation_receipts import linked_recovery_worker as worker
from app.trading.broker_mutation_receipts.types import (
    BrokerMutationIntentRequest,
    BrokerMutationTarget,
)
from app.trading.execution.materialization import RecoveryMaterializationError


_DECISION_ID = uuid.UUID("00000000-0000-0000-0000-000000000101")
_CLIENT_ORDER_ID = "client-order-101"


@dataclass(frozen=True, slots=True)
class _Acquisition:
    outcome: str
    receipt: object | None
    submission_claim: object | None
    handle: object | None

    @property
    def acquired(self) -> bool:
        return self.outcome in {"acquired", "already_owned"}


class _Session:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    def __enter__(self) -> _Session:
        self._events.append("session_enter")
        return self

    def __exit__(self, *_args: object) -> None:
        self._events.append("session_exit")


def _session_factory(events: list[str]):
    def factory() -> _Session:
        events.append("session_new")
        return _Session(events)

    return factory


def _intent(**overrides: object):
    request: dict[str, object] = {
        "symbol": "AAPL",
        "side": "buy",
        "qty": Decimal("2"),
        "notional": None,
        "order_type": "limit",
        "time_in_force": "day",
        "limit_price": Decimal("190.25"),
        "stop_price": None,
        "trail_price": None,
        "trail_percent": None,
        "order_class": "simple",
        "position_intent": "buy_to_open",
        "extended_hours": False,
    }
    request.update(overrides)
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper-primary",
            endpoint_fingerprint="a" * 64,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id="decision/101",
            client_request_id=_CLIENT_ORDER_ID,
            target=BrokerMutationTarget(kind="order", key=_CLIENT_ORDER_ID),
            request_payload=request,
            submission_claim_id=_DECISION_ID,
        )
    )


def _broker_order(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "broker-order-101",
        "client_order_id": _CLIENT_ORDER_ID,
        "alpaca_account_label": "paper-primary",
        "status": "accepted",
        "symbol": "AAPL",
        "side": "buy",
        "qty": "2",
        "notional": None,
        "type": "limit",
        "time_in_force": "day",
        "limit_price": "190.25",
        "stop_price": None,
        "trail_price": None,
        "trail_percent": None,
        "order_class": "simple",
        "position_intent": "buy_to_open",
        "extended_hours": False,
        "filled_qty": "0",
        "filled_avg_price": None,
    }
    payload.update(overrides)
    return payload


def _acquired(intent: object) -> _Acquisition:
    receipt = SimpleNamespace(intent=intent)
    claim = SimpleNamespace(broker_order_id=None)
    handle = SimpleNamespace(submission_claim=SimpleNamespace())
    return _Acquisition(
        outcome="acquired",
        receipt=receipt,
        submission_claim=claim,
        handle=handle,
    )


def _install_acquisition(
    monkeypatch: pytest.MonkeyPatch,
    acquisition: _Acquisition,
    events: list[str],
) -> None:
    def acquire(*_args: object, **_kwargs: object) -> _Acquisition:
        events.append("acquire")
        return acquisition

    monkeypatch.setattr(worker, "acquire_linked_submission_recovery", acquire)


def _install_quarantine_hooks(
    monkeypatch: pytest.MonkeyPatch,
    events: list[str],
) -> None:
    monkeypatch.setattr(
        worker,
        "build_broker_mutation_recovery_observation",
        lambda _request: events.append("build_observation") or object(),
    )
    monkeypatch.setattr(
        worker,
        "record_linked_submission_recovery_observation",
        lambda *_args, **_kwargs: events.append("record_observation"),
    )
    monkeypatch.setattr(
        worker,
        "release_linked_submission_recovery",
        lambda *_args, **_kwargs: events.append("release"),
    )


def test_busy_recovery_does_not_call_broker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    acquisition = _Acquisition("busy", None, None, None)
    _install_acquisition(monkeypatch, acquisition, events)

    def broker_read(**_kwargs: object) -> object:
        events.append("broker_read")
        return _broker_order()

    result = worker.recover_linked_submission(
        worker.LinkedRecoveryRequest(
            session_factory=_session_factory(events),
            receipt_id=uuid.uuid4(),
            recovery_owner="recovery-worker",
            writer_generation=7,
            broker_read=broker_read,
        )
    )

    assert result.outcome == "busy"
    assert events == ["session_new", "session_enter", "acquire", "session_exit"]


def test_absent_broker_order_is_quarantined_and_released(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    intent = _intent()
    acquisition = _acquired(intent)
    _install_acquisition(monkeypatch, acquisition, events)
    _install_quarantine_hooks(monkeypatch, events)

    def broker_read(**kwargs: object) -> object | None:
        events.append(f"broker_read:{kwargs['client_order_id']}")
        return None

    result = worker.recover_linked_submission(
        worker.LinkedRecoveryRequest(
            session_factory=_session_factory(events),
            receipt_id=uuid.uuid4(),
            recovery_owner="recovery-worker",
            writer_generation=7,
            broker_read=broker_read,
        )
    )

    assert result.outcome == "not_found"
    assert result.error_code == "broker_order_absent"
    assert events == [
        "session_new",
        "session_enter",
        "acquire",
        "session_exit",
        "broker_read:client-order-101",
        "build_observation",
        "session_new",
        "session_enter",
        "record_observation",
        "session_exit",
        "session_new",
        "session_enter",
        "release",
        "session_exit",
    ]


def test_broker_read_failure_is_quarantined_and_released(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    acquisition = _acquired(_intent())
    _install_acquisition(monkeypatch, acquisition, events)
    _install_quarantine_hooks(monkeypatch, events)

    def broker_read(**_kwargs: object) -> object:
        raise worker.LinkedRecoveryBrokerReadError("broker unavailable")

    result = worker.recover_linked_submission(
        worker.LinkedRecoveryRequest(
            session_factory=_session_factory(events),
            receipt_id=uuid.uuid4(),
            recovery_owner="recovery-worker",
            writer_generation=7,
            broker_read=broker_read,
        )
    )

    assert result.outcome == "indeterminate"
    assert result.error_code == "broker_read_failed"
    assert events[-4:] == ["session_new", "session_enter", "release", "session_exit"]


@pytest.mark.parametrize(
    ("intent_overrides", "broker_overrides", "expected_reason"),
    [
        (
            {"qty": None, "notional": Decimal("100")},
            {"qty": None, "notional": "100"},
            "notional_submission_recovery_indeterminate",
        ),
        (
            {"order_class": "bracket"},
            {"order_class": "bracket"},
            "alpaca_recovery_request_terms_invalid",
        ),
        ({}, {"status": "unknown"}, "alpaca_recovery_broker_status_invalid"),
    ],
)
def test_unsafe_broker_read_is_indeterminate_without_materialization(
    monkeypatch: pytest.MonkeyPatch,
    intent_overrides: dict[str, object],
    broker_overrides: dict[str, object],
    expected_reason: str,
) -> None:
    events: list[str] = []
    intent = _intent(**intent_overrides)
    acquisition = _acquired(intent)
    _install_acquisition(monkeypatch, acquisition, events)
    _install_quarantine_hooks(monkeypatch, events)
    monkeypatch.setattr(
        worker,
        "materialize_validated_alpaca_recovery",
        lambda *_args, **_kwargs: pytest.fail("notional order was materialized"),
    )
    monkeypatch.setattr(
        worker,
        "settle_linked_submission_recovery",
        lambda *_args, **_kwargs: pytest.fail("indeterminate order was settled"),
    )

    result = worker.recover_linked_submission(
        worker.LinkedRecoveryRequest(
            session_factory=_session_factory(events),
            receipt_id=uuid.uuid4(),
            recovery_owner="recovery-worker",
            writer_generation=7,
            broker_read=lambda **_kwargs: _broker_order(**broker_overrides),
        )
    )

    assert result.outcome == "indeterminate"
    assert result.error_code == expected_reason
    assert "record_observation" in events
    assert "release" in events


def test_validated_order_materializes_before_paired_settlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    intent = _intent()
    acquisition = _acquired(intent)
    _install_acquisition(monkeypatch, acquisition, events)
    execution_id = uuid.UUID("00000000-0000-0000-0000-000000000202")
    terminal = SimpleNamespace()
    monkeypatch.setattr(
        worker,
        "materialize_validated_alpaca_recovery",
        lambda *_args, **_kwargs: (
            events.append("materialize") or SimpleNamespace(id=execution_id)
        ),
    )
    monkeypatch.setattr(
        worker,
        "build_linked_submission_recovery_settlement",
        lambda **_kwargs: events.append("build_settlement") or object(),
    )
    monkeypatch.setattr(
        worker,
        "settle_linked_submission_recovery",
        lambda *_args, **_kwargs: events.append("settle") or terminal,
    )

    result = worker.recover_linked_submission(
        worker.LinkedRecoveryRequest(
            session_factory=_session_factory(events),
            receipt_id=uuid.uuid4(),
            recovery_owner="recovery-worker",
            writer_generation=7,
            broker_read=lambda **_kwargs: _broker_order(),
        )
    )

    assert result.outcome == "reconciled"
    assert result.execution_id == execution_id
    assert result.terminal is terminal
    assert events == [
        "session_new",
        "session_enter",
        "acquire",
        "session_exit",
        "session_new",
        "session_enter",
        "materialize",
        "build_settlement",
        "settle",
        "session_exit",
    ]


def test_materialization_conflict_is_quarantined_without_settlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    intent = _intent()
    acquisition = _acquired(intent)
    _install_acquisition(monkeypatch, acquisition, events)
    _install_quarantine_hooks(monkeypatch, events)
    monkeypatch.setattr(
        worker,
        "materialize_validated_alpaca_recovery",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RecoveryMaterializationError("identity conflict")
        ),
    )
    monkeypatch.setattr(
        worker,
        "settle_linked_submission_recovery",
        lambda *_args, **_kwargs: pytest.fail("conflicted materialization was settled"),
    )

    result = worker.recover_linked_submission(
        worker.LinkedRecoveryRequest(
            session_factory=_session_factory(events),
            receipt_id=uuid.uuid4(),
            recovery_owner="recovery-worker",
            writer_generation=7,
            broker_read=lambda **_kwargs: _broker_order(),
        )
    )

    assert result.outcome == "indeterminate"
    assert result.error_code == "recovery_materialization_rejected"
    assert events[-4:] == ["session_new", "session_enter", "release", "session_exit"]
