# pyright: reportUnusedImport=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false

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

from ...config import settings
from ...models import (
    Execution,
    PositionSnapshot,
    Strategy,
    TradeDecision,
)
from ..models import StrategyDecision
from ..paper_route_target_plan import (
    paper_route_target_plan_from_payload,
    paper_route_target_plan_probe_symbols,
    paper_route_target_plan_targets,
)
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    source_decision_mode_is_profit_proof_eligible,
)
from ..session_context import regular_session_open_utc_for
from .target_plan_helpers import (
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

logger = logging.getLogger(__name__)


class SimplePipelineSourceCollectionMixin:
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

    def _paper_route_target_source_decisions(
        self,
        *,
        strategies: Sequence[Strategy],
        allowed_symbols: set[str],
        positions: Sequence[Mapping[str, Any]] | None = None,
        session: Session | None = None,
    ) -> list[StrategyDecision]:
        if settings.trading_mode != "paper":
            return []
        if not settings.trading_simple_paper_route_probe_enabled:
            return []
        now = self._trading_now().astimezone(timezone.utc)
        if not self._is_market_session_open(now):
            self._record_bounded_target_plan_blocker(
                reason="paper_route_session_window_not_open"
            )
            return []
        target_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached(
                session=session,
                strategies=strategies,
            )
        )
        if target_plan_error:
            self._record_bounded_target_plan_blocker(
                reason=target_plan_error,
                symbols=target_symbols,
                targets=target_plan_targets,
            )
            return []
        if not target_symbols:
            if str(settings.trading_paper_route_target_plan_url or "").strip():
                self._record_bounded_target_plan_blocker(
                    reason="paper_route_target_plan_probe_symbols_missing",
                    symbols=target_symbols,
                    targets=target_plan_targets,
                )
            return []

        normalized_allowed = {
            symbol.strip().upper() for symbol in allowed_symbols if symbol.strip()
        }
        bounded_sim_owner_active = _target_plan_has_active_bounded_sim_collection_owner(
            target_plan_targets,
            account_label=self.account_label,
            now=now,
        )
        decisions: list[StrategyDecision] = []
        seen: set[tuple[str, str, str, str]] = set()
        for raw_target in target_plan_targets:
            target = _bounded_sim_collection_target_with_runtime_account_audit(
                raw_target,
                positions=(
                    positions
                    if _target_requires_bounded_sim_collection_gate(raw_target)
                    else None
                ),
                account_label=self.account_label,
            )
            if (
                bounded_sim_owner_active
                and _target_runtime_account_matches(
                    target,
                    account_label=self.account_label,
                )
                and not _target_owns_bounded_sim_collection_account(target)
            ):
                logger.warning(
                    "Skipping paper-route target source collection because bounded "
                    "H-PAIRS evidence collection owns account=%s hypothesis_id=%s "
                    "candidate_id=%s runtime_strategy_name=%s",
                    self.account_label,
                    _safe_text(target.get("hypothesis_id")),
                    _safe_text(target.get("candidate_id")),
                    _safe_text(target.get("runtime_strategy_name")),
                )
                continue
            if _target_requires_bounded_sim_collection_gate(target):
                collection_blockers = _bounded_sim_collection_blockers(
                    target,
                    account_label=self.account_label,
                )
                if collection_blockers:
                    logger.warning(
                        "Skipping paper-route target source collection because bounded SIM collection is not authorized blockers=%s",
                        ",".join(collection_blockers),
                    )
                    continue
            window = _target_probe_window(target)
            if window is None:
                continue
            window_start, window_end = window
            if now < window_start or now >= window_end:
                continue
            target_cap = _target_probe_cap(target)
            if target_cap is None or target_cap <= 0:
                continue
            strategy = self._paper_route_target_strategy(target, strategies)
            if strategy is None:
                continue
            strategy_symbols = self._paper_route_target_strategy_symbols(strategy)
            symbols = sorted(_target_symbols(target) & target_symbols)
            if normalized_allowed:
                symbols = [symbol for symbol in symbols if symbol in normalized_allowed]
            if strategy_symbols:
                symbols = [symbol for symbol in symbols if symbol in strategy_symbols]
            symbol_actions = _target_probe_symbol_actions(target, symbols)
            symbol_quantities = _target_probe_symbol_quantities(target, symbols)
            pair_balance_state = _target_pair_balance_state(target, symbol_actions)
            if _target_requires_bounded_sim_collection_gate(
                target
            ) and self._paper_route_target_account_has_open_exposure(positions):
                logger.warning(
                    "Skipping paper-route target source collection because account "
                    "is not flat for bounded SIM evidence strategy=%s symbols=%s",
                    strategy.name,
                    symbols,
                )
                continue
            if pair_balance_state == "imbalanced":
                logger.warning(
                    "Skipping imbalanced paper-route pair target strategy=%s symbols=%s actions=%s",
                    strategy.name,
                    symbols,
                    symbol_actions,
                )
                continue
            if (
                pair_balance_state == "balanced"
                and any(action == "sell" for action in symbol_actions.values())
                and not settings.trading_allow_shorts
            ):
                logger.warning(
                    "Skipping balanced paper-route pair target because shorts are disabled strategy=%s symbols=%s",
                    strategy.name,
                    symbols,
                )
                continue
            blocked_open_exposure_symbols: list[str] = []
            for symbol in symbols:
                if self._paper_route_target_symbol_has_open_position(
                    positions,
                    symbol,
                ):
                    blocked_open_exposure_symbols.append(symbol)
                    continue
                if (
                    session is not None
                    and self._paper_route_target_symbol_has_open_strategy_exposure(
                        session=session,
                        strategy=strategy,
                        symbol=symbol,
                        account_label=self.account_label,
                        window_start=window_start,
                    )
                ):
                    blocked_open_exposure_symbols.append(symbol)
            if blocked_open_exposure_symbols and pair_balance_state == "balanced":
                logger.warning(
                    "Skipping balanced paper-route pair target because existing "
                    "strategy exposure is still open strategy=%s symbols=%s "
                    "blocked_symbols=%s",
                    strategy.name,
                    symbols,
                    blocked_open_exposure_symbols,
                )
                continue
            for symbol in symbols:
                action = symbol_actions.get(symbol, _target_probe_action(target))
                if action == "sell" and not settings.trading_allow_shorts:
                    continue
                if symbol in blocked_open_exposure_symbols:
                    continue
                if (
                    session is not None
                    and self._paper_route_target_symbol_has_open_profit_proof_exposure(
                        session=session,
                        strategy=strategy,
                        symbol=symbol,
                        account_label=self.account_label,
                        window_start=window_start,
                    )
                ):
                    continue
                key = (str(strategy.id), symbol, window_start.isoformat(), action)
                if key in seen:
                    continue
                seen.add(key)
                metadata = self._paper_route_target_source_decision_metadata(
                    target=target,
                    strategy=strategy,
                    symbol=symbol,
                    window_start=window_start,
                    window_end=window_end,
                    max_notional=target_cap,
                )
                metadata["paper_route_probe_symbol_actions"] = dict(symbol_actions)
                if symbol_quantities:
                    metadata["paper_route_probe_symbol_quantities"] = {
                        item_symbol: str(quantity)
                        for item_symbol, quantity in symbol_quantities.items()
                    }
                metadata["paper_route_probe_pair_balance_required"] = (
                    pair_balance_state != "not_required"
                )
                metadata["paper_route_probe_pair_balance_state"] = pair_balance_state
                metadata["paper_route_probe_leg_action"] = action
                execution_metadata = (
                    self._bounded_paper_route_execution_metadata(
                        target=target,
                        strategy=strategy,
                        symbol=symbol,
                        action=action,
                        account_label=self.account_label,
                        max_notional=target_cap,
                    )
                    if _target_requires_bounded_sim_collection_gate(target)
                    else {}
                )
                source_decision_mode = ROUTE_ACQUISITION_SOURCE_DECISION_MODE
                profit_proof_eligible = False
                if (
                    _safe_text(execution_metadata.get("submit_path"))
                    == "bounded_paper_route_collection"
                ):
                    source_decision_mode = (
                        BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                    )
                    profit_proof_eligible = True
                    metadata["source_decision_mode"] = source_decision_mode
                    metadata["profit_proof_eligible"] = profit_proof_eligible
                    metadata["bounded_paper_route_submit_path"] = execution_metadata[
                        "submit_path"
                    ]
                    metadata["bounded_paper_route_execution_policy"] = (
                        execution_metadata["execution_policy"]
                    )
                simple_lane = {
                    "source": "external_target_plan_url",
                    "target_plan_source_decision": True,
                    "paper_route_probe_max_notional": str(target_cap),
                    "paper_route_probe_window_start": window_start.isoformat(),
                    "paper_route_probe_window_end": window_end.isoformat(),
                    "paper_route_probe_symbol_actions": dict(symbol_actions),
                    **(
                        {
                            "paper_route_probe_symbol_quantities": {
                                item_symbol: str(quantity)
                                for item_symbol, quantity in symbol_quantities.items()
                            }
                        }
                        if symbol_quantities
                        else {}
                    ),
                    "paper_route_probe_pair_balance_state": pair_balance_state,
                    "paper_route_probe_leg_action": action,
                    "live_capital_routing_enabled": False,
                    "client_order_id_basis": "trade_decision_hash",
                    **(
                        {
                            "execution_account_label": execution_metadata[
                                "execution_account_label"
                            ],
                            "submit_path": execution_metadata["submit_path"],
                        }
                        if execution_metadata
                        else {}
                    ),
                }
                params: dict[str, Any] = {
                    "paper_route_target_plan": metadata,
                    "paper_route_target_plan_source_decision": metadata,
                    "simple_lane": simple_lane,
                    "source_decision_mode": source_decision_mode,
                    "profit_proof_eligible": profit_proof_eligible,
                    "hypothesis_id": metadata.get("hypothesis_id"),
                    "candidate_id": metadata.get("candidate_id"),
                    "strategy_name": metadata.get("strategy_name"),
                    "runtime_strategy_name": metadata.get("runtime_strategy_name"),
                    "account_label": metadata.get("account_label"),
                    "source_account_label": metadata.get("source_account_label"),
                    "source_kind": metadata.get("source_kind"),
                    "source_manifest_ref": metadata.get("source_manifest_ref"),
                    "paper_route_target_plan_source": metadata.get(
                        "paper_route_target_plan_source"
                    ),
                    "paper_route_probe_scope_authority": metadata.get(
                        "paper_route_probe_scope_authority"
                    ),
                    "paper_route_probe_symbols": metadata.get(
                        "paper_route_probe_symbols"
                    ),
                    "observed_stage": _safe_text(target.get("observed_stage"))
                    or "paper",
                    "bounded_collection_stage": "bounded_paper_collection",
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_authority_ok": False,
                    "final_promotion_allowed": False,
                    "live_capital_routing_enabled": False,
                    **execution_metadata,
                    **(
                        {
                            "bounded_paper_route_submit_path": execution_metadata[
                                "submit_path"
                            ],
                            "bounded_paper_route_execution_policy": (
                                execution_metadata["execution_policy"]
                            ),
                        }
                        if execution_metadata
                        else {}
                    ),
                    **_target_plan_lineage([dict(target)], symbol),
                }
                if "exit_minute_after_open" in metadata:
                    params["exit_minute_after_open"] = metadata[
                        "exit_minute_after_open"
                    ]
                _merge_paper_route_probe_lineage(
                    params,
                    _paper_route_probe_lineage_from_params(params),
                )
                timeframe = (
                    _safe_text(target.get("timeframe"))
                    or _safe_text(target.get("base_timeframe"))
                    or _safe_text(strategy.base_timeframe)
                    or "1Min"
                )
                requested_qty = symbol_quantities.get(symbol, Decimal("1"))
                quantity_resolution = self._paper_route_target_quantity_resolution(
                    target=target,
                    symbol=symbol,
                    symbols=symbols,
                    action=action,
                    requested_qty=requested_qty,
                    symbol_quantities=symbol_quantities,
                    max_notional=target_cap,
                    event_ts=now,
                    timeframe=timeframe,
                )
                if quantity_resolution is None:
                    continue
                if quantity_resolution.audit.get("sizing_source") != "target_notional":
                    blockers = quantity_resolution.audit.get("blockers")
                    blocker_items = (
                        cast(list[object], blockers)
                        if isinstance(blockers, list)
                        else []
                    )
                    blocker_text = ",".join(str(item) for item in blocker_items)
                    logger.warning(
                        "Skipping paper-route target source decision because "
                        "target-notional sizing is not authoritative strategy=%s "
                        "symbol=%s blockers=%s",
                        strategy.name,
                        symbol,
                        blocker_text,
                    )
                    continue
                qty = quantity_resolution.qty
                metadata["paper_route_target_notional_sizing"] = (
                    quantity_resolution.audit
                )
                simple_lane["paper_route_target_notional_sizing"] = (
                    quantity_resolution.audit
                )
                simple_lane["target_source_notional_sized"] = (
                    quantity_resolution.audit.get("sizing_source") == "target_notional"
                )
                params["paper_route_target_notional_sizing"] = quantity_resolution.audit
                params.update(quantity_resolution.price_params)
                decisions.append(
                    StrategyDecision(
                        strategy_id=str(strategy.id),
                        symbol=symbol,
                        event_ts=now,
                        timeframe=timeframe,
                        action=action,
                        qty=qty,
                        order_type="market",
                        time_in_force="day",
                        rationale="external paper-route target plan source decision",
                        params=params,
                    )
                )
        return decisions

    def _paper_route_target_plan_reserves_account(
        self,
        *,
        allowed_symbols: set[str],
    ) -> bool:
        if settings.trading_mode != "paper":
            return False
        if not settings.trading_simple_paper_route_probe_enabled:
            return False
        now = self._trading_now().astimezone(timezone.utc)
        if not self._is_market_session_open(now):
            return False
        target_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error:
            if str(settings.trading_paper_route_target_plan_url or "").strip():
                self._record_bounded_target_plan_blocker(
                    reason=target_plan_error,
                    symbols=target_symbols,
                    targets=target_plan_targets,
                )
                return True
            return False
        if not target_symbols:
            return False
        for target in target_plan_targets:
            if not _target_requires_bounded_sim_collection_gate(target):
                continue
            if not _bounded_sim_collection_reserves_account(
                target,
                account_label=self.account_label,
            ):
                continue
            if _target_owns_bounded_sim_collection_account(
                target
            ) and _target_active_in_window(target, now):
                return True
        return False

    @staticmethod
    def _paper_route_target_symbol_has_open_strategy_exposure(
        *,
        session: Session,
        strategy: Strategy,
        symbol: str,
        account_label: str,
        window_start: datetime,
    ) -> bool:
        strategy_id = getattr(strategy, "id", None)
        normalized_symbol = symbol.strip().upper()
        if strategy_id is None or not normalized_symbol:
            return False

        guard_start = window_start - _PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK
        try:
            rows = session.execute(
                select(Execution.side, Execution.filled_qty, Execution.created_at)
                .join(TradeDecision, Execution.trade_decision_id == TradeDecision.id)
                .where(
                    Execution.alpaca_account_label == account_label,
                    TradeDecision.alpaca_account_label == account_label,
                    TradeDecision.strategy_id == strategy_id,
                    Execution.symbol == normalized_symbol,
                    TradeDecision.symbol == normalized_symbol,
                    Execution.filled_qty > 0,
                    Execution.status.in_(("filled", "partially_filled")),
                    Execution.created_at >= guard_start,
                )
            ).all()
        except Exception:
            logger.exception(
                "Failed to inspect paper-route target strategy exposure "
                "strategy_id=%s symbol=%s account_label=%s",
                strategy_id,
                normalized_symbol,
                account_label,
            )
            return True

        signed_qty = Decimal("0")
        latest_fill_at: datetime | None = None
        for row in rows:
            side = row[0]
            filled_qty = row[1]
            created_at = row[2] if len(row) > 2 else None
            qty = _optional_decimal(filled_qty)
            if qty is None or qty <= 0:
                continue
            if str(side or "").strip().lower() == "sell":
                signed_qty -= qty
            else:
                signed_qty += qty
            if isinstance(created_at, datetime):
                latest_fill_at = (
                    created_at
                    if latest_fill_at is None or created_at > latest_fill_at
                    else latest_fill_at
                )
        if abs(signed_qty) <= _PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON:
            return False
        if SimplePipelineSourceCollectionMixin._paper_route_target_symbol_has_flat_repair_snapshot(
            session=session,
            account_label=account_label,
            symbol=normalized_symbol,
            after=latest_fill_at,
        ):
            return False
        return True

    @staticmethod
    def _paper_route_target_symbol_has_flat_repair_snapshot(
        *,
        session: Session,
        account_label: str,
        symbol: str,
        after: datetime | None,
    ) -> bool:
        if after is None:
            return False
        try:
            row = session.execute(
                select(PositionSnapshot.positions, PositionSnapshot.as_of)
                .where(
                    PositionSnapshot.alpaca_account_label == account_label,
                    PositionSnapshot.as_of >= after,
                )
                .order_by(desc(PositionSnapshot.as_of))
                .limit(1)
            ).first()
        except Exception:
            logger.exception(
                "Failed to inspect paper-route flat repair snapshot symbol=%s account_label=%s",
                symbol,
                account_label,
            )
            return False
        if row is None:
            return False
        positions = row[0]
        if not isinstance(positions, Sequence) or isinstance(
            positions, (bytes, bytearray, str)
        ):
            return False
        return not SimplePipelineSourceCollectionMixin._paper_route_target_symbol_has_open_position(
            cast(Sequence[Mapping[str, Any]], positions),
            symbol,
        )

    @staticmethod
    def _paper_route_target_symbol_has_open_profit_proof_exposure(
        *,
        session: Session,
        strategy: Strategy,
        symbol: str,
        account_label: str,
        window_start: datetime,
    ) -> bool:
        strategy_id = getattr(strategy, "id", None)
        normalized_symbol = symbol.strip().upper()
        if strategy_id is None or not normalized_symbol:
            return False

        guard_start = window_start - _PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK
        try:
            rows = session.execute(
                select(
                    Execution.side,
                    Execution.filled_qty,
                    TradeDecision.decision_json,
                    Execution.created_at,
                )
                .join(TradeDecision, Execution.trade_decision_id == TradeDecision.id)
                .where(
                    Execution.alpaca_account_label == account_label,
                    TradeDecision.alpaca_account_label == account_label,
                    TradeDecision.strategy_id == strategy_id,
                    Execution.symbol == normalized_symbol,
                    TradeDecision.symbol == normalized_symbol,
                    Execution.filled_qty > 0,
                    Execution.status.in_(("filled", "partially_filled")),
                    Execution.created_at >= guard_start,
                )
            ).all()
        except Exception:
            logger.exception(
                "Failed to inspect paper-route target source proof exposure "
                "strategy_id=%s symbol=%s account_label=%s",
                strategy_id,
                normalized_symbol,
                account_label,
            )
            return True

        signed_qty = Decimal("0")
        latest_fill_at: datetime | None = None
        for row in rows:
            side = row[0]
            filled_qty = row[1]
            raw_decision_json = row[2]
            created_at = row[3] if len(row) > 3 else None
            if not isinstance(raw_decision_json, Mapping):
                continue
            decision_json = cast(Mapping[str, Any], raw_decision_json)
            raw_params = decision_json.get("params")
            if not isinstance(raw_params, Mapping):
                continue
            params = cast(Mapping[str, Any], raw_params)
            lineage = _paper_route_probe_lineage_from_params(params)
            profit_proof_eligible = _target_bool(lineage.get("profit_proof_eligible"))
            if profit_proof_eligible is False:
                continue
            if (
                profit_proof_eligible is not True
                and not source_decision_mode_is_profit_proof_eligible(
                    lineage.get("source_decision_mode")
                )
            ):
                continue
            qty = _optional_decimal(filled_qty)
            if qty is None or qty <= 0:
                continue
            if str(side or "").strip().lower() == "sell":
                signed_qty -= qty
            else:
                signed_qty += qty
            if isinstance(created_at, datetime):
                latest_fill_at = (
                    created_at
                    if latest_fill_at is None or created_at > latest_fill_at
                    else latest_fill_at
                )
        if abs(signed_qty) <= _PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON:
            return False
        if SimplePipelineSourceCollectionMixin._paper_route_target_symbol_has_flat_repair_snapshot(
            session=session,
            account_label=account_label,
            symbol=normalized_symbol,
            after=latest_fill_at,
        ):
            return False
        return True

    @staticmethod
    def _paper_route_target_symbol_has_open_position(
        positions: Sequence[Mapping[str, Any]] | None,
        symbol: str,
    ) -> bool:
        if not positions:
            return False
        normalized_symbol = symbol.strip().upper()
        if not normalized_symbol:
            return False
        for position in positions:
            if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
                continue
            for qty_key in ("qty", "quantity", "qty_available"):
                qty = _optional_decimal(position.get(qty_key))
                if qty is not None and qty != 0:
                    return True
            market_value = _optional_decimal(position.get("market_value"))
            if market_value is not None and market_value != 0:
                return True
        return False

    @staticmethod
    def _paper_route_positions_without_materialized_open_order_projections(
        positions: Sequence[Mapping[str, Any]] | None,
        materialized_client_order_ids: set[str],
    ) -> list[Mapping[str, Any]]:
        if not positions:
            return []
        if not materialized_client_order_ids:
            return [position for position in positions]

        filtered_positions: list[Mapping[str, Any]] = []
        for position in positions:
            if SimplePipelineSourceCollectionMixin._paper_route_position_is_materialized_projection(
                position,
                materialized_client_order_ids,
            ):
                continue
            filtered_positions.append(position)
        return filtered_positions

    @staticmethod
    def _paper_route_position_is_materialized_projection(
        position: Mapping[str, Any],
        materialized_client_order_ids: set[str],
    ) -> bool:
        if not bool(position.get("open_order_projection")):
            return False
        if not bool(position.get("open_order_projection_only")):
            return False
        raw_ids = position.get("open_order_client_order_ids")
        client_order_ids: set[str] = set()
        if isinstance(raw_ids, list):
            client_order_ids.update(
                str(item).strip()
                for item in cast(list[Any], raw_ids)
                if str(item).strip()
            )
        raw_id = str(position.get("open_order_client_order_id") or "").strip()
        if raw_id:
            client_order_ids.add(raw_id)
        if not client_order_ids:
            return False
        return client_order_ids.issubset(materialized_client_order_ids)

    @staticmethod
    def _paper_route_target_account_has_open_exposure(
        positions: Sequence[Mapping[str, Any]] | None,
    ) -> bool:
        if not positions:
            return False
        for position in positions:
            for qty_key in ("qty", "quantity", "qty_available"):
                qty = _optional_decimal(position.get(qty_key))
                if qty is not None and qty != 0:
                    return True
            market_value = _optional_decimal(position.get("market_value"))
            if market_value is not None and market_value != 0:
                return True
        return False

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
