"""Persistence operations for options subscription-state reconciliation."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
import json
from typing import cast

from sqlalchemy import text
from sqlalchemy.orm import Session


_DEACTIVATION_BATCH_SIZE = 1_000


@dataclass(frozen=True)
class SubscriptionReconcileResult:
    hot_count: int
    warm_count: int
    changed_count: int
    deactivated_count: int


def load_live_subscription_candidates(session: Session) -> list[dict[str, object]]:
    """Return only persisted hot/warm rows eligible to seed live ranking."""

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
                   subs.ranking_score,
                   COALESCE(subs.ranking_inputs, '{}'::JSONB) AS ranking_inputs,
                   subs.tier,
                   subs.desired_channels,
                   subs.provider_cap_generation
            FROM torghut_options_subscription_state AS subs
            JOIN torghut_options_contract_catalog AS catalog
              ON catalog.contract_symbol = subs.contract_symbol
            WHERE catalog.status = 'active'
              AND subs.tier IN ('hot', 'warm')
            ORDER BY subs.ranking_score DESC, catalog.contract_symbol ASC
            """
        )
    ).mappings()
    return [dict(row) for row in rows]


def load_non_off_subscription_symbols(session: Session) -> set[str]:
    """Return every symbol eligible for final-cycle cleanup."""

    rows = session.execute(
        text(
            """
            SELECT contract_symbol
            FROM torghut_options_subscription_state
            WHERE tier IS DISTINCT FROM 'off'
            """
        )
    )
    return {cast(str, row[0]) for row in rows}


def reconcile_subscription_state(
    session: Session,
    *,
    ranked_rows: list[dict[str, object]],
    deactivate_symbols: Iterable[str],
    observed_at: datetime,
) -> SubscriptionReconcileResult:
    """Apply one conditional desired-state upsert and explicit deactivation set."""

    desired_rows, desired_symbols, hot_count, warm_count = _desired_rows(ranked_rows)
    explicit_deactivations = sorted(
        {
            str(contract_symbol)
            for contract_symbol in deactivate_symbols
            if str(contract_symbol)
        }
        - desired_symbols
    )
    changed_count = 0
    deactivated_count = 0
    with session.begin():
        if desired_rows:
            result = session.execute(
                text(
                    """
                    WITH desired AS (
                      SELECT item ->> 'contract_symbol' AS contract_symbol,
                             CAST(item ->> 'ranking_score' AS DOUBLE PRECISION) AS ranking_score,
                             COALESCE(item -> 'ranking_inputs', '{}'::JSONB) AS ranking_inputs,
                             item ->> 'tier' AS tier,
                             ARRAY(
                               SELECT jsonb_array_elements_text(
                                 COALESCE(item -> 'desired_channels', '[]'::JSONB)
                               )
                             ) AS desired_channels,
                             CAST(item ->> 'provider_cap_generation' AS BIGINT) AS provider_cap_generation
                      FROM jsonb_array_elements(CAST(:ranked_rows AS JSONB)) AS source(item)
                    )
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
                    SELECT contract_symbol,
                      ranking_score,
                      ranking_inputs,
                      tier,
                      desired_channels,
                      ARRAY[]::TEXT[],
                      provider_cap_generation,
                      :last_ranked_ts
                    FROM desired
                    ON CONFLICT (contract_symbol) DO UPDATE
                    SET ranking_score = EXCLUDED.ranking_score,
                        ranking_inputs = EXCLUDED.ranking_inputs,
                        tier = EXCLUDED.tier,
                        desired_channels = EXCLUDED.desired_channels,
                        provider_cap_generation = EXCLUDED.provider_cap_generation,
                        last_ranked_ts = EXCLUDED.last_ranked_ts
                    WHERE (
                      torghut_options_subscription_state.ranking_score,
                      torghut_options_subscription_state.ranking_inputs,
                      torghut_options_subscription_state.tier,
                      torghut_options_subscription_state.desired_channels,
                      torghut_options_subscription_state.provider_cap_generation
                    ) IS DISTINCT FROM (
                      EXCLUDED.ranking_score,
                      EXCLUDED.ranking_inputs,
                      EXCLUDED.tier,
                      EXCLUDED.desired_channels,
                      EXCLUDED.provider_cap_generation
                    )
                    -- Per-row freshness means material assignment change. Successful
                    -- cycle freshness is recorded once in the catalog watermark.
                    """
                ),
                {
                    "ranked_rows": _coerce_json(desired_rows),
                    "last_ranked_ts": observed_at,
                },
            )
            changed_count = max(int(getattr(result, "rowcount", 0) or 0), 0)
        for offset in range(0, len(explicit_deactivations), _DEACTIVATION_BATCH_SIZE):
            symbols = explicit_deactivations[offset : offset + _DEACTIVATION_BATCH_SIZE]
            result = session.execute(
                text(
                    """
                    UPDATE torghut_options_subscription_state
                    SET tier = 'off',
                        last_ranked_ts = :last_ranked_ts
                    WHERE contract_symbol = ANY(:symbols)
                      AND tier IS DISTINCT FROM 'off'
                    """
                ),
                {
                    "symbols": symbols,
                    "last_ranked_ts": observed_at,
                },
            )
            deactivated_count += max(int(getattr(result, "rowcount", 0) or 0), 0)
    return SubscriptionReconcileResult(
        hot_count=hot_count,
        warm_count=warm_count,
        changed_count=changed_count,
        deactivated_count=deactivated_count,
    )


def _desired_rows(
    ranked_rows: list[dict[str, object]],
) -> tuple[list[dict[str, object]], set[str], int, int]:
    desired_rows: list[dict[str, object]] = []
    desired_symbols: set[str] = set()
    hot_count = 0
    warm_count = 0
    for row in ranked_rows:
        contract_symbol = str(row["contract_symbol"])
        if contract_symbol in desired_symbols:
            raise ValueError(
                f"duplicate subscription contract symbol: {contract_symbol}"
            )
        desired_symbols.add(contract_symbol)
        tier = cast(str, row["tier"])
        if tier == "hot":
            hot_count += 1
        elif tier == "warm":
            warm_count += 1
        desired_rows.append(
            {
                "contract_symbol": contract_symbol,
                "ranking_score": float(cast(int | float | str, row["ranking_score"])),
                "ranking_inputs": row["ranking_inputs"],
                "tier": tier,
                "desired_channels": list(
                    cast(Iterable[object], row["desired_channels"])
                ),
                "provider_cap_generation": int(
                    cast(int | float | str, row["provider_cap_generation"])
                ),
            }
        )
    return desired_rows, desired_symbols, hot_count, warm_count


def _coerce_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
