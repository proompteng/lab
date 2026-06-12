# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false

from __future__ import annotations

import logging
import os
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, cast
from urllib.parse import urlsplit

from sqlalchemy import desc, select  # pyright: ignore[reportUnknownVariableType]
from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Execution,
    PositionSnapshot,
    Strategy,
    TradeDecision,
)
from ...models import StrategyDecision
from ...paper_route_target_plan import (
    paper_route_target_plan_from_payload,
    paper_route_target_plan_probe_symbols,
    paper_route_target_plan_targets,
)
from ...runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    source_decision_mode_is_profit_proof_eligible,
)
from ...session_context import regular_session_open_utc_for
from ..target_plan_helpers import (
    _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL,
    _BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS,
    _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS,
    _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS,
    _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS,
    _PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON,
    _PAPER_ROUTE_TARGET_PLAN_CACHE_SECONDS,
    _PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
    _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS,
    _PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK,
    _REGULAR_SESSION_MINUTES,
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_reserves_account,
    _bounded_sim_collection_target_with_runtime_account_audit,
    _lineage_text_values,
    _merge_paper_route_probe_lineage,
    _optional_decimal,
    _paper_route_probe_lineage_from_params,
    _safe_text,
    _strategy_lookup_names,
    _target_active_in_window,
    _target_bool,
    _target_bounded_collection_authorized,
    _target_has_bounded_sim_collection_source_kind,
    _target_has_bounded_source_collection_authorization,
    _target_lookup_names,
    _target_missing_explicit_probe_window,
    _target_owns_bounded_sim_collection_account,
    _target_pair_balance_state,
    _target_plan_has_active_bounded_sim_collection_owner,
    _target_plan_lineage,
    _target_probe_action,
    _target_probe_cap,
    _target_probe_exit_minute_after_open,
    _target_probe_symbol_actions,
    _target_probe_symbol_quantities,
    _target_probe_window,
    _target_requires_bounded_sim_collection_gate,
    _target_runtime_account_matches,
    _target_symbols,
    _target_truthy,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_80 import *
from .part_02_simplepipelinesourcecollectionmixinmethods import *


class _SimplePipelineSourceCollectionMixinMethodsPart3:
    def _paper_route_target_lineage_for_decision(
        self,
        decision: StrategyDecision,
        strategy: Strategy | None,
    ) -> dict[str, Any]:
        if settings.trading_mode != "paper":
            return {}
        if not settings.trading_simple_paper_route_probe_enabled:
            return {}
        symbol = decision.symbol.strip().upper()
        if not symbol:
            return {}
        target_plan_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error or symbol not in target_plan_symbols:
            return {}
        matching_targets: list[dict[str, Any]] = []
        for target in target_plan_targets:
            target_symbols = _target_symbols(target)
            if target_symbols and symbol not in target_symbols:
                continue
            if not self._target_matches_decision_strategy(target, decision, strategy):
                continue
            if _target_probe_window(target) is not None and not (
                self._decision_event_in_target_window(decision, target)
            ):
                continue
            matching_targets.append(dict(target))
        if not matching_targets:
            return {}
        lineage = _target_plan_lineage(matching_targets, symbol)
        if not any(
            lineage.get(key)
            for key in (
                "source_candidate_ids",
                "source_hypothesis_ids",
                "paper_route_probe_lineage_targets",
            )
        ):
            return {}
        return {
            "mode": "paper_route_target_lineage",
            "source": "external_target_plan_url",
            "symbol": symbol,
            "paper_route_target_plan_symbols": sorted(target_plan_symbols),
            **lineage,
        }

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
        if settings.trading_mode != "paper":
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        if self._paper_route_target_source_cap(decision.params) is not None:
            return None
        if isinstance(
            decision.params.get("paper_route_target_plan_source_decision"), Mapping
        ):
            return None
        if isinstance(decision.params.get("paper_route_probe_exit"), Mapping):
            return None
        existing_mode = (
            str(decision.params.get("source_decision_mode") or "")
            .strip()
            .lower()
            .replace("-", "_")
        )
        if existing_mode == ROUTE_ACQUISITION_SOURCE_DECISION_MODE:
            return None
        symbol = decision.symbol.strip().upper()
        if not symbol:
            return None
        target_plan_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error or symbol not in target_plan_symbols:
            return None
        for target in target_plan_targets:
            target_symbols = _target_symbols(target)
            if target_symbols and symbol not in target_symbols:
                continue
            if not self._decision_event_in_target_window(decision, target):
                continue
            if not self._target_matches_decision_strategy(target, decision, strategy):
                continue
            if _safe_text(target.get("candidate_id")) is None:
                continue
            if _safe_text(target.get("hypothesis_id")) is None:
                continue
            if str(target.get("observed_stage") or "").strip().lower() != "paper":
                continue
            if not _target_has_bounded_sim_collection_source_kind(target):
                continue
            if _target_requires_bounded_sim_collection_gate(target):
                blockers = _bounded_sim_collection_blockers(
                    target,
                    account_label=self.account_label,
                )
                if blockers:
                    logger.warning(
                        "Skipping strategy-signal paper authority because bounded SIM "
                        "collection is not authorized strategy=%s symbol=%s blockers=%s",
                        strategy.name if strategy is not None else decision.strategy_id,
                        symbol,
                        ",".join(blockers),
                    )
                    continue
            if not _target_truthy(target.get("paper_probation_authorized")):
                continue
            return target
        return None

    @staticmethod
    def _strategy_signal_paper_metadata(
        *,
        decision: StrategyDecision,
        target: Mapping[str, Any],
        strategy: Strategy | None,
    ) -> dict[str, Any]:
        lineage = _target_plan_lineage([dict(target)], decision.symbol)
        window = _target_probe_window(target)
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
        return metadata

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
    _SimplePipelineSourceCollectionMixinMethodsPart1,
    _SimplePipelineSourceCollectionMixinMethodsPart2,
    _SimplePipelineSourceCollectionMixinMethodsPart3,
    object,
):
    pass


__all__ = [name for name in globals() if not name.startswith("__")]
