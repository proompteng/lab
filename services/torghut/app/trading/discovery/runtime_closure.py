"""Runtime-closure bundle helpers for MLX autoresearch outputs."""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, cast

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
from app.trading.reporting import summarize_replay_profitability
import scripts.local_intraday_tsmom_replay as replay_mod
from scripts.search_consistent_profitability_frontier import (
    apply_candidate_to_configmap_with_overrides,
)

_REPO_ROOT = Path(__file__).resolve().parents[5]


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
}

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
        "design_doc": "docs/torghut/design-system/v6/70-torghut-mlx-autoresearch-and-apple-silicon-research-lane-2026-04-10.md",
    }


def _runtime_closure_policy(
    *, best_candidate: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    portfolio_optimizer_evidence_required = bool(
        _portfolio_optimizer_evidence(best_candidate) if best_candidate is not None else {}
    )
    policy = {
        "promotion_require_profitability_stage_manifest": True,
        "promotion_require_portfolio_optimizer_evidence": portfolio_optimizer_evidence_required,
        "promotion_portfolio_optimizer_evidence_artifact": "promotion/portfolio-optimizer-evidence.json",
        "promotion_require_alpha_readiness_contract": True,
        "promotion_require_jangar_dependency_quorum": True,
        "promotion_require_benchmark_parity": False,
        "promotion_require_foundation_router_parity": False,
        "promotion_require_deeplob_bdlob_contract": False,
        "promotion_require_advisor_fallback_slo": False,
        "promotion_require_contamination_registry": False,
        "promotion_require_hmm_state_posterior": False,
        "promotion_require_expert_router_registry": False,
        "promotion_require_shadow_live_deviation": False,
        "promotion_require_simulation_calibration": False,
        "promotion_require_stress_evidence": False,
        "promotion_require_janus_evidence": False,
        "gate6_require_profitability_evidence": False,
        "gate6_require_janus_evidence": False,
        "rollback_require_human_approval": True,
        "rollback_dry_run_max_age_hours": 72,
    }
    return policy


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


def _portfolio_candidate_runtime_payload(portfolio: PortfolioCandidateSpec) -> dict[str, Any]:
    payload = portfolio.to_payload()
    objective_scorecard = _mapping(payload.get("objective_scorecard"))
    return {
        "candidate_id": portfolio.portfolio_candidate_id,
        "portfolio_candidate_id": portfolio.portfolio_candidate_id,
        "source_candidate_ids": list(portfolio.source_candidate_ids),
        "family_template_id": "portfolio_whitepaper_autoresearch_v1",
        "objective_scope": "research_only",
        "objective_met": bool(objective_scorecard.get("target_met")),
        "status": "keep",
        "target_net_pnl_per_day": str(portfolio.target_net_pnl_per_day),
        "net_pnl_per_day": _string(objective_scorecard.get("net_pnl_per_day")),
        "active_day_ratio": _string(objective_scorecard.get("active_day_ratio")),
        "positive_day_ratio": _string(objective_scorecard.get("positive_day_ratio")),
        "best_day_share": _string(objective_scorecard.get("best_day_share")),
        "worst_day_loss": _string(objective_scorecard.get("worst_day_loss")),
        "max_drawdown": _string(objective_scorecard.get("max_drawdown")),
        "objective_scorecard": objective_scorecard,
        "optimizer_report": dict(portfolio.optimizer_report),
        "capital_budget": dict(portfolio.capital_budget),
        "correlation_budget": dict(portfolio.correlation_budget),
        "drawdown_budget": dict(portfolio.drawdown_budget),
        "evidence_refs": list(portfolio.evidence_refs),
        "portfolio": {
            "source_candidate_ids": list(portfolio.source_candidate_ids),
            "target_net_pnl_per_day": str(portfolio.target_net_pnl_per_day),
            "base_per_leg_notional": "50000",
            "sleeves": [dict(item) for item in portfolio.sleeves],
            "capital_budget": dict(portfolio.capital_budget),
            "correlation_budget": dict(portfolio.correlation_budget),
            "drawdown_budget": dict(portfolio.drawdown_budget),
            "evidence_refs": list(portfolio.evidence_refs),
        },
        "promotion_status": "blocked_pending_runtime_parity",
        "promotion_stage": "research_candidate",
        "promotion_reason": "portfolio runtime closure requires parity, approval replay, and shadow validation",
        "promotion_blockers": [
            "scheduler_v3_parity_missing",
            "scheduler_v3_approval_missing",
            "shadow_validation_missing",
        ],
        "promotion_required_evidence": [
            "portfolio_optimizer_evidence",
            "scheduler_v3_parity_replay",
            "scheduler_v3_approval_replay",
            "live_shadow_validation",
        ],
    }


def _runtime_best_candidate_payload(
    best_candidate: Mapping[str, Any] | PortfolioCandidateSpec,
) -> dict[str, Any]:
    if isinstance(best_candidate, PortfolioCandidateSpec):
        return _portfolio_candidate_runtime_payload(best_candidate)
    return dict(best_candidate)


def _portfolio_optimizer_evidence(
    best_candidate: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if best_candidate is None:
        return {}
    portfolio = _portfolio_payload(best_candidate)
    optimizer_report = _mapping(best_candidate.get("optimizer_report"))
    objective_scorecard = _mapping(best_candidate.get("objective_scorecard"))
    if not portfolio and not optimizer_report:
        return {}
    source_candidate_ids = _text_tuple(best_candidate.get("source_candidate_ids"))
    if not source_candidate_ids:
        source_candidate_ids = _text_tuple(portfolio.get("source_candidate_ids"))
    evidence_refs = _text_tuple(best_candidate.get("evidence_refs"))
    if not evidence_refs:
        evidence_refs = _text_tuple(portfolio.get("evidence_refs"))
    sleeves = _list_of_mappings(portfolio.get("sleeves"))
    return {
        "schema_version": "torghut.portfolio-optimizer-evidence.v1",
        "portfolio_candidate_id": _string(
            best_candidate.get("portfolio_candidate_id")
        )
        or _string(best_candidate.get("candidate_id")),
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "source_candidate_ids": list(source_candidate_ids),
        "target_net_pnl_per_day": _string(
            best_candidate.get("target_net_pnl_per_day")
        )
        or _string(portfolio.get("target_net_pnl_per_day")),
        "sleeve_count": len(sleeves),
        "evidence_refs": list(evidence_refs),
        "objective_scorecard": objective_scorecard,
        "optimizer_report": optimizer_report,
        "capital_budget": _mapping(best_candidate.get("capital_budget"))
        or _mapping(portfolio.get("capital_budget")),
        "correlation_budget": _mapping(best_candidate.get("correlation_budget"))
        or _mapping(portfolio.get("correlation_budget")),
        "drawdown_budget": _mapping(best_candidate.get("drawdown_budget"))
        or _mapping(portfolio.get("drawdown_budget")),
        "target_met": bool(objective_scorecard.get("target_met")),
        "oracle_passed": bool(objective_scorecard.get("oracle_passed")),
    }


def _portfolio_symbols(best_candidate: Mapping[str, Any]) -> tuple[str, ...]:
    override_symbols = _list_of_strings(
        _candidate_strategy_overrides(best_candidate).get("universe_symbols")
    )
    if override_symbols:
        return override_symbols
    return _list_of_strings(_portfolio_payload(best_candidate).get("symbols"))


def _is_microbar_portfolio_candidate(best_candidate: Mapping[str, Any]) -> bool:
    replay_backend = _string(
        _mapping(best_candidate.get("replay_config")).get("backend")
    )
    return (
        _string(best_candidate.get("family_template_id"))
        == "microbar_cross_sectional_pairs_v1"
        or _runtime_family(best_candidate) == "microbar_cross_sectional_pairs"
        or replay_backend == "microbar_daily_portfolio"
    )


def _microbar_portfolio_strategy_name(
    *,
    base_name: str,
    sleeve_index: int,
    side: str,
) -> str:
    return f"{base_name}-sleeve-{sleeve_index}-{side}"


def _portfolio_runtime_strategy_names(
    best_candidate: Mapping[str, Any],
) -> tuple[str, ...]:
    portfolio = _portfolio_payload(best_candidate)
    if not portfolio:
        strategy_name = _runtime_strategy_name(best_candidate)
        return (strategy_name,) if strategy_name else ()
    if not _is_microbar_portfolio_candidate(best_candidate):
        names: list[str] = []
        for sleeve_index, sleeve in enumerate(
            _list_of_mappings(portfolio.get("sleeves")), start=1
        ):
            strategy_name = _string(sleeve.get("runtime_strategy_name"))
            if not strategy_name:
                strategy_name = f"{_runtime_strategy_name(best_candidate) or 'whitepaper-autoresearch'}-sleeve-{sleeve_index}"
            names.append(strategy_name)
        return tuple(names)
    base_name = (
        _runtime_strategy_name(best_candidate) or "microbar-cross-sectional-pairs-v1"
    )
    names: list[str] = []
    sleeves = _list_of_mappings(_portfolio_payload(best_candidate).get("sleeves"))
    for sleeve_index, _sleeve in enumerate(sleeves, start=1):
        names.append(
            _microbar_portfolio_strategy_name(
                base_name=base_name, sleeve_index=sleeve_index, side="long"
            )
        )
        names.append(
            _microbar_portfolio_strategy_name(
                base_name=base_name, sleeve_index=sleeve_index, side="short"
            )
        )
    return tuple(names)


def _policy_ref_slug(value: str) -> str:
    normalized = "".join(
        character.lower() if character.isalnum() else "-" for character in value
    ).strip("-")
    while "--" in normalized:
        normalized = normalized.replace("--", "-")
    return normalized or "strategy"


def _portfolio_policy_refs(
    *,
    best_candidate: Mapping[str, Any],
    strategy_names: tuple[str, ...],
) -> dict[str, list[str]]:
    portfolio = _portfolio_payload(best_candidate)
    prefix = _string(portfolio.get("policy_ref_prefix")) or _PORTFOLIO_POLICY_REF_PREFIX
    candidate_slug = _policy_ref_slug(
        _string(best_candidate.get("candidate_id")) or "candidate"
    )

    refs: dict[str, list[str]] = {
        "promotion_policy_refs": [],
        "risk_profile_refs": [],
        "sizing_policy_refs": [],
        "execution_policy_refs": [],
    }
    for strategy_name in strategy_names:
        strategy_slug = _policy_ref_slug(strategy_name)
        refs["promotion_policy_refs"].append(
            f"{prefix}/{candidate_slug}/promotion/{strategy_slug}"
        )
        refs["risk_profile_refs"].append(
            f"{prefix}/{candidate_slug}/risk/{strategy_slug}"
        )
        refs["sizing_policy_refs"].append(
            f"{prefix}/{candidate_slug}/sizing/{strategy_slug}"
        )
        refs["execution_policy_refs"].append(
            f"{prefix}/{candidate_slug}/execution/{strategy_slug}"
        )
    return {key: sorted(values) for key, values in refs.items()}


def _portfolio_promotion_v2(best_candidate: Mapping[str, Any]) -> dict[str, Any]:
    strategy_names = _portfolio_runtime_strategy_names(best_candidate)
    if len(strategy_names) <= 1:
        return {}
    symbols = _portfolio_symbols(best_candidate)
    policy_refs = _portfolio_policy_refs(
        best_candidate=best_candidate,
        strategy_names=strategy_names,
    )
    return {
        "mode": "portfolio_aware",
        "strategy_count": len(strategy_names),
        "spec_compiled_count": len(strategy_names),
        "strategy_compilation_source": "runtime_closure_materialized_portfolio_v1",
        "unique_symbol_count": len(set(symbols)),
        "overlapping_symbols": list(symbols),
        **policy_refs,
        "missing_policy_refs": [],
    }


def _materialized_microbar_portfolio_runtime_strategies(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
) -> list[dict[str, Any]]:
    if not _is_microbar_portfolio_candidate(best_candidate):
        return []
    portfolio = _portfolio_payload(best_candidate)
    sleeves = _list_of_mappings(portfolio.get("sleeves"))
    if not sleeves:
        return []
    base_per_leg_notional = _decimal(portfolio.get("base_per_leg_notional"))
    if base_per_leg_notional <= 0:
        raise ValueError(
            "runtime_closure_microbar_portfolio_base_per_leg_notional_missing"
        )
    symbols = _portfolio_symbols(best_candidate) or execution_context.symbols
    if not symbols:
        raise ValueError("runtime_closure_microbar_portfolio_symbols_missing")
    base_name = (
        _runtime_strategy_name(best_candidate) or "microbar-cross-sectional-pairs-v1"
    )
    candidate_id = _string(best_candidate.get("candidate_id")) or "runtime-closure"
    strategies: list[dict[str, Any]] = []
    for sleeve_index, sleeve in enumerate(sleeves, start=1):
        signal = _string(sleeve.get("signal"))
        signal_settings = _MICROBAR_PORTFOLIO_SIGNAL_SETTINGS.get(signal)
        if signal_settings is None:
            raise ValueError(
                f"runtime_closure_microbar_portfolio_signal_unsupported:{signal}"
            )
        entry_minute = max(0, _int(sleeve.get("entry_minute_after_open")))
        exit_text = _string(sleeve.get("exit_minute_after_open")) or "close"
        top_n = max(1, _int(sleeve.get("top_n")))
        weight = _decimal(sleeve.get("weight"), default="1")
        if weight <= 0:
            weight = Decimal("1")
        max_notional_per_trade = base_per_leg_notional * weight
        if execution_context.start_equity > 0:
            max_position_pct_equity = (
                max_notional_per_trade / execution_context.start_equity
            )
        else:
            max_position_pct_equity = Decimal("10")
        max_position_pct_equity = max(max_position_pct_equity, Decimal("0.1"))
        for side, strategy_type in (
            ("long", "microbar_cross_sectional_long_v1"),
            ("short", "microbar_cross_sectional_short_v1"),
        ):
            strategies.append(
                {
                    "name": _microbar_portfolio_strategy_name(
                        base_name=base_name,
                        sleeve_index=sleeve_index,
                        side=side,
                    ),
                    "strategy_id": f"{strategy_type}@runtime-closure:{candidate_id}:s{sleeve_index}:{side}",
                    "strategy_type": strategy_type,
                    "version": "1.0.0",
                    "description": (
                        f"Runtime-closure materialized sleeve {sleeve_index} "
                        f"for {_runtime_family(best_candidate) or 'microbar portfolio'}"
                    ),
                    "enabled": True,
                    "base_timeframe": "1Sec",
                    "universe_type": strategy_type,
                    "universe_symbols": list(symbols),
                    "max_notional_per_trade": _decimal_string(max_notional_per_trade),
                    "max_position_pct_equity": _decimal_string(max_position_pct_equity),
                    "params": {
                        "entry_minute_after_open": str(entry_minute),
                        "exit_minute_after_open": exit_text,
                        "signal_motif": signal,
                        "rank_feature": signal_settings["rank_feature"],
                        "selection_mode": signal_settings["selection_mode"],
                        "top_n": str(top_n),
                        "universe_size": str(len(symbols)),
                        "max_concurrent_positions": str(top_n),
                        "max_entries_per_session": str(top_n),
                        "position_isolation_mode": "per_strategy",
                    },
                }
            )
    return strategies


def _materialized_generic_portfolio_runtime_strategies(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
) -> list[dict[str, Any]]:
    if _is_microbar_portfolio_candidate(best_candidate):
        return []
    portfolio = _portfolio_payload(best_candidate)
    sleeves = _list_of_mappings(portfolio.get("sleeves"))
    if not sleeves:
        return []
    base_per_leg_notional = _decimal(
        portfolio.get("base_per_leg_notional"), default="50000"
    )
    if base_per_leg_notional <= 0:
        base_per_leg_notional = Decimal("50000")
    symbols = _portfolio_symbols(best_candidate) or execution_context.symbols
    if not symbols:
        raise ValueError("runtime_closure_generic_portfolio_symbols_missing")
    candidate_id = _string(best_candidate.get("candidate_id")) or "runtime-closure"
    strategies: list[dict[str, Any]] = []
    for sleeve_index, sleeve in enumerate(sleeves, start=1):
        runtime_family = (
            _string(sleeve.get("runtime_family"))
            or _runtime_family(best_candidate)
            or "whitepaper_autoresearch_sleeve"
        )
        strategy_name = (
            _string(sleeve.get("runtime_strategy_name"))
            or f"whitepaper-autoresearch-sleeve-{sleeve_index}"
        )
        weight = _decimal(sleeve.get("weight"), default="1")
        if weight <= 0:
            weight = Decimal("1")
        max_notional_per_trade = _decimal(sleeve.get("max_notional_per_trade"))
        if max_notional_per_trade <= 0:
            max_notional_per_trade = base_per_leg_notional * weight
        if execution_context.start_equity > 0:
            max_position_pct_equity = (
                max_notional_per_trade / execution_context.start_equity
            )
        else:
            max_position_pct_equity = Decimal("10")
        max_position_pct_equity = max(max_position_pct_equity, Decimal("0.1"))
        strategy_symbols = _list_of_strings(sleeve.get("symbols")) or symbols
        strategies.append(
            {
                "name": strategy_name,
                "strategy_id": f"{runtime_family}@runtime-closure:{candidate_id}:s{sleeve_index}",
                "strategy_type": runtime_family,
                "version": "1.0.0",
                "description": f"Runtime-closure materialized whitepaper autoresearch sleeve {sleeve_index}",
                "enabled": True,
                "base_timeframe": "1Sec",
                "universe_type": runtime_family,
                "universe_symbols": list(strategy_symbols),
                "max_notional_per_trade": _decimal_string(max_notional_per_trade),
                "max_position_pct_equity": _decimal_string(max_position_pct_equity),
                "params": {
                    "source_candidate_id": _string(sleeve.get("candidate_id")),
                    "candidate_spec_id": _string(sleeve.get("candidate_spec_id")),
                    "portfolio_candidate_id": candidate_id,
                    "sleeve_weight": _decimal_string(weight),
                    "expected_net_pnl_per_day": _string(
                        sleeve.get("expected_net_pnl_per_day")
                    ),
                    "risk_contribution": _string(sleeve.get("risk_contribution")),
                    "correlation_cluster": _string(sleeve.get("correlation_cluster")),
                    "position_isolation_mode": "per_strategy",
                },
            }
        )
    return strategies


def _candidate_symbols(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
) -> tuple[str, ...]:
    override_symbols = _portfolio_symbols(best_candidate)
    if override_symbols:
        return override_symbols
    return execution_context.symbols


def _window_bounds(
    *,
    best_candidate: Mapping[str, Any],
    window_name: str,
    manifest: MlxSnapshotManifest,
) -> tuple[date, date]:
    replay_config = _mapping(best_candidate.get("replay_config"))
    start_key = f"{window_name}_start_date"
    end_key = f"{window_name}_end_date"
    start_text = _string(best_candidate.get(start_key)) or _string(
        replay_config.get(start_key)
    )
    end_text = _string(best_candidate.get(end_key)) or _string(
        replay_config.get(end_key)
    )
    if not start_text or not end_text:
        if window_name != "full_window":
            raise ValueError(f"runtime_closure_window_missing:{window_name}")
        start_text = manifest.source_window_start
        end_text = manifest.source_window_end
    return (_date_from_iso(start_text), _date_from_iso(end_text))


def _materialize_candidate_configmap(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
    output_path: Path,
) -> Path:
    configmap_payload = yaml.safe_load(
        execution_context.strategy_configmap_path.read_text(encoding="utf-8")
    )
    if not isinstance(configmap_payload, Mapping):
        raise ValueError("strategy_configmap_not_mapping")
    portfolio_runtime_strategies = [
        *_materialized_microbar_portfolio_runtime_strategies(
            best_candidate=best_candidate,
            execution_context=execution_context,
        ),
        *_materialized_generic_portfolio_runtime_strategies(
            best_candidate=best_candidate,
            execution_context=execution_context,
        ),
    ]
    if portfolio_runtime_strategies:
        rendered_payload = yaml.safe_load(
            yaml.safe_dump(cast(Mapping[str, Any], configmap_payload), sort_keys=False)
        )
        if not isinstance(rendered_payload, dict):
            raise ValueError("strategy_configmap_not_mapping")
        rendered = cast(dict[str, Any], rendered_payload)
        data_payload = rendered.get("data")
        if not isinstance(data_payload, dict):
            raise ValueError("strategy_configmap_missing_data")
        data = cast(dict[str, Any], data_payload)
        strategies_yaml = data.get("strategies.yaml")
        if not isinstance(strategies_yaml, str):
            raise ValueError("strategy_configmap_missing_strategies_yaml")
        catalog_payload = yaml.safe_load(strategies_yaml)
        if not isinstance(catalog_payload, dict):
            raise ValueError("strategy_catalog_not_mapping")
        catalog = cast(dict[str, Any], catalog_payload)
        strategies_payload = catalog.get("strategies")
        if not isinstance(strategies_payload, list):
            raise ValueError("strategy_catalog_missing_strategies")
        strategies = cast(list[Any], strategies_payload)
        if _disable_other_strategies(best_candidate):
            for item in strategies:
                if isinstance(item, dict):
                    item["enabled"] = False
        by_name: dict[str, int] = {}
        for index, item in enumerate(strategies):
            if not isinstance(item, Mapping):
                continue
            item_mapping = cast(Mapping[str, Any], item)
            item_name = _string(item_mapping.get("name"))
            if item_name:
                by_name[item_name] = index
        for item in portfolio_runtime_strategies:
            item_name = _string(item.get("name"))
            if item_name in by_name:
                strategies[by_name[item_name]] = item
            else:
                strategies.append(item)
        data["strategies.yaml"] = yaml.safe_dump(catalog, sort_keys=False)
    else:
        strategy_name = _runtime_strategy_name(best_candidate)
        if not strategy_name:
            raise ValueError("runtime_closure_missing_runtime_strategy_name")
        candidate_params = _candidate_params(best_candidate)
        if not candidate_params:
            raise ValueError("runtime_closure_missing_candidate_params")
        rendered = apply_candidate_to_configmap_with_overrides(
            configmap_payload=cast(Mapping[str, Any], configmap_payload),
            strategy_name=strategy_name,
            candidate_params=candidate_params,
            strategy_overrides=_candidate_strategy_overrides(best_candidate),
            disable_other_strategies=_disable_other_strategies(best_candidate),
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(yaml.safe_dump(rendered, sort_keys=False), encoding="utf-8")
    return output_path


def _default_replay_executor(config: replay_mod.ReplayConfig) -> dict[str, Any]:
    return replay_mod.run_replay(config)


def _run_runtime_replay(
    *,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
    execution_context: RuntimeClosureExecutionContext,
    strategy_configmap_path: Path,
    window_name: str,
    replay_executor: Any,
) -> dict[str, Any]:
    start_date, end_date = _window_bounds(
        best_candidate=best_candidate, window_name=window_name, manifest=manifest
    )
    config = replay_mod.ReplayConfig(
        strategy_configmap_path=strategy_configmap_path,
        clickhouse_http_url=execution_context.clickhouse_http_url,
        clickhouse_username=execution_context.clickhouse_username,
        clickhouse_password=execution_context.clickhouse_password,
        start_date=start_date,
        end_date=end_date,
        chunk_minutes=max(1, execution_context.chunk_minutes),
        flatten_eod=True,
        start_equity=execution_context.start_equity,
        symbols=_candidate_symbols(
            best_candidate=best_candidate, execution_context=execution_context
        ),
        progress_log_interval_seconds=max(
            1, execution_context.progress_log_interval_seconds
        ),
    )
    return cast(dict[str, Any], replay_executor(config))


def _replay_analysis(
    *,
    window_name: str,
    replay_payload: Mapping[str, Any],
    best_candidate: Mapping[str, Any],
    program: StrategyAutoresearchProgram,
) -> dict[str, Any]:
    summary = summarize_replay_profitability(replay_payload)
    total_filled_notional = sum(
        _daily_filled_notional(replay_payload).values(), Decimal("0")
    )
    positive_days = sum(1 for value in summary.daily_net.values() if value > 0)
    negative_days = sum(1 for value in summary.daily_net.values() if value < 0)
    family_template_id = _string(best_candidate.get("family_template_id"))
    normalization_regime = _string(best_candidate.get("normalization_regime"))
    decomposition_payload: dict[str, Any] | None = None
    decomposition_error = ""
    regime_pass_rate = Decimal("0")
    symbol_concentration = Decimal("1")
    family_contribution = Decimal("1")
    try:
        decomposition = build_replay_decomposition(
            replay_payload=replay_payload,
            family_id=family_template_id,
            normalization_regime=normalization_regime or None,
        )
        decomposition_payload = decomposition.to_payload()
        regime_pass_rate = regime_slice_pass_rate(decomposition)
        symbol_concentration = max_symbol_concentration_share(decomposition)
        family_contribution = max_family_contribution_share(decomposition)
    except Exception as exc:
        decomposition_error = str(exc)

    scorecard = build_scorecard(
        candidate_id=_string(best_candidate.get("candidate_id")),
        trading_day_count=summary.trading_day_count,
        net_pnl_per_day=summary.net_per_day,
        active_days=summary.active_days,
        positive_days=positive_days,
        avg_filled_notional_per_day=(
            total_filled_notional / Decimal(summary.trading_day_count)
            if summary.trading_day_count > 0
            else Decimal("0")
        ),
        avg_filled_notional_per_active_day=(
            total_filled_notional / Decimal(summary.active_days)
            if summary.active_days > 0
            else Decimal("0")
        ),
        worst_day_loss=abs(summary.worst_day_net)
        if summary.worst_day_net < 0
        else Decimal("0"),
        max_drawdown=_max_drawdown_from_daily_net(summary.daily_net),
        best_day_share=_max_best_day_share_of_total_pnl(
            daily_net=summary.daily_net,
            total_net_pnl=summary.net_pnl,
        ),
        negative_day_count=negative_days,
        rolling_3d_lower_bound=_rolling_lower_bound(summary.daily_net, window=3),
        rolling_5d_lower_bound=_rolling_lower_bound(summary.daily_net, window=5),
        regime_slice_pass_rate=regime_pass_rate,
        symbol_concentration_share=symbol_concentration,
        entry_family_contribution_share=family_contribution,
    )
    hard_vetoes = list(
        evaluate_vetoes(
            scorecard,
            policy=_objective_veto_policy(program),
            is_fresh=True,
        )
    )
    replay_candidate = {
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "objective_scorecard": scorecard.to_payload(),
        "full_window": {
            "trading_day_count": summary.trading_day_count,
            "active_days": summary.active_days,
        },
        "hard_vetoes": hard_vetoes,
    }
    objective_met = candidate_meets_objective(
        replay_candidate, objective=program.objective
    )
    return {
        "schema_version": "torghut.runtime-closure-replay-report.v1",
        "window_name": window_name,
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "runtime_family": _runtime_family(best_candidate),
        "runtime_strategy_name": _runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            _portfolio_runtime_strategy_names(best_candidate)
        ),
        "objective_met": objective_met,
        "hard_vetoes": hard_vetoes,
        "scorecard": scorecard.to_payload(),
        "summary": {
            "start_date": summary.start_date,
            "end_date": summary.end_date,
            "trading_day_count": summary.trading_day_count,
            "net_pnl": str(summary.net_pnl),
            "net_per_day": str(summary.net_per_day),
            "active_days": summary.active_days,
            "decision_count": summary.decision_count,
            "filled_count": summary.filled_count,
            "wins": summary.wins,
            "losses": summary.losses,
            "worst_day_net": str(summary.worst_day_net),
            "profit_factor": str(summary.profit_factor)
            if summary.profit_factor is not None
            else None,
            "positive_days": positive_days,
            "negative_days": negative_days,
            "daily_net": {day: str(value) for day, value in summary.daily_net.items()},
            "daily_filled_notional": {
                day: str(value)
                for day, value in _daily_filled_notional(replay_payload).items()
            },
        },
        "decomposition": decomposition_payload,
        "decomposition_error": decomposition_error or None,
    }


def _shadow_validation_artifact(
    *,
    best_candidate: Mapping[str, Any],
    program: StrategyAutoresearchProgram,
    execution_context: RuntimeClosureExecutionContext | None,
) -> dict[str, Any]:
    mode = program.runtime_closure_policy.shadow_validation_mode
    if mode != "require_live_evidence":
        return {
            "schema_version": "torghut.runtime-closure-shadow-validation-plan.v1",
            "candidate_id": _string(best_candidate.get("candidate_id")),
            "mode": mode,
            "status": "skipped",
            "required": False,
            "reasons": [],
            "evidence_loaded": False,
            "source_artifact_path": None,
            "source_schema_version": None,
        }

    artifact_path = (
        execution_context.shadow_validation_artifact_path
        if execution_context is not None
        else None
    )
    if artifact_path is None:
        return {
            "schema_version": "torghut.runtime-closure-shadow-validation-plan.v1",
            "candidate_id": _string(best_candidate.get("candidate_id")),
            "mode": mode,
            "status": "pending_live_evidence",
            "required": True,
            "reasons": ["live_shadow_evidence_not_available_from_local_autoresearch"],
            "evidence_loaded": False,
            "source_artifact_path": None,
            "source_schema_version": None,
        }

    try:
        payload = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {
            "schema_version": "torghut.runtime-closure-shadow-validation-plan.v1",
            "candidate_id": _string(best_candidate.get("candidate_id")),
            "mode": mode,
            "status": "invalid_artifact",
            "required": True,
            "reasons": ["shadow_validation_artifact_invalid_json"],
            "evidence_loaded": False,
            "source_artifact_path": str(artifact_path),
            "source_schema_version": None,
        }

    source_payload = _mapping(payload)
    source_schema_version = _string(source_payload.get("schema_version"))
    status = _string(source_payload.get("status")) or "invalid_artifact"
    reasons: list[str] = []
    if source_schema_version != "shadow-live-deviation-report-v1":
        reasons.append("shadow_validation_schema_version_invalid")
        status = "invalid_artifact"
    elif status == "within_budget":
        pass
    elif status in {"pending_live_evidence", "pending"}:
        reasons.append("shadow_validation_pending")
    else:
        reasons.append("shadow_validation_status_not_within_budget")

    return {
        "schema_version": "torghut.runtime-closure-shadow-validation-plan.v1",
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "mode": mode,
        "status": status,
        "required": True,
        "reasons": reasons,
        "evidence_loaded": source_schema_version == "shadow-live-deviation-report-v1",
        "source_artifact_path": str(artifact_path),
        "source_schema_version": source_schema_version,
        "order_count": _int(source_payload.get("order_count")),
        "coverage_error": source_payload.get("coverage_error"),
    }


def _summary_status_and_next_steps(
    *,
    parity_report: Mapping[str, Any] | None,
    approval_report: Mapping[str, Any] | None,
    shadow_plan: Mapping[str, Any],
) -> tuple[str, tuple[str, ...]]:
    parity_pass = (
        bool(_mapping(parity_report).get("objective_met"))
        if parity_report is not None
        else False
    )
    approval_pass = (
        bool(_mapping(approval_report).get("objective_met"))
        if approval_report is not None
        else False
    )
    shadow_required = bool(shadow_plan.get("required"))
    shadow_status = _string(shadow_plan.get("status"))
    shadow_ready = shadow_status == "within_budget"

    if parity_report is None:
        return (
            "pending_runtime_parity",
            (
                "scheduler_v3_parity_replay",
                "scheduler_v3_approval_replay",
                *(() if not shadow_required else ("live_shadow_validation",)),
            ),
        )
    if not parity_pass:
        return ("runtime_parity_failed", ("scheduler_v3_parity_replay",))
    if approval_report is None:
        return (
            "pending_approval_replay",
            (
                "scheduler_v3_approval_replay",
                *(() if not shadow_required else ("live_shadow_validation",)),
            ),
        )
    if not approval_pass:
        return ("approval_replay_failed", ("scheduler_v3_approval_replay",))
    if shadow_required and shadow_status in {"pending_live_evidence", "pending", ""}:
        return (
            "pending_shadow_validation",
            ("live_shadow_validation", "promotion_review"),
        )
    if shadow_required and not shadow_ready:
        return ("shadow_validation_failed", ("live_shadow_validation",))
    return ("ready_for_promotion_review", ("promotion_review",))


def _candidate_spec(
    *,
    runner_run_id: str,
    program: StrategyAutoresearchProgram,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
) -> dict[str, Any]:
    replay_config = _mapping(best_candidate.get("replay_config"))
    portfolio_promotion_v2 = _portfolio_promotion_v2(best_candidate)
    portfolio_optimizer_evidence = _portfolio_optimizer_evidence(best_candidate)
    return {
        "schema_version": "torghut.runtime-closure-candidate-spec.v1",
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "runner_run_id": runner_run_id,
        "program_id": program.program_id,
        "family_template_id": _string(best_candidate.get("family_template_id")),
        "runtime_family": _runtime_family(best_candidate),
        "runtime_strategy_name": _runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            _portfolio_runtime_strategy_names(best_candidate)
        ),
        "dataset_snapshot_ref": manifest.snapshot_id,
        "source_window_start": manifest.source_window_start,
        "source_window_end": manifest.source_window_end,
        "objective_scope": _string(best_candidate.get("objective_scope"))
        or "research_only",
        "objective_met": bool(best_candidate.get("objective_met")),
        "status": _string(best_candidate.get("status")),
        "mutation_label": _string(best_candidate.get("mutation_label")),
        "parent_candidate_id": _string(best_candidate.get("parent_candidate_id")),
        "candidate_params": _candidate_params(best_candidate),
        "candidate_strategy_overrides": _candidate_strategy_overrides(best_candidate),
        "disable_other_strategies": _disable_other_strategies(best_candidate),
        "train_start_date": _string(best_candidate.get("train_start_date"))
        or _string(replay_config.get("train_start_date")),
        "train_end_date": _string(best_candidate.get("train_end_date"))
        or _string(replay_config.get("train_end_date")),
        "holdout_start_date": _string(best_candidate.get("holdout_start_date"))
        or _string(replay_config.get("holdout_start_date")),
        "holdout_end_date": _string(best_candidate.get("holdout_end_date"))
        or _string(replay_config.get("holdout_end_date")),
        "full_window_start_date": _string(best_candidate.get("full_window_start_date"))
        or _string(replay_config.get("full_window_start_date"))
        or manifest.source_window_start,
        "full_window_end_date": _string(best_candidate.get("full_window_end_date"))
        or _string(replay_config.get("full_window_end_date"))
        or manifest.source_window_end,
        "normalization_regime": _string(best_candidate.get("normalization_regime")),
        "descriptor": {
            "descriptor_id": _string(best_candidate.get("descriptor_id")),
            "entry_window_start_minute": _int(
                best_candidate.get("entry_window_start_minute")
            ),
            "entry_window_end_minute": _int(
                best_candidate.get("entry_window_end_minute")
            ),
            "max_hold_minutes": _int(best_candidate.get("max_hold_minutes")),
            "rank_count": _int(best_candidate.get("rank_count")),
            "requires_prev_day_features": bool(
                best_candidate.get("requires_prev_day_features")
            ),
            "requires_cross_sectional_features": bool(
                best_candidate.get("requires_cross_sectional_features")
            ),
            "requires_quote_quality_gate": bool(
                best_candidate.get("requires_quote_quality_gate")
            ),
        },
        "metrics": {
            "net_pnl_per_day": _string(best_candidate.get("net_pnl_per_day")),
            "active_day_ratio": _string(best_candidate.get("active_day_ratio")),
            "positive_day_ratio": _string(best_candidate.get("positive_day_ratio")),
            "best_day_share": _string(best_candidate.get("best_day_share")),
            "worst_day_loss": _string(best_candidate.get("worst_day_loss")),
            "max_drawdown": _string(best_candidate.get("max_drawdown")),
            "proposal_score": _float(best_candidate.get("proposal_score")),
            "proposal_rank": _int(best_candidate.get("proposal_rank")),
        },
        "promotion_contract": {
            "status": _string(best_candidate.get("promotion_status")),
            "stage": _string(best_candidate.get("promotion_stage")),
            "reason": _string(best_candidate.get("promotion_reason")),
            "blockers": list(
                cast(list[str], best_candidate.get("promotion_blockers") or [])
            ),
            "required_evidence": list(
                cast(list[str], best_candidate.get("promotion_required_evidence") or [])
            ),
        },
        **(
            {"portfolio_optimizer_evidence": portfolio_optimizer_evidence}
            if portfolio_optimizer_evidence
            else {}
        ),
        **(
            {"portfolio_promotion_v2": portfolio_promotion_v2}
            if portfolio_promotion_v2
            else {}
        ),
    }


def _candidate_generation_manifest(
    *,
    runner_run_id: str,
    program: StrategyAutoresearchProgram,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
) -> dict[str, Any]:
    return {
        "schema_version": "torghut.runtime-closure-generation-manifest.v1",
        "runner_run_id": runner_run_id,
        "program_id": program.program_id,
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "dataset_snapshot_ref": manifest.snapshot_id,
        "proposal_score": _float(best_candidate.get("proposal_score")),
        "proposal_rank": _int(best_candidate.get("proposal_rank")),
        "proposal_selected": bool(best_candidate.get("proposal_selected")),
        "proposal_selection_reason": _string(
            best_candidate.get("proposal_selection_reason")
        ),
        "mutation_label": _string(best_candidate.get("mutation_label")),
        "status": _string(best_candidate.get("status")),
        "runtime_strategy_names": list(
            _portfolio_runtime_strategy_names(best_candidate)
        ),
        "runtime_closure_policy": program.runtime_closure_policy.to_payload(),
    }


def _gate_report(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
    promotion_target: str,
    parity_report: Mapping[str, Any] | None,
    approval_report: Mapping[str, Any] | None,
    shadow_plan: Mapping[str, Any],
    portfolio_optimizer_evidence_ref: str | None = None,
) -> dict[str, Any]:
    runtime_family = _runtime_family(best_candidate) or "unknown"
    parity_pass = (
        bool(_mapping(parity_report).get("objective_met"))
        if parity_report is not None
        else False
    )
    approval_pass = (
        bool(_mapping(approval_report).get("objective_met"))
        if approval_report is not None
        else False
    )
    shadow_required = bool(shadow_plan.get("required"))
    shadow_status = _string(shadow_plan.get("status"))
    shadow_ready = shadow_status == "within_budget"
    portfolio_promotion_v2 = _portfolio_promotion_v2(best_candidate)
    portfolio_optimizer_evidence = _portfolio_optimizer_evidence(best_candidate)
    promotion_reasons: list[str] = []
    if parity_report is None:
        promotion_reasons.append("research_candidate_pending_scheduler_v3_parity")
    elif not parity_pass:
        promotion_reasons.append("scheduler_v3_parity_failed")
    if approval_report is None:
        promotion_reasons.append("research_candidate_pending_scheduler_v3_approval")
    elif not approval_pass:
        promotion_reasons.append("scheduler_v3_approval_failed")
    if shadow_required and shadow_status in {"pending_live_evidence", "pending", ""}:
        promotion_reasons.append("research_candidate_pending_shadow_validation")
    elif shadow_required and not shadow_ready:
        promotion_reasons.append("shadow_validation_failed")
    throughput_source = (
        approval_report if approval_report is not None else parity_report
    )
    throughput_summary = (
        _mapping(_mapping(throughput_source).get("summary"))
        if throughput_source is not None
        else {}
    )
    return {
        "run_id": runner_run_id,
        "promotion_allowed": False,
        "recommended_mode": promotion_target,
        "dependency_quorum": {
            "decision": "allow",
            "reasons": [],
            "message": "Autoresearch runtime closure artifacts are local-only and do not require live actuation.",
        },
        "alpha_readiness": {
            "mode": "candidate_alignment_v1",
            "registry_loaded": True,
            "registry_path": "runtime_harness",
            "registry_errors": [],
            "strategy_families": [runtime_family],
            "matched_hypothesis_ids": [
                _string(best_candidate.get("family_template_id"))
            ],
            "missing_strategy_families": [],
            "promotion_eligible": False,
            "reasons": list(promotion_reasons),
        },
        "throughput": {
            "signal_count": int(throughput_summary.get("decision_count") or 0),
            "decision_count": int(throughput_summary.get("decision_count") or 0),
            "trade_count": int(throughput_summary.get("filled_count") or 0),
            "no_signal_window": int(throughput_summary.get("filled_count") or 0) <= 0,
            "no_signal_reason": "no_runtime_fills_in_closure_window"
            if int(throughput_summary.get("filled_count") or 0) <= 0
            else None,
        },
        "gates": [
            {"gate_id": "gate0_data_integrity", "status": "pass"},
            {
                "gate_id": "gate1_scheduler_v3_parity_replay",
                "status": "pass"
                if parity_pass
                else ("fail" if parity_report is not None else "pending"),
            },
            {
                "gate_id": "gate2_scheduler_v3_approval_replay",
                "status": "pass"
                if approval_pass
                else ("fail" if approval_report is not None else "pending"),
            },
            {
                "gate_id": "gate3_shadow_validation",
                "status": (
                    "pass"
                    if shadow_ready
                    else (
                        "pending"
                        if shadow_required
                        and shadow_status in {"pending_live_evidence", "pending", ""}
                        else ("fail" if shadow_required else "skip")
                    )
                ),
            },
        ],
        "promotion_evidence": {
            "promotion_rationale": {
                "requested_target": promotion_target,
                "gate_recommended_mode": promotion_target,
                "gate_reasons": list(promotion_reasons),
                "shadow_validation_status": shadow_status,
                "rationale_text": "Runtime closure replays executed, but promotion stays blocked until parity, approval, and shadow requirements are satisfied.",
            },
            **(
                {
                    "portfolio_optimizer": {
                        "artifact_ref": portfolio_optimizer_evidence_ref,
                        "schema_version": portfolio_optimizer_evidence[
                            "schema_version"
                        ],
                        "portfolio_candidate_id": portfolio_optimizer_evidence[
                            "portfolio_candidate_id"
                        ],
                        "target_met": portfolio_optimizer_evidence["target_met"],
                        "oracle_passed": portfolio_optimizer_evidence["oracle_passed"],
                        "sleeve_count": portfolio_optimizer_evidence["sleeve_count"],
                    }
                }
                if portfolio_optimizer_evidence
                else {}
            ),
        },
        "uncertainty_gate_action": "abstain",
        "coverage_error": (
            "0.0"
            if parity_pass and approval_pass and (not shadow_required or shadow_ready)
            else "1.0"
        ),
        "recalibration_run_id": None,
        **(
            {"vnext": {"portfolio_promotion": portfolio_promotion_v2}}
            if portfolio_promotion_v2
            else {}
        ),
    }


def _candidate_state(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
    parity_report: Mapping[str, Any] | None,
    approval_report: Mapping[str, Any] | None,
    shadow_plan: Mapping[str, Any],
) -> dict[str, Any]:
    dependency_quorum: dict[str, Any] = {
        "decision": "allow",
        "reasons": [],
        "message": "Local runtime-closure planning is allowed.",
    }
    reasons: list[str] = []
    if parity_report is None:
        reasons.append("runtime_parity_not_completed")
    elif not bool(_mapping(parity_report).get("objective_met")):
        reasons.append("runtime_parity_failed")
    if approval_report is None:
        reasons.append("approval_replay_not_completed")
    elif not bool(_mapping(approval_report).get("objective_met")):
        reasons.append("approval_replay_failed")
    if bool(shadow_plan.get("required")):
        shadow_status = _string(shadow_plan.get("status"))
        if shadow_status in {"pending_live_evidence", "pending", ""}:
            reasons.append("shadow_validation_pending")
        elif shadow_status != "within_budget":
            reasons.append("shadow_validation_failed")
    return {
        "candidateId": _string(best_candidate.get("candidate_id")),
        "runId": runner_run_id,
        "activeStage": "runtime-closure",
        "paused": False,
        "datasetSnapshotRef": manifest.snapshot_id,
        "noSignalReason": None,
        "dependencyQuorum": dependency_quorum,
        "alphaReadiness": {
            "mode": "candidate_alignment_v1",
            "registry_loaded": True,
            "registry_path": "runtime_harness",
            "registry_errors": [],
            "strategy_families": [_runtime_family(best_candidate)],
            "matched_hypothesis_ids": [
                _string(best_candidate.get("family_template_id"))
            ],
            "missing_strategy_families": [],
            "promotion_eligible": False,
            "reasons": reasons,
            "dependency_quorum": dependency_quorum,
        },
        "rollbackReadiness": {
            "killSwitchDryRunPassed": False,
            "gitopsRevertDryRunPassed": False,
            "strategyDisableDryRunPassed": False,
            "dryRunCompletedAt": "",
            "humanApproved": False,
            "rollbackTarget": "",
        },
    }


def _backtest_summary(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
    parity_report: Mapping[str, Any] | None,
    approval_report: Mapping[str, Any] | None,
    promotion_target: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    walkforward = {
        "schema_version": "torghut.runtime-closure-walkforward-results.v1",
        "run_id": runner_run_id,
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "dataset_snapshot_ref": manifest.snapshot_id,
        "status": "research_only",
        "runtime_family": _runtime_family(best_candidate),
        "runtime_strategy_name": _runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            _portfolio_runtime_strategy_names(best_candidate)
        ),
        "parity_replay": dict(parity_report or {}),
        "approval_replay": dict(approval_report or {}),
    }
    approval_metrics = (
        _mapping(_mapping(approval_report).get("scorecard"))
        if approval_report is not None
        else {}
    )
    evaluation = {
        "report_version": "torghut.runtime-closure-evaluation-report.v1",
        "generated_at": _now_iso(),
        "run_id": runner_run_id,
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "promotion_target": promotion_target,
        "recommended_mode": promotion_target,
        "promotion_allowed": False,
        "objective_met": bool(_mapping(approval_report).get("objective_met"))
        if approval_report is not None
        else False,
        "metrics": approval_metrics,
        "parity_replay": dict(parity_report or {}),
        "approval_replay": dict(approval_report or {}),
    }
    return walkforward, evaluation


def _profitability_stage_manifest(
    *,
    root: Path,
    runner_run_id: str,
    candidate_id: str,
    candidate_spec_path: Path,
    candidate_generation_manifest_path: Path,
    walkforward_results_path: Path,
    evaluation_report_path: Path,
    gate_report_path: Path,
    rollback_readiness_path: Path,
    portfolio_optimizer_evidence_path: Path | None,
    parity_replay_path: Path | None,
    approval_replay_path: Path | None,
    shadow_validation_path: Path | None,
    parity_pass: bool,
    approval_pass: bool,
    shadow_status: str,
) -> dict[str, Any]:
    def _artifact(path: Path, *, stage: str, check: str) -> dict[str, Any]:
        return {
            "path": str(path.relative_to(root)),
            "sha256": _sha256_path(path),
            "stage": stage,
            "check": check,
        }

    artifact_hashes = {
        str(candidate_spec_path.relative_to(root)): _sha256_path(candidate_spec_path),
        str(candidate_generation_manifest_path.relative_to(root)): _sha256_path(
            candidate_generation_manifest_path
        ),
        str(walkforward_results_path.relative_to(root)): _sha256_path(
            walkforward_results_path
        ),
        str(evaluation_report_path.relative_to(root)): _sha256_path(
            evaluation_report_path
        ),
        str(gate_report_path.relative_to(root)): _sha256_path(gate_report_path),
        str(rollback_readiness_path.relative_to(root)): _sha256_path(
            rollback_readiness_path
        ),
    }
    if parity_replay_path is not None and parity_replay_path.exists():
        artifact_hashes[str(parity_replay_path.relative_to(root))] = _sha256_path(
            parity_replay_path
        )
    if approval_replay_path is not None and approval_replay_path.exists():
        artifact_hashes[str(approval_replay_path.relative_to(root))] = _sha256_path(
            approval_replay_path
        )
    if shadow_validation_path is not None and shadow_validation_path.exists():
        artifact_hashes[str(shadow_validation_path.relative_to(root))] = _sha256_path(
            shadow_validation_path
        )
    if (
        portfolio_optimizer_evidence_path is not None
        and portfolio_optimizer_evidence_path.exists()
    ):
        artifact_hashes[
            str(portfolio_optimizer_evidence_path.relative_to(root))
        ] = _sha256_path(portfolio_optimizer_evidence_path)
    payload = {
        "schema_version": "profitability-stage-manifest-v1",
        "candidate_id": candidate_id,
        "strategy_family": "autoresearch_runtime_closure",
        "llm_artifact_ref": None,
        "router_artifact_ref": "runtime_harness",
        "run_context": _runtime_run_context(root=root, runner_run_id=runner_run_id),
        "stages": {
            "research": {
                "status": "pass",
                "checks": [
                    {"check": "candidate_spec_present", "status": "pass"},
                    {
                        "check": "candidate_generation_manifest_present",
                        "status": "pass",
                    },
                    {"check": "walkforward_results_present", "status": "pass"},
                    {"check": "baseline_evaluation_report_present", "status": "pass"},
                    *(
                        [
                            {
                                "check": "portfolio_optimizer_evidence_present",
                                "status": "pass",
                            }
                        ]
                        if portfolio_optimizer_evidence_path is not None
                        and portfolio_optimizer_evidence_path.exists()
                        else []
                    ),
                ],
                "artifacts": {
                    "candidate_spec": _artifact(
                        candidate_spec_path,
                        stage="research",
                        check="candidate_spec_present",
                    ),
                    "candidate_generation_manifest": _artifact(
                        candidate_generation_manifest_path,
                        stage="research",
                        check="candidate_generation_manifest_present",
                    ),
                    "walkforward_results": _artifact(
                        walkforward_results_path,
                        stage="research",
                        check="walkforward_results_present",
                    ),
                    "baseline_evaluation_report": _artifact(
                        evaluation_report_path,
                        stage="research",
                        check="baseline_evaluation_report_present",
                    ),
                    **(
                        {
                            "portfolio_optimizer_evidence": _artifact(
                                portfolio_optimizer_evidence_path,
                                stage="research",
                                check="portfolio_optimizer_evidence_present",
                            )
                        }
                        if portfolio_optimizer_evidence_path is not None
                        and portfolio_optimizer_evidence_path.exists()
                        else {}
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": _now_iso(),
            },
            "validation": {
                "status": "pass"
                if approval_replay_path is not None and approval_pass
                else "fail",
                "checks": [
                    {"check": "evaluation_report_present", "status": "pass"},
                    {
                        "check": "profitability_benchmark_present",
                        "status": "pass"
                        if approval_replay_path is not None
                        else "fail",
                    },
                    {
                        "check": "profitability_evidence_present",
                        "status": "pass"
                        if approval_replay_path is not None
                        else "fail",
                    },
                    {
                        "check": "profitability_validation_present",
                        "status": "pass" if approval_pass else "fail",
                    },
                ],
                "artifacts": {
                    "evaluation_report": _artifact(
                        evaluation_report_path,
                        stage="validation",
                        check="evaluation_report_present",
                    ),
                    **(
                        {
                            "approval_replay": _artifact(
                                approval_replay_path,
                                stage="validation",
                                check="profitability_benchmark_present",
                            )
                        }
                        if approval_replay_path is not None
                        and approval_replay_path.exists()
                        else {}
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": _now_iso(),
            },
            "execution": {
                "status": (
                    "pass"
                    if parity_pass
                    and approval_pass
                    and shadow_status in {"within_budget", "skipped"}
                    else "fail"
                ),
                "checks": [
                    {"check": "gate_evaluation_present", "status": "pass"},
                    {
                        "check": "gate_matrix_approval",
                        "status": "pass" if parity_pass and approval_pass else "fail",
                    },
                    {
                        "check": "drift_gate_approval",
                        "status": "pass"
                        if shadow_status in {"within_budget", "skipped"}
                        else "fail",
                    },
                ],
                "artifacts": {
                    "gate_evaluation": _artifact(
                        gate_report_path,
                        stage="execution",
                        check="gate_evaluation_present",
                    ),
                    **(
                        {
                            "parity_replay": _artifact(
                                parity_replay_path,
                                stage="execution",
                                check="gate_matrix_approval",
                            )
                        }
                        if parity_replay_path is not None
                        and parity_replay_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "shadow_validation": _artifact(
                                shadow_validation_path,
                                stage="execution",
                                check="drift_gate_approval",
                            )
                        }
                        if shadow_validation_path is not None
                        and shadow_validation_path.exists()
                        else {}
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": _now_iso(),
            },
            "governance": {
                "status": "fail",
                "checks": [
                    {"check": "rollback_ready", "status": "fail"},
                    {"check": "gate_report_present", "status": "pass"},
                    {"check": "candidate_spec_present", "status": "pass"},
                    {"check": "rollback_readiness_present", "status": "pass"},
                    {"check": "risk_controls_attestable", "status": "pass"},
                ],
                "artifacts": {
                    "candidate_spec": _artifact(
                        candidate_spec_path,
                        stage="governance",
                        check="candidate_spec_present",
                    ),
                    "gate_evaluation": _artifact(
                        gate_report_path,
                        stage="governance",
                        check="gate_report_present",
                    ),
                    "rollback_readiness": _artifact(
                        rollback_readiness_path,
                        stage="governance",
                        check="rollback_readiness_present",
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": _now_iso(),
            },
        },
        "overall_status": "fail",
        "failure_reasons": list(
            dict.fromkeys(
                [
                    *([] if approval_pass else ["validation_stage_incomplete"]),
                    *(
                        []
                        if parity_pass
                        and approval_pass
                        and shadow_status in {"within_budget", "skipped"}
                        else ["execution_stage_incomplete"]
                    ),
                    "governance_stage_incomplete",
                ]
            )
        ),
        "replay_contract": {
            "artifact_hashes": artifact_hashes,
            "contract_hash": _sha256_json({"artifact_hashes": artifact_hashes}),
            "hash_algorithm": "sha256",
        },
        "rollback_contract_ref": str(rollback_readiness_path.relative_to(root)),
        "created_at_utc": _now_iso(),
    }
    payload["content_hash"] = _sha256_json(
        {key: value for key, value in payload.items() if key != "content_hash"}
    )
    return payload


@dataclass(frozen=True)
class RuntimeClosureBundleSummary:
    status: str
    candidate_id: str
    root: str
    candidate_spec_path: str
    candidate_generation_manifest_path: str
    candidate_configmap_path: str
    gate_report_path: str
    parity_replay_path: str
    parity_report_path: str
    approval_replay_path: str
    approval_report_path: str
    shadow_validation_path: str
    candidate_state_path: str
    rollback_readiness_artifact_path: str
    rollback_readiness_evaluation_path: str
    policy_path: str
    portfolio_optimizer_evidence_path: str
    profitability_stage_manifest_path: str
    promotion_prerequisites_path: str
    replay_plan_path: str
    next_required_steps: tuple[str, ...]
    promotion_prerequisites: Mapping[str, Any]
    rollback_readiness: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "candidate_id": self.candidate_id,
            "root": self.root,
            "candidate_spec_path": self.candidate_spec_path,
            "candidate_generation_manifest_path": self.candidate_generation_manifest_path,
            "candidate_configmap_path": self.candidate_configmap_path,
            "gate_report_path": self.gate_report_path,
            "parity_replay_path": self.parity_replay_path,
            "parity_report_path": self.parity_report_path,
            "approval_replay_path": self.approval_replay_path,
            "approval_report_path": self.approval_report_path,
            "shadow_validation_path": self.shadow_validation_path,
            "candidate_state_path": self.candidate_state_path,
            "rollback_readiness_artifact_path": self.rollback_readiness_artifact_path,
            "rollback_readiness_evaluation_path": self.rollback_readiness_evaluation_path,
            "policy_path": self.policy_path,
            "portfolio_optimizer_evidence_path": self.portfolio_optimizer_evidence_path,
            "profitability_stage_manifest_path": self.profitability_stage_manifest_path,
            "promotion_prerequisites_path": self.promotion_prerequisites_path,
            "replay_plan_path": self.replay_plan_path,
            "next_required_steps": list(self.next_required_steps),
            "promotion_prerequisites": dict(self.promotion_prerequisites),
            "rollback_readiness": dict(self.rollback_readiness),
        }


def write_runtime_closure_bundle(
    *,
    run_root: Path,
    runner_run_id: str,
    program: StrategyAutoresearchProgram,
    best_candidate: Mapping[str, Any] | PortfolioCandidateSpec | None,
    manifest: MlxSnapshotManifest,
    execution_context: RuntimeClosureExecutionContext | None = None,
    replay_executor: Any | None = None,
) -> RuntimeClosureBundleSummary:
    closure_root = run_root / "runtime-closure"
    if best_candidate is None:
        summary = RuntimeClosureBundleSummary(
            status="missing_candidate",
            candidate_id="",
            root=str(closure_root),
            candidate_spec_path="",
            candidate_generation_manifest_path="",
            candidate_configmap_path="",
            gate_report_path="",
            parity_replay_path="",
            parity_report_path="",
            approval_replay_path="",
            approval_report_path="",
            shadow_validation_path="",
            candidate_state_path="",
            rollback_readiness_artifact_path="",
            rollback_readiness_evaluation_path="",
            policy_path="",
            portfolio_optimizer_evidence_path="",
            profitability_stage_manifest_path="",
            promotion_prerequisites_path="",
            replay_plan_path="",
            next_required_steps=(),
            promotion_prerequisites={},
            rollback_readiness={},
        )
        _write_json(closure_root / "summary.json", summary.to_payload())
        return summary

    best_candidate = _runtime_best_candidate_payload(best_candidate)
    candidate_id = _string(best_candidate.get("candidate_id"))
    candidate_spec_path = closure_root / "research" / "candidate-spec.json"
    candidate_generation_manifest_path = (
        closure_root / "research" / "candidate-generation-manifest.json"
    )
    candidate_configmap_path = closure_root / "replay" / "candidate-configmap.yaml"
    gate_report_path = closure_root / "gates" / "gate-evaluation.json"
    parity_replay_path = closure_root / "replay" / "scheduler-v3-parity-replay.json"
    parity_report_path = closure_root / "replay" / "scheduler-v3-parity-report.json"
    approval_replay_path = closure_root / "replay" / "scheduler-v3-approval-replay.json"
    approval_report_path = closure_root / "replay" / "scheduler-v3-approval-report.json"
    shadow_validation_path = closure_root / "replay" / "shadow-validation-plan.json"
    candidate_state_path = closure_root / "promotion" / "candidate-state.json"
    rollback_readiness_artifact_path = (
        closure_root / "gates" / "rollback-readiness.json"
    )
    rollback_readiness_evaluation_path = (
        closure_root / "promotion" / "rollback-readiness-evaluation.json"
    )
    policy_path = closure_root / "promotion" / "policy.json"
    portfolio_optimizer_evidence_path = (
        closure_root / "promotion" / "portfolio-optimizer-evidence.json"
    )
    profitability_stage_manifest_path = (
        closure_root / "profitability" / "profitability-stage-manifest-v1.json"
    )
    promotion_prerequisites_path = (
        closure_root / "promotion" / "promotion-prerequisites.json"
    )
    replay_plan_path = closure_root / "replay" / "runtime-replay-plan.json"
    walkforward_results_path = closure_root / "backtest" / "walkforward-results.json"
    evaluation_report_path = closure_root / "backtest" / "evaluation-report.json"

    candidate_spec = _candidate_spec(
        runner_run_id=runner_run_id,
        program=program,
        best_candidate=best_candidate,
        manifest=manifest,
    )
    candidate_generation_manifest = _candidate_generation_manifest(
        runner_run_id=runner_run_id,
        program=program,
        best_candidate=best_candidate,
        manifest=manifest,
    )
    portfolio_optimizer_evidence = _portfolio_optimizer_evidence(best_candidate)
    policy_payload = _runtime_closure_policy(best_candidate=best_candidate)

    _write_json(candidate_spec_path, candidate_spec)
    _write_json(candidate_generation_manifest_path, candidate_generation_manifest)
    _write_json(policy_path, policy_payload)
    if portfolio_optimizer_evidence:
        _write_json(portfolio_optimizer_evidence_path, portfolio_optimizer_evidence)

    replay_plan = {
        "schema_version": "torghut.runtime-closure-replay-plan.v1",
        "candidate_id": candidate_id,
        "dataset_snapshot_ref": manifest.snapshot_id,
        "source_window_start": manifest.source_window_start,
        "source_window_end": manifest.source_window_end,
        "runtime_family": _runtime_family(best_candidate),
        "runtime_strategy_name": _runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            _portfolio_runtime_strategy_names(best_candidate)
        ),
        "approval_path": "scheduler_v3",
        "required_steps": [
            "checked_in_runtime_family",
            "scheduler_v3_parity_replay",
            "scheduler_v3_approval_replay",
            "live_shadow_validation",
        ],
        "runtime_closure_policy": program.runtime_closure_policy.to_payload(),
        "execution_context": execution_context.to_payload()
        if execution_context is not None
        else None,
        "recommended_commands": [
            "run scheduler-v3 parity replay for the mapped runtime family on the snapshot window",
            "run scheduler-v3 approval replay on the same candidate family and snapshot contract",
            "attach shadow validation evidence before requesting promotion",
        ],
    }
    _write_json(replay_plan_path, replay_plan)

    parity_report: dict[str, Any] | None = None
    approval_report: dict[str, Any] | None = None
    if program.runtime_closure_policy.enabled and execution_context is not None:
        replay_runner = replay_executor or _default_replay_executor
        rendered_configmap_path = _materialize_candidate_configmap(
            best_candidate=best_candidate,
            execution_context=execution_context,
            output_path=candidate_configmap_path,
        )
        if program.runtime_closure_policy.execute_parity_replay:
            parity_payload = _run_runtime_replay(
                best_candidate=best_candidate,
                manifest=manifest,
                execution_context=execution_context,
                strategy_configmap_path=rendered_configmap_path,
                window_name=program.runtime_closure_policy.parity_window,
                replay_executor=replay_runner,
            )
            _write_json(parity_replay_path, parity_payload)
            parity_report = _replay_analysis(
                window_name=program.runtime_closure_policy.parity_window,
                replay_payload=parity_payload,
                best_candidate=best_candidate,
                program=program,
            )
            _write_json(parity_report_path, parity_report)
        if program.runtime_closure_policy.execute_approval_replay:
            approval_payload = _run_runtime_replay(
                best_candidate=best_candidate,
                manifest=manifest,
                execution_context=execution_context,
                strategy_configmap_path=rendered_configmap_path,
                window_name=program.runtime_closure_policy.approval_window,
                replay_executor=replay_runner,
            )
            _write_json(approval_replay_path, approval_payload)
            approval_report = _replay_analysis(
                window_name=program.runtime_closure_policy.approval_window,
                replay_payload=approval_payload,
                best_candidate=best_candidate,
                program=program,
            )
            _write_json(approval_report_path, approval_report)

    shadow_plan = _shadow_validation_artifact(
        best_candidate=best_candidate,
        program=program,
        execution_context=execution_context,
    )
    _write_json(shadow_validation_path, shadow_plan)
    gate_report = _gate_report(
        runner_run_id=runner_run_id,
        best_candidate=best_candidate,
        promotion_target=program.runtime_closure_policy.promotion_target,
        parity_report=parity_report,
        approval_report=approval_report,
        shadow_plan=shadow_plan,
        portfolio_optimizer_evidence_ref=(
            str(portfolio_optimizer_evidence_path.relative_to(closure_root))
            if portfolio_optimizer_evidence
            else None
        ),
    )
    _write_json(gate_report_path, gate_report)
    candidate_state = _candidate_state(
        runner_run_id=runner_run_id,
        best_candidate=best_candidate,
        manifest=manifest,
        parity_report=parity_report,
        approval_report=approval_report,
        shadow_plan=shadow_plan,
    )
    _write_json(candidate_state_path, candidate_state)

    rollback_readiness_result = evaluate_rollback_readiness(
        policy_payload=policy_payload,
        candidate_state_payload=candidate_state,
    )
    _write_json(
        rollback_readiness_artifact_path, rollback_readiness_result.to_payload()
    )
    _write_json(
        rollback_readiness_evaluation_path, rollback_readiness_result.to_payload()
    )

    walkforward_results, evaluation_report = _backtest_summary(
        runner_run_id=runner_run_id,
        best_candidate=best_candidate,
        manifest=manifest,
        parity_report=parity_report,
        approval_report=approval_report,
        promotion_target=program.runtime_closure_policy.promotion_target,
    )
    _write_json(walkforward_results_path, walkforward_results)
    _write_json(evaluation_report_path, evaluation_report)
    profitability_stage_manifest = _profitability_stage_manifest(
        root=closure_root,
        runner_run_id=runner_run_id,
        candidate_id=candidate_id,
        candidate_spec_path=candidate_spec_path,
        candidate_generation_manifest_path=candidate_generation_manifest_path,
        walkforward_results_path=walkforward_results_path,
        evaluation_report_path=evaluation_report_path,
        gate_report_path=gate_report_path,
        rollback_readiness_path=rollback_readiness_artifact_path,
        portfolio_optimizer_evidence_path=portfolio_optimizer_evidence_path
        if portfolio_optimizer_evidence_path.exists()
        else None,
        parity_replay_path=parity_replay_path if parity_replay_path.exists() else None,
        approval_replay_path=approval_replay_path
        if approval_replay_path.exists()
        else None,
        shadow_validation_path=shadow_validation_path
        if shadow_validation_path.exists()
        else None,
        parity_pass=bool(_mapping(parity_report).get("objective_met"))
        if parity_report is not None
        else False,
        approval_pass=bool(_mapping(approval_report).get("objective_met"))
        if approval_report is not None
        else False,
        shadow_status=_string(shadow_plan.get("status")),
    )
    _write_json(profitability_stage_manifest_path, profitability_stage_manifest)

    promotion_prerequisites_result = evaluate_promotion_prerequisites(
        policy_payload=policy_payload,
        gate_report_payload=gate_report,
        candidate_state_payload=candidate_state,
        promotion_target=program.runtime_closure_policy.promotion_target,
        artifact_root=closure_root,
    )
    _write_json(
        promotion_prerequisites_path, promotion_prerequisites_result.to_payload()
    )

    summary_status, next_required_steps = _summary_status_and_next_steps(
        parity_report=parity_report,
        approval_report=approval_report,
        shadow_plan=shadow_plan,
    )

    summary = RuntimeClosureBundleSummary(
        status=summary_status,
        candidate_id=candidate_id,
        root=str(closure_root),
        candidate_spec_path=str(candidate_spec_path),
        candidate_generation_manifest_path=str(candidate_generation_manifest_path),
        candidate_configmap_path=str(candidate_configmap_path)
        if candidate_configmap_path.exists()
        else "",
        gate_report_path=str(gate_report_path),
        parity_replay_path=str(parity_replay_path)
        if parity_replay_path.exists()
        else "",
        parity_report_path=str(parity_report_path)
        if parity_report_path.exists()
        else "",
        approval_replay_path=str(approval_replay_path)
        if approval_replay_path.exists()
        else "",
        approval_report_path=str(approval_report_path)
        if approval_report_path.exists()
        else "",
        shadow_validation_path=str(shadow_validation_path),
        candidate_state_path=str(candidate_state_path),
        rollback_readiness_artifact_path=str(rollback_readiness_artifact_path),
        rollback_readiness_evaluation_path=str(rollback_readiness_evaluation_path),
        policy_path=str(policy_path),
        portfolio_optimizer_evidence_path=str(portfolio_optimizer_evidence_path)
        if portfolio_optimizer_evidence_path.exists()
        else "",
        profitability_stage_manifest_path=str(profitability_stage_manifest_path),
        promotion_prerequisites_path=str(promotion_prerequisites_path),
        replay_plan_path=str(replay_plan_path),
        next_required_steps=next_required_steps,
        promotion_prerequisites=promotion_prerequisites_result.to_payload(),
        rollback_readiness=rollback_readiness_result.to_payload(),
    )
    _write_json(closure_root / "summary.json", summary.to_payload())
    return summary
