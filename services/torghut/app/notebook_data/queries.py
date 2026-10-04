"""Auditable SQL contracts for Torghut diagnostics.

All statements project named typed fields, bind parameters, aggregate before
returning data, and carry an explicit row cap. Raw payload columns are forbidden.
"""

from __future__ import annotations

EQUITIES_FLOW_QUERY = """
WITH selected_sessions AS (
    SELECT session_date
    FROM (
        SELECT toDate(event_ts, 'America/New_York') AS session_date
        FROM torghut.ta_signals
        WHERE event_ts <= {as_of:DateTime64(3, 'UTC')}
          AND event_ts >= subtractDays({as_of:DateTime64(3, 'UTC')}, 25)
        GROUP BY session_date
        ORDER BY session_date DESC
        LIMIT {session_count:UInt8}
    )
), aggregated AS (
    SELECT
        symbol,
        toStartOfMinute(event_ts) AS event_minute,
        argMax(ema12, ingest_ts) AS ema12,
        argMax(ema26, ingest_ts) AS ema26,
        argMax(rsi14, ingest_ts) AS rsi14,
        argMax(vwap_session, ingest_ts) AS vwap_session,
        max(ingest_ts) AS latest_ingest_ts
    FROM torghut.ta_signals
    WHERE event_ts <= {as_of:DateTime64(3, 'UTC')}
      AND toDate(event_ts, 'America/New_York') IN (SELECT session_date FROM selected_sessions)
    GROUP BY symbol, event_minute
)
SELECT
    symbol,
    event_minute AS event_ts,
    ema12,
    ema26,
    rsi14,
    vwap_session,
    latest_ingest_ts,
    max(latest_ingest_ts) OVER () AS source_watermark
FROM aggregated
ORDER BY event_ts, symbol
LIMIT {limit:UInt32}
FORMAT JSON
""".strip()

OPTIONS_FLOW_QUERY = """
WITH (
    SELECT max(ingest_ts)
    FROM torghut.options_surface_features
    WHERE ingest_ts <= {as_of:DateTime64(3, 'UTC')}
) AS anchor
SELECT
    underlying_symbol,
    event_ts,
    argMax(atm_iv, ingest_ts) AS atm_iv,
    argMax(call_put_skew_25d, ingest_ts) AS call_put_skew_25d,
    argMax(snapshot_coverage_ratio, ingest_ts) AS snapshot_coverage_ratio,
    argMax(hot_contract_coverage_ratio, ingest_ts) AS hot_contract_coverage_ratio,
    argMax(feature_quality_status, ingest_ts) AS feature_quality_status,
    max(ingest_ts) AS latest_ingest_ts,
    max(max(ingest_ts)) OVER () AS source_watermark
FROM torghut.options_surface_features
WHERE ingest_ts > subtractMinutes(anchor, {minutes:UInt16})
  AND ingest_ts <= anchor
GROUP BY underlying_symbol, event_ts
ORDER BY event_ts, underlying_symbol
LIMIT {limit:UInt32}
FORMAT JSON
""".strip()

HYPERLIQUID_FLOW_QUERY = """
WITH (
    SELECT max(ingest_ts)
    FROM torghut.hyperliquid_ta_features
    WHERE ingest_ts <= {as_of:DateTime64(3, 'UTC')}
) AS anchor
SELECT
    network,
    market_id,
    coin,
    dex,
    interval,
    event_ts,
    argMax(price, ingest_ts) AS price,
    argMax(regime, ingest_ts) AS regime,
    argMax(source_lag_seconds, ingest_ts) AS source_lag_seconds,
    argMax(momentum_5m_bps, ingest_ts) AS momentum_5m_bps,
    argMax(volatility_bps, ingest_ts) AS volatility_bps,
    argMax(spread_bps, ingest_ts) AS spread_bps,
    max(ingest_ts) AS latest_ingest_ts,
    max(max(ingest_ts)) OVER () AS source_watermark
FROM torghut.hyperliquid_ta_features
WHERE ingest_ts > subtractMinutes(anchor, {minutes:UInt16})
  AND ingest_ts <= anchor
GROUP BY network, market_id, coin, dex, interval, event_ts
ORDER BY event_ts, coin, interval
LIMIT {limit:UInt32}
FORMAT JSON
""".strip()

DECISION_STATUS_QUERY = """
SELECT
    td.strategy_id::text AS strategy_id,
    date_trunc('day', td.created_at) AS bucket_start,
    td.status,
    count(*)::bigint AS decision_count,
    max(td.created_at) AS last_activity_at,
    max(max(td.created_at)) OVER () AS source_watermark
FROM trade_decisions AS td
WHERE td.created_at >= %(start)s
  AND td.created_at <= %(end)s
  AND (%(strategy_id)s::uuid IS NULL OR td.strategy_id = %(strategy_id)s::uuid)
GROUP BY td.strategy_id, bucket_start, td.status
ORDER BY bucket_start, strategy_id, status
LIMIT %(limit)s
""".strip()

EXECUTION_LINK_QUERY = """
SELECT
    COALESCE(td.strategy_id::text, 'unlinked') AS strategy_id,
    e.symbol,
    e.status,
    count(*)::bigint AS execution_count,
    count(*) FILTER (WHERE td.id IS NULL)::bigint AS unlinked_execution_count,
    count(*) FILTER (WHERE td.id IS NOT NULL)::bigint AS linked_execution_count,
    count(tca.id)::bigint AS tca_count,
    sum(e.filled_qty)::numeric AS filled_qty,
    max(COALESCE(e.last_update_at, e.updated_at, e.created_at)) AS last_activity_at,
    max(max(COALESCE(e.last_update_at, e.updated_at, e.created_at))) OVER () AS source_watermark
FROM executions AS e
LEFT JOIN trade_decisions AS td ON td.id = e.trade_decision_id
LEFT JOIN execution_tca_metrics AS tca ON tca.execution_id = e.id
WHERE e.created_at >= %(start)s
  AND e.created_at <= %(end)s
  AND (%(strategy_id)s::uuid IS NULL OR td.strategy_id = %(strategy_id)s::uuid)
GROUP BY COALESCE(td.strategy_id::text, 'unlinked'), e.symbol, e.status
ORDER BY strategy_id, symbol, status
LIMIT %(limit)s
""".strip()

REJECTION_REASON_QUERY = """
SELECT
    r.source,
    r.account_label,
    r.symbol,
    r.reject_reason,
    count(*)::bigint AS rejected_signal_count,
    max(r.event_ts) AS last_activity_at,
    max(max(r.event_ts)) OVER () AS source_watermark
FROM rejected_signal_outcome_events AS r
WHERE r.event_ts >= %(start)s
  AND r.event_ts <= %(end)s
GROUP BY r.source, r.account_label, r.symbol, r.reject_reason
ORDER BY rejected_signal_count DESC, reject_reason, symbol
LIMIT %(limit)s
""".strip()

TCA_EVIDENCE_QUERY = """
SELECT
    t.execution_id::text AS execution_id,
    t.trade_decision_id::text AS trade_decision_id,
    t.strategy_id::text AS strategy_id,
    t.alpaca_account_label AS account_label,
    t.symbol,
    t.side,
    t.filled_qty,
    t.slippage_bps,
    t.expected_shortfall_bps_p50,
    t.expected_shortfall_bps_p95,
    t.realized_shortfall_bps,
    t.divergence_bps,
    t.computed_at,
    max(t.computed_at) OVER () AS source_watermark
FROM execution_tca_metrics AS t
WHERE t.computed_at >= %(start)s
  AND t.computed_at <= %(end)s
  AND (%(strategy_id)s::uuid IS NULL OR t.strategy_id = %(strategy_id)s::uuid)
ORDER BY t.computed_at, t.execution_id
LIMIT %(limit)s
""".strip()

LEDGER_EVIDENCE_QUERY = """
SELECT
    date_trunc('day', l.bucket_ended_at) AS bucket_day,
    l.observed_stage,
    COALESCE(l.account_label, 'unlabeled') AS account_label,
    COALESCE(l.runtime_strategy_name, l.hypothesis_id) AS strategy_label,
    sum(l.fill_count)::bigint AS fill_count,
    sum(l.decision_count)::bigint AS decision_count,
    sum(l.filled_notional)::numeric AS filled_notional,
    sum(l.gross_strategy_pnl)::numeric AS gross_strategy_pnl,
    sum(l.cost_amount)::numeric AS cost_amount,
    sum(l.net_strategy_pnl_after_costs)::numeric AS net_strategy_pnl_after_costs,
    max(l.bucket_ended_at) AS latest_bucket_ended_at,
    max(max(l.bucket_ended_at)) OVER () AS source_watermark
FROM strategy_runtime_ledger_buckets AS l
WHERE l.bucket_ended_at >= %(start)s
  AND l.bucket_ended_at <= %(end)s
GROUP BY bucket_day, l.observed_stage, COALESCE(l.account_label, 'unlabeled'),
         COALESCE(l.runtime_strategy_name, l.hypothesis_id)
ORDER BY bucket_day, observed_stage, account_label, strategy_label
LIMIT %(limit)s
""".strip()

ALL_QUERIES = {
    "flow.equities": EQUITIES_FLOW_QUERY,
    "flow.options": OPTIONS_FLOW_QUERY,
    "flow.hyperliquid": HYPERLIQUID_FLOW_QUERY,
    "lifecycle.decisions": DECISION_STATUS_QUERY,
    "lifecycle.executions": EXECUTION_LINK_QUERY,
    "lifecycle.rejections": REJECTION_REASON_QUERY,
    "execution.tca": TCA_EVIDENCE_QUERY,
    "execution.ledger": LEDGER_EVIDENCE_QUERY,
}

FORBIDDEN_PROJECTIONS = (
    "decision_json",
    "raw_order",
    "execution_audit_json",
    "event_payload_json",
    "outcome_payload_json",
    "payload_json",
)


def assert_query_contract(query_identifier: str, sql: str) -> None:
    normalized = " ".join(sql.lower().split())
    if "select *" in normalized:
        raise ValueError(f"{query_identifier} must not use SELECT *")
    for field in FORBIDDEN_PROJECTIONS:
        if field in normalized:
            raise ValueError(f"{query_identifier} projects forbidden field {field}")
    if "limit" not in normalized:
        raise ValueError(f"{query_identifier} has no row limit")
