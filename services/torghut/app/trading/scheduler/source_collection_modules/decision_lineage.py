from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import timedelta, timezone
from typing import TYPE_CHECKING, Any, cast

from ....config import settings
from ....models import (
    Strategy,
)
from ...models import StrategyDecision
from ...runtime_decision_authority import (
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
)
from ..target_plan_helpers_modules import (
    BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS as _BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS,
    BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS as _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS,
    BOUNDED_SIM_COLLECTION_LINEAGE_KEYS as _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS,
    BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS as _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS,
    REGULAR_SESSION_MINUTES as _REGULAR_SESSION_MINUTES,
    bounded_sim_collection_blockers as _bounded_sim_collection_blockers,
    lineage_text_values as _lineage_text_values,
    merge_paper_route_probe_lineage as _merge_paper_route_probe_lineage,
    safe_text as _safe_text,
    strategy_lookup_names as _strategy_lookup_names,
    target_bool as _target_bool,
    target_has_bounded_sim_collection_source_kind as _target_has_bounded_sim_collection_source_kind,
    target_lookup_names as _target_lookup_names,
    target_plan_lineage as _target_plan_lineage,
    target_probe_exit_minute_after_open as _target_probe_exit_minute_after_open,
    target_probe_window as _target_probe_window,
    target_requires_bounded_sim_collection_gate as _target_requires_bounded_sim_collection_gate,
    target_symbols as _target_symbols,
    target_truthy as _target_truthy,
)
from .source_decisions import SimplePipelineSourceCollectionDecisionMixin
from .target_plan_fetch import SimplePipelineSourceCollectionTargetPlanMixin


if TYPE_CHECKING:
    from .collection_types import (
        SourceCollectionRuntime as SourceCollectionRuntimeMixin,
    )
else:

    class SourceCollectionRuntimeMixin:
        pass


logger = logging.getLogger(__name__)


class SimplePipelineSourceCollectionLineageMixin(SourceCollectionRuntimeMixin):
    def _paper_route_target_lineage_for_decision(
        self,
        decision: StrategyDecision,
        strategy: Strategy | None,
    ) -> dict[str, Any]:
        symbol = self._paper_route_lineage_symbol(decision)
        if symbol is None:
            return {}
        target_plan_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error or symbol not in target_plan_symbols:
            return {}
        matching_targets = self._paper_route_lineage_targets(
            target_plan_targets,
            decision=decision,
            strategy=strategy,
            symbol=symbol,
        )
        if not matching_targets:
            return {}
        lineage = _target_plan_lineage(matching_targets, symbol)
        if not self._paper_route_lineage_has_materialized_source(lineage):
            return {}
        return {
            "mode": "paper_route_target_lineage",
            "source": "external_target_plan_url",
            "symbol": symbol,
            "paper_route_target_plan_symbols": sorted(target_plan_symbols),
            **lineage,
        }

    @staticmethod
    def _paper_route_lineage_symbol(decision: StrategyDecision) -> str | None:
        if settings.trading_mode != "paper":
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        symbol = decision.symbol.strip().upper()
        return symbol or None

    def _paper_route_lineage_targets(
        self,
        targets: list[dict[str, Any]],
        *,
        decision: StrategyDecision,
        strategy: Strategy | None,
        symbol: str,
    ) -> list[dict[str, Any]]:
        matching_targets: list[dict[str, Any]] = []
        for target in targets:
            if self._paper_route_lineage_target_matches(
                target,
                decision=decision,
                strategy=strategy,
                symbol=symbol,
            ):
                matching_targets.append(dict(target))
        return matching_targets

    def _paper_route_lineage_target_matches(
        self,
        target: Mapping[str, Any],
        *,
        decision: StrategyDecision,
        strategy: Strategy | None,
        symbol: str,
    ) -> bool:
        target_symbols = _target_symbols(target)
        if target_symbols and symbol not in target_symbols:
            return False
        if not self._target_matches_decision_strategy(target, decision, strategy):
            return False
        return _target_probe_window(
            target
        ) is None or self._decision_event_in_target_window(
            decision,
            target,
        )

    @staticmethod
    def _paper_route_lineage_has_materialized_source(
        lineage: Mapping[str, Any],
    ) -> bool:
        return any(
            lineage.get(key)
            for key in (
                "source_candidate_ids",
                "source_hypothesis_ids",
                "paper_route_probe_lineage_targets",
            )
        )

    @staticmethod
    def _target_matches_decision_strategy(
        target: Mapping[str, Any],
        decision: StrategyDecision,
        strategy: Strategy | None,
    ) -> bool:
        lookup_names = {value.lower() for value in _target_lookup_names(target)}
        if not lookup_names:
            return False
        candidate_names = {
            str(decision.strategy_id).strip(),
        }
        if strategy is not None:
            candidate_names.update(_strategy_lookup_names(strategy))
        return any(
            candidate.strip().lower() in lookup_names
            for candidate in candidate_names
            if candidate.strip()
        )

    @staticmethod
    def _decision_event_in_target_window(
        decision: StrategyDecision,
        target: Mapping[str, Any],
    ) -> bool:
        window = _target_probe_window(target)
        if window is None:
            return False
        window_start, window_end = window
        event_ts = decision.event_ts
        if event_ts.tzinfo is None:
            event_ts = event_ts.replace(tzinfo=timezone.utc)
        event_ts = event_ts.astimezone(timezone.utc)
        return window_start <= event_ts < window_end

    def _strategy_signal_paper_target_for_decision(
        self,
        decision: StrategyDecision,
        strategy: Strategy | None,
    ) -> Mapping[str, Any] | None:
        symbol = self._strategy_signal_candidate_symbol(decision)
        if symbol is None:
            return None
        target_plan_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error or symbol not in target_plan_symbols:
            return None
        for target in target_plan_targets:
            if self._strategy_signal_target_matches(
                target,
                decision=decision,
                strategy=strategy,
                symbol=symbol,
            ):
                return target
        return None

    def _strategy_signal_candidate_symbol(
        self,
        decision: StrategyDecision,
    ) -> str | None:
        if self._strategy_signal_candidate_blocked(decision):
            return None
        symbol = decision.symbol.strip().upper()
        return symbol or None

    def _strategy_signal_candidate_blocked(
        self,
        decision: StrategyDecision,
    ) -> bool:
        existing_mode = (
            str(decision.params.get("source_decision_mode") or "")
            .strip()
            .lower()
            .replace("-", "_")
        )
        return (
            settings.trading_mode != "paper"
            or not settings.trading_simple_paper_route_probe_enabled
            or self._paper_route_target_source_cap(decision.params) is not None
            or isinstance(
                decision.params.get("paper_route_target_plan_source_decision"),
                Mapping,
            )
            or isinstance(decision.params.get("paper_route_probe_exit"), Mapping)
            or existing_mode == ROUTE_ACQUISITION_SOURCE_DECISION_MODE
        )

    def _strategy_signal_target_matches(
        self,
        target: Mapping[str, Any],
        *,
        decision: StrategyDecision,
        strategy: Strategy | None,
        symbol: str,
    ) -> bool:
        target_symbols = _target_symbols(target)
        if target_symbols and symbol not in target_symbols:
            return False
        if not self._decision_event_in_target_window(decision, target):
            return False
        if not self._target_matches_decision_strategy(target, decision, strategy):
            return False
        if not self._strategy_signal_target_identity_complete(target):
            return False
        if self._strategy_signal_target_blocked(target, decision, strategy, symbol):
            return False
        return _target_truthy(target.get("paper_probation_authorized"))

    @staticmethod
    def _strategy_signal_target_identity_complete(
        target: Mapping[str, Any],
    ) -> bool:
        return (
            _safe_text(target.get("candidate_id")) is not None
            and _safe_text(target.get("hypothesis_id")) is not None
            and str(target.get("observed_stage") or "").strip().lower() == "paper"
            and _target_has_bounded_sim_collection_source_kind(target)
        )

    def _strategy_signal_target_blocked(
        self,
        target: Mapping[str, Any],
        decision: StrategyDecision,
        strategy: Strategy | None,
        symbol: str,
    ) -> bool:
        if not _target_requires_bounded_sim_collection_gate(target):
            return False
        blockers = _bounded_sim_collection_blockers(
            target,
            account_label=self.account_label,
        )
        if not blockers:
            return False
        logger.warning(
            "Skipping strategy-signal paper authority because bounded SIM "
            "collection is not authorized strategy=%s symbol=%s blockers=%s",
            strategy.name if strategy is not None else decision.strategy_id,
            symbol,
            ",".join(blockers),
        )
        return True

    @staticmethod
    def _strategy_signal_paper_metadata(
        *,
        decision: StrategyDecision,
        target: Mapping[str, Any],
        strategy: Strategy | None,
    ) -> dict[str, Any]:
        lineage = _target_plan_lineage([dict(target)], decision.symbol)
        metadata: dict[str, Any] = {
            "mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
            "source": "external_target_plan_url",
            "symbol": decision.symbol.strip().upper(),
            "source_decision_mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
            "profit_proof_eligible": True,
            "paper_route_target_plan_source": "external_target_plan_url",
            "paper_route_probe_scope_authority": "external_target_plan",
            "paper_probation_authorized": True,
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
            **lineage,
        }
        if strategy is not None:
            metadata["strategy_name"] = strategy.name
            metadata["strategy_id"] = str(strategy.id)
        SimplePipelineSourceCollectionLineageMixin._add_strategy_signal_identity_metadata(
            metadata,
            target,
        )
        SimplePipelineSourceCollectionLineageMixin._add_strategy_signal_bounded_metadata(
            metadata,
            target,
        )
        SimplePipelineSourceCollectionLineageMixin._add_strategy_signal_probe_metadata(
            metadata,
            target,
        )
        return metadata

    @staticmethod
    def _add_strategy_signal_identity_metadata(
        metadata: dict[str, Any],
        target: Mapping[str, Any],
    ) -> None:
        for key in (
            "candidate_id",
            "hypothesis_id",
            "observed_stage",
            "strategy_family",
            "runtime_strategy_name",
            "source_kind",
            "source_manifest_ref",
            "dataset_snapshot_ref",
        ):
            value = _safe_text(target.get(key))
            if value is not None:
                metadata[key] = value

    @staticmethod
    def _add_strategy_signal_bounded_metadata(
        metadata: dict[str, Any],
        target: Mapping[str, Any],
    ) -> None:
        for key in _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS:
            value = _safe_text(target.get(key))
            if value is not None:
                metadata[key] = value
        for key in _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS:
            value = _target_bool(target.get(key))
            if value is not None:
                metadata[key] = value
        for key in _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS:
            value = target.get(key)
            if isinstance(value, Mapping):
                metadata[key] = dict(cast(Mapping[str, Any], value))
        for key in _BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS:
            values = _lineage_text_values(target.get(key))
            if values:
                metadata[key] = values
        symbols = _lineage_text_values(target.get("paper_route_probe_symbols"))
        if symbols:
            metadata["paper_route_probe_symbols"] = symbols
        for key in (
            "paper_route_probe_pair_balance_required",
            "paper_route_probe_pair_balance_state",
        ):
            value = target.get(key)
            if value is not None:
                metadata[key] = value

    @staticmethod
    def _add_strategy_signal_probe_metadata(
        metadata: dict[str, Any],
        target: Mapping[str, Any],
    ) -> None:
        window = _target_probe_window(target)
        if window is not None:
            window_start, window_end = window
            metadata["paper_route_probe_window_start"] = window_start.isoformat()
            metadata["paper_route_probe_window_end"] = window_end.isoformat()
            exit_minute, exit_defaulted = _target_probe_exit_minute_after_open(target)
            if exit_minute is not None:
                effective_exit_minute = min(exit_minute, _REGULAR_SESSION_MINUTES - 1)
                metadata["exit_minute_after_open"] = exit_minute
                metadata["effective_exit_minute_after_open"] = effective_exit_minute
                metadata["exit_due_at"] = (
                    window_start + timedelta(minutes=effective_exit_minute)
                ).isoformat()
                if exit_defaulted:
                    metadata["paper_route_probe_exit_defaulted"] = True
                    metadata["paper_route_probe_exit_default_reason"] = (
                        "target_plan_evidence_collection_session_close"
                    )

    def _with_paper_route_target_lineage(
        self,
        decision: StrategyDecision,
        *,
        strategy: Strategy | None = None,
    ) -> StrategyDecision:
        lineage = self._paper_route_target_lineage_for_decision(decision, strategy)
        if not lineage:
            return decision
        params = dict(decision.params)
        existing = params.get("paper_route_target_plan")
        if isinstance(existing, Mapping):
            merged_target_plan = dict(cast(Mapping[str, Any], existing))
            _merge_paper_route_probe_lineage(merged_target_plan, lineage)
            for key, value in lineage.items():
                merged_target_plan.setdefault(key, value)
            params["paper_route_target_plan"] = merged_target_plan
        else:
            params["paper_route_target_plan"] = lineage
        _merge_paper_route_probe_lineage(params, lineage)
        strategy_signal_target = self._strategy_signal_paper_target_for_decision(
            decision, strategy
        )
        if strategy_signal_target is not None:
            metadata = self._strategy_signal_paper_metadata(
                decision=decision,
                target=strategy_signal_target,
                strategy=strategy,
            )
            params["strategy_signal_paper"] = metadata
            params["source_decision_mode"] = STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE
            params["profit_proof_eligible"] = True
            params.setdefault("promotion_allowed", False)
            params.setdefault("final_promotion_authorized", False)
            params.setdefault("final_promotion_allowed", False)
            if "exit_minute_after_open" in metadata:
                params.setdefault(
                    "exit_minute_after_open",
                    metadata["exit_minute_after_open"],
                )
            target_plan = params.get("paper_route_target_plan")
            if isinstance(target_plan, Mapping):
                merged_target_plan = dict(cast(Mapping[str, Any], target_plan))
                for key, value in metadata.items():
                    merged_target_plan.setdefault(key, value)
                params["paper_route_target_plan"] = merged_target_plan
        return decision.model_copy(update={"params": params})


class SimplePipelineSourceCollectionMixin(
    SimplePipelineSourceCollectionTargetPlanMixin,
    SimplePipelineSourceCollectionDecisionMixin,
    SimplePipelineSourceCollectionLineageMixin,
    object,
):
    pass


__all__ = [
    "SimplePipelineSourceCollectionLineageMixin",
    "SimplePipelineSourceCollectionMixin",
]
