"""Types and constants for deterministic intraday TSMOM replay."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import (
    date,
    datetime,
    timezone,
)
from decimal import Decimal
from pathlib import Path
from typing import (
    Any,
    Mapping,
)

from app.trading.economic_policy import DEFAULT_ECONOMIC_POLICY_PATH
from app.trading.models import (
    SignalEnvelope,
    StrategyDecision,
)

logging.getLogger("alembic").setLevel(logging.WARNING)

DEFAULT_CHUNK_MINUTES = 10

DEFAULT_START_EQUITY = Decimal("31590.02")

DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS = 30

DEFAULT_PROGRESS_LOG_INTERVAL_SECONDS = 15

logger = logging.getLogger(__name__)

_SHARED_POSITION_OWNER = "__shared__"

_FILL_LATENCY_BUCKETS_MS = (0, 50, 150, 250, 500, 1000)

_FILL_LATENCY_THRESHOLDS_MS = (50, 150, 250)

_EXACT_REPLAY_LEDGER_ROWS_SCHEMA_VERSION = "torghut.exact_replay_ledger.rows.v1"

_REPLAY_LEDGER_ACCOUNT_LABEL = "TORGHUT_REPLAY"

_REPLAY_COST_BASIS = "local_replay_transaction_cost_model"

_REPLAY_ADV_SOURCE = "observed_microbar_notional_by_symbol_day"

_REPLAY_LEDGER_SOURCE = "local_intraday_tsmom_replay"


def _resolve_repo_root(script_path: Path) -> Path:
    resolved = script_path.resolve()
    for candidate in (resolved.parent, *resolved.parents):
        if (candidate / "argocd").is_dir() and (
            candidate / "services" / "torghut"
        ).is_dir():
            return candidate
    for candidate in (resolved.parent, *resolved.parents):
        if (candidate / "app").is_dir() and (candidate / "scripts").is_dir():
            return candidate
    parents = resolved.parents
    return parents[3] if len(parents) > 3 else parents[-1]


_REPO_ROOT = _resolve_repo_root(Path(__file__))


def default_strategy_configmap_path() -> Path:
    if strategy_config_path := os.environ.get("TRADING_STRATEGY_CONFIG_PATH"):
        return Path(strategy_config_path)
    return _REPO_ROOT / "argocd/applications/torghut/strategy-configmap.yaml"


def _default_economic_policy_path() -> Path:
    configured_path = str(os.environ.get("TRADING_ECONOMIC_POLICY_PATH") or "").strip()
    return (
        Path(configured_path).expanduser()
        if configured_path
        else DEFAULT_ECONOMIC_POLICY_PATH
    )


def _default_economic_policy_expected_digest() -> str | None:
    return (
        str(os.environ.get("TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST") or "").strip()
        or None
    )


def _position_key(symbol: str, strategy_id: str) -> tuple[str, str]:
    return (symbol.strip().upper(), strategy_id.strip())


def _stable_json_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _file_sha256(path: Path | None) -> str | None:
    if path is None or not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _decimal_text_or_none(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return _decimal_text(value)


def _decimal_text(value: Decimal) -> str:
    return format(value, "f")


@dataclass(frozen=True)
class ReplayConfig:
    strategy_configmap_path: Path
    clickhouse_http_url: str
    clickhouse_username: str | None
    clickhouse_password: str | None
    start_date: date
    end_date: date
    chunk_minutes: int
    flatten_eod: bool
    start_equity: Decimal
    economic_policy_path: Path = field(default_factory=_default_economic_policy_path)
    economic_policy_expected_digest: str | None = field(
        default_factory=_default_economic_policy_expected_digest
    )
    symbols: tuple[str, ...] = ()
    replay_tape_path: Path | None = None
    replay_tape_manifest_path: Path | None = None
    allow_stale_tape: bool = False
    progress_log_interval_seconds: int = DEFAULT_PROGRESS_LOG_INTERVAL_SECONDS
    capture_traces: bool = False
    capture_trace_funnel: bool = False
    capture_exact_replay_ledger: bool = False
    force_position_isolation: bool = False
    clickhouse_query_timeout_seconds: int = DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS
    observation_cutoff: datetime | None = None


@dataclass
class PositionState:
    strategy_id: str
    qty: Decimal
    avg_entry_price: Decimal
    opened_at: datetime
    entry_cost_total: Decimal
    decision_at: datetime
    pending_entry: bool = False


@dataclass
class PendingOrder:
    decision: StrategyDecision
    created_at: datetime
    signal: SignalEnvelope


@dataclass(frozen=True)
class ReplayLedgerContext:
    account_label: str
    candidate_id: str
    candidate_identity: dict[str, Any]
    candidate_identity_hash: str
    execution_policy_hash: str
    cost_model_hash: str
    cost_lineage: dict[str, Any]
    cost_lineage_hash: str
    lineage_hash: str
    replay_data_hash: str | None
    economic_policy_digest: str


@dataclass(frozen=True)
class ReplayCostLineage:
    total_cost: Decimal
    notional: Decimal
    adv_notional: Decimal | None
    adv_source: str | None
    participation_rate: Decimal | None
    spread: Decimal | None
    volatility: Decimal | None
    spread_cost_bps: Decimal
    volatility_cost_bps: Decimal
    impact_cost_bps: Decimal
    commission_cost: Decimal
    commission_cost_bps: Decimal
    sec_fee_cost: Decimal
    taf_fee_cost: Decimal
    cat_fee_cost: Decimal
    regulatory_fee_cost: Decimal
    regulatory_fee_cost_bps: Decimal
    total_cost_bps: Decimal
    capacity_ok: bool
    warnings: tuple[str, ...]
    max_participation_rate: Decimal
    impact_bps_at_full_participation: Decimal
    impact_participation_exponent: Decimal


@dataclass
class ClosedTrade:
    symbol: str
    strategy_id: str
    decision_at: datetime
    opened_at: datetime
    closed_at: datetime
    qty: Decimal
    entry_price: Decimal
    exit_price: Decimal
    gross_pnl: Decimal
    net_pnl: Decimal
    exit_reason: str
