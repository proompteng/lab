#!/usr/bin/env python3
"""Flatten the Torghut paper account so runtime proof windows start clean."""

from __future__ import annotations

import json
import sys
from contextlib import nullcontext
from typing import Any, cast

from sqlalchemy.orm import Session

from app.alpaca_client import TorghutAlpacaClient
from app.snapshots import snapshot_account_and_positions
from app.trading.firewall import OrderFirewall

from .flatten_core import (
    DEFAULT_EXTENDED_HOURS_LIMIT_AWAY_BPS,
    DEFAULT_MAX_GROSS_MARKET_VALUE,
    DEFAULT_POLL_SECONDS,
    TERMINAL_CLEAN_STATUSES,
    _as_mapping,
    _decimal,
    _parse_args,
    _session_factory_from_env,
    _target_plan_readback_pending_clean_window_baseline_only,
    read_target_plan_clean_window_readback,
)
from .lineage_execution import flatten_paper_account_positions


def _facade_attr(name: str, fallback: Any) -> Any:
    facade = sys.modules.get("scripts.flatten_paper_account_positions")
    if facade is None:
        return fallback
    return getattr(facade, name, fallback)


def main() -> int:
    args = _parse_args()
    max_gross_market_value = _decimal(
        args.max_gross_market_value,
        default=DEFAULT_MAX_GROSS_MARKET_VALUE,
    )
    limit_away_bps = _decimal(
        args.limit_away_bps,
        default=DEFAULT_EXTENDED_HOURS_LIMIT_AWAY_BPS,
    )
    client_factory = _facade_attr("TorghutAlpacaClient", TorghutAlpacaClient)
    firewall_factory = _facade_attr("OrderFirewall", OrderFirewall)
    session_factory_from_env = _facade_attr(
        "_session_factory_from_env",
        _session_factory_from_env,
    )
    snapshot_writer = _facade_attr(
        "snapshot_account_and_positions",
        snapshot_account_and_positions,
    )
    flatten_positions = _facade_attr(
        "flatten_paper_account_positions",
        flatten_paper_account_positions,
    )
    client = client_factory(paper=True, base_url=str(args.paper_base_url or ""))
    firewall = firewall_factory(client)
    session_factory, session_engine, database_dsn_env = session_factory_from_env(
        str(args.database_dsn_env or "DB_DSN")
    )
    try:
        lineage_context = (
            session_factory() if args.persist_lineage else nullcontext(None)
        )
        with lineage_context as lineage_session:
            payload = flatten_positions(
                client=firewall,
                account_label=str(args.account_label or ""),
                expected_account_label=str(args.expected_account_label or ""),
                trading_mode=str(args.trading_mode or ""),
                apply=bool(args.apply),
                max_gross_market_value=max_gross_market_value,
                max_position_count=max(0, int(args.max_position_count)),
                extended_hours_limit=bool(args.extended_hours_limit),
                limit_away_bps=limit_away_bps,
                wait_flat_seconds=max(0.0, float(args.wait_flat_seconds or 0.0)),
                poll_seconds=max(0.1, float(args.poll_seconds or DEFAULT_POLL_SECONDS)),
                persist_lineage=bool(args.persist_lineage),
                lineage_session=cast(Session | None, lineage_session),
            )
        payload["database_dsn_env"] = database_dsn_env
        if args.persist_snapshot:
            if (
                payload["trading_mode"] == "paper"
                and payload["account_label"] == payload["expected_account_label"]
            ):
                with session_factory() as session:
                    snapshot = snapshot_writer(
                        session,
                        cast(Any, firewall),
                        str(args.account_label or ""),
                    )
                payload["position_snapshot_id"] = str(snapshot.id)
                payload["position_snapshot_as_of"] = snapshot.as_of.isoformat()
            else:
                payload["position_snapshot_skipped"] = (
                    "paper_account_label_or_mode_guard_failed"
                )
        if args.target_plan_readback_url or args.require_target_plan_readback_clean:
            readback = read_target_plan_clean_window_readback(
                url=str(args.target_plan_readback_url or ""),
                account_label=str(args.account_label or ""),
                snapshot_id=(
                    str(payload["position_snapshot_id"])
                    if payload.get("position_snapshot_id")
                    else None
                ),
                snapshot_as_of=(
                    str(payload["position_snapshot_as_of"])
                    if payload.get("position_snapshot_as_of")
                    else None
                ),
                timeout_seconds=max(
                    0.1,
                    float(args.target_plan_readback_timeout_seconds or 0.1),
                ),
            )
            payload["target_plan_readback"] = readback
            payload["target_plan_readback_required_clean"] = bool(
                args.require_target_plan_readback_clean
            )
            payload["target_plan_readback_clean"] = readback.get("state") == "clean"
            payload["target_plan_readback_pending_clean_window_baseline_allowed"] = (
                bool(args.allow_pending_clean_window_baseline_readback)
                and _target_plan_readback_pending_clean_window_baseline_only(
                    _as_mapping(readback)
                )
            )
    finally:
        if session_engine is not None:
            session_engine.dispose()
    if args.json:
        print(json.dumps(payload, sort_keys=True))
    else:
        print(
            f"status={payload['status']} positions={payload['position_count']} "
            f"submitted={payload['submitted_order_count']} blockers={','.join(payload['blockers'])}"
        )
    if payload["status"] not in TERMINAL_CLEAN_STATUSES:
        return 2
    if bool(payload.get("target_plan_readback_required_clean")) and not bool(
        payload.get("target_plan_readback_clean")
        or payload.get("target_plan_readback_pending_clean_window_baseline_allowed")
    ):
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
