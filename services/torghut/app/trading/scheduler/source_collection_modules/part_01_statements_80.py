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


logger = logging.getLogger(__name__)


class _SimplePipelineSourceCollectionMixinMethodsPart1:
    @staticmethod
    def _paper_route_target_plan_url_points_to_current_service(url: str) -> bool:
        parsed = urlsplit(url)
        path = (parsed.path or "").rstrip("/")
        if path not in {"/trading/paper-route-target-plan", "/trading/proofs"}:
            return False
        hostname = (parsed.hostname or "").strip().lower()
        service_name = os.getenv("K_SERVICE", "").strip().lower()
        if not hostname or not service_name:
            return False
        namespace = (
            os.getenv("POD_NAMESPACE", os.getenv("NAMESPACE", "")).strip().lower()
        )
        service_hosts = {service_name}
        if namespace:
            service_hosts.update(
                {
                    f"{service_name}.{namespace}",
                    f"{service_name}.{namespace}.svc",
                    f"{service_name}.{namespace}.svc.cluster.local",
                }
            )
        return hostname in service_hosts or hostname.startswith(f"{service_name}.")

    def _local_paper_route_target_probe_symbols(
        self,
        *,
        session: Session | None,
        strategies: Sequence[Strategy] | None = None,
    ) -> tuple[set[str], str | None, list[dict[str, Any]]]:
        try:
            gate = self._live_submission_gate(session=session)
        except Exception as exc:  # pragma: no cover - defensive runtime fallback
            logger.exception(
                "Local paper-route target plan unavailable for bounded probe"
            )
            return (
                set(),
                f"paper_route_target_plan_local_gate_failed:{type(exc).__name__}",
                [],
            )

        plan = paper_route_target_plan_from_payload(gate)
        targets = paper_route_target_plan_targets(plan)
        if not targets:
            return set(), "paper_route_target_plan_missing", []

        resolved_targets: list[dict[str, Any]] = []
        for target in targets:
            resolved_target = self._paper_route_target_with_local_probe_contract(
                {
                    **dict(target),
                    "paper_route_target_plan_source": _safe_text(
                        target.get("paper_route_target_plan_source")
                    )
                    or "local_live_submission_gate",
                },
                strategies=strategies,
            )
            resolved_targets.append(resolved_target)
        symbols = set(
            paper_route_target_plan_probe_symbols({"targets": resolved_targets})
        )
        if not symbols:
            return (
                set(),
                "paper_route_target_plan_probe_symbols_missing",
                resolved_targets,
            )
        return symbols, None, resolved_targets

    def _external_paper_route_target_probe_symbols(
        self,
        *,
        session: Session | None = None,
        strategies: Sequence[Strategy] | None = None,
    ) -> tuple[
        set[str],
        str | None,
        list[dict[str, Any]],
    ]:
        url = str(settings.trading_paper_route_target_plan_url or "").strip()
        if not url:
            return set(), None, []
        if self._paper_route_target_plan_url_points_to_current_service(url):
            return self._local_paper_route_target_probe_symbols(
                session=session,
                strategies=strategies,
            )
        plan = self._fetch_paper_route_target_plan_url(
            url,
            timeout_seconds=settings.trading_paper_route_target_plan_timeout_seconds,
            attempts=_PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
            retry_backoff_seconds=0.25,
        )
        load_error = str(plan.get("load_error") or "").strip()
        if load_error:
            logger.warning(
                "Paper-route target plan unavailable for bounded probe url=%s error=%s attempts=%s",
                url,
                load_error,
                plan.get("fetch_attempts") or 1,
            )
            return set(), load_error, []
        targets = [
            self._paper_route_target_with_local_probe_contract(
                target,
                strategies=strategies,
            )
            for target in paper_route_target_plan_targets(plan)
        ]
        symbols = set(paper_route_target_plan_probe_symbols({"targets": targets}))
        if not symbols:
            return set(), "paper_route_target_plan_probe_symbols_missing", []
        return symbols, None, targets

    def _external_paper_route_target_probe_symbols_cached(
        self,
        *,
        session: Session | None = None,
        strategies: Sequence[Strategy] | None = None,
    ) -> tuple[set[str], str | None, list[dict[str, Any]]]:
        now = self._trading_now().astimezone(timezone.utc)
        cached = cast(
            tuple[set[str], str | None, list[dict[str, Any]], datetime] | None,
            getattr(self, "_paper_route_target_plan_cache", None),
        )
        if cached is not None:
            symbols, load_error, targets, cached_at = cached
            if (
                now - cached_at.astimezone(timezone.utc)
            ).total_seconds() < _PAPER_ROUTE_TARGET_PLAN_CACHE_SECONDS:
                return set(symbols), load_error, [dict(target) for target in targets]
        symbols, load_error, targets = self._external_paper_route_target_probe_symbols(
            session=session,
            strategies=strategies,
        )
        used_stale_success = False
        if load_error:
            success_cached = cast(
                tuple[set[str], list[dict[str, Any]], datetime] | None,
                getattr(self, "_paper_route_target_plan_success_cache", None),
            )
            if success_cached is not None:
                cached_symbols, cached_targets, success_cached_at = success_cached
                success_age_seconds = max(
                    (now - success_cached_at.astimezone(timezone.utc)).total_seconds(),
                    0.0,
                )
                if success_age_seconds < _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS:
                    logger.warning(
                        "Using stale successful paper-route target plan for bounded probe error=%s age_seconds=%.1f",
                        load_error,
                        success_age_seconds,
                    )
                    targets = [
                        {
                            **dict(target),
                            "paper_route_target_plan_cache_status": "stale_success",
                            "paper_route_target_plan_last_load_error": load_error,
                            "paper_route_target_plan_stale_success_age_seconds": int(
                                max(success_age_seconds, 0.0)
                            ),
                        }
                        for target in cached_targets
                    ]
                    symbols = set(cached_symbols)
                    load_error = None
                    used_stale_success = True
        if load_error is None and symbols and targets and not used_stale_success:
            self._paper_route_target_plan_success_cache = (
                set(symbols),
                [dict(target) for target in targets],
                now,
            )
        self._paper_route_target_plan_cache = (
            set(symbols),
            load_error,
            [dict(target) for target in targets],
            now,
        )
        return symbols, load_error, targets

    def _active_bounded_paper_route_target_window(
        self,
        decision: StrategyDecision,
    ) -> dict[str, object] | None:
        if settings.trading_mode != "paper":
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        symbol = decision.symbol.strip().upper()
        if not symbol:
            return None

        target_symbols, target_plan_error, targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error or symbol not in target_symbols:
            return None

        now = self._trading_now().astimezone(timezone.utc)
        active_targets: list[dict[str, Any]] = []
        active_windows: list[dict[str, str]] = []
        window_starts: list[datetime] = []
        window_ends: list[datetime] = []
        for target in targets:
            if not _target_requires_bounded_sim_collection_gate(target):
                continue
            if symbol not in _target_symbols(target):
                continue
            window = _target_probe_window(target)
            if window is None:
                continue
            window_start, window_end = window
            if now < window_start or now >= window_end:
                continue
            active_targets.append(dict(target))
            window_starts.append(window_start)
            window_ends.append(window_end)
            active_windows.append(
                {
                    "window_start": window_start.isoformat(),
                    "window_end": window_end.isoformat(),
                }
            )
        if not active_targets:
            return None
        gate: dict[str, object] = {
            "mode": "paper_route_target_window_submission_gate",
            "symbol": symbol,
            "account_label": self.account_label,
            "target_count": len(active_targets),
            "target_symbols": sorted(target_symbols),
            "active_windows": active_windows[:5],
            "requires_scoped_source_decision": True,
        }
        if window_starts and window_ends:
            gate["window_start"] = min(window_starts).isoformat()
            gate["window_end"] = max(window_ends).isoformat()
        gate.update(_target_plan_lineage(active_targets, symbol))
        return gate

    @staticmethod
    def _paper_route_target_strategy(
        target: Mapping[str, Any],
        strategies: Sequence[Strategy],
    ) -> Strategy | None:
        lookup_names = {
            value.strip().lower()
            for value in _target_lookup_names(target)
            if value.strip()
        }
        if not lookup_names:
            return None
        for strategy in strategies:
            if any(
                candidate.strip().lower() in lookup_names
                for candidate in _strategy_lookup_names(strategy)
                if candidate.strip()
            ):
                return strategy
        return None

    @staticmethod
    def _paper_route_target_strategy_symbols(strategy: Strategy) -> set[str]:
        raw_symbols = strategy.universe_symbols
        if isinstance(raw_symbols, str):
            values: Sequence[object] = raw_symbols.split(",")
        elif isinstance(raw_symbols, Sequence) and not isinstance(
            raw_symbols, (bytes, bytearray)
        ):
            values = cast(Sequence[object], raw_symbols)
        else:
            values = ()
        return {symbol for raw in values if (symbol := str(raw).strip().upper())}

    @staticmethod
    def _paper_route_target_source_readiness_from_strategy(
        target: Mapping[str, Any],
        *,
        strategy: Strategy | None,
        raw_probe_symbols: set[str],
        scoped_probe_symbols: set[str],
    ) -> dict[str, object]:
        lookup_names = [
            name for name in _target_lookup_names(target) if str(name).strip()
        ]
        blockers: list[str] = []
        matched: dict[str, object] | None = None
        if strategy is None:
            if not lookup_names:
                blockers.append("source_strategy_lookup_missing")
            blockers.append("source_strategy_missing")
        else:
            if not lookup_names:
                lookup_names = _strategy_lookup_names(strategy)
            matched = {
                "strategy_id": str(strategy.id or ""),
                "strategy_name": str(strategy.name or ""),
                "enabled": bool(strategy.enabled),
                "base_timeframe": str(strategy.base_timeframe or ""),
                "universe_symbols": sorted(
                    SimplePipelineSourceCollectionMixin._paper_route_target_strategy_symbols(
                        strategy
                    )
                ),
                "max_notional_per_trade": str(strategy.max_notional_per_trade or ""),
            }
            if not bool(strategy.enabled):
                blockers.append("source_strategy_disabled")
        if not raw_probe_symbols:
            blockers.append("paper_route_probe_symbol_missing")
        elif not scoped_probe_symbols:
            blockers.append("source_strategy_universe_excludes_probe_symbols")
        source = "local_target_plan_probe_symbols"
        if _target_truthy(target.get("paper_route_probe_strategy_universe_fallback")):
            source = "local_strategy_universe_target_plan_fallback"
        elif strategy is None:
            source = "local_target_plan_strategy_unresolved"
        return {
            "schema_version": "torghut.paper-route-source-decision-readiness.v1",
            "ready": not blockers,
            "source": source,
            "blockers": blockers,
            "strategy_lookup_names": lookup_names,
            "matched_strategy": matched,
            "raw_probe_symbols": sorted(raw_probe_symbols),
            "scoped_probe_symbols": sorted(scoped_probe_symbols),
        }

    def _paper_route_target_with_local_probe_contract(
        self,
        target: Mapping[str, Any],
        *,
        strategies: Sequence[Strategy] | None,
    ) -> dict[str, Any]:
        normalized = dict(target)
        strategy = (
            self._paper_route_target_strategy(normalized, strategies)
            if strategies is not None
            else None
        )
        raw_symbols = _target_symbols(normalized)
        scoped_symbols = set(raw_symbols)
        strategy_symbols: set[str] = set()
        if strategy is not None:
            strategy_symbols = self._paper_route_target_strategy_symbols(strategy)
            if not raw_symbols and strategy_symbols:
                raw_symbols = set(strategy_symbols)
                scoped_symbols = set(strategy_symbols)
                normalized.setdefault("paper_route_probe_raw_target_symbols", [])
                normalized.setdefault("paper_route_probe_strategy_scope_applied", True)
                normalized.setdefault(
                    "paper_route_probe_strategy_universe_fallback",
                    True,
                )
                normalized.setdefault(
                    "paper_route_probe_strategy_universe_symbols",
                    sorted(strategy_symbols),
                )
                normalized.setdefault(
                    "paper_route_probe_scope_authority",
                    "strategy_universe",
                )
            elif strategy_symbols:
                scoped_symbols = raw_symbols & strategy_symbols

        if raw_symbols and not _target_symbols(normalized):
            normalized["paper_route_probe_symbols"] = sorted(raw_symbols)
        elif raw_symbols and "paper_route_probe_symbols" not in normalized:
            normalized["paper_route_probe_symbols"] = sorted(raw_symbols)

        if (
            _target_has_bounded_source_collection_authorization(normalized)
            and _target_probe_window(normalized) is None
            and _target_missing_explicit_probe_window(normalized)
        ):
            now = self._trading_now().astimezone(timezone.utc)
            window_start = regular_session_open_utc_for(now)
            window_end = window_start + timedelta(minutes=_REGULAR_SESSION_MINUTES)
            normalized["paper_route_probe_window_start"] = window_start.isoformat()
            normalized["paper_route_probe_window_end"] = window_end.isoformat()
            normalized.setdefault("paper_route_probe_window_defaulted", True)
            normalized.setdefault(
                "paper_route_probe_window_source",
                "current_regular_session_source_collection_default",
            )

        if not isinstance(normalized.get("source_decision_readiness"), Mapping):
            normalized["source_decision_readiness"] = (
                self._paper_route_target_source_readiness_from_strategy(
                    normalized,
                    strategy=strategy,
                    raw_probe_symbols=raw_symbols,
                    scoped_probe_symbols=scoped_symbols,
                )
            )
        return normalized

    @staticmethod
    def _paper_route_target_source_decision_metadata(
        *,
        target: Mapping[str, Any],
        strategy: Strategy,
        symbol: str,
        window_start: datetime,
        window_end: datetime,
        max_notional: Decimal,
    ) -> dict[str, Any]:
        lineage = _target_plan_lineage([dict(target)], symbol)
        bounded_collection_authorized = _target_bounded_collection_authorized(target)
        target_runtime_strategy_name = (
            _safe_text(target.get("runtime_strategy_name")) or strategy.name
        )
        metadata: dict[str, Any] = {
            "mode": "paper_route_target_plan_source_decision",
            "source": "external_target_plan_url",
            "symbol": symbol,
            "strategy_name": strategy.name,
            "runtime_strategy_name": target_runtime_strategy_name,
            "strategy_lookup_names": _target_lookup_names(target),
            "paper_route_probe_symbols": sorted(_target_symbols(target)),
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_route_probe_next_session_max_notional": str(max_notional),
            "paper_route_probe_effective_max_notional": str(max_notional),
            "paper_route_probe_symbol_quantities": {
                item_symbol: str(quantity)
                for item_symbol, quantity in _target_probe_symbol_quantities(
                    target,
                    sorted(_target_symbols(target)),
                ).items()
            },
            "paper_route_target_plan_source": "external_target_plan_url",
            "paper_route_probe_scope_authority": "external_target_plan",
            "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            "profit_proof_eligible": False,
            "source_kind": _safe_text(target.get("source_kind")),
            "account_label": _safe_text(target.get("account_label")),
            "source_account_label": _safe_text(target.get("source_account_label")),
            "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
            "bounded_collection_stage": "bounded_paper_collection",
            "account_stage_runtime_identity": {
                "account_label": _safe_text(target.get("account_label")),
                "source_account_label": _safe_text(target.get("source_account_label")),
                "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
                "runtime_strategy_name": target_runtime_strategy_name,
                "source_kind": _safe_text(target.get("source_kind")),
            },
            "source_manifest_ref": _safe_text(target.get("source_manifest_ref")),
            "paper_probation_authorized": bool(
                target.get("paper_probation_authorized")
            ),
            "source_collection_authorized": bool(
                target.get("source_collection_authorized")
            ),
            "source_collection_authorization_scope": _safe_text(
                target.get("source_collection_authorization_scope")
            ),
            "source_collection_reason_codes": [
                str(item).strip()
                for item in _lineage_text_values(
                    target.get("source_collection_reason_codes")
                )
                if str(item).strip()
            ],
            "bounded_evidence_collection_authorized": bounded_collection_authorized,
            "bounded_live_paper_collection_authorized": (bounded_collection_authorized),
            "canary_collection_authorized": bounded_collection_authorized,
            "evidence_collection_ok": _target_truthy(
                target.get("evidence_collection_ok")
            ),
            "bounded_evidence_collection_scope": (
                _safe_text(target.get("bounded_evidence_collection_scope"))
                or "paper_route_probe_next_session_only"
            ),
            "bounded_evidence_collection_max_notional": str(max_notional),
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
            **lineage,
        }
        for key in (
            "source_decision_readiness",
            "paper_route_target_account_audit_state",
            "paper_route_target_account_audit_blockers",
            "bounded_evidence_collection_blockers",
            "runtime_window_import_health_gate_blockers",
            "paper_route_account_pre_session_blockers",
            "paper_route_account_contamination_blockers",
            "paper_route_hpairs_symbol_blockers",
            "paper_route_probe_pair_balance_state",
        ):
            if key in target:
                metadata[key] = target[key]
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
        for key in (
            "candidate_id",
            "hypothesis_id",
            "observed_stage",
            "strategy_family",
        ):
            value = _safe_text(target.get(key))
            if value is not None:
                metadata[key] = value
        return metadata

    @staticmethod
    def _bounded_paper_route_execution_metadata(
        *,
        target: Mapping[str, Any],
        strategy: Strategy,
        symbol: str,
        action: str,
        account_label: str | None,
        max_notional: Decimal,
    ) -> dict[str, Any]:
        target_account_label = (
            _safe_text(target.get("account_label"))
            or _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL
        )
        runtime_account_label = (
            _safe_text(account_label)
            or _safe_text(target.get("execution_account_label"))
            or target_account_label
        )
        source_account_label = _safe_text(target.get("source_account_label"))
        execution_policy = {
            "schema_version": "torghut.bounded-paper-route-execution-policy.v1",
            "authority": "bounded_paper_route_collection_only",
            "live_capital_routing_enabled": False,
            "capital_promotion_allowed": False,
            "target_account_label": target_account_label,
            "runtime_account_label": runtime_account_label,
            "source_account_label": source_account_label,
            "strategy_id": str(strategy.id),
            "strategy_name": strategy.name,
            "symbol": symbol,
            "side": action,
            "max_notional": str(max_notional),
            "idempotency_key_basis": "trade_decision_hash_client_order_id",
            "order_feed_linkage_keys": [
                "alpaca_account_label",
                "client_order_id",
            ],
        }
        return {
            "execution_lane": "simple",
            "submit_path": "bounded_paper_route_collection",
            "execution_account_label": runtime_account_label,
            "execution_policy": execution_policy,
            "lineage": {
                "schema_version": "torghut.bounded-paper-route-lineage.v1",
                "hypothesis_id": _safe_text(target.get("hypothesis_id")),
                "candidate_id": _safe_text(target.get("candidate_id")),
                "source_manifest_ref": _safe_text(target.get("source_manifest_ref")),
                "target_account_label": target_account_label,
                "runtime_account_label": runtime_account_label,
                "source_account_label": source_account_label,
                "source_kind": _safe_text(target.get("source_kind")),
                "bounded_evidence_collection_scope": _safe_text(
                    target.get("bounded_evidence_collection_scope")
                ),
            },
        }

    @staticmethod
    def _paper_route_target_source_cap(
        params: Mapping[str, Any],
    ) -> Decimal | None:
        metadata = params.get("paper_route_target_plan_source_decision")
        if not isinstance(metadata, Mapping):
            metadata = params.get("paper_route_target_plan")
        if not isinstance(metadata, Mapping):
            return None
        mode = str(cast(Mapping[str, Any], metadata).get("mode") or "").strip()
        if mode != "paper_route_target_plan_source_decision":
            return None
        cap = _optional_decimal(
            cast(Mapping[str, Any], metadata).get(
                "paper_route_probe_next_session_max_notional"
            )
        )
        return cap if cap is not None and cap > 0 else None


__all__ = [name for name in globals() if not name.startswith("__")]
