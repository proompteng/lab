"""LEAN multi-lane orchestration helpers for Torghut control-plane governance."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    LeanBacktestRun,
    LeanCanaryIncident,
    LeanExecutionShadowEvent,
    LeanStrategyShadowEvaluation,
    coerce_json_payload,
)


class LeanLaneManager:
    """Coordinates LEAN lane requests with durable Torghut governance storage."""

    def submit_backtest(
        self,
        session: Session,
        *,
        config: Mapping[str, Any],
        lane: str,
        requested_by: str | None,
        correlation_id: str,
    ) -> LeanBacktestRun:
        payload = self._request_runner(
            'POST',
            '/v1/backtests/submit',
            body={
                'lane': lane,
                'config': dict(config),
            },
            correlation_id=correlation_id,
        )
        backtest_id = str(payload.get('backtest_id') or '').strip()
        if not backtest_id:
            raise RuntimeError('lean_backtest_submit_invalid_response')

        row = session.execute(
            select(LeanBacktestRun).where(LeanBacktestRun.backtest_id == backtest_id)
        ).scalar_one_or_none()
        if row is None:
            row = LeanBacktestRun(
                backtest_id=backtest_id,
                lane=lane,
                status=str(payload.get('status') or 'queued'),
                requested_by=requested_by,
                config_json=coerce_json_payload(dict(config)),
                reproducibility_hash=str(payload.get('reproducibility_hash') or '') or None,
            )
        else:
            row.status = str(payload.get('status') or row.status)
            row.requested_by = requested_by or row.requested_by
            row.config_json = coerce_json_payload(dict(config))
            row.reproducibility_hash = str(payload.get('reproducibility_hash') or '') or row.reproducibility_hash
        session.add(row)
        session.commit()
        session.refresh(row)
        return row

    def refresh_backtest(self, session: Session, *, backtest_id: str) -> LeanBacktestRun:
        row = session.execute(
            select(LeanBacktestRun).where(LeanBacktestRun.backtest_id == backtest_id)
        ).scalar_one_or_none()
        if row is None:
            raise RuntimeError('lean_backtest_not_found')

        payload = self._request_runner('GET', f'/v1/backtests/{backtest_id}')
        row.status = str(payload.get('status') or row.status)
        result = payload.get('result')
        if isinstance(result, Mapping):
            result_map = cast(Mapping[str, Any], result)
            row.result_json = coerce_json_payload(dict(result_map))
            row.artifacts_json = coerce_json_payload(dict(cast(Mapping[str, Any], result_map.get('artifacts') or {})))
            replay_hash = str(result_map.get('replay_hash') or '').strip()
            if replay_hash:
                row.replay_hash = replay_hash
            deterministic = result_map.get('deterministic_replay_passed')
            if isinstance(deterministic, bool):
                row.deterministic_replay_passed = deterministic
        row.failure_taxonomy = self._derive_backtest_failure_taxonomy(row)
        if row.status == 'completed':
            row.completed_at = datetime.now(timezone.utc)
        session.add(row)
        session.commit()
        session.refresh(row)
        return row

    def record_strategy_shadow(
        self,
        session: Session,
        *,
        strategy_id: str,
        symbol: str,
        intent: Mapping[str, Any],
        shadow_result: Mapping[str, Any],
    ) -> LeanStrategyShadowEvaluation:
        run_id = str(shadow_result.get('run_id') or '').strip()
        if not run_id:
            signature = hashlib.sha256(
                json.dumps({'strategy_id': strategy_id, 'symbol': symbol, 'intent': dict(intent)}, sort_keys=True).encode(
                    'utf-8'
                )
            ).hexdigest()
            run_id = signature[:24]

        row = session.execute(
            select(LeanStrategyShadowEvaluation).where(LeanStrategyShadowEvaluation.run_id == run_id)
        ).scalar_one_or_none()
        if row is None:
            row = LeanStrategyShadowEvaluation(
                run_id=run_id,
                strategy_id=strategy_id,
                symbol=symbol,
                intent_json=coerce_json_payload(dict(intent)),
                shadow_json=coerce_json_payload(dict(shadow_result)),
                parity_status=str(shadow_result.get('parity_status') or 'unknown'),
                governance_json=coerce_json_payload(dict(cast(Mapping[str, Any], shadow_result.get('governance') or {}))),
                disable_switch_active=settings.trading_lean_lane_disable_switch,
            )
        else:
            row.shadow_json = coerce_json_payload(dict(shadow_result))
            row.parity_status = str(shadow_result.get('parity_status') or row.parity_status)
            row.governance_json = coerce_json_payload(dict(cast(Mapping[str, Any], shadow_result.get('governance') or {})))
            row.disable_switch_active = settings.trading_lean_lane_disable_switch
        session.add(row)
        session.commit()
        session.refresh(row)
        return row

    def parity_summary(self, session: Session, *, lookback_hours: int = 24) -> dict[str, Any]:
        since = datetime.now(timezone.utc) - timedelta(hours=max(lookback_hours, 1))
        rows = session.execute(
            select(LeanExecutionShadowEvent).where(LeanExecutionShadowEvent.created_at >= since)
        ).scalars().all()
        total = len(rows)
        drift = sum(1 for row in rows if row.parity_status != 'pass')
        failure_counts: dict[str, int] = {}
        avg_delta_bps = Decimal('0')
        counted_delta = 0
        for row in rows:
            if row.failure_taxonomy:
                failure_counts[row.failure_taxonomy] = failure_counts.get(row.failure_taxonomy, 0) + 1
            if row.parity_delta_bps is not None:
                avg_delta_bps += row.parity_delta_bps
                counted_delta += 1
        average = (avg_delta_bps / counted_delta) if counted_delta > 0 else Decimal('0')
        return {
            'lookback_hours': lookback_hours,
            'events_total': total,
            'drift_events': drift,
            'drift_ratio': (drift / total) if total > 0 else 0.0,
            'avg_parity_delta_bps': float(average),
            'failure_classes': failure_counts,
        }

    def record_canary_incident(
        self,
        session: Session,
        *,
        incident_key: str,
        breach_type: str,
        severity: str,
        symbols: list[str],
        evidence: Mapping[str, Any],
        rollback_triggered: bool,
    ) -> LeanCanaryIncident:
        row = session.execute(
            select(LeanCanaryIncident).where(LeanCanaryIncident.incident_key == incident_key)
        ).scalar_one_or_none()
        if row is None:
            row = LeanCanaryIncident(
                incident_key=incident_key,
                breach_type=breach_type,
                severity=severity,
                symbols=coerce_json_payload(symbols),
                evidence_json=coerce_json_payload(dict(evidence)),
                rollback_triggered=rollback_triggered,
            )
        else:
            row.breach_type = breach_type
            row.severity = severity
            row.symbols = coerce_json_payload(symbols)
            row.evidence_json = coerce_json_payload(dict(evidence))
            row.rollback_triggered = rollback_triggered
        session.add(row)
        session.commit()
        session.refresh(row)
        return row

    def _derive_backtest_failure_taxonomy(self, row: LeanBacktestRun) -> str | None:
        if row.status in {'queued', 'running'}:
            return None
        if row.status != 'completed':
            return 'backtest_failed'
        if row.deterministic_replay_passed is False:
            return 'replay_nondeterministic'
        if row.reproducibility_hash and row.replay_hash:
            return None
        return 'missing_repro_artifacts'

    def _request_runner(
        self,
        method: str,
        path: str,
        *,
        body: Mapping[str, Any] | None = None,
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        if not settings.trading_lean_runner_url:
            raise RuntimeError('lean_runner_url_not_configured')
        url = f'{settings.trading_lean_runner_url.rstrip("/")}{path}'
        payload = None
        headers = {'accept': 'application/json'}
        if correlation_id:
            headers['X-Correlation-ID'] = correlation_id
        if body is not None:
            payload = json.dumps(dict(body)).encode('utf-8')
            headers['content-type'] = 'application/json'
        request = Request(url=url, method=method, headers=headers, data=payload)
        try:
            with urlopen(request, timeout=max(settings.trading_lean_runner_timeout_seconds, 1)) as response:
                raw = response.read().decode('utf-8').strip()
        except HTTPError as exc:
            detail = exc.read().decode('utf-8').strip()
            raise RuntimeError(f'lean_runner_http_{exc.code}:{detail}') from exc
        except URLError as exc:
            raise RuntimeError(f'lean_runner_network_error:{exc.reason}') from exc
        if not raw:
            return {}
        parsed = json.loads(raw)
        if not isinstance(parsed, Mapping):
            return {}
        return {str(key): value for key, value in cast(Mapping[object, Any], parsed).items()}


__all__ = ['LeanLaneManager']
