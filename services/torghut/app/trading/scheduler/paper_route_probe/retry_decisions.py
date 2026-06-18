from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Execution,
    Strategy,
    TradeDecision,
)
from ....strategies.catalog import extract_catalog_metadata
from ...models import StrategyDecision
from ...session_context import regular_session_open_utc_for
from ..target_plan_helpers import (
    FLATTEN_CLOSE_DECISION_SCHEMA_VERSION as _FLATTEN_CLOSE_DECISION_SCHEMA_VERSION,
    PAPER_ROUTE_PROBE_EXIT_PENDING_GRACE_SECONDS as _PAPER_ROUTE_PROBE_EXIT_PENDING_GRACE_SECONDS,
    REGULAR_SESSION_MINUTES as _REGULAR_SESSION_MINUTES,
    bounded_paper_route_collection_entry_metadata as _bounded_paper_route_collection_entry_metadata,
    merge_paper_route_probe_lineage as _merge_paper_route_probe_lineage,
    optional_decimal as _optional_decimal,
    paper_route_probe_entry_metadata as _paper_route_probe_entry_metadata,
    paper_route_probe_lineage_from_params as _paper_route_probe_lineage_from_params,
    safe_int as _safe_int,
    safe_text as _safe_text,
    strategy_signal_paper_entry_metadata as _strategy_signal_paper_entry_metadata,
)

from .probe_types import (
    PaperRouteProbeExitPlan,
    PaperRouteProbeExitRecordLookup,
    PaperRouteProbeExposure,
    PaperRouteProbeFilledExecution,
)

if TYPE_CHECKING:
    from .probe_types import PaperRouteProbeRuntime
else:

    class PaperRouteProbeRuntime:
        pass


logger = logging.getLogger(__name__)


def paper_route_probe_exit_metadata(
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


def paper_route_target_price_retry_metadata(
    decision_row: TradeDecision,
) -> dict[str, object] | None:
    payload = _paper_route_target_price_retry_payload(decision_row)
    if payload is None:
        return None
    decision_json, risk_reasons = payload
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


def _paper_route_target_price_retry_payload(
    decision_row: TradeDecision,
) -> tuple[Mapping[str, object], list[str]] | None:
    decision_json = _rejected_pre_submit_decision_json(decision_row)
    if decision_json is None:
        return None
    risk_reasons = _paper_route_target_price_retry_risk_reasons(decision_json)
    if risk_reasons is None:
        return None
    return decision_json, risk_reasons


def _rejected_pre_submit_decision_json(
    decision_row: TradeDecision,
) -> Mapping[str, object] | None:
    if decision_row.status != "rejected":
        return None
    decision_json_raw = decision_row.decision_json
    if not isinstance(decision_json_raw, Mapping):
        return None
    decision_json = cast(Mapping[str, object], decision_json_raw)
    if decision_json.get("submission_stage") != "rejected_pre_submit":
        return None
    return decision_json


def _mapping_child(
    payload: Mapping[str, object],
    key: str,
) -> Mapping[str, object] | None:
    child = payload.get(key)
    return cast(Mapping[str, object], child) if isinstance(child, Mapping) else None


def _paper_route_target_price_retry_risk_reasons(
    decision_json: Mapping[str, object],
) -> list[str] | None:
    params = _mapping_child(decision_json, "params")
    if params is None or not isinstance(params.get("paper_route_target_plan"), Mapping):
        return None
    precheck = _mapping_child(params, "simple_lane_precheck")
    if precheck is None or precheck.get("price") is not None:
        return None
    risk_reasons = _risk_reason_items(decision_json.get("risk_reasons"))
    if "broker_precheck_failed" not in risk_reasons:
        return None
    return risk_reasons


def _risk_reason_items(raw_risk_reasons: object) -> list[str]:
    risk_reason_items: Sequence[object] = []
    if isinstance(raw_risk_reasons, Sequence) and not isinstance(
        raw_risk_reasons,
        (str, bytes, bytearray),
    ):
        risk_reason_items = cast(Sequence[object], raw_risk_reasons)
    return [str(item).strip() for item in risk_reason_items if str(item).strip()]


def _paper_route_probe_exit_source(params: Mapping[str, Any]) -> str | None:
    if _strategy_signal_paper_entry_metadata(params) is not None:
        return "filled_strategy_signal_paper_executions"
    if _bounded_paper_route_collection_entry_metadata(params) is not None:
        return "filled_bounded_paper_route_collection_executions"
    if _paper_route_probe_entry_metadata(params) is not None:
        return "filled_paper_route_probe_executions"
    return None


def _paper_route_probe_exit_lookback_start(
    *,
    now: datetime,
    session_open: datetime,
) -> datetime:
    exit_lookback_hours = max(
        0,
        _safe_int(settings.trading_simple_paper_route_probe_exit_lookback_hours),
    )
    if exit_lookback_hours <= 0:
        return session_open
    return now - timedelta(hours=exit_lookback_hours)


def _paper_route_probe_exit_params(
    *,
    exposure: PaperRouteProbeExposure,
    plan: PaperRouteProbeExitPlan,
    now: datetime,
) -> dict[str, Any]:
    avg_entry_price = exposure.avg_entry_price
    exit_metadata: dict[str, Any] = {
        "mode": "paper_route_exit",
        "source": exposure.exit_source or "filled_paper_route_probe_executions",
        "symbol": exposure.symbol,
        "strategy_id": str(exposure.strategy.id),
        "db_open_qty": str(exposure.exit_qty),
        "db_open_signed_qty": str(exposure.net_qty),
        "db_open_side": "long" if exposure.net_qty > 0 else "short",
        "exit_minute_after_open": plan.exit_minute,
        "effective_exit_minute_after_open": plan.effective_exit_minute,
        "exit_due_at": plan.exit_due_at.isoformat(),
        "session_open": exposure.session_open.isoformat(),
        "stale_exit_repair": exposure.session_open.date() < now.date(),
        "latest_entry_at": exposure.latest_entry_at.isoformat()
        if exposure.latest_entry_at is not None
        else None,
        "avg_entry_price": str(avg_entry_price)
        if avg_entry_price is not None
        else None,
        **exposure.lineage,
    }
    params: dict[str, Any] = {
        "paper_route_probe_exit": exit_metadata,
        "simple_lane": _paper_route_probe_exit_simple_lane(
            exposure=exposure,
            avg_entry_price=avg_entry_price,
        ),
    }
    for key in ("source_decision_mode", "profit_proof_eligible"):
        if key in exposure.lineage:
            params[key] = exposure.lineage[key]
    if avg_entry_price is not None:
        params["price"] = avg_entry_price
    if plan.exit_event_ts != plan.exit_due_at:
        exit_metadata["retry_event_ts"] = plan.exit_event_ts.isoformat()
    return params


def _paper_route_probe_exit_simple_lane(
    *,
    exposure: PaperRouteProbeExposure,
    avg_entry_price: Decimal | None,
) -> dict[str, Any]:
    return {
        "final_qty": str(exposure.exit_qty),
        "notional": str(exposure.exit_qty * avg_entry_price)
        if avg_entry_price is not None
        else None,
        "quantity_resolution": {
            "reason": (
                "sell_reducing_paper_route_probe_exit"
                if exposure.exit_action == "sell"
                else "buy_reducing_paper_route_probe_short_exit"
            ),
            "short_increasing": False,
            "position_qty": str(exposure.net_qty),
        },
    }


def _paper_route_probe_execution_side(
    execution: Execution,
) -> Literal["buy", "sell"] | None:
    side = str(execution.side or "").strip().lower()
    return cast(Literal["buy", "sell"], side) if side in {"buy", "sell"} else None


def _paper_route_probe_execution_created_at(execution: Execution) -> datetime:
    created_at = execution.created_at
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    return created_at.astimezone(timezone.utc)


def _paper_route_probe_exit_minute_value(raw_value: object) -> int | None:
    parsed_value = _paper_route_probe_exit_minute_raw_value(raw_value)
    return max(0, parsed_value) if parsed_value is not None else None


def _paper_route_probe_exit_minute_raw_value(raw_value: object) -> int | None:
    if raw_value is None:
        return None
    if isinstance(raw_value, str):
        return _paper_route_probe_exit_minute_text(raw_value)
    try:
        return int(cast(Any, raw_value))
    except (TypeError, ValueError, ArithmeticError):
        return None


def _paper_route_probe_exit_minute_text(raw_value: str) -> int | None:
    text = raw_value.strip().lower()
    if not text:
        return None
    if text == "close":
        return _REGULAR_SESSION_MINUTES
    try:
        return int(Decimal(text))
    except Exception:
        return None


class SimplePipelinePaperRouteProbeRetryDecisionMixin(PaperRouteProbeRuntime):
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
        return paper_route_probe_exit_metadata(decision)

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
        return _paper_route_probe_exit_minute_value(raw_value)

    @staticmethod
    def _paper_route_probe_exit_minute_after_open(
        *,
        decision: StrategyDecision,
        strategy: Strategy | None = None,
    ) -> int | None:
        direct_exit_minute = SimplePipelinePaperRouteProbeRetryDecisionMixin._paper_route_probe_exit_minute_value(
            decision.params.get("exit_minute_after_open")
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
                metadata_exit_minute = SimplePipelinePaperRouteProbeRetryDecisionMixin._paper_route_probe_exit_minute_value(
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
                metadata_exit_minute = SimplePipelinePaperRouteProbeRetryDecisionMixin._paper_route_probe_exit_minute_value(
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
        return SimplePipelinePaperRouteProbeRetryDecisionMixin._paper_route_probe_exit_minute_value(
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
        metadata = SimplePipelinePaperRouteProbeRetryDecisionMixin._paper_route_probe_exit_metadata(
            decision
        )
        if metadata is not None:
            raw_session_open = metadata.get("session_open")
            if isinstance(raw_session_open, datetime):
                return SimplePipelinePaperRouteProbeRetryDecisionMixin._paper_route_probe_session_open(
                    raw_session_open
                )
            raw_text = str(raw_session_open or "").strip()
            if raw_text:
                try:
                    parsed = datetime.fromisoformat(raw_text.replace("Z", "+00:00"))
                    return SimplePipelinePaperRouteProbeRetryDecisionMixin._paper_route_probe_session_open(
                        parsed
                    )
                except ValueError:
                    pass
        return SimplePipelinePaperRouteProbeRetryDecisionMixin._paper_route_probe_session_open(
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
        now = self._trading_now().astimezone(timezone.utc)
        if not self._paper_route_probe_exit_scan_ready(now):
            return []
        exposures = self._paper_route_probe_exit_exposures(session=session, now=now)
        decisions: list[StrategyDecision] = []
        for exposure in exposures.values():
            decision = self._paper_route_probe_exit_decision_from_exposure(
                session=session,
                exposure=exposure,
                now=now,
            )
            if decision is not None:
                decisions.append(decision)
        return decisions

    def _paper_route_probe_exit_scan_ready(self, now: datetime) -> bool:
        if settings.trading_mode != "paper":
            return False
        if not settings.trading_simple_paper_route_probe_enabled:
            return False
        if self._is_market_session_open(now):
            return True
        self._record_bounded_target_plan_blocker(
            reason="paper_route_session_window_not_open"
        )
        return False

    def _paper_route_probe_exit_exposures(
        self,
        *,
        session: Session,
        now: datetime,
    ) -> dict[tuple[str, str, str], PaperRouteProbeExposure]:
        session_open = regular_session_open_utc_for(now)
        lookback_start = _paper_route_probe_exit_lookback_start(
            now=now,
            session_open=session_open,
        )
        exposures: dict[tuple[str, str, str], PaperRouteProbeExposure] = {}
        for execution, decision_row in self._paper_route_probe_filled_execution_rows(
            session=session,
            lookback_start=lookback_start,
        ):
            fill = self._paper_route_probe_filled_execution(
                session=session,
                execution=execution,
                decision_row=decision_row,
            )
            if fill is None:
                continue
            exposure = exposures.setdefault(
                fill.exposure_key,
                PaperRouteProbeExposure(
                    strategy=fill.strategy,
                    symbol=fill.symbol,
                    timeframe=fill.timeframe,
                    session_open=fill.session_open,
                ),
            )
            exposure.record_fill(fill)
            _merge_paper_route_probe_lineage(exposure.lineage, fill.lineage)
        return exposures

    def _paper_route_probe_filled_execution_rows(
        self,
        *,
        session: Session,
        lookback_start: datetime,
    ) -> Sequence[tuple[Execution, TradeDecision]]:
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
        return cast(Sequence[tuple[Execution, TradeDecision]], rows)

    def _paper_route_probe_filled_execution(
        self,
        *,
        session: Session,
        execution: Execution,
        decision_row: TradeDecision,
    ) -> PaperRouteProbeFilledExecution | None:
        decision = self._trade_decision_from_retry_row(decision_row)
        if decision is None:
            return None
        params = decision.params
        exit_source = _paper_route_probe_exit_source(params)
        is_exit = paper_route_probe_exit_metadata(decision) is not None
        if exit_source is None and not is_exit:
            return None
        side = _paper_route_probe_execution_side(execution)
        filled_qty = _optional_decimal(execution.filled_qty)
        strategy = session.get(Strategy, decision_row.strategy_id)
        symbol = str(execution.symbol or decision_row.symbol or "").strip().upper()
        if side is None or filled_qty is None or filled_qty <= 0:
            return None
        if strategy is None or not symbol:
            return None
        session_open = self._paper_route_probe_filled_execution_session_open(
            decision=decision,
            is_entry=exit_source is not None,
        )
        execution_created_at = _paper_route_probe_execution_created_at(execution)
        return PaperRouteProbeFilledExecution(
            strategy=strategy,
            symbol=symbol,
            timeframe=decision.timeframe,
            session_open=session_open,
            side=side,
            filled_qty=filled_qty,
            avg_fill_price=_optional_decimal(execution.avg_fill_price),
            exit_minute_after_open=self._paper_route_probe_exit_minute_after_open(
                decision=decision,
                strategy=strategy,
            ),
            exit_source=exit_source,
            lineage=_paper_route_probe_lineage_from_params(params),
            execution_created_at=execution_created_at,
        )

    def _paper_route_probe_filled_execution_session_open(
        self,
        *,
        decision: StrategyDecision,
        is_entry: bool,
    ) -> datetime:
        if is_entry:
            return self._paper_route_probe_session_open(decision.event_ts)
        return self._paper_route_probe_exit_session_open(
            decision=decision,
            fallback=decision.event_ts,
        )

    def _paper_route_probe_exit_decision_from_exposure(
        self,
        *,
        session: Session,
        exposure: PaperRouteProbeExposure,
        now: datetime,
    ) -> StrategyDecision | None:
        plan = self._paper_route_probe_exit_plan(
            session=session,
            exposure=exposure,
            now=now,
        )
        if plan is None:
            return None
        return StrategyDecision(
            strategy_id=str(exposure.strategy.id),
            symbol=exposure.symbol,
            event_ts=plan.exit_event_ts,
            timeframe=str(exposure.timeframe or exposure.strategy.base_timeframe),
            action=exposure.exit_action,
            qty=exposure.exit_qty,
            rationale="paper-route-probe-exit",
            params=_paper_route_probe_exit_params(
                exposure=exposure,
                plan=plan,
                now=now,
            ),
        )

    def _paper_route_probe_exit_plan(
        self,
        *,
        session: Session,
        exposure: PaperRouteProbeExposure,
        now: datetime,
    ) -> PaperRouteProbeExitPlan | None:
        if exposure.net_qty == 0 or exposure.exit_minute_after_open is None:
            return None
        effective_exit_minute = min(
            exposure.exit_minute_after_open,
            _REGULAR_SESSION_MINUTES - 1,
        )
        exit_due_at = exposure.session_open + timedelta(minutes=effective_exit_minute)
        if now < exit_due_at:
            return None
        lookup = PaperRouteProbeExitRecordLookup(
            session=session,
            strategy=exposure.strategy,
            symbol=exposure.symbol,
            session_open=exposure.session_open,
            exit_due_at=exit_due_at,
        )
        if self._paper_route_probe_exit_already_recorded(lookup):
            return None
        return PaperRouteProbeExitPlan(
            exit_minute=exposure.exit_minute_after_open,
            effective_exit_minute=effective_exit_minute,
            exit_due_at=exit_due_at,
            exit_event_ts=now if now > exit_due_at else exit_due_at,
        )

    def _paper_route_probe_exit_already_recorded(
        self,
        lookup: PaperRouteProbeExitRecordLookup,
    ) -> bool:
        rows = (
            lookup.session.execute(
                select(TradeDecision)
                .where(
                    TradeDecision.strategy_id == lookup.strategy.id,
                    TradeDecision.alpaca_account_label == self.account_label,
                    TradeDecision.symbol == lookup.symbol,
                    TradeDecision.created_at >= lookup.session_open,
                )
                .order_by(TradeDecision.created_at.desc())
            )
            .scalars()
            .all()
        )
        exit_due_at_text = lookup.exit_due_at.isoformat()
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
                lookup.session.execute(
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
        return paper_route_target_price_retry_metadata(decision_row)


__all__ = ["SimplePipelinePaperRouteProbeRetryDecisionMixin"]
