"""ClickHouse signal status and accepted-source freshness contracts."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Mapping

from ...config import settings

from .clickhouse_signal_source_freshness import (
    ClickHouseSignalFreshnessContext as _ClickHouseSignalFreshnessContext,
    accepted_signal_sources as _accepted_signal_sources,
    build_accepted_source_freshness_contract as _build_accepted_source_freshness_contract,
    build_unavailable_accepted_source_freshness_contract as _build_unavailable_accepted_source_freshness_contract,
    latest_signal_readiness_counts as _latest_signal_readiness_counts,
)
from .shared_context import (
    ClickHouseSignalIngestorContract as _ClickHouseSignalIngestorContract,
)

logger = logging.getLogger("app.trading.ingest")

_CLICKHOUSE_STATUS_EXCEPTIONS = (RuntimeError, OSError, ValueError, TypeError)


if TYPE_CHECKING:
    _ClickHouseSignalIngestorStatusBase = _ClickHouseSignalIngestorContract
else:
    _ClickHouseSignalIngestorStatusBase = object


class _ClickHouseSignalIngestorStatusMethods(_ClickHouseSignalIngestorStatusBase):
    def latest_signal_status(self) -> dict[str, object]:
        if not self.url:
            return self._unavailable_signal_status(
                state="unavailable",
                reason_code="clickhouse_url_missing",
                blocking_reason="accepted_ta_signal_unavailable",
            )
        try:
            time_column = self._resolve_time_column()
            latest_signal_at = self._latest_signal_timestamp(
                time_column,
                fail_on_query_error=True,
            )
        except _CLICKHOUSE_STATUS_EXCEPTIONS as exc:
            logger.warning("Failed to load ClickHouse TA freshness status: %s", exc)
            return self._unavailable_signal_status(
                state="unavailable",
                reason_code="clickhouse_ta_status_query_failed",
                blocking_reason="accepted_ta_signal_unavailable",
                extra_status={"detail": str(exc)[:200]},
            )
        if latest_signal_at is None:
            return self._unavailable_signal_status(
                state="missing",
                reason_code="clickhouse_ta_latest_signal_missing",
                blocking_reason="accepted_ta_signal_missing",
                extra_status={"time_column": time_column},
            )
        status: dict[str, object] = {
            "state": "current",
            "latest_signal_at": latest_signal_at,
            "source_ref": self.table,
            "time_column": time_column,
        }
        status.update(
            self._accepted_source_freshness_contract(
                time_column=time_column,
                latest_signal_at=latest_signal_at,
            )
        )
        try:
            status.update(
                _latest_signal_readiness_counts(
                    context=self._signal_freshness_context(),
                    time_column=time_column,
                    latest_signal_at=latest_signal_at,
                )
            )
        except _CLICKHOUSE_STATUS_EXCEPTIONS as exc:
            logger.warning("Failed to load ClickHouse TA readiness counts: %s", exc)
            status["readiness_reason_codes"] = ["clickhouse_ta_readiness_query_failed"]
            status["readiness_detail"] = str(exc)[:200]
        return status

    def _unavailable_signal_status(
        self,
        *,
        state: str,
        reason_code: str,
        blocking_reason: str,
        extra_status: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        status: dict[str, object] = {
            "state": "missing",
            "reason_codes": [reason_code],
            "source_ref": self.table,
        }
        if extra_status is not None:
            status.update(extra_status)
        status.update(
            _build_unavailable_accepted_source_freshness_contract(
                context=self._signal_freshness_context(),
                state=state,
                reason_code=reason_code,
                blocking_reason=blocking_reason,
            )
        )
        return status

    def _accepted_source_freshness_contract(
        self,
        *,
        time_column: str,
        latest_signal_at: datetime,
    ) -> dict[str, object]:
        return _build_accepted_source_freshness_contract(
            context=self._signal_freshness_context(),
            time_column=time_column,
            latest_signal_at=latest_signal_at,
        )

    def _signal_freshness_context(self) -> _ClickHouseSignalFreshnessContext:
        return _ClickHouseSignalFreshnessContext(
            table=self.table,
            simulation_mode=self.simulation_mode,
            initial_lookback_minutes=self.initial_lookback_minutes,
            max_staleness_ms=settings.trading_feature_max_staleness_ms,
            allowed_sources_raw=",".join(self._accepted_signal_sources()),
            query_clickhouse=self._query_clickhouse,
            resolve_columns=self._resolve_columns,
            source_where_clause=self._source_where_clause,
        )

    def _accepted_signal_sources(self) -> tuple[str, ...]:
        return _accepted_signal_sources(settings.trading_signal_allowed_sources_raw)


ClickHouseSignalIngestorStatusMethods = _ClickHouseSignalIngestorStatusMethods


__all__ = [
    "ClickHouseSignalIngestorStatusMethods",
]
