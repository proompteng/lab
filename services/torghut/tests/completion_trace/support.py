# fmt: off
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import (
    Base,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    VNextEmpiricalJobRun,
)
from app.trading.completion import (
    DOC29_EMPIRICAL_JOBS_GATE,
    DOC29_EMPIRICAL_MANIFEST_GATE,
    DOC29_LIVE_CANARY_GATE,
    DOC29_LIVE_SCALE_GATE,
    DOC29_PAPER_GATE,
    DOC29_SIMULATION_FULL_DAY_GATE,
    DOC29_SIMULATION_SMOKE_GATE,
    TRACE_STATUS_SATISFIED,
    build_completion_trace,
    build_doc29_completion_status,
    persist_completion_trace,
    runtime_and_doc_completion_matrices_match,
)
from app.trading.completion.runtime_ledger_bucket_existing_blockers import (
    runtime_ledger_bucket_matches_window as _runtime_ledger_bucket_matches_window,
    runtime_ledger_bucket_refs_for_windows as _runtime_ledger_bucket_refs_for_windows,
    runtime_ledger_bucket_summary as _runtime_ledger_bucket_summary,
    runtime_ledger_daily_summary as _runtime_ledger_daily_summary,
)
from app.trading.completion.runtime_matrix_path import (
    median_decimal as _median_decimal,
    p10_decimal as _p10_decimal,
    runtime_ledger_trading_day_key as _runtime_ledger_trading_day_key,
)


def _truthful_empirical_payload(
    *,
    job_run_id: str,
    dataset_snapshot_ref: str = 'snapshot-1',
) -> dict[str, object]:
    return {
        'promotion_authority_eligible': True,
        'artifact_authority': {
            'provenance': 'historical_market_replay',
            'maturity': 'empirically_validated',
            'authoritative': True,
            'placeholder': False,
        },
        'lineage': {
            'dataset_snapshot_ref': dataset_snapshot_ref,
            'job_run_id': job_run_id,
            'runtime_version_refs': ['services/torghut@sha256:abc'],
            'model_refs': ['models/candidate@sha256:def'],
        },
    }


def _promotion_decision(
    *,
    run_id: str,
    candidate_id: str,
    hypothesis_id: str,
    promotion_target: str,
    state: str,
    allowed: bool = True,
) -> StrategyPromotionDecision:
    return StrategyPromotionDecision(
        run_id=run_id,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        promotion_target=promotion_target,
        state=state,
        allowed=allowed,
        reason_summary='runtime_evidence_thresholds_satisfied' if allowed else 'runtime_evidence_denied',
    )


def _runtime_ledger_source_authority_payload(
    *,
    cost_basis: str | None = 'broker_reported_fees',
    cost_basis_counts: dict[str, int] | None = None,
    extra: dict[str, object] | None = None,
) -> dict[str, object]:
    trade_decision_ids = [f'trade-decision-{index}' for index in range(24)]
    execution_ids = [f'execution-{index}' for index in range(12)]
    execution_order_event_ids = [
        f'execution-order-event-{index}' for index in range(12)
    ]
    source_window_ids = [f'source-window-{index}' for index in range(12)]
    source_offsets = [
        {
            'topic': 'torghut.trade-updates.v2',
            'partition': 0,
            'offset': 42 + index,
        }
        for index in range(12)
    ]
    payload: dict[str, object] = {
        'source': 'runtime-order-feed',
        'source_window_start': '2026-03-06T14:30:00+00:00',
        'source_window_end': '2026-03-06T15:00:00+00:00',
        'source_refs': [
            'postgres:trade_decisions',
            'postgres:executions',
            'postgres:execution_order_events',
            'postgres:order_feed_source_windows',
        ],
        'source_row_counts': {
            'trade_decisions': 24,
            'executions': 12,
            'execution_order_events': 12,
            'order_feed_source_windows': 12,
        },
        'source_window_ids': source_window_ids,
        'trade_decision_ids': trade_decision_ids,
        'execution_ids': execution_ids,
        'execution_order_event_ids': execution_order_event_ids,
        'source_offsets': source_offsets,
        'source_materialization': 'execution_order_events',
        'authority_class': 'runtime_order_feed_execution_source',
        'authority_reason': 'event_sourced_runtime_ledger_profit_proof',
    }
    if cost_basis is not None:
        payload['cost_basis'] = cost_basis
        payload['cost_basis_counts'] = cost_basis_counts or {cost_basis: 12}
    if extra:
        payload.update(extra)
    return payload


def _runtime_ledger_bucket(
    *,
    run_id: str,
    candidate_id: str = 'cand-1',
    hypothesis_id: str = 'legacy_macd_rsi',
    observed_stage: str = 'live',
    bucket_started_at: datetime,
    bucket_ended_at: datetime,
    ledger_schema_version: str = 'torghut.runtime-ledger-bucket.v1',
    payload_json: dict[str, object] | None = None,
) -> StrategyRuntimeLedgerBucket:
    return StrategyRuntimeLedgerBucket(
        run_id=run_id,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        observed_stage=observed_stage,
        bucket_started_at=bucket_started_at,
        bucket_ended_at=bucket_ended_at,
        runtime_strategy_name='legacy-macd-rsi',
        strategy_family='breakout_continuation_consistent',
        fill_count=12,
        decision_count=24,
        submitted_order_count=12,
        cancelled_order_count=0,
        rejected_order_count=0,
        unfilled_order_count=0,
        closed_trade_count=6,
        open_position_count=0,
        filled_notional=Decimal('120000'),
        gross_strategy_pnl=Decimal('20'),
        cost_amount=Decimal('3.2'),
        net_strategy_pnl_after_costs=Decimal('16.8'),
        post_cost_expectancy_bps=Decimal('1.4'),
        ledger_schema_version=ledger_schema_version,
        pnl_basis='realized_strategy_pnl_after_explicit_costs',
        execution_policy_hash_counts={'policy-hash': 12},
        cost_model_hash_counts={'cost-hash': 12},
        lineage_hash_counts={'lineage-hash': 12},
        blockers_json=[],
        payload_json=_runtime_ledger_source_authority_payload() if payload_json is None else payload_json,
    )


def _add_truthful_empirical_jobs(
    session: Any,
    *,
    run_id: str = 'run-1',
    candidate_id: str = 'cand-1',
    dataset_snapshot_ref: str = 'snapshot-1',
) -> None:
    for job_type in (
        'benchmark_parity',
        'foundation_router_parity',
        'janus_event_car',
        'janus_hgrm_reward',
    ):
        session.add(
            VNextEmpiricalJobRun(
                run_id=run_id,
                candidate_id=candidate_id,
                job_name=job_type,
                job_type=job_type,
                job_run_id=f'job-{job_type}',
                status='completed',
                authority='empirical',
                promotion_authority_eligible=True,
                dataset_snapshot_ref=dataset_snapshot_ref,
                artifact_refs=[f's3://artifacts/{job_type}.json'],
                payload_json=_truthful_empirical_payload(
                    job_run_id=f'job-{job_type}',
                    dataset_snapshot_ref=dataset_snapshot_ref,
                ),
            )
        )


class _TestCompletionTraceBase(TestCase):
    def setUp(self) -> None:
        engine = create_engine(
            'sqlite+pysqlite:///:memory:',
            future=True,
            connect_args={'check_same_thread': False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine,
            expire_on_commit=False,
            future=True,
        )

__all__: tuple[str, ...] = (
    "Any",
    "Base",
    "DOC29_EMPIRICAL_JOBS_GATE",
    "DOC29_EMPIRICAL_MANIFEST_GATE",
    "DOC29_LIVE_CANARY_GATE",
    "DOC29_LIVE_SCALE_GATE",
    "DOC29_PAPER_GATE",
    "DOC29_SIMULATION_FULL_DAY_GATE",
    "DOC29_SIMULATION_SMOKE_GATE",
    "Decimal",
    "StaticPool",
    "StrategyHypothesisMetricWindow",
    "StrategyPromotionDecision",
    "StrategyRuntimeLedgerBucket",
    "TRACE_STATUS_SATISFIED",
    "TestCase",
    "VNextEmpiricalJobRun",
    "_TestCompletionTraceBase",
    "_add_truthful_empirical_jobs",
    "_median_decimal",
    "_p10_decimal",
    "_promotion_decision",
    "_runtime_ledger_bucket",
    "_runtime_ledger_bucket_matches_window",
    "_runtime_ledger_bucket_refs_for_windows",
    "_runtime_ledger_bucket_summary",
    "_runtime_ledger_daily_summary",
    "_runtime_ledger_source_authority_payload",
    "_runtime_ledger_trading_day_key",
    "_truthful_empirical_payload",
    "build_completion_trace",
    "build_doc29_completion_status",
    "create_engine",
    "datetime",
    "patch",
    "persist_completion_trace",
    "runtime_and_doc_completion_matrices_match",
    "sessionmaker",
    "timedelta",
    "timezone",
)
