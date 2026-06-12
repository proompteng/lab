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


class _SimplePipelineSubmissionPreparationMixinMethodsPart1:
    def _submission_control_plane_snapshot(
        self,
        *,
        capital_stage: str | None = None,
    ) -> dict[str, object]:
        snapshot = super()._submission_control_plane_snapshot(
            capital_stage=capital_stage
        )
        snapshot["pipeline_mode"] = settings.trading_pipeline_mode
        snapshot["execution_lane"] = "simple"
        snapshot["submit_path"] = "direct_alpaca"
        return snapshot

    def _ensure_decision_price(
        self, decision: StrategyDecision, signal_price: Any
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]]:
        requires_executable_quote = (
            self._paper_route_decision_requires_executable_quote(decision)
        )
        if signal_price is not None and "price_snapshot" in decision.params:
            if (
                not requires_executable_quote
                or self._decision_has_executable_quote_payload(decision)
            ):
                return decision, None
        if (
            signal_price is not None
            and requires_executable_quote
            and self._decision_has_executable_quote_payload(decision)
        ):
            return decision, None
        snapshot = self.price_fetcher.fetch_market_snapshot(
            SignalEnvelope(
                event_ts=decision.event_ts,
                symbol=decision.symbol,
                payload={},
                timeframe=decision.timeframe,
            )
        )
        target_snapshot = _target_metadata_quote_snapshot(
            decision.params,
            symbol=decision.symbol,
        )
        snapshot_has_executable_quote = (
            snapshot is not None
            and snapshot.bid is not None
            and snapshot.ask is not None
            and snapshot.bid > 0
            and snapshot.ask >= snapshot.bid
        )
        if (
            (
                snapshot is None
                or snapshot.price is None
                or (requires_executable_quote and not snapshot_has_executable_quote)
            )
            and target_snapshot is not None
            and _snapshot_has_executable_quote(target_snapshot)
        ):
            updated_params = self._paper_route_params_with_quote_snapshot(
                decision.params,
                target_snapshot,
                signal_price=signal_price,
            )
            return decision.model_copy(update={"params": updated_params}), None
        if snapshot is None or snapshot.price is None:
            return decision, None
        updated_params = dict(decision.params)
        if signal_price is None:
            updated_params["price"] = snapshot.price
        updated_params["price_snapshot"] = self._paper_route_price_snapshot_payload(
            snapshot
        )
        if snapshot.spread is not None and "spread" not in updated_params:
            updated_params["spread"] = snapshot.spread
        if snapshot.bid is not None:
            updated_params.setdefault("imbalance_bid_px", snapshot.bid)
        if snapshot.ask is not None:
            updated_params.setdefault("imbalance_ask_px", snapshot.ask)
        if snapshot.spread is not None:
            updated_params.setdefault("imbalance_spread", snapshot.spread)
        return decision.model_copy(update={"params": updated_params}), snapshot

    @staticmethod
    def _paper_route_params_with_quote_snapshot(
        params: Mapping[str, Any],
        snapshot: Mapping[str, Any],
        *,
        signal_price: Any,
    ) -> dict[str, Any]:
        updated_params = dict(params)
        price = _decimal_from_mapping(
            snapshot, ("price", "mid", "mid_price", "midpoint")
        )
        bid = _decimal_from_mapping(snapshot, ("bid", "bid_px", "bid_price", "bp"))
        ask = _decimal_from_mapping(snapshot, ("ask", "ask_px", "ask_price", "ap"))
        spread = _decimal_from_mapping(snapshot, ("spread", "imbalance_spread"))
        computed_spread = ask - bid if bid is not None and ask is not None else None
        quote_as_of = (
            _parse_target_datetime(snapshot.get("quote_as_of"))
            or _parse_target_datetime(snapshot.get("as_of"))
            or _parse_target_datetime(snapshot.get("timestamp"))
        )
        source = _text_from_mapping(snapshot, ("quote_source", "source", "feed"))
        if price is None and bid is not None and ask is not None:
            price = (bid + ask) / Decimal("2")
        if signal_price is None and price is not None:
            updated_params["price"] = price
        if bid is not None:
            updated_params.setdefault("imbalance_bid_px", bid)
        if ask is not None:
            updated_params.setdefault("imbalance_ask_px", ask)
        if spread is not None or computed_spread is not None:
            effective_spread = spread if spread is not None else computed_spread
            updated_params.setdefault("spread", effective_spread)
            updated_params.setdefault("imbalance_spread", effective_spread)
        updated_params["price_snapshot"] = {
            "source": source,
            "quote_source": source,
            "as_of": quote_as_of.isoformat() if quote_as_of is not None else None,
            "quote_as_of": quote_as_of.isoformat() if quote_as_of is not None else None,
            "price": str(price) if price is not None else None,
            "bid": str(bid) if bid is not None else None,
            "ask": str(ask) if ask is not None else None,
            "spread": str(spread if spread is not None else computed_spread)
            if spread is not None or computed_spread is not None
            else None,
        }
        return updated_params

    @staticmethod
    def _decision_has_executable_quote_payload(decision: StrategyDecision) -> bool:
        params = decision.params
        if _executable_bid_ask_present(params):
            return True
        price_snapshot = params.get("price_snapshot")
        if isinstance(price_snapshot, Mapping):
            return _executable_bid_ask_present(cast(Mapping[str, Any], price_snapshot))
        return False

    @staticmethod
    def _paper_route_price_snapshot_payload(
        snapshot: MarketSnapshot,
    ) -> dict[str, Any]:
        payload = _price_snapshot_payload(snapshot)
        if snapshot.bid is not None:
            payload["bid"] = str(snapshot.bid)
        if snapshot.ask is not None:
            payload["ask"] = str(snapshot.ask)
        if snapshot.quote_as_of is not None:
            payload["quote_as_of"] = snapshot.quote_as_of.isoformat()
        if snapshot.quote_source is not None:
            payload["quote_source"] = snapshot.quote_source
        return payload

    def _paper_route_target_sizing_price(
        self,
        *,
        target: Mapping[str, Any],
        symbol: str,
        action: Literal["buy", "sell"],
        event_ts: datetime,
        timeframe: str,
    ) -> tuple[Decimal | None, dict[str, Any], str | None]:
        target_snapshot = _target_metadata_quote_snapshot(
            target,
            symbol=symbol,
        ) or _quote_snapshot_from_mapping(target, symbol=symbol)
        if target_snapshot is not None:
            reference_price = _quote_snapshot_reference_price(
                target_snapshot,
                action=action,
            )
            if reference_price is not None and reference_price > 0:
                price_params = self._paper_route_params_with_quote_snapshot(
                    {},
                    target_snapshot,
                    signal_price=None,
                )
                price_params["price"] = reference_price
                price_params["reference_price"] = reference_price
                return reference_price, price_params, "target_plan_quote_snapshot"

        price_fetcher = getattr(self, "price_fetcher", None)
        if price_fetcher is None:
            return None, {}, None
        try:
            snapshot = price_fetcher.fetch_market_snapshot(
                SignalEnvelope(
                    event_ts=event_ts,
                    symbol=symbol,
                    payload={},
                    timeframe=timeframe,
                )
            )
        except Exception:
            logger.exception(
                "Failed to fetch paper-route target sizing quote symbol=%s timeframe=%s",
                symbol,
                timeframe,
            )
            return None, {}, None
        if snapshot is None:
            return None, {}, None
        snapshot_payload = self._paper_route_price_snapshot_payload(snapshot)
        reference_price = _quote_snapshot_reference_price(
            snapshot_payload,
            action=action,
        )
        if reference_price is None or reference_price <= 0:
            return None, {"price_snapshot": snapshot_payload}, "price_fetcher_snapshot"
        return (
            reference_price,
            {
                "price": reference_price,
                "reference_price": reference_price,
                "price_snapshot": snapshot_payload,
            },
            "price_fetcher_snapshot",
        )

    def _paper_route_target_quantity_resolution(
        self,
        *,
        target: Mapping[str, Any],
        symbol: str,
        symbols: Sequence[str],
        action: Literal["buy", "sell"],
        requested_qty: Decimal,
        symbol_quantities: Mapping[str, Decimal],
        max_notional: Decimal,
        event_ts: datetime,
        timeframe: str,
    ) -> _TargetProbeQuantityResolution | None:
        if requested_qty <= 0:
            return None
        normalized_symbol = symbol.strip().upper()
        symbol_budget = _target_probe_symbol_notional_budget(
            target=target,
            symbol=normalized_symbol,
            symbols=symbols,
            symbol_quantities=symbol_quantities,
            max_notional=max_notional,
        )
        reference_price, price_params, price_source = (
            self._paper_route_target_sizing_price(
                target=target,
                symbol=normalized_symbol,
                action=action,
                event_ts=event_ts,
                timeframe=timeframe,
            )
        )
        audit: dict[str, Any] = {
            "schema_version": "torghut.paper-route-target-notional-sizing.v1",
            "symbol": normalized_symbol,
            "action": action,
            "sizing_source": "quantity_fallback",
            "requested_qty": str(requested_qty),
            "resolved_qty": str(requested_qty),
            "target_notional": str(_target_probe_cap(target) or max_notional),
            "paper_route_probe_max_notional": str(max_notional),
            "symbol_notional_budget": (
                str(symbol_budget) if symbol_budget is not None else None
            ),
            "reference_price": (
                str(reference_price) if reference_price is not None else None
            ),
            "reference_price_source": price_source,
            "symbols": [item.strip().upper() for item in symbols if item.strip()],
            "blockers": [],
        }
        if reference_price is not None and reference_price > 0:
            requested_notional = requested_qty * reference_price
            audit["requested_notional"] = str(requested_notional)
            if symbol_budget is not None and requested_notional > 0:
                audit["notional_scale_gap"] = str(symbol_budget / requested_notional)

        if symbol_budget is None or symbol_budget <= 0:
            audit["blockers"] = ["paper_route_target_symbol_notional_budget_missing"]
            return _TargetProbeQuantityResolution(
                qty=requested_qty,
                audit=audit,
                price_params=price_params,
            )
        if reference_price is None or reference_price <= 0:
            audit["blockers"] = ["paper_route_target_notional_price_missing"]
            return _TargetProbeQuantityResolution(
                qty=requested_qty,
                audit=audit,
                price_params=price_params,
            )

        resolved_qty = (symbol_budget / reference_price).quantize(
            _PAPER_ROUTE_PROBE_QTY_STEP,
            rounding=ROUND_DOWN,
        )
        if resolved_qty <= 0:
            audit["blockers"] = ["paper_route_target_notional_qty_below_min_step"]
            return None
        audit["sizing_source"] = "target_notional"
        audit["resolved_qty"] = str(resolved_qty)
        audit["resolved_notional"] = str(resolved_qty * reference_price)
        audit["overrode_requested_qty"] = resolved_qty != requested_qty
        return _TargetProbeQuantityResolution(
            qty=resolved_qty,
            audit=audit,
            price_params=price_params,
        )

    @staticmethod
    def _decision_quote_snapshot_for_target_sizing(
        decision: StrategyDecision,
    ) -> dict[str, Any] | None:
        normalized_symbol = decision.symbol.strip().upper()
        snapshot = _quote_snapshot_from_mapping(
            decision.params,
            symbol=normalized_symbol,
        )
        if snapshot is not None:
            return dict(snapshot)
        price = _decimal_from_mapping(
            decision.params,
            ("price", "reference_price", "mid", "mid_price"),
        )
        bid = _decimal_from_mapping(
            decision.params,
            ("imbalance_bid_px", "bid", "bid_px", "bid_price"),
        )
        ask = _decimal_from_mapping(
            decision.params,
            ("imbalance_ask_px", "ask", "ask_px", "ask_price"),
        )
        spread = _decimal_from_mapping(
            decision.params,
            ("imbalance_spread", "spread"),
        )
        if price is None and bid is not None and ask is not None and ask >= bid:
            price = (bid + ask) / Decimal("2")
        if price is None and bid is None and ask is None:
            return None
        return {
            "symbol": normalized_symbol,
            "price": str(price) if price is not None else None,
            "bid": str(bid) if bid is not None else None,
            "ask": str(ask) if ask is not None else None,
            "spread": str(spread) if spread is not None else None,
            "source": "decision_executable_quote",
            "quote_source": "decision_executable_quote",
        }

    def _bounded_collection_target_sizing_payload(
        self,
        *,
        decision: StrategyDecision,
        metadata: Mapping[str, Any],
    ) -> dict[str, Any]:
        normalized_symbol = decision.symbol.strip().upper()
        target = dict(metadata)
        if _quote_snapshot_from_mapping(target, symbol=normalized_symbol) is None:
            snapshot = self._decision_quote_snapshot_for_target_sizing(decision)
            if snapshot is not None:
                target["price_snapshot"] = snapshot
        return target

    @staticmethod
    def _bounded_collection_exit_window_elapsed(
        *,
        decision: StrategyDecision,
        metadata: Mapping[str, Any],
    ) -> tuple[datetime, datetime] | None:
        exit_due_at = _parse_target_datetime(metadata.get("exit_due_at"))
        if exit_due_at is None:
            return None
        event_ts = decision.event_ts
        if event_ts.tzinfo is None:
            event_ts = event_ts.replace(tzinfo=timezone.utc)
        event_ts = event_ts.astimezone(timezone.utc)
        if event_ts < exit_due_at:
            return None
        return event_ts, exit_due_at

    @staticmethod
    def _apply_bounded_collection_exit_window_audit(
        decision: StrategyDecision,
        *,
        event_ts: datetime,
        exit_due_at: datetime,
    ) -> StrategyDecision:
        reason = "bounded_paper_route_target_exit_window_elapsed"
        audit = {
            "schema_version": "torghut.bounded-paper-route-exit-window.v1",
            "state": "rejected",
            "reason": reason,
            "symbol": decision.symbol.strip().upper(),
            "action": decision.action,
            "event_ts": event_ts.isoformat(),
            "exit_due_at": exit_due_at.isoformat(),
            "source_decision_mode": (
                BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
            ),
        }
        params = dict(decision.params)
        params["bounded_paper_route_target_exit_window"] = audit
        simple_lane = dict(cast(Mapping[str, Any], params.get("simple_lane") or {}))
        simple_lane["bounded_paper_route_target_exit_window"] = audit
        params["simple_lane"] = simple_lane

        for key in (
            "paper_route_target_plan_source_decision",
            "paper_route_target_plan",
            "paper_route_probe",
        ):
            metadata = _mapping_value(params.get(key))
            if metadata is None:
                continue
            updated_metadata = dict(metadata)
            updated_metadata["bounded_paper_route_target_exit_window"] = audit
            params[key] = updated_metadata

        return decision.model_copy(update={"params": params})

    def _bounded_collection_exit_window_guarded_decision(
        self,
        decision: StrategyDecision,
    ) -> tuple[StrategyDecision, str | None]:
        if self._paper_route_probe_exit_metadata(decision) is not None:
            return decision, None
        metadata = _bounded_paper_route_collection_entry_metadata(decision.params)
        if metadata is None:
            return decision, None
        elapsed = self._bounded_collection_exit_window_elapsed(
            decision=decision,
            metadata=metadata,
        )
        if elapsed is None:
            return decision, None
        event_ts, exit_due_at = elapsed
        updated = self._apply_bounded_collection_exit_window_audit(
            decision,
            event_ts=event_ts,
            exit_due_at=exit_due_at,
        )
        return updated, "bounded_paper_route_target_exit_window_elapsed"

    @staticmethod
    def _apply_bounded_collection_target_sizing_audit(
        decision: StrategyDecision,
        *,
        audit: Mapping[str, Any],
        qty: Decimal,
        action: Literal["buy", "sell"] | None = None,
        price_params: Mapping[str, Any] | None = None,
    ) -> StrategyDecision:
        params = dict(decision.params)
        if price_params:
            params.update(dict(price_params))
        audit_payload = dict(audit)
        params["paper_route_target_notional_sizing"] = audit_payload

        reference_price = _optional_decimal(audit_payload.get("reference_price"))
        notional = qty * reference_price if reference_price is not None else None
        simple_lane = dict(cast(Mapping[str, Any], params.get("simple_lane") or {}))
        simple_lane["final_qty"] = str(qty)
        simple_lane["paper_route_target_notional_sizing"] = audit_payload
        simple_lane["target_source_notional_sized"] = (
            _safe_text(audit_payload.get("sizing_source")) == "target_notional"
        )
        if notional is not None:
            simple_lane["notional"] = str(notional)
        params["simple_lane"] = simple_lane

        for key in (
            "paper_route_target_plan_source_decision",
            "paper_route_target_plan",
            "paper_route_probe",
        ):
            metadata = _mapping_value(params.get(key))
            if metadata is None:
                continue
            updated_metadata = dict(metadata)
            updated_metadata["paper_route_target_notional_sizing"] = audit_payload
            updated_metadata["target_source_notional_sized"] = (
                _safe_text(audit_payload.get("sizing_source")) == "target_notional"
            )
            params[key] = updated_metadata

        update: dict[str, Any] = {"qty": qty, "params": params}
        if action is not None:
            update["action"] = action
        return decision.model_copy(update=update)

    def _bounded_collection_target_notional_sized_decision(
        self,
        *,
        decision: StrategyDecision,
        strategy: Strategy,
        positions: list[dict[str, Any]],
    ) -> tuple[StrategyDecision, str | None]:
        if self._paper_route_probe_exit_metadata(decision) is not None:
            return decision, None

        metadata = _bounded_paper_route_collection_entry_metadata(decision.params)
        if metadata is None:
            if not _bounded_collection_decision_requires_target_notional_sizing(
                decision.params
            ):
                return decision, None
            audit = {
                "schema_version": "torghut.paper-route-target-notional-sizing.v1",
                "symbol": decision.symbol.strip().upper(),
                "action": decision.action,
                "sizing_source": "missing",
                "requested_qty": str(decision.qty),
                "resolved_qty": str(decision.qty),
                "blockers": ["bounded_paper_route_target_metadata_missing"],
            }
            updated = self._apply_bounded_collection_target_sizing_audit(
                decision,
                audit=audit,
                qty=decision.qty,
            )
            return updated, "bounded_paper_route_target_notional_sizing_missing"

        exit_guarded_decision, exit_window_reason = (
            self._bounded_collection_exit_window_guarded_decision(decision)
        )
        if exit_window_reason is not None:
            return exit_guarded_decision, exit_window_reason

        target = self._bounded_collection_target_sizing_payload(
            decision=decision,
            metadata=metadata,
        )
        normalized_symbol = decision.symbol.strip().upper()
        target_symbols = sorted(_target_symbols(target))
        if normalized_symbol not in target_symbols:
            target_symbols.append(normalized_symbol)
        symbol_quantities = _target_probe_symbol_quantities(target, target_symbols)
        requested_qty = symbol_quantities.get(normalized_symbol) or decision.qty
        action: Literal["buy", "sell"] = (
            "sell" if str(decision.action).strip().lower() == "sell" else "buy"
        )
        action = _target_probe_symbol_actions(target, target_symbols).get(
            normalized_symbol,
            action,
        )
        max_notional = _target_probe_cap(target)
        if max_notional is None or max_notional <= 0:
            audit = {
                "schema_version": "torghut.paper-route-target-notional-sizing.v1",
                "symbol": normalized_symbol,
                "action": action,
                "sizing_source": "missing",
                "requested_qty": str(requested_qty),
                "resolved_qty": str(decision.qty),
                "symbols": target_symbols,
                "blockers": ["bounded_paper_route_target_notional_cap_missing"],
            }
            updated = self._apply_bounded_collection_target_sizing_audit(
                decision,
                audit=audit,
                qty=decision.qty,
                action=action,
            )
            return updated, "bounded_paper_route_target_notional_sizing_missing"

        quantity_resolution = self._paper_route_target_quantity_resolution(
            target=target,
            symbol=normalized_symbol,
            symbols=target_symbols,
            action=action,
            requested_qty=requested_qty,
            symbol_quantities=symbol_quantities,
            max_notional=max_notional,
            event_ts=decision.event_ts,
            timeframe=decision.timeframe,
        )
        if quantity_resolution is None:
            audit = {
                "schema_version": "torghut.paper-route-target-notional-sizing.v1",
                "symbol": normalized_symbol,
                "action": action,
                "sizing_source": "missing",
                "requested_qty": str(requested_qty),
                "resolved_qty": str(decision.qty),
                "target_notional": str(max_notional),
                "symbols": target_symbols,
                "blockers": ["paper_route_target_notional_qty_below_min_step"],
            }
            updated = self._apply_bounded_collection_target_sizing_audit(
                decision,
                audit=audit,
                qty=decision.qty,
                action=action,
            )
            return updated, "bounded_paper_route_target_notional_sizing_missing"

        audit = dict(quantity_resolution.audit)
        if _safe_text(audit.get("sizing_source")) != "target_notional":
            updated = self._apply_bounded_collection_target_sizing_audit(
                decision,
                audit=audit,
                qty=quantity_resolution.qty,
                action=action,
                price_params=quantity_resolution.price_params,
            )
            return updated, "bounded_paper_route_target_notional_sizing_missing"

        position_qty = position_qty_for_symbol(positions, normalized_symbol)
        broker_resolution = resolve_quantity_resolution(
            normalized_symbol,
            action=action,
            global_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            position_qty=position_qty,
            requested_qty=quantity_resolution.qty,
        )
        broker_qty = quantize_qty_for_symbol(
            normalized_symbol,
            quantity_resolution.qty,
            fractional_equities_enabled=broker_resolution.fractional_allowed,
        )
        if broker_qty <= 0:
            blockers = list(cast(list[Any], audit.get("blockers") or []))
            blockers.append("paper_route_target_notional_broker_qty_below_min_step")
            audit["blockers"] = list(dict.fromkeys(str(item) for item in blockers))
            audit["broker_quantity_resolution"] = broker_resolution.to_payload()
            updated = self._apply_bounded_collection_target_sizing_audit(
                decision,
                audit=audit,
                qty=decision.qty,
                action=action,
                price_params=quantity_resolution.price_params,
            )
            return updated, "bounded_paper_route_target_notional_sizing_missing"

        reference_price = _optional_decimal(audit.get("reference_price"))
        audit["target_notional_resolved_qty"] = audit.get("resolved_qty")
        audit["target_notional_resolved_notional"] = audit.get("resolved_notional")
        audit["broker_quantity_resolution"] = broker_resolution.to_payload()
        audit["broker_quantity_adjusted"] = broker_qty != quantity_resolution.qty
        audit["broker_resolved_qty"] = str(broker_qty)
        audit["resolved_qty"] = str(broker_qty)
        if reference_price is not None:
            audit["broker_resolved_notional"] = str(broker_qty * reference_price)
            audit["resolved_notional"] = str(broker_qty * reference_price)

        updated = self._apply_bounded_collection_target_sizing_audit(
            decision,
            audit=audit,
            qty=broker_qty,
            action=action,
            price_params=quantity_resolution.price_params,
        )
        return updated, None

    @staticmethod
    def _paper_route_decision_requires_executable_quote(
        decision: StrategyDecision,
    ) -> bool:
        if isinstance(decision.params.get("paper_route_probe_exit"), Mapping):
            return False
        if isinstance(decision.params.get("paper_route_target_plan"), Mapping):
            return True
        if isinstance(
            decision.params.get("paper_route_target_plan_source_decision"), Mapping
        ):
            return True
        if isinstance(decision.params.get("paper_route_probe"), Mapping):
            return True
        if isinstance(decision.params.get("strategy_signal_paper"), Mapping):
            return True
        mode = normalize_source_decision_mode(
            decision.params.get("source_decision_mode")
        )
        return mode in {
            ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
        }


__all__ = [name for name in globals() if not name.startswith("__")]
