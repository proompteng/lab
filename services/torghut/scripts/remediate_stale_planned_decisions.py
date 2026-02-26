#!/usr/bin/env python
"""Remediate stale planned trade decisions without matching executions."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, cast
from zoneinfo import ZoneInfo

from sqlalchemy import exists, select

from app.db import SessionLocal
from app.models import Execution, TradeDecision, coerce_json_payload


def _parse_et_day(day: str) -> tuple[datetime, datetime]:
    parsed = datetime.strptime(day, "%Y-%m-%d")
    et = ZoneInfo("America/New_York")
    start_et = parsed.replace(tzinfo=et)
    end_et = start_et + timedelta(days=1)
    return start_et.astimezone(timezone.utc), end_et.astimezone(timezone.utc)


def _append_reason(row: TradeDecision, reason: str) -> None:
    raw_payload = row.decision_json
    payload: dict[str, Any]
    if isinstance(raw_payload, dict):
        payload = dict(cast(dict[str, Any], raw_payload))
    else:
        payload = {}
    existing = payload.get("risk_reasons")
    reasons: list[str]
    if isinstance(existing, list):
        reasons = [str(item) for item in existing]
    else:
        reasons = []
    reasons.append(reason)
    payload["risk_reasons"] = reasons
    row.decision_json = coerce_json_payload(payload)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Mark stale planned decisions as rejected when no execution exists by "
            "trade_decision_id or client_order_id hash."
        )
    )
    parser.add_argument(
        "--day-et",
        type=str,
        default=None,
        help="Optional ET trading day filter (YYYY-MM-DD).",
    )
    parser.add_argument(
        "--max-age-seconds",
        type=int,
        default=600,
        help="Minimum age in seconds for a planned decision to be considered stale.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=5000,
        help="Maximum number of rows to inspect/remediate in one run.",
    )
    parser.add_argument(
        "--reason-prefix",
        type=str,
        default="decision_timeout_unsubmitted_remediation",
        help="Prefix used for appended risk_reasons.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply remediation updates. Default is dry-run.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional path to write JSON audit output.",
    )
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    max_age_seconds = max(0, int(args.max_age_seconds))
    cutoff = now - timedelta(seconds=max_age_seconds)
    limit = max(1, min(int(args.limit), 50_000))

    window_start_utc: datetime | None = None
    window_end_utc: datetime | None = None
    if args.day_et:
        window_start_utc, window_end_utc = _parse_et_day(args.day_et)

    has_direct_execution = (
        select(Execution.id)
        .where(Execution.trade_decision_id == TradeDecision.id)
        .limit(1)
    )
    has_hash_execution = (
        select(Execution.id)
        .where(
            Execution.client_order_id == TradeDecision.decision_hash,
            Execution.alpaca_account_label == TradeDecision.alpaca_account_label,
        )
        .limit(1)
    )

    with SessionLocal() as session:
        query = (
            select(TradeDecision)
            .where(
                TradeDecision.status == "planned",
                TradeDecision.created_at <= cutoff,
                ~exists(has_direct_execution),
                ~exists(has_hash_execution),
            )
            .order_by(TradeDecision.created_at.asc())
            .limit(limit)
        )
        if window_start_utc is not None and window_end_utc is not None:
            query = query.where(
                TradeDecision.created_at >= window_start_utc,
                TradeDecision.created_at < window_end_utc,
            )

        rows = list(session.execute(query).scalars().all())
        remediated: list[dict[str, Any]] = []
        for row in rows:
            age_seconds = max(
                0, int((now - row.created_at).total_seconds()) if row.created_at else 0
            )
            reason = f"{args.reason_prefix}:{age_seconds}s"
            remediated.append(
                {
                    "id": str(row.id),
                    "strategy_id": str(row.strategy_id),
                    "symbol": row.symbol,
                    "account_label": row.alpaca_account_label,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                    "age_seconds": age_seconds,
                    "reason": reason,
                }
            )
            if not args.apply:
                continue
            row.status = "rejected"
            _append_reason(row, reason)
            session.add(row)

        if args.apply:
            session.commit()

    report = {
        "mode": "apply" if args.apply else "dry_run",
        "generated_at_utc": now.isoformat(),
        "day_et": args.day_et,
        "window_start_utc": window_start_utc.isoformat() if window_start_utc else None,
        "window_end_utc": window_end_utc.isoformat() if window_end_utc else None,
        "max_age_seconds": max_age_seconds,
        "limit": limit,
        "rows_matched": len(remediated),
        "rows_remediated": len(remediated) if args.apply else 0,
        "items": remediated,
    }
    payload = json.dumps(report, indent=2)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
