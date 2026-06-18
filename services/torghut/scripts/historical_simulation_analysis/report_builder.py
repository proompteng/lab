#!/usr/bin/env python3
"""Generate a production-ready statistical report for a historical simulation run."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg

from scripts.start_historical_simulation import (
    ClickHouseRuntimeConfig,
    _as_mapping,
    _as_text,
    _build_clickhouse_runtime_config,
    _build_postgres_runtime_config,
    _build_resources,
    _default_simulation_postgres_db,
    _load_manifest,
    _resolve_window_bounds,
    _safe_float,
    _safe_int,
    _validate_window_policy,
)

from .report_helpers import (
    REPORT_SCHEMA_VERSION,
    _as_decimal,
    _build_last_price_map,
    _collect_clickhouse_stats,
    _csv_write,
    _decimal_to_str,
    _extract_run_scope_decisions,
    _extract_signal_event_ts,
    _fifo_trade_pnl,
    _json_default,
    _load_json,
    _mean,
    _parse_args,
    _percentile,
    _query_rows,
    _render_markdown,
    _to_list_of_strings,
    _to_mapping,
)


def _build_report(args: argparse.Namespace) -> dict[str, Any]:
    manifest_path = Path(args.dataset_manifest)
    manifest = _load_manifest(manifest_path)
    resources = _build_resources(args.run_id, manifest)
    postgres_config = _build_postgres_runtime_config(
        manifest,
        simulation_db=_default_simulation_postgres_db(resources),
    )
    if args.simulation_dsn:
        postgres_config = type(postgres_config)(
            admin_dsn=postgres_config.admin_dsn,
            simulation_dsn=args.simulation_dsn,
            simulation_db=postgres_config.simulation_db,
            migrations_command=postgres_config.migrations_command,
        )

    clickhouse_config_raw = _build_clickhouse_runtime_config(manifest)
    clickhouse_http_url = (
        args.clickhouse_http_url.strip() or clickhouse_config_raw.http_url
    )
    clickhouse_config: ClickHouseRuntimeConfig | None = None
    if clickhouse_http_url:
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url=clickhouse_http_url,
            username=args.clickhouse_username.strip() or clickhouse_config_raw.username,
            password=args.clickhouse_password
            if args.clickhouse_password
            else clickhouse_config_raw.password,
        )

    window_start, window_end = _resolve_window_bounds(manifest)
    window_policy = _validate_window_policy(manifest)
    strict_coverage_ratio = _safe_float(
        window_policy.get("strict_coverage_ratio"), default=0.95
    )

    output_dir = (
        Path(args.output_dir)
        if args.output_dir
        else resources.output_root / resources.run_token / "report"
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    with psycopg.connect(postgres_config.simulation_dsn) as conn:
        decisions_all = _query_rows(
            conn,
            "SELECT id, strategy_id, symbol, status, created_at, executed_at, decision_json "
            "FROM trade_decisions ORDER BY created_at ASC",
        )
        decisions = _extract_run_scope_decisions(decisions_all, run_id=args.run_id)
        decision_ids = {str(row.get("id")) for row in decisions}

        executions_all = _query_rows(
            conn,
            "SELECT id, trade_decision_id, symbol, side, submitted_qty, filled_qty, avg_fill_price, status, "
            "created_at, last_update_at, order_feed_last_event_ts, execution_expected_adapter, "
            "execution_actual_adapter, execution_fallback_reason, execution_fallback_count "
            "FROM executions ORDER BY created_at ASC",
        )
        if decision_ids:
            executions = [
                row
                for row in executions_all
                if str(row.get("trade_decision_id") or "") in decision_ids
            ]
        else:
            executions = executions_all
        execution_ids = {str(row.get("id")) for row in executions}

        order_events_all = _query_rows(
            conn,
            "SELECT execution_id, event_ts, created_at, status, event_type FROM execution_order_events ORDER BY created_at ASC",
        )
        order_events_total = len(order_events_all)
        order_events_unlinked = sum(
            1 for row in order_events_all if row.get("execution_id") is None
        )
        if execution_ids:
            order_events = [
                row
                for row in order_events_all
                if str(row.get("execution_id") or "") in execution_ids
            ]
        else:
            order_events = order_events_all

        tca_all = _query_rows(
            conn,
            "SELECT execution_id, trade_decision_id, strategy_id, symbol, side, filled_qty, avg_fill_price, "
            "arrival_price, shortfall_notional, slippage_bps, realized_shortfall_bps, divergence_bps, computed_at "
            "FROM execution_tca_metrics ORDER BY computed_at ASC",
        )
        if execution_ids:
            tca_rows = [
                row
                for row in tca_all
                if str(row.get("execution_id") or "") in execution_ids
            ]
        else:
            tca_rows = tca_all

        llm_reviews_all = _query_rows(
            conn,
            "SELECT id, trade_decision_id, model, prompt_version, verdict, confidence, tokens_prompt, "
            "tokens_completion, risk_flags, response_json, created_at "
            "FROM llm_decision_reviews ORDER BY created_at ASC",
        )
        if decision_ids:
            llm_reviews = [
                row
                for row in llm_reviews_all
                if str(row.get("trade_decision_id") or "") in decision_ids
            ]
        else:
            llm_reviews = llm_reviews_all

        trade_cursor_rows = _query_rows(
            conn,
            "SELECT source, account_label, cursor_at, cursor_seq, cursor_symbol FROM trade_cursor ORDER BY updated_at DESC",
        )

    decision_status_counts: Counter[str] = Counter()
    strategy_symbol_counts: Counter[tuple[str, str]] = Counter()
    signal_to_decision_ms: list[float] = []
    decision_ts_values: list[datetime] = []
    decisions_by_id: dict[str, dict[str, Any]] = {}

    for decision in decisions:
        decision_id = str(decision.get("id") or "")
        decisions_by_id[decision_id] = decision
        status = _as_text(decision.get("status")) or "unknown"
        decision_status_counts[status] += 1
        strategy_symbol_counts[
            (
                str(decision.get("strategy_id") or ""),
                _as_text(decision.get("symbol")) or "",
            )
        ] += 1

        created_at = decision.get("created_at")
        decision_json = _to_mapping(decision.get("decision_json"))
        signal_ts = _extract_signal_event_ts(decision_json)
        if isinstance(created_at, datetime) and signal_ts is not None:
            signal_to_decision_ms.append(
                (created_at - signal_ts).total_seconds() * 1000.0
            )
            decision_ts_values.append(signal_ts)

    execution_status_counts: Counter[str] = Counter()
    expected_actual_counts: Counter[tuple[str, str]] = Counter()
    fallback_reason_counts: Counter[str] = Counter()
    decision_to_submit_ms: list[float] = []
    submit_to_feed_update_ms: list[float] = []

    first_order_event_by_execution: dict[str, datetime] = {}
    for event in order_events:
        execution_id = str(event.get("execution_id") or "")
        event_ts = event.get("event_ts")
        created_at = event.get("created_at")
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
        execution_id = str(execution.get("id") or "")
        status = _as_text(execution.get("status")) or "unknown"
        execution_status_counts[status] += 1

        expected_adapter = (
            _as_text(execution.get("execution_expected_adapter")) or "unknown"
        ).lower()
        actual_adapter = (
            _as_text(execution.get("execution_actual_adapter")) or "unknown"
        ).lower()
        expected_actual_counts[(expected_adapter, actual_adapter)] += 1
        if expected_adapter != actual_adapter:
            mismatch_executions += 1

        fallback_reason = _as_text(execution.get("execution_fallback_reason")) or ""
        fallback_count = _safe_int(execution.get("execution_fallback_count"))
        if fallback_reason:
            fallback_reason_counts[fallback_reason] += 1
        fallback_applied = bool(
            fallback_reason or fallback_count > 0 or expected_adapter != actual_adapter
        )
        if fallback_applied:
            fallback_executions += 1

        created_at = execution.get("created_at")
        if isinstance(created_at, datetime):
            decision_id = str(execution.get("trade_decision_id") or "")
            decision = decisions_by_id.get(decision_id)
            if decision is not None and isinstance(
                decision.get("created_at"), datetime
            ):
                decision_created_at = decision["created_at"]
                decision_to_submit_ms.append(
                    (created_at - decision_created_at).total_seconds() * 1000.0
                )

            first_update = first_order_event_by_execution.get(execution_id)
            if first_update is not None:
                executions_with_events += 1
                submit_to_feed_update_ms.append(
                    (first_update - created_at).total_seconds() * 1000.0
                )
            elif isinstance(execution.get("order_feed_last_event_ts"), datetime):
                order_feed_last_event_ts = execution["order_feed_last_event_ts"]
                submit_to_feed_update_ms.append(
                    (order_feed_last_event_ts - created_at).total_seconds() * 1000.0
                )

    latency_rows: list[dict[str, Any]] = []
    for execution in executions:
        execution_id = str(execution.get("id") or "")
        decision_id = str(execution.get("trade_decision_id") or "")
        decision = decisions_by_id.get(decision_id)
        created_at = execution.get("created_at")
        signal_to_decision_value: float | None = None
        decision_to_submit_value: float | None = None
        submit_to_first_update_value: float | None = None
        if decision is not None and isinstance(decision.get("created_at"), datetime):
            decision_created_at = decision["created_at"]
            decision_json = _to_mapping(decision.get("decision_json"))
            signal_event_ts = _extract_signal_event_ts(decision_json)
            if signal_event_ts is not None:
                signal_to_decision_value = (
                    decision_created_at - signal_event_ts
                ).total_seconds() * 1000.0
            if isinstance(created_at, datetime):
                decision_to_submit_value = (
                    created_at - decision_created_at
                ).total_seconds() * 1000.0
        if isinstance(created_at, datetime):
            first_update = first_order_event_by_execution.get(execution_id)
            if first_update is not None:
                submit_to_first_update_value = (
                    first_update - created_at
                ).total_seconds() * 1000.0
        latency_rows.append(
            {
                "execution_id": execution_id,
                "trade_decision_id": decision_id,
                "symbol": _as_text(execution.get("symbol")),
                "signal_to_decision_ms": signal_to_decision_value,
                "decision_to_submit_ms": decision_to_submit_value,
                "submit_to_first_update_ms": submit_to_first_update_value,
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
        verdict = (_as_text(review.get("verdict")) or "unknown").lower()
        model = _as_text(review.get("model")) or "unknown"
        prompt_version = _as_text(review.get("prompt_version")) or "unknown"
        llm_verdict_counts[verdict] += 1
        llm_model_prompt_counts[(model, prompt_version)] += 1

        confidence = _safe_float(review.get("confidence"), default=-1)
        if confidence >= 0:
            llm_avg_confidence_values.append(confidence)
        llm_token_prompt += _safe_int(review.get("tokens_prompt"))
        llm_token_completion += _safe_int(review.get("tokens_completion"))

        for flag in _to_list_of_strings(review.get("risk_flags")):
            llm_risk_flag_counter[flag] += 1

        response_json = _to_mapping(review.get("response_json"))
        policy_override = _as_text(response_json.get("policy_override")) or ""
        fallback = (_as_text(response_json.get("fallback")) or "").lower()
        if "_fallback_" in policy_override or fallback in {"veto", "pass_through"}:
            llm_fallback_total += 1
        if isinstance(response_json.get("deterministic_guardrails"), list):
            llm_deterministic_guardrail_total += 1

        calibrated = _to_mapping(response_json.get("calibrated_probabilities"))
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
                "review_id": str(review.get("id") or ""),
                "trade_decision_id": str(review.get("trade_decision_id") or ""),
                "model": model,
                "prompt_version": prompt_version,
                "verdict": verdict,
                "confidence": confidence if confidence >= 0 else None,
                "tokens_prompt": _safe_int(review.get("tokens_prompt")),
                "tokens_completion": _safe_int(review.get("tokens_completion")),
            }
        )

    clickhouse_stats = _collect_clickhouse_stats(
        clickhouse_config=clickhouse_config,
        clickhouse_db=resources.clickhouse_db,
    )

    last_prices = _build_last_price_map(
        clickhouse_config=clickhouse_config,
        price_table=resources.clickhouse_price_table,
        tca_rows=tca_rows,
        execution_rows=executions,
    )
    pnl_summary_raw, trade_pnl_rows = _fifo_trade_pnl(
        executions, last_prices=last_prices
    )

    tca_shortfall_total = Decimal("0")
    tca_realized_shortfall_values: list[float] = []
    tca_abs_slippage_values: list[float] = []
    tca_abs_divergence_values: list[float] = []
    for row in tca_rows:
        shortfall = _as_decimal(row.get("shortfall_notional"))
        if shortfall is not None:
            tca_shortfall_total += shortfall
        realized_shortfall = _as_decimal(row.get("realized_shortfall_bps"))
        if realized_shortfall is not None:
            tca_realized_shortfall_values.append(float(realized_shortfall))
        slippage = _as_decimal(row.get("slippage_bps"))
        if slippage is not None:
            tca_abs_slippage_values.append(float(abs(slippage)))
        divergence = _as_decimal(row.get("divergence_bps"))
        if divergence is not None:
            tca_abs_divergence_values.append(float(abs(divergence)))

    reporting_cfg = _as_mapping(manifest.get("reporting"))
    commission_bps = _as_decimal(reporting_cfg.get("commission_bps")) or Decimal("0")
    per_trade_fee = _as_decimal(reporting_cfg.get("per_trade_fee")) or Decimal("0")

    execution_notional_total = pnl_summary_raw["execution_notional_total"]
    commission_cost = (execution_notional_total * commission_bps) / Decimal("10000")
    per_trade_cost_total = per_trade_fee * Decimal(len(trade_pnl_rows))
    estimated_cost_total = commission_cost + per_trade_cost_total
    gross_pnl = pnl_summary_raw["gross_pnl"]
    net_pnl_estimated = gross_pnl - estimated_cost_total

    tca_realized_pnl_proxy_notional = -tca_shortfall_total

    target_window_minutes = (window_end - window_start).total_seconds() / 60.0
    decision_span_minutes: float | None = None
    if decision_ts_values:
        decision_span_minutes = (
            max(decision_ts_values) - min(decision_ts_values)
        ).total_seconds() / 60.0

    dump_span_minutes: float | None = None
    dump_min_ts: datetime | None = None
    dump_max_ts: datetime | None = None
    run_dir = resources.output_root / resources.run_token
    run_manifest = _load_json(run_dir / "run-manifest.json")
    if run_manifest is not None:
        dump_payload = _as_mapping(run_manifest.get("dump"))
        min_ms = dump_payload.get("min_source_timestamp_ms")
        max_ms = dump_payload.get("max_source_timestamp_ms")
        if min_ms is not None and max_ms is not None:
            min_ts_ms = _safe_int(min_ms, default=-1)
            max_ts_ms = _safe_int(max_ms, default=-1)
            if min_ts_ms >= 0 and max_ts_ms >= min_ts_ms:
                dump_min_ts = datetime.fromtimestamp(
                    min_ts_ms / 1000.0, tz=timezone.utc
                )
                dump_max_ts = datetime.fromtimestamp(
                    max_ts_ms / 1000.0, tz=timezone.utc
                )
                dump_span_minutes = (max_ts_ms - min_ts_ms) / 60_000.0

    coverage_ratio: float | None = None
    if dump_span_minutes is not None and target_window_minutes > 0:
        coverage_ratio = dump_span_minutes / target_window_minutes

    funnel = {
        "trade_decisions": len(decisions),
        "executions": len(executions),
        "execution_order_events": len(order_events),
        "execution_order_events_total": order_events_total,
        "execution_order_events_unlinked": order_events_unlinked,
        "execution_tca_metrics": len(tca_rows),
        "llm_reviews": len(llm_reviews),
        "decision_status_counts": dict(sorted(decision_status_counts.items())),
        "decision_to_execution_rate": (
            (len(executions) / len(decisions)) if decisions else 0.0
        ),
        "decision_strategy_symbol_counts": [
            {
                "strategy_id": strategy_id,
                "symbol": symbol,
                "count": count,
            }
            for (strategy_id, symbol), count in sorted(strategy_symbol_counts.items())
        ],
    }

    execution_quality = {
        "execution_status_counts": dict(sorted(execution_status_counts.items())),
        "expected_actual_adapter_counts": [
            {
                "expected_adapter": expected,
                "actual_adapter": actual,
                "count": count,
            }
            for (expected, actual), count in sorted(expected_actual_counts.items())
        ],
        "fallback_reason_counts": dict(sorted(fallback_reason_counts.items())),
        "fallback_execution_count": fallback_executions,
        "fallback_ratio": (fallback_executions / len(executions))
        if executions
        else 0.0,
        "adapter_mismatch_count": mismatch_executions,
        "adapter_mismatch_ratio": (mismatch_executions / len(executions))
        if executions
        else 0.0,
        "executions_with_order_events": executions_with_events,
        "order_event_coverage_ratio": (
            (executions_with_events / len(executions)) if executions else 0.0
        ),
        "unlinked_order_event_count": order_events_unlinked,
        "unlinked_order_event_ratio": (
            (order_events_unlinked / order_events_total) if order_events_total else 0.0
        ),
        "latency_ms": {
            "signal_to_decision_p50": _percentile(signal_to_decision_ms, 50),
            "signal_to_decision_p95": _percentile(signal_to_decision_ms, 95),
            "decision_to_submit_p50": _percentile(decision_to_submit_ms, 50),
            "decision_to_submit_p95": _percentile(decision_to_submit_ms, 95),
            "submit_to_first_update_p50": _percentile(submit_to_feed_update_ms, 50),
            "submit_to_first_update_p95": _percentile(submit_to_feed_update_ms, 95),
        },
        "slippage_bps": {
            "avg_abs": _mean(tca_abs_slippage_values),
            "p50_abs": _percentile(tca_abs_slippage_values, 50),
            "p95_abs": _percentile(tca_abs_slippage_values, 95),
            "max_abs": max(tca_abs_slippage_values)
            if tca_abs_slippage_values
            else None,
        },
        "divergence_bps": {
            "avg_abs": _mean(tca_abs_divergence_values),
            "p50_abs": _percentile(tca_abs_divergence_values, 50),
            "p95_abs": _percentile(tca_abs_divergence_values, 95),
            "max_abs": max(tca_abs_divergence_values)
            if tca_abs_divergence_values
            else None,
        },
    }

    llm_total = len(llm_reviews)
    llm_error_count = llm_verdict_counts.get("error", 0)
    llm = {
        "total_reviews": llm_total,
        "error_count": llm_error_count,
        "error_rate": (llm_error_count / llm_total) if llm_total else 0.0,
        "avg_confidence": _mean(llm_avg_confidence_values),
        "verdict_counts": dict(sorted(llm_verdict_counts.items())),
        "by_model_prompt": [
            {
                "model": model,
                "prompt_version": prompt_version,
                "count": count,
            }
            for (model, prompt_version), count in sorted(
                llm_model_prompt_counts.items()
            )
        ],
        "tokens": {
            "prompt": llm_token_prompt,
            "completion": llm_token_completion,
            "total": llm_token_prompt + llm_token_completion,
        },
        "top_risk_flags": [
            {
                "flag": flag,
                "count": count,
            }
            for flag, count in llm_risk_flag_counter.most_common(10)
        ],
        "decision_contribution": {
            "fallback_total": llm_fallback_total,
            "fallback_rate": (llm_fallback_total / llm_total) if llm_total else 0.0,
            "deterministic_guardrail_total": llm_deterministic_guardrail_total,
            "deterministic_guardrail_rate": (
                (llm_deterministic_guardrail_total / llm_total) if llm_total else 0.0
            ),
            "contribution_events": (
                llm_verdict_counts.get("veto", 0)
                + llm_verdict_counts.get("adjust", 0)
                + llm_verdict_counts.get("abstain", 0)
                + llm_verdict_counts.get("escalate", 0)
            ),
            "contribution_rate": (
                (
                    llm_verdict_counts.get("veto", 0)
                    + llm_verdict_counts.get("adjust", 0)
                    + llm_verdict_counts.get("abstain", 0)
                    + llm_verdict_counts.get("escalate", 0)
                )
                / llm_total
                if llm_total
                else 0.0
            ),
        },
        "calibration": {
            "mean_confidence_gap": _mean(llm_confidence_gap_values),
            "samples": len(llm_confidence_gap_values),
        },
    }

    coverage = {
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "target_window_minutes": target_window_minutes,
        "decision_signal_min_ts": min(decision_ts_values).isoformat()
        if decision_ts_values
        else None,
        "decision_signal_max_ts": max(decision_ts_values).isoformat()
        if decision_ts_values
        else None,
        "decision_span_minutes": decision_span_minutes,
        "dump_signal_min_ts": dump_min_ts.isoformat()
        if dump_min_ts is not None
        else None,
        "dump_signal_max_ts": dump_max_ts.isoformat()
        if dump_max_ts is not None
        else None,
        "dump_span_minutes": dump_span_minutes,
        "window_coverage_ratio_from_dump": coverage_ratio,
    }

    stability_anomalies: list[str] = []
    if len(decisions) == 0:
        stability_anomalies.append("no_trade_decisions")
    if len(executions) == 0:
        stability_anomalies.append("no_executions")
    if len(executions) > 0 and len(order_events) == 0:
        stability_anomalies.append("no_execution_order_events")
    if coverage_ratio is not None and coverage_ratio < strict_coverage_ratio:
        stability_anomalies.append("dump_coverage_below_95pct")
    if llm_total > 0 and llm["error_rate"] > 0.05:
        stability_anomalies.append("llm_error_rate_above_5pct")
    if execution_quality["fallback_ratio"] > 0.2:
        stability_anomalies.append("execution_fallback_ratio_above_20pct")

    stability = {
        "anomalies": stability_anomalies,
        "clickhouse": clickhouse_stats,
        "trade_cursor_rows": trade_cursor_rows,
    }

    monitor_cfg = _as_mapping(manifest.get("monitor"))
    min_decisions = _safe_int(monitor_cfg.get("min_trade_decisions"), default=1)
    min_executions = _safe_int(monitor_cfg.get("min_executions"), default=1)

    fail_reasons: list[str] = []
    warn_reasons: list[str] = []
    if len(decisions) < min_decisions:
        fail_reasons.append("trade_decisions_below_minimum")
    if len(executions) < min_executions:
        fail_reasons.append("executions_below_minimum")
    if coverage_ratio is not None and coverage_ratio < strict_coverage_ratio:
        fail_reasons.append("window_coverage_ratio_below_95pct")

    if len(executions) > 0 and len(order_events) == 0:
        warn_reasons.append("execution_order_events_missing")
    if len(executions) > 0 and len(order_events) == 0 and order_events_total > 0:
        warn_reasons.append("execution_order_events_unlinked")
    if execution_quality["adapter_mismatch_ratio"] > 0:
        warn_reasons.append("execution_adapter_mismatch_detected")
    if llm_total > 0 and llm["error_rate"] > 0.05:
        warn_reasons.append("llm_error_rate_above_threshold")

    verdict_status = "PASS"
    if fail_reasons:
        verdict_status = "FAIL"
    elif warn_reasons:
        verdict_status = "WARN"

    verdict = {
        "status": verdict_status,
        "fail_reasons": fail_reasons,
        "warn_reasons": warn_reasons,
    }

    pnl = {
        "realized_pnl": _decimal_to_str(pnl_summary_raw["realized_pnl"]),
        "unrealized_pnl": _decimal_to_str(pnl_summary_raw["unrealized_pnl"]),
        "gross_pnl": _decimal_to_str(gross_pnl),
        "commission_bps": _decimal_to_str(commission_bps),
        "per_trade_fee": _decimal_to_str(per_trade_fee),
        "estimated_cost_total": _decimal_to_str(estimated_cost_total),
        "net_pnl_estimated": _decimal_to_str(net_pnl_estimated),
        "execution_notional_total": _decimal_to_str(execution_notional_total),
        "tca_shortfall_notional_total": _decimal_to_str(tca_shortfall_total),
        "tca_realized_pnl_proxy_notional": _decimal_to_str(
            tca_realized_pnl_proxy_notional
        ),
        "avg_realized_shortfall_bps": _mean(tca_realized_shortfall_values),
        "open_lot_count": pnl_summary_raw["open_lot_count"],
        "realized_by_symbol": pnl_summary_raw["realized_by_symbol"],
    }

    run_metadata = {
        "run_id": args.run_id,
        "run_token": resources.run_token,
        "dataset_id": resources.dataset_id,
        "lane": resources.lane,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "manifest_path": str(manifest_path),
        "simulation_db": postgres_config.simulation_db,
        "clickhouse_db": resources.clickhouse_db,
        "clickhouse_price_table": resources.clickhouse_price_table,
        "clickhouse_signal_table": resources.clickhouse_signal_table,
    }

    report = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "run_metadata": run_metadata,
        "window_policy": window_policy,
        "coverage": coverage,
        "funnel": funnel,
        "execution_quality": execution_quality,
        "pnl": pnl,
        "llm": llm,
        "stability": stability,
        "verdict": verdict,
        "artifacts": {
            "run_dir": str(run_dir),
            "report_dir": str(output_dir),
            "run_manifest_path": str(run_dir / "run-manifest.json"),
            "trade_pnl_csv": str(output_dir / "trade-pnl.csv"),
            "execution_latency_csv": str(output_dir / "execution-latency.csv"),
            "llm_review_summary_csv": str(output_dir / "llm-review-summary.csv"),
        },
        "caveats": [
            {
                "code": "pnl_estimation_limits",
                "message": "gross/net pnl values are derived from execution fills and latest available prices; they are not a broker statement.",
            },
            {
                "code": "tca_proxy_limits",
                "message": "tca_realized_pnl_proxy_notional is derived from shortfall notional and excludes full portfolio mark-to-market effects.",
            },
        ],
    }

    _csv_write(output_dir / "trade-pnl.csv", trade_pnl_rows)
    _csv_write(output_dir / "execution-latency.csv", latency_rows)
    _csv_write(output_dir / "llm-review-summary.csv", llm_summary_rows)

    report_json_path = output_dir / "simulation-report.json"
    report_md_path = output_dir / "simulation-report.md"
    report_json_path.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=_json_default),
        encoding="utf-8",
    )
    report_md_path.write_text(_render_markdown(report), encoding="utf-8")
    return report


def main() -> None:
    args = _parse_args()
    report = _build_report(args)
    if args.json:
        print(
            json.dumps(
                report, sort_keys=True, separators=(",", ":"), default=_json_default
            )
        )
        return
    print(json.dumps(report, indent=2, sort_keys=True, default=_json_default))


if __name__ == "__main__":
    main()


__all__ = [
    "_as_decimal",
    "_build_last_price_map",
    "_build_report",
    "_collect_clickhouse_stats",
    "_csv_write",
    "_decimal_to_str",
    "_extract_run_scope_decisions",
    "_extract_signal_event_ts",
    "_fifo_trade_pnl",
    "_json_default",
    "_load_json",
    "_mean",
    "_parse_args",
    "_percentile",
    "_query_rows",
    "_render_markdown",
    "_to_list_of_strings",
    "_to_mapping",
    "main",
]
