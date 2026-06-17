from __future__ import annotations

import logging
import os
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Any, cast
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Strategy,
)
from ...models import StrategyDecision
from ...paper_route_target_plan import (
    paper_route_target_plan_from_payload,
    paper_route_target_plan_probe_symbols,
    paper_route_target_plan_targets,
)
from ...promotion_authority import (
    capital_blocked_authority,
    source_collection_authority,
    target_capital_promotion_allowed,
)
from ...runtime_decision_authority import (
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
)
from ...session_context import regular_session_open_utc_for
from ..target_plan_helpers_modules import (
    BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL as _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL,
    PAPER_ROUTE_TARGET_PLAN_CACHE_SECONDS as _PAPER_ROUTE_TARGET_PLAN_CACHE_SECONDS,
    PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS as _PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
    PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS as _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS,
    REGULAR_SESSION_MINUTES as _REGULAR_SESSION_MINUTES,
    lineage_text_values as _lineage_text_values,
    optional_decimal as _optional_decimal,
    safe_text as _safe_text,
    strategy_lookup_names as _strategy_lookup_names,
    target_bounded_collection_authorized as _target_bounded_collection_authorized,
    target_has_bounded_source_collection_authorization as _target_has_bounded_source_collection_authorization,
    target_lookup_names as _target_lookup_names,
    target_missing_explicit_probe_window as _target_missing_explicit_probe_window,
    target_plan_lineage as _target_plan_lineage,
    target_probe_exit_minute_after_open as _target_probe_exit_minute_after_open,
    target_probe_symbol_actions as _target_probe_symbol_actions,
    target_probe_symbol_quantities as _target_probe_symbol_quantities,
    target_probe_window as _target_probe_window,
    target_requires_bounded_sim_collection_gate as _target_requires_bounded_sim_collection_gate,
    target_symbols as _target_symbols,
    target_truthy as _target_truthy,
)
from .collection_types import (
    SourceCollectionActiveWindowSummary,
    SourceCollectionAction,
    SourceCollectionTargetContext,
)


if TYPE_CHECKING:
    from .collection_types import (
        SourceCollectionRuntime as SourceCollectionRuntimeMixin,
    )
else:

    class SourceCollectionRuntimeMixin:
        pass


logger = logging.getLogger(__name__)


class SimplePipelineSourceCollectionTargetPlanMixin(SourceCollectionRuntimeMixin):
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
        cached = self._paper_route_target_plan_cache
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
        summary = self._active_bounded_paper_route_target_summary(
            targets=targets,
            symbol=symbol,
            now=now,
        )
        if not summary.active_targets:
            return None
        gate: dict[str, object] = {
            "mode": "paper_route_target_window_submission_gate",
            "symbol": symbol,
            "account_label": self.account_label,
            "target_count": len(summary.active_targets),
            "target_symbols": sorted(target_symbols),
            "active_windows": summary.active_windows[:5],
            "requires_scoped_source_decision": True,
        }
        if summary.window_starts and summary.window_ends:
            gate["window_start"] = min(summary.window_starts).isoformat()
            gate["window_end"] = max(summary.window_ends).isoformat()
        gate.update(_target_plan_lineage(summary.active_targets, symbol))
        return gate

    @staticmethod
    def _active_bounded_paper_route_target_summary(
        *,
        targets: Sequence[Mapping[str, Any]],
        symbol: str,
        now: datetime,
    ) -> SourceCollectionActiveWindowSummary:
        active_targets: list[dict[str, Any]] = []
        active_windows: list[dict[str, str]] = []
        window_starts: list[datetime] = []
        window_ends: list[datetime] = []
        for target in targets:
            window = _target_probe_window(target)
            if (
                not _target_requires_bounded_sim_collection_gate(target)
                or symbol not in _target_symbols(target)
                or window is None
            ):
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
        return SourceCollectionActiveWindowSummary(
            active_targets=active_targets,
            active_windows=active_windows,
            window_starts=window_starts,
            window_ends=window_ends,
        )

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
                    SimplePipelineSourceCollectionTargetPlanMixin._paper_route_target_strategy_symbols(
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

        if _target_has_bounded_source_collection_authorization(normalized):
            now = self._trading_now().astimezone(timezone.utc)
        else:
            now = None
        if now is not None and self._paper_route_target_uses_current_session_window(
            normalized,
            now=now,
        ):
            source_window = _target_probe_window(normalized)
            window_start = regular_session_open_utc_for(now)
            window_end = window_start + timedelta(minutes=_REGULAR_SESSION_MINUTES)
            if source_window is not None:
                normalized.setdefault(
                    "paper_route_probe_source_window_start",
                    source_window[0].isoformat(),
                )
                normalized.setdefault(
                    "paper_route_probe_source_window_end",
                    source_window[1].isoformat(),
                )
                normalized.setdefault(
                    "paper_route_probe_window_overrode_source_window",
                    True,
                )
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
    def _paper_route_target_uses_current_session_window(
        target: Mapping[str, Any],
        *,
        now: datetime,
    ) -> bool:
        if _target_missing_explicit_probe_window(target):
            return True
        scope = _safe_text(target.get("bounded_evidence_collection_scope"))
        next_session_cap = _optional_decimal(
            target.get("paper_route_probe_next_session_max_notional")
        )
        if scope != "paper_route_probe_next_session_only" and next_session_cap is None:
            return False
        source_window = _target_probe_window(target)
        if source_window is None:
            return True
        window_start = regular_session_open_utc_for(now)
        window_end = window_start + timedelta(minutes=_REGULAR_SESSION_MINUTES)
        return source_window != (window_start, window_end)

    @staticmethod
    def _paper_route_target_source_decision_metadata(
        **metadata_args: Any,
    ) -> dict[str, Any]:
        context, symbol = (
            SimplePipelineSourceCollectionTargetPlanMixin._source_collection_metadata_context(
                metadata_args
            )
        )
        return SimplePipelineSourceCollectionTargetPlanMixin._paper_route_target_source_decision_metadata_from_context(
            context=context,
            symbol=symbol,
        )

    @staticmethod
    def _source_collection_metadata_context(
        metadata_args: Mapping[str, Any],
        *,
        require_window: bool = True,
    ) -> tuple[SourceCollectionTargetContext, str]:
        raw_symbol = metadata_args.get("symbol")
        if not isinstance(raw_symbol, str) or not raw_symbol.strip():
            raise TypeError("symbol is required")
        symbol = raw_symbol.strip().upper()
        context = metadata_args.get("context")
        if isinstance(context, SourceCollectionTargetContext):
            return context, symbol
        target = metadata_args.get("target")
        strategy = metadata_args.get("strategy")
        window_start = metadata_args.get("window_start")
        window_end = metadata_args.get("window_end")
        max_notional = _optional_decimal(metadata_args.get("max_notional"))
        if not isinstance(target, Mapping):
            raise TypeError("target is required")
        if not isinstance(strategy, Strategy):
            raise TypeError("strategy is required")
        if require_window and not (
            isinstance(window_start, datetime) and isinstance(window_end, datetime)
        ):
            raise TypeError("window_start and window_end are required")
        if not isinstance(window_start, datetime):
            window_start = datetime.fromtimestamp(0, tz=timezone.utc)
        if not isinstance(window_end, datetime):
            window_end = window_start
        if max_notional is None:
            raise TypeError("max_notional is required")
        target_mapping = cast(Mapping[str, Any], target)
        normalized_target: dict[str, Any] = dict(target_mapping)
        symbols = sorted(_target_symbols(normalized_target)) or [symbol]
        return (
            SourceCollectionTargetContext(
                target=normalized_target,
                strategy=strategy,
                symbols=symbols,
                symbol_actions=_target_probe_symbol_actions(normalized_target, symbols),
                symbol_quantities=_target_probe_symbol_quantities(
                    normalized_target,
                    symbols,
                ),
                pair_balance_state="not_required",
                window_start=window_start,
                window_end=window_end,
                target_cap=max_notional,
            ),
            symbol,
        )

    @staticmethod
    def _paper_route_target_source_decision_metadata_from_context(
        *,
        context: SourceCollectionTargetContext,
        symbol: str,
    ) -> dict[str, Any]:
        target = context.target
        strategy = context.strategy
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
            "paper_route_probe_window_start": context.window_start.isoformat(),
            "paper_route_probe_window_end": context.window_end.isoformat(),
            "paper_route_probe_total_max_notional": (
                _safe_text(target.get("paper_route_probe_total_max_notional"))
                or str(context.target_cap)
            ),
            "paper_route_probe_next_session_max_notional": str(context.target_cap),
            "paper_route_probe_effective_max_notional": str(context.target_cap),
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
            "bounded_evidence_collection_max_notional": str(context.target_cap),
            **source_collection_authority(
                blockers=["runtime_ledger_source_collection_pending"],
                bounded_live_paper_collection_authorized=(
                    bounded_collection_authorized
                ),
            ).as_target_fields(),
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
                context.window_start + timedelta(minutes=effective_exit_minute)
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
        **metadata_args: Any,
    ) -> dict[str, Any]:
        context, symbol = (
            SimplePipelineSourceCollectionTargetPlanMixin._source_collection_metadata_context(
                metadata_args,
                require_window=False,
            )
        )
        action = metadata_args.get("action")
        if action not in {"buy", "sell"}:
            raise TypeError("action must be buy or sell")
        account_label = metadata_args.get("account_label")
        return SimplePipelineSourceCollectionTargetPlanMixin._bounded_paper_route_execution_metadata_from_context(
            context=context,
            symbol=symbol,
            action=cast(SourceCollectionAction, action),
            account_label=str(account_label).strip()
            if account_label is not None
            else None,
        )

    @staticmethod
    def _bounded_paper_route_execution_metadata_from_context(
        *,
        context: SourceCollectionTargetContext,
        symbol: str,
        action: SourceCollectionAction,
        account_label: str | None,
    ) -> dict[str, Any]:
        target = context.target
        strategy = context.strategy
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
        execution_policy: dict[str, Any] = {
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
            "max_notional": str(context.target_cap),
            "idempotency_key_basis": "trade_decision_hash_client_order_id",
            "order_feed_linkage_keys": [
                "alpaca_account_label",
                "client_order_id",
            ],
        }
        if "promotion_stage" not in execution_policy:
            execution_policy.update(
                capital_blocked_authority(
                    blockers=["execution_policy_not_capital_promotion_authority"],
                ).as_target_fields()
            )
        if target_capital_promotion_allowed(execution_policy):
            execution_policy["promotion_stage"] = "capital_allowed"
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


__all__ = ["SimplePipelineSourceCollectionTargetPlanMixin"]
