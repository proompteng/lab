"""Snapshot enrichment service for the options lane."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import logging
import threading
from datetime import datetime, timedelta
from typing import Any

from fastapi import FastAPI, HTTPException

from .alpaca import AlpacaApiError, AlpacaOptionsClient, normalize_snapshot_record
from .kafka import OptionsKafkaProducer, SequenceGenerator, build_envelope
from .options_status import build_status_payload
from .repository import OptionsRepository
from .session import session_state, utc_now
from .settings import get_options_lane_settings

logger = logging.getLogger(__name__)

settings = get_options_lane_settings()


class _EnricherState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.last_success_ts: str | None = None
        self.last_error_code: str | None = None
        self.last_error_detail: str | None = None
        self.ready = False
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def set_success(self, at: str) -> None:
        with self._lock:
            self.last_success_ts = at
            self.last_error_code = None
            self.last_error_detail = None
            self.ready = True

    def set_error(self, code: str, detail: str) -> None:
        with self._lock:
            self.last_error_code = code
            self.last_error_detail = detail

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "last_success_ts": self.last_success_ts,
                "last_error_code": self.last_error_code,
                "last_error_detail": self.last_error_detail,
                "ready": self.ready,
            }


_state = _EnricherState()
_seq = SequenceGenerator()
_repository = OptionsRepository(settings.sqlalchemy_dsn)
_repository.ensure_rate_bucket_defaults({"contracts": (0.25, 2), "snapshots_hot": (1.0, 10), "snapshots_cold": (0.25, 5), "bars_backfill": (0.25, 2)})
_producer = OptionsKafkaProducer(
    bootstrap_servers=settings.kafka_bootstrap,
    security_protocol=settings.kafka_security_protocol,
    sasl_mechanism=settings.kafka_sasl_mechanism,
    sasl_username=settings.kafka_sasl_user,
    sasl_password=settings.kafka_sasl_password,
    linger_ms=settings.kafka_linger_ms,
    batch_size=settings.kafka_batch_size,
    request_timeout_ms=settings.kafka_request_timeout_ms,
)
_client = AlpacaOptionsClient(
    key_id=settings.alpaca_key_id,
    secret_key=settings.alpaca_secret_key,
    base_url=settings.alpaca_base_url,
    feed=settings.alpaca_feed,
)


def _publish_snapshot(*, symbol: str, payload: dict[str, Any], observed_at: datetime) -> None:
    envelope = build_envelope(
        feed=settings.alpaca_feed,
        channel="snapshot",
        symbol=symbol,
        seq=_seq.next(),
        payload=payload,
        event_ts=observed_at,
        ingest_ts=observed_at,
        source="rest",
    )
    _producer.send(settings.topic_snapshots, symbol, envelope)


def _publish_status(*, status_value: str, observed_at: datetime, error_code: str | None = None, error_detail: str | None = None, backlog: int | None = None) -> None:
    payload = build_status_payload(
        component="enricher",
        status=status_value,
        session_value=session_state(observed_at, settings.holiday_set),
        last_success_ts=_state.snapshot()["last_success_ts"],
        active_contracts=_repository.count_active_contracts(),
        hot_contracts=_repository.count_hot_contracts(),
        rest_backlog=backlog,
        error_code=error_code,
        error_detail=error_detail,
    )
    envelope = build_envelope(
        feed=settings.alpaca_feed,
        channel="status",
        symbol="enricher",
        seq=_seq.next(),
        payload=payload,
        event_ts=observed_at,
        ingest_ts=observed_at,
        source="rest",
    )
    _producer.send(settings.topic_status, "enricher", envelope)


def _ranking_inputs_from_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    trade_recency_score = 1.0 if payload.get("latest_trade_ts") else 0.2
    quote_recency_score = 1.0 if payload.get("latest_quote_ts") else 0.2
    liquidity_score = 0.5
    if payload.get("latest_bid_size") and payload.get("latest_ask_size"):
        total_size = float(payload["latest_bid_size"]) + float(payload["latest_ask_size"])
        liquidity_score = min(total_size / 1000.0, 1.0)
    return {
        "trade_recency_score": trade_recency_score,
        "quote_recency_score": quote_recency_score,
        "liquidity_score": liquidity_score,
    }


def _process_tier(*, tier: str, interval_sec: int, bucket_name: str) -> int:
    due_rows = _repository.get_due_snapshot_contracts(
        tier=tier,
        stale_after=timedelta(seconds=interval_sec),
        limit=settings.options_snapshot_batch_size,
    )
    if not due_rows:
        return 0
    if not _repository.acquire_rate_bucket(
        bucket_name,
        1.0 if bucket_name == "snapshots_hot" else 0.25,
        10 if bucket_name == "snapshots_hot" else 5,
    ):
        return len(due_rows)

    symbols = [str(row["contract_symbol"]) for row in due_rows]
    metadata = _repository.fetch_contract_metadata(symbols)
    snapshots = _client.get_snapshots(symbols)
    observed_at = utc_now()
    for symbol in symbols:
        contract = metadata.get(symbol)
        if contract is None:
            continue
        raw_snapshot = snapshots.get(symbol)
        if raw_snapshot is None:
            continue
        payload = normalize_snapshot_record(
            symbol,
            raw_snapshot,
            underlying_symbol=str(contract["underlying_symbol"]),
            snapshot_class=tier,
        )
        _publish_snapshot(symbol=symbol, payload=payload, observed_at=observed_at)
        _repository.record_snapshot_success(
            contract_symbol=symbol,
            snapshot_class=tier,
            observed_at=observed_at,
            ranking_inputs=_ranking_inputs_from_snapshot(payload),
        )
    return 0


def _enricher_loop() -> None:
    while not _state.stop_event.is_set():
        try:
            hot_backlog = _process_tier(
                tier="hot",
                interval_sec=settings.options_snapshot_hot_interval_sec,
                bucket_name="snapshots_hot",
            )
            warm_backlog = _process_tier(
                tier="warm",
                interval_sec=settings.options_snapshot_warm_interval_sec,
                bucket_name="snapshots_cold",
            )
            cold_backlog = _process_tier(
                tier="cold",
                interval_sec=settings.options_snapshot_cold_interval_sec,
                bucket_name="snapshots_cold",
            )
            observed_at = utc_now()
            _publish_status(
                status_value="ok",
                observed_at=observed_at,
                backlog=hot_backlog + warm_backlog + cold_backlog,
            )
            _producer.flush()
            _state.set_success(observed_at.isoformat())
        except AlpacaApiError as exc:
            logger.exception("options enricher failed")
            _state.set_error(str(exc.status_code), exc.body[:200])
            if exc.status_code == 429:
                _repository.halve_rate_bucket("snapshots_hot")
                _repository.halve_rate_bucket("snapshots_cold")
            _publish_status(
                status_value="blocked" if exc.status_code in {405, 406, 410, 412, 413, 429} else "degraded",
                observed_at=utc_now(),
                error_code=str(exc.status_code or "alpaca_api_error"),
                error_detail=exc.body[:200],
            )
        except Exception as exc:
            logger.exception("options enricher failed")
            _state.set_error("snapshot_cycle_failed", str(exc))
            _publish_status(
                status_value="degraded",
                observed_at=utc_now(),
                error_code="snapshot_cycle_failed",
                error_detail=str(exc)[:200],
            )
        finally:
            _producer.flush()
        _state.stop_event.wait(5)


def _start_worker() -> None:
    if _state.thread is not None:
        return
    _state.thread = threading.Thread(target=_enricher_loop, name="options-enricher", daemon=True)
    _state.thread.start()


def _stop_worker() -> None:
    _state.stop_event.set()
    if _state.thread is not None:
        _state.thread.join(timeout=10)
    _producer.close()
    _repository.close()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    _start_worker()
    try:
        yield
    finally:
        _stop_worker()


app = FastAPI(title="torghut-options-enricher", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"status": "ok", **_state.snapshot()}


@app.get("/readyz")
def readyz() -> dict[str, Any]:
    snapshot = _state.snapshot()
    if not snapshot["ready"]:
        raise HTTPException(status_code=503, detail=snapshot)
    return {"status": "ready", **snapshot}
