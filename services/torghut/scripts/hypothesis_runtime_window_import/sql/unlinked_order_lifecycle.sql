select
    oe.id,
    coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id),
    e.id,
    coalesce(oe.event_ts, oe.created_at),
    oe.symbol,
    oe.alpaca_account_label,
    null,
    null,
    null,
    oe.alpaca_order_id,
    oe.client_order_id,
    oe.event_type,
    oe.status,
    e.side,
    oe.qty,
    oe.filled_qty,
    oe.filled_qty_delta,
    oe.avg_fill_price,
    oe.filled_notional_delta,
    oe.fill_quantity_basis,
    oe.event_fingerprint,
    oe.source_topic,
    oe.source_partition,
    oe.source_offset,
    oe.source_window_id,
    oe.raw_event,
    e.execution_audit_json,
    e.raw_order,
    sw.status,
    sw.status_reason,
    sw.consumed_count,
    sw.inserted_count,
    sw.duplicate_count,
    sw.malformed_count,
    sw.missing_payload_count,
    sw.missing_identity_count,
    sw.out_of_scope_account_count,
    sw.unlinked_execution_count,
    sw.unlinked_decision_count,
    sw.failed_unhandled_count,
    sw.dropped_count,
    sw.gap_count,
    sw.gap_ranges
from execution_order_events oe
left join order_feed_source_windows sw on sw.id = oe.source_window_id
left join lateral (
    select matched.*
    from (
        select
            array_agg(e_match.id order by e_match.created_at, e_match.id) as ids,
            count(*) as match_count
        from executions e_match
        where e_match.alpaca_account_label = %s
          and (
                (
                    oe.execution_id is not null
                    and e_match.id = oe.execution_id
                )
                or (
                    nullif(oe.alpaca_order_id, '') is not null
                    and e_match.alpaca_order_id = oe.alpaca_order_id
                )
                or (
                    nullif(oe.client_order_id, '') is not null
                    and e_match.client_order_id = oe.client_order_id
                )
              )
    ) exact_match
    join executions matched on matched.id = exact_match.ids[1]
    where exact_match.match_count = 1
) e on true
left join lateral (
    select matched.*
    from (
        select
            array_agg(d_match.id order by d_match.created_at, d_match.id) as ids,
            count(*) as match_count
        from trade_decisions d_match
        where d_match.alpaca_account_label = %s
          and nullif(oe.client_order_id, '') is not null
          and d_match.decision_hash = oe.client_order_id
    ) exact_decision_match
    join trade_decisions matched on matched.id = exact_decision_match.ids[1]
    where exact_decision_match.match_count = 1
) d_by_client on true
where oe.alpaca_account_label = %s
  and coalesce(oe.event_ts, oe.created_at) >= %s
  and coalesce(oe.event_ts, oe.created_at) < %s
  and (
        e.id is null
        or coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id) is null
      )
  and (
        lower(coalesce(oe.event_type, oe.status, '')) in (
            'fill', 'filled', 'partial_fill', 'partially_filled'
        )
        or coalesce(oe.filled_qty, 0) > 0
      )
  {unlinked_order_event_symbol_clause}
order by coalesce(oe.event_ts, oe.created_at), oe.created_at
