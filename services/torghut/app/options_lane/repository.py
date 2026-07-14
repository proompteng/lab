"""Persistence helpers for the options lane control plane."""

from __future__ import annotations

from collections.abc import Iterable
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
import heapq
import json
import logging
from typing import Any, Iterator, cast

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.options_lane.catalog_watermark_repository import (
    CatalogCycleSummary,
    record_catalog_cycle_success,
)
from app.options_lane.catalog_scope import OptionsCatalogScope
from app.options_lane.catalog_change_detection import contract_catalog_row_changed
from app.options_lane.subscription_state_repository import (
    SubscriptionReconcileResult,
    load_cold_subscription_symbols,
    load_live_subscription_candidates,
    load_non_off_subscription_symbols,
    reconcile_subscription_state,
)


logger = logging.getLogger(__name__)

OPTIONS_STATUS_COUNT_TIMEOUT_MS = 500


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


class OptionsRepository:
    """Postgres-backed control-plane repository for the options lane."""

    def __init__(self, sqlalchemy_dsn: str) -> None:
        self._engine: Engine = create_engine(
            sqlalchemy_dsn, future=True, pool_pre_ping=True
        )
        self._session_factory = sessionmaker(
            bind=self._engine,
            expire_on_commit=False,
            future=True,
        )

    @contextmanager
    def session(self) -> Iterator[Session]:
        session = self._session_factory()
        try:
            yield session
        finally:
            session.close()

    def close(self) -> None:
        self._engine.dispose()

    def ensure_rate_bucket_defaults(
        self, defaults: dict[str, tuple[float, int]]
    ) -> None:
        now = _utc_now()
        with self.session() as session, session.begin():
            for bucket_name, (refill_per_second, burst_capacity) in defaults.items():
                session.execute(
                    text(
                        """
                        INSERT INTO torghut_options_rate_limit_state (
                          bucket_name,
                          refill_per_second,
                          burst_capacity,
                          tokens_available,
                          last_refill_ts,
                          metadata
                        ) VALUES (
                          :bucket_name,
                          :refill_per_second,
                          :burst_capacity,
                          :tokens_available,
                          :last_refill_ts,
                          CAST(:metadata AS JSONB)
                        )
                        ON CONFLICT (bucket_name) DO NOTHING
                        """
                    ),
                    {
                        "bucket_name": bucket_name,
                        "refill_per_second": refill_per_second,
                        "burst_capacity": burst_capacity,
                        "tokens_available": float(burst_capacity),
                        "last_refill_ts": now,
                        "metadata": "{}",
                    },
                )

    def acquire_rate_bucket(
        self, bucket_name: str, refill_per_second: float, burst_capacity: int
    ) -> bool:
        now = _utc_now()
        self.ensure_rate_bucket_defaults(
            {bucket_name: (refill_per_second, burst_capacity)}
        )
        with self.session() as session, session.begin():
            row = (
                session.execute(
                    text(
                        """
                    SELECT bucket_name, refill_per_second, burst_capacity, tokens_available, last_refill_ts
                    FROM torghut_options_rate_limit_state
                    WHERE bucket_name = :bucket_name
                    """
                    ),
                    {"bucket_name": bucket_name},
                )
                .mappings()
                .first()
            )

            if row is None:
                return False

            last_refill_ts = cast(datetime, row["last_refill_ts"])
            elapsed_seconds = max((now - last_refill_ts).total_seconds(), 0.0)
            active_refill = float(row["refill_per_second"] or refill_per_second)
            active_burst = int(row["burst_capacity"] or burst_capacity)
            tokens_available = min(
                float(row["tokens_available"] or 0.0)
                + (elapsed_seconds * active_refill),
                float(active_burst),
            )
            if tokens_available < 1.0:
                session.execute(
                    text(
                        """
                        UPDATE torghut_options_rate_limit_state
                        SET tokens_available = :tokens_available,
                            last_refill_ts = :last_refill_ts
                        WHERE bucket_name = :bucket_name
                        """
                    ),
                    {
                        "bucket_name": bucket_name,
                        "tokens_available": tokens_available,
                        "last_refill_ts": now,
                    },
                )
                return False

            session.execute(
                text(
                    """
                    UPDATE torghut_options_rate_limit_state
                    SET tokens_available = :tokens_available,
                        last_refill_ts = :last_refill_ts
                    WHERE bucket_name = :bucket_name
                    """
                ),
                {
                    "bucket_name": bucket_name,
                    "tokens_available": tokens_available - 1.0,
                    "last_refill_ts": now,
                },
            )
            return True

    def halve_rate_bucket(self, bucket_name: str) -> None:
        now = _utc_now()
        with self.session() as session, session.begin():
            session.execute(
                text(
                    """
                    UPDATE torghut_options_rate_limit_state
                    SET refill_per_second = GREATEST(refill_per_second * 0.5, 0.01),
                        last_429_ts = :last_429_ts
                    WHERE bucket_name = :bucket_name
                    """
                ),
                {"bucket_name": bucket_name, "last_429_ts": now},
            )

    def sync_contract_catalog_page(
        self,
        contracts: list[dict[str, Any]],
        *,
        observed_at: datetime,
    ) -> list[dict[str, Any]]:
        """Upsert one page of active contracts and return changed rows."""

        if not contracts:
            return []
        contracts_by_symbol = {
            cast(str, row["contract_symbol"]): row for row in contracts
        }
        ordered_contracts = [
            contracts_by_symbol[symbol] for symbol in sorted(contracts_by_symbol)
        ]
        seen_symbols = {
            row["contract_symbol"]
            for row in ordered_contracts
            if row.get("contract_symbol")
        }
        published_rows: list[dict[str, Any]] = []

        with self.session() as session, session.begin():
            existing_rows = {
                row["contract_symbol"]: dict(row)
                for row in session.execute(
                    text(
                        """
                        SELECT *
                        FROM torghut_options_contract_catalog
                        WHERE contract_symbol = ANY(:symbols)
                        """
                    ),
                    {"symbols": list(seen_symbols) or [""]},
                ).mappings()
            }
            upsert_rows: list[dict[str, Any]] = []

            for contract in ordered_contracts:
                contract_symbol = cast(str, contract["contract_symbol"])
                current = existing_rows.get(contract_symbol)
                first_seen_ts = (
                    current.get("first_seen_ts")
                    if current
                    else contract["first_seen_ts"]
                )
                payload = dict(contract)
                payload["first_seen_ts"] = first_seen_ts

                changed = contract_catalog_row_changed(
                    current=current,
                    payload=payload,
                )
                if changed:
                    published_rows.append(payload)
                    upsert_rows.append(
                        {
                            **payload,
                            "metadata": _coerce_json(payload["metadata"]),
                        }
                    )

            if upsert_rows:
                session.execute(
                    text(
                        """
                    INSERT INTO torghut_options_contract_catalog (
                      contract_symbol,
                      contract_id,
                      root_symbol,
                      underlying_symbol,
                      expiration_date,
                      strike_price,
                      option_type,
                      style,
                      contract_size,
                      status,
                      tradable,
                      open_interest,
                      open_interest_date,
                      close_price,
                      close_price_date,
                      provider_updated_ts,
                      first_seen_ts,
                      last_seen_ts,
                      metadata
                    ) VALUES (
                      :contract_symbol,
                      :contract_id,
                      :root_symbol,
                      :underlying_symbol,
                      :expiration_date,
                      :strike_price,
                      :option_type,
                      :style,
                      :contract_size,
                      :status,
                      :tradable,
                      :open_interest,
                      :open_interest_date,
                      :close_price,
                      :close_price_date,
                      :provider_updated_ts,
                      :first_seen_ts,
                      :last_seen_ts,
                      CAST(:metadata AS JSONB)
                    )
                    ON CONFLICT (contract_symbol) DO UPDATE
                    SET contract_id = EXCLUDED.contract_id,
                        root_symbol = EXCLUDED.root_symbol,
                        underlying_symbol = EXCLUDED.underlying_symbol,
                        expiration_date = EXCLUDED.expiration_date,
                        strike_price = EXCLUDED.strike_price,
                        option_type = EXCLUDED.option_type,
                        style = EXCLUDED.style,
                        contract_size = EXCLUDED.contract_size,
                        status = EXCLUDED.status,
                        tradable = EXCLUDED.tradable,
                        open_interest = EXCLUDED.open_interest,
                        open_interest_date = EXCLUDED.open_interest_date,
                        close_price = EXCLUDED.close_price,
                        close_price_date = EXCLUDED.close_price_date,
                        provider_updated_ts = EXCLUDED.provider_updated_ts,
                        last_seen_ts = EXCLUDED.last_seen_ts,
                        metadata = EXCLUDED.metadata
                    WHERE (
                      torghut_options_contract_catalog.contract_id,
                      torghut_options_contract_catalog.root_symbol,
                      torghut_options_contract_catalog.underlying_symbol,
                      torghut_options_contract_catalog.expiration_date,
                      torghut_options_contract_catalog.strike_price,
                      torghut_options_contract_catalog.option_type,
                      torghut_options_contract_catalog.style,
                      torghut_options_contract_catalog.contract_size,
                      torghut_options_contract_catalog.status,
                      torghut_options_contract_catalog.tradable,
                      torghut_options_contract_catalog.open_interest,
                      torghut_options_contract_catalog.open_interest_date,
                      torghut_options_contract_catalog.close_price,
                      torghut_options_contract_catalog.close_price_date,
                      torghut_options_contract_catalog.provider_updated_ts,
                      torghut_options_contract_catalog.metadata
                    ) IS DISTINCT FROM (
                      EXCLUDED.contract_id,
                      EXCLUDED.root_symbol,
                      EXCLUDED.underlying_symbol,
                      EXCLUDED.expiration_date,
                      EXCLUDED.strike_price,
                      EXCLUDED.option_type,
                      EXCLUDED.style,
                      EXCLUDED.contract_size,
                      EXCLUDED.status,
                      EXCLUDED.tradable,
                      EXCLUDED.open_interest,
                      EXCLUDED.open_interest_date,
                      EXCLUDED.close_price,
                      EXCLUDED.close_price_date,
                      EXCLUDED.provider_updated_ts,
                      EXCLUDED.metadata
                    )
                        """
                    ),
                    upsert_rows,
                )

        return published_rows

    def mark_contracts_missing_from_cycle(
        self,
        *,
        observed_at: datetime,
        scope: OptionsCatalogScope,
        seen_symbols: set[str],
    ) -> list[dict[str, Any]]:
        normalized_seen_symbols = sorted(
            {symbol.strip().upper() for symbol in seen_symbols if symbol.strip()}
        )
        if not normalized_seen_symbols:
            raise ValueError("complete options catalog scan must contain contracts")

        with self.session() as session, session.begin():
            session.execute(
                text(
                    """
                    CREATE TEMPORARY TABLE options_catalog_seen_contracts (
                      contract_symbol TEXT PRIMARY KEY
                    ) ON COMMIT DROP
                    """
                )
            )
            session.execute(
                text(
                    """
                    INSERT INTO options_catalog_seen_contracts (contract_symbol)
                    SELECT unnest(CAST(:seen_symbols AS TEXT[]))
                    ON CONFLICT (contract_symbol) DO NOTHING
                    """
                ),
                {"seen_symbols": normalized_seen_symbols},
            )
            transition_rows = session.execute(
                text(
                    """
                    UPDATE torghut_options_contract_catalog AS catalog
                    SET status = CASE
                          WHEN catalog.expiration_date < CAST(:observed_at AS DATE) THEN 'expired'
                          ELSE 'inactive'
                        END,
                        last_seen_ts = :observed_at
                    WHERE catalog.status = 'active'
                      AND catalog.underlying_symbol = ANY(:underlying_symbols)
                      AND catalog.expiration_date <= :expiration_date_lte
                      AND (
                        catalog.expiration_date < :expiration_date_gte
                        OR NOT EXISTS (
                          SELECT 1
                          FROM options_catalog_seen_contracts AS seen
                          WHERE seen.contract_symbol = catalog.contract_symbol
                        )
                      )
                    RETURNING catalog.*
                    """
                ),
                {"observed_at": observed_at, **scope.query_parameters},
            ).mappings()
            return [
                {
                    **dict(row),
                    "catalog_status_reason": "not_seen_in_active_discovery_run",
                }
                for row in transition_rows
            ]

    def list_active_contracts(self) -> list[dict[str, Any]]:
        with self.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT catalog.contract_symbol,
                           catalog.status,
                           catalog.underlying_symbol,
                           catalog.expiration_date,
                           catalog.strike_price,
                           catalog.close_price,
                           catalog.open_interest,
                           COALESCE(subs.ranking_inputs, '{}'::JSONB) AS ranking_inputs
                    FROM torghut_options_contract_catalog AS catalog
                    LEFT JOIN torghut_options_subscription_state AS subs
                      ON subs.contract_symbol = catalog.contract_symbol
                    WHERE catalog.status = 'active'
                    ORDER BY catalog.underlying_symbol, catalog.expiration_date, catalog.strike_price
                    """
                )
            ).mappings()
            return [dict(row) for row in rows]

    def iter_active_contracts_for_ranking(
        self, *, scope: OptionsCatalogScope, batch_size: int = 5000
    ) -> Iterator[dict[str, Any]]:
        with self.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT catalog.contract_symbol,
                           catalog.status,
                           catalog.underlying_symbol,
                           catalog.expiration_date,
                           catalog.strike_price,
                           catalog.close_price,
                           catalog.open_interest,
                           COALESCE(subs.ranking_inputs, '{}'::JSONB) AS ranking_inputs
                    FROM torghut_options_contract_catalog AS catalog
                    LEFT JOIN torghut_options_subscription_state AS subs
                      ON subs.contract_symbol = catalog.contract_symbol
                    WHERE catalog.status = 'active'
                      AND catalog.underlying_symbol = ANY(:underlying_symbols)
                      AND catalog.expiration_date BETWEEN :expiration_date_gte AND :expiration_date_lte
                    ORDER BY catalog.contract_symbol
                    """
                ),
                scope.query_parameters,
            ).mappings()
            while batch := rows.fetchmany(batch_size):
                for row in batch:
                    yield dict(row)

    def list_live_subscription_candidates(
        self, *, scope: OptionsCatalogScope
    ) -> list[dict[str, Any]]:
        """Return only the persisted hot/warm candidate seed."""

        with self.session() as session:
            return load_live_subscription_candidates(session, scope=scope)

    def list_non_off_subscription_symbols(self) -> set[str]:
        """Return every symbol eligible for final-cycle cleanup."""

        with self.session() as session:
            return load_non_off_subscription_symbols(session)

    def list_cold_subscription_symbols(
        self, *, scope: OptionsCatalogScope
    ) -> frozenset[str]:
        """Return rows that only final reconciliation may retier or deactivate."""

        with self.session() as session:
            return load_cold_subscription_symbols(session, scope=scope)

    def write_subscription_state(
        self,
        *,
        ranked_rows: list[dict[str, Any]],
        deactivate_symbols: Iterable[str],
        observed_at: datetime,
    ) -> SubscriptionReconcileResult:
        with self.session() as session:
            return reconcile_subscription_state(
                session,
                ranked_rows=ranked_rows,
                deactivate_symbols=deactivate_symbols,
                observed_at=observed_at,
            )

    def get_hot_symbols(self, limit: int, *, scope: OptionsCatalogScope) -> list[str]:
        with self.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT subscriptions.contract_symbol
                    FROM torghut_options_subscription_state AS subscriptions
                    JOIN torghut_options_contract_catalog AS catalog
                      ON catalog.contract_symbol = subscriptions.contract_symbol
                    WHERE subscriptions.tier = 'hot'
                      AND catalog.status = 'active'
                      AND catalog.underlying_symbol = ANY(:underlying_symbols)
                      AND catalog.expiration_date BETWEEN :expiration_date_gte AND :expiration_date_lte
                    ORDER BY subscriptions.ranking_score DESC,
                             subscriptions.contract_symbol ASC
                    LIMIT :limit
                    """
                ),
                {"limit": limit, **scope.query_parameters},
            )
            return [cast(str, row[0]) for row in rows]

    def record_catalog_cycle_success(self, summary: CatalogCycleSummary) -> None:
        """Persist complete-cycle freshness in one watermark row."""

        with self.session() as session:
            record_catalog_cycle_success(session, summary)

    def get_due_snapshot_contracts(
        self,
        *,
        tier: str,
        stale_after: timedelta,
        limit: int,
    ) -> list[dict[str, Any]]:
        now = _utc_now()
        threshold = now - stale_after
        with self.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT catalog.contract_symbol,
                           catalog.underlying_symbol,
                           catalog.expiration_date,
                           catalog.strike_price,
                           catalog.option_type,
                           subs.tier,
                           watermarks.last_success_ts
                    FROM torghut_options_subscription_state AS subs
                    JOIN torghut_options_contract_catalog AS catalog
                      ON catalog.contract_symbol = subs.contract_symbol
                    LEFT JOIN torghut_options_watermarks AS watermarks
                      ON watermarks.component = 'enricher'
                     AND watermarks.scope_type = 'contract_symbol'
                     AND watermarks.scope_key = subs.contract_symbol
                    WHERE catalog.status = 'active'
                      AND subs.tier = :tier
                      AND (
                        watermarks.last_success_ts IS NULL
                        OR watermarks.last_success_ts < :threshold
                      )
                    ORDER BY COALESCE(watermarks.last_success_ts, TIMESTAMPTZ 'epoch') ASC,
                             subs.ranking_score DESC
                    LIMIT :limit
                    """
                ),
                {"tier": tier, "threshold": threshold, "limit": limit},
            ).mappings()
            return [dict(row) for row in rows]

    def record_snapshot_success(
        self,
        *,
        contract_symbol: str,
        snapshot_class: str,
        observed_at: datetime,
        ranking_inputs: dict[str, Any],
    ) -> None:
        with self.session() as session, session.begin():
            session.execute(
                text(
                    """
                    INSERT INTO torghut_options_watermarks (
                      component,
                      scope_type,
                      scope_key,
                      cursor,
                      last_event_ts,
                      last_success_ts,
                      next_eligible_ts,
                      retry_count,
                      metadata
                    ) VALUES (
                      'enricher',
                      'contract_symbol',
                      :scope_key,
                      NULL,
                      :last_event_ts,
                      :last_success_ts,
                      NULL,
                      0,
                      CAST(:metadata AS JSONB)
                    )
                    ON CONFLICT (component, scope_type, scope_key) DO UPDATE
                    SET last_event_ts = EXCLUDED.last_event_ts,
                        last_success_ts = EXCLUDED.last_success_ts,
                        retry_count = 0,
                        metadata = EXCLUDED.metadata
                    """
                ),
                {
                    "scope_key": contract_symbol,
                    "last_event_ts": observed_at,
                    "last_success_ts": observed_at,
                    "metadata": _coerce_json({"snapshot_class": snapshot_class}),
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO torghut_options_subscription_state (
                      contract_symbol,
                      ranking_score,
                      ranking_inputs,
                      tier,
                      desired_channels,
                      subscribed_channels,
                      provider_cap_generation,
                      last_ranked_ts
                    )
                    VALUES (
                      :contract_symbol,
                      0,
                      CAST(:ranking_inputs AS JSONB),
                      'cold',
                      ARRAY['trades', 'quotes']::TEXT[],
                      ARRAY[]::TEXT[],
                      0,
                      :last_ranked_ts
                    )
                    ON CONFLICT (contract_symbol) DO UPDATE
                    SET ranking_inputs = COALESCE(torghut_options_subscription_state.ranking_inputs, '{}'::JSONB)
                        || EXCLUDED.ranking_inputs
                    """
                ),
                {
                    "contract_symbol": contract_symbol,
                    "ranking_inputs": _coerce_json(ranking_inputs),
                    "last_ranked_ts": observed_at,
                },
            )

    def _bounded_count(
        self, sql: str, *, timeout_ms: int = OPTIONS_STATUS_COUNT_TIMEOUT_MS
    ) -> int | None:
        bounded_timeout_ms = max(1, int(timeout_ms))
        try:
            with self.session() as session, session.begin():
                session.execute(
                    text(f"SET LOCAL statement_timeout = {bounded_timeout_ms}")
                )
                return int(session.execute(text(sql)).scalar_one() or 0)
        except SQLAlchemyError as exc:
            logger.warning("options status count failed query=%s error=%s", sql, exc)
            return None

    def count_active_contracts(self) -> int | None:
        return self._bounded_count(
            "SELECT COUNT(*) FROM torghut_options_contract_catalog WHERE status = 'active'"
        )

    def count_hot_contracts(self) -> int | None:
        return self._bounded_count(
            "SELECT COUNT(*) FROM torghut_options_subscription_state WHERE tier = 'hot'"
        )

    def max_active_open_interest(self, *, scope: OptionsCatalogScope) -> int:
        with self.session() as session:
            return int(
                session.execute(
                    text(
                        """
                        SELECT COALESCE(MAX(open_interest), 0)
                        FROM torghut_options_contract_catalog
                        WHERE status = 'active'
                          AND underlying_symbol = ANY(:underlying_symbols)
                          AND expiration_date BETWEEN :expiration_date_gte AND :expiration_date_lte
                        """
                    ),
                    scope.query_parameters,
                ).scalar_one()
                or 0
            )

    def fetch_contract_metadata(self, symbols: list[str]) -> dict[str, dict[str, Any]]:
        if not symbols:
            return {}
        with self.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT *
                    FROM torghut_options_contract_catalog
                    WHERE contract_symbol = ANY(:symbols)
                    """
                ),
                {"symbols": symbols},
            ).mappings()
            return {cast(str, row["contract_symbol"]): dict(row) for row in rows}


def ranked_contract_rows(
    contracts: list[dict[str, Any]],
    *,
    observed_at: datetime,
    hot_cap: int,
    warm_cap: int,
    provider_cap_bootstrap: int,
    underlying_priority: set[str],
) -> list[dict[str, Any]]:
    """Apply the deterministic ranking contract from doc 34."""

    active_contracts = [row for row in contracts if row.get("status") == "active"]
    if not active_contracts:
        return []
    max_open_interest = (
        max(int(contract.get("open_interest") or 0) for contract in active_contracts)
        or 1
    )
    ranked = [
        _build_ranked_contract_row(
            row,
            observed_at=observed_at,
            max_open_interest=max_open_interest,
            provider_cap_bootstrap=provider_cap_bootstrap,
            underlying_priority=underlying_priority,
        )
        for row in active_contracts
    ]
    ranked.sort(
        key=lambda row: (-float(row["ranking_score"]), str(row["contract_symbol"]))
    )
    hot_count, warm_count = subscription_tier_limits(
        hot_cap=hot_cap,
        warm_cap=warm_cap,
        provider_cap_bootstrap=provider_cap_bootstrap,
    )
    for index, row in enumerate(ranked):
        if index < hot_count:
            row["tier"] = "hot"
        elif index < hot_count + warm_count:
            row["tier"] = "warm"
        else:
            row["tier"] = "cold"
    return ranked


def top_ranked_contract_rows(
    contracts: Iterator[dict[str, Any]],
    *,
    observed_at: datetime,
    hot_cap: int,
    warm_cap: int,
    max_open_interest: int,
    provider_cap_bootstrap: int,
    underlying_priority: set[str],
) -> list[dict[str, Any]]:
    """Rank only the hot and warm candidates while streaming the active universe."""

    hot_count, warm_count = subscription_tier_limits(
        hot_cap=hot_cap,
        warm_cap=warm_cap,
        provider_cap_bootstrap=provider_cap_bootstrap,
    )
    candidate_limit = hot_count + warm_count
    if candidate_limit <= 0:
        return []

    heap: list[tuple[float, tuple[int, ...], dict[str, Any]]] = []
    for row in contracts:
        if row.get("status") != "active":
            continue
        ranked_row = _build_ranked_contract_row(
            row,
            observed_at=observed_at,
            max_open_interest=max_open_interest,
            provider_cap_bootstrap=provider_cap_bootstrap,
            underlying_priority=underlying_priority,
        )
        heap_item = (
            float(ranked_row["ranking_score"]),
            _contract_symbol_heap_key(str(ranked_row["contract_symbol"])),
            ranked_row,
        )
        if len(heap) < candidate_limit:
            heapq.heappush(heap, heap_item)
            continue
        if heap_item[:2] > heap[0][:2]:
            heapq.heapreplace(heap, heap_item)

    ranked = [item[2] for item in heap]
    ranked.sort(
        key=lambda row: (-float(row["ranking_score"]), str(row["contract_symbol"]))
    )
    for index, row in enumerate(ranked):
        row["tier"] = "hot" if index < hot_count else "warm"
    return ranked


def merge_top_ranked_contract_rows(
    ranked_rows: Iterable[dict[str, Any]],
    contracts: Iterable[dict[str, Any]],
    *,
    observed_at: datetime,
    hot_cap: int,
    warm_cap: int,
    max_open_interest: int,
    provider_cap_bootstrap: int,
    underlying_priority: set[str],
) -> list[dict[str, Any]]:
    """Merge new contract rows into the current hot/warm candidate set."""

    rows_by_symbol = {
        str(row["contract_symbol"]): row
        for row in ranked_rows
        if row.get("contract_symbol")
    }
    rows_by_symbol.update(
        {
            str(row["contract_symbol"]): row
            for row in contracts
            if row.get("contract_symbol")
        }
    )
    return top_ranked_contract_rows(
        iter(rows_by_symbol.values()),
        observed_at=observed_at,
        hot_cap=hot_cap,
        warm_cap=warm_cap,
        max_open_interest=max_open_interest,
        provider_cap_bootstrap=provider_cap_bootstrap,
        underlying_priority=underlying_priority,
    )


def subscription_tier_limits(
    *, hot_cap: int, warm_cap: int, provider_cap_bootstrap: int
) -> tuple[int, int]:
    hot_count = min(hot_cap, max(int(provider_cap_bootstrap * 0.8), 0))
    warm_count = min(warm_cap, hot_count * 5 if hot_count > 0 else warm_cap)
    return hot_count, warm_count


def _contract_symbol_heap_key(contract_symbol: str) -> tuple[int, ...]:
    return tuple(-ord(ch) for ch in contract_symbol)


def _dte_score(*, observed_at: datetime, expiration_date: date) -> float:
    dte = max((expiration_date - observed_at.date()).days, 0)
    if dte <= 7:
        return 1.0
    if dte <= 30:
        return 0.8
    if dte <= 90:
        return 0.5
    return 0.2


def _moneyness_score(metadata: dict[str, Any]) -> float:
    strike_price = float(metadata.get("strike_price") or 0.0)
    close_price = float(metadata.get("close_price") or strike_price or 1.0)
    if strike_price <= 0 or close_price <= 0:
        return 0.5
    distance = abs(strike_price - close_price) / close_price
    return max(0.0, 1.0 - min(distance, 1.0))


def _priority_score(*, underlying_symbol: str, underlying_priority: set[str]) -> float:
    return 1.0 if underlying_symbol in underlying_priority else 0.5


def _score_or_default(values: dict[str, object], key: str, default: float) -> float:
    raw_value = values.get(key, default)
    try:
        return float(cast(int | float | str, raw_value))
    except (TypeError, ValueError, ArithmeticError):
        return default


def _parsed_ranking_inputs(row: dict[str, Any]) -> dict[str, object]:
    ranking_inputs = row.get("ranking_inputs")
    if isinstance(ranking_inputs, str):
        try:
            loaded_ranking_inputs = json.loads(ranking_inputs)
        except json.JSONDecodeError:
            return {}
        return (
            cast(dict[str, object], loaded_ranking_inputs)
            if isinstance(loaded_ranking_inputs, dict)
            else {}
        )
    if isinstance(ranking_inputs, dict):
        return cast(dict[str, object], ranking_inputs)
    return {}


def _build_ranked_contract_row(
    row: dict[str, Any],
    *,
    observed_at: datetime,
    max_open_interest: int,
    provider_cap_bootstrap: int,
    underlying_priority: set[str],
) -> dict[str, Any]:
    open_interest = int(row.get("open_interest") or 0)
    parsed_ranking_inputs = _parsed_ranking_inputs(row)
    liquidity_score = min(open_interest / max(max_open_interest, 1), 1.0)
    quote_recency_score = _score_or_default(
        parsed_ranking_inputs, "quote_recency_score", 0.5
    )
    trade_recency_score = _score_or_default(
        parsed_ranking_inputs, "trade_recency_score", 0.5
    )
    underlying_activity_score = _score_or_default(
        parsed_ranking_inputs,
        "underlying_activity_score",
        _priority_score(
            underlying_symbol=str(row["underlying_symbol"]),
            underlying_priority=underlying_priority,
        ),
    )
    dte_score = _dte_score(
        observed_at=observed_at,
        expiration_date=cast(date, row["expiration_date"]),
    )
    moneyness_score = _score_or_default(
        parsed_ranking_inputs, "moneyness_score", _moneyness_score(row)
    )
    ranking_score = (
        0.30 * liquidity_score
        + 0.20 * quote_recency_score
        + 0.15 * trade_recency_score
        + 0.15 * underlying_activity_score
        + 0.10 * dte_score
        + 0.10 * moneyness_score
    )

    return {
        "contract_symbol": row["contract_symbol"],
        "status": row.get("status", "active"),
        "underlying_symbol": row["underlying_symbol"],
        "expiration_date": row["expiration_date"],
        "strike_price": row.get("strike_price"),
        "close_price": row.get("close_price"),
        "open_interest": open_interest,
        "ranking_score": ranking_score,
        "ranking_inputs": {
            "liquidity_score": round(liquidity_score, 6),
            "quote_recency_score": round(quote_recency_score, 6),
            "trade_recency_score": round(trade_recency_score, 6),
            "underlying_activity_score": round(underlying_activity_score, 6),
            "dte_score": round(dte_score, 6),
            "moneyness_score": round(moneyness_score, 6),
        },
        "desired_channels": ["trades", "quotes"],
        "provider_cap_generation": provider_cap_bootstrap,
    }
