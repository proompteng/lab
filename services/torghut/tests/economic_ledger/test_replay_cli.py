from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from scripts import replay_broker_economic_ledger as replay_cli
from tests.economic_ledger.test_tigerbeetle_parity import _flat_replay, _runs


def test_observation_and_publication_modes_are_mutually_exclusive() -> None:
    with pytest.raises(SystemExit):
        replay_cli._parse_args(
            [
                "--observe",
                "--publish-token",
                f"publish:{'a' * 64}",
            ]
        )


def test_default_mode_is_read_only_replay() -> None:
    args = replay_cli._parse_args([])

    assert args.observe is False
    assert args.publish_token is None
    assert args.source_consistency_timeout_seconds == 0


def test_tigerbeetle_parity_requires_observation_mode() -> None:
    with pytest.raises(SystemExit):
        replay_cli._parse_args(["--tigerbeetle-parity"])


def test_source_consistency_retry_requires_observation_mode() -> None:
    with pytest.raises(SystemExit):
        replay_cli._parse_args(["--source-consistency-timeout-seconds", "1"])


def test_source_consistency_retry_rejects_negative_timeout() -> None:
    with pytest.raises(SystemExit):
        replay_cli._parse_args(
            ["--observe", "--source-consistency-timeout-seconds", "-1"]
        )


@pytest.mark.parametrize(
    "reason",
    sorted(replay_cli._SOURCE_CONSISTENCY_RETRY_REASONS),
)
def test_observation_retries_only_source_consistency_races(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    reason: str,
) -> None:
    attempts = 0
    delays: list[float] = []

    def execute_attempt(
        *_args: object, **_kwargs: object
    ) -> tuple[dict[str, object], int]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise replay_cli.EconomicLedgerError(reason)
        return {"schema_version": "test-observation"}, 0

    monkeypatch.setattr(
        replay_cli,
        "TorghutAlpacaClient",
        lambda: SimpleNamespace(
            endpoint_class="paper",
            endpoint_url="https://paper-api.alpaca.markets",
        ),
    )
    monkeypatch.setattr(replay_cli, "_execute_attempt", execute_attempt)
    monkeypatch.setattr(replay_cli.time, "sleep", delays.append)
    monkeypatch.setattr(replay_cli, "BUILD_COMMIT", "a" * 40)
    monkeypatch.setattr(replay_cli, "BUILD_IMAGE_DIGEST", f"sha256:{'b' * 64}")

    assert (
        replay_cli.main(["--observe", "--source-consistency-timeout-seconds", "30"])
        == 0
    )

    captured = capsys.readouterr()
    retry_log = json.loads(captured.err)
    assert attempts == 2
    assert delays == [replay_cli._SOURCE_CONSISTENCY_RETRY_DELAY_SECONDS]
    assert retry_log["reason"] == reason
    assert retry_log["schema_version"] == (
        "torghut.broker-economic-source-retry-log.v1"
    )
    assert json.loads(captured.out)["schema_version"] == "test-observation"


def test_observation_does_not_retry_non_source_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0
    delays: list[float] = []

    def execute_attempt(
        *_args: object, **_kwargs: object
    ) -> tuple[dict[str, object], int]:
        nonlocal attempts
        attempts += 1
        raise replay_cli.EconomicLedgerError("tigerbeetle_economic_account_mismatch")

    monkeypatch.setattr(
        replay_cli,
        "TorghutAlpacaClient",
        lambda: SimpleNamespace(
            endpoint_class="paper",
            endpoint_url="https://paper-api.alpaca.markets",
        ),
    )
    monkeypatch.setattr(replay_cli, "_execute_attempt", execute_attempt)
    monkeypatch.setattr(replay_cli.time, "sleep", delays.append)
    monkeypatch.setattr(replay_cli, "BUILD_COMMIT", "a" * 40)
    monkeypatch.setattr(replay_cli, "BUILD_IMAGE_DIGEST", f"sha256:{'b' * 64}")

    with pytest.raises(
        replay_cli.EconomicLedgerError,
        match="tigerbeetle_economic_account_mismatch",
    ):
        replay_cli.main(["--observe", "--source-consistency-timeout-seconds", "30"])

    assert attempts == 1
    assert delays == []


def test_observation_source_retry_timeout_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0
    monotonic_values = iter((10.0, 11.0))

    def execute_attempt(
        *_args: object, **_kwargs: object
    ) -> tuple[dict[str, object], int]:
        nonlocal attempts
        attempts += 1
        raise replay_cli.EconomicLedgerError("economic_ledger_source_cursor_incomplete")

    monkeypatch.setattr(
        replay_cli,
        "TorghutAlpacaClient",
        lambda: SimpleNamespace(
            endpoint_class="paper",
            endpoint_url="https://paper-api.alpaca.markets",
        ),
    )
    monkeypatch.setattr(replay_cli, "_execute_attempt", execute_attempt)
    monkeypatch.setattr(replay_cli.time, "monotonic", lambda: next(monotonic_values))
    monkeypatch.setattr(replay_cli, "BUILD_COMMIT", "a" * 40)
    monkeypatch.setattr(replay_cli, "BUILD_IMAGE_DIGEST", f"sha256:{'b' * 64}")

    with pytest.raises(
        replay_cli.EconomicLedgerError,
        match="economic_ledger_source_cursor_incomplete",
    ):
        replay_cli.main(["--observe", "--source-consistency-timeout-seconds", "1"])

    assert attempts == 1


def test_observation_log_excludes_token_scope_and_broker_economics() -> None:
    replay = _flat_replay()
    observation = SimpleNamespace(
        observation_id=uuid.uuid4(),
        runs=_runs(replay),
        result=SimpleNamespace(
            payload={
                "reason_codes": [],
                "economics": {"broker": {"cash": "sensitive"}},
                "tigerbeetle_economic_parity": {
                    "parity": True,
                    "expected": {"transfer_count": 4},
                },
            },
            open_order_count=0,
            reconciled=True,
            residual_count=0,
            result_sha256="e" * 64,
            source_age_seconds=1,
        ),
    )

    payload = replay_cli._observation_output(replay, observation)
    encoded = json.dumps(payload, sort_keys=True)

    assert "publish:" not in encoded
    assert _flat_replay().snapshot.prepared.scope.account_label not in encoded
    assert "sensitive" not in encoded
    assert "economics" not in encoded


def test_parity_observation_closes_client_persists_evidence_and_exits_nonzero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    replay = _flat_replay()
    runs = _runs(replay)
    broker_snapshot = SimpleNamespace(
        observed_at=datetime(2026, 7, 16, 14, 2, tzinfo=timezone.utc)
    )
    parity = SimpleNamespace(
        parity=False,
        payload={"schema_version": "test-parity", "parity": False},
    )
    persisted_kwargs: dict[str, object] = {}

    class Transaction:
        def __enter__(self) -> None:
            return None

        def __exit__(self, *_args: object) -> None:
            return None

    class Session:
        def __enter__(self) -> Session:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def begin(self) -> Transaction:
            return Transaction()

    class TigerBeetleClient:
        closed = False

        def close(self) -> None:
            self.closed = True

    tigerbeetle_client = TigerBeetleClient()
    observation = SimpleNamespace(
        observation_id=uuid.uuid4(),
        runs=runs,
        result=SimpleNamespace(
            payload={
                "reason_codes": ["tigerbeetle_economic_transfer_missing"],
                "tigerbeetle_economic_parity": parity.payload,
            },
            open_order_count=0,
            reconciled=False,
            residual_count=1,
            result_sha256="e" * 64,
            source_age_seconds=1,
        ),
    )

    def persist(*_args: object, **kwargs: object) -> SimpleNamespace:
        persisted_kwargs.update(kwargs)
        return observation

    monkeypatch.setattr(
        replay_cli,
        "TorghutAlpacaClient",
        lambda: SimpleNamespace(
            endpoint_class="paper",
            endpoint_url="https://paper-api.alpaca.markets",
        ),
    )
    monkeypatch.setattr(
        replay_cli, "capture_broker_economic_snapshot", lambda *_: broker_snapshot
    )
    monkeypatch.setattr(replay_cli, "SessionLocal", Session)
    monkeypatch.setattr(
        replay_cli,
        "load_broker_economic_ledger_source_rows",
        lambda *_args, **_kwargs: object(),
    )
    monkeypatch.setattr(
        replay_cli,
        "prepare_broker_economic_ledger_snapshot",
        lambda *_: replay.snapshot,
    )
    monkeypatch.setattr(
        replay_cli,
        "replay_broker_economic_ledger_snapshot",
        lambda *_: replay,
    )
    monkeypatch.setattr(
        replay_cli,
        "require_published_broker_economic_ledger_runs",
        lambda *_args, **_kwargs: runs,
    )
    monkeypatch.setattr(
        replay_cli,
        "create_tigerbeetle_client",
        lambda *_: tigerbeetle_client,
    )
    monkeypatch.setattr(
        replay_cli,
        "audit_broker_economic_tigerbeetle_parity",
        lambda *_args, **_kwargs: parity,
    )
    monkeypatch.setattr(
        replay_cli,
        "persist_broker_economic_ledger_reconciliation",
        persist,
    )
    monkeypatch.setattr(replay_cli, "BUILD_COMMIT", "a" * 40)
    monkeypatch.setattr(replay_cli, "BUILD_IMAGE_DIGEST", f"sha256:{'b' * 64}")
    monkeypatch.setattr(replay_cli.settings, "tigerbeetle_enabled", True)
    monkeypatch.setattr(replay_cli.settings, "tigerbeetle_cluster_id", 2001)

    assert replay_cli.main(["--observe", "--tigerbeetle-parity"]) == 1
    assert tigerbeetle_client.closed is True
    assert persisted_kwargs["tigerbeetle_parity"] is parity
    assert "tigerbeetle_cluster_id" not in persisted_kwargs


def test_dry_run_closes_database_transaction_before_preparation_and_reduction(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    events: list[str] = []

    class Transaction:
        def __init__(self, session: Session) -> None:
            self._session = session

        def __enter__(self) -> None:
            events.append("transaction_enter")
            self._session.transaction_active = True

        def __exit__(self, *_args: object) -> None:
            self._session.transaction_active = False
            events.append("transaction_exit")

    class Session:
        transaction_active = False

        def __enter__(self) -> Session:
            events.append("session_enter")
            return self

        def __exit__(self, *_args: object) -> None:
            events.append("session_exit")

        def begin(self) -> Transaction:
            return Transaction(self)

    session = Session()
    source_rows = object()
    ledger_snapshot = object()

    def load_source_rows(loaded_session: Session, **_kwargs: object) -> object:
        assert loaded_session is session
        assert loaded_session.transaction_active is True
        events.append("load_source_rows")
        return source_rows

    def prepare_snapshot(loaded_source_rows: object) -> object:
        assert loaded_source_rows is source_rows
        assert session.transaction_active is False
        events.append("prepare_snapshot")
        return ledger_snapshot

    def reduce_snapshot(loaded_snapshot: object) -> SimpleNamespace:
        assert loaded_snapshot is ledger_snapshot
        assert session.transaction_active is False
        events.append("reduce_snapshot")
        return SimpleNamespace(
            to_payload=lambda **_kwargs: {"schema_version": "test-replay"}
        )

    monkeypatch.setattr(
        replay_cli,
        "TorghutAlpacaClient",
        lambda: SimpleNamespace(
            endpoint_class="paper",
            endpoint_url="https://paper-api.alpaca.markets",
        ),
    )
    monkeypatch.setattr(replay_cli, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        replay_cli, "load_broker_economic_ledger_source_rows", load_source_rows
    )
    monkeypatch.setattr(
        replay_cli, "prepare_broker_economic_ledger_snapshot", prepare_snapshot
    )
    monkeypatch.setattr(
        replay_cli, "replay_broker_economic_ledger_snapshot", reduce_snapshot
    )

    assert replay_cli.main([]) == 0
    assert events == [
        "session_enter",
        "transaction_enter",
        "load_source_rows",
        "transaction_exit",
        "session_exit",
        "prepare_snapshot",
        "reduce_snapshot",
    ]
    assert '"schema_version":"test-replay"' in capsys.readouterr().out
