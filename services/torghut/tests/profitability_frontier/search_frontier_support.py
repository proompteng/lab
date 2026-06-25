from __future__ import annotations

import io
import json
import sys
from argparse import Namespace
from collections import deque
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast
from unittest import TestCase
from unittest.mock import patch
from types import SimpleNamespace

import yaml

from app.trading.discovery.replay_tape import (
    build_source_query_digest,
    materialize_signal_tape,
)
from app.trading.models import SignalEnvelope
import scripts.search_consistent_profitability_frontier as frontier


class _GuardedSignalRow:
    def __init__(
        self,
        *,
        symbol: str,
        event_ts: datetime,
        seq: int,
    ) -> None:
        self.symbol = symbol
        self.seq = seq
        self._event_ts = event_ts
        self.raise_on_event_ts = False

    @property
    def event_ts(self) -> datetime:
        if self.raise_on_event_ts:
            raise AssertionError("cached iterator should use the prebuilt date index")
        return self._event_ts


def _authoritative_exact_replay_rows() -> list[dict[str, object]]:
    return [
        {
            "event_type": "decision",
            "executed_at": "2026-03-18T14:35:00+00:00",
            "decision_id": "decision-buy",
            "order_id": "order-buy",
            "symbol": "NVDA",
            "side": "buy",
        },
        {
            "event_type": "order_submitted",
            "executed_at": "2026-03-18T14:35:01+00:00",
            "decision_id": "decision-buy",
            "order_id": "order-buy",
            "symbol": "NVDA",
            "side": "buy",
        },
        {
            "event_type": "fill",
            "executed_at": "2026-03-18T14:35:02+00:00",
            "decision_id": "decision-buy",
            "order_id": "order-buy",
            "symbol": "NVDA",
            "side": "buy",
            "filled_qty": "1",
            "avg_fill_price": "100",
            "cost_amount": "0.10",
            "cost_basis": "local_replay_transaction_cost_model",
        },
        {
            "event_type": "decision",
            "executed_at": "2026-03-18T14:40:00+00:00",
            "decision_id": "decision-sell",
            "order_id": "order-sell",
            "symbol": "NVDA",
            "side": "sell",
        },
        {
            "event_type": "order_submitted",
            "executed_at": "2026-03-18T14:40:01+00:00",
            "decision_id": "decision-sell",
            "order_id": "order-sell",
            "symbol": "NVDA",
            "side": "sell",
        },
        {
            "event_type": "fill",
            "executed_at": "2026-03-18T14:40:02+00:00",
            "decision_id": "decision-sell",
            "order_id": "order-sell",
            "symbol": "NVDA",
            "side": "sell",
            "filled_qty": "1",
            "avg_fill_price": "101",
            "cost_amount": "0.10",
            "cost_basis": "local_replay_transaction_cost_model",
        },
    ]


def _authoritative_exact_replay_ledger_payload(
    *,
    rows: list[dict[str, object]] | None = None,
    fill_row_count: int = 2,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.exact_replay_ledger.rows.v1",
        "account_label": "TORGHUT_REPLAY",
        "execution_policy_hash": "policy-sha",
        "cost_model_hash": "cost-sha",
        "lineage_hash": "ledger-lineage-sha",
        "fill_row_count": fill_row_count,
        "runtime_ledger_rows": rows
        if rows is not None
        else _authoritative_exact_replay_rows(),
    }


__all__: tuple[str, ...] = (
    "Decimal",
    "Namespace",
    "Path",
    "SignalEnvelope",
    "SimpleNamespace",
    "TemporaryDirectory",
    "TestCase",
    "_GuardedSignalRow",
    "_authoritative_exact_replay_ledger_payload",
    "_authoritative_exact_replay_rows",
    "build_source_query_digest",
    "cast",
    "date",
    "datetime",
    "deque",
    "frontier",
    "io",
    "json",
    "materialize_signal_tape",
    "patch",
    "redirect_stderr",
    "redirect_stdout",
    "sys",
    "timedelta",
    "timezone",
    "yaml",
)
