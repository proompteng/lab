"""Deterministic autonomous lane: research -> gate evaluation -> paper candidate patch."""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, cast


import yaml

from ...models import (
    Strategy,
)
from ..evaluation import (
    WalkForwardDecision,
)
from .gates import (
    PromotionTarget,
)
from .runtime import (
    StrategyRuntimeConfig,
)


def _baseline_runtime_strategies() -> list[StrategyRuntimeConfig]:
    return [
        StrategyRuntimeConfig(
            strategy_id="baseline-legacy-macd-rsi",
            strategy_type="legacy_macd_rsi",
            version="1.0.0",
            params={"buy_rsi_threshold": 35, "sell_rsi_threshold": 65, "qty": 1},
            base_timeframe="1Min",
            enabled=True,
            priority=0,
        )
    ]


def _profitability_threshold_payload(
    policy_payload: dict[str, Any],
) -> dict[str, object]:
    return {
        "min_market_net_pnl_delta": str(
            policy_payload.get("gate6_min_market_net_pnl_delta", "0")
        ),
        "min_risk_adjusted_return_over_drawdown": str(
            policy_payload.get("gate6_min_return_over_drawdown", "0")
        ),
        "min_regime_slice_pass_ratio": str(
            policy_payload.get("gate6_min_regime_slice_pass_ratio", "0.50")
        ),
        "max_cost_bps": str(policy_payload.get("gate6_max_cost_bps", "35")),
        "max_calibration_error": str(
            policy_payload.get("gate6_max_calibration_error", "0.45")
        ),
        "min_confidence_samples": int(
            policy_payload.get("gate6_min_confidence_samples", 1)
        ),
        "min_reproducibility_hashes": int(
            policy_payload.get("gate6_min_reproducibility_hashes", 5)
        ),
    }


def _collect_confidence_values(decisions: list[WalkForwardDecision]) -> list[Decimal]:
    values: list[Decimal] = []
    for item in decisions:
        raw_value = item.decision.params.get("confidence")
        if raw_value is None:
            runtime_payload = item.decision.params.get("runtime")
            if isinstance(runtime_payload, Mapping):
                raw_value = cast(Mapping[str, Any], runtime_payload).get("confidence")
        if raw_value is None:
            continue
        try:
            values.append(Decimal(str(raw_value)))
        except (ArithmeticError, TypeError, ValueError):
            continue
    return values


def _to_orm_strategies(
    runtime_strategies: list[StrategyRuntimeConfig],
) -> list[Strategy]:
    strategies: list[Strategy] = []
    for item in runtime_strategies:
        strategies.append(
            Strategy(
                name=item.strategy_id,
                description=f"{item.strategy_type}@{item.version}",
                enabled=item.enabled,
                base_timeframe=item.base_timeframe,
                universe_type=_strategy_universe_type(item.strategy_type),
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=None,
            )
        )
    return strategies


def _strategy_universe_type(strategy_type: str) -> str:
    normalized = strategy_type.strip().lower()
    if normalized in {"static", "legacy_macd_rsi"}:
        return "static"
    if normalized in {"intraday_tsmom", "intraday_tsmom_v1", "tsmom_intraday"}:
        return "intraday_tsmom_v1"
    return strategy_type


def _evaluate_drift_promotion_gate(
    *,
    promotion_target: PromotionTarget,
    drift_promotion_evidence: dict[str, Any] | None,
) -> dict[str, Any]:
    evidence = drift_promotion_evidence or {}
    artifact_refs_raw = evidence.get("evidence_artifact_refs")
    artifact_refs = (
        [
            str(item)
            for item in cast(list[object], artifact_refs_raw)
            if str(item).strip()
        ]
        if isinstance(artifact_refs_raw, list)
        else []
    )
    if promotion_target != "live":
        return {
            "allowed": True,
            "reasons": [],
            "eligible_for_live_promotion": bool(
                evidence.get("eligible_for_live_promotion", False)
            ),
            "artifact_refs": sorted(set(artifact_refs)),
        }

    if not evidence:
        return {
            "allowed": False,
            "reasons": ["drift_promotion_evidence_missing"],
            "eligible_for_live_promotion": False,
            "artifact_refs": [],
        }

    reasons_raw = evidence.get("reasons")
    reasons = (
        [str(item) for item in cast(list[object], reasons_raw) if str(item).strip()]
        if isinstance(reasons_raw, list)
        else []
    )
    eligible = bool(evidence.get("eligible_for_live_promotion", False))
    if not eligible:
        if not reasons:
            reasons.append("drift_promotion_evidence_not_eligible")
        return {
            "allowed": False,
            "reasons": sorted(set(reasons)),
            "eligible_for_live_promotion": False,
            "artifact_refs": sorted(set(artifact_refs)),
        }
    return {
        "allowed": True,
        "reasons": [],
        "eligible_for_live_promotion": True,
        "artifact_refs": sorted(set(artifact_refs)),
    }


def _write_paper_candidate_patch(
    *,
    configmap_path: Path,
    runtime_strategies: list[StrategyRuntimeConfig],
    candidate_id: str,
    output_path: Path,
) -> Path:
    configmap_payload_raw: object = yaml.safe_load(
        configmap_path.read_text(encoding="utf-8")
    )
    if not isinstance(configmap_payload_raw, Mapping):
        raise ValueError("invalid configmap payload")
    configmap_payload = cast(Mapping[str, Any], configmap_payload_raw)

    candidate_strategies: list[dict[str, Any]] = []
    for strategy in runtime_strategies:
        if not strategy.enabled:
            continue
        candidate_strategies.append(
            {
                "name": strategy.strategy_id,
                "description": f"Autonomous candidate {candidate_id} ({strategy.strategy_type}@{strategy.version})",
                "enabled": True,
                "base_timeframe": strategy.base_timeframe,
                "universe_type": _strategy_universe_type(strategy.strategy_type),
                "max_notional_per_trade": 250,
                "max_position_pct_equity": 0.025,
            }
        )

    candidate_strategies.sort(key=lambda item: str(item["name"]))

    metadata_raw = configmap_payload.get("metadata", {})
    metadata: dict[str, Any] = (
        dict(cast(Mapping[str, Any], metadata_raw))
        if isinstance(metadata_raw, Mapping)
        else {}
    )
    patch_payload: dict[str, Any] = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": metadata.get("name", "torghut-strategy-config"),
            "namespace": metadata.get("namespace", "torghut"),
            "annotations": {
                "torghut.proompteng.ai/candidate-id": candidate_id,
                "torghut.proompteng.ai/recommended-mode": "paper",
            },
        },
        "data": {
            "strategies.yaml": yaml.safe_dump(
                {"strategies": candidate_strategies}, sort_keys=False
            ),
        },
    }
    output_path.write_text(
        yaml.safe_dump(patch_payload, sort_keys=False), encoding="utf-8"
    )
    return output_path


baseline_runtime_strategies = _baseline_runtime_strategies
profitability_threshold_payload = _profitability_threshold_payload
collect_confidence_values = _collect_confidence_values
to_orm_strategies = _to_orm_strategies
strategy_universe_type = _strategy_universe_type
evaluate_drift_promotion_gate = _evaluate_drift_promotion_gate
write_paper_candidate_patch = _write_paper_candidate_patch

__all__ = [
    "_baseline_runtime_strategies",
    "_profitability_threshold_payload",
    "_collect_confidence_values",
    "_to_orm_strategies",
    "_strategy_universe_type",
    "_evaluate_drift_promotion_gate",
    "_write_paper_candidate_patch",
]
