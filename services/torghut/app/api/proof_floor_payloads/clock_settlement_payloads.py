"""Clock-settlement payload assembly."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.config import settings
from app.trading.clock_settlement import build_clock_settlement_receipt


def build_clock_settlement_payload(
    *,
    torghut_revision: str | None,
    source_commit: str | None,
    build: Mapping[str, Any],
    evidence_clock_arbiter: Mapping[str, Any],
    routeable_profit_candidate_exchange: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    profit_signal_quorum: Mapping[str, Any],
    rollout_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_clock_settlement_receipt(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        source_commit=source_commit,
        build=build,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs_status,
        profit_signal_quorum=profit_signal_quorum,
        rollout_status=rollout_status,
    )


__all__ = ("build_clock_settlement_payload",)
