# pyright: reportUnusedImport=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Literal, Optional, cast

from sqlalchemy.orm import Session

from ...config import settings
from ...models import (
    Strategy,
    TradeDecision,
)
from ..firewall import OrderFirewallBlocked
from ..models import SignalEnvelope, StrategyDecision
from ..prices import MarketSnapshot
from ..quote_quality import (
    QuoteQualityPolicy,
    QuoteQualityStatus,
    _status,
    assess_signal_quote_quality,
)
from ..quantity_rules import quantize_qty_for_symbol, resolve_quantity_resolution
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ..simple_risk import (
    position_qty_for_symbol,
    prepare_simple_decision,
)
from .pipeline_helpers import (
    _extract_json_error_payload,
    _price_snapshot_payload,
)
from .target_plan_helpers import (
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

logger = logging.getLogger(__name__)


class SimplePipelineSubmissionPreparationMixin:
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

    def _passes_risk_verdict(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        symbol_allowlist: set[str],
        execution_advisor: Mapping[str, Any] | None,
    ) -> bool:
        _ = (strategy, account, symbol_allowlist, execution_advisor)
        short_reason = self._simple_shortability_reason(
            decision=decision,
            positions=positions,
        )
        if short_reason is None:
            return True
        self._record_decision_rejection(
            session=session,
            decision=decision,
            decision_row=decision_row,
            reasons=[short_reason],
            log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
        )
        return False

    def _is_trading_submission_allowed(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> bool:
        if not settings.trading_enabled:
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason="trading_disabled",
                submission_stage="blocked_trading_disabled",
            )
            return False
        firewall_status = self.order_firewall.status()
        if firewall_status.kill_switch_enabled:
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=["kill_switch_enabled"],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
            return False
        if settings.trading_mode == "live":
            live_submission_gate = self._live_submission_gate(session=session)
            if not bool(live_submission_gate.get("allowed", False)):
                self._block_decision_submission(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reason=str(
                        live_submission_gate.get("reason")
                        or "live_submission_gate_blocked"
                    ),
                    submission_stage="blocked_live_submission_gate",
                    extra_metadata={"live_submission_gate": live_submission_gate},
                )
                return False
        proof_floor = self._profitability_proof_floor(session=session)
        proof_floor_block_reason = self._proof_floor_submission_block_reason(
            proof_floor
        )
        paper_route_probe_applied = False
        if proof_floor_block_reason is not None:
            collection_metadata = _bounded_sim_collection_metadata_from_decision(
                decision,
                account_label=self.account_label,
                trading_mode=settings.trading_mode,
            )
            if not settings.trading_simple_submit_enabled:
                if collection_metadata is None:
                    self._block_decision_submission(
                        session=session,
                        decision=decision,
                        decision_row=decision_row,
                        reason="simple_submit_disabled",
                        submission_stage="blocked_simple_submit_disabled",
                        capital_stage="shadow",
                        extra_metadata={
                            "simple_lane": {
                                "submit_enabled": False,
                                "bounded_sim_collection_bypass": False,
                                "bounded_sim_collection_required": True,
                                "proof_floor_block_reason": proof_floor_block_reason,
                            }
                        },
                    )
                    return False
            if settings.trading_mode == "paper" and (
                self._paper_route_probe_exit_metadata(decision) is not None
                or _paper_route_probe_entry_metadata(decision.params) is not None
                or collection_metadata is not None
            ):
                paper_route_probe_applied = True
            if not paper_route_probe_applied:
                self._block_decision_submission(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reason=proof_floor_block_reason,
                    submission_stage="blocked_profitability_proof_floor",
                    capital_stage=str(
                        proof_floor.get("capital_state") or "zero_notional"
                    ),
                    extra_metadata={"profitability_proof_floor": dict(proof_floor)},
                )
                return False
        proof_floor_symbol_block_reason = (
            self._proof_floor_symbol_block_reason(
                proof_floor,
                decision.symbol,
            )
            if not paper_route_probe_applied
            else None
        )
        if proof_floor_symbol_block_reason is not None:
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason=proof_floor_symbol_block_reason,
                submission_stage="blocked_profitability_route_symbol",
                capital_stage=str(proof_floor.get("capital_state") or "zero_notional"),
                extra_metadata={"profitability_proof_floor": dict(proof_floor)},
            )
            return False
        if settings.trading_emergency_stop_enabled and self.state.emergency_stop_active:
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason=self.state.emergency_stop_reason or "emergency_stop_active",
                submission_stage="blocked_emergency_stop",
            )
            return False
        active_target_window = self._active_bounded_paper_route_target_window(decision)
        if active_target_window is not None:
            collection_metadata = _bounded_sim_collection_metadata_from_decision(
                decision,
                account_label=self.account_label,
                trading_mode=settings.trading_mode,
            )
            exit_metadata = self._paper_route_probe_exit_metadata(decision)
            if collection_metadata is None and exit_metadata is None:
                self._block_decision_submission(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reason="paper_route_target_window_requires_scoped_source_decision",
                    submission_stage="blocked_paper_route_target_window_unscoped",
                    capital_stage="shadow",
                    extra_metadata={
                        "paper_route_target_window": active_target_window,
                        "simple_lane": {
                            "submit_enabled": settings.trading_simple_submit_enabled,
                            "bounded_sim_collection_required": True,
                            "bounded_sim_collection_bypass": False,
                        },
                    },
                )
                return False
        return True

    def _execution_client_for_symbol(
        self, symbol: str, *, symbol_allowlist: set[str] | None = None
    ) -> Any:
        _ = (symbol, symbol_allowlist)
        return self.execution_adapter

    def _submit_order_with_handling(
        self,
        *,
        session: Session,
        execution_client: Any,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        selected_adapter_name: str,
        retry_delays: list[int],
    ) -> tuple[Any | None, bool]:
        try:
            retry_delays_seconds = [float(delay) for delay in retry_delays]
            execution = self.executor.submit_order(
                session,
                execution_client,
                decision,
                decision_row,
                self.account_label,
                execution_expected_adapter=selected_adapter_name,
                retry_delays=retry_delays_seconds,
            )
            return execution, False
        except OrderFirewallBlocked:
            return self._reject_submit(
                session=session,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name=selected_adapter_name,
                reason="kill_switch_enabled",
                rejection_type="firewall_blocked",
            )
        except Exception as exc:
            payload = _extract_json_error_payload(exc) or {}
            reason = self._map_submit_exception(payload)
            metadata = {"broker_precheck": payload} if payload else None
            return self._reject_submit(
                session=session,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name=selected_adapter_name,
                reason=reason,
                rejection_type="submit_failed",
                metadata=metadata,
            )

    def _reject_submit(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        selected_adapter_name: str,
        reason: str,
        rejection_type: str,
        metadata: Mapping[str, Any] | None = None,
    ) -> tuple[None, bool]:
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_state("rejected")
        self.state.metrics.record_decision_rejection_reasons([reason])
        self.state.metrics.record_execution_submit_result(
            status="rejected",
            adapter=selected_adapter_name,
        )
        self.executor.mark_rejected(
            session,
            decision_row,
            reason,
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_submit",
                extra=metadata,
            ),
        )
        self._emit_domain_telemetry(
            event_name="torghut.execution.rejected",
            severity="warning",
            decision=decision,
            decision_row=decision_row,
            reason_codes=[reason],
            extra_properties={"rejection_type": rejection_type},
        )
        return None, True

    @staticmethod
    def _map_submit_exception(payload: Mapping[str, Any]) -> str:
        source = str(payload.get("source") or "").strip().lower()
        code = str(payload.get("code") or "").strip().lower()
        if source == "local_pre_submit":
            if code in {"local_qty_invalid_increment"}:
                return "invalid_qty_increment"
            if code in {"local_qty_below_min", "local_qty_non_positive"}:
                return "qty_below_min_after_clamp"
            if code in {
                "local_account_shorting_disabled",
                "local_symbol_not_shortable",
                "local_symbol_not_tradable",
                "local_shorts_not_allowed",
                "shorting_metadata_unavailable",
            }:
                return "shorting_not_allowed_for_asset"
            return "broker_precheck_failed"
        return "broker_submit_failed"

    def _simple_shortability_reason(
        self,
        *,
        decision: StrategyDecision,
        positions: list[dict[str, Any]],
    ) -> str | None:
        if decision.action != "sell":
            return None
        current_qty = position_qty_for_symbol(positions, decision.symbol)
        if current_qty > 0 and decision.qty <= current_qty:
            return None
        if not settings.trading_allow_shorts:
            return "shorting_not_allowed_for_asset"

        account = self.order_firewall.get_account()
        if account is not None:
            shorting_enabled = account.get("shorting_enabled")
            if isinstance(shorting_enabled, bool) and not shorting_enabled:
                return "shorting_not_allowed_for_asset"
        elif settings.trading_mode == "live":
            return "shorting_not_allowed_for_asset"

        asset = self.order_firewall.get_asset(decision.symbol)
        if asset is not None:
            tradable = asset.get("tradable")
            shortable = asset.get("shortable")
            if isinstance(tradable, bool) and not tradable:
                return "shorting_not_allowed_for_asset"
            if isinstance(shortable, bool) and not shortable:
                return "shorting_not_allowed_for_asset"
        elif settings.trading_mode == "live":
            return "shorting_not_allowed_for_asset"
        return None

    @staticmethod
    def _apply_simple_projected_position(
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
    ) -> None:
        normalized_symbol = decision.symbol.strip().upper()
        updated = False
        for position in positions:
            if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
                continue
            raw_qty = position.get("qty") or position.get("quantity") or "0"
            try:
                qty = Decimal(str(raw_qty))
            except (ArithmeticError, ValueError):
                qty = Decimal("0")
            side = str(position.get("side") or "").strip().lower()
            signed_qty = -abs(qty) if side == "short" else qty
            delta = decision.qty if decision.action == "buy" else -decision.qty
            next_qty = signed_qty + delta
            position["qty"] = str(abs(next_qty))
            position["side"] = "short" if next_qty < 0 else "long"
            updated = True
            break
        if not updated:
            positions.append(
                {
                    "symbol": normalized_symbol,
                    "qty": str(decision.qty),
                    "side": "long" if decision.action == "buy" else "short",
                }
            )

    @staticmethod
    def _apply_simple_projected_buying_power(
        account: dict[str, str],
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
    ) -> None:
        buying_power = _optional_decimal(account.get("buying_power"))
        if buying_power is None:
            return
        notional = _simple_decision_notional(decision)
        if notional is None or notional <= 0:
            return
        consumed = _simple_buying_power_consumption(
            positions=positions,
            decision=decision,
            notional=notional,
        )
        if consumed <= 0:
            return
        account["buying_power"] = str(max(buying_power - consumed, Decimal("0")))
