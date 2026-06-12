# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Literal, Optional, cast

from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Strategy,
    TradeDecision,
)
from ...firewall import OrderFirewallBlocked
from ...models import SignalEnvelope, StrategyDecision
from ...prices import MarketSnapshot
from ...quote_quality import (
    QuoteQualityPolicy,
    QuoteQualityStatus,
    _status,
    assess_signal_quote_quality,
)
from ...quantity_rules import quantize_qty_for_symbol, resolve_quantity_resolution
from ...runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ...simple_risk import (
    position_qty_for_symbol,
    prepare_simple_decision,
)
from ..pipeline_helpers import (
    _extract_json_error_payload,
    _price_snapshot_payload,
)
from ..target_plan_helpers import (
    _PAPER_ROUTE_PROBE_QTY_STEP,
    _TargetProbeQuantityResolution,
    _bounded_collection_decision_requires_target_notional_sizing,
    _bounded_paper_route_collection_entry_metadata,
    _bounded_sim_collection_metadata_from_decision,
    _decimal_from_mapping,
    _executable_bid_ask_present,
    _first_decimal,
    _mapping_value,
    _min_optional_decimal,
    _optional_decimal,
    _paper_route_probe_entry_metadata,
    _parse_target_datetime,
    _pct_cap_to_notional,
    _quote_snapshot_from_mapping,
    _quote_snapshot_reference_price,
    _safe_int,
    _safe_text,
    _simple_buying_power_consumption,
    _simple_decision_notional,
    _snapshot_has_executable_quote,
    _target_metadata_quote_snapshot,
    _target_notional_sizing_audit_from_params,
    _target_probe_cap,
    _target_probe_symbol_actions,
    _target_probe_symbol_notional_budget,
    _target_probe_symbol_quantities,
    _target_symbols,
    _text_from_mapping,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_74 import *
from .part_02_simplepipelinesubmissionpreparationmixinme import *


class _SimplePipelineSubmissionPreparationMixinMethodsPart2:
    def _paper_route_quote_routeability(
        self,
        decision: StrategyDecision,
        snapshot: MarketSnapshot | None,
    ) -> tuple[QuoteQualityStatus, dict[str, object]]:
        params = decision.params
        price_snapshot_raw = params.get("price_snapshot")
        price_snapshot: Mapping[str, Any]
        if isinstance(price_snapshot_raw, Mapping):
            price_snapshot = cast(Mapping[str, Any], price_snapshot_raw)
        else:
            price_snapshot = {}
        target_quote_snapshot = _target_metadata_quote_snapshot(
            params,
            symbol=decision.symbol,
        )
        target_price_snapshot: Mapping[str, Any] = (
            target_quote_snapshot
            if target_quote_snapshot is not None
            else cast(Mapping[str, Any], {})
        )
        if not price_snapshot and target_quote_snapshot is not None:
            price_snapshot = target_quote_snapshot

        params_price = _optional_decimal(params.get("price"))
        snapshot_price = snapshot.price if snapshot is not None else None
        payload_price = _decimal_from_mapping(
            price_snapshot,
            ("price", "mid", "mid_price", "midpoint"),
        )
        target_payload_price = _decimal_from_mapping(
            target_price_snapshot,
            ("price", "mid", "mid_price", "midpoint"),
        )
        price = _first_decimal(
            snapshot_price,
            payload_price,
            target_payload_price,
            params_price,
        )

        snapshot_bid = snapshot.bid if snapshot is not None else None
        payload_bid = _decimal_from_mapping(
            price_snapshot,
            ("bid", "bid_px", "bid_price", "bp"),
        )
        target_payload_bid = _decimal_from_mapping(
            target_price_snapshot,
            ("bid", "bid_px", "bid_price", "bp"),
        )
        params_bid = _optional_decimal(params.get("imbalance_bid_px"))
        bid = _first_decimal(snapshot_bid, payload_bid, target_payload_bid, params_bid)

        snapshot_ask = snapshot.ask if snapshot is not None else None
        payload_ask = _decimal_from_mapping(
            price_snapshot,
            ("ask", "ask_px", "ask_price", "ap"),
        )
        target_payload_ask = _decimal_from_mapping(
            target_price_snapshot,
            ("ask", "ask_px", "ask_price", "ap"),
        )
        params_ask = _optional_decimal(params.get("imbalance_ask_px"))
        ask = _first_decimal(snapshot_ask, payload_ask, target_payload_ask, params_ask)

        snapshot_spread = snapshot.spread if snapshot is not None else None
        payload_spread = _decimal_from_mapping(
            price_snapshot,
            ("spread", "imbalance_spread"),
        )
        target_payload_spread = _decimal_from_mapping(
            target_price_snapshot,
            ("spread", "imbalance_spread"),
        )
        params_spread = _optional_decimal(params.get("spread"))
        computed_spread = ask - bid if bid is not None and ask is not None else None
        spread = _first_decimal(
            snapshot_spread,
            payload_spread,
            target_payload_spread,
            params_spread,
            computed_spread,
        )
        using_target_executable_quote = (
            target_quote_snapshot is not None
            and snapshot_bid is None
            and snapshot_ask is None
            and payload_bid is None
            and payload_ask is None
            and target_payload_bid is not None
            and target_payload_ask is not None
        )
        target_quote_as_of = (
            _parse_target_datetime(target_price_snapshot.get("quote_as_of"))
            or _parse_target_datetime(target_price_snapshot.get("as_of"))
            or _parse_target_datetime(target_price_snapshot.get("timestamp"))
        )
        price_snapshot_quote_as_of = (
            _parse_target_datetime(price_snapshot.get("quote_as_of"))
            or _parse_target_datetime(price_snapshot.get("as_of"))
            or _parse_target_datetime(price_snapshot.get("timestamp"))
        )
        quote_as_of = (
            target_quote_as_of
            if using_target_executable_quote and target_quote_as_of is not None
            else (
                snapshot.quote_as_of
                if snapshot is not None and snapshot.quote_as_of is not None
                else price_snapshot_quote_as_of or target_quote_as_of
            )
        )
        target_source = _text_from_mapping(
            target_price_snapshot,
            ("quote_source", "source", "feed"),
        )
        price_snapshot_source = _text_from_mapping(
            price_snapshot,
            ("quote_source", "source", "feed"),
        )
        source = (
            target_source
            if using_target_executable_quote and target_source is not None
            else (
                str(
                    (
                        snapshot.quote_source
                        if snapshot is not None and snapshot.quote_source is not None
                        else price_snapshot_source
                        or target_source
                        or (snapshot.source if snapshot is not None else "")
                    )
                    or ""
                ).strip()
                or None
            )
        )
        quality_payload: dict[str, object] = {
            "price": price,
            "imbalance_bid_px": bid,
            "imbalance_ask_px": ask,
            "spread": spread,
            "price_snapshot": {
                "source": source,
                "quote_source": source,
                "as_of": quote_as_of.isoformat() if quote_as_of is not None else None,
                "quote_as_of": quote_as_of.isoformat()
                if quote_as_of is not None
                else None,
                "price": str(price) if price is not None else None,
                "bid": str(bid) if bid is not None else None,
                "ask": str(ask) if ask is not None else None,
                "spread": str(spread) if spread is not None else None,
            },
        }
        status = assess_signal_quote_quality(
            signal=SignalEnvelope(
                event_ts=decision.event_ts,
                symbol=decision.symbol,
                payload=quality_payload,
                timeframe=decision.timeframe,
            ),
            previous_price=None,
            policy=QuoteQualityPolicy(
                max_executable_spread_bps=settings.trading_signal_max_executable_spread_bps,
                max_quote_mid_jump_bps=settings.trading_signal_max_quote_mid_jump_bps,
                max_jump_with_wide_spread_bps=settings.trading_signal_max_jump_with_wide_spread_bps,
                max_executable_quote_age_seconds=settings.trading_executable_quote_lookback_seconds,
            ),
        )
        quote_lookup_diagnostics = (
            snapshot.quote_lookup_diagnostics if snapshot is not None else None
        )
        status = self._apply_quote_lookup_diagnostic_reason(
            status,
            quote_lookup_diagnostics=quote_lookup_diagnostics,
        )
        target_mismatch = self._paper_route_target_plan_source_mismatch(decision)
        if target_mismatch is not None:
            status = QuoteQualityStatus(
                valid=False,
                reason="target_plan_source_mismatch",
                spread_bps=status.spread_bps,
                jump_bps=status.jump_bps,
                quote_age_seconds=status.quote_age_seconds,
                source=source,
                price=status.price,
                bid=status.bid,
                ask=status.ask,
                fillability_state="blocked",
                repair_action="skip_symbol_until_target_plan_source_matches_decision",
                operator_next_action="skip_symbol",
                evidence_requirements=(
                    "target_plan_symbol_scope",
                    "strategy_source_decision_lineage",
                ),
            )
        routeability = self._paper_route_quote_routeability_payload(
            decision=decision,
            status=status,
            source=source,
            quote_as_of=quote_as_of,
            quote_lookup_diagnostics=quote_lookup_diagnostics,
            target_mismatch=target_mismatch,
        )
        return status, routeability

    @staticmethod
    def _apply_quote_lookup_diagnostic_reason(
        status: QuoteQualityStatus,
        *,
        quote_lookup_diagnostics: Mapping[str, object] | None,
    ) -> QuoteQualityStatus:
        if status.valid or status.reason != "missing_executable_quote":
            return status
        if not isinstance(quote_lookup_diagnostics, Mapping):
            return status
        diagnostic_reason = _safe_text(
            quote_lookup_diagnostics.get("latest_quote_rejected_reason")
        )
        if diagnostic_reason not in {
            "crossed_quote",
            "non_positive_bid",
            "non_positive_ask",
            "spread_bps_exceeded",
        }:
            return status
        return _status(
            valid=False,
            reason=diagnostic_reason,
            spread_bps=_optional_decimal(
                quote_lookup_diagnostics.get("latest_quote_spread_bps")
            )
            or status.spread_bps,
            jump_bps=status.jump_bps,
            quote_age_seconds=status.quote_age_seconds,
            source=status.source,
            price=status.price,
            bid=status.bid,
            ask=status.ask,
        )

    @staticmethod
    def _paper_route_target_plan_source_mismatch(
        decision: StrategyDecision,
    ) -> dict[str, object] | None:
        metadata = _mapping_value(
            decision.params.get("paper_route_target_plan_source_decision")
        ) or _mapping_value(decision.params.get("paper_route_target_plan"))
        if metadata is None:
            return None
        symbol = decision.symbol.strip().upper()
        metadata_symbol = _safe_text(metadata.get("symbol"))
        target_symbols = _target_symbols(metadata)
        mismatches: list[str] = []
        if metadata_symbol is not None and metadata_symbol.upper() != symbol:
            mismatches.append("target_plan_symbol_mismatch")
        if target_symbols and symbol not in target_symbols:
            mismatches.append("target_plan_symbol_scope_mismatch")
        expected_action = (
            SimplePipelineSubmissionPreparationMixin._target_plan_action_for_symbol(
                metadata,
                symbol=symbol,
            )
        )
        decision_action = (
            SimplePipelineSubmissionPreparationMixin._normalize_target_plan_action(
                decision.action
            )
        )
        if expected_action is not None and decision_action != expected_action:
            mismatches.append("target_plan_side_mismatch")
        if not mismatches:
            return None
        return {
            "schema_version": "torghut.paper-route-target-plan-source-mismatch.v1",
            "symbol": symbol,
            "metadata_symbol": metadata_symbol,
            "target_symbols": sorted(target_symbols),
            "decision_action": decision_action,
            "target_action": expected_action,
            "mismatches": mismatches,
        }

    @staticmethod
    def _target_plan_action_for_symbol(
        metadata: Mapping[str, Any],
        *,
        symbol: str,
    ) -> Literal["buy", "sell"] | None:
        normalized_symbol = symbol.strip().upper()
        raw_actions = metadata.get("paper_route_probe_symbol_actions")
        if isinstance(raw_actions, Mapping):
            for raw_symbol, raw_action in cast(
                Mapping[object, object], raw_actions
            ).items():
                if str(raw_symbol).strip().upper() != normalized_symbol:
                    continue
                return SimplePipelineSubmissionPreparationMixin._normalize_target_plan_action(
                    raw_action
                )
        metadata_symbol = _safe_text(metadata.get("symbol"))
        direct_symbol_matches = (
            metadata_symbol is None or metadata_symbol.upper() == normalized_symbol
        )
        if not direct_symbol_matches:
            return None
        for key in (
            "paper_route_probe_leg_action",
            "paper_route_probe_action",
            "probe_action",
            "action",
            "side",
        ):
            action = (
                SimplePipelineSubmissionPreparationMixin._normalize_target_plan_action(
                    metadata.get(key)
                )
            )
            if action is not None:
                return action
        return None

    @staticmethod
    def _normalize_target_plan_action(value: object) -> Literal["buy", "sell"] | None:
        normalized = str(value or "").strip().lower()
        if normalized in {"buy", "long"}:
            return "buy"
        if normalized in {"sell", "short"}:
            return "sell"
        return None

    @staticmethod
    def _paper_route_quote_routeability_payload(
        *,
        decision: StrategyDecision,
        status: QuoteQualityStatus,
        source: str | None,
        quote_as_of: datetime | None,
        quote_lookup_diagnostics: Mapping[str, object] | None = None,
        target_mismatch: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        blockers = [] if status.valid else [status.reason or "missing_executable_quote"]
        return {
            "schema_version": "torghut.paper-route-quote-routeability.v1",
            "status": "accepted" if status.valid else "blocked",
            "reason": status.reason if not status.valid else "executable_quote_ready",
            "symbol": decision.symbol.strip().upper(),
            "source": source,
            "quote_as_of": quote_as_of.isoformat() if quote_as_of is not None else None,
            "quote_age_seconds": str(status.quote_age_seconds)
            if status.quote_age_seconds is not None
            else None,
            "spread_bps": str(status.spread_bps)
            if status.spread_bps is not None
            else None,
            "max_spread_bps": str(settings.trading_signal_max_executable_spread_bps),
            "max_quote_age_seconds": settings.trading_executable_quote_lookback_seconds,
            "bid": str(status.bid) if status.bid is not None else None,
            "ask": str(status.ask) if status.ask is not None else None,
            "price": str(status.price) if status.price is not None else None,
            "capability": "executable_bid_ask",
            "fillability_state": status.fillability_state,
            "repair_action": status.repair_action,
            "operator_next_action": status.operator_next_action,
            "bounded_evidence_collection_ready": status.valid,
            "bounded_evidence_collection_action": (
                "allow_bounded_collection"
                if status.valid
                else status.operator_next_action or "refresh_source_snapshot"
            ),
            "promotion_allowed": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
            "readiness": {
                "schema_version": "torghut.paper-route-fillability-readiness.v1",
                "state": "ready" if status.valid else "blocked",
                "blockers": blockers,
                "next_operator_action": status.operator_next_action,
                "repair_action": status.repair_action,
                "evidence_requirements": list(status.evidence_requirements),
                "promotion_allowed": False,
                "final_authority_ok": False,
            },
            "target_plan_source_mismatch": dict(target_mismatch)
            if target_mismatch is not None
            else None,
            "quote_lookup_diagnostics": dict(quote_lookup_diagnostics)
            if isinstance(quote_lookup_diagnostics, Mapping)
            else None,
        }

    @staticmethod
    def _paper_route_quote_routeability_retry_metadata(
        decision_row: TradeDecision,
    ) -> dict[str, object] | None:
        if decision_row.status != "rejected":
            return None
        decision_json_raw = decision_row.decision_json
        if not isinstance(decision_json_raw, Mapping):
            return None
        decision_json = cast(Mapping[str, Any], decision_json_raw)
        params = _mapping_value(decision_json.get("params"))
        if params is None:
            return None
        if not (
            isinstance(params.get("paper_route_target_plan_source_decision"), Mapping)
            or isinstance(params.get("paper_route_target_plan"), Mapping)
            or isinstance(params.get("paper_route_probe"), Mapping)
        ):
            return None
        routeability = _mapping_value(params.get("quote_routeability"))
        if routeability is None:
            return None
        if _safe_text(routeability.get("status")) != "blocked":
            return None
        reason = _safe_text(routeability.get("reason"))
        retryable_reasons = {
            "absent_snapshot_fallback",
            "missing_executable_quote",
            "missing_bid",
            "missing_ask",
            "non_positive_price",
            "non_positive_bid",
            "non_positive_ask",
            "crossed_quote",
            "stale_quote",
            "spread_bps_exceeded",
            "wide_spread_midpoint_jump",
        }
        if reason not in retryable_reasons:
            return None
        retry_attempts = _safe_int(
            decision_json.get("paper_route_quote_routeability_retry_attempts")
        )
        retry_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
            0,
        )
        if retry_limit <= 0 or retry_attempts >= retry_limit:
            return None
        return {
            "previous_decision_status": "rejected",
            "previous_submission_stage": "rejected_quote_routeability",
            "previous_quote_routeability_reason": reason,
            "previous_quote_routeability": dict(routeability),
            "previous_retry_attempts": retry_attempts,
        }

    def _reopen_rejected_paper_route_quote_routeability_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        retry_transition = self._paper_route_retry_transition(
            decision_row,
            allowed_kinds=frozenset({"quote_routeability"}),
        )
        if retry_transition is None:
            return None
        retry_metadata = retry_transition.metadata
        if self.executor.execution_exists(session, decision_row):
            return None

        self.executor.sync_decision_state(session, decision_row, decision)
        raw_decision_json = decision_row.decision_json
        decision_json = (
            dict(cast(Mapping[str, Any], raw_decision_json))
            if isinstance(raw_decision_json, Mapping)
            else {}
        )
        retry_attempts = _safe_int(
            decision_json.get("paper_route_quote_routeability_retry_attempts")
        )
        params_mapping = _mapping_value(decision_json.get("params"))
        params = dict(params_mapping) if params_mapping is not None else {}
        params.pop("quote_routeability", None)
        decision_json["params"] = params
        decision_json["submission_stage"] = (
            "paper_route_quote_routeability_retry_pending"
        )
        decision_json["paper_route_quote_routeability_retry_attempts"] = (
            retry_attempts + 1
        )
        decision_json["paper_route_quote_routeability_retry"] = {
            **retry_metadata,
            "submission_stage": "paper_route_quote_routeability_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
        }
        for key in (
            "risk_reasons",
            "reject_reason_atomic",
            "reject_class",
            "reject_origin",
            "broker_precheck",
        ):
            decision_json.pop(key, None)
        decision_row.status = "planned"
        decision_row.created_at = self._trading_now()
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening paper route target source decision after transient quote routeability failure strategy_id=%s decision_id=%s symbol=%s previous_reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            retry_metadata["previous_quote_routeability_reason"],
        )
        return decision_row

    def _prepare_decision_for_submission(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]] | None:
        decision, bounded_exit_window_reject_reason = (
            self._bounded_collection_exit_window_guarded_decision(decision)
        )
        if bounded_exit_window_reject_reason is not None:
            self.executor.update_decision_params(session, decision_row, decision.params)
            self.executor.sync_decision_state(session, decision_row, decision)
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=[bounded_exit_window_reject_reason],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
            return None
        decision, snapshot = self._ensure_decision_price(
            decision, signal_price=decision.params.get("price")
        )
        if self._paper_route_decision_requires_executable_quote(decision):
            quote_status, routeability = self._paper_route_quote_routeability(
                decision,
                snapshot,
            )
            params_update = dict(decision.params)
            params_update["quote_routeability"] = routeability
            decision = decision.model_copy(update={"params": params_update})
            self.executor.update_decision_params(session, decision_row, params_update)
            if not quote_status.valid:
                reason = quote_status.reason or "missing_executable_quote"
                self._record_decision_rejection(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reasons=[reason],
                    log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
                )
                return None
        decision, bounded_target_sizing_reject_reason = (
            self._bounded_collection_target_notional_sized_decision(
                decision=decision,
                strategy=strategy,
                positions=positions,
            )
        )
        self.executor.update_decision_params(session, decision_row, decision.params)
        self.executor.sync_decision_state(session, decision_row, decision)
        if bounded_target_sizing_reject_reason is not None:
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=[bounded_target_sizing_reject_reason],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
            return None
        proof_floor = self._profitability_proof_floor(session=session)
        proof_floor_block_reason = self._proof_floor_submission_block_reason(
            proof_floor
        )
        if (
            proof_floor_block_reason is not None
            and settings.trading_mode == "paper"
            and self._paper_route_probe_exit_metadata(decision) is None
            and _paper_route_probe_entry_metadata(decision.params) is None
        ):
            probe_context = self._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision,
                strategy=strategy,
                session=session,
                strategies=[strategy],
            )
            capped_decision = self._paper_route_probe_capped_decision(
                decision=decision,
                proof_floor=proof_floor,
                context=probe_context or {},
            )
            if capped_decision is not None:
                decision = capped_decision
        max_notional_per_order = _min_optional_decimal(
            _optional_decimal(settings.trading_simple_max_notional_per_order),
            _optional_decimal(settings.trading_max_notional_per_trade),
            _optional_decimal(strategy.max_notional_per_trade),
        )
        equity = _optional_decimal(account.get("equity"))
        max_notional_per_symbol = _min_optional_decimal(
            _optional_decimal(settings.trading_simple_max_notional_per_symbol),
            _optional_decimal(settings.trading_allocator_max_symbol_notional),
            _pct_cap_to_notional(
                equity=equity,
                pct=_optional_decimal(settings.trading_max_position_pct_equity),
            ),
            _pct_cap_to_notional(
                equity=equity,
                pct=_optional_decimal(strategy.max_position_pct_equity),
            ),
        )
        preparation = prepare_simple_decision(
            decision=decision,
            account=account,
            positions=positions,
            fractional_equities_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            max_notional_per_order=max_notional_per_order,
            max_notional_per_symbol=max_notional_per_symbol,
            buying_power_reserve_bps=_optional_decimal(
                settings.trading_simple_buying_power_reserve_bps
            )
            or Decimal("0"),
            max_order_pct_equity=_optional_decimal(
                settings.trading_simple_max_order_pct_equity
            ),
            max_gross_exposure_pct_equity=_optional_decimal(
                settings.trading_simple_max_gross_exposure_pct_equity
            ),
            require_equity_for_exposure_increase=(
                settings.trading_simple_submit_enabled
                or settings.trading_simple_paper_route_probe_enabled
            ),
        )
        target_notional_sizing = _target_notional_sizing_audit_from_params(
            decision.params
        )
        expected_target_qty = (
            _optional_decimal(target_notional_sizing.get("resolved_qty"))
            if target_notional_sizing is not None
            else None
        )
        if (
            target_notional_sizing is not None
            and expected_target_qty is not None
            and expected_target_qty > 0
            and preparation.approved
            and preparation.reject_reason is None
            and preparation.decision.qty != expected_target_qty
        ):
            adjusted_audit = dict(target_notional_sizing)
            adjusted_audit.setdefault(
                "target_notional_resolved_qty",
                adjusted_audit.get("resolved_qty"),
            )
            adjusted_audit.setdefault(
                "target_notional_resolved_notional",
                adjusted_audit.get("resolved_notional"),
            )
            adjusted_audit["precheck_quantity_adjusted"] = True
            adjusted_audit["precheck_adjustment_reason"] = (
                "risk_precheck_capped_quantity"
            )
            adjusted_audit["precheck_resolved_qty"] = str(preparation.decision.qty)
            adjusted_audit["precheck_expected_target_qty"] = str(expected_target_qty)
            reference_price = _optional_decimal(adjusted_audit.get("reference_price"))
            if reference_price is not None:
                adjusted_audit["precheck_resolved_notional"] = str(
                    preparation.decision.qty * reference_price
                )
                adjusted_audit["precheck_expected_target_notional"] = str(
                    expected_target_qty * reference_price
                )
                adjusted_audit["resolved_notional"] = str(
                    preparation.decision.qty * reference_price
                )
            adjusted_audit["resolved_qty"] = str(preparation.decision.qty)
            simple_lane_precheck = _mapping_value(
                preparation.decision.params.get("simple_lane")
            )
            if simple_lane_precheck is not None:
                for key in (
                    "capped_by_order",
                    "capped_by_symbol",
                    "capped_by_buying_power",
                ):
                    if key in simple_lane_precheck:
                        adjusted_audit[f"precheck_{key}"] = bool(
                            simple_lane_precheck.get(key)
                        )
            target_notional_sizing = adjusted_audit
        prepared_for_alignment = preparation.decision
        if target_notional_sizing is not None:
            prepared_action: Literal["buy", "sell"] = (
                "sell"
                if str(preparation.decision.action).strip().lower() == "sell"
                else "buy"
            )
            prepared_for_alignment = self._apply_bounded_collection_target_sizing_audit(
                preparation.decision,
                audit=target_notional_sizing,
                qty=preparation.decision.qty,
                action=prepared_action,
            )
        prepared_decision = self._align_prechecked_paper_route_probe_cap(
            prepared_for_alignment
        )
        self.executor.sync_decision_state(session, decision_row, prepared_decision)
        if preparation.diagnostics:
            params_update = dict(prepared_decision.params)
            params_update["simple_lane_precheck"] = preparation.diagnostics
            self.executor.update_decision_params(session, decision_row, params_update)
        if not preparation.approved or preparation.reject_reason is not None:
            reason = preparation.reject_reason or "broker_precheck_failed"
            self._record_decision_rejection(
                session=session,
                decision=prepared_decision,
                decision_row=decision_row,
                reasons=[reason],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
            return None
        return prepared_decision, snapshot


__all__ = [name for name in globals() if not name.startswith("__")]
