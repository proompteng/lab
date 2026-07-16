from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import cast

import pytest
from sqlalchemy import Table, create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, BrokerAccountActivity, BrokerAccountActivityCursor
from app.trading.broker_account_activity_backfill import (
    AlpacaAccountActivitiesClient,
    BrokerAccountActivityIngestor,
)
from app.trading.broker_account_activities import (
    BrokerAccountActivityContradiction,
    BrokerAccountActivityError,
    BrokerAccountActivityPayloadError,
    BrokerActivityObservation,
    BrokerStreamPosition,
    compare_broker_fill_sources,
    load_broker_account_activity_status,
    normalize_broker_account_activity,
    normalize_broker_trade_update,
    persist_broker_trade_update,
)


def _fill(activity_id: str, *, price: str = "100.25") -> dict[str, object]:
    return {
        "activity_type": "FILL",
        "cum_qty": "2",
        "id": activity_id,
        "leaves_qty": "0",
        "order_id": f"order-{activity_id}",
        "price": price,
        "qty": "1",
        "side": "buy",
        "symbol": "AAPL",
        "transaction_time": "2026-07-15T18:07:02.759Z",
        "type": "fill",
    }


def _observation(observed_at: datetime) -> BrokerActivityObservation:
    return BrokerActivityObservation(
        environment="paper",
        account_label="paper-account",
        endpoint_fingerprint="a" * 64,
        observed_at=observed_at,
    )


def _stream_position(offset: int) -> BrokerStreamPosition:
    return BrokerStreamPosition(
        topic="torghut.trade-updates.v2",
        partition=0,
        offset=offset,
    )


class _Clock:
    def __init__(self) -> None:
        self.value = datetime(2026, 7, 16, 1, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        current = self.value
        self.value += timedelta(seconds=1)
        return current


def _session_factory() -> sessionmaker[Session]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            cast(Table, BrokerAccountActivity.__table__),
            cast(Table, BrokerAccountActivityCursor.__table__),
        ],
    )
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def test_client_uses_last_full_page_id_as_exclusive_page_token() -> None:
    calls: list[dict[str, object]] = []
    payload = [_fill(f"activity-{index:03d}") for index in range(100)]

    def get_json(**kwargs: object) -> object:
        calls.append(kwargs)
        return payload

    client = AlpacaAccountActivitiesClient(
        api_key="key",
        secret_key="secret",
        endpoint_url="https://paper-api.alpaca.markets/v2",
        get_json=get_json,
    )
    page = client.list_page(
        after=datetime(2026, 7, 14, tzinfo=timezone.utc),
        until=datetime(2026, 7, 16, tzinfo=timezone.utc),
        page_token="activity-before",
    )

    assert page.next_page_token == "activity-099"
    assert page.request_page_token == "activity-before"
    assert len(page.activities) == 100
    assert calls[0]["url"] == ("https://paper-api.alpaca.markets/v2/account/activities")
    params = calls[0]["params"]
    assert isinstance(params, Mapping)
    assert params == {
        "after": "2026-07-14T00:00:00Z",
        "until": "2026-07-16T00:00:00Z",
        "direction": "asc",
        "page_size": 100,
        "page_token": "activity-before",
    }


def test_client_rejects_untrusted_rows_before_cursor_advance() -> None:
    def get_invalid_page(**_: object) -> object:
        return [{"activity_type": "FILL"}]

    client = AlpacaAccountActivitiesClient(
        api_key="key",
        secret_key="secret",
        endpoint_url="https://paper-api.alpaca.markets",
        get_json=get_invalid_page,
    )

    with pytest.raises(
        BrokerAccountActivityPayloadError,
        match="broker_account_activity_id_invalid",
    ):
        client.list_page(
            after=datetime(2026, 7, 14, tzinfo=timezone.utc),
            until=datetime(2026, 7, 16, tzinfo=timezone.utc),
            page_token=None,
        )


def test_normalization_preserves_nontrade_economic_fields_and_hash() -> None:
    payload = {
        "activity_type": "DIV",
        "currency": "USD",
        "date": "2026-07-15",
        "id": "activity-dividend",
        "net_amount": "1.02",
        "qty": "2",
        "symbol": "T",
    }
    row = normalize_broker_account_activity(
        payload,
        observation=_observation(datetime(2026, 7, 16, tzinfo=timezone.utc)),
        source_page_token=None,
    )

    assert row.activity_type == "DIV"
    assert str(row.net_amount) == "1.02"
    assert row.settle_date is not None
    assert row.settle_date.isoformat() == "2026-07-15"
    assert row.raw_payload == payload
    assert len(row.raw_payload_sha256) == 64
    assert len(row.normalized_economic_sha256) == 64


def test_stream_and_backfill_fill_share_one_normalized_economic_hash() -> None:
    observed_at = datetime(2026, 7, 16, tzinfo=timezone.utc)
    rest_payload = _fill("activity-fill")
    rest_payload["transaction_time"] = "2026-07-16T11:50:40.401907Z"
    rest = normalize_broker_account_activity(
        rest_payload,
        observation=_observation(observed_at),
        source_page_token=None,
    )
    stream = normalize_broker_trade_update(
        {
            "channel": "trade_updates",
            "ingestTs": "2026-07-15T18:07:03Z",
            "payload": {
                "event": "fill",
                "execution_id": "execution-fill",
                "order": {
                    "client_order_id": "client-fill",
                    "filled_qty": "2",
                    "id": "order-activity-fill",
                    "qty": "2",
                    "side": "buy",
                    "symbol": "AAPL",
                },
                "price": "100.25",
                "qty": "1",
                "timestamp": "2026-07-16T11:50:40.401906528Z",
            },
        },
        event_fingerprint="b" * 64,
        observation=_observation(observed_at),
        position=BrokerStreamPosition(
            topic="torghut.trade-updates.v2",
            partition=1,
            offset=42,
        ),
    )

    assert (
        rest.event_at
        == stream.event_at
        == datetime(
            2026,
            7,
            16,
            11,
            50,
            40,
            401907,
            tzinfo=timezone.utc,
        )
    )
    assert rest.normalized_economic_sha256 == stream.normalized_economic_sha256
    assert rest.raw_payload_sha256 != stream.raw_payload_sha256
    assert stream.raw_payload.get("ingestTs") is None
    assert (stream.source_topic, stream.source_partition, stream.source_offset) == (
        "torghut.trade-updates.v2",
        1,
        42,
    )


def test_stream_fact_replay_deduplicates_and_changed_payload_is_contradiction() -> None:
    sessions = _session_factory()
    raw_event = {
        "seq": 1,
        "stream": "trade_updates",
        "data": {
            "event": "partial_fill",
            "event_id": "stream-event-1",
            "order": {
                "filled_qty": "1",
                "id": "order-1",
                "qty": "2",
                "side": "buy",
                "symbol": "AAPL",
            },
            "price": "100",
            "qty": "1",
            "timestamp": "2026-07-15T18:07:02.759Z",
        },
    }
    observation = _observation(datetime(2026, 7, 16, tzinfo=timezone.utc))
    with sessions.begin() as session:
        _, first_duplicate = persist_broker_trade_update(
            session,
            raw_event,
            event_fingerprint="c" * 64,
            observation=observation,
            position=_stream_position(10),
        )
        _, replay_duplicate = persist_broker_trade_update(
            session,
            {**raw_event, "seq": 2},
            event_fingerprint="d" * 64,
            observation=observation,
            position=_stream_position(11),
        )
    assert first_duplicate is False
    assert replay_duplicate is True

    changed = cast(dict[str, object], raw_event["data"]).copy()
    changed["price"] = "101"
    with sessions.begin() as session:
        with pytest.raises(
            BrokerAccountActivityContradiction,
            match="broker_trade_update_payload_changed",
        ):
            persist_broker_trade_update(
                session,
                {"stream": "trade_updates", "data": changed},
                event_fingerprint="e" * 64,
                observation=observation,
                position=_stream_position(12),
            )

    with sessions() as session:
        assert session.scalar(select(func.count(BrokerAccountActivity.id))) == 1


def test_source_comparison_requires_nonempty_equal_fill_multisets() -> None:
    sessions = _session_factory()
    observed_at = datetime(2026, 7, 16, tzinfo=timezone.utc)
    rest = normalize_broker_account_activity(
        _fill("activity-fill"),
        observation=_observation(observed_at),
        source_page_token=None,
    )
    stream = normalize_broker_trade_update(
        {
            "stream": "trade_updates",
            "data": {
                "event": "fill",
                "order": {
                    "filled_qty": "2",
                    "id": "order-activity-fill",
                    "qty": "2",
                    "side": "buy",
                    "symbol": "AAPL",
                },
                "price": "100.25",
                "qty": "1",
                "timestamp": "2026-07-15T18:07:02.759Z",
            },
        },
        event_fingerprint="d" * 64,
        observation=_observation(observed_at),
        position=_stream_position(100),
    )
    with sessions.begin() as session:
        session.add_all((rest, stream))
    with sessions() as session:
        comparison = compare_broker_fill_sources(
            session,
            account_label="paper-account",
            environment="paper",
            window_start=datetime(2026, 7, 15, 18, tzinfo=timezone.utc),
            window_end=datetime(2026, 7, 15, 19, tzinfo=timezone.utc),
        )
        empty = compare_broker_fill_sources(
            session,
            account_label="paper-account",
            environment="paper",
            window_start=datetime(2026, 7, 14, tzinfo=timezone.utc),
            window_end=datetime(2026, 7, 15, tzinfo=timezone.utc),
        )

    assert comparison["proof_complete"] is True
    assert comparison["rest_fill_count"] == 1
    assert comparison["stream_fill_count"] == 1
    assert (
        comparison["rest_normalized_multiset_sha256"]
        == (comparison["stream_normalized_multiset_sha256"])
    )
    assert empty["equivalent"] is True
    assert empty["proof_complete"] is False


@pytest.mark.parametrize(
    ("payload", "expected_type", "expected_correction", "expected_net_amount"),
    [
        (
            {
                "activity_type": "FILL",
                "id": "correction-1",
                "order_id": "order-1",
                "previous_id": "fill-1",
                "price": "99.5",
                "qty": "1",
                "side": "buy",
                "symbol": "AAPL",
                "transaction_time": "2026-07-15T18:07:02.759Z",
                "type": "trade_correct",
            },
            "FILL",
            "fill-1",
            None,
        ),
        (
            {
                "activity_type": "SSP",
                "date": "2026-07-15",
                "id": "split-1",
                "qty": "4",
                "symbol": "AAPL",
            },
            "SSP",
            None,
            None,
        ),
        (
            {
                "activity_type": "DIV",
                "date": "2026-07-15",
                "id": "dividend-1",
                "net_amount": "12.34",
                "qty": "4",
                "symbol": "AAPL",
            },
            "DIV",
            None,
            "12.34",
        ),
        (
            {
                "activity_type": "FEE",
                "currency": "USD",
                "date": "2026-07-15",
                "id": "fee-1",
                "net_amount": "-0.10",
            },
            "FEE",
            None,
            "-0.10",
        ),
        (
            {
                "activity_type": "CSD",
                "currency": "USD",
                "date": "2026-07-15",
                "id": "cash-deposit-1",
                "net_amount": "100.00",
            },
            "CSD",
            None,
            "100.00",
        ),
    ],
)
def test_backfill_preserves_corrections_splits_and_dividends(
    payload: dict[str, object],
    expected_type: str,
    expected_correction: str | None,
    expected_net_amount: str | None,
) -> None:
    row = normalize_broker_account_activity(
        payload,
        observation=_observation(datetime(2026, 7, 16, tzinfo=timezone.utc)),
        source_page_token=None,
    )

    assert row.activity_type == expected_type
    assert row.correction_of_external_id == expected_correction
    assert (
        str(row.net_amount) if row.net_amount is not None else None
    ) == expected_net_amount
    assert row.raw_payload == payload


def test_ingestor_drains_bounded_pages_then_deduplicates_overlap() -> None:
    pages: list[object] = [
        [_fill(f"activity-{index:03d}") for index in range(100)],
        [_fill("activity-100")],
        [_fill("activity-100")],
    ]
    requested_tokens: list[object] = []

    def get_json(**kwargs: object) -> object:
        params = kwargs["params"]
        assert isinstance(params, Mapping)
        requested_tokens.append(cast(Mapping[str, object], params).get("page_token"))
        return pages.pop(0)

    client = AlpacaAccountActivitiesClient(
        api_key="key",
        secret_key="secret",
        endpoint_url="https://paper-api.alpaca.markets",
        get_json=get_json,
    )
    sessions = _session_factory()
    ingestor = BrokerAccountActivityIngestor(
        client=client,
        session_factory=sessions,
        account_label="paper-account",
        now=_Clock(),
    )

    with pytest.raises(
        ValueError,
        match="broker_account_activity_max_pages_invalid",
    ):
        ingestor.ingest_batch(max_pages=0)

    first = ingestor.ingest_batch(max_pages=2)
    third = ingestor.ingest_once()

    assert (first.seen, first.inserted, first.complete) == (101, 101, True)
    assert (third.inserted, third.duplicates, third.complete) == (0, 1, True)
    assert requested_tokens == [None, "activity-099", None]
    with sessions() as session:
        assert session.scalar(select(func.count(BrokerAccountActivity.id))) == 101
        cursor = session.scalar(select(BrokerAccountActivityCursor))
        assert cursor is not None
        assert cursor.status == "complete"
        assert cursor.next_page_token is None
        assert cursor.pages_processed == 3
        assert cursor.activities_seen == 102
        assert cursor.activities_inserted == 101


def test_changed_payload_for_same_activity_is_hard_contradiction() -> None:
    pages: list[object] = [
        [_fill("activity-001")],
        [_fill("activity-001", price="101.00")],
    ]

    def get_json(**_: object) -> object:
        return pages.pop(0)

    client = AlpacaAccountActivitiesClient(
        api_key="key",
        secret_key="secret",
        endpoint_url="https://paper-api.alpaca.markets",
        get_json=get_json,
    )
    sessions = _session_factory()
    ingestor = BrokerAccountActivityIngestor(
        client=client,
        session_factory=sessions,
        account_label="paper-account",
        now=_Clock(),
    )
    ingestor.ingest_once()

    with pytest.raises(
        BrokerAccountActivityContradiction,
        match="broker_account_activity_payload_changed:activity-001",
    ):
        ingestor.ingest_once()

    with sessions() as session:
        stored = session.scalar(select(BrokerAccountActivity))
        cursor = session.scalar(select(BrokerAccountActivityCursor))
        assert stored is not None
        assert str(stored.price) == "100.250000000000000000"
        assert cursor is not None
        assert cursor.status == "error"
        assert cursor.activities_seen == 1
        assert cursor.activities_inserted == 1


def test_failed_request_retries_the_same_durable_scan_window() -> None:
    calls: list[dict[str, object]] = []

    def get_json(**kwargs: object) -> object:
        params = kwargs["params"]
        assert isinstance(params, Mapping)
        calls.append(dict(cast(Mapping[str, object], params)))
        if len(calls) == 1:
            raise BrokerAccountActivityError("injected_transport_failure")
        return [_fill("activity-recovered")]

    sessions = _session_factory()
    ingestor = BrokerAccountActivityIngestor(
        client=AlpacaAccountActivitiesClient(
            api_key="key",
            secret_key="secret",
            endpoint_url="https://paper-api.alpaca.markets",
            get_json=get_json,
        ),
        session_factory=sessions,
        account_label="paper-account",
        now=_Clock(),
    )

    with pytest.raises(BrokerAccountActivityError, match="injected_transport_failure"):
        ingestor.ingest_once()
    with sessions() as session:
        failed = session.scalar(select(BrokerAccountActivityCursor))
        assert failed is not None
        assert failed.status == "error"
        assert failed.next_page_token is None

    recovered = ingestor.ingest_once()

    assert recovered.complete is True
    assert recovered.inserted == 1
    assert calls[0] == calls[1]


def test_status_distinguishes_complete_fresh_cursor_from_stale_source() -> None:
    pages: list[object] = [[_fill("activity-001")]]
    clock = _Clock()

    def get_json(**_: object) -> object:
        return pages.pop(0)

    client = AlpacaAccountActivitiesClient(
        api_key="key",
        secret_key="secret",
        endpoint_url="https://paper-api.alpaca.markets",
        get_json=get_json,
    )
    sessions = _session_factory()
    BrokerAccountActivityIngestor(
        client=client,
        session_factory=sessions,
        account_label="paper-account",
        now=clock,
    ).ingest_once()

    with sessions() as session:
        current = load_broker_account_activity_status(
            session,
            account_label="paper-account",
            environment="paper",
            observed_at=clock.value,
        )
        stale = load_broker_account_activity_status(
            session,
            account_label="paper-account",
            environment="paper",
            observed_at=clock.value + timedelta(seconds=61),
        )

    assert current["state"] == "current"
    assert current["current"] is True
    assert current["activities_inserted"] == 1
    assert stale["current"] is False
    assert stale["reason_codes"] == ["broker_account_activity_cursor_stale"]
