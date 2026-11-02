"""Catalog-cycle watermark persistence for the options lane."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
import json

from sqlalchemy import text
from sqlalchemy.orm import Session


@dataclass(frozen=True)
class CatalogCycleSummary:
    observed_at: datetime
    page_count: int
    contract_count: int
    catalog_changed_count: int
    transition_count: int
    hot_count: int
    warm_count: int
    subscription_changed_count: int
    subscription_deactivated_count: int


def record_catalog_cycle_success(
    session: Session, summary: CatalogCycleSummary
) -> None:
    """Record one successful complete scan without rewriting stable subscriptions."""

    metadata = asdict(summary)
    metadata.pop("observed_at")
    with session.begin():
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
                  'catalog',
                  'universe',
                  'live',
                  NULL,
                  :observed_at,
                  :observed_at,
                  NULL,
                  0,
                  CAST(:metadata AS JSONB)
                )
                ON CONFLICT (component, scope_type, scope_key) DO UPDATE
                SET cursor = NULL,
                    last_event_ts = EXCLUDED.last_event_ts,
                    last_success_ts = EXCLUDED.last_success_ts,
                    next_eligible_ts = NULL,
                    retry_count = 0,
                    metadata = EXCLUDED.metadata
                """
            ),
            {
                "observed_at": summary.observed_at,
                "metadata": json.dumps(
                    metadata,
                    sort_keys=True,
                    separators=(",", ":"),
                    default=str,
                ),
            },
        )
