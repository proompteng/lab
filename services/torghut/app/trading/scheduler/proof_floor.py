from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

from sqlalchemy.orm import Session

from ...config import settings
from .pipeline.contexts import LiveSubmissionGateInputs
from .pipeline.shared import TradingPipelineBase
from .target_plan_helpers import (
    PAPER_ROUTE_PROBE_REASONS as _PAPER_ROUTE_PROBE_REASONS,
    PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS as _PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
    SIMPLE_ALLOWED_REJECT_REASONS as _SIMPLE_ALLOWED_REJECT_REASONS,
    SIMPLE_MARKET_CONTEXT_RETRY_INTERVAL as _SIMPLE_MARKET_CONTEXT_RETRY_INTERVAL,
    optional_decimal as _optional_decimal,
)

logger = logging.getLogger(__name__)


class SimplePipelineProofFloorMixin(TradingPipelineBase):
    def _profitability_proof_floor(self, *, session: Session) -> Mapping[str, object]:
        try:
            self._refresh_market_context_for_proof_floor()
            market_context_status = self._build_submission_gate_market_context_status()
            hypothesis_payload = self._build_hypothesis_runtime_summary(
                session,
                market_context_status=market_context_status,
            )
            quant_evidence = self._load_quant_evidence_status()
            live_submission_gate = self._live_submission_gate(
                inputs=LiveSubmissionGateInputs(
                    session=session,
                    hypothesis_summary=hypothesis_payload,
                    quant_health_status=quant_evidence,
                )
            )
            return self._build_profitability_proof_floor_receipt(
                account_label=self.account_label,
                torghut_revision=None,
                trading_mode=settings.trading_mode,
                market_session_open=cast(
                    bool | None,
                    getattr(self.state, "market_session_open", None),
                ),
                live_submission_gate=live_submission_gate,
                hypothesis_payload=hypothesis_payload,
                quant_evidence=quant_evidence,
                market_context_status=market_context_status,
                tca_summary=self._build_tca_gate_inputs(session=session),
                simple_lane_status={
                    "enabled": True,
                    "submit_enabled": settings.trading_simple_submit_enabled,
                    "order_feed_telemetry_enabled": (
                        settings.trading_simple_order_feed_telemetry_enabled
                    ),
                    "order_feed_ingestion_enabled": (
                        settings.trading_order_feed_enabled
                    ),
                    "order_feed_bootstrap_configured": bool(
                        settings.trading_order_feed_bootstrap_server_list
                    ),
                    "order_feed_topic_count": len(settings.trading_order_feed_topics),
                    "order_feed_assignment_mode": (
                        settings.trading_order_feed_assignment_mode
                    ),
                    "order_feed_auto_offset_reset": (
                        settings.trading_order_feed_auto_offset_reset
                    ),
                    "order_feed_lifecycle_required": settings.trading_mode
                    in {"paper", "live"},
                    "order_feed_lifecycle_status": (
                        "enabled"
                        if settings.trading_simple_order_feed_telemetry_enabled
                        else "disabled"
                    ),
                    "paper_route_probe_enabled": (
                        settings.trading_simple_paper_route_probe_enabled
                    ),
                    "paper_route_probe_allow_live_mode": (
                        settings.trading_simple_paper_route_probe_allow_live_mode
                    ),
                    "paper_route_probe_max_notional": (
                        settings.trading_simple_paper_route_probe_max_notional
                    ),
                    "route_symbol_filter_enabled": True,
                    "max_notional_per_order": settings.trading_simple_max_notional_per_order,
                    "max_notional_per_symbol": settings.trading_simple_max_notional_per_symbol,
                    "allowed_reject_reasons": sorted(_SIMPLE_ALLOWED_REJECT_REASONS),
                },
                tca_max_age_seconds=_PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
            )
        except Exception as exc:  # pragma: no cover - defensive capital safety
            logger.exception("Simple-lane proof floor unavailable")
            return {
                "schema_version": "torghut.profitability-proof-floor.v1",
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    f"profitability_proof_floor_unavailable:{type(exc).__name__}"
                ],
            }

    def _refresh_market_context_for_proof_floor(self) -> None:
        """Keep simple-lane proof-floor market context fresh without the LLM path.

        The legacy pipeline records market context while building LLM review
        requests. Simple mode can run with LLM disabled, so the proof floor must
        refresh the same state explicitly before alpha-readiness checks.
        """

        if not settings.trading_market_context_url:
            return

        now = datetime.now(timezone.utc)
        self._age_market_context_freshness(now)
        if self._market_context_refresh_recent(now):
            return
        freshness_seconds = self.state.last_market_context_freshness_seconds
        if (
            freshness_seconds is not None
            and freshness_seconds
            <= settings.trading_market_context_max_staleness_seconds
            and not self.state.market_context_alert_active
        ):
            return

        symbol = self._market_context_probe_symbol()
        if not symbol:
            return
        market_context, market_context_error = self._fetch_market_context(symbol)
        self._record_market_context_observation(
            symbol=symbol,
            market_context=market_context,
            market_context_error=market_context_error,
        )

    def _age_market_context_freshness(self, now: datetime) -> None:
        as_of = self.state.last_market_context_as_of
        if as_of is None:
            return
        if as_of.tzinfo is None:
            as_of = as_of.replace(tzinfo=timezone.utc)
        freshness_seconds = max(
            0,
            int(
                (
                    now.astimezone(timezone.utc) - as_of.astimezone(timezone.utc)
                ).total_seconds()
            ),
        )
        self.state.last_market_context_freshness_seconds = freshness_seconds

    def _market_context_refresh_recent(self, now: datetime) -> bool:
        checked_at = self.state.last_market_context_checked_at
        if checked_at is None:
            return False
        if checked_at.tzinfo is None:
            checked_at = checked_at.replace(tzinfo=timezone.utc)
        return (
            now.astimezone(timezone.utc) - checked_at.astimezone(timezone.utc)
        ) < _SIMPLE_MARKET_CONTEXT_RETRY_INTERVAL

    def _market_context_probe_symbol(self) -> str | None:
        existing_symbol = (
            str(self.state.last_market_context_symbol or "").strip().upper()
        )
        if existing_symbol:
            return existing_symbol
        try:
            symbols = self.universe_resolver.get_resolution().symbols
        except Exception:
            logger.exception("Simple-lane market context probe symbol unavailable")
            return None
        for raw_symbol in symbols:
            symbol = str(raw_symbol).strip().upper()
            if symbol:
                return symbol
        return None

    @staticmethod
    def _proof_floor_submission_block_reason(
        proof_floor: Mapping[str, object],
    ) -> str | None:
        route_state = str(proof_floor.get("route_state") or "").strip()
        capital_state = str(proof_floor.get("capital_state") or "").strip()
        max_notional = _optional_decimal(proof_floor.get("max_notional"))
        if (
            route_state == "repair_only"
            or capital_state == "zero_notional"
            or (max_notional is not None and max_notional <= 0)
        ):
            blocking_reasons = proof_floor.get("blocking_reasons")
            if isinstance(blocking_reasons, list):
                for item in cast(list[object], blocking_reasons):
                    reason = str(item).strip()
                    if reason:
                        return reason
            return "profitability_proof_floor_zero_notional"
        return None

    @staticmethod
    def _proof_floor_market_session_open(proof_floor: Mapping[str, object]) -> bool:
        market_window = proof_floor.get("market_window")
        if not isinstance(market_window, Mapping):
            return False
        return bool(cast(Mapping[str, object], market_window).get("session_open"))

    @staticmethod
    def _proof_floor_route_candidate_symbols(
        proof_floor: Mapping[str, object],
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        route_book_mapping = cast(Mapping[str, Any], route_book)
        summary = route_book_mapping.get("summary")
        if not isinstance(summary, Mapping):
            return set()
        summary_mapping = cast(Mapping[str, Any], summary)
        raw_symbols = summary_mapping.get("candidate_symbols")
        if not isinstance(raw_symbols, list):
            return set()
        candidate_symbols: set[str] = set()
        for raw_symbol in cast(list[object], raw_symbols):
            symbol = str(raw_symbol).strip().upper()
            if symbol:
                candidate_symbols.add(symbol)
        return candidate_symbols

    @staticmethod
    def _proof_floor_route_repair_symbols(
        proof_floor: Mapping[str, object],
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        summary = cast(Mapping[str, Any], route_book).get("summary")
        if not isinstance(summary, Mapping):
            return set()
        repair_symbols: set[str] = set()
        for key in ("repair_candidate_symbols", "candidate_symbols"):
            raw_symbols = cast(Mapping[str, Any], summary).get(key)
            if not isinstance(raw_symbols, list):
                continue
            for raw_symbol in cast(list[object], raw_symbols):
                symbol = str(raw_symbol).strip().upper()
                if symbol:
                    repair_symbols.add(symbol)
        return repair_symbols

    @staticmethod
    def _proof_floor_paper_route_probe_symbols(
        proof_floor: Mapping[str, object],
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        route_book_mapping = cast(Mapping[str, Any], route_book)
        probe = route_book_mapping.get("paper_route_probe")
        summary = route_book_mapping.get("summary")
        symbols: set[str] = set()
        for source, keys in (
            (probe, ("active_symbols", "eligible_symbols")),
            (
                summary,
                (
                    "paper_route_probe_active_symbols",
                    "paper_route_probe_eligible_symbols",
                ),
            ),
        ):
            if not isinstance(source, Mapping):
                continue
            source_mapping = cast(Mapping[str, Any], source)
            for key in keys:
                raw_symbols = source_mapping.get(key)
                if not isinstance(raw_symbols, list):
                    continue
                for raw_symbol in cast(list[object], raw_symbols):
                    symbol = str(raw_symbol).strip().upper()
                    if symbol:
                        symbols.add(symbol)
        return symbols

    @staticmethod
    def _proof_floor_symbol_route_probe_reasons(
        proof_floor: Mapping[str, object],
        symbol: str,
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        raw_summary = cast(Mapping[str, Any], route_book).get("summary")
        summary: Mapping[str, Any]
        if isinstance(raw_summary, Mapping):
            summary = cast(Mapping[str, Any], raw_summary)
        else:
            summary = {}
        normalized_symbol = symbol.strip().upper()
        reasons: set[str] = set()
        route_book_mapping = cast(Mapping[str, Any], route_book)
        candidate_sources: list[object] = [
            summary.get("repair_candidates"),
            route_book_mapping.get("records"),
        ]
        for raw_candidates in candidate_sources:
            if not isinstance(raw_candidates, list):
                continue
            for raw_candidate in cast(list[object], raw_candidates):
                if not isinstance(raw_candidate, Mapping):
                    continue
                candidate = cast(Mapping[str, Any], raw_candidate)
                candidate_symbol = str(candidate.get("symbol") or "").strip().upper()
                if not candidate_symbol or candidate_symbol != normalized_symbol:
                    continue
                state = str(candidate.get("state") or "").strip()
                if state not in {"missing", "probing"}:
                    continue
                reason = str(candidate.get("reason") or "").strip()
                if reason in _PAPER_ROUTE_PROBE_REASONS:
                    reasons.add(reason)
        return reasons

    @staticmethod
    def _proof_floor_symbol_block_reason(
        proof_floor: Mapping[str, object],
        symbol: str,
    ) -> str | None:
        candidate_symbols = (
            SimplePipelineProofFloorMixin._proof_floor_route_candidate_symbols(
                proof_floor
            )
        )
        if not candidate_symbols:
            return None
        normalized_symbol = symbol.strip().upper()
        if normalized_symbol and normalized_symbol not in candidate_symbols:
            return "profitability_route_symbol_excluded"
        return None
