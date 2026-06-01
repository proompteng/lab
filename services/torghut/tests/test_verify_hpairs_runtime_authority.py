from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import cast
from unittest.mock import patch

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.trading.runtime_authority_verifier import (
    AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER,
    AUTHORITY_BUCKET_BLOCKERS_PRESENT,
    AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER,
    AUTHORITY_COST_MODEL_HASH_BLOCKER,
    AUTHORITY_EVIDENCE_MISSING_BLOCKER,
    AUTHORITY_EXPLICIT_COSTS_BLOCKER,
    AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER,
    AUTHORITY_LEDGER_SCHEMA_BLOCKER,
    AUTHORITY_LINEAGE_HASH_BLOCKER,
    AUTHORITY_MEAN_PNL_BLOCKER,
    AUTHORITY_ORDER_LIFECYCLE_MISSING_BLOCKER,
    AUTHORITY_OPEN_POSITIONS_BLOCKER,
    AUTHORITY_P10_PNL_BLOCKER,
    AUTHORITY_PNL_BASIS_BLOCKER,
    AUTHORITY_POLICY_HASH_BLOCKER,
    AUTHORITY_READ_ERROR_BLOCKER,
    AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
    AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
    AUTHORITY_TRADING_DAYS_BLOCKER,
    AUTHORITY_WORST_DAY_BLOCKER,
    DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
    RuntimeAuthorityEvidenceRow,
    build_runtime_authority_report,
    load_runtime_authority_rows,
    runtime_authority_report_json,
)
from app.trading.runtime_ledger import EXACT_REPLAY_LEDGER_SCHEMA_VERSION, POST_COST_PNL_BASIS
from scripts import verify_hpairs_runtime_authority as cli


def _source_payload(day_index: int) -> dict[str, object]:
    return {
        'source_window_start': f'2026-05-{day_index + 1:02d}T14:30:00Z',
        'source_window_end': f'2026-05-{day_index + 1:02d}T21:00:00Z',
        'source_refs': [
            'postgres:trade_decisions',
            'postgres:executions',
            'postgres:execution_order_events',
            'postgres:order_feed_source_windows',
        ],
        'source_row_counts': {
            'trade_decisions': 20,
            'executions': 20,
            'execution_order_events': 20,
            'order_feed_source_windows': 20,
        },
        'trade_decision_ids': [f'decision-{day_index}-{item}' for item in range(20)],
        'execution_ids': [f'execution-{day_index}-{item}' for item in range(20)],
        'execution_order_event_ids': [f'event-{day_index}-{item}' for item in range(20)],
        'source_window_ids': [f'window-{day_index}-{item}' for item in range(20)],
        'source_offsets': [
            {'topic': 'alpaca.trade_updates', 'partition': 0, 'offset': day_index * 100 + item}
            for item in range(20)
        ],
        'source_materialization': 'execution_order_events',
        'authority_class': 'runtime_order_feed_execution_source',
        'order_feed_lifecycle_complete': True,
        'execution_economics_complete': True,
        'cost_basis_counts': {'explicit_broker_fee_runtime': 20},
    }


def _row(day_index: int, *, pnl: str = '600', open_positions: int = 0, source_backed: bool = True) -> dict[str, object]:
    start = datetime(2026, 5, 1, tzinfo=timezone.utc) + timedelta(days=day_index)
    payload = _source_payload(day_index) if source_backed else {}
    return {
        'id': f'row-{day_index:02d}',
        'run_id': 'runtime-run',
        'candidate_id': DEFAULT_HPAIRS_CANDIDATE_ID,
        'hypothesis_id': DEFAULT_HPAIRS_HYPOTHESIS_ID,
        'observed_stage': 'paper',
        'bucket_started_at': start,
        'bucket_ended_at': start + timedelta(hours=6),
        'account_label': DEFAULT_HPAIRS_ACCOUNT_LABEL,
        'runtime_strategy_name': DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        'strategy_family': 'pairs',
        'fill_count': 20,
        'decision_count': 20,
        'submitted_order_count': 20,
        'cancelled_order_count': 0,
        'rejected_order_count': 0,
        'unfilled_order_count': 0,
        'closed_trade_count': 20,
        'open_position_count': open_positions,
        'filled_notional': Decimal('600000'),
        'gross_strategy_pnl': Decimal(pnl) + Decimal('10'),
        'cost_amount': Decimal('10'),
        'net_strategy_pnl_after_costs': Decimal(pnl),
        'post_cost_expectancy_bps': Decimal('10'),
        'ledger_schema_version': EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        'pnl_basis': POST_COST_PNL_BASIS,
        'execution_policy_hash_counts': {'policy-hash': 20},
        'cost_model_hash_counts': {'cost-hash': 20},
        'lineage_hash_counts': {'lineage-hash': 20},
        'blockers': [],
        'payload': payload,
    }


def _bucket(day_index: int) -> SimpleNamespace:
    row = _row(day_index)
    return SimpleNamespace(
        id=row['id'],
        run_id=row['run_id'],
        candidate_id=row['candidate_id'],
        hypothesis_id=row['hypothesis_id'],
        observed_stage=row['observed_stage'],
        bucket_started_at=row['bucket_started_at'],
        bucket_ended_at=row['bucket_ended_at'],
        account_label=row['account_label'],
        runtime_strategy_name=row['runtime_strategy_name'],
        strategy_family=row['strategy_family'],
        fill_count=row['fill_count'],
        decision_count=row['decision_count'],
        submitted_order_count=row['submitted_order_count'],
        cancelled_order_count=row['cancelled_order_count'],
        rejected_order_count=row['rejected_order_count'],
        unfilled_order_count=row['unfilled_order_count'],
        closed_trade_count=row['closed_trade_count'],
        open_position_count=row['open_position_count'],
        filled_notional=row['filled_notional'],
        gross_strategy_pnl=row['gross_strategy_pnl'],
        cost_amount=row['cost_amount'],
        net_strategy_pnl_after_costs=row['net_strategy_pnl_after_costs'],
        post_cost_expectancy_bps=row['post_cost_expectancy_bps'],
        ledger_schema_version=row['ledger_schema_version'],
        pnl_basis=row['pnl_basis'],
        execution_policy_hash_counts=row['execution_policy_hash_counts'],
        cost_model_hash_counts=row['cost_model_hash_counts'],
        lineage_hash_counts=row['lineage_hash_counts'],
        blockers_json=row['blockers'],
        payload_json=row['payload'],
        created_at=row['bucket_started_at'],
        updated_at=row['bucket_ended_at'],
    )


def test_empty_evidence_is_blocked() -> None:
    report = build_runtime_authority_report([])

    assert report['final_authority_ok'] is False
    assert AUTHORITY_EVIDENCE_MISSING_BLOCKER in report['blockers']
    assert AUTHORITY_TRADING_DAYS_BLOCKER in report['blockers']
    assert report['trading_days'] == []


def test_aggregate_only_bucket_is_blocked() -> None:
    report = build_runtime_authority_report([_row(0, source_backed=False)])

    blockers = set(report['blockers'])
    assert report['final_authority_ok'] is False
    assert RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER in blockers
    assert RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER in blockers
    assert RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER in blockers
    assert RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER in blockers
    assert RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER in blockers


def test_bucket_loader_applies_identity_and_window_filters() -> None:
    class FakeScalars:
        def all(self) -> list[SimpleNamespace]:
            return [_bucket(0)]

    class FakeSession:
        statement = None

        def scalars(self, statement):  # type: ignore[no-untyped-def]
            self.statement = statement
            return FakeScalars()

    session = FakeSession()
    rows = load_runtime_authority_rows(
        session,  # type: ignore[arg-type]
        observed_stage='paper',
        started_at=datetime(2026, 5, 1, 12, 0),
        ended_at=datetime(2026, 5, 2, 12, 0, tzinfo=timezone.utc),
    )

    assert len(rows) == 1
    assert rows[0].row_id == 'row-00'
    assert rows[0].bucket_started_at.tzinfo is timezone.utc
    assert session.statement is not None


def test_runtime_authority_row_instances_are_accepted() -> None:
    dict_report = build_runtime_authority_report([_row(0)])
    row_payload = dict_report['trading_days'][0]
    assert row_payload['row_refs'] == ['row-00']

    row_data = _row(0)
    row = RuntimeAuthorityEvidenceRow(
        row_id=str(row_data['id']),
        run_id=str(row_data['run_id']),
        candidate_id=str(row_data['candidate_id']),
        hypothesis_id=str(row_data['hypothesis_id']),
        observed_stage=str(row_data['observed_stage']),
        bucket_started_at=row_data['bucket_started_at'],  # type: ignore[arg-type]
        bucket_ended_at=row_data['bucket_ended_at'],  # type: ignore[arg-type]
        account_label=str(row_data['account_label']),
        runtime_strategy_name=str(row_data['runtime_strategy_name']),
        strategy_family=str(row_data['strategy_family']),
        fill_count=20,
        decision_count=20,
        submitted_order_count=20,
        cancelled_order_count=0,
        rejected_order_count=0,
        unfilled_order_count=0,
        closed_trade_count=20,
        open_position_count=0,
        filled_notional=Decimal('600000'),
        gross_strategy_pnl=Decimal('610'),
        cost_amount=Decimal('10'),
        net_strategy_pnl_after_costs=Decimal('600'),
        post_cost_expectancy_bps=Decimal('10'),
        ledger_schema_version=EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        pnl_basis=POST_COST_PNL_BASIS,
        execution_policy_hash_counts={'policy-hash': 20},
        cost_model_hash_counts={'cost-hash': 20},
        lineage_hash_counts={'lineage-hash': 20},
        blockers=(),
        payload=row_data['payload'],  # type: ignore[arg-type]
    )
    object_report = build_runtime_authority_report([row])

    assert object_report['trading_days'][0]['row_refs'] == ['row-00']


def test_bad_runtime_bucket_surfaces_all_row_level_blockers() -> None:
    bad_row = _row(0)
    bad_row.update(
        {
            'fill_count': 0,
            'decision_count': 0,
            'submitted_order_count': 0,
            'closed_trade_count': 0,
            'filled_notional': Decimal('0'),
            'ledger_schema_version': 'synthetic-schema',
            'pnl_basis': 'gross_only',
            'execution_policy_hash_counts': {},
            'cost_model_hash_counts': {},
            'lineage_hash_counts': {'lineage-hash': 0},
            'blockers': ['source_bucket_has_prior_blocker'],
            'payload': {
                **_source_payload(0),
                'cost_basis': 'execution_reconstructed_non_promotion_grade',
            },
        }
    )

    report = build_runtime_authority_report([bad_row])
    blockers = set(report['blockers'])

    assert AUTHORITY_BUCKET_BLOCKERS_PRESENT in blockers
    assert AUTHORITY_LEDGER_SCHEMA_BLOCKER in blockers
    assert AUTHORITY_PNL_BASIS_BLOCKER in blockers
    assert AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER in blockers
    assert AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER in blockers
    assert AUTHORITY_ORDER_LIFECYCLE_MISSING_BLOCKER in blockers
    assert AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER in blockers
    assert AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER in blockers
    assert AUTHORITY_EXPLICIT_COSTS_BLOCKER in blockers
    assert AUTHORITY_POLICY_HASH_BLOCKER in blockers
    assert AUTHORITY_COST_MODEL_HASH_BLOCKER in blockers
    assert AUTHORITY_LINEAGE_HASH_BLOCKER in blockers


def test_source_refs_accept_mapping_and_scalar_offset_forms() -> None:
    row = _row(0)
    row['payload'] = {
        **_source_payload(0),
        'source_refs': {'trade_decisions': True, 'ignored': False, 'executions': 'custom-exec-ref'},
        'source_window_ids': {'primary': True, 'secondary': 'window-explicit'},
        'trade_decision_ids': {'one': 'decision-explicit'},
        'execution_ids': {'execution-explicit': True},
        'execution_order_event_ids': {'event': None, 'event-explicit': True},
        'source_offsets': {'topic': 'alpaca.trade_updates', 'partition': 0, 'offset': 123},
    }
    scalar_offset_row = _row(1)
    scalar_offset_payload = _source_payload(1)
    scalar_offset_payload.pop('source_offsets')
    scalar_offset_payload.update({'source_topic': 'alpaca.trade_updates', 'source_partition': 0, 'source_offset': 456})
    scalar_offset_row['payload'] = scalar_offset_payload

    report = build_runtime_authority_report([row, scalar_offset_row])
    daily = report['trading_days'][0]
    scalar_daily = report['trading_days'][1]

    assert daily['source_ref_count'] == 2
    assert daily['source_window_id_count'] == 2
    assert daily['trade_decision_ref_count'] == 1
    assert daily['execution_ref_count'] == 1
    assert daily['execution_order_event_ref_count'] == 1
    assert daily['source_offset_count'] == 1
    assert scalar_daily['source_offset_count'] == 1


def test_invalid_normalized_values_fail_closed() -> None:
    row = _row(0)
    row.update(
        {
            'bucket_started_at': 'not-a-date',
            'bucket_ended_at': '2026-05-01T21:00:00Z',
        }
    )

    with pytest.raises(ValueError, match='bucket_started_at_invalid'):
        build_runtime_authority_report([row])

    invalid_number_row = _row(0)
    invalid_number_row.update(
        {
            'fill_count': 'not-an-int',
            'net_strategy_pnl_after_costs': 'not-a-decimal',
            'post_cost_expectancy_bps': 'not-a-decimal',
        }
    )

    report = build_runtime_authority_report([invalid_number_row])

    assert report['aggregate']['mean_daily_net_pnl_after_costs'] == '0'
    assert AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER in report['blockers']


def test_source_backed_too_few_days_is_blocked() -> None:
    report = build_runtime_authority_report([_row(day) for day in range(5)])

    assert report['final_authority_ok'] is False
    assert AUTHORITY_TRADING_DAYS_BLOCKER in report['blockers']
    assert report['aggregate']['trading_day_count'] == 5


def test_open_positions_are_blocked() -> None:
    rows = [_row(day) for day in range(20)]
    rows[-1] = _row(19, open_positions=1)

    report = build_runtime_authority_report(rows)

    assert report['final_authority_ok'] is False
    assert AUTHORITY_OPEN_POSITIONS_BLOCKER in report['blockers']
    assert report['aggregate']['open_position_count'] == 1


def test_distribution_risk_gates_are_blocked() -> None:
    rows = [_row(day, pnl='600') for day in range(20)]
    rows[0] = _row(0, pnl='8000')
    rows[1] = _row(1, pnl='-1200')
    rows[2] = _row(2, pnl='-500')
    for day in range(3, 20):
        rows[day] = _row(day, pnl='100')

    report = build_runtime_authority_report(rows)

    blockers = set(report['blockers'])
    assert report['final_authority_ok'] is False
    assert AUTHORITY_MEAN_PNL_BLOCKER in blockers
    assert AUTHORITY_P10_PNL_BLOCKER in blockers
    assert AUTHORITY_WORST_DAY_BLOCKER in blockers
    assert AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER in blockers
    assert report['aggregate']['max_drawdown'] == '1700'


def test_row_level_runtime_authority_blockers_are_reported() -> None:
    row = _row(0)
    row.update(
        {
            'fill_count': 0,
            'decision_count': 0,
            'submitted_order_count': 0,
            'closed_trade_count': 0,
            'open_position_count': 1,
            'filled_notional': 0,
            'ledger_schema_version': 'artifact-only',
            'pnl_basis': 'gross_strategy_pnl',
            'execution_policy_hash_counts': {},
            'cost_model_hash_counts': {},
            'lineage_hash_counts': {},
            'blockers': ['upstream_bucket_blocker'],
            'payload': {
                **_source_payload(0),
                'cost_basis': 'synthetic_estimated_costs',
                'cost_basis_counts': {'synthetic_estimated_costs': 1},
            },
        }
    )

    report = build_runtime_authority_report([row])

    blockers = set(report['blockers'])
    assert AUTHORITY_BUCKET_BLOCKERS_PRESENT in blockers
    assert AUTHORITY_LEDGER_SCHEMA_BLOCKER in blockers
    assert AUTHORITY_PNL_BASIS_BLOCKER in blockers
    assert AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER in blockers
    assert AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER in blockers
    assert AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER in blockers
    assert AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER in blockers
    assert AUTHORITY_EXPLICIT_COSTS_BLOCKER in blockers
    assert AUTHORITY_POLICY_HASH_BLOCKER in blockers
    assert AUTHORITY_COST_MODEL_HASH_BLOCKER in blockers
    assert AUTHORITY_LINEAGE_HASH_BLOCKER in blockers
    assert 'upstream_bucket_blocker' in blockers


def test_ref_counting_accepts_mapping_and_scalar_offset_shapes() -> None:
    row = _row(0)
    payload = _source_payload(0)
    payload.update(
        {
            'source_window_ids': {'window-a': True, 'window-b': False, 'window-c': 'window-c-alias'},
            'trade_decision_ids': {'decision-a': True, 'decision-b': 'decision-b-alias'},
            'execution_ids': {'execution-a': True},
            'execution_order_event_ids': {'event-a': True},
            'source_refs': {'orders': True, 'ignored': False},
            'source_offsets': {'topic': 'alpaca.trade_updates', 'partition': 0, 'offset': 33},
        }
    )
    row['payload'] = payload

    report = build_runtime_authority_report([row])
    day = cast(dict[str, object], report['trading_days'][0])

    assert day['source_window_id_count'] == 2
    assert day['trade_decision_ref_count'] == 2
    assert day['execution_ref_count'] == 1
    assert day['execution_order_event_ref_count'] == 1
    assert day['source_ref_count'] == 1
    assert day['source_offset_count'] == 1


def test_dataclass_rows_and_invalid_scalar_values_normalize_fail_closed() -> None:
    row = RuntimeAuthorityEvidenceRow(
        row_id='dataclass-row',
        run_id='runtime-run',
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        observed_stage='paper',
        bucket_started_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
        bucket_ended_at=datetime(2026, 5, 1, 6, tzinfo=timezone.utc),
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        strategy_family='pairs',
        fill_count=20,
        decision_count=20,
        submitted_order_count=20,
        cancelled_order_count=0,
        rejected_order_count=0,
        unfilled_order_count=0,
        closed_trade_count=20,
        open_position_count=0,
        filled_notional=Decimal('600000'),
        gross_strategy_pnl=Decimal('610'),
        cost_amount=Decimal('10'),
        net_strategy_pnl_after_costs=Decimal('0'),
        post_cost_expectancy_bps=None,
        ledger_schema_version=EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        pnl_basis=POST_COST_PNL_BASIS,
        execution_policy_hash_counts={'policy': 'not-a-number'},
        cost_model_hash_counts={'cost': '1'},
        lineage_hash_counts={'lineage': '1'},
        blockers=(),
        payload=_source_payload(0),
    )

    report = build_runtime_authority_report([row])

    assert report['final_authority_ok'] is False
    assert AUTHORITY_POLICY_HASH_BLOCKER in report['blockers']
    assert report['aggregate']['total_net_strategy_pnl_after_costs'] == '0'


def test_invalid_mapping_timestamps_are_rejected() -> None:
    row = _row(0)
    row['bucket_started_at'] = 'not-a-timestamp'

    with pytest.raises(ValueError, match='bucket_started_at_invalid'):
        build_runtime_authority_report([row])


def test_load_runtime_authority_rows_filters_and_normalizes_bucket() -> None:
    class ScalarResult:
        def __init__(self, bucket: SimpleNamespace) -> None:
            self.bucket = bucket

        def all(self) -> list[SimpleNamespace]:
            return [self.bucket]

    class FakeSession:
        statement: object | None = None

        def __init__(self, bucket: SimpleNamespace) -> None:
            self.bucket = bucket

        def scalars(self, statement: object) -> ScalarResult:
            self.statement = statement
            return ScalarResult(self.bucket)

    start = datetime(2026, 5, 1, tzinfo=timezone.utc)
    bucket = SimpleNamespace(
        id='bucket-1',
        run_id='runtime-run',
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        observed_stage='paper',
        bucket_started_at=start,
        bucket_ended_at=start + timedelta(hours=6),
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        strategy_family='pairs',
        fill_count='2',
        decision_count='2',
        submitted_order_count='2',
        cancelled_order_count=0,
        rejected_order_count=0,
        unfilled_order_count=0,
        closed_trade_count=1,
        open_position_count=0,
        filled_notional='1000.50',
        gross_strategy_pnl='11',
        cost_amount='1',
        net_strategy_pnl_after_costs='10',
        post_cost_expectancy_bps='8',
        ledger_schema_version=EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        pnl_basis=POST_COST_PNL_BASIS,
        execution_policy_hash_counts={'policy': 1},
        cost_model_hash_counts={'cost': 1},
        lineage_hash_counts={'lineage': 1},
        blockers_json=['stored_blocker'],
        payload_json={**_source_payload(0), 'blockers': ['payload_blocker']},
        created_at=start,
    )
    session = FakeSession(bucket)

    rows = load_runtime_authority_rows(
        cast(Session, session),
        observed_stage='paper',
        started_at=start,
        ended_at=start + timedelta(days=1),
    )

    assert session.statement is not None
    assert rows[0].row_id == 'bucket-1'
    assert rows[0].filled_notional == Decimal('1000.50')
    assert rows[0].blockers == ('stored_blocker', 'payload_blocker')


def test_positive_20_day_source_backed_distribution_passes_thresholds() -> None:
    report = build_runtime_authority_report([_row(day) for day in range(20)])

    assert report['final_authority_ok'] is True
    assert report['blockers'] == []
    assert report['aggregate']['trading_day_count'] == 20
    assert report['aggregate']['mean_daily_net_pnl_after_costs'] == '600'
    assert report['aggregate']['median_daily_net_pnl_after_costs'] == '600'
    assert report['aggregate']['p10_daily_net_pnl_after_costs'] == '600'
    assert report['aggregate']['worst_day_net_pnl_after_costs'] == '600'
    assert report['aggregate']['best_day_share'] == '0.05'
    assert report['aggregate']['total_filled_notional'] == '12000000'
    assert report['aggregate']['closed_round_trips'] == 400


def test_output_is_stable_json() -> None:
    report = build_runtime_authority_report([_row(day) for day in range(20)])
    encoded = runtime_authority_report_json(report)

    assert encoded == runtime_authority_report_json(report)
    decoded = json.loads(encoded)
    assert list(decoded) == sorted(decoded)
    assert decoded['schema_version'] == 'torghut.hpairs-runtime-authority-proof.v1'


def test_cli_parses_window_filters_and_fail_on_blockers(capsys) -> None:  # type: ignore[no-untyped-def]
    class FakeSession:
        def __enter__(self) -> 'FakeSession':
            return self

        def __exit__(self, exc_type, exc, traceback) -> None:  # type: ignore[no-untyped-def]
            return None

    with (
        patch.object(cli, 'SessionLocal', return_value=FakeSession()),
        patch.object(cli, 'load_runtime_authority_rows', return_value=[]) as load_rows,
    ):
        exit_code = cli.main(
            [
                '--mode',
                'authority',
                '--observed-stage',
                'paper',
                '--start',
                '2026-05-01T14:30:00',
                '--end',
                '2026-05-02T21:00:00Z',
                '--fail-on-blockers',
            ]
        )

    assert exit_code == 1
    kwargs = load_rows.call_args.kwargs
    assert kwargs['observed_stage'] == 'paper'
    assert kwargs['started_at'] == datetime(2026, 5, 1, 14, 30, tzinfo=timezone.utc)
    assert kwargs['ended_at'] == datetime(2026, 5, 2, 21, tzinfo=timezone.utc)
    payload = json.loads(capsys.readouterr().out)
    assert payload['final_authority_ok'] is False


def test_cli_reports_database_read_errors(capsys) -> None:  # type: ignore[no-untyped-def]
    with patch.object(cli, 'SessionLocal', side_effect=SQLAlchemyError('db unavailable')):
        exit_code = cli.main(['--fail-on-blockers'])

    assert exit_code == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload['evidence_read_error'] == 'db unavailable'
    assert AUTHORITY_READ_ERROR_BLOCKER in payload['blockers']


def test_cli_emits_read_only_report_from_session_fixture(capsys) -> None:  # type: ignore[no-untyped-def]
    class FakeSession:
        def __enter__(self) -> 'FakeSession':
            return self

        def __exit__(self, exc_type, exc, traceback) -> None:  # type: ignore[no-untyped-def]
            return None

    with (
        patch.object(cli, 'SessionLocal', return_value=FakeSession()) as session_local,
        patch.object(cli, 'load_runtime_authority_rows', return_value=[_row(day) for day in range(20)]) as load_rows,
    ):
        exit_code = cli.main([])

    assert exit_code == 0
    session_local.assert_called_once_with()
    load_rows.assert_called_once()
    payload = json.loads(capsys.readouterr().out)
    assert payload['final_authority_ok'] is True


def test_cli_parses_window_arguments_and_fails_on_blockers(capsys) -> None:  # type: ignore[no-untyped-def]
    class FakeSession:
        def __enter__(self) -> 'FakeSession':
            return self

        def __exit__(self, exc_type, exc, traceback) -> None:  # type: ignore[no-untyped-def]
            return None

    with (
        patch.object(cli, 'SessionLocal', return_value=FakeSession()),
        patch.object(cli, 'load_runtime_authority_rows', return_value=[]),
    ):
        exit_code = cli.main(
            [
                '--observed-stage',
                'paper',
                '--start',
                '2026-05-01T09:30:00',
                '--end',
                '2026-05-02T16:00:00Z',
                '--fail-on-blockers',
            ]
        )

    assert exit_code == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload['identity']['observed_stage'] == 'paper'
    assert payload['window']['started_at'] == '2026-05-01T09:30:00Z'
    assert payload['window']['ended_at'] == '2026-05-02T16:00:00Z'


def test_cli_reports_read_error_as_blocker(capsys) -> None:  # type: ignore[no-untyped-def]
    class FakeSession:
        def __enter__(self) -> 'FakeSession':
            raise SQLAlchemyError('database unavailable')

        def __exit__(self, exc_type, exc, traceback) -> None:  # type: ignore[no-untyped-def]
            return None

    with patch.object(cli, 'SessionLocal', return_value=FakeSession()):
        exit_code = cli.main([])

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert AUTHORITY_READ_ERROR_BLOCKER in payload['blockers']
    assert payload['evidence_read_error'] == 'database unavailable'
