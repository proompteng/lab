"""Runtime-closure bundle helpers for MLX autoresearch outputs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

import yaml

from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.portfolio_candidates import PortfolioCandidateSpec
from app.trading.evidence_receipts import build_portfolio_proof_receipt
from app.trading.hypotheses import (
    hypothesis_registry_requires_dependency_capability,
    load_hypothesis_registry,
)
import scripts.local_intraday_tsmom_replay as replay_mod
from scripts.search_consistent_profitability_frontier import (
    apply_candidate_to_configmap_with_overrides,
)


from .context import (
    to_string,
    to_mapping,
    to_mapping_list,
    to_string_tuple,
    to_int,
    to_decimal,
    decimal_to_string,
    MICROBAR_PORTFOLIO_SIGNAL_SETTINGS,
    MICROBAR_PORTFOLIO_RUNTIME_PARAM_KEYS,
    PORTFOLIO_POLICY_REF_PREFIX,
    RuntimeClosureExecutionContext,
    date_from_iso,
    runtime_execution_realism_summary,
    runtime_family,
    runtime_strategy_name,
    candidate_params,
    candidate_strategy_overrides,
    disable_other_strategies,
    portfolio_payload,
    text_tuple,
)


@dataclass(frozen=True)
class RuntimeReplayRequest:
    best_candidate: Mapping[str, Any]
    manifest: MlxSnapshotManifest
    execution_context: RuntimeClosureExecutionContext
    strategy_configmap_path: Path
    window_name: str
    replay_executor: Any


@dataclass(frozen=True)
class MicrobarPortfolioContext:
    best_candidate: Mapping[str, Any]
    execution_context: RuntimeClosureExecutionContext
    base_per_leg_notional: Decimal
    symbols: tuple[str, ...]
    base_name: str
    candidate_id: str


@dataclass(frozen=True)
class GenericPortfolioContext:
    best_candidate: Mapping[str, Any]
    execution_context: RuntimeClosureExecutionContext
    base_per_leg_notional: Decimal
    symbols: tuple[str, ...]
    candidate_id: str


@dataclass(frozen=True)
class RenderedStrategyCatalog:
    rendered: dict[str, Any]
    data: dict[str, Any]
    catalog: dict[str, Any]
    strategies: list[Any]


@dataclass(frozen=True)
class MicrobarSleeveRuntimeParams:
    sleeve_params: Mapping[str, Any]
    signal: str
    signal_settings: Mapping[str, str]
    entry_minute: int
    exit_text: str
    top_n: int
    sleeve_symbols: Sequence[str]


def runtime_closure_policy(
    *, best_candidate: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    portfolio_optimizer_evidence_required = bool(
        portfolio_optimizer_evidence(best_candidate)
        if best_candidate is not None
        else {}
    )
    return {
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


def portfolio_proof_receipt_payload(
    *,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
    target_net_pnl_per_day: Decimal,
    runtime_closure_artifact_refs: Sequence[str],
) -> dict[str, Any]:
    objective_scorecard = to_mapping(best_candidate.get("objective_scorecard"))
    portfolio_candidate_id = to_string(
        best_candidate.get("portfolio_candidate_id")
    ) or to_string(best_candidate.get("candidate_id"))
    post_cost_net_pnl_per_day = to_decimal(
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
            "portfolio_optimizer": portfolio_optimizer_evidence(best_candidate),
            "runtime_strategy_names": list(
                portfolio_runtime_strategy_names(best_candidate)
            ),
        },
    )
    return receipt.to_payload()


def portfolio_candidate_runtime_payload(
    portfolio: PortfolioCandidateSpec,
) -> dict[str, Any]:
    payload = portfolio.to_payload()
    objective_scorecard = to_mapping(payload.get("objective_scorecard"))
    return {
        "candidate_id": portfolio.portfolio_candidate_id,
        "portfolio_candidate_id": portfolio.portfolio_candidate_id,
        "source_candidate_ids": list(portfolio.source_candidate_ids),
        "family_template_id": "portfolio_whitepaper_autoresearch_v1",
        "objective_scope": "research_only",
        "objective_met": bool(objective_scorecard.get("target_met")),
        "status": "keep",
        "target_net_pnl_per_day": str(portfolio.target_net_pnl_per_day),
        "net_pnl_per_day": to_string(objective_scorecard.get("net_pnl_per_day")),
        "active_day_ratio": to_string(objective_scorecard.get("active_day_ratio")),
        "positive_day_ratio": to_string(objective_scorecard.get("positive_day_ratio")),
        "best_day_share": to_string(objective_scorecard.get("best_day_share")),
        "worst_day_loss": to_string(objective_scorecard.get("worst_day_loss")),
        "max_drawdown": to_string(objective_scorecard.get("max_drawdown")),
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


def runtime_best_candidate_payload(
    best_candidate: Mapping[str, Any] | PortfolioCandidateSpec,
) -> dict[str, Any]:
    if isinstance(best_candidate, PortfolioCandidateSpec):
        return portfolio_candidate_runtime_payload(best_candidate)
    return dict(best_candidate)


def portfolio_optimizer_evidence(
    best_candidate: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if best_candidate is None:
        return {}
    portfolio = portfolio_payload(best_candidate)
    optimizer_report = to_mapping(best_candidate.get("optimizer_report"))
    objective_scorecard = to_mapping(best_candidate.get("objective_scorecard"))
    if not portfolio and not optimizer_report:
        return {}
    source_candidate_ids = text_tuple(best_candidate.get("source_candidate_ids"))
    if not source_candidate_ids:
        source_candidate_ids = text_tuple(portfolio.get("source_candidate_ids"))
    evidence_refs = text_tuple(best_candidate.get("evidence_refs"))
    if not evidence_refs:
        evidence_refs = text_tuple(portfolio.get("evidence_refs"))
    sleeves = to_mapping_list(portfolio.get("sleeves"))
    return {
        "schema_version": "torghut.portfolio-optimizer-evidence.v1",
        "portfolio_candidate_id": to_string(
            best_candidate.get("portfolio_candidate_id")
        )
        or to_string(best_candidate.get("candidate_id")),
        "candidate_id": to_string(best_candidate.get("candidate_id")),
        "source_candidate_ids": list(source_candidate_ids),
        "target_net_pnl_per_day": to_string(
            best_candidate.get("target_net_pnl_per_day")
        )
        or to_string(portfolio.get("target_net_pnl_per_day")),
        "sleeve_count": len(sleeves),
        "evidence_refs": list(evidence_refs),
        "objective_scorecard": objective_scorecard,
        "optimizer_report": optimizer_report,
        "capital_budget": to_mapping(best_candidate.get("capital_budget"))
        or to_mapping(portfolio.get("capital_budget")),
        "correlation_budget": to_mapping(best_candidate.get("correlation_budget"))
        or to_mapping(portfolio.get("correlation_budget")),
        "drawdown_budget": to_mapping(best_candidate.get("drawdown_budget"))
        or to_mapping(portfolio.get("drawdown_budget")),
        "target_met": bool(objective_scorecard.get("target_met")),
        "oracle_passed": bool(objective_scorecard.get("oracle_passed")),
    }


def portfolio_symbols(best_candidate: Mapping[str, Any]) -> tuple[str, ...]:
    override_symbols = to_string_tuple(
        candidate_strategy_overrides(best_candidate).get("universe_symbols")
    )
    if override_symbols:
        return override_symbols
    return to_string_tuple(portfolio_payload(best_candidate).get("symbols"))


def is_microbar_portfolio_candidate(best_candidate: Mapping[str, Any]) -> bool:
    replay_backend = to_string(
        to_mapping(best_candidate.get("replay_config")).get("backend")
    )
    return (
        to_string(best_candidate.get("family_template_id"))
        == "microbar_cross_sectional_pairs_v1"
        or runtime_family(best_candidate) == "microbar_cross_sectional_pairs"
        or replay_backend == "microbar_daily_portfolio"
    )


def microbar_portfolio_strategy_name(
    *,
    base_name: str,
    sleeve_index: int,
    side: str,
) -> str:
    return f"{base_name}-sleeve-{sleeve_index}-{side}"


def portfolio_runtime_strategy_names(
    best_candidate: Mapping[str, Any],
) -> tuple[str, ...]:
    portfolio = portfolio_payload(best_candidate)
    if not portfolio:
        strategy_name = runtime_strategy_name(best_candidate)
        return (strategy_name,) if strategy_name else ()
    if not is_microbar_portfolio_candidate(best_candidate):
        names: list[str] = []
        for sleeve_index, sleeve in enumerate(
            to_mapping_list(portfolio.get("sleeves")), start=1
        ):
            strategy_name = to_string(sleeve.get("runtime_strategy_name"))
            if not strategy_name:
                strategy_name = f"{runtime_strategy_name(best_candidate) or 'whitepaper-autoresearch'}-sleeve-{sleeve_index}"
            names.append(strategy_name)
        return tuple(names)
    base_name = (
        runtime_strategy_name(best_candidate) or "microbar-cross-sectional-pairs-v1"
    )
    names: list[str] = []
    sleeves = to_mapping_list(portfolio_payload(best_candidate).get("sleeves"))
    for sleeve_index, sleeve in enumerate(sleeves, start=1):
        names.append(
            microbar_portfolio_strategy_name(
                base_name=base_name, sleeve_index=sleeve_index, side="long"
            )
        )
        names.append(
            microbar_portfolio_strategy_name(
                base_name=base_name, sleeve_index=sleeve_index, side="short"
            )
        )
    return tuple(names)


def policy_ref_slug(value: str) -> str:
    normalized = "".join(
        character.lower() if character.isalnum() else "-" for character in value
    ).strip("-")
    while "--" in normalized:
        normalized = normalized.replace("--", "-")
    return normalized or "strategy"


def portfolio_policy_refs(
    *,
    best_candidate: Mapping[str, Any],
    strategy_names: tuple[str, ...],
) -> dict[str, list[str]]:
    portfolio = portfolio_payload(best_candidate)
    prefix = (
        to_string(portfolio.get("policy_ref_prefix")) or PORTFOLIO_POLICY_REF_PREFIX
    )
    candidate_slug = policy_ref_slug(
        to_string(best_candidate.get("candidate_id")) or "candidate"
    )

    refs: dict[str, list[str]] = {
        "promotion_policy_refs": [],
        "risk_profile_refs": [],
        "sizing_policy_refs": [],
        "execution_policy_refs": [],
    }
    for strategy_name in strategy_names:
        strategy_slug = policy_ref_slug(strategy_name)
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


def portfolio_promotion_v2(best_candidate: Mapping[str, Any]) -> dict[str, Any]:
    strategy_names = portfolio_runtime_strategy_names(best_candidate)
    if len(strategy_names) <= 1:
        return {}
    symbols = portfolio_symbols(best_candidate)
    policy_refs = portfolio_policy_refs(
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


def materialized_microbar_portfolio_runtime_strategies(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
) -> list[dict[str, Any]]:
    context = microbar_portfolio_context(
        best_candidate=best_candidate,
        execution_context=execution_context,
    )
    if context is None:
        return []
    sleeves = to_mapping_list(portfolio_payload(best_candidate).get("sleeves"))
    strategies: list[dict[str, Any]] = []
    for sleeve_index, sleeve in enumerate(sleeves, start=1):
        strategies.extend(
            materialized_microbar_sleeve_strategies(
                context=context,
                sleeve_index=sleeve_index,
                sleeve=sleeve,
            )
        )
    return strategies


def microbar_portfolio_context(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
) -> MicrobarPortfolioContext | None:
    if not is_microbar_portfolio_candidate(best_candidate):
        return None
    portfolio = portfolio_payload(best_candidate)
    if not to_mapping_list(portfolio.get("sleeves")):
        return None
    base_per_leg_notional = to_decimal(portfolio.get("base_per_leg_notional"))
    if base_per_leg_notional <= 0:
        raise ValueError(
            "runtime_closure_microbar_portfolio_base_per_leg_notional_missing"
        )
    symbols = portfolio_symbols(best_candidate) or execution_context.symbols
    if not symbols:
        raise ValueError("runtime_closure_microbar_portfolio_symbols_missing")
    return MicrobarPortfolioContext(
        best_candidate=best_candidate,
        execution_context=execution_context,
        base_per_leg_notional=base_per_leg_notional,
        symbols=tuple(symbols),
        base_name=runtime_strategy_name(best_candidate)
        or "microbar-cross-sectional-pairs-v1",
        candidate_id=to_string(best_candidate.get("candidate_id")) or "runtime-closure",
    )


def materialized_microbar_sleeve_strategies(
    *,
    context: MicrobarPortfolioContext,
    sleeve_index: int,
    sleeve: Mapping[str, Any],
) -> list[dict[str, Any]]:
    sleeve_params = to_mapping(sleeve.get("params"))
    signal = to_string(sleeve.get("signal")) or to_string(
        sleeve_params.get("signal_motif")
    )
    signal_settings = MICROBAR_PORTFOLIO_SIGNAL_SETTINGS.get(signal)
    if signal_settings is None:
        raise ValueError(
            f"runtime_closure_microbar_portfolio_signal_unsupported:{signal}"
        )
    entry_minute = max(
        0,
        to_int(
            sleeve.get("entry_minute_after_open")
            or sleeve_params.get("entry_minute_after_open")
        ),
    )
    exit_text = (
        to_string(sleeve.get("exit_minute_after_open"))
        or to_string(sleeve_params.get("exit_minute_after_open"))
        or "close"
    )
    top_n = max(1, to_int(sleeve.get("top_n") or sleeve_params.get("top_n")))
    sleeve_symbols = microbar_sleeve_symbols(sleeve, fallback=context.symbols)
    weight = to_decimal(sleeve.get("weight"), default="1")
    if weight <= 0:
        weight = Decimal("1")
    max_notional_per_trade = context.base_per_leg_notional * weight
    return [
        {
            "name": microbar_portfolio_strategy_name(
                base_name=context.base_name,
                sleeve_index=sleeve_index,
                side=side,
            ),
            "strategy_id": f"{strategy_type}@runtime-closure:{context.candidate_id}:s{sleeve_index}:{side}",
            "strategy_type": strategy_type,
            "version": "1.0.0",
            "description": (
                f"Runtime-closure materialized sleeve {sleeve_index} "
                f"for {runtime_family(context.best_candidate) or 'microbar portfolio'}"
            ),
            "enabled": True,
            "base_timeframe": "1Sec",
            "universe_type": strategy_type,
            "universe_symbols": list(sleeve_symbols),
            "max_notional_per_trade": decimal_to_string(max_notional_per_trade),
            "max_position_pct_equity": decimal_to_string(
                max_position_pct_equity(
                    max_notional_per_trade=max_notional_per_trade,
                    execution_context=context.execution_context,
                )
            ),
            "params": microbar_sleeve_runtime_params(
                MicrobarSleeveRuntimeParams(
                    sleeve_params=sleeve_params,
                    signal=signal,
                    signal_settings=signal_settings,
                    entry_minute=entry_minute,
                    exit_text=exit_text,
                    top_n=top_n,
                    sleeve_symbols=sleeve_symbols,
                )
            ),
        }
        for side, strategy_type in (
            ("long", "microbar_cross_sectional_long_v1"),
            ("short", "microbar_cross_sectional_short_v1"),
        )
    ]


def microbar_sleeve_symbols(
    sleeve: Mapping[str, Any], *, fallback: Sequence[str]
) -> list[str]:
    return [
        symbol
        for symbol in (
            to_string(item).upper()
            for item in cast(Sequence[Any], sleeve.get("universe_symbols") or [])
        )
        if symbol
    ] or list(fallback)


def max_position_pct_equity(
    *,
    max_notional_per_trade: Decimal,
    execution_context: RuntimeClosureExecutionContext,
) -> Decimal:
    if execution_context.start_equity > 0:
        raw_pct = max_notional_per_trade / execution_context.start_equity
    else:
        raw_pct = Decimal("10")
    return max(raw_pct, Decimal("0.1"))


def microbar_sleeve_runtime_params(
    request: MicrobarSleeveRuntimeParams,
) -> dict[str, Any]:
    return {
        "entry_minute_after_open": str(request.entry_minute),
        "exit_minute_after_open": request.exit_text,
        "signal_motif": request.signal,
        "rank_feature": to_string(request.sleeve_params.get("rank_feature"))
        or request.signal_settings["rank_feature"],
        "selection_mode": to_string(request.sleeve_params.get("selection_mode"))
        or request.signal_settings["selection_mode"],
        "top_n": str(request.top_n),
        "universe_size": str(len(request.sleeve_symbols)),
        "max_concurrent_positions": str(request.top_n),
        "max_entries_per_session": str(request.top_n),
        "position_isolation_mode": "per_strategy",
        **{
            key: to_string(request.sleeve_params.get(key))
            for key in MICROBAR_PORTFOLIO_RUNTIME_PARAM_KEYS
            if to_string(request.sleeve_params.get(key))
        },
    }


def materialized_generic_portfolio_runtime_strategies(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
) -> list[dict[str, Any]]:
    context = generic_portfolio_context(
        best_candidate=best_candidate,
        execution_context=execution_context,
    )
    if context is None:
        return []
    return [
        materialized_generic_sleeve_strategy(
            context=context,
            sleeve_index=sleeve_index,
            sleeve=sleeve,
        )
        for sleeve_index, sleeve in enumerate(
            to_mapping_list(portfolio_payload(best_candidate).get("sleeves")),
            start=1,
        )
    ]


def generic_portfolio_context(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
) -> GenericPortfolioContext | None:
    if is_microbar_portfolio_candidate(best_candidate):
        return None
    portfolio = portfolio_payload(best_candidate)
    if not to_mapping_list(portfolio.get("sleeves")):
        return None
    base_per_leg_notional = to_decimal(
        portfolio.get("base_per_leg_notional"), default="50000"
    )
    if base_per_leg_notional <= 0:
        base_per_leg_notional = Decimal("50000")
    symbols = portfolio_symbols(best_candidate) or execution_context.symbols
    if not symbols:
        raise ValueError("runtime_closure_generic_portfolio_symbols_missing")
    return GenericPortfolioContext(
        best_candidate=best_candidate,
        execution_context=execution_context,
        base_per_leg_notional=base_per_leg_notional,
        symbols=tuple(symbols),
        candidate_id=to_string(best_candidate.get("candidate_id")) or "runtime-closure",
    )


def materialized_generic_sleeve_strategy(
    *,
    context: GenericPortfolioContext,
    sleeve_index: int,
    sleeve: Mapping[str, Any],
) -> dict[str, Any]:
    sleeve_params = to_mapping(sleeve.get("params"))
    sleeve_runtime_family = (
        to_string(sleeve.get("runtime_family"))
        or runtime_family(context.best_candidate)
        or "whitepaper_autoresearch_sleeve"
    )
    strategy_name = (
        to_string(sleeve.get("runtime_strategy_name"))
        or f"whitepaper-autoresearch-sleeve-{sleeve_index}"
    )
    weight = to_decimal(sleeve.get("weight"), default="1")
    if weight <= 0:
        weight = Decimal("1")
    max_notional_per_trade = generic_sleeve_notional(
        context=context,
        sleeve=sleeve,
        weight=weight,
    )
    return {
        "name": strategy_name,
        "strategy_id": f"{sleeve_runtime_family}@runtime-closure:{context.candidate_id}:s{sleeve_index}",
        "strategy_type": sleeve_runtime_family,
        "version": "1.0.0",
        "description": f"Runtime-closure materialized whitepaper autoresearch sleeve {sleeve_index}",
        "enabled": True,
        "base_timeframe": "1Sec",
        "universe_type": sleeve_runtime_family,
        "universe_symbols": list(
            to_string_tuple(sleeve.get("symbols"))
            or to_string_tuple(sleeve.get("universe_symbols"))
            or context.symbols
        ),
        "max_notional_per_trade": decimal_to_string(max_notional_per_trade),
        "max_position_pct_equity": decimal_to_string(
            max_position_pct_equity(
                max_notional_per_trade=max_notional_per_trade,
                execution_context=context.execution_context,
            )
        ),
        "params": generic_sleeve_runtime_params(
            sleeve=sleeve,
            sleeve_params=sleeve_params,
            candidate_id=context.candidate_id,
            weight=weight,
        ),
    }


def generic_sleeve_notional(
    *,
    context: GenericPortfolioContext,
    sleeve: Mapping[str, Any],
    weight: Decimal,
) -> Decimal:
    max_notional_per_trade = to_decimal(sleeve.get("max_notional_per_trade"))
    if max_notional_per_trade > 0:
        return max_notional_per_trade
    return context.base_per_leg_notional * weight


def generic_sleeve_runtime_params(
    *,
    sleeve: Mapping[str, Any],
    sleeve_params: Mapping[str, Any],
    candidate_id: str,
    weight: Decimal,
) -> dict[str, Any]:
    return {
        **{str(key): value for key, value in sleeve_params.items()},
        "source_candidate_id": to_string(sleeve.get("candidate_id")),
        "candidate_spec_id": to_string(sleeve.get("candidate_spec_id")),
        "portfolio_candidate_id": candidate_id,
        "sleeve_weight": decimal_to_string(weight),
        "expected_net_pnl_per_day": to_string(sleeve.get("expected_net_pnl_per_day")),
        "risk_contribution": to_string(sleeve.get("risk_contribution")),
        "correlation_cluster": to_string(sleeve.get("correlation_cluster")),
        "position_isolation_mode": "per_strategy",
    }


def candidate_symbols(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
) -> tuple[str, ...]:
    override_symbols = portfolio_symbols(best_candidate)
    if override_symbols:
        return override_symbols
    return execution_context.symbols


def window_bounds(
    *,
    best_candidate: Mapping[str, Any],
    window_name: str,
    manifest: MlxSnapshotManifest,
) -> tuple[date, date]:
    replay_config = to_mapping(best_candidate.get("replay_config"))
    start_key = f"{window_name}_start_date"
    end_key = f"{window_name}_end_date"
    start_text = to_string(best_candidate.get(start_key)) or to_string(
        replay_config.get(start_key)
    )
    end_text = to_string(best_candidate.get(end_key)) or to_string(
        replay_config.get(end_key)
    )
    if not start_text or not end_text:
        if window_name != "full_window":
            raise ValueError(f"runtime_closure_window_missing:{window_name}")
        start_text = manifest.source_window_start
        end_text = manifest.source_window_end
    return (date_from_iso(start_text), date_from_iso(end_text))


def load_strategy_configmap_payload(path: Path) -> dict[str, Any]:
    source = path.read_text(encoding="utf-8")
    payload = yaml.safe_load(source)
    if not isinstance(payload, Mapping):
        raise ValueError("strategy_configmap_not_mapping")
    payload_mapping = cast(Mapping[str, Any], payload)
    data = payload_mapping.get("data")
    if isinstance(data, Mapping):
        data_mapping = cast(Mapping[str, Any], data)
        if isinstance(data_mapping.get("strategies.yaml"), str):
            return dict(payload_mapping)
    if isinstance(payload_mapping.get("strategies"), list):
        return {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {"name": path.stem},
            "data": {"strategies.yaml": source},
        }
    raise ValueError("strategy_configmap_missing_strategies_yaml")


def materialize_candidate_configmap(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
    output_path: Path,
) -> Path:
    configmap_payload = load_strategy_configmap_payload(
        execution_context.strategy_configmap_path
    )
    portfolio_runtime_strategies = [
        *materialized_microbar_portfolio_runtime_strategies(
            best_candidate=best_candidate,
            execution_context=execution_context,
        ),
        *materialized_generic_portfolio_runtime_strategies(
            best_candidate=best_candidate,
            execution_context=execution_context,
        ),
    ]
    if portfolio_runtime_strategies:
        rendered = render_portfolio_candidate_configmap(
            configmap_payload=configmap_payload,
            best_candidate=best_candidate,
            portfolio_runtime_strategies=portfolio_runtime_strategies,
        )
    else:
        rendered = render_single_candidate_configmap(
            configmap_payload=configmap_payload,
            best_candidate=best_candidate,
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(yaml.safe_dump(rendered, sort_keys=False), encoding="utf-8")
    return output_path


def render_portfolio_candidate_configmap(
    *,
    configmap_payload: Mapping[str, Any],
    best_candidate: Mapping[str, Any],
    portfolio_runtime_strategies: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    catalog = rendered_strategy_catalog(configmap_payload)
    if disable_other_strategies(best_candidate):
        disable_strategy_entries(catalog.strategies)
    merge_strategy_entries(
        strategies=catalog.strategies,
        portfolio_runtime_strategies=portfolio_runtime_strategies,
    )
    catalog.data["strategies.yaml"] = yaml.safe_dump(catalog.catalog, sort_keys=False)
    return catalog.rendered


def rendered_strategy_catalog(
    configmap_payload: Mapping[str, Any],
) -> RenderedStrategyCatalog:
    rendered_payload = yaml.safe_load(
        yaml.safe_dump(configmap_payload, sort_keys=False)
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
    return RenderedStrategyCatalog(
        rendered=rendered,
        data=data,
        catalog=catalog,
        strategies=cast(list[Any], strategies_payload),
    )


def disable_strategy_entries(strategies: Sequence[Any]) -> None:
    for item in strategies:
        if isinstance(item, dict):
            item["enabled"] = False


def merge_strategy_entries(
    *,
    strategies: list[Any],
    portfolio_runtime_strategies: Sequence[Mapping[str, Any]],
) -> None:
    by_name: dict[str, int] = {}
    for index, item in enumerate(strategies):
        if not isinstance(item, Mapping):
            continue
        item_mapping = cast(Mapping[str, Any], item)
        item_name = to_string(item_mapping.get("name"))
        if item_name:
            by_name[item_name] = index
    for item in portfolio_runtime_strategies:
        item_name = to_string(item.get("name"))
        if item_name in by_name:
            strategies[by_name[item_name]] = dict(item)
        else:
            strategies.append(dict(item))


def render_single_candidate_configmap(
    *,
    configmap_payload: Mapping[str, Any],
    best_candidate: Mapping[str, Any],
) -> dict[str, Any]:
    strategy_name = runtime_strategy_name(best_candidate)
    if not strategy_name:
        raise ValueError("runtime_closure_missing_runtime_strategy_name")
    rendered_candidate_params = candidate_params(best_candidate)
    if not rendered_candidate_params:
        raise ValueError("runtime_closure_missing_candidate_params")
    return apply_candidate_to_configmap_with_overrides(
        configmap_payload=configmap_payload,
        strategy_name=strategy_name,
        candidate_params=rendered_candidate_params,
        strategy_overrides=candidate_strategy_overrides(best_candidate),
        disable_other_strategies=disable_other_strategies(best_candidate),
    )


def default_replay_executor(config: replay_mod.ReplayConfig) -> dict[str, Any]:
    payload = dict(replay_mod.run_replay(config))
    realism_summary = runtime_execution_realism_summary(payload)
    missing_evidence = list(realism_summary["execution_realism_missing_evidence"])
    payload["execution_realism_status"] = realism_summary["execution_realism_status"]
    payload["execution_realism_missing_evidence"] = missing_evidence
    execution_realism = to_mapping(payload.get("execution_realism"))
    execution_realism["status"] = realism_summary["execution_realism_status"]
    execution_realism["missing_evidence"] = missing_evidence
    payload["execution_realism"] = execution_realism
    return payload


def run_runtime_replay(request: RuntimeReplayRequest) -> dict[str, Any]:
    start_date, end_date = window_bounds(
        best_candidate=request.best_candidate,
        window_name=request.window_name,
        manifest=request.manifest,
    )
    config = replay_mod.ReplayConfig(
        strategy_configmap_path=request.strategy_configmap_path,
        clickhouse_http_url=request.execution_context.clickhouse_http_url,
        clickhouse_username=request.execution_context.clickhouse_username,
        clickhouse_password=request.execution_context.clickhouse_password,
        start_date=start_date,
        end_date=end_date,
        chunk_minutes=max(1, request.execution_context.chunk_minutes),
        flatten_eod=True,
        start_equity=request.execution_context.start_equity,
        symbols=candidate_symbols(
            best_candidate=request.best_candidate,
            execution_context=request.execution_context,
        ),
        progress_log_interval_seconds=max(
            1, request.execution_context.progress_log_interval_seconds
        ),
    )
    return cast(dict[str, Any], request.replay_executor(config))
