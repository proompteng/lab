"""Late-stage materialized paper-route processing mixin."""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import settings
from ...models import Strategy, TradeDecision, coerce_json_payload
from ..models import StrategyDecision
from .pipeline.contexts import AllocationDecisionContext
from .pipeline.shared import TradingPipelineBase
from .target_plan_helpers import (
    bounded_sim_collection_metadata_from_decision as _bounded_sim_collection_metadata_from_decision,
    safe_int as _safe_int,
    safe_text as _safe_text,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _MaterializedCandidateContext:
    session: Session
    strategies: Sequence[Strategy]
    positions: Sequence[Mapping[str, Any]]
    now: datetime


class SimplePipelinePaperRouteMaterializationProcessingMixin(TradingPipelineBase):
    def _active_materialized_paper_route_client_order_ids(
        self,
        *,
        session: Session,
        rows: Sequence[TradeDecision],
        strategies: Sequence[Strategy],
        positions: Sequence[Mapping[str, Any]],
        now: datetime,
    ) -> set[str]:
        client_order_ids: set[str] = set()
        candidate_context = _MaterializedCandidateContext(
            session=session,
            strategies=strategies,
            positions=positions,
            now=now,
        )
        for decision_row in rows:
            decision_hash = _safe_text(decision_row.decision_hash)
            if decision_hash is None:
                continue
            candidate = self._paper_route_materialized_candidate(
                decision_row=decision_row,
                context=candidate_context,
            )
            if candidate is not None:
                client_order_ids.add(decision_hash)
        return client_order_ids

    def _paper_route_materialized_planned_decisions(
        self,
        *,
        session: Session,
        strategies: Sequence[Strategy],
        allowed_symbols: set[str],
        positions: Sequence[Mapping[str, Any]],
    ) -> list[StrategyDecision]:
        if settings.trading_mode != "paper":
            return []
        if not settings.trading_simple_paper_route_probe_enabled:
            return []
        now = self._trading_now().astimezone(timezone.utc)

        rows = (
            session.execute(
                select(TradeDecision)
                .where(
                    TradeDecision.status == "planned",
                    TradeDecision.alpaca_account_label == self.account_label,
                )
                .order_by(TradeDecision.created_at.asc(), TradeDecision.symbol.asc())
                .limit(100)
            )
            .scalars()
            .all()
        )
        decisions: list[StrategyDecision] = []
        seen: set[str] = set()
        expired_count = 0
        context = self._paper_route_materialized_planning_context(
            session=session,
            rows=rows,
            strategies=strategies,
            positions=positions,
            now=now,
        )
        for decision_row in rows:
            if str(decision_row.id) in seen:
                continue
            result = self._paper_route_materialized_planned_candidate(
                decision_row=decision_row,
                context=context,
            )
            if result.expired:
                expired_count += 1
                seen.add(str(decision_row.id))
                continue
            candidate = result.candidate
            if candidate is None:
                continue
            decision = self._paper_route_materialized_decision_with_execution_metadata(
                decision_row=decision_row,
                payload=candidate.payload,
                target=candidate.target,
                strategy=candidate.strategy,
                symbol=candidate.symbol,
                action=candidate.action,
                window_start=candidate.window_start,
                window_end=candidate.window_end,
                max_notional=candidate.target_cap,
                now=now,
            )
            if decision is None:
                continue
            decisions.append(decision)
            seen.add(str(decision_row.id))
        if expired_count:
            session.commit()
            logger.warning(
                "Expired stale materialized paper-route target source decisions account_label=%s count=%s",
                self.account_label,
                expired_count,
            )
        return decisions

    def _process_paper_route_materialized_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_materialized_planned_decisions(
            session=session,
            strategies=strategies,
            positions=positions,
            allowed_symbols=allowed_symbols,
        )
        for decision in decisions:
            self.state.metrics.decisions_total += 1
            try:
                submitted = self._handle_decision(
                    AllocationDecisionContext(
                        session=session,
                        strategies=list(strategies),
                        account=account,
                        positions=positions,
                        allowed_symbols=allowed_symbols,
                    ),
                    decision,
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
                    "Materialized paper-route target source decision handling failed "
                    "strategy_id=%s symbol=%s timeframe=%s",
                    decision.strategy_id,
                    decision.symbol,
                    decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["broker_submit_failed"]
                )

    def _reopen_bounded_sim_collection_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        retry_transition = self._paper_route_retry_transition(
            decision_row,
            allowed_kinds=frozenset({"bounded_probe"}),
        )
        if retry_transition is None:
            return None
        retry_metadata = retry_transition.metadata
        if self.executor.execution_exists(session, decision_row):
            return None
        collection_metadata = _bounded_sim_collection_metadata_from_decision(
            decision,
            account_label=self.account_label,
            trading_mode=settings.trading_mode,
        )
        if collection_metadata is None:
            return None
        proof_floor = self._profitability_proof_floor(session=session)
        if self._proof_floor_submission_block_reason(proof_floor) is None:
            return None

        self.executor.update_decision_params(session, decision_row, decision.params)
        self.executor.sync_decision_state(session, decision_row, decision)
        decision_row.status = "planned"
        decision_row.created_at = self._trading_now()
        decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        decision_json["paper_route_probe_retry_attempts"] = retry_attempts + 1
        decision_json["bounded_sim_collection_retry"] = {
            **retry_metadata,
            "submission_stage": "bounded_sim_collection_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
            "collection_metadata": dict(collection_metadata),
        }
        decision_json["submission_stage"] = "bounded_sim_collection_retry_pending"
        decision_json.pop("submission_block_reason", None)
        decision_json.pop("submission_block_atomic", None)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening proof-floor-blocked decision for bounded SIM evidence collection strategy_id=%s decision_id=%s symbol=%s previous_reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            retry_metadata["previous_submission_block_reason"],
        )
        return decision_row

    @staticmethod
    def _paper_route_materialized_trade_decision_id(
        decision: StrategyDecision,
    ) -> UUID | None:
        row_id_text = _safe_text(
            decision.params.get("paper_route_materialized_trade_decision_id")
        )
        if row_id_text is None:
            return None
        try:
            return UUID(row_id_text)
        except ValueError:
            return None

    def _claimable_materialized_paper_route_decision_row(
        self,
        *,
        session: Session,
        row_id: UUID,
    ) -> TradeDecision | None:
        decision_row = session.get(TradeDecision, row_id)
        if decision_row is None:
            return None
        if decision_row.alpaca_account_label != self.account_label:
            return None
        retryable_status = (
            decision_row.status in {"blocked", "rejected"}
            and self._paper_route_retry_transition(decision_row) is not None
        )
        if decision_row.status != "planned" and not retryable_status:
            return None
        if self.executor.execution_exists(session, decision_row):
            return None
        return decision_row

    def _claim_materialized_paper_route_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
    ) -> TradeDecision | None:
        row_id = self._paper_route_materialized_trade_decision_id(decision)
        if row_id is None:
            return None
        decision_row = self._claimable_materialized_paper_route_decision_row(
            session=session,
            row_id=row_id,
        )
        if decision_row is None:
            return None

        decision_row.strategy_id = strategy.id
        decision_row.symbol = decision.symbol
        decision_row.timeframe = decision.timeframe
        decision_row.rationale = decision.rationale
        if decision_row.status == "planned":
            decision_row.decision_json = coerce_json_payload(
                decision.model_dump(mode="json")
            )
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        return decision_row

    def _first_reopened_paper_route_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        for reopen in (
            self._reopen_rejected_paper_route_quote_routeability_decision,
            self._reopen_rejected_paper_route_probe_exit_decision,
            self._reopen_rejected_paper_route_target_price_decision,
            self._reopen_bounded_sim_collection_decision,
        ):
            reopened = reopen(
                session=session,
                decision=decision,
                decision_row=decision_row,
            )
            if reopened is not None:
                return reopened
        return None

    def _refresh_paper_route_target_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> None:
        if "paper_route_target_plan" in decision.params:
            self.executor.update_decision_params(session, decision_row, decision.params)
            self.executor.sync_decision_state(session, decision_row, decision)
        if (
            decision_row.status == "planned"
            and self._paper_route_target_source_cap(decision.params) is not None
        ):
            decision_row.created_at = self._trading_now()
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

    def _reopen_bounded_paper_route_probe_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
        decision_row: TradeDecision,
        retry_metadata: Mapping[str, Any],
    ) -> TradeDecision | None:
        if self.executor.execution_exists(session, decision_row):
            return None
        proof_floor = self._profitability_proof_floor(session=session)
        if self._proof_floor_submission_block_reason(proof_floor) is None:
            return None
        probe_context = self._paper_route_probe_context(
            proof_floor=proof_floor,
            decision=decision,
            strategy=strategy,
            session=session,
            strategies=[strategy],
        )
        if probe_context is None:
            return None
        if self._paper_route_probe_reference_price(decision) is None:
            return None

        decision_row.status = "planned"
        decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        decision_json["paper_route_probe_retry_attempts"] = retry_attempts + 1
        decision_json["paper_route_probe_retry"] = {
            **retry_metadata,
            "submission_stage": "paper_route_probe_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
            "context": dict(probe_context),
        }
        decision_json["submission_stage"] = "paper_route_probe_retry_pending"
        decision_json.pop("submission_block_reason", None)
        decision_json.pop("submission_block_atomic", None)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening proof-floor-blocked decision for bounded paper route probe strategy_id=%s decision_id=%s symbol=%s previous_reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            retry_metadata["previous_submission_block_reason"],
        )
        return decision_row

    def _ensure_pending_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
    ) -> TradeDecision | None:
        decision = self._with_paper_route_target_lineage(decision, strategy=strategy)
        if (
            _safe_text(
                decision.params.get("paper_route_materialized_trade_decision_id")
            )
            is not None
        ):
            decision_row = self._claim_materialized_paper_route_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )
            if decision_row is None:
                return None
        else:
            decision_row = self.executor.ensure_decision(
                session, decision, strategy, self.account_label
            )
        reopened = self._first_reopened_paper_route_decision_row(
            session=session,
            decision=decision,
            decision_row=decision_row,
        )
        if reopened is not None:
            return reopened

        self._refresh_paper_route_target_decision_row(
            session=session,
            decision=decision,
            decision_row=decision_row,
        )
        if (
            _safe_text(
                decision.params.get("paper_route_materialized_trade_decision_id")
            )
            is not None
        ):
            return decision_row
        retry_transition = self._paper_route_retry_transition(
            decision_row,
            allowed_kinds=frozenset({"bounded_probe"}),
        )
        if retry_transition is None:
            return super()._ensure_pending_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )
        retry_metadata = retry_transition.metadata
        return self._reopen_bounded_paper_route_probe_decision(
            session=session,
            decision=decision,
            strategy=strategy,
            decision_row=decision_row,
            retry_metadata=retry_metadata,
        )
