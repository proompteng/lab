# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import select  # pyright: ignore[reportUnknownVariableType]
from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Execution,
    Strategy,
    TradeDecision,
)
from ....strategies.catalog import extract_catalog_metadata
from ...models import StrategyDecision
from ...runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ...session_context import regular_session_open_utc_for
from ...simple_risk import (
    position_qty_for_symbol,
)
from ..submission_preparation import SimplePipelineSubmissionPreparationMixin
from ..target_plan_helpers import (
    _FLATTEN_CLOSE_DECISION_SCHEMA_VERSION,
    _PAPER_ROUTE_PROBE_EXIT_PENDING_GRACE_SECONDS,
    _PAPER_ROUTE_PROBE_QTY_STEP,
    _PAPER_ROUTE_PROBE_REASONS,
    _PAPER_ROUTE_RETRY_KINDS,
    _PaperRouteRetryKind,
    _PaperRouteRetryTransition,
    _REGULAR_SESSION_MINUTES,
    _bounded_paper_route_collection_entry_metadata,
    _merge_paper_route_probe_lineage,
    _optional_decimal,
    _paper_route_probe_entry_metadata,
    _paper_route_probe_lineage_from_params,
    _safe_int,
    _safe_text,
    _strategy_signal_paper_entry_metadata,
    _target_bool,
    _target_notional_sizing_audit_from_params,
    _target_plan_lineage,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_55 import *


class _SimplePipelinePaperRouteProbeMixinMethodsPart1:
    @staticmethod
    def _trade_decision_from_retry_row(
        decision_row: TradeDecision,
    ) -> StrategyDecision | None:
        decision_json = decision_row.decision_json
        if not isinstance(decision_json, Mapping):
            return None
        decision_payload = cast(Mapping[str, Any], decision_json)
        if (
            str(decision_payload.get("schema_version") or "").strip()
            == _FLATTEN_CLOSE_DECISION_SCHEMA_VERSION
            or str(decision_payload.get("flatten_lineage_role") or "").strip()
            == "close"
        ):
            return None
        try:
            return StrategyDecision.model_validate(decision_payload)
        except Exception:
            logger.warning(
                "Skipping paper route probe retry with invalid decision payload decision_id=%s",
                decision_row.id,
                exc_info=True,
            )
            return None

    @staticmethod
    def _paper_route_probe_exit_metadata(
        decision: StrategyDecision,
    ) -> Mapping[str, Any] | None:
        metadata = decision.params.get("paper_route_probe_exit")
        if not isinstance(metadata, Mapping):
            return None
        metadata_mapping = cast(Mapping[str, Any], metadata)
        mode = str(metadata_mapping.get("mode") or "").strip()
        if mode != "paper_route_exit":
            return None
        return metadata_mapping

    def _paper_route_probe_retry_session_open(self) -> datetime:
        now = self._trading_now().astimezone(timezone.utc)
        return regular_session_open_utc_for(now)

    @staticmethod
    def _paper_route_probe_strategy(
        *,
        session: Session,
        decision: StrategyDecision,
    ) -> Strategy | None:
        try:
            strategy_id = UUID(decision.strategy_id)
        except (TypeError, ValueError):
            return None
        return session.get(Strategy, strategy_id)

    @staticmethod
    def _paper_route_probe_exit_minute_value(raw_value: object) -> int | None:
        if raw_value is None:
            return None
        if isinstance(raw_value, str):
            text = raw_value.strip().lower()
            if not text:
                return None
            if text == "close":
                return _REGULAR_SESSION_MINUTES
            try:
                return max(0, int(Decimal(text)))
            except Exception:
                return None
        try:
            return max(0, int(cast(Any, raw_value)))
        except (TypeError, ValueError, ArithmeticError):
            return None

    @staticmethod
    def _paper_route_probe_exit_minute_after_open(
        *,
        decision: StrategyDecision,
        strategy: Strategy | None = None,
    ) -> int | None:
        direct_exit_minute = (
            SimplePipelinePaperRouteProbeMixin._paper_route_probe_exit_minute_value(
                decision.params.get("exit_minute_after_open")
            )
        )
        if direct_exit_minute is not None:
            return direct_exit_minute
        probe_metadata = decision.params.get("paper_route_probe")
        if isinstance(probe_metadata, Mapping):
            probe_mapping = cast(Mapping[str, object], probe_metadata)
            for key in (
                "exit_minute_after_open",
                "effective_exit_minute_after_open",
            ):
                metadata_exit_minute = SimplePipelinePaperRouteProbeMixin._paper_route_probe_exit_minute_value(
                    probe_mapping.get(key)
                )
                if metadata_exit_minute is not None:
                    return metadata_exit_minute
        for params_key in (
            "paper_route_target_plan_source_decision",
            "paper_route_target_plan",
            "strategy_signal_paper",
        ):
            target_metadata = decision.params.get(params_key)
            if not isinstance(target_metadata, Mapping):
                continue
            target_mapping = cast(Mapping[str, object], target_metadata)
            for key in (
                "exit_minute_after_open",
                "effective_exit_minute_after_open",
            ):
                metadata_exit_minute = SimplePipelinePaperRouteProbeMixin._paper_route_probe_exit_minute_value(
                    target_mapping.get(key)
                )
                if metadata_exit_minute is not None:
                    return metadata_exit_minute
        if strategy is None:
            return None
        metadata = extract_catalog_metadata(strategy.description)
        metadata_params = metadata.get("params")
        if not isinstance(metadata_params, Mapping):
            return None
        params = cast(Mapping[str, object], metadata_params)
        return SimplePipelinePaperRouteProbeMixin._paper_route_probe_exit_minute_value(
            params.get("exit_minute_after_open")
        )

    @staticmethod
    def _paper_route_probe_session_open(value: datetime) -> datetime:
        ts = (
            value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        ).astimezone(timezone.utc)
        return regular_session_open_utc_for(ts)

    @staticmethod
    def _paper_route_probe_exit_session_open(
        *,
        decision: StrategyDecision,
        fallback: datetime,
    ) -> datetime:
        metadata = SimplePipelinePaperRouteProbeMixin._paper_route_probe_exit_metadata(
            decision
        )
        if metadata is not None:
            raw_session_open = metadata.get("session_open")
            if isinstance(raw_session_open, datetime):
                return (
                    SimplePipelinePaperRouteProbeMixin._paper_route_probe_session_open(
                        raw_session_open
                    )
                )
            raw_text = str(raw_session_open or "").strip()
            if raw_text:
                try:
                    parsed = datetime.fromisoformat(raw_text.replace("Z", "+00:00"))
                    return SimplePipelinePaperRouteProbeMixin._paper_route_probe_session_open(
                        parsed
                    )
                except ValueError:
                    pass
        return SimplePipelinePaperRouteProbeMixin._paper_route_probe_session_open(
            fallback
        )

    def _paper_route_probe_entry_after_exit_minute(
        self,
        *,
        decision: StrategyDecision,
        strategy: Strategy | None = None,
    ) -> bool:
        if decision.action not in {"buy", "sell"}:
            return False
        exit_minute = self._paper_route_probe_exit_minute_after_open(
            decision=decision,
            strategy=strategy,
        )
        if exit_minute is None:
            return False
        now = self._trading_now().astimezone(timezone.utc)
        session_open = regular_session_open_utc_for(now)
        minutes_elapsed = int((now - session_open).total_seconds() // 60)
        return minutes_elapsed >= exit_minute

    def _created_in_current_regular_session(
        self,
        decision_row: TradeDecision,
        decision: StrategyDecision,
        *,
        session_open: datetime,
    ) -> bool:
        for raw_ts in (decision.event_ts, decision_row.created_at):
            ts = (
                raw_ts
                if raw_ts.tzinfo is not None
                else raw_ts.replace(tzinfo=timezone.utc)
            )
            if ts.astimezone(timezone.utc) >= session_open:
                return True
        return False

    def _paper_route_probe_retry_decisions(
        self,
        *,
        session: Session,
    ) -> list[StrategyDecision]:
        if not settings.trading_simple_paper_route_probe_enabled:
            return []
        batch_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_batch_limit),
            0,
        )
        scan_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_scan_limit),
            0,
        )
        if batch_limit <= 0 or scan_limit <= 0:
            return []

        session_open = self._paper_route_probe_retry_session_open()
        rows = (
            session.execute(
                select(TradeDecision)
                .where(
                    TradeDecision.status.in_(("blocked", "rejected")),
                    TradeDecision.alpaca_account_label == self.account_label,
                )
                .order_by(TradeDecision.created_at.desc())
                .limit(scan_limit)
            )
            .scalars()
            .all()
        )
        decisions: list[StrategyDecision] = []
        for decision_row in rows:
            if len(decisions) >= batch_limit:
                break
            if self._paper_route_retry_transition(decision_row) is None:
                continue
            if self.executor.execution_exists(session, decision_row):
                continue
            decision = self._trade_decision_from_retry_row(decision_row)
            if decision is None:
                continue
            if not self._created_in_current_regular_session(
                decision_row,
                decision,
                session_open=session_open,
            ):
                continue
            strategy = self._paper_route_probe_strategy(
                session=session,
                decision=decision,
            )
            if self._paper_route_probe_entry_after_exit_minute(
                decision=decision,
                strategy=strategy,
            ):
                logger.warning(
                    "Skipping stale paper route probe entry retry after strategy exit minute strategy_id=%s symbol=%s",
                    decision.strategy_id,
                    decision.symbol,
                )
                continue
            decisions.append(decision)
        return decisions

    def _paper_route_probe_exit_decisions(
        self,
        *,
        session: Session,
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

        session_open = regular_session_open_utc_for(now)
        exit_lookback_hours = max(
            0,
            _safe_int(settings.trading_simple_paper_route_probe_exit_lookback_hours),
        )
        lookback_start = (
            now - timedelta(hours=exit_lookback_hours)
            if exit_lookback_hours > 0
            else session_open
        )
        rows = session.execute(
            select(Execution, TradeDecision)
            .join(TradeDecision, Execution.trade_decision_id == TradeDecision.id)
            .where(
                Execution.alpaca_account_label == self.account_label,
                TradeDecision.alpaca_account_label == self.account_label,
                Execution.status == "filled",
                Execution.filled_qty > Decimal("0"),
                Execution.created_at >= lookback_start,
            )
            .order_by(Execution.created_at.asc())
        ).all()
        exposures: dict[tuple[str, str, str], dict[str, Any]] = {}
        for execution, decision_row in rows:
            decision = self._trade_decision_from_retry_row(decision_row)
            if decision is None:
                continue
            decision_json = decision_row.decision_json
            if not isinstance(decision_json, Mapping):
                continue
            params = decision.params
            probe_entry_metadata = _paper_route_probe_entry_metadata(params)
            bounded_collection_entry_metadata = (
                _bounded_paper_route_collection_entry_metadata(params)
            )
            strategy_signal_entry_metadata = _strategy_signal_paper_entry_metadata(
                params
            )
            is_entry = (
                probe_entry_metadata is not None
                or bounded_collection_entry_metadata is not None
                or strategy_signal_entry_metadata is not None
            )
            is_exit = isinstance(params.get("paper_route_probe_exit"), Mapping)
            if not is_entry and not is_exit:
                continue
            side = str(execution.side or "").strip().lower()
            if side not in {"buy", "sell"}:
                continue
            filled_qty = _optional_decimal(execution.filled_qty)
            if filled_qty is None or filled_qty <= 0:
                continue
            strategy = session.get(Strategy, decision_row.strategy_id)
            if strategy is None:
                continue
            symbol = str(execution.symbol or decision_row.symbol or "").strip().upper()
            if not symbol:
                continue

            entry_session_open = (
                self._paper_route_probe_session_open(decision.event_ts)
                if is_entry
                else self._paper_route_probe_exit_session_open(
                    decision=decision,
                    fallback=decision.event_ts,
                )
            )
            key = (str(strategy.id), symbol, entry_session_open.isoformat())
            exposure = exposures.setdefault(
                key,
                {
                    "strategy": strategy,
                    "symbol": symbol,
                    "timeframe": decision.timeframe,
                    "session_open": entry_session_open,
                    "net_qty": Decimal("0"),
                    "buy_qty": Decimal("0"),
                    "buy_notional": Decimal("0"),
                    "sell_qty": Decimal("0"),
                    "sell_notional": Decimal("0"),
                    "latest_entry_at": None,
                    "exit_minute_after_open": None,
                    "exit_source": None,
                    "paper_route_probe_lineage": {},
                },
            )
            if strategy_signal_entry_metadata is not None:
                exposure["exit_source"] = "filled_strategy_signal_paper_executions"
            elif bounded_collection_entry_metadata is not None:
                exposure["exit_source"] = (
                    "filled_bounded_paper_route_collection_executions"
                )
            elif (
                probe_entry_metadata is not None and exposure.get("exit_source") is None
            ):
                exposure["exit_source"] = "filled_paper_route_probe_executions"
            lineage = _paper_route_probe_lineage_from_params(params)
            if lineage:
                exposure_lineage = cast(
                    dict[str, Any], exposure["paper_route_probe_lineage"]
                )
                _merge_paper_route_probe_lineage(exposure_lineage, lineage)
            signed_qty = filled_qty if side == "buy" else -filled_qty
            exposure["net_qty"] = cast(Decimal, exposure["net_qty"]) + signed_qty
            if side == "buy":
                exit_minute = self._paper_route_probe_exit_minute_after_open(
                    decision=decision,
                    strategy=strategy,
                )
                if exit_minute is not None:
                    exposure["exit_minute_after_open"] = exit_minute
                avg_fill_price = _optional_decimal(execution.avg_fill_price)
                if avg_fill_price is not None and avg_fill_price > 0:
                    exposure["buy_qty"] = (
                        cast(Decimal, exposure["buy_qty"]) + filled_qty
                    )
                    exposure["buy_notional"] = cast(
                        Decimal,
                        exposure["buy_notional"],
                    ) + (filled_qty * avg_fill_price)
            elif side == "sell":
                exit_minute = self._paper_route_probe_exit_minute_after_open(
                    decision=decision,
                    strategy=strategy,
                )
                if exit_minute is not None:
                    exposure["exit_minute_after_open"] = exit_minute
                avg_fill_price = _optional_decimal(execution.avg_fill_price)
                if avg_fill_price is not None and avg_fill_price > 0:
                    exposure["sell_qty"] = (
                        cast(Decimal, exposure["sell_qty"]) + filled_qty
                    )
                    exposure["sell_notional"] = cast(
                        Decimal,
                        exposure["sell_notional"],
                    ) + (filled_qty * avg_fill_price)
            latest_entry_at = exposure.get("latest_entry_at")
            execution_created_at = (
                execution.created_at
                if execution.created_at.tzinfo is not None
                else execution.created_at.replace(tzinfo=timezone.utc)
            ).astimezone(timezone.utc)
            if not isinstance(latest_entry_at, datetime) or (
                execution_created_at > latest_entry_at
            ):
                exposure["latest_entry_at"] = execution_created_at

        decisions: list[StrategyDecision] = []
        for exposure in exposures.values():
            net_qty = cast(Decimal, exposure["net_qty"])
            if net_qty == 0:
                continue
            raw_exit_minute = exposure.get("exit_minute_after_open")
            exit_minute = raw_exit_minute if isinstance(raw_exit_minute, int) else None
            if exit_minute is None:
                continue
            effective_exit_minute = min(exit_minute, _REGULAR_SESSION_MINUTES - 1)
            entry_session_open = cast(datetime, exposure["session_open"])
            exit_due_at = entry_session_open + timedelta(minutes=effective_exit_minute)
            if now < exit_due_at:
                continue
            strategy = cast(Strategy, exposure["strategy"])
            symbol = str(exposure["symbol"])
            if self._paper_route_probe_exit_already_recorded(
                session=session,
                strategy=strategy,
                symbol=symbol,
                session_open=entry_session_open,
                exit_due_at=exit_due_at,
            ):
                continue
            buy_qty = cast(Decimal, exposure["buy_qty"])
            buy_notional = cast(Decimal, exposure["buy_notional"])
            sell_qty = cast(Decimal, exposure["sell_qty"])
            sell_notional = cast(Decimal, exposure["sell_notional"])
            exit_action: Literal["buy", "sell"] = "sell" if net_qty > 0 else "buy"
            exit_qty = abs(net_qty)
            avg_entry_price = None
            if net_qty > 0 and buy_qty > 0:
                avg_entry_price = buy_notional / buy_qty
            elif net_qty < 0 and sell_qty > 0:
                avg_entry_price = sell_notional / sell_qty
            exit_source = (
                _safe_text(exposure.get("exit_source"))
                or "filled_paper_route_probe_executions"
            )
            params: dict[str, Any] = {
                "paper_route_probe_exit": {
                    "mode": "paper_route_exit",
                    "source": exit_source,
                    "symbol": symbol,
                    "strategy_id": str(strategy.id),
                    "db_open_qty": str(exit_qty),
                    "db_open_signed_qty": str(net_qty),
                    "db_open_side": "long" if net_qty > 0 else "short",
                    "exit_minute_after_open": exit_minute,
                    "effective_exit_minute_after_open": effective_exit_minute,
                    "exit_due_at": exit_due_at.isoformat(),
                    "session_open": entry_session_open.isoformat(),
                    "stale_exit_repair": entry_session_open.date() < now.date(),
                    "latest_entry_at": exposure["latest_entry_at"].isoformat()
                    if isinstance(exposure.get("latest_entry_at"), datetime)
                    else None,
                    "avg_entry_price": str(avg_entry_price)
                    if avg_entry_price is not None
                    else None,
                    **cast(
                        dict[str, Any], exposure.get("paper_route_probe_lineage") or {}
                    ),
                },
                "simple_lane": {
                    "final_qty": str(exit_qty),
                    "notional": str(exit_qty * avg_entry_price)
                    if avg_entry_price is not None
                    else None,
                    "quantity_resolution": {
                        "reason": (
                            "sell_reducing_paper_route_probe_exit"
                            if exit_action == "sell"
                            else "buy_reducing_paper_route_probe_short_exit"
                        ),
                        "short_increasing": False,
                        "position_qty": str(net_qty),
                    },
                },
            }
            exit_lineage = cast(
                Mapping[str, Any], exposure.get("paper_route_probe_lineage") or {}
            )
            for key in ("source_decision_mode", "profit_proof_eligible"):
                if key in exit_lineage:
                    params[key] = exit_lineage[key]
            if avg_entry_price is not None:
                params["price"] = avg_entry_price
            exit_event_ts = now if now > exit_due_at else exit_due_at
            if exit_event_ts != exit_due_at:
                params["paper_route_probe_exit"]["retry_event_ts"] = (
                    exit_event_ts.isoformat()
                )
            decisions.append(
                StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol=symbol,
                    event_ts=exit_event_ts,
                    timeframe=str(exposure["timeframe"] or strategy.base_timeframe),
                    action=exit_action,
                    qty=exit_qty,
                    rationale="paper-route-probe-exit",
                    params=params,
                )
            )
        return decisions

    def _paper_route_probe_exit_already_recorded(
        self,
        *,
        session: Session,
        strategy: Strategy,
        symbol: str,
        session_open: datetime,
        exit_due_at: datetime,
    ) -> bool:
        rows = (
            session.execute(
                select(TradeDecision)
                .where(
                    TradeDecision.strategy_id == strategy.id,
                    TradeDecision.alpaca_account_label == self.account_label,
                    TradeDecision.symbol == symbol,
                    TradeDecision.created_at >= session_open,
                )
                .order_by(TradeDecision.created_at.desc())
            )
            .scalars()
            .all()
        )
        exit_due_at_text = exit_due_at.isoformat()
        for row in rows:
            decision = self._trade_decision_from_retry_row(row)
            if decision is None:
                continue
            metadata = self._paper_route_probe_exit_metadata(decision)
            if metadata is None:
                continue
            if str(metadata.get("exit_due_at") or "") != exit_due_at_text:
                continue
            linked_executions = (
                session.execute(
                    select(Execution)
                    .where(Execution.trade_decision_id == row.id)
                    .order_by(Execution.created_at.desc())
                )
                .scalars()
                .all()
            )
            filled_execution_recorded = any(
                _safe_text(execution.status) == "filled"
                or (_optional_decimal(execution.filled_qty) or Decimal("0"))
                > Decimal("0")
                for execution in linked_executions
            )
            if row.status in {"filled", "executed"} or filled_execution_recorded:
                return True
            if row.status in {"planned", "submitted"}:
                created_at = (
                    row.created_at
                    if row.created_at.tzinfo is not None
                    else row.created_at.replace(tzinfo=timezone.utc)
                ).astimezone(timezone.utc)
                now = self._trading_now().astimezone(timezone.utc)
                if (
                    now - created_at
                ).total_seconds() < _PAPER_ROUTE_PROBE_EXIT_PENDING_GRACE_SECONDS:
                    return True
                continue
            if row.status == "rejected":
                continue
        return False

    def _reopen_rejected_paper_route_probe_exit_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        if decision_row.status != "rejected":
            return None
        exit_metadata = self._paper_route_probe_exit_metadata(decision)
        if exit_metadata is None:
            return None
        if self.executor.execution_exists(session, decision_row):
            return None
        retry_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
            0,
        )
        raw_decision_json: object = decision_row.decision_json
        decision_json: dict[str, Any] = (
            dict(cast(Mapping[str, Any], raw_decision_json))
            if isinstance(raw_decision_json, Mapping)
            else {}
        )
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_exit_retry_attempts")
        )
        if retry_limit > 0 and retry_attempts >= retry_limit:
            return None
        previous_stage = str(decision_json.get("submission_stage") or "rejected")
        raw_previous_risk_reasons = decision_json.get("risk_reasons")
        previous_risk_reason_items: Sequence[object] = []
        if isinstance(raw_previous_risk_reasons, Sequence) and not isinstance(
            raw_previous_risk_reasons,
            (str, bytes, bytearray),
        ):
            previous_risk_reason_items = cast(
                Sequence[object], raw_previous_risk_reasons
            )
        previous_risk_reasons = [
            str(item) for item in previous_risk_reason_items if str(item).strip()
        ]
        self.executor.sync_decision_state(session, decision_row, decision)
        raw_decision_json = decision_row.decision_json
        decision_json = (
            dict(cast(Mapping[str, Any], raw_decision_json))
            if isinstance(raw_decision_json, Mapping)
            else {}
        )
        decision_json["submission_stage"] = "paper_route_probe_exit_retry_pending"
        decision_json["paper_route_probe_exit_retry_attempts"] = retry_attempts + 1
        decision_json["paper_route_probe_exit_retry"] = {
            "previous_decision_status": "rejected",
            "previous_submission_stage": previous_stage,
            "previous_risk_reasons": previous_risk_reasons,
            "submission_stage": "paper_route_probe_exit_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
            "exit_due_at": str(exit_metadata.get("exit_due_at") or ""),
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
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening rejected paper route probe exit strategy_id=%s decision_id=%s symbol=%s previous_stage=%s reasons=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            previous_stage,
            ",".join(previous_risk_reasons),
        )
        return decision_row

    @staticmethod
    def _paper_route_target_price_retry_metadata(
        decision_row: TradeDecision,
    ) -> dict[str, object] | None:
        if decision_row.status != "rejected":
            return None
        decision_json_raw = decision_row.decision_json
        if not isinstance(decision_json_raw, Mapping):
            return None
        decision_json = cast(Mapping[str, object], decision_json_raw)
        if decision_json.get("submission_stage") != "rejected_pre_submit":
            return None
        params_raw = decision_json.get("params")
        if not isinstance(params_raw, Mapping):
            return None
        params = cast(Mapping[str, object], params_raw)
        if not isinstance(params.get("paper_route_target_plan"), Mapping):
            return None
        precheck_raw = params.get("simple_lane_precheck")
        if not isinstance(precheck_raw, Mapping):
            return None
        precheck = cast(Mapping[str, object], precheck_raw)
        if precheck.get("price") is not None:
            return None
        raw_risk_reasons = decision_json.get("risk_reasons")
        risk_reason_items: Sequence[object] = []
        if isinstance(raw_risk_reasons, Sequence) and not isinstance(
            raw_risk_reasons,
            (str, bytes, bytearray),
        ):
            risk_reason_items = cast(Sequence[object], raw_risk_reasons)
        risk_reasons = [
            str(item).strip() for item in risk_reason_items if str(item).strip()
        ]
        if "broker_precheck_failed" not in risk_reasons:
            return None
        retry_attempts = _safe_int(
            decision_json.get("paper_route_target_price_retry_attempts")
        )
        retry_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
            0,
        )
        if retry_limit <= 0 or retry_attempts >= retry_limit:
            return None
        return {
            "previous_decision_status": "rejected",
            "previous_submission_stage": "rejected_pre_submit",
            "previous_risk_reasons": risk_reasons,
            "previous_retry_attempts": retry_attempts,
        }


__all__ = [name for name in globals() if not name.startswith("__")]
