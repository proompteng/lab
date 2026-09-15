"""Runtime-closure bundle helpers for MLX autoresearch outputs."""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.autoresearch import (
    StrategyAutoresearchProgram,
)
from app.trading.discovery.objectives import (
    ObjectiveVetoPolicy,
)


def discover_runtime_root(source_path: Path) -> Path:
    resolved = source_path.resolve()
    search_start = resolved if resolved.is_dir() else resolved.parent
    ancestors = (search_start, *search_start.parents)
    for candidate in ancestors:
        if (candidate / ".git").exists() and (
            candidate / "services" / "torghut"
        ).exists():
            return candidate
    for candidate in ancestors:
        if (
            candidate
            / "argocd"
            / "applications"
            / "torghut"
            / "strategy-configmap.yaml"
        ).exists():
            return candidate
    for candidate in ancestors:
        if (candidate / "app" / "main.py").exists() and (
            candidate / "scripts"
        ).exists():
            return candidate
    if tuple(resolved.parts[-4:]) == (
        "app",
        "trading",
        "discovery",
        "runtime_closure.py",
    ):
        return resolved.parents[3]
    return search_start


REPO_ROOT = discover_runtime_root(Path(__file__))

MIN_SIMULATION_PARITY_SAMPLE_COUNT = 120

MAX_SIMULATION_LIVE_FILL_ERROR_BPS = Decimal("8")

MAX_ADVERSE_SELECTION_ERROR_BPS = Decimal("8")

EXECUTION_REALISM_PASS_STATUSES = frozenset(
    {
        "pass",
        "passed",
        "within_budget",
        "within_tolerance",
    }
)


def to_string(value: Any) -> str:
    return str(value or "").strip()


def to_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping_value = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping_value.items()}


def to_mapping_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    resolved: list[dict[str, Any]] = []
    for item in cast(list[Any], value):
        mapping = to_mapping(item)
        if mapping:
            resolved.append(mapping)
    return resolved


def to_string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    resolved: list[str] = []
    for item in cast(list[Any], value):
        normalized = to_string(item).upper()
        if normalized:
            resolved.append(normalized)
    return tuple(resolved)


def to_int(value: Any) -> int:
    try:
        return int(float(str(value or 0)))
    except (TypeError, ValueError):
        return 0


def to_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def to_decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal(default)


def decimal_to_string(value: Decimal) -> str:
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered or "0"


def optional_decimal_to_string(value: Any) -> str:
    if value is None or to_string(value) == "":
        return ""
    return decimal_to_string(to_decimal(value))


def p10(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    ordered = sorted(values)
    index = int((len(ordered) - 1) * 0.10)
    return ordered[index]


MICROBAR_PORTFOLIO_SIGNAL_SETTINGS: dict[str, dict[str, str]] = {
    "open_window_continuation": {
        "rank_feature": "cross_section_session_open_rank",
        "selection_mode": "continuation",
    },
    "open_window_reversal": {
        "rank_feature": "cross_section_session_open_rank",
        "selection_mode": "reversal",
    },
    "vwap_close_continuation": {
        "rank_feature": "cross_section_vwap_w5m_rank",
        "selection_mode": "continuation",
    },
    "vwap_close_reversal": {
        "rank_feature": "cross_section_vwap_w5m_rank",
        "selection_mode": "reversal",
    },
    "prev_day_open45_periodicity": {
        "rank_feature": "cross_section_prev_day_open45_return_rank",
        "selection_mode": "continuation",
    },
    "overnight_gap_reversal": {
        "rank_feature": "cross_section_prev_session_close_rank",
        "selection_mode": "reversal",
    },
    "opening_window_prev_close_reversal": {
        "rank_feature": "cross_section_opening_window_return_from_prev_close_rank",
        "selection_mode": "reversal",
    },
    "intraday_tug_of_war_reversal": {
        "rank_feature": "cross_section_prev_session_close_rank",
        "selection_mode": "reversal",
    },
}

MICROBAR_PORTFOLIO_RUNTIME_PARAM_KEYS: tuple[str, ...] = (
    "entry_window_minutes",
    "gate_feature",
    "gate_min",
    "gate_max",
    "max_pair_legs",
    "entry_cooldown_seconds",
    "long_stop_loss_bps",
    "short_stop_loss_bps",
    "long_trailing_stop_activation_profit_bps",
    "long_trailing_stop_drawdown_bps",
    "short_trailing_stop_activation_profit_bps",
    "short_trailing_stop_drawdown_bps",
    "max_hold_seconds",
    "max_session_negative_exit_bps",
    "max_stop_loss_exits_per_session",
    "stop_loss_lockout_seconds",
)

PORTFOLIO_POLICY_REF_PREFIX = "torghut.autoresearch.portfolio"


def json_dumps(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload, indent=2, sort_keys=True)


def write_json(path: Path, payload: Mapping[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_dumps(payload) + "\n", encoding="utf-8")
    return path


def sha256_path(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_json(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def git_output(*args: str) -> str:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return ""
    return completed.stdout.strip()


def runtime_run_context(*, root: Path, runner_run_id: str) -> dict[str, str]:
    head = git_output("rev-parse", "--abbrev-ref", "HEAD") or "unknown"
    return {
        "repository": "proompteng/lab",
        "base": "main",
        "head": head,
        "artifact_path": str(root),
        "run_id": runner_run_id,
        "design_doc": "docs/torghut/design-system/v6/71-torghut-whitepaper-autoresearch-profit-target-strategy-factory-2026-04-21.md",
    }


@dataclass(frozen=True)
class RuntimeClosureExecutionContext:
    strategy_configmap_path: Path
    clickhouse_http_url: str
    clickhouse_username: str | None
    clickhouse_password: str | None
    start_equity: Decimal
    chunk_minutes: int
    symbols: tuple[str, ...] = ()
    progress_log_interval_seconds: int = 30
    shadow_validation_artifact_path: Path | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "strategy_configmap_path": str(self.strategy_configmap_path),
            "clickhouse_http_url": self.clickhouse_http_url,
            "clickhouse_username": self.clickhouse_username,
            "start_equity": str(self.start_equity),
            "chunk_minutes": self.chunk_minutes,
            "symbols": list(self.symbols),
            "progress_log_interval_seconds": self.progress_log_interval_seconds,
            "shadow_validation_artifact_path": (
                str(self.shadow_validation_artifact_path)
                if self.shadow_validation_artifact_path is not None
                else None
            ),
        }


def date_from_iso(value: str) -> date:
    return date.fromisoformat(value)


def daily_filled_notional(payload: Mapping[str, Any]) -> dict[str, Decimal]:
    daily_payload = to_mapping(payload.get("daily"))
    resolved: dict[str, Decimal] = {}
    for day, value in daily_payload.items():
        item = to_mapping(value)
        resolved[day] = Decimal(str(item.get("filled_notional", "0")))
    return resolved


def daily_liquidity_notional(payload: Mapping[str, Any]) -> dict[str, Decimal]:
    daily_payload = to_mapping(payload.get("daily"))
    resolved: dict[str, Decimal] = {}
    for day, value in daily_payload.items():
        item = to_mapping(value)
        raw_value = (
            item.get("adv_notional")
            or item.get("daily_adv_notional")
            or item.get("depth_notional")
            or item.get("fillable_depth_notional")
        )
        if raw_value is not None:
            resolved[day] = to_decimal(raw_value)
    return resolved


def runtime_execution_realism_summary(payload: Mapping[str, Any]) -> dict[str, Any]:
    evidence = to_mapping(payload.get("execution_realism"))

    def payload_value(name: str) -> object:
        value = evidence.get(name)
        return payload.get(name) if value is None else value

    lob_event_stream_event_count = to_int(
        payload_value("lob_event_stream_event_count")
        or payload_value("lob_event_stream_sample_count")
    )
    fill_outcome_count = to_int(
        payload_value("fill_outcome_count")
        or payload_value("fill_outcome_sample_count")
    )
    live_paper_parity_sample_count = to_int(
        payload_value("live_paper_parity_sample_count")
        or payload_value("simulation_live_parity_sample_count")
    )
    live_paper_parity_status = to_string(
        payload_value("live_paper_parity_status")
        or payload_value("simulation_live_parity_status")
    )
    summary: dict[str, Any] = {
        "daily_lob_event_stream_count": to_mapping(
            payload_value("daily_lob_event_stream_count")
        ),
        "daily_fill_outcome_count": to_mapping(
            payload_value("daily_fill_outcome_count")
        ),
        "lob_event_stream_event_count": lob_event_stream_event_count,
        "lob_event_stream_sample_count": lob_event_stream_event_count,
        "fill_outcome_count": fill_outcome_count,
        "fill_outcome_sample_count": fill_outcome_count,
        "live_paper_parity_status": live_paper_parity_status,
        "simulation_live_parity_status": live_paper_parity_status,
        "live_paper_parity_sample_count": live_paper_parity_sample_count,
        "simulation_live_parity_sample_count": live_paper_parity_sample_count,
        "live_paper_parity_max_fill_error_bps": optional_decimal_to_string(
            payload_value("live_paper_parity_max_fill_error_bps")
        ),
        "live_paper_parity_max_adverse_selection_error_bps": optional_decimal_to_string(
            payload_value("live_paper_parity_max_adverse_selection_error_bps")
            or payload_value("adverse_selection_error_bps")
        ),
        "implementation_trace_ref": to_string(
            payload_value("implementation_trace_ref")
        ),
        "lob_event_stream_artifact_ref": to_string(
            payload_value("lob_event_stream_artifact_ref")
        ),
        "fill_outcomes_artifact_ref": to_string(
            payload_value("fill_outcomes_artifact_ref")
        ),
        "simulation_live_parity_artifact_ref": to_string(
            payload_value("simulation_live_parity_artifact_ref")
        ),
    }
    missing_evidence = execution_realism_missing_evidence(summary)
    summary["execution_realism_status"] = (
        "complete" if not missing_evidence else "missing_required_evidence"
    )
    summary["execution_realism_missing_evidence"] = list(missing_evidence)
    return summary


def execution_realism_missing_evidence(summary: Mapping[str, Any]) -> tuple[str, ...]:
    missing: list[str] = []
    parity_status = to_string(
        summary.get("live_paper_parity_status")
        or summary.get("simulation_live_parity_status")
    )
    parity_sample_count = max(
        to_int(summary.get("live_paper_parity_sample_count")),
        to_int(summary.get("simulation_live_parity_sample_count")),
    )
    if (
        max(
            to_int(summary.get("lob_event_stream_event_count")),
            to_int(summary.get("lob_event_stream_sample_count")),
        )
        <= 0
    ):
        missing.append("lob_event_stream_evidence_missing")
    if to_string(summary.get("lob_event_stream_artifact_ref")) == "":
        missing.append("lob_event_stream_artifact_ref_missing")
    if (
        max(
            to_int(summary.get("fill_outcome_count")),
            to_int(summary.get("fill_outcome_sample_count")),
        )
        <= 0
    ):
        missing.append("fill_outcome_evidence_missing")
    if to_string(summary.get("fill_outcomes_artifact_ref")) == "":
        missing.append("fill_outcomes_artifact_ref_missing")
    if parity_sample_count <= 0:
        missing.append("live_paper_parity_evidence_missing")
    if to_string(summary.get("simulation_live_parity_artifact_ref")) == "":
        missing.append("simulation_live_parity_artifact_ref_missing")
    if parity_status not in EXECUTION_REALISM_PASS_STATUSES:
        missing.append("live_paper_parity_status_not_within_budget")
    if parity_sample_count < MIN_SIMULATION_PARITY_SAMPLE_COUNT:
        missing.append("live_paper_parity_sample_count_below_minimum")
    fill_error_bps = summary.get("live_paper_parity_max_fill_error_bps")
    adverse_selection_error_bps = summary.get(
        "live_paper_parity_max_adverse_selection_error_bps"
    )
    missing.extend(
        live_paper_parity_error_evidence(
            fill_error_bps=fill_error_bps,
            adverse_selection_error_bps=adverse_selection_error_bps,
        )
    )
    if (
        to_string(
            summary.get("implementation_trace_ref")
            or summary.get("runtime_implementation_artifact_ref")
        )
        == ""
    ):
        missing.append("implementation_trace_evidence_missing")
    return tuple(missing)


def live_paper_parity_error_evidence(
    *,
    fill_error_bps: Any,
    adverse_selection_error_bps: Any,
) -> tuple[str, ...]:
    missing: list[str] = []
    if to_string(fill_error_bps) == "":
        missing.append("live_paper_parity_fill_error_evidence_missing")
    elif to_decimal(fill_error_bps) > MAX_SIMULATION_LIVE_FILL_ERROR_BPS:
        missing.append("live_paper_parity_fill_error_above_maximum")
    if to_string(adverse_selection_error_bps) == "":
        missing.append("live_paper_parity_adverse_selection_error_evidence_missing")
    elif to_decimal(adverse_selection_error_bps) > MAX_ADVERSE_SELECTION_ERROR_BPS:
        missing.append("live_paper_parity_adverse_selection_error_above_maximum")
    return tuple(missing)


def max_drawdown_from_daily_net(daily_net: Mapping[str, Decimal]) -> Decimal:
    equity = Decimal("0")
    peak = Decimal("0")
    max_drawdown = Decimal("0")
    for trading_day in sorted(daily_net):
        equity += daily_net[trading_day]
        if equity > peak:
            peak = equity
        drawdown = peak - equity
        if drawdown > max_drawdown:
            max_drawdown = drawdown
    return max_drawdown


def rolling_lower_bound(daily_net: Mapping[str, Decimal], *, window: int) -> Decimal:
    ordered = [daily_net[key] for key in sorted(daily_net)]
    if not ordered:
        return Decimal("0")
    if len(ordered) < window:
        return sum(ordered, Decimal("0")) / Decimal(len(ordered))
    values: list[Decimal] = []
    for index in range(len(ordered) - window + 1):
        sample = ordered[index : index + window]
        values.append(sum(sample, Decimal("0")) / Decimal(window))
    return min(values) if values else Decimal("0")


def max_best_day_share_of_total_pnl(
    *, daily_net: Mapping[str, Decimal], total_net_pnl: Decimal
) -> Decimal:
    if total_net_pnl <= 0:
        return Decimal("1")
    best_positive_day = max(
        (value for value in daily_net.values() if value > 0), default=Decimal("0")
    )
    if best_positive_day <= 0:
        return Decimal("0")
    return best_positive_day / total_net_pnl


def objective_veto_policy(program: StrategyAutoresearchProgram) -> ObjectiveVetoPolicy:
    return ObjectiveVetoPolicy(
        required_min_active_day_ratio=program.objective.min_active_day_ratio,
        required_min_daily_notional=program.objective.min_daily_notional,
        required_max_best_day_share=program.objective.max_best_day_share,
        required_max_worst_day_loss=program.objective.max_worst_day_loss,
        required_max_drawdown=program.objective.max_drawdown,
        required_min_regime_slice_pass_rate=program.objective.min_regime_slice_pass_rate,
    )


def runtime_family(best_candidate: Mapping[str, Any]) -> str:
    return (
        to_string(best_candidate.get("runtime_family"))
        or to_string(best_candidate.get("family"))
        or to_string(best_candidate.get("family_template_id"))
    )


def runtime_strategy_name(best_candidate: Mapping[str, Any]) -> str:
    return to_string(best_candidate.get("runtime_strategy_name")) or to_string(
        best_candidate.get("strategy_name")
    )


def candidate_params(best_candidate: Mapping[str, Any]) -> dict[str, Any]:
    direct = to_mapping(best_candidate.get("candidate_params"))
    if direct:
        return direct
    replay_config = to_mapping(best_candidate.get("replay_config"))
    return to_mapping(replay_config.get("params"))


def candidate_strategy_overrides(best_candidate: Mapping[str, Any]) -> dict[str, Any]:
    direct = to_mapping(best_candidate.get("candidate_strategy_overrides"))
    if direct:
        return direct
    replay_config = to_mapping(best_candidate.get("replay_config"))
    return to_mapping(replay_config.get("strategy_overrides"))


def disable_other_strategies(best_candidate: Mapping[str, Any]) -> bool:
    if "disable_other_strategies" in best_candidate:
        return bool(best_candidate.get("disable_other_strategies"))
    replay_config = to_mapping(best_candidate.get("replay_config"))
    if "disable_other_strategies" in replay_config:
        return bool(replay_config.get("disable_other_strategies"))
    return True


def portfolio_payload(best_candidate: Mapping[str, Any]) -> dict[str, Any]:
    direct = to_mapping(best_candidate.get("portfolio"))
    if direct:
        return direct
    replay_config = to_mapping(best_candidate.get("replay_config"))
    return to_mapping(replay_config.get("portfolio"))


def text_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(str(item) for item in cast(list[Any], value) if str(item).strip())
