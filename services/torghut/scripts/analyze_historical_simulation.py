#!/usr/bin/env python3
"""Generate a production-ready statistical report for a historical simulation run."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

import psycopg
from psycopg import rows

from scripts.start_historical_simulation import (
    ClickHouseRuntimeConfig,
    _as_mapping,
    _as_text,
    _build_clickhouse_runtime_config,
    _build_postgres_runtime_config,
    _build_resources,
    _http_clickhouse_query,
    _load_manifest,
    _normalize_run_token,
    _parse_rfc3339_timestamp,
    _resolve_window_bounds,
    _safe_float,
    _safe_int,
    _validate_window_policy,
)

REPORT_SCHEMA_VERSION = 'torghut.simulation-report.v1'


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Analyze one historical simulation run and export metrics artifacts.',
    )
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--dataset-manifest', required=True)
    parser.add_argument('--simulation-dsn', default='')
    parser.add_argument('--clickhouse-http-url', default='')
    parser.add_argument('--clickhouse-username', default='')
    parser.add_argument('--clickhouse-password', default='')
    parser.add_argument('--output-dir', default='')
    parser.add_argument('--json', action='store_true', help='Emit compact JSON to stdout.')
    return parser.parse_args()


def _to_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return {str(k): item for k, item in value.items()}
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return {}
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError:
            return {}
        return _to_mapping(decoded)
    return {}


def _to_list_of_strings(value: Any) -> list[str]:
    if isinstance(value, list):
        values: list[str] = []
        for item in value:
            text = _as_text(item)
            if text:
                values.append(text)
        return values
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        return [stripped]
    return []


def _as_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        return Decimal(int(value))
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return Decimal(stripped)
        except Exception:
            return None
    return None


def _decimal_to_str(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(value, 'f')


def _json_default(value: object) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc).isoformat()
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, Decimal):
        return format(value, 'f')
    return str(value)


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    if percentile <= 0:
        return min(values)
    if percentile >= 100:
        return max(values)
    ordered = sorted(values)
    rank = (len(ordered) - 1) * (percentile / 100.0)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    if low == high:
        return ordered[low]
    fraction = rank - low
    return ordered[low] + (ordered[high] - ordered[low]) * fraction


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None
    if not isinstance(payload, Mapping):
        return None
    return {str(k): value for k, value in payload.items()}


def _parse_optional_ts(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return _parse_rfc3339_timestamp(value, label='timestamp')
    except SystemExit:
        return None


def _query_rows(conn: psycopg.Connection[Any], query: str) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=rows.dict_row) as cursor:
        cursor.execute(query)  # pyright: ignore[reportCallIssue]
        payload = cursor.fetchall()
    return [{str(k): v for k, v in item.items()} for item in payload]


def _extract_simulation_context(decision_json: Mapping[str, Any]) -> dict[str, Any]:
    params = _to_mapping(decision_json.get('params'))
    return _to_mapping(params.get('simulation_context'))


def _extract_signal_event_ts(decision_json: Mapping[str, Any]) -> datetime | None:
    context = _extract_simulation_context(decision_json)
    signal_event_ts = _parse_optional_ts(_as_text(context.get('signal_event_ts')))
    if signal_event_ts is not None:
        return signal_event_ts
    return _parse_optional_ts(_as_text(decision_json.get('event_ts')))


def _extract_run_scope_decisions(
    decisions: list[dict[str, Any]],
    *,
    run_id: str,
) -> list[dict[str, Any]]:
    with_context = [
        row
        for row in decisions
        if _as_text(_extract_simulation_context(_to_mapping(row.get('decision_json'))).get('simulation_run_id'))
    ]
    if not with_context:
        return decisions
    scoped = [
        row
        for row in with_context
        if _as_text(_extract_simulation_context(_to_mapping(row.get('decision_json'))).get('simulation_run_id')) == run_id
    ]
    return scoped


def _build_last_price_map(
    *,
    clickhouse_config: ClickHouseRuntimeConfig | None,
    clickhouse_db: str,
    tca_rows: list[dict[str, Any]],
    execution_rows: list[dict[str, Any]],
) -> dict[str, Decimal]:
    prices: dict[str, Decimal] = {}
    if clickhouse_config is not None and clickhouse_config.http_url:
        query = (
            f'SELECT symbol, toString(argMax(close, event_ts)) '
            f'FROM {clickhouse_db}.ta_microbars '
            f'GROUP BY symbol FORMAT TabSeparated'
        )
        try:
            status, body = _http_clickhouse_query(config=clickhouse_config, query=query)
        except Exception:
            status = 0
            body = ''
        if 200 <= status < 300 and body:
            for line in body.splitlines():
                parts = line.split('\t')
                if len(parts) != 2:
                    continue
                symbol = parts[0].strip()
                price = _as_decimal(parts[1])
                if symbol and price is not None:
                    prices[symbol] = price

    if not prices:
        for row in reversed(tca_rows):
            symbol = _as_text(row.get('symbol'))
            if not symbol or symbol in prices:
                continue
            avg_fill_price = _as_decimal(row.get('avg_fill_price'))
            arrival_price = _as_decimal(row.get('arrival_price'))
            if avg_fill_price is not None:
                prices[symbol] = avg_fill_price
            elif arrival_price is not None:
                prices[symbol] = arrival_price

    if not prices:
        for row in reversed(execution_rows):
            symbol = _as_text(row.get('symbol'))
            if not symbol or symbol in prices:
                continue
            avg_fill_price = _as_decimal(row.get('avg_fill_price'))
            if avg_fill_price is not None:
                prices[symbol] = avg_fill_price

    return prices


def _fifo_trade_pnl(
    executions: list[dict[str, Any]],
    *,
    last_prices: Mapping[str, Decimal],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    long_lots: dict[str, deque[dict[str, Decimal]]] = defaultdict(deque)
    short_lots: dict[str, deque[dict[str, Decimal]]] = defaultdict(deque)
    open_lot_count = 0
    realized_total = Decimal('0')
    execution_notional_total = Decimal('0')
    realized_by_symbol: dict[str, Decimal] = defaultdict(lambda: Decimal('0'))
    trade_rows: list[dict[str, Any]] = []

    for row in executions:
        symbol = _as_text(row.get('symbol'))
        side = (_as_text(row.get('side')) or '').lower()
        qty = _as_decimal(row.get('filled_qty'))
        price = _as_decimal(row.get('avg_fill_price'))
        if symbol is None or side not in {'buy', 'sell'} or qty is None or price is None:
            continue
        if qty <= 0:
            continue

        remaining = qty
        realized_for_execution = Decimal('0')
        execution_notional_total += qty * price

        if side == 'buy':
            shorts = short_lots[symbol]
            while remaining > 0 and shorts:
                lot = shorts[0]
                close_qty = min(remaining, lot['qty'])
                realized = (lot['price'] - price) * close_qty
                realized_total += realized
                realized_by_symbol[symbol] += realized
                realized_for_execution += realized
                lot['qty'] -= close_qty
                remaining -= close_qty
                if lot['qty'] <= 0:
                    shorts.popleft()
            if remaining > 0:
                long_lots[symbol].append({'qty': remaining, 'price': price})
        else:
            longs = long_lots[symbol]
            while remaining > 0 and longs:
                lot = longs[0]
                close_qty = min(remaining, lot['qty'])
                realized = (price - lot['price']) * close_qty
                realized_total += realized
                realized_by_symbol[symbol] += realized
                realized_for_execution += realized
                lot['qty'] -= close_qty
                remaining -= close_qty
                if lot['qty'] <= 0:
                    longs.popleft()
            if remaining > 0:
                short_lots[symbol].append({'qty': remaining, 'price': price})

        trade_rows.append(
            {
                'execution_id': str(row.get('id') or ''),
                'trade_decision_id': str(row.get('trade_decision_id') or ''),
                'symbol': symbol,
                'side': side,
                'filled_qty': _decimal_to_str(qty),
                'avg_fill_price': _decimal_to_str(price),
                'realized_pnl_contribution': _decimal_to_str(realized_for_execution),
                'created_at': str(row.get('created_at') or ''),
            }
        )

    unrealized_total = Decimal('0')
    for symbol, lots in long_lots.items():
        last = last_prices.get(symbol)
        if last is None:
            continue
        for lot in lots:
            unrealized_total += (last - lot['price']) * lot['qty']
            open_lot_count += 1
    for symbol, lots in short_lots.items():
        last = last_prices.get(symbol)
        if last is None:
            continue
        for lot in lots:
            unrealized_total += (lot['price'] - last) * lot['qty']
            open_lot_count += 1

    gross_total = realized_total + unrealized_total
    by_symbol_payload = [
        {
            'symbol': symbol,
            'realized_pnl': _decimal_to_str(value),
        }
        for symbol, value in sorted(realized_by_symbol.items())
    ]
    return (
        {
            'realized_pnl': realized_total,
            'unrealized_pnl': unrealized_total,
            'gross_pnl': gross_total,
            'execution_notional_total': execution_notional_total,
            'open_lot_count': open_lot_count,
            'realized_by_symbol': by_symbol_payload,
        },
        trade_rows,
    )


def _csv_write(path: Path, rows_payload: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows_payload:
        path.write_text('', encoding='utf-8')
        return
    headers = sorted({key for row in rows_payload for key in row.keys()})
    with path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        for row in rows_payload:
            writer.writerow({key: row.get(key) for key in headers})


def _collect_clickhouse_stats(
    *,
    clickhouse_config: ClickHouseRuntimeConfig | None,
    clickhouse_db: str,
) -> dict[str, Any]:
    if clickhouse_config is None or not clickhouse_config.http_url:
        return {
            'enabled': False,
            'error': None,
            'tables': {},
        }
    query = (
        'SELECT table, toString(sum(rows)) '
        'FROM system.parts '
        f"WHERE active=1 AND database='{clickhouse_db}' "
        'GROUP BY table ORDER BY table FORMAT TabSeparated'
    )
    try:
        status, body = _http_clickhouse_query(config=clickhouse_config, query=query)
    except Exception as exc:
        return {
            'enabled': True,
            'error': f'clickhouse_query_failed:exception:{exc}',
            'tables': {},
        }
    if status < 200 or status >= 300:
        return {
            'enabled': True,
            'error': f'clickhouse_query_failed:{status}:{body[:160]}',
            'tables': {},
        }
    table_rows: dict[str, int] = {}
    for line in body.splitlines():
        parts = line.split('\t')
        if len(parts) != 2:
            continue
        table = parts[0].strip()
        row_count = _safe_int(parts[1], default=0)
        if table:
            table_rows[table] = row_count
    return {
        'enabled': True,
        'error': None,
        'tables': table_rows,
    }


def _render_markdown(report: Mapping[str, Any]) -> str:
    verdict = _as_text(report.get('verdict', {}).get('status')) if isinstance(report.get('verdict'), Mapping) else None
    pnl = _as_mapping(report.get('pnl'))
    funnel = _as_mapping(report.get('funnel'))
    llm = _as_mapping(report.get('llm'))
    execution_quality = _as_mapping(report.get('execution_quality'))
    coverage = _as_mapping(report.get('coverage'))

    return '\n'.join(
        [
            '# Simulation Report',
            '',
            f"- Schema: `{_as_text(report.get('schema_version'))}`",
            f"- Run ID: `{_as_text(_as_mapping(report.get('run_metadata')).get('run_id'))}`",
            f"- Verdict: `{verdict or 'unknown'}`",
            '',
            '## Coverage',
            '',
            f"- Target window minutes: `{coverage.get('target_window_minutes')}`",
            f"- Decision span minutes: `{coverage.get('decision_span_minutes')}`",
            f"- Dump span minutes: `{coverage.get('dump_span_minutes')}`",
            '',
            '## Funnel',
            '',
            f"- Decisions: `{funnel.get('trade_decisions')}`",
            f"- Executions: `{funnel.get('executions')}`",
            f"- Execution TCA samples: `{funnel.get('execution_tca_metrics')}`",
            f"- LLM reviews: `{funnel.get('llm_reviews')}`",
            '',
            '## PnL',
            '',
            f"- Gross PnL: `{pnl.get('gross_pnl')}`",
            f"- Net PnL (estimated): `{pnl.get('net_pnl_estimated')}`",
            f"- Realized PnL (FIFO): `{pnl.get('realized_pnl')}`",
            f"- Unrealized PnL: `{pnl.get('unrealized_pnl')}`",
            f"- TCA realized proxy: `{pnl.get('tca_realized_pnl_proxy_notional')}`",
            '',
            '## Execution Quality',
            '',
            f"- Fallback ratio: `{execution_quality.get('fallback_ratio')}`",
            f"- Adapter mismatch ratio: `{execution_quality.get('adapter_mismatch_ratio')}`",
            f"- Order event coverage ratio: `{execution_quality.get('order_event_coverage_ratio')}`",
            '',
            '## LLM',
            '',
            f"- Error rate: `{llm.get('error_rate')}`",
            f"- Avg confidence: `{llm.get('avg_confidence')}`",
            f"- Contribution rate: `{_as_mapping(llm.get('decision_contribution')).get('contribution_rate')}`",
        ]
    )


def _build_report(args: argparse.Namespace) -> dict[str, Any]:
    manifest_path = Path(args.dataset_manifest)
    manifest = _load_manifest(manifest_path)
    resources = _build_resources(args.run_id, manifest)
    run_token = _normalize_run_token(args.run_id)

    postgres_config = _build_postgres_runtime_config(
        manifest,
        simulation_db=f'torghut_sim_{run_token}',
    )
    if args.simulation_dsn:
        postgres_config = type(postgres_config)(
            admin_dsn=postgres_config.admin_dsn,
            simulation_dsn=args.simulation_dsn,
            simulation_db=postgres_config.simulation_db,
            migrations_command=postgres_config.migrations_command,
        )

    clickhouse_config_raw = _build_clickhouse_runtime_config(manifest)
    clickhouse_http_url = args.clickhouse_http_url.strip() or clickhouse_config_raw.http_url
    clickhouse_config: ClickHouseRuntimeConfig | None = None
    if clickhouse_http_url:
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url=clickhouse_http_url,
            username=args.clickhouse_username.strip() or clickhouse_config_raw.username,
            password=args.clickhouse_password if args.clickhouse_password else clickhouse_config_raw.password,
        )

    window_start, window_end = _resolve_window_bounds(manifest)
    window_policy = _validate_window_policy(manifest)
    strict_coverage_ratio = _safe_float(window_policy.get('strict_coverage_ratio'), default=0.95)

    output_dir = (
        Path(args.output_dir)
        if args.output_dir
        else resources.output_root / resources.run_token / 'report'
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    with psycopg.connect(postgres_config.simulation_dsn) as conn:
        decisions_all = _query_rows(
            conn,
            'SELECT id, strategy_id, symbol, status, created_at, executed_at, decision_json '
            'FROM trade_decisions ORDER BY created_at ASC',
        )
        decisions = _extract_run_scope_decisions(decisions_all, run_id=args.run_id)
        decision_ids = {str(row.get('id')) for row in decisions}

        executions_all = _query_rows(
            conn,
            'SELECT id, trade_decision_id, symbol, side, submitted_qty, filled_qty, avg_fill_price, status, '
            'created_at, last_update_at, order_feed_last_event_ts, execution_expected_adapter, '
            'execution_actual_adapter, execution_fallback_reason, execution_fallback_count '
            'FROM executions ORDER BY created_at ASC',
        )
        if decision_ids:
            executions = [
                row
                for row in executions_all
                if str(row.get('trade_decision_id') or '') in decision_ids
            ]
        else:
            executions = executions_all
        execution_ids = {str(row.get('id')) for row in executions}

        order_events_all = _query_rows(
            conn,
            'SELECT execution_id, event_ts, created_at, status, event_type FROM execution_order_events ORDER BY created_at ASC',
        )
        order_events_total = len(order_events_all)
        order_events_unlinked = sum(
            1
            for row in order_events_all
            if row.get('execution_id') is None
        )
        if execution_ids:
            order_events = [
                row
                for row in order_events_all
                if str(row.get('execution_id') or '') in execution_ids
            ]
        else:
            order_events = order_events_all

        tca_all = _query_rows(
            conn,
            'SELECT execution_id, trade_decision_id, strategy_id, symbol, side, filled_qty, avg_fill_price, '
            'arrival_price, shortfall_notional, slippage_bps, realized_shortfall_bps, divergence_bps, computed_at '
            'FROM execution_tca_metrics ORDER BY computed_at ASC',
        )
        if execution_ids:
            tca_rows = [
                row
                for row in tca_all
                if str(row.get('execution_id') or '') in execution_ids
            ]
        else:
            tca_rows = tca_all

        llm_reviews_all = _query_rows(
            conn,
            'SELECT id, trade_decision_id, model, prompt_version, verdict, confidence, tokens_prompt, '
            'tokens_completion, risk_flags, response_json, created_at '
            'FROM llm_decision_reviews ORDER BY created_at ASC',
        )
        if decision_ids:
            llm_reviews = [
                row
                for row in llm_reviews_all
                if str(row.get('trade_decision_id') or '') in decision_ids
            ]
        else:
            llm_reviews = llm_reviews_all

        trade_cursor_rows = _query_rows(
            conn,
            'SELECT source, account_label, cursor_at, cursor_seq, cursor_symbol FROM trade_cursor ORDER BY updated_at DESC',
        )

    decision_status_counts: Counter[str] = Counter()
    strategy_symbol_counts: Counter[tuple[str, str]] = Counter()
    signal_to_decision_ms: list[float] = []
    decision_ts_values: list[datetime] = []
    decisions_by_id: dict[str, dict[str, Any]] = {}

    for decision in decisions:
        decision_id = str(decision.get('id') or '')
        decisions_by_id[decision_id] = decision
        status = _as_text(decision.get('status')) or 'unknown'
        decision_status_counts[status] += 1
        strategy_symbol_counts[(str(decision.get('strategy_id') or ''), _as_text(decision.get('symbol')) or '')] += 1

        created_at = decision.get('created_at')
        decision_json = _to_mapping(decision.get('decision_json'))
        signal_ts = _extract_signal_event_ts(decision_json)
        if isinstance(created_at, datetime) and signal_ts is not None:
            signal_to_decision_ms.append((created_at - signal_ts).total_seconds() * 1000.0)
            decision_ts_values.append(signal_ts)

    execution_status_counts: Counter[str] = Counter()
    expected_actual_counts: Counter[tuple[str, str]] = Counter()
    fallback_reason_counts: Counter[str] = Counter()
    decision_to_submit_ms: list[float] = []
    submit_to_feed_update_ms: list[float] = []

    first_order_event_by_execution: dict[str, datetime] = {}
    for event in order_events:
        execution_id = str(event.get('execution_id') or '')
        event_ts = event.get('event_ts')
        created_at = event.get('created_at')
        resolved_ts: datetime | None = None
        if isinstance(event_ts, datetime):
            resolved_ts = event_ts
        elif isinstance(created_at, datetime):
            resolved_ts = created_at
        if execution_id and resolved_ts is not None:
            existing = first_order_event_by_execution.get(execution_id)
            if existing is None or resolved_ts < existing:
                first_order_event_by_execution[execution_id] = resolved_ts

    executions_with_events = 0
    fallback_executions = 0
    mismatch_executions = 0
    for execution in executions:
        execution_id = str(execution.get('id') or '')
        status = _as_text(execution.get('status')) or 'unknown'
        execution_status_counts[status] += 1

        expected_adapter = (_as_text(execution.get('execution_expected_adapter')) or 'unknown').lower()
        actual_adapter = (_as_text(execution.get('execution_actual_adapter')) or 'unknown').lower()
        expected_actual_counts[(expected_adapter, actual_adapter)] += 1
        if expected_adapter != actual_adapter:
            mismatch_executions += 1

        fallback_reason = _as_text(execution.get('execution_fallback_reason')) or ''
        fallback_count = _safe_int(execution.get('execution_fallback_count'))
        if fallback_reason:
            fallback_reason_counts[fallback_reason] += 1
        fallback_applied = bool(fallback_reason or fallback_count > 0 or expected_adapter != actual_adapter)
        if fallback_applied:
            fallback_executions += 1

        created_at = execution.get('created_at')
        if isinstance(created_at, datetime):
            decision_id = str(execution.get('trade_decision_id') or '')
            decision = decisions_by_id.get(decision_id)
            if decision is not None and isinstance(decision.get('created_at'), datetime):
                decision_created_at = decision['created_at']
                decision_to_submit_ms.append((created_at - decision_created_at).total_seconds() * 1000.0)

            first_update = first_order_event_by_execution.get(execution_id)
            if first_update is not None:
                executions_with_events += 1
                submit_to_feed_update_ms.append((first_update - created_at).total_seconds() * 1000.0)
            elif isinstance(execution.get('order_feed_last_event_ts'), datetime):
                order_feed_last_event_ts = execution['order_feed_last_event_ts']
                submit_to_feed_update_ms.append((order_feed_last_event_ts - created_at).total_seconds() * 1000.0)

    latency_rows: list[dict[str, Any]] = []
    for execution in executions:
        execution_id = str(execution.get('id') or '')
        decision_id = str(execution.get('trade_decision_id') or '')
        decision = decisions_by_id.get(decision_id)
        created_at = execution.get('created_at')
        signal_to_decision_value: float | None = None
        decision_to_submit_value: float | None = None
        submit_to_first_update_value: float | None = None
        if decision is not None and isinstance(decision.get('created_at'), datetime):
            decision_created_at = decision['created_at']
            decision_json = _to_mapping(decision.get('decision_json'))
            signal_event_ts = _extract_signal_event_ts(decision_json)
            if signal_event_ts is not None:
                signal_to_decision_value = (decision_created_at - signal_event_ts).total_seconds() * 1000.0
            if isinstance(created_at, datetime):
                decision_to_submit_value = (created_at - decision_created_at).total_seconds() * 1000.0
        if isinstance(created_at, datetime):
            first_update = first_order_event_by_execution.get(execution_id)
            if first_update is not None:
                submit_to_first_update_value = (first_update - created_at).total_seconds() * 1000.0
        latency_rows.append(
            {
                'execution_id': execution_id,
                'trade_decision_id': decision_id,
                'symbol': _as_text(execution.get('symbol')),
                'signal_to_decision_ms': signal_to_decision_value,
                'decision_to_submit_ms': decision_to_submit_value,
                'submit_to_first_update_ms': submit_to_first_update_value,
            }
        )

    llm_verdict_counts: Counter[str] = Counter()
    llm_model_prompt_counts: Counter[tuple[str, str]] = Counter()
    llm_avg_confidence_values: list[float] = []
    llm_token_prompt = 0
    llm_token_completion = 0
    llm_risk_flag_counter: Counter[str] = Counter()
    llm_fallback_total = 0
    llm_deterministic_guardrail_total = 0
    llm_confidence_gap_values: list[float] = []

    llm_summary_rows: list[dict[str, Any]] = []

    for review in llm_reviews:
        verdict = (_as_text(review.get('verdict')) or 'unknown').lower()
        model = _as_text(review.get('model')) or 'unknown'
        prompt_version = _as_text(review.get('prompt_version')) or 'unknown'
        llm_verdict_counts[verdict] += 1
        llm_model_prompt_counts[(model, prompt_version)] += 1

        confidence = _safe_float(review.get('confidence'), default=-1)
        if confidence >= 0:
            llm_avg_confidence_values.append(confidence)
        llm_token_prompt += _safe_int(review.get('tokens_prompt'))
        llm_token_completion += _safe_int(review.get('tokens_completion'))

        for flag in _to_list_of_strings(review.get('risk_flags')):
            llm_risk_flag_counter[flag] += 1

        response_json = _to_mapping(review.get('response_json'))
        policy_override = _as_text(response_json.get('policy_override')) or ''
        fallback = (_as_text(response_json.get('fallback')) or '').lower()
        if '_fallback_' in policy_override or fallback in {'veto', 'pass_through'}:
            llm_fallback_total += 1
        if isinstance(response_json.get('deterministic_guardrails'), list):
            llm_deterministic_guardrail_total += 1

        calibrated = _to_mapping(response_json.get('calibrated_probabilities'))
        top_probability: float | None = None
        for probability_raw in calibrated.values():
            probability = _safe_float(probability_raw, default=-1)
            if probability < 0:
                continue
            if top_probability is None or probability > top_probability:
                top_probability = probability
        if top_probability is not None and confidence >= 0:
            llm_confidence_gap_values.append(abs(top_probability - confidence))

        llm_summary_rows.append(
            {
                'review_id': str(review.get('id') or ''),
                'trade_decision_id': str(review.get('trade_decision_id') or ''),
                'model': model,
                'prompt_version': prompt_version,
                'verdict': verdict,
                'confidence': confidence if confidence >= 0 else None,
                'tokens_prompt': _safe_int(review.get('tokens_prompt')),
                'tokens_completion': _safe_int(review.get('tokens_completion')),
            }
        )

    clickhouse_stats = _collect_clickhouse_stats(
        clickhouse_config=clickhouse_config,
        clickhouse_db=resources.clickhouse_db,
    )

    last_prices = _build_last_price_map(
        clickhouse_config=clickhouse_config,
        clickhouse_db=resources.clickhouse_db,
        tca_rows=tca_rows,
        execution_rows=executions,
    )
    pnl_summary_raw, trade_pnl_rows = _fifo_trade_pnl(executions, last_prices=last_prices)

    tca_shortfall_total = Decimal('0')
    tca_realized_shortfall_values: list[float] = []
    for row in tca_rows:
        shortfall = _as_decimal(row.get('shortfall_notional'))
        if shortfall is not None:
            tca_shortfall_total += shortfall
        realized_shortfall = _as_decimal(row.get('realized_shortfall_bps'))
        if realized_shortfall is not None:
            tca_realized_shortfall_values.append(float(realized_shortfall))

    reporting_cfg = _as_mapping(manifest.get('reporting'))
    commission_bps = _as_decimal(reporting_cfg.get('commission_bps')) or Decimal('0')
    per_trade_fee = _as_decimal(reporting_cfg.get('per_trade_fee')) or Decimal('0')

    execution_notional_total = pnl_summary_raw['execution_notional_total']
    commission_cost = (execution_notional_total * commission_bps) / Decimal('10000')
    per_trade_cost_total = per_trade_fee * Decimal(len(trade_pnl_rows))
    estimated_cost_total = commission_cost + per_trade_cost_total
    gross_pnl = pnl_summary_raw['gross_pnl']
    net_pnl_estimated = gross_pnl - estimated_cost_total

    tca_realized_pnl_proxy_notional = -tca_shortfall_total

    target_window_minutes = (window_end - window_start).total_seconds() / 60.0
    decision_span_minutes: float | None = None
    if decision_ts_values:
        decision_span_minutes = (
            (max(decision_ts_values) - min(decision_ts_values)).total_seconds() / 60.0
        )

    dump_span_minutes: float | None = None
    dump_min_ts: datetime | None = None
    dump_max_ts: datetime | None = None
    run_dir = resources.output_root / resources.run_token
    run_manifest = _load_json(run_dir / 'run-manifest.json')
    if run_manifest is not None:
        dump_payload = _as_mapping(run_manifest.get('dump'))
        min_ms = dump_payload.get('min_source_timestamp_ms')
        max_ms = dump_payload.get('max_source_timestamp_ms')
        if min_ms is not None and max_ms is not None:
            min_ts_ms = _safe_int(min_ms, default=-1)
            max_ts_ms = _safe_int(max_ms, default=-1)
            if min_ts_ms >= 0 and max_ts_ms >= min_ts_ms:
                dump_min_ts = datetime.fromtimestamp(min_ts_ms / 1000.0, tz=timezone.utc)
                dump_max_ts = datetime.fromtimestamp(max_ts_ms / 1000.0, tz=timezone.utc)
                dump_span_minutes = (max_ts_ms - min_ts_ms) / 60_000.0

    coverage_ratio: float | None = None
    if dump_span_minutes is not None and target_window_minutes > 0:
        coverage_ratio = dump_span_minutes / target_window_minutes

    funnel = {
        'trade_decisions': len(decisions),
        'executions': len(executions),
        'execution_order_events': len(order_events),
        'execution_order_events_total': order_events_total,
        'execution_order_events_unlinked': order_events_unlinked,
        'execution_tca_metrics': len(tca_rows),
        'llm_reviews': len(llm_reviews),
        'decision_status_counts': dict(sorted(decision_status_counts.items())),
        'decision_to_execution_rate': (
            (len(executions) / len(decisions)) if decisions else 0.0
        ),
        'decision_strategy_symbol_counts': [
            {
                'strategy_id': strategy_id,
                'symbol': symbol,
                'count': count,
            }
            for (strategy_id, symbol), count in sorted(strategy_symbol_counts.items())
        ],
    }

    execution_quality = {
        'execution_status_counts': dict(sorted(execution_status_counts.items())),
        'expected_actual_adapter_counts': [
            {
                'expected_adapter': expected,
                'actual_adapter': actual,
                'count': count,
            }
            for (expected, actual), count in sorted(expected_actual_counts.items())
        ],
        'fallback_reason_counts': dict(sorted(fallback_reason_counts.items())),
        'fallback_execution_count': fallback_executions,
        'fallback_ratio': (fallback_executions / len(executions)) if executions else 0.0,
        'adapter_mismatch_count': mismatch_executions,
        'adapter_mismatch_ratio': (mismatch_executions / len(executions)) if executions else 0.0,
        'executions_with_order_events': executions_with_events,
        'order_event_coverage_ratio': (
            (executions_with_events / len(executions)) if executions else 0.0
        ),
        'unlinked_order_event_count': order_events_unlinked,
        'unlinked_order_event_ratio': (
            (order_events_unlinked / order_events_total) if order_events_total else 0.0
        ),
        'latency_ms': {
            'signal_to_decision_p50': _percentile(signal_to_decision_ms, 50),
            'signal_to_decision_p95': _percentile(signal_to_decision_ms, 95),
            'decision_to_submit_p50': _percentile(decision_to_submit_ms, 50),
            'decision_to_submit_p95': _percentile(decision_to_submit_ms, 95),
            'submit_to_first_update_p50': _percentile(submit_to_feed_update_ms, 50),
            'submit_to_first_update_p95': _percentile(submit_to_feed_update_ms, 95),
        },
    }

    llm_total = len(llm_reviews)
    llm_error_count = llm_verdict_counts.get('error', 0)
    llm = {
        'total_reviews': llm_total,
        'error_count': llm_error_count,
        'error_rate': (llm_error_count / llm_total) if llm_total else 0.0,
        'avg_confidence': _mean(llm_avg_confidence_values),
        'verdict_counts': dict(sorted(llm_verdict_counts.items())),
        'by_model_prompt': [
            {
                'model': model,
                'prompt_version': prompt_version,
                'count': count,
            }
            for (model, prompt_version), count in sorted(llm_model_prompt_counts.items())
        ],
        'tokens': {
            'prompt': llm_token_prompt,
            'completion': llm_token_completion,
            'total': llm_token_prompt + llm_token_completion,
        },
        'top_risk_flags': [
            {
                'flag': flag,
                'count': count,
            }
            for flag, count in llm_risk_flag_counter.most_common(10)
        ],
        'decision_contribution': {
            'fallback_total': llm_fallback_total,
            'fallback_rate': (llm_fallback_total / llm_total) if llm_total else 0.0,
            'deterministic_guardrail_total': llm_deterministic_guardrail_total,
            'deterministic_guardrail_rate': (
                (llm_deterministic_guardrail_total / llm_total) if llm_total else 0.0
            ),
            'contribution_events': (
                llm_verdict_counts.get('veto', 0)
                + llm_verdict_counts.get('adjust', 0)
                + llm_verdict_counts.get('abstain', 0)
                + llm_verdict_counts.get('escalate', 0)
            ),
            'contribution_rate': (
                (
                    llm_verdict_counts.get('veto', 0)
                    + llm_verdict_counts.get('adjust', 0)
                    + llm_verdict_counts.get('abstain', 0)
                    + llm_verdict_counts.get('escalate', 0)
                )
                / llm_total
                if llm_total
                else 0.0
            ),
        },
        'calibration': {
            'mean_confidence_gap': _mean(llm_confidence_gap_values),
            'samples': len(llm_confidence_gap_values),
        },
    }

    coverage = {
        'window_start': window_start.isoformat(),
        'window_end': window_end.isoformat(),
        'target_window_minutes': target_window_minutes,
        'decision_signal_min_ts': min(decision_ts_values).isoformat() if decision_ts_values else None,
        'decision_signal_max_ts': max(decision_ts_values).isoformat() if decision_ts_values else None,
        'decision_span_minutes': decision_span_minutes,
        'dump_signal_min_ts': dump_min_ts.isoformat() if dump_min_ts is not None else None,
        'dump_signal_max_ts': dump_max_ts.isoformat() if dump_max_ts is not None else None,
        'dump_span_minutes': dump_span_minutes,
        'window_coverage_ratio_from_dump': coverage_ratio,
    }

    stability_anomalies: list[str] = []
    if len(decisions) == 0:
        stability_anomalies.append('no_trade_decisions')
    if len(executions) == 0:
        stability_anomalies.append('no_executions')
    if len(executions) > 0 and len(order_events) == 0:
        stability_anomalies.append('no_execution_order_events')
    if coverage_ratio is not None and coverage_ratio < strict_coverage_ratio:
        stability_anomalies.append('dump_coverage_below_95pct')
    if llm_total > 0 and llm['error_rate'] > 0.05:
        stability_anomalies.append('llm_error_rate_above_5pct')
    if execution_quality['fallback_ratio'] > 0.2:
        stability_anomalies.append('execution_fallback_ratio_above_20pct')

    stability = {
        'anomalies': stability_anomalies,
        'clickhouse': clickhouse_stats,
        'trade_cursor_rows': trade_cursor_rows,
    }

    monitor_cfg = _as_mapping(manifest.get('monitor'))
    min_decisions = _safe_int(monitor_cfg.get('min_trade_decisions'), default=1)
    min_executions = _safe_int(monitor_cfg.get('min_executions'), default=1)

    fail_reasons: list[str] = []
    warn_reasons: list[str] = []
    if len(decisions) < min_decisions:
        fail_reasons.append('trade_decisions_below_minimum')
    if len(executions) < min_executions:
        fail_reasons.append('executions_below_minimum')
    if coverage_ratio is not None and coverage_ratio < strict_coverage_ratio:
        fail_reasons.append('window_coverage_ratio_below_95pct')

    if len(executions) > 0 and len(order_events) == 0:
        warn_reasons.append('execution_order_events_missing')
    if len(executions) > 0 and len(order_events) == 0 and order_events_total > 0:
        warn_reasons.append('execution_order_events_unlinked')
    if execution_quality['adapter_mismatch_ratio'] > 0:
        warn_reasons.append('execution_adapter_mismatch_detected')
    if llm_total > 0 and llm['error_rate'] > 0.05:
        warn_reasons.append('llm_error_rate_above_threshold')

    verdict_status = 'PASS'
    if fail_reasons:
        verdict_status = 'FAIL'
    elif warn_reasons:
        verdict_status = 'WARN'

    verdict = {
        'status': verdict_status,
        'fail_reasons': fail_reasons,
        'warn_reasons': warn_reasons,
    }

    pnl = {
        'realized_pnl': _decimal_to_str(pnl_summary_raw['realized_pnl']),
        'unrealized_pnl': _decimal_to_str(pnl_summary_raw['unrealized_pnl']),
        'gross_pnl': _decimal_to_str(gross_pnl),
        'commission_bps': _decimal_to_str(commission_bps),
        'per_trade_fee': _decimal_to_str(per_trade_fee),
        'estimated_cost_total': _decimal_to_str(estimated_cost_total),
        'net_pnl_estimated': _decimal_to_str(net_pnl_estimated),
        'execution_notional_total': _decimal_to_str(execution_notional_total),
        'tca_shortfall_notional_total': _decimal_to_str(tca_shortfall_total),
        'tca_realized_pnl_proxy_notional': _decimal_to_str(tca_realized_pnl_proxy_notional),
        'avg_realized_shortfall_bps': _mean(tca_realized_shortfall_values),
        'open_lot_count': pnl_summary_raw['open_lot_count'],
        'realized_by_symbol': pnl_summary_raw['realized_by_symbol'],
    }

    run_metadata = {
        'run_id': args.run_id,
        'run_token': run_token,
        'dataset_id': resources.dataset_id,
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'manifest_path': str(manifest_path),
        'simulation_db': postgres_config.simulation_db,
        'clickhouse_db': resources.clickhouse_db,
    }

    report = {
        'schema_version': REPORT_SCHEMA_VERSION,
        'run_metadata': run_metadata,
        'window_policy': window_policy,
        'coverage': coverage,
        'funnel': funnel,
        'execution_quality': execution_quality,
        'pnl': pnl,
        'llm': llm,
        'stability': stability,
        'verdict': verdict,
        'artifacts': {
            'run_dir': str(run_dir),
            'report_dir': str(output_dir),
            'run_manifest_path': str(run_dir / 'run-manifest.json'),
            'trade_pnl_csv': str(output_dir / 'trade-pnl.csv'),
            'execution_latency_csv': str(output_dir / 'execution-latency.csv'),
            'llm_review_summary_csv': str(output_dir / 'llm-review-summary.csv'),
        },
        'caveats': [
            {
                'code': 'pnl_estimation_limits',
                'message': 'gross/net pnl values are derived from execution fills and latest available prices; they are not a broker statement.',
            },
            {
                'code': 'tca_proxy_limits',
                'message': 'tca_realized_pnl_proxy_notional is derived from shortfall notional and excludes full portfolio mark-to-market effects.',
            },
        ],
    }

    _csv_write(output_dir / 'trade-pnl.csv', trade_pnl_rows)
    _csv_write(output_dir / 'execution-latency.csv', latency_rows)
    _csv_write(output_dir / 'llm-review-summary.csv', llm_summary_rows)

    report_json_path = output_dir / 'simulation-report.json'
    report_md_path = output_dir / 'simulation-report.md'
    report_json_path.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=_json_default),
        encoding='utf-8',
    )
    report_md_path.write_text(_render_markdown(report), encoding='utf-8')
    return report


def main() -> None:
    args = _parse_args()
    report = _build_report(args)
    if args.json:
        print(json.dumps(report, sort_keys=True, separators=(',', ':'), default=_json_default))
        return
    print(json.dumps(report, indent=2, sort_keys=True, default=_json_default))


if __name__ == '__main__':
    main()
