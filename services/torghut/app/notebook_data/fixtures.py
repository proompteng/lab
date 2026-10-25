"""Deterministic fixture evidence used only by explicit notebook CI mode."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Mapping

from .models import QueryResult, Record

FIXTURE_AS_OF = datetime(2026, 7, 17, 20, 0, tzinfo=timezone.utc)


def _flow_equities() -> list[Record]:
    rows: list[Record] = []
    for minute in range(60):
        event = FIXTURE_AS_OF - timedelta(minutes=59 - minute)
        for offset, symbol in enumerate(("AAPL", "MSFT", "SPY")):
            price = 180 + offset * 40 + minute * 0.04
            rows.append(
                {
                    "symbol": symbol,
                    "event_ts": event.isoformat(),
                    "ema12": price + 0.08,
                    "ema26": price - 0.05,
                    "rsi14": 45 + ((minute + offset * 5) % 25),
                    "vwap_session": price - 0.02,
                    "latest_ingest_ts": (event + timedelta(seconds=5)).isoformat(),
                    "source_watermark": FIXTURE_AS_OF.isoformat(),
                }
            )
    return rows


def _flow_options() -> list[Record]:
    rows: list[Record] = []
    for minute in range(60):
        event = FIXTURE_AS_OF - timedelta(minutes=59 - minute)
        for offset, symbol in enumerate(("AAPL", "SPY")):
            rows.append(
                {
                    "underlying_symbol": symbol,
                    "event_ts": event.isoformat(),
                    "atm_iv": 0.22 + offset * 0.03 + minute * 0.0001,
                    "call_put_skew_25d": -0.015 + offset * 0.004,
                    "snapshot_coverage_ratio": 0.94 - offset * 0.02,
                    "hot_contract_coverage_ratio": 0.91 - offset * 0.02,
                    "feature_quality_status": "ok",
                    "latest_ingest_ts": (event + timedelta(seconds=4)).isoformat(),
                    "source_watermark": FIXTURE_AS_OF.isoformat(),
                }
            )
    return rows


def _flow_hyperliquid() -> list[Record]:
    rows: list[Record] = []
    for minute in range(30):
        event = FIXTURE_AS_OF - timedelta(minutes=29 - minute)
        for offset, coin in enumerate(("BTC", "ETH")):
            rows.append(
                {
                    "network": "mainnet",
                    "market_id": coin,
                    "coin": coin,
                    "dex": "hyperliquid",
                    "interval": "1m",
                    "event_ts": event.isoformat(),
                    "price": 64_000 + offset * -60_000 + minute * (8 + offset),
                    "regime": "trend" if minute > 14 else "range",
                    "source_lag_seconds": 2 + offset,
                    "momentum_5m_bps": minute - 15,
                    "volatility_bps": 18 + offset * 4,
                    "spread_bps": 0.8 + offset * 0.3,
                    "latest_ingest_ts": (event + timedelta(seconds=3)).isoformat(),
                    "source_watermark": FIXTURE_AS_OF.isoformat(),
                }
            )
    return rows


def _status() -> Record:
    return {
        "service": "torghut",
        "build": {
            "version": "fixture",
            "commit": "fixture-commit",
            "image_digest": "sha256:fixture",
        },
        "action_authority": {
            "evaluated_at": FIXTURE_AS_OF.isoformat(),
            "service_healthy": False,
            "entry_allowed": False,
            "reduce_only_allowed": False,
            "recovery_degraded": True,
            "reason_codes": {
                "service": ["scheduler_success_stale"],
                "entry": ["scheduler_success_stale", "mainnet_route_unavailable"],
                "reduce_only": ["mainnet_route_unavailable"],
                "recovery": ["scheduler_success_stale"],
            },
        },
        "live_submission_gate": {
            "allowed": False,
            "new_exposure_allowed": True,
            "blocked_reasons": ["scheduler_success_stale"],
        },
        "execution": {"allowed": False, "reason_codes": ["mainnet_route_unavailable"]},
        "runtime_ledger": {
            "status": "degraded",
            "bucket_count": 0,
            "reason_codes": ["runtime_ledger_missing"],
        },
        "broker_economic_ledger": {
            "state": "current",
            "current": True,
            "reconciled": True,
            "accounting_parity_satisfied": True,
            "capital_authority": False,
            "reason_codes": ["capital_authority_not_granted"],
            "tigerbeetle_economic_parity": {
                "parity": True,
                "capital_authority": False,
                "blockers": [],
            },
        },
        "tigerbeetle_ledger": {
            "ok": True,
            "reconciliation_ok": True,
            "capital_authority": False,
            "reason_codes": [],
        },
        "capital_controls": {
            "new_exposure_allowed": True,
            "ledger_state": "current",
            "ledger_reason": None,
        },
        "market_context": {"status": "market_closed", "market_session_open": False},
        "signal_continuity": {
            "market_session_open": False,
            "last_state": "expected_idle",
        },
    }


def fixture_query(
    query_identifier: str,
    parameters: Mapping[str, object],
    *,
    row_limit: int,
) -> QueryResult:
    del parameters
    rows: list[Record]
    if query_identifier == "flow.equities":
        rows = _flow_equities()
    elif query_identifier == "flow.options":
        rows = _flow_options()
    elif query_identifier == "flow.hyperliquid":
        rows = _flow_hyperliquid()
    elif query_identifier == "lifecycle.decisions":
        rows = [
            {
                "strategy_id": "11111111-1111-1111-1111-111111111111",
                "bucket_start": (FIXTURE_AS_OF - timedelta(days=day)).isoformat(),
                "status": status,
                "decision_count": count,
                "last_activity_at": FIXTURE_AS_OF.isoformat(),
                "source_watermark": FIXTURE_AS_OF.isoformat(),
            }
            for day in range(5)
            for status, count in (
                ("filled", 18 + day),
                ("rejected", 7 + day),
                ("blocked", 4),
            )
        ]
    elif query_identifier == "lifecycle.executions":
        rows = [
            {
                "strategy_id": "11111111-1111-1111-1111-111111111111",
                "symbol": "AAPL",
                "status": "filled",
                "execution_count": 42,
                "unlinked_execution_count": 0,
                "linked_execution_count": 42,
                "tca_count": 42,
                "filled_qty": 84,
                "last_activity_at": FIXTURE_AS_OF.isoformat(),
                "source_watermark": FIXTURE_AS_OF.isoformat(),
            },
            {
                "strategy_id": "unlinked",
                "symbol": "SPY",
                "status": "canceled",
                "execution_count": 1,
                "unlinked_execution_count": 1,
                "linked_execution_count": 0,
                "tca_count": 0,
                "filled_qty": 0,
                "last_activity_at": FIXTURE_AS_OF.isoformat(),
                "source_watermark": FIXTURE_AS_OF.isoformat(),
            },
        ]
    elif query_identifier == "lifecycle.rejections":
        rows = [
            {
                "source": "equities",
                "account_label": "paper",
                "symbol": symbol,
                "reject_reason": reason,
                "rejected_signal_count": count,
                "last_activity_at": FIXTURE_AS_OF.isoformat(),
                "source_watermark": FIXTURE_AS_OF.isoformat(),
            }
            for symbol, reason, count in (
                ("AAPL", "spread_too_wide", 12),
                ("SPY", "risk_gate", 7),
            )
        ]
    elif query_identifier == "execution.tca":
        rows = [
            {
                "execution_id": f"00000000-0000-0000-0000-{index:012d}",
                "trade_decision_id": f"10000000-0000-0000-0000-{index:012d}",
                "strategy_id": "11111111-1111-1111-1111-111111111111",
                "account_label": "paper",
                "symbol": "AAPL" if index % 2 == 0 else "SPY",
                "side": "buy" if index % 2 == 0 else "sell",
                "filled_qty": 2,
                "slippage_bps": (index % 9) - 4,
                "expected_shortfall_bps_p50": 1.5,
                "expected_shortfall_bps_p95": 4.5,
                "realized_shortfall_bps": 1 + (index % 7),
                "divergence_bps": (index % 7) - 1.5,
                "computed_at": (FIXTURE_AS_OF - timedelta(hours=index)).isoformat(),
                "source_watermark": FIXTURE_AS_OF.isoformat(),
            }
            for index in range(48)
        ]
    elif query_identifier == "execution.ledger":
        rows = [
            {
                "bucket_day": (FIXTURE_AS_OF - timedelta(days=60 - day)).isoformat(),
                "observed_stage": "paper",
                "account_label": "paper",
                "strategy_label": "fixture-strategy",
                "fill_count": 5,
                "decision_count": 12,
                "filled_notional": 10_000,
                "gross_strategy_pnl": 20 + day,
                "cost_amount": 3,
                "net_strategy_pnl_after_costs": 17 + day,
                "latest_bucket_ended_at": (
                    FIXTURE_AS_OF - timedelta(days=60 - day)
                ).isoformat(),
                "source_watermark": (FIXTURE_AS_OF - timedelta(days=31)).isoformat(),
            }
            for day in range(30)
        ]
    elif query_identifier in {"flow.status", "execution.status", "capital.status"}:
        rows = [_status()]
    else:
        raise KeyError(f"no fixture for query {query_identifier}")
    selected = tuple(rows[:row_limit])
    return QueryResult(selected, FIXTURE_AS_OF, len(rows) > row_limit)
