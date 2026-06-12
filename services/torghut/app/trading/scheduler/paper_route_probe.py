# pyright: reportUnusedImport=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import select  # pyright: ignore[reportUnknownVariableType]
from sqlalchemy.orm import Session

from ...config import settings
from ...models import (
    Execution,
    Strategy,
    TradeDecision,
)
from ...strategies.catalog import extract_catalog_metadata
from ..models import StrategyDecision
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ..session_context import regular_session_open_utc_for
from ..simple_risk import (
    position_qty_for_symbol,
)
from .submission_preparation import SimplePipelineSubmissionPreparationMixin
from .target_plan_helpers import (
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

logger = logging.getLogger(__name__)


class SimplePipelinePaperRouteProbeMixin:
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

    @staticmethod
    def _paper_route_retry_transition(
        decision_row: TradeDecision,
        *,
        allowed_kinds: frozenset[_PaperRouteRetryKind] = _PAPER_ROUTE_RETRY_KINDS,
    ) -> _PaperRouteRetryTransition | None:
        if "quote_routeability" in allowed_kinds:
            quote_routeability_metadata = SimplePipelineSubmissionPreparationMixin._paper_route_quote_routeability_retry_metadata(
                decision_row
            )
            if quote_routeability_metadata is not None:
                return _PaperRouteRetryTransition(
                    kind="quote_routeability",
                    metadata=quote_routeability_metadata,
                )
        if "target_price" in allowed_kinds:
            target_price_metadata = SimplePipelinePaperRouteProbeMixin._paper_route_target_price_retry_metadata(
                decision_row
            )
            if target_price_metadata is not None:
                return _PaperRouteRetryTransition(
                    kind="target_price",
                    metadata=target_price_metadata,
                )
        if "bounded_probe" in allowed_kinds:
            probe_metadata = (
                SimplePipelinePaperRouteProbeMixin._paper_route_probe_retry_metadata(
                    decision_row
                )
            )
            if probe_metadata is not None:
                return _PaperRouteRetryTransition(
                    kind="bounded_probe",
                    metadata=probe_metadata,
                )
        return None

    def _reopen_rejected_paper_route_target_price_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        retry_transition = self._paper_route_retry_transition(
            decision_row,
            allowed_kinds=frozenset({"target_price"}),
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
            decision_json.get("paper_route_target_price_retry_attempts")
        )
        decision_json["submission_stage"] = "paper_route_target_price_retry_pending"
        decision_json["paper_route_target_price_retry_attempts"] = retry_attempts + 1
        decision_json["paper_route_target_price_retry"] = {
            **retry_metadata,
            "submission_stage": "paper_route_target_price_retry_pending",
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
            "Reopening paper route target source decision after transient price precheck failure strategy_id=%s decision_id=%s symbol=%s previous_reasons=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            ",".join(
                cast(list[str], retry_metadata.get("previous_risk_reasons") or [])
            ),
        )
        return decision_row

    @staticmethod
    def _restore_simulation_paper_route_probe_exit_position(
        *,
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
        metadata: Mapping[str, Any],
        price: Decimal | None,
        execution_adapter: Any | None,
        trading_mode: str | None,
    ) -> Decimal | None:
        if str(trading_mode or "").strip().lower() != "paper":
            return None
        if (
            str(getattr(execution_adapter, "name", "") or "").strip().lower()
            != "simulation"
        ):
            return None
        db_open_qty = _optional_decimal(metadata.get("db_open_qty"))
        if db_open_qty is None or db_open_qty <= 0:
            return None
        open_side = str(metadata.get("db_open_side") or "long").strip().lower()
        if open_side not in {"long", "short"}:
            open_side = "long"
        seed_missing = getattr(
            execution_adapter, "seed_missing_position_snapshot", None
        )
        if not callable(seed_missing):
            return None

        restored_qty = (
            min(db_open_qty, decision.qty) if decision.qty > 0 else db_open_qty
        )
        position: dict[str, Any] = {
            "symbol": decision.symbol,
            "qty": str(restored_qty),
            "side": open_side,
        }
        if price is not None and price > 0:
            position["market_value"] = str(restored_qty * price)
        try:
            seeded = bool(seed_missing(position))
        except Exception as exc:
            logger.warning(
                "Failed to restore simulation paper route probe exit position symbol=%s error=%s",
                decision.symbol,
                exc,
            )
            return None
        if not seeded:
            return None
        positions.append(dict(position))
        return restored_qty

    @staticmethod
    def _execution_adapter_positions(
        execution_adapter: Any | None,
    ) -> list[dict[str, Any]] | None:
        if execution_adapter is None:
            return None
        list_positions = getattr(execution_adapter, "list_positions", None)
        if not callable(list_positions):
            return None
        try:
            raw_positions = list_positions()
        except Exception as exc:
            logger.warning(
                "Failed to refresh paper route probe exit broker positions error=%s",
                exc,
            )
            return None
        if raw_positions is None or isinstance(
            raw_positions,
            (str, bytes, bytearray),
        ):
            return None
        if not isinstance(raw_positions, Sequence):
            return None
        raw_position_items = cast(Sequence[object], raw_positions)
        return [
            dict(cast(Mapping[str, Any], position))
            for position in raw_position_items
            if isinstance(position, Mapping)
        ]

    @staticmethod
    def _prepare_paper_route_probe_exit_position(
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
        *,
        execution_adapter: Any | None = None,
        trading_mode: str | None = None,
    ) -> StrategyDecision | None:
        if (
            SimplePipelinePaperRouteProbeMixin._paper_route_probe_exit_metadata(
                decision
            )
            is None
        ):
            return decision
        broker_positions = (
            SimplePipelinePaperRouteProbeMixin._execution_adapter_positions(
                execution_adapter
            )
        )
        current_qty = position_qty_for_symbol(
            broker_positions if broker_positions is not None else positions,
            decision.symbol,
        )
        params = dict(decision.params)
        metadata = dict(cast(Mapping[str, Any], params["paper_route_probe_exit"]))
        simple_lane = dict(cast(Mapping[str, Any], params.get("simple_lane") or {}))
        quantity_resolution = dict(
            cast(Mapping[str, Any], simple_lane.get("quantity_resolution") or {})
        )
        is_short_exit = decision.action == "buy"
        effective_position_qty = abs(current_qty)
        position_missing = current_qty >= 0 if is_short_exit else current_qty <= 0
        if position_missing:
            price = _optional_decimal(params.get("price"))
            restored_qty = (
                SimplePipelinePaperRouteProbeMixin._restore_simulation_paper_route_probe_exit_position(
                    positions=positions,
                    decision=decision,
                    metadata=metadata,
                    price=price,
                    execution_adapter=execution_adapter,
                    trading_mode=trading_mode,
                )
                if current_qty == 0
                else None
            )
            if restored_qty is None:
                return None
            metadata["broker_position_qty"] = str(current_qty)
            metadata["db_position_qty_fallback"] = True
            metadata["position_source"] = "source_execution_db_open_qty"
            current_qty = -restored_qty if is_short_exit else restored_qty
            effective_position_qty = restored_qty
        else:
            effective_position_qty = abs(current_qty)
            if broker_positions is not None:
                metadata["position_source"] = "execution_adapter_positions"
        if effective_position_qty < decision.qty:
            decision = decision.model_copy(update={"qty": effective_position_qty})
            metadata["qty_capped_to_position"] = True
        metadata.setdefault("broker_position_qty", str(current_qty))
        metadata["effective_position_qty"] = str(effective_position_qty)

        quantity_resolution["position_qty"] = str(decision.qty)
        simple_lane["final_qty"] = str(decision.qty)
        simple_lane["quantity_resolution"] = quantity_resolution
        price = _optional_decimal(params.get("price"))
        if price is not None and price > 0:
            simple_lane["notional"] = str(decision.qty * price)
        params["paper_route_probe_exit"] = metadata
        params["simple_lane"] = simple_lane
        return decision.model_copy(update={"params": params})

    def _process_paper_route_probe_retry_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_probe_retry_decisions(session=session)
        for decision in decisions:
            prepared_decision = self._prepare_paper_route_probe_exit_position(
                positions,
                decision,
                execution_adapter=self.execution_adapter,
                trading_mode=settings.trading_mode,
            )
            if prepared_decision is None:
                continue
            self.state.metrics.decisions_total += 1
            try:
                submitted = self._handle_decision(
                    session,
                    prepared_decision,
                    strategies,
                    account,
                    positions,
                    allowed_symbols,
                )
                if submitted is not None:
                    self._apply_simple_projected_buying_power(
                        account,
                        positions,
                        submitted,
                    )
                    self._apply_simple_projected_position(positions, submitted)
            except Exception:
                logger.exception(
                    "Paper route probe retry handling failed strategy_id=%s symbol=%s timeframe=%s",
                    prepared_decision.strategy_id,
                    prepared_decision.symbol,
                    prepared_decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["broker_submit_failed"]
                )

    def _process_paper_route_probe_retry_decisions_unless_target_reserved(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        if self._paper_route_target_plan_reserves_account(
            allowed_symbols=allowed_symbols
        ):
            logger.info(
                "Skipping generic paper-route probe retries while bounded target-plan "
                "evidence collection owns account=%s",
                self.account_label,
            )
            return
        self._process_paper_route_probe_retry_decisions(
            session=session,
            strategies=strategies,
            account=account,
            positions=positions,
            allowed_symbols=allowed_symbols,
        )

    def _process_paper_route_probe_exit_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_probe_exit_decisions(session=session)
        for decision in decisions:
            prepared_decision = self._prepare_paper_route_probe_exit_position(
                positions,
                decision,
                execution_adapter=self.execution_adapter,
                trading_mode=settings.trading_mode,
            )
            if prepared_decision is None:
                continue
            self.state.metrics.decisions_total += 1
            try:
                submitted = self._handle_decision(
                    session,
                    prepared_decision,
                    strategies,
                    account,
                    positions,
                    allowed_symbols,
                )
                if submitted is not None:
                    self._apply_simple_projected_buying_power(
                        account,
                        positions,
                        submitted,
                    )
                    self._apply_simple_projected_position(positions, submitted)
            except Exception:
                logger.exception(
                    "Paper route probe exit handling failed strategy_id=%s symbol=%s timeframe=%s",
                    prepared_decision.strategy_id,
                    prepared_decision.symbol,
                    prepared_decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["broker_submit_failed"]
                )

    @staticmethod
    def _paper_route_probe_reference_price(
        decision: StrategyDecision,
    ) -> Decimal | None:
        for value in (
            decision.limit_price,
            decision.params.get("price"),
            cast(Mapping[str, Any], decision.params.get("simple_lane") or {}).get(
                "price"
            )
            if isinstance(decision.params.get("simple_lane"), Mapping)
            else None,
            cast(Mapping[str, Any], decision.params.get("price_snapshot") or {}).get(
                "price"
            )
            if isinstance(decision.params.get("price_snapshot"), Mapping)
            else None,
        ):
            price = _optional_decimal(value)
            if price is not None and price > 0:
                return price
        return None

    @staticmethod
    def _paper_route_probe_short_increasing_sell(decision: StrategyDecision) -> bool:
        if decision.action != "sell":
            return False
        for key in ("simple_lane", "sizing"):
            section = decision.params.get(key)
            if not isinstance(section, Mapping):
                continue
            quantity_resolution = cast(Mapping[str, Any], section).get(
                "quantity_resolution"
            )
            if not isinstance(quantity_resolution, Mapping):
                continue
            resolution = cast(Mapping[str, Any], quantity_resolution)
            short_increasing = resolution.get("short_increasing")
            if isinstance(short_increasing, bool):
                return short_increasing
            if isinstance(short_increasing, str):
                normalized = short_increasing.strip().lower()
                if normalized in {"true", "1", "yes", "on"}:
                    return True
                if normalized in {"false", "0", "no", "off"}:
                    return False
            reason = str(resolution.get("reason") or "").strip().lower()
            if reason.startswith("sell_reducing_"):
                return False
            if "short_increasing" in reason:
                return True
        return True

    def _paper_route_probe_context(
        self,
        *,
        proof_floor: Mapping[str, object],
        decision: StrategyDecision,
        strategy: Strategy | None = None,
        session: Session | None = None,
        strategies: Sequence[Strategy] | None = None,
    ) -> dict[str, object] | None:
        if settings.trading_mode != "paper":
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        if (
            decision.action == "sell"
            and not settings.trading_allow_shorts
            and self._paper_route_probe_short_increasing_sell(decision)
        ):
            return None
        if decision.action not in {"buy", "sell"}:
            return None
        target_source_cap = self._paper_route_target_source_cap(decision.params)
        if target_source_cap is not None:
            cap = target_source_cap
        else:
            cap = _optional_decimal(
                settings.trading_simple_paper_route_probe_max_notional
            )
        if cap is None or cap <= 0:
            return None
        if not self._proof_floor_market_session_open(proof_floor):
            return None
        if self._paper_route_probe_entry_after_exit_minute(
            decision=decision,
            strategy=strategy,
        ):
            return None
        exit_minute = self._paper_route_probe_exit_minute_after_open(
            decision=decision,
            strategy=strategy,
        )
        effective_exit_minute: int | None = None
        exit_due_at: str | None = None
        if exit_minute is not None:
            effective_exit_minute = min(exit_minute, _REGULAR_SESSION_MINUTES - 1)
            now = self._trading_now().astimezone(timezone.utc)
            session_open = regular_session_open_utc_for(now)
            exit_due_at = (
                session_open + timedelta(minutes=effective_exit_minute)
            ).isoformat()

        blocking_reasons = {
            str(item).strip()
            for item in cast(list[object], proof_floor.get("blocking_reasons") or [])
            if str(item).strip()
        }
        symbol = decision.symbol.strip().upper()
        target_plan_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached(
                session=session,
                strategies=strategies,
            )
        )
        if target_plan_error:
            return None
        if target_plan_symbols and symbol not in target_plan_symbols:
            return None
        target_source_authorized = (
            self._paper_route_target_source_cap(decision.params) is not None
            and bool(target_plan_symbols)
            and symbol in target_plan_symbols
        )
        if target_plan_symbols and not target_source_authorized:
            return None
        symbol_route_probe_reasons = self._proof_floor_symbol_route_probe_reasons(
            proof_floor,
            symbol,
        )
        paper_route_probe_symbols = self._proof_floor_paper_route_probe_symbols(
            proof_floor
        )
        symbol_paper_route_probe_eligible = symbol in paper_route_probe_symbols
        if not (
            (blocking_reasons & _PAPER_ROUTE_PROBE_REASONS)
            or symbol_route_probe_reasons
            or symbol_paper_route_probe_eligible
            or target_source_authorized
        ):
            return None

        repair_symbols = self._proof_floor_route_repair_symbols(proof_floor)
        if (
            repair_symbols
            and symbol not in repair_symbols
            and not symbol_paper_route_probe_eligible
        ):
            return None

        source_decision_mode = ROUTE_ACQUISITION_SOURCE_DECISION_MODE
        profit_proof_eligible = False
        context_mode = "paper_route_acquisition"
        bounded_execution_policy: Mapping[str, Any] | None = None
        bounded_submit_path: str | None = None
        if target_source_authorized:
            requested_source_decision_mode = normalize_source_decision_mode(
                decision.params.get("source_decision_mode")
            )
            if (
                requested_source_decision_mode
                == BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                and _target_bool(decision.params.get("profit_proof_eligible")) is True
            ):
                source_decision_mode = (
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                )
                profit_proof_eligible = True
                context_mode = "bounded_paper_route_collection"
                raw_bounded_policy = decision.params.get(
                    "bounded_paper_route_execution_policy"
                )
                if isinstance(raw_bounded_policy, Mapping):
                    bounded_execution_policy = cast(
                        Mapping[str, Any], raw_bounded_policy
                    )
                bounded_submit_path = _safe_text(
                    decision.params.get("bounded_paper_route_submit_path")
                )

        context: dict[str, object] = {
            "enabled": True,
            "mode": context_mode,
            "source_decision_mode": source_decision_mode,
            "profit_proof_eligible": profit_proof_eligible,
            "max_notional": str(cap),
            "symbol": symbol,
            "side": decision.action,
            "blocking_reasons": sorted(blocking_reasons | symbol_route_probe_reasons),
            "target_source_authorized": target_source_authorized,
            "route_repair_symbols": sorted(repair_symbols),
            "paper_route_probe_symbols": sorted(paper_route_probe_symbols),
            "paper_route_target_plan_symbols": sorted(target_plan_symbols),
            "paper_route_target_plan_source": "external_target_plan_url"
            if target_plan_symbols
            else None,
            **_target_plan_lineage(target_plan_targets, symbol),
            "exit_minute_after_open": exit_minute,
            "effective_exit_minute_after_open": effective_exit_minute,
            "exit_due_at": exit_due_at,
            "simple_submit_enabled": settings.trading_simple_submit_enabled,
            "simple_submit_bypass_scope": "paper_route_probe_only"
            if not settings.trading_simple_submit_enabled
            else None,
        }
        if bounded_execution_policy is not None:
            context["bounded_paper_route_execution_policy"] = dict(
                bounded_execution_policy
            )
        if bounded_submit_path is not None:
            context["bounded_paper_route_submit_path"] = bounded_submit_path
        return context

    @staticmethod
    def _paper_route_probe_retry_metadata(
        decision_row: TradeDecision,
    ) -> dict[str, object] | None:
        if decision_row.status != "blocked":
            return None
        decision_json_raw = decision_row.decision_json
        if not isinstance(decision_json_raw, Mapping):
            return None
        decision_json = cast(Mapping[str, object], decision_json_raw)
        if decision_json.get("submission_stage") != "blocked_profitability_proof_floor":
            return None
        reason = str(decision_json.get("submission_block_reason") or "").strip()
        if not reason:
            return None
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        retry_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
            0,
        )
        if retry_limit <= 0 or retry_attempts >= retry_limit:
            return None
        proof_floor = decision_json.get("profitability_proof_floor")
        if not isinstance(proof_floor, Mapping):
            return None
        return {
            "previous_submission_stage": "blocked_profitability_proof_floor",
            "previous_submission_block_reason": reason,
            "previous_decision_status": "blocked",
            "previous_paper_route_probe_retry_attempts": retry_attempts,
        }

    def _paper_route_probe_capped_decision(
        self,
        *,
        decision: StrategyDecision,
        proof_floor: Mapping[str, object],
        context: Mapping[str, object],
    ) -> StrategyDecision | None:
        cap = _optional_decimal(context.get("max_notional"))
        price = self._paper_route_probe_reference_price(decision)
        if price is None or price <= 0:
            return None
        target_source_authorized = bool(context.get("target_source_authorized"))
        target_notional_sizing = _target_notional_sizing_audit_from_params(
            decision.params
        )
        if (
            target_source_authorized
            and target_notional_sizing is not None
            and decision.qty > 0
        ):
            capped_qty = decision.qty
        else:
            if cap is None or cap <= 0:
                return None
            capped_qty = (cap / price).quantize(
                _PAPER_ROUTE_PROBE_QTY_STEP,
                rounding=ROUND_DOWN,
            )
            if capped_qty <= 0:
                return None
            if decision.qty > 0 and not target_source_authorized:
                capped_qty = min(decision.qty, capped_qty)

        capped_notional = capped_qty * price
        params = dict(decision.params)
        simple_lane = dict(cast(Mapping[str, Any], params.get("simple_lane") or {}))
        simple_lane["final_qty"] = str(capped_qty)
        simple_lane["notional"] = str(capped_notional)
        simple_lane["paper_route_probe_cap_applied"] = True
        if target_source_authorized:
            simple_lane["target_source_notional_sized"] = True
        if target_notional_sizing is not None:
            simple_lane["paper_route_target_notional_sizing"] = dict(
                target_notional_sizing
            )
        params["simple_lane"] = simple_lane
        paper_route_probe = {
            **dict(context),
            "reference_price": str(price),
            "capped_qty": str(capped_qty),
            "capped_notional": str(capped_notional),
            "capital_stage": str(proof_floor.get("capital_state") or "zero_notional"),
            "target_source_notional_sized": target_source_authorized,
        }
        if target_notional_sizing is not None:
            paper_route_probe["paper_route_target_notional_sizing"] = dict(
                target_notional_sizing
            )
        params["paper_route_probe"] = paper_route_probe
        _merge_paper_route_probe_lineage(
            params,
            _paper_route_probe_lineage_from_params(params),
        )
        return decision.model_copy(update={"qty": capped_qty, "params": params})

    def _align_prechecked_paper_route_probe_cap(
        self,
        decision: StrategyDecision,
    ) -> StrategyDecision:
        metadata = _paper_route_probe_entry_metadata(decision.params)
        if metadata is None:
            return decision
        price = self._paper_route_probe_reference_price(decision)
        if price is None or price <= 0:
            return decision

        notional = decision.qty * price
        params = dict(decision.params)
        simple_lane = dict(cast(Mapping[str, Any], params.get("simple_lane") or {}))
        simple_lane["final_qty"] = str(decision.qty)
        simple_lane["notional"] = str(notional)
        simple_lane["paper_route_probe_cap_applied"] = True
        if bool(metadata.get("target_source_authorized")):
            simple_lane["target_source_notional_sized"] = True

        probe_metadata = dict(metadata)
        probe_metadata["reference_price"] = str(price)
        probe_metadata["capped_qty"] = str(decision.qty)
        probe_metadata["capped_notional"] = str(notional)

        params["simple_lane"] = simple_lane
        params["paper_route_probe"] = probe_metadata
        _merge_paper_route_probe_lineage(
            params,
            _paper_route_probe_lineage_from_params(params),
        )
        return decision.model_copy(update={"params": params})
