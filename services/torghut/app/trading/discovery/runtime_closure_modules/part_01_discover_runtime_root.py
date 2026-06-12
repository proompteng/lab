# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

import yaml

from app.trading.autonomy.policy_checks import (
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
)
from app.trading.discovery.autoresearch import (
    StrategyAutoresearchProgram,
    candidate_meets_objective,
)
from app.trading.discovery.decomposition import (
    build_replay_decomposition,
    max_family_contribution_share,
    max_symbol_concentration_share,
    regime_slice_pass_rate,
)
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.objectives import (
    ObjectiveVetoPolicy,
    build_scorecard,
    evaluate_vetoes,
)
from app.trading.discovery.portfolio_candidates import PortfolioCandidateSpec
from app.trading.evidence_receipts import build_portfolio_proof_receipt
from app.trading.costs import BPS_SCALE, CostModelConfig, participation_power
from app.trading.hypotheses import (
    hypothesis_registry_requires_dependency_capability,
    load_hypothesis_registry,
)
from app.trading.reporting import summarize_replay_profitability
import scripts.local_intraday_tsmom_replay as replay_mod
from scripts.search_consistent_profitability_frontier import (
    apply_candidate_to_configmap_with_overrides,
)

# ruff: noqa: F401,F403,F405,F811,F821


def _discover_runtime_root(source_path: Path) -> Path:
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


_REPO_ROOT = _discover_runtime_root(Path(__file__))

_MIN_SIMULATION_PARITY_SAMPLE_COUNT = 120

_MAX_SIMULATION_LIVE_FILL_ERROR_BPS = Decimal("8")

_MAX_ADVERSE_SELECTION_ERROR_BPS = Decimal("8")

_EXECUTION_REALISM_PASS_STATUSES = frozenset(
    {
        "pass",
        "passed",
        "within_budget",
        "within_tolerance",
    }
)


def _string(value: Any) -> str:
    return str(value or "").strip()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping_value = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping_value.items()}


def _list_of_mappings(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    resolved: list[dict[str, Any]] = []
    for item in cast(list[Any], value):
        mapping = _mapping(item)
        if mapping:
            resolved.append(mapping)
    return resolved


def _list_of_strings(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    resolved: list[str] = []
    for item in cast(list[Any], value):
        normalized = _string(item).upper()
        if normalized:
            resolved.append(normalized)
    return tuple(resolved)


def _int(value: Any) -> int:
    try:
        return int(float(str(value or 0)))
    except (TypeError, ValueError):
        return 0


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal(default)


def _decimal_string(value: Decimal) -> str:
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered or "0"


def _optional_decimal_string(value: Any) -> str:
    if value is None or _string(value) == "":
        return ""
    return _decimal_string(_decimal(value))


def _p10(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    ordered = sorted(values)
    index = int((len(ordered) - 1) * 0.10)
    return ordered[index]


_MICROBAR_PORTFOLIO_SIGNAL_SETTINGS: dict[str, dict[str, str]] = {
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

_MICROBAR_PORTFOLIO_RUNTIME_PARAM_KEYS: tuple[str, ...] = (
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

_PORTFOLIO_POLICY_REF_PREFIX = "torghut.autoresearch.portfolio"


def _json_dumps(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload, indent=2, sort_keys=True)


def _write_json(path: Path, payload: Mapping[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_json_dumps(payload) + "\n", encoding="utf-8")
    return path


def _sha256_path(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_json(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _git_output(*args: str) -> str:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=_REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return ""
    return completed.stdout.strip()


def _runtime_run_context(*, root: Path, runner_run_id: str) -> dict[str, str]:
    head = _git_output("rev-parse", "--abbrev-ref", "HEAD") or "unknown"
    return {
        "repository": "proompteng/lab",
        "base": "main",
        "head": head,
        "artifact_path": str(root),
        "run_id": runner_run_id,
        "design_doc": "docs/torghut/design-system/v6/71-torghut-whitepaper-autoresearch-profit-target-strategy-factory-2026-04-21.md",
    }


def _runtime_closure_policy(
    *, best_candidate: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    portfolio_optimizer_evidence_required = bool(
        _portfolio_optimizer_evidence(best_candidate)
        if best_candidate is not None
        else {}
    )
    policy = {
        "promotion_require_profitability_stage_manifest": True,
        "promotion_require_portfolio_optimizer_evidence": portfolio_optimizer_evidence_required,
        "promotion_portfolio_optimizer_evidence_artifact": "promotion/portfolio-optimizer-evidence.json",
        "promotion_require_alpha_readiness_contract": True,
        "promotion_require_jangar_dependency_quorum": hypothesis_registry_requires_dependency_capability(
            load_hypothesis_registry(),
            "jangar_dependency_quorum",
        ),
        "promotion_require_benchmark_parity": False,
        "promotion_require_foundation_router_parity": False,
        "promotion_require_deeplob_bdlob_contract": False,
        "promotion_require_advisor_fallback_slo": False,
        "promotion_require_contamination_registry": False,
        "promotion_require_hmm_state_posterior": False,
        "promotion_require_expert_router_registry": False,
        "promotion_require_shadow_live_deviation": False,
        "promotion_require_simulation_calibration": False,
        "promotion_require_stress_evidence": True,
        "promotion_min_stress_case_count": 4,
        "promotion_stress_max_age_hours": 24,
        "promotion_require_janus_evidence": False,
        "gate6_require_profitability_evidence": False,
        "gate6_require_janus_evidence": False,
        "rollback_require_human_approval": True,
        "rollback_dry_run_max_age_hours": 72,
    }
    return policy


def _portfolio_proof_receipt_payload(
    *,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
    target_net_pnl_per_day: Decimal,
    runtime_closure_artifact_refs: Sequence[str],
) -> dict[str, Any]:
    objective_scorecard = _mapping(best_candidate.get("objective_scorecard"))
    portfolio_candidate_id = _string(
        best_candidate.get("portfolio_candidate_id")
    ) or _string(best_candidate.get("candidate_id"))
    post_cost_net_pnl_per_day = _decimal(
        best_candidate.get("net_pnl_per_day")
        or objective_scorecard.get("net_pnl_per_day")
    )
    holdout_status = (
        "pass"
        if bool(best_candidate.get("objective_met")) and manifest.holdout_days > 0
        else "missing"
    )
    receipt = build_portfolio_proof_receipt(
        portfolio_candidate_id=portfolio_candidate_id,
        target_net_pnl_per_day=target_net_pnl_per_day,
        post_cost_net_pnl_per_day=post_cost_net_pnl_per_day,
        holdout_result={
            "status": holdout_status,
            "holdout_days": manifest.holdout_days,
            "source_window_start": manifest.source_window_start,
            "source_window_end": manifest.source_window_end,
        },
        runtime_closure_artifact_refs=runtime_closure_artifact_refs,
        contribution={
            "objective_scorecard": objective_scorecard,
            "portfolio_optimizer": _portfolio_optimizer_evidence(best_candidate),
            "runtime_strategy_names": list(
                _portfolio_runtime_strategy_names(best_candidate)
            ),
        },
    )
    return receipt.to_payload()


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


def _date_from_iso(value: str) -> date:
    return date.fromisoformat(value)


def _daily_filled_notional(payload: Mapping[str, Any]) -> dict[str, Decimal]:
    daily_payload = _mapping(payload.get("daily"))
    resolved: dict[str, Decimal] = {}
    for day, value in daily_payload.items():
        item = _mapping(value)
        resolved[day] = Decimal(str(item.get("filled_notional", "0")))
    return resolved


def _daily_liquidity_notional(payload: Mapping[str, Any]) -> dict[str, Decimal]:
    daily_payload = _mapping(payload.get("daily"))
    resolved: dict[str, Decimal] = {}
    for day, value in daily_payload.items():
        item = _mapping(value)
        raw_value = (
            item.get("adv_notional")
            or item.get("daily_adv_notional")
            or item.get("depth_notional")
            or item.get("fillable_depth_notional")
        )
        if raw_value is not None:
            resolved[day] = _decimal(raw_value)
    return resolved


def _runtime_execution_realism_summary(payload: Mapping[str, Any]) -> dict[str, Any]:
    evidence = _mapping(payload.get("execution_realism"))

    def _payload_value(name: str) -> object:
        value = evidence.get(name)
        return payload.get(name) if value is None else value

    lob_event_stream_event_count = _int(
        _payload_value("lob_event_stream_event_count")
        or _payload_value("lob_event_stream_sample_count")
    )
    fill_outcome_count = _int(
        _payload_value("fill_outcome_count")
        or _payload_value("fill_outcome_sample_count")
    )
    live_paper_parity_sample_count = _int(
        _payload_value("live_paper_parity_sample_count")
        or _payload_value("simulation_live_parity_sample_count")
    )
    live_paper_parity_status = _string(
        _payload_value("live_paper_parity_status")
        or _payload_value("simulation_live_parity_status")
    )
    summary: dict[str, Any] = {
        "daily_lob_event_stream_count": _mapping(
            _payload_value("daily_lob_event_stream_count")
        ),
        "daily_fill_outcome_count": _mapping(
            _payload_value("daily_fill_outcome_count")
        ),
        "lob_event_stream_event_count": lob_event_stream_event_count,
        "lob_event_stream_sample_count": lob_event_stream_event_count,
        "fill_outcome_count": fill_outcome_count,
        "fill_outcome_sample_count": fill_outcome_count,
        "live_paper_parity_status": live_paper_parity_status,
        "simulation_live_parity_status": live_paper_parity_status,
        "live_paper_parity_sample_count": live_paper_parity_sample_count,
        "simulation_live_parity_sample_count": live_paper_parity_sample_count,
        "live_paper_parity_max_fill_error_bps": _optional_decimal_string(
            _payload_value("live_paper_parity_max_fill_error_bps")
        ),
        "live_paper_parity_max_adverse_selection_error_bps": _optional_decimal_string(
            _payload_value("live_paper_parity_max_adverse_selection_error_bps")
            or _payload_value("adverse_selection_error_bps")
        ),
        "implementation_trace_ref": _string(_payload_value("implementation_trace_ref")),
        "lob_event_stream_artifact_ref": _string(
            _payload_value("lob_event_stream_artifact_ref")
        ),
        "fill_outcomes_artifact_ref": _string(
            _payload_value("fill_outcomes_artifact_ref")
        ),
        "simulation_live_parity_artifact_ref": _string(
            _payload_value("simulation_live_parity_artifact_ref")
        ),
    }
    missing_evidence = _execution_realism_missing_evidence(summary)
    summary["execution_realism_status"] = (
        "complete" if not missing_evidence else "missing_required_evidence"
    )
    summary["execution_realism_missing_evidence"] = list(missing_evidence)
    return summary


def _execution_realism_missing_evidence(summary: Mapping[str, Any]) -> tuple[str, ...]:
    missing: list[str] = []
    parity_status = _string(
        summary.get("live_paper_parity_status")
        or summary.get("simulation_live_parity_status")
    )
    parity_sample_count = max(
        _int(summary.get("live_paper_parity_sample_count")),
        _int(summary.get("simulation_live_parity_sample_count")),
    )
    if (
        max(
            _int(summary.get("lob_event_stream_event_count")),
            _int(summary.get("lob_event_stream_sample_count")),
        )
        <= 0
    ):
        missing.append("lob_event_stream_evidence_missing")
    if _string(summary.get("lob_event_stream_artifact_ref")) == "":
        missing.append("lob_event_stream_artifact_ref_missing")
    if (
        max(
            _int(summary.get("fill_outcome_count")),
            _int(summary.get("fill_outcome_sample_count")),
        )
        <= 0
    ):
        missing.append("fill_outcome_evidence_missing")
    if _string(summary.get("fill_outcomes_artifact_ref")) == "":
        missing.append("fill_outcomes_artifact_ref_missing")
    if parity_sample_count <= 0:
        missing.append("live_paper_parity_evidence_missing")
    if _string(summary.get("simulation_live_parity_artifact_ref")) == "":
        missing.append("simulation_live_parity_artifact_ref_missing")
    if parity_status not in _EXECUTION_REALISM_PASS_STATUSES:
        missing.append("live_paper_parity_status_not_within_budget")
    if parity_sample_count < _MIN_SIMULATION_PARITY_SAMPLE_COUNT:
        missing.append("live_paper_parity_sample_count_below_minimum")
    fill_error_bps = summary.get("live_paper_parity_max_fill_error_bps")
    adverse_selection_error_bps = summary.get(
        "live_paper_parity_max_adverse_selection_error_bps"
    )
    if _string(fill_error_bps) == "":
        missing.append("live_paper_parity_fill_error_evidence_missing")
    elif _decimal(fill_error_bps) > _MAX_SIMULATION_LIVE_FILL_ERROR_BPS:
        missing.append("live_paper_parity_fill_error_above_maximum")
    if _string(adverse_selection_error_bps) == "":
        missing.append("live_paper_parity_adverse_selection_error_evidence_missing")
    elif _decimal(adverse_selection_error_bps) > _MAX_ADVERSE_SELECTION_ERROR_BPS:
        missing.append("live_paper_parity_adverse_selection_error_above_maximum")
    if (
        _string(
            summary.get("implementation_trace_ref")
            or summary.get("runtime_implementation_artifact_ref")
        )
        == ""
    ):
        missing.append("implementation_trace_evidence_missing")
    return tuple(missing)


def _max_drawdown_from_daily_net(daily_net: Mapping[str, Decimal]) -> Decimal:
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


def _rolling_lower_bound(daily_net: Mapping[str, Decimal], *, window: int) -> Decimal:
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


def _max_best_day_share_of_total_pnl(
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


def _objective_veto_policy(program: StrategyAutoresearchProgram) -> ObjectiveVetoPolicy:
    return ObjectiveVetoPolicy(
        required_min_active_day_ratio=program.objective.min_active_day_ratio,
        required_min_daily_notional=program.objective.min_daily_notional,
        required_max_best_day_share=program.objective.max_best_day_share,
        required_max_worst_day_loss=program.objective.max_worst_day_loss,
        required_max_drawdown=program.objective.max_drawdown,
        required_min_regime_slice_pass_rate=program.objective.min_regime_slice_pass_rate,
    )


def _runtime_family(best_candidate: Mapping[str, Any]) -> str:
    return (
        _string(best_candidate.get("runtime_family"))
        or _string(best_candidate.get("family"))
        or _string(best_candidate.get("family_template_id"))
    )


def _runtime_strategy_name(best_candidate: Mapping[str, Any]) -> str:
    return _string(best_candidate.get("runtime_strategy_name")) or _string(
        best_candidate.get("strategy_name")
    )


def _candidate_params(best_candidate: Mapping[str, Any]) -> dict[str, Any]:
    direct = _mapping(best_candidate.get("candidate_params"))
    if direct:
        return direct
    replay_config = _mapping(best_candidate.get("replay_config"))
    return _mapping(replay_config.get("params"))


def _candidate_strategy_overrides(best_candidate: Mapping[str, Any]) -> dict[str, Any]:
    direct = _mapping(best_candidate.get("candidate_strategy_overrides"))
    if direct:
        return direct
    replay_config = _mapping(best_candidate.get("replay_config"))
    return _mapping(replay_config.get("strategy_overrides"))


def _disable_other_strategies(best_candidate: Mapping[str, Any]) -> bool:
    if "disable_other_strategies" in best_candidate:
        return bool(best_candidate.get("disable_other_strategies"))
    replay_config = _mapping(best_candidate.get("replay_config"))
    if "disable_other_strategies" in replay_config:
        return bool(replay_config.get("disable_other_strategies"))
    return True


def _portfolio_payload(best_candidate: Mapping[str, Any]) -> dict[str, Any]:
    direct = _mapping(best_candidate.get("portfolio"))
    if direct:
        return direct
    replay_config = _mapping(best_candidate.get("replay_config"))
    return _mapping(replay_config.get("portfolio"))


def _text_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(str(item) for item in cast(list[Any], value) if str(item).strip())


__all__ = [name for name in globals() if not name.startswith("__")]
