"""Contract discovery and hot-set service for the options lane."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import logging
import threading
from datetime import datetime, timedelta
from time import monotonic
from typing import Any, cast

from fastapi import FastAPI, HTTPException

from .alpaca import AlpacaApiError, AlpacaOptionsClient, normalize_contract_record
from .catalog_watermark_repository import CatalogCycleSummary
from .kafka import OptionsKafkaProducer, SequenceGenerator, build_envelope
from .options_status import build_status_payload
from .repository import (
    OptionsRepository,
    merge_top_ranked_contract_rows,
    subscription_tier_limits,
    top_ranked_contract_rows,
)
from .session import session_state, utc_now
from .settings import get_options_lane_settings
from .subscription_reconciliation import (
    ProtectedSubscriptionSeed,
    plan_provisional_subscription_reconciliation,
)

logger = logging.getLogger("uvicorn.error")

settings = get_options_lane_settings()
PROVISIONAL_SUBSCRIPTION_FLUSH_PAGES = 10
PROVISIONAL_SUBSCRIPTION_FLUSH_SECONDS = 30.0


class _CatalogState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.last_success_ts: str | None = None
        self.last_error_code: str | None = None
        self.last_error_detail: str | None = None
        self.ready = False
        self.subscription_reconciliations_total = 0
        self.subscription_rows_changed_total = 0
        self.subscription_rows_deactivated_total = 0
        self.last_subscription_reconcile_ts: str | None = None
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def set_success(self, at: str) -> None:
        with self._lock:
            self.last_success_ts = at
            self.last_error_code = None
            self.last_error_detail = None
            self.ready = True

    def set_ready(self) -> None:
        with self._lock:
            self.ready = True

    def set_error(self, code: str, detail: str) -> None:
        with self._lock:
            self.last_error_code = code
            self.last_error_detail = detail

    def record_subscription_reconciliation(
        self, *, changed_count: int, deactivated_count: int, observed_at: datetime
    ) -> None:
        with self._lock:
            self.subscription_reconciliations_total += 1
            self.subscription_rows_changed_total += max(changed_count, 0)
            self.subscription_rows_deactivated_total += max(deactivated_count, 0)
            self.last_subscription_reconcile_ts = observed_at.isoformat()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "last_success_ts": self.last_success_ts,
                "last_error_code": self.last_error_code,
                "last_error_detail": self.last_error_detail,
                "ready": self.ready,
                "subscription_reconciliations_total": self.subscription_reconciliations_total,
                "subscription_rows_changed_total": self.subscription_rows_changed_total,
                "subscription_rows_deactivated_total": self.subscription_rows_deactivated_total,
                "last_subscription_reconcile_ts": self.last_subscription_reconcile_ts,
            }


_state = _CatalogState()
_seq = SequenceGenerator()
_repository = OptionsRepository(settings.sqlalchemy_dsn)
_repository.ensure_rate_bucket_defaults(
    {
        "contracts": (1.0, 4),
        "snapshots_hot": (1.0, 10),
        "snapshots_cold": (0.25, 5),
        "bars_backfill": (0.25, 2),
    }
)
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
    contracts_base_url=settings.alpaca_contracts_base_url,
    data_base_url=settings.alpaca_data_base_url,
    feed=settings.alpaca_feed,
)


def _publish_contract_row(contract: dict[str, Any], *, observed_at: datetime) -> None:
    payload = {
        "contract_id": contract["contract_id"],
        "contract_symbol": contract["contract_symbol"],
        "name": contract.get("name"),
        "status": contract["status"],
        "tradable": bool(contract["tradable"]),
        "expiration_date": contract["expiration_date"],
        "root_symbol": contract["root_symbol"],
        "underlying_symbol": contract["underlying_symbol"],
        "underlying_asset_id": contract.get("underlying_asset_id"),
        "option_type": contract["option_type"],
        "style": contract["style"],
        "strike_price": contract["strike_price"],
        "contract_size": contract["contract_size"],
        "open_interest": contract.get("open_interest"),
        "open_interest_date": contract.get("open_interest_date"),
        "close_price": contract.get("close_price"),
        "close_price_date": contract.get("close_price_date"),
        "first_seen_ts": contract["first_seen_ts"],
        "last_seen_ts": contract["last_seen_ts"],
        "provider_updated_ts": contract.get("provider_updated_ts"),
        "catalog_status_reason": contract.get("catalog_status_reason"),
        "schema_version": 1,
    }
    envelope = build_envelope(
        feed=settings.alpaca_feed,
        channel="contract",
        symbol=contract["contract_symbol"],
        seq=_seq.next(),
        payload=payload,
        event_ts=observed_at,
        ingest_ts=observed_at,
        source="catalog",
    )
    _producer.send(settings.topic_contracts, contract["contract_symbol"], envelope)


def _publish_status(
    *,
    status_value: str,
    observed_at: datetime,
    error_code: str | None = None,
    error_detail: str | None = None,
) -> None:
    payload = build_status_payload(
        component="catalog",
        status=status_value,
        session_value=session_state(observed_at, settings.holiday_set),
        last_success_ts=_state.snapshot()["last_success_ts"],
        active_contracts=None,
        hot_contracts=None,
        rest_backlog=0,
        error_code=error_code,
        error_detail=error_detail,
    )
    envelope = build_envelope(
        feed=settings.alpaca_feed,
        channel="status",
        symbol="catalog",
        seq=_seq.next(),
        payload=payload,
        event_ts=observed_at,
        ingest_ts=observed_at,
        source="catalog",
    )
    _producer.send(settings.topic_status, "catalog", envelope)


def _discovery_interval_seconds() -> int:
    now = utc_now()
    if session_state(now, settings.holiday_set) == "regular":
        return settings.options_contract_discovery_interval_sec
    return settings.options_contract_discovery_offsession_interval_sec


def _run_discovery_cycle() -> None:
    observed_at = utc_now()
    expiration_start = observed_at.date()
    expiration_end = expiration_start + timedelta(
        days=settings.options_contract_expiration_horizon_days
    )
    page_token: str | None = None
    page_count = 0
    contract_count = 0
    changed_count = 0
    persisted_subscription_rows = _repository.list_live_subscription_candidates()
    cold_symbols = _repository.list_cold_subscription_symbols()
    live_seed_rows = [
        row for row in persisted_subscription_rows if row.get("tier") in {"hot", "warm"}
    ]
    protected_hot_symbols = {
        str(row["contract_symbol"]) for row in live_seed_rows if row["tier"] == "hot"
    }
    protected_warm_symbols = {
        str(row["contract_symbol"]) for row in live_seed_rows if row["tier"] == "warm"
    }
    hot_limit, warm_limit = subscription_tier_limits(
        hot_cap=settings.options_subscription_hot_cap,
        warm_cap=settings.options_subscription_warm_cap,
        provider_cap_bootstrap=settings.options_provider_cap_bootstrap,
    )
    protected_seed = ProtectedSubscriptionSeed(
        hot_symbols=frozenset(protected_hot_symbols),
        warm_symbols=frozenset(protected_warm_symbols),
        hot_limit=hot_limit,
        warm_limit=warm_limit,
        cold_symbols=cold_symbols,
    )
    cycle_owned_symbols: set[str] = set()
    active_seed_rows = [row for row in live_seed_rows if row.get("status") == "active"]
    max_open_interest = max(
        (cast(int, row.get("open_interest") or 0) for row in active_seed_rows),
        default=0,
    )
    provisional_ranked_rows = top_ranked_contract_rows(
        iter(active_seed_rows),
        observed_at=observed_at,
        hot_cap=settings.options_subscription_hot_cap,
        warm_cap=settings.options_subscription_warm_cap,
        max_open_interest=max(max_open_interest, 1),
        provider_cap_bootstrap=settings.options_provider_cap_bootstrap,
        underlying_priority=settings.underlying_priority_set,
    )
    last_subscription_flush = monotonic()

    while True:
        while not _repository.acquire_rate_bucket("contracts", 1.0, 4):
            if _state.stop_event.wait(1.0):
                return
        contracts, page_token = _client.list_contracts(
            status="active",
            limit=settings.options_contract_discovery_page_limit,
            expiration_date_gte=expiration_start,
            expiration_date_lte=expiration_end,
            page_token=page_token,
        )
        page_count += 1
        normalized_contracts = [
            normalize_contract_record(contract, observed_at=observed_at)
            for contract in contracts
            if str(contract.get("symbol") or "").strip()
        ]
        contract_count += len(normalized_contracts)
        max_open_interest = max(
            max_open_interest,
            max(
                (
                    cast(int, contract.get("open_interest") or 0)
                    for contract in normalized_contracts
                ),
                default=0,
            ),
        )
        changed_rows = _repository.sync_contract_catalog_page(
            normalized_contracts,
            observed_at=observed_at,
        )
        changed_count += len(changed_rows)
        for row in changed_rows:
            _publish_contract_row(row, observed_at=observed_at)
        provisional_ranked_rows = merge_top_ranked_contract_rows(
            provisional_ranked_rows,
            normalized_contracts,
            observed_at=observed_at,
            hot_cap=settings.options_subscription_hot_cap,
            warm_cap=settings.options_subscription_warm_cap,
            max_open_interest=max(max_open_interest, 1),
            provider_cap_bootstrap=settings.options_provider_cap_bootstrap,
            underlying_priority=settings.underlying_priority_set,
        )
        flush_time = monotonic()
        subscription_flush_due = bool(page_token) and (
            page_count == 1
            or page_count % PROVISIONAL_SUBSCRIPTION_FLUSH_PAGES == 0
            or flush_time - last_subscription_flush
            >= PROVISIONAL_SUBSCRIPTION_FLUSH_SECONDS
        )
        if subscription_flush_due:
            provisional_plan = plan_provisional_subscription_reconciliation(
                provisional_ranked_rows,
                protected_seed=protected_seed,
                previously_owned_symbols=cycle_owned_symbols,
            )
            changed_count_for_flush = 0
            deactivated_count_for_flush = 0
            if provisional_plan.ranked_rows or provisional_plan.deactivate_symbols:
                reconcile_result = _repository.write_subscription_state(
                    ranked_rows=provisional_plan.ranked_rows,
                    deactivate_symbols=provisional_plan.deactivate_symbols,
                    observed_at=observed_at,
                )
                changed_count_for_flush = reconcile_result.changed_count
                deactivated_count_for_flush = reconcile_result.deactivated_count
                _state.record_subscription_reconciliation(
                    changed_count=changed_count_for_flush,
                    deactivated_count=deactivated_count_for_flush,
                    observed_at=observed_at,
                )
            cycle_owned_symbols = provisional_plan.owned_symbols
            last_subscription_flush = flush_time
            logger.info(
                "options catalog subscription reconciliation pages=%s protected=%s cycle_owned=%s changed=%s deactivated=%s",
                page_count,
                len(protected_hot_symbols) + len(protected_warm_symbols),
                len(provisional_plan.ranked_rows),
                changed_count_for_flush,
                deactivated_count_for_flush,
            )
            if not _state.snapshot()["ready"] and any(
                row["tier"] == "hot" for row in provisional_ranked_rows
            ):
                _state.set_ready()
                logger.info(
                    "options catalog provisional hot-set ready pages=%s contracts=%s hot=%s warm=%s",
                    page_count,
                    contract_count,
                    sum(1 for row in provisional_ranked_rows if row["tier"] == "hot"),
                    sum(1 for row in provisional_ranked_rows if row["tier"] == "warm"),
                )
        if page_count == 1 or page_count % 10 == 0 or not page_token:
            logger.info(
                "options catalog discovery progress pages=%s contracts=%s changed=%s has_next=%s",
                page_count,
                contract_count,
                changed_count,
                bool(page_token),
            )
        if not page_token:
            break

    transition_rows = _repository.mark_contracts_missing_from_cycle(
        observed_at=observed_at,
    )
    for row in transition_rows:
        _publish_contract_row(row, observed_at=observed_at)

    ranked_rows = top_ranked_contract_rows(
        _repository.iter_active_contracts_for_ranking(),
        observed_at=observed_at,
        hot_cap=settings.options_subscription_hot_cap,
        warm_cap=settings.options_subscription_warm_cap,
        max_open_interest=_repository.max_active_open_interest(),
        provider_cap_bootstrap=settings.options_provider_cap_bootstrap,
        underlying_priority=settings.underlying_priority_set,
    )
    final_symbols = {str(row["contract_symbol"]) for row in ranked_rows}
    current_non_off_symbols = _repository.list_non_off_subscription_symbols()
    final_reconcile_result = _repository.write_subscription_state(
        ranked_rows=ranked_rows,
        deactivate_symbols=current_non_off_symbols - final_symbols,
        observed_at=observed_at,
    )
    _state.record_subscription_reconciliation(
        changed_count=final_reconcile_result.changed_count,
        deactivated_count=final_reconcile_result.deactivated_count,
        observed_at=observed_at,
    )
    hot_count = sum(1 for row in ranked_rows if row["tier"] == "hot")
    warm_count = sum(1 for row in ranked_rows if row["tier"] == "warm")
    cycle_summary = CatalogCycleSummary(
        observed_at=observed_at,
        page_count=page_count,
        contract_count=contract_count,
        catalog_changed_count=changed_count,
        transition_count=len(transition_rows),
        hot_count=hot_count,
        warm_count=warm_count,
        subscription_changed_count=final_reconcile_result.changed_count,
        subscription_deactivated_count=final_reconcile_result.deactivated_count,
    )
    _repository.record_catalog_cycle_success(cycle_summary)
    logger.info(
        "options catalog discovery cycle completed pages=%s contracts=%s changed=%s transitions=%s hot=%s warm=%s subscription_changes=%s subscription_deactivations=%s",
        page_count,
        contract_count,
        changed_count,
        len(transition_rows),
        hot_count,
        warm_count,
        final_reconcile_result.changed_count,
        final_reconcile_result.deactivated_count,
    )
    _publish_status(status_value="ok", observed_at=observed_at)
    _producer.flush()
    _state.set_success(observed_at.isoformat())


def _catalog_loop() -> None:
    while not _state.stop_event.is_set():
        try:
            _run_discovery_cycle()
        except AlpacaApiError as exc:
            logger.exception("options catalog discovery failed")
            _state.set_error(str(exc.status_code), exc.body[:200])
            _publish_status(
                status_value="blocked"
                if exc.status_code in {401, 403, 405, 406, 410, 412, 413}
                else "degraded",
                observed_at=utc_now(),
                error_code=str(exc.status_code or "alpaca_api_error"),
                error_detail=exc.body[:200],
            )
        except Exception as exc:
            logger.exception("options catalog discovery failed")
            _state.set_error("catalog_cycle_failed", str(exc))
            _publish_status(
                status_value="degraded",
                observed_at=utc_now(),
                error_code="catalog_cycle_failed",
                error_detail=str(exc)[:200],
            )
        finally:
            _producer.flush()
        _state.stop_event.wait(_discovery_interval_seconds())


def _start_worker() -> None:
    if _state.thread is not None:
        return
    _state.thread = threading.Thread(
        target=_catalog_loop, name="options-catalog", daemon=True
    )
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


app = FastAPI(title="torghut-options-catalog", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"status": "ok", **_state.snapshot()}


@app.get("/readyz")
def readyz() -> dict[str, Any]:
    snapshot = _state.snapshot()
    if not snapshot["ready"]:
        raise HTTPException(status_code=503, detail=snapshot)
    return {"status": "ready", **snapshot}


@app.get("/v1/options/hot-set")
def hot_set() -> dict[str, Any]:
    symbols = _repository.get_hot_symbols(settings.options_subscription_hot_cap)
    return {
        "symbols": symbols,
        "count": len(symbols),
        "provider_cap": settings.options_provider_cap_bootstrap,
        "generated_at": utc_now().isoformat(),
    }
