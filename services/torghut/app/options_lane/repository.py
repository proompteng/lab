"""Persistence helpers for the options lane control plane."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
import json
from typing import Any, Iterator, cast

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


class OptionsRepository:
    """Postgres-backed control-plane repository for the options lane."""

    def __init__(self, sqlalchemy_dsn: str) -> None:
        self._engine: Engine = create_engine(sqlalchemy_dsn, future=True, pool_pre_ping=True)
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

    def ensure_rate_bucket_defaults(self, defaults: dict[str, tuple[float, int]]) -> None:
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

    def acquire_rate_bucket(self, bucket_name: str, refill_per_second: float, burst_capacity: int) -> bool:
        now = _utc_now()
        self.ensure_rate_bucket_defaults({bucket_name: (refill_per_second, burst_capacity)})
        with self.session() as session, session.begin():
            row = session.execute(
                text(
                    """
                    SELECT bucket_name, refill_per_second, burst_capacity, tokens_available, last_refill_ts
                    FROM torghut_options_rate_limit_state
                    WHERE bucket_name = :bucket_name
                    """
                ),
                {"bucket_name": bucket_name},
            ).mappings().first()

            if row is None:
                return False

            last_refill_ts = cast(datetime, row["last_refill_ts"])
            elapsed_seconds = max((now - last_refill_ts).total_seconds(), 0.0)
            active_refill = float(row["refill_per_second"] or refill_per_second)
            active_burst = int(row["burst_capacity"] or burst_capacity)
            tokens_available = min(
                float(row["tokens_available"] or 0.0) + (elapsed_seconds * active_refill),
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

    def sync_contract_catalog(
        self,
        contracts: list[dict[str, Any]],
        *,
        observed_at: datetime,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Upsert the active contract set and return changed rows plus inactive transitions."""

        seen_symbols = {row["contract_symbol"] for row in contracts if row.get("contract_symbol")}
        published_rows: list[dict[str, Any]] = []
        transition_rows: list[dict[str, Any]] = []

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

            for contract in contracts:
                contract_symbol = cast(str, contract["contract_symbol"])
                current = existing_rows.get(contract_symbol)
                first_seen_ts = current.get("first_seen_ts") if current else contract["first_seen_ts"]
                payload = dict(contract)
                payload["first_seen_ts"] = first_seen_ts

                changed = current is None or any(
                    payload.get(field) != current.get(field)
                    for field in (
                        "contract_id",
                        "status",
                        "tradable",
                        "expiration_date",
                        "root_symbol",
                        "underlying_symbol",
                        "underlying_asset_id",
                        "option_type",
                        "style",
                        "strike_price",
                        "contract_size",
                        "open_interest",
                        "open_interest_date",
                        "close_price",
                        "close_price_date",
                        "provider_updated_ts",
                    )
                )

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
                        """
                    ),
                    {
                        **payload,
                        "metadata": _coerce_json(payload["metadata"]),
                    },
                )
                if changed:
                    published_rows.append(payload)

            stale_rows = session.execute(
                text(
                    """
                    SELECT *
                    FROM torghut_options_contract_catalog
                    WHERE status = 'active'
                      AND contract_symbol <> ALL(:symbols)
                    """
                ),
                {"symbols": list(seen_symbols) or [""]},
            ).mappings()

            for row in stale_rows:
                expiration_date = cast(date, row["expiration_date"])
                next_status = "expired" if expiration_date < observed_at.date() else "inactive"
                session.execute(
                    text(
                        """
                        UPDATE torghut_options_contract_catalog
                        SET status = :status,
                            last_seen_ts = :last_seen_ts
                        WHERE contract_symbol = :contract_symbol
                        """
                    ),
                    {
                        "contract_symbol": row["contract_symbol"],
                        "status": next_status,
                        "last_seen_ts": observed_at,
                    },
                )
                transition = dict(row)
                transition["status"] = next_status
                transition["last_seen_ts"] = observed_at
                transition["catalog_status_reason"] = "not_seen_in_active_discovery_run"
                transition_rows.append(transition)

        return published_rows, transition_rows

    def list_active_contracts(self) -> list[dict[str, Any]]:
        with self.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT catalog.*, subs.ranking_inputs
                    FROM torghut_options_contract_catalog AS catalog
                    LEFT JOIN torghut_options_subscription_state AS subs
                      ON subs.contract_symbol = catalog.contract_symbol
                    WHERE catalog.status = 'active'
                    ORDER BY catalog.underlying_symbol, catalog.expiration_date, catalog.strike_price
                    """
                )
            ).mappings()
            return [dict(row) for row in rows]

    def write_subscription_state(
        self,
        *,
        ranked_rows: list[dict[str, Any]],
        observed_at: datetime,
    ) -> tuple[int, int]:
        hot_count = 0
        warm_count = 0
        with self.session() as session, session.begin():
            for row in ranked_rows:
                tier = cast(str, row["tier"])
                if tier == "hot":
                    hot_count += 1
                elif tier == "warm":
                    warm_count += 1
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
                        ) VALUES (
                          :contract_symbol,
                          :ranking_score,
                          CAST(:ranking_inputs AS JSONB),
                          :tier,
                          :desired_channels,
                          ARRAY[]::TEXT[],
                          :provider_cap_generation,
                          :last_ranked_ts
                        )
                        ON CONFLICT (contract_symbol) DO UPDATE
                        SET ranking_score = EXCLUDED.ranking_score,
                            ranking_inputs = EXCLUDED.ranking_inputs,
                            tier = EXCLUDED.tier,
                            desired_channels = EXCLUDED.desired_channels,
                            provider_cap_generation = EXCLUDED.provider_cap_generation,
                            last_ranked_ts = EXCLUDED.last_ranked_ts
                        """
                    ),
                    {
                        "contract_symbol": row["contract_symbol"],
                        "ranking_score": row["ranking_score"],
                        "ranking_inputs": _coerce_json(row["ranking_inputs"]),
                        "tier": tier,
                        "desired_channels": row["desired_channels"],
                        "provider_cap_generation": row["provider_cap_generation"],
                        "last_ranked_ts": observed_at,
                    },
                )
            session.execute(
                text(
                    """
                    UPDATE torghut_options_subscription_state
                    SET tier = 'off',
                        last_ranked_ts = :last_ranked_ts
                    WHERE contract_symbol <> ALL(:symbols)
                    """
                ),
                {
                    "symbols": [row["contract_symbol"] for row in ranked_rows] or [""],
                    "last_ranked_ts": observed_at,
                },
            )
        return hot_count, warm_count

    def get_hot_symbols(self, limit: int) -> list[str]:
        with self.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT contract_symbol
                    FROM torghut_options_subscription_state
                    WHERE tier = 'hot'
                    ORDER BY ranking_score DESC, contract_symbol ASC
                    LIMIT :limit
                    """
                ),
                {"limit": limit},
            )
            return [cast(str, row[0]) for row in rows]

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

    def count_active_contracts(self) -> int:
        with self.session() as session:
            return int(
                session.execute(
                    text(
                        "SELECT COUNT(*) FROM torghut_options_contract_catalog WHERE status = 'active'"
                    )
                ).scalar_one()
            )

    def count_hot_contracts(self) -> int:
        with self.session() as session:
            return int(
                session.execute(
                    text("SELECT COUNT(*) FROM torghut_options_subscription_state WHERE tier = 'hot'")
                ).scalar_one()
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

    def _dte_score(expiration_date: date) -> float:
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

    def _priority_score(underlying_symbol: str) -> float:
        return 1.0 if underlying_symbol in underlying_priority else 0.5

    def _score_or_default(values: dict[str, object], key: str, default: float) -> float:
        raw_value = values.get(key, default)
        try:
            return float(cast(int | float | str, raw_value))
        except (TypeError, ValueError, ArithmeticError):
            return default

    max_open_interest = max(int(row.get("open_interest") or 0) for row in active_contracts) or 1
    ranked: list[dict[str, Any]] = []
    for row in active_contracts:
        open_interest = int(row.get("open_interest") or 0)
        ranking_inputs = row.get("ranking_inputs")
        parsed_ranking_inputs: dict[str, object]
        if isinstance(ranking_inputs, str):
            try:
                loaded_ranking_inputs = json.loads(ranking_inputs)
            except json.JSONDecodeError:
                parsed_ranking_inputs = {}
            else:
                parsed_ranking_inputs = cast(dict[str, object], loaded_ranking_inputs) if isinstance(loaded_ranking_inputs, dict) else {}
        elif isinstance(ranking_inputs, dict):
            parsed_ranking_inputs = cast(dict[str, object], ranking_inputs)
        else:
            parsed_ranking_inputs = {}

        liquidity_score = min(open_interest / max_open_interest, 1.0)
        quote_recency_score = _score_or_default(parsed_ranking_inputs, "quote_recency_score", 0.5)
        trade_recency_score = _score_or_default(parsed_ranking_inputs, "trade_recency_score", 0.5)
        underlying_activity_score = _score_or_default(
            parsed_ranking_inputs,
            "underlying_activity_score",
            _priority_score(str(row["underlying_symbol"])),
        )
        dte_score = _dte_score(cast(date, row["expiration_date"]))
        moneyness_score = _score_or_default(parsed_ranking_inputs, "moneyness_score", _moneyness_score(row))

        ranking_score = (
            0.30 * liquidity_score
            + 0.20 * quote_recency_score
            + 0.15 * trade_recency_score
            + 0.15 * underlying_activity_score
            + 0.10 * dte_score
            + 0.10 * moneyness_score
        )

        ranked.append(
            {
                "contract_symbol": row["contract_symbol"],
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
                "provider_cap_generation": 0,
            }
        )

    ranked.sort(key=lambda row: (float(row["ranking_score"]), str(row["contract_symbol"])), reverse=True)
    hot_count = min(hot_cap, max(int(provider_cap_bootstrap * 0.8), 0))
    warm_count = min(warm_cap, hot_count * 5 if hot_count > 0 else warm_cap)

    for index, row in enumerate(ranked):
        if index < hot_count:
            row["tier"] = "hot"
        elif index < hot_count + warm_count:
            row["tier"] = "warm"
        else:
            row["tier"] = "cold"
    return ranked
