"""Compile whitepaper hypothesis cards into executable Torghut candidate specs."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

import yaml

from app.trading.discovery.candidate_specs import CandidateSpec, compile_candidate_specs
from app.trading.discovery.hypothesis_cards import (
    HypothesisCard,
    build_hypothesis_cards,
)


EXECUTABLE_FAMILY_IDS = {
    "breakout_reclaim_v2",
    "washout_rebound_v2",
    "momentum_pullback_v1",
    "mean_reversion_rebound_v1",
    "microbar_cross_sectional_pairs_v1",
    "microstructure_continuation_matched_filter_v1",
    "intraday_tsmom_v2",
    "late_day_continuation_v1",
}

FEATURE_ALIASES = {
    "trade_flow": "order_flow_imbalance",
    "relative_volume": "turnover",
    "clustered_order_events": "order_flow_imbalance",
    "depth_proxy": "quote_quality",
    "execution_shortfall": "transaction_cost_stress",
    "order_arrival_clustering": "information_arrival_rate",
    "volatility_state": "realized_volatility",
    "spread_bps": "max_spread_bps",
    "executed_trade_obi": "order_flow_imbalance",
    "signed_trade_volume": "order_flow_imbalance",
    "weighted_microprice_momentum": "order_flow_imbalance",
    "multi_level_order_book": "order_flow_imbalance",
    "macro_announcement_window": "information_arrival_rate",
    "dvar": "realized_volatility",
}


@dataclass(frozen=True)
class CandidateCompilationBlocker:
    candidate_spec_id: str
    reason: str
    detail: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "candidate_spec_id": self.candidate_spec_id,
            "reason": self.reason,
            "detail": dict(self.detail),
        }


@dataclass(frozen=True)
class WhitepaperCandidateCompilation:
    candidate_specs: tuple[CandidateSpec, ...]
    executable_specs: tuple[CandidateSpec, ...]
    blocked_specs: tuple[CandidateSpec, ...]
    blockers: tuple[CandidateCompilationBlocker, ...]
    whitepaper_experiment_payloads: tuple[Mapping[str, Any], ...]
    vnext_experiment_payloads: tuple[Mapping[str, Any], ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            "candidate_specs": [item.to_payload() for item in self.candidate_specs],
            "executable_candidate_spec_ids": [
                item.candidate_spec_id for item in self.executable_specs
            ],
            "blocked_candidate_spec_ids": [
                item.candidate_spec_id for item in self.blocked_specs
            ],
            "blockers": [item.to_payload() for item in self.blockers],
            "whitepaper_experiment_payloads": [
                dict(item) for item in self.whitepaper_experiment_payloads
            ],
            "vnext_experiment_payloads": [
                dict(item) for item in self.vnext_experiment_payloads
            ],
        }


def _load_family_template(
    family_template_id: str,
    *,
    family_template_dir: Path | None,
) -> Mapping[str, Any]:
    if family_template_dir is None:
        return {}
    path = family_template_dir / f"{family_template_id}.yaml"
    if not path.exists():
        return {}
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], payload).items()}


def _family_feature_catalog(family_template_dir: Path | None) -> set[str]:
    if family_template_dir is None or not family_template_dir.exists():
        return set()
    features: set[str] = set()
    for path in family_template_dir.glob("*.yaml"):
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping):
            continue
        family_payload = {
            str(key): item for key, item in cast(Mapping[Any, Any], payload).items()
        }
        features.update(_sequence_strings(family_payload.get("required_features")))
        features.update(_sequence_strings(family_payload.get("risk_controls")))
        liquidity = family_payload.get("liquidity_assumptions")
        if isinstance(liquidity, Mapping):
            features.update(str(key) for key in cast(Mapping[Any, Any], liquidity))
        else:
            features.update(_sequence_strings(liquidity))
    return features


def _seed_sweep_config_path(
    family_template_id: str,
    *,
    seed_sweep_dir: Path | None,
) -> Path | None:
    if seed_sweep_dir is None or not seed_sweep_dir.exists():
        return None
    for path in sorted(seed_sweep_dir.glob("profitability-frontier-*.yaml")):
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping):
            continue
        sweep_payload = {
            str(key): item for key, item in cast(Mapping[Any, Any], payload).items()
        }
        if (
            str(sweep_payload.get("family_template_id") or "").strip()
            == family_template_id
        ):
            return path
    return None


def _sequence_strings(value: Any) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    rows = cast(Sequence[Any], value)
    return tuple(str(item) for item in rows if str(item).strip())


def _mapping_sequence(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    resolved: list[dict[str, Any]] = []
    for item in cast(Sequence[Any], value):
        if not isinstance(item, Mapping):
            continue
        resolved.append(
            {str(key): row for key, row in cast(Mapping[Any, Any], item).items()}
        )
    return tuple(resolved)


def _blockers_for_spec(
    spec: CandidateSpec,
    *,
    family_template_dir: Path | None,
    seed_sweep_dir: Path | None,
) -> tuple[CandidateCompilationBlocker, ...]:
    blockers: list[CandidateCompilationBlocker] = []
    claim_relation_blockers = _mapping_sequence(
        spec.feature_contract.get("claim_relation_blockers")
    )
    if claim_relation_blockers:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="contradictory_claim_relation",
                detail={"claim_relation_blockers": list(claim_relation_blockers)},
            )
        )
    if spec.family_template_id not in EXECUTABLE_FAMILY_IDS:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="family_not_in_production_grammar",
                detail={"family_template_id": spec.family_template_id},
            )
        )
    if not spec.runtime_family or not spec.runtime_strategy_name:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="runtime_harness_missing",
                detail={
                    "runtime_family": spec.runtime_family,
                    "runtime_strategy_name": spec.runtime_strategy_name,
                },
            )
        )

    family_template = _load_family_template(
        spec.family_template_id, family_template_dir=family_template_dir
    )
    if family_template_dir is not None and not family_template:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="family_template_missing",
                detail={"family_template_id": spec.family_template_id},
            )
        )
    runtime_harness = family_template.get("runtime_harness")
    if family_template and not isinstance(runtime_harness, Mapping):
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="family_runtime_harness_missing",
                detail={"family_template_id": spec.family_template_id},
            )
        )
    if (
        seed_sweep_dir is not None
        and _seed_sweep_config_path(
            spec.family_template_id, seed_sweep_dir=seed_sweep_dir
        )
        is None
    ):
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="seed_sweep_missing",
                detail={
                    "family_template_id": spec.family_template_id,
                    "seed_sweep_dir": str(seed_sweep_dir),
                },
            )
        )

    required_features = {
        FEATURE_ALIASES.get(feature, feature)
        for feature in _sequence_strings(spec.feature_contract.get("required_features"))
    }
    feature_catalog = _family_feature_catalog(family_template_dir)
    missing_features = sorted(required_features - feature_catalog)
    if family_template_dir is not None and missing_features:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="required_features_missing_from_family_template",
                detail={
                    "family_template_id": spec.family_template_id,
                    "missing_features": missing_features,
                },
            )
        )
    return tuple(blockers)


def whitepaper_experiment_payload_for_candidate(spec: CandidateSpec) -> dict[str, Any]:
    vnext_payload = spec.to_vnext_experiment_payload()
    return {
        "experiment_id": vnext_payload["experiment_id"],
        "family_template_id": spec.family_template_id,
        "template_id": spec.family_template_id,
        "hypothesis": vnext_payload.get("hypothesis"),
        "paper_claim_links": vnext_payload.get("paper_claim_links", []),
        "dataset_snapshot_policy": vnext_payload["dataset_snapshot_policy"],
        "template_overrides": vnext_payload["template_overrides"],
        "feature_variants": vnext_payload["feature_variants"],
        "veto_controller_variants": vnext_payload["veto_controller_variants"],
        "selection_objectives": vnext_payload["selection_objectives"],
        "hard_vetoes": vnext_payload["hard_vetoes"],
        "expected_failure_modes": vnext_payload["expected_failure_modes"],
        "promotion_contract": vnext_payload["promotion_contract"],
        "candidate_spec": vnext_payload["candidate_spec"],
    }


def compile_whitepaper_candidate_specs(
    *,
    hypothesis_cards: Sequence[HypothesisCard],
    target_net_pnl_per_day: Decimal = Decimal("500"),
    family_template_dir: Path | None = None,
    seed_sweep_dir: Path | None = None,
) -> WhitepaperCandidateCompilation:
    candidate_specs = tuple(
        compile_candidate_specs(
            hypothesis_cards=hypothesis_cards,
            target_net_pnl_per_day=target_net_pnl_per_day,
        )
    )
    blockers: list[CandidateCompilationBlocker] = []
    executable_specs: list[CandidateSpec] = []
    blocked_specs: list[CandidateSpec] = []
    for spec in candidate_specs:
        spec_blockers = _blockers_for_spec(
            spec,
            family_template_dir=family_template_dir,
            seed_sweep_dir=seed_sweep_dir,
        )
        blockers.extend(spec_blockers)
        if spec_blockers:
            blocked_specs.append(spec)
        else:
            executable_specs.append(spec)
    return WhitepaperCandidateCompilation(
        candidate_specs=candidate_specs,
        executable_specs=tuple(executable_specs),
        blocked_specs=tuple(blocked_specs),
        blockers=tuple(blockers),
        whitepaper_experiment_payloads=tuple(
            whitepaper_experiment_payload_for_candidate(spec)
            for spec in executable_specs
        ),
        vnext_experiment_payloads=tuple(
            spec.to_vnext_experiment_payload() for spec in executable_specs
        ),
    )


def compile_claim_payloads_to_whitepaper_experiments(
    *,
    run_id: str,
    claims: Sequence[Mapping[str, Any]],
    relations: Sequence[Mapping[str, Any]] = (),
    target_net_pnl_per_day: Decimal = Decimal("500"),
    family_template_dir: Path | None = None,
    seed_sweep_dir: Path | None = None,
) -> WhitepaperCandidateCompilation:
    cards = build_hypothesis_cards(
        source_run_id=run_id,
        claims=claims,
        relations=relations,
    )
    return compile_whitepaper_candidate_specs(
        hypothesis_cards=cards,
        target_net_pnl_per_day=target_net_pnl_per_day,
        family_template_dir=family_template_dir,
        seed_sweep_dir=seed_sweep_dir,
    )
