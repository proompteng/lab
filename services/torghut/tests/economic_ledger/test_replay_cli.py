from __future__ import annotations

from types import SimpleNamespace

import pytest

from scripts import replay_broker_economic_ledger as replay_cli


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
