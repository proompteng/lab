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

from .part_01_discover_runtime_root import *


def _portfolio_candidate_runtime_payload(
    portfolio: PortfolioCandidateSpec,
) -> dict[str, Any]:
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
        "portfolio_candidate_id": _string(best_candidate.get("portfolio_candidate_id"))
        or _string(best_candidate.get("candidate_id")),
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "source_candidate_ids": list(source_candidate_ids),
        "target_net_pnl_per_day": _string(best_candidate.get("target_net_pnl_per_day"))
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
        sleeve_params = _mapping(sleeve.get("params"))
        signal = _string(sleeve.get("signal")) or _string(
            sleeve_params.get("signal_motif")
        )
        signal_settings = _MICROBAR_PORTFOLIO_SIGNAL_SETTINGS.get(signal)
        if signal_settings is None:
            raise ValueError(
                f"runtime_closure_microbar_portfolio_signal_unsupported:{signal}"
            )
        entry_minute = max(
            0,
            _int(
                sleeve.get("entry_minute_after_open")
                or sleeve_params.get("entry_minute_after_open")
            ),
        )
        exit_text = (
            _string(sleeve.get("exit_minute_after_open"))
            or _string(sleeve_params.get("exit_minute_after_open"))
            or "close"
        )
        top_n = max(1, _int(sleeve.get("top_n") or sleeve_params.get("top_n")))
        sleeve_symbols = [
            symbol
            for symbol in (
                _string(item).upper()
                for item in cast(Sequence[Any], sleeve.get("universe_symbols") or [])
            )
            if symbol
        ] or list(symbols)
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
                    "universe_symbols": list(sleeve_symbols),
                    "max_notional_per_trade": _decimal_string(max_notional_per_trade),
                    "max_position_pct_equity": _decimal_string(max_position_pct_equity),
                    "params": {
                        "entry_minute_after_open": str(entry_minute),
                        "exit_minute_after_open": exit_text,
                        "signal_motif": signal,
                        "rank_feature": _string(sleeve_params.get("rank_feature"))
                        or signal_settings["rank_feature"],
                        "selection_mode": _string(sleeve_params.get("selection_mode"))
                        or signal_settings["selection_mode"],
                        "top_n": str(top_n),
                        "universe_size": str(len(sleeve_symbols)),
                        "max_concurrent_positions": str(top_n),
                        "max_entries_per_session": str(top_n),
                        "position_isolation_mode": "per_strategy",
                        **{
                            key: _string(sleeve_params.get(key))
                            for key in _MICROBAR_PORTFOLIO_RUNTIME_PARAM_KEYS
                            if _string(sleeve_params.get(key))
                        },
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
        sleeve_params = _mapping(sleeve.get("params"))
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
        strategy_symbols = (
            _list_of_strings(sleeve.get("symbols"))
            or _list_of_strings(sleeve.get("universe_symbols"))
            or symbols
        )
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
                    **{str(key): value for key, value in sleeve_params.items()},
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


def _load_strategy_configmap_payload(path: Path) -> dict[str, Any]:
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


def _materialize_candidate_configmap(
    *,
    best_candidate: Mapping[str, Any],
    execution_context: RuntimeClosureExecutionContext,
    output_path: Path,
) -> Path:
    configmap_payload = _load_strategy_configmap_payload(
        execution_context.strategy_configmap_path
    )
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
    payload = dict(replay_mod.run_replay(config))
    realism_summary = _runtime_execution_realism_summary(payload)
    missing_evidence = list(realism_summary["execution_realism_missing_evidence"])
    payload["execution_realism_status"] = realism_summary["execution_realism_status"]
    payload["execution_realism_missing_evidence"] = missing_evidence
    execution_realism = _mapping(payload.get("execution_realism"))
    execution_realism["status"] = realism_summary["execution_realism_status"]
    execution_realism["missing_evidence"] = missing_evidence
    payload["execution_realism"] = execution_realism
    return payload


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


__all__ = [name for name in globals() if not name.startswith("__")]
