select
    e.id,
    d.id,
    d.created_at,
    coalesce(
        e.order_feed_last_event_ts,
        e.last_update_at,
        e.updated_at,
        e.created_at
    ) as execution_event_at,
    e.created_at,
    e.symbol,
    e.side,
    e.filled_qty,
    e.avg_fill_price,
    t.shortfall_notional,
    e.execution_audit_json,
    e.raw_order,
    e.alpaca_account_label,
    s.name,
    d.decision_hash,
    d.decision_json,
    e.alpaca_order_id,
    e.client_order_id,
    e.status,
    t.id
from executions e
join trade_decisions d on d.id = e.trade_decision_id
join strategies s on s.id = d.strategy_id
left join execution_tca_metrics t on t.execution_id = e.id
where s.name = any(%s)
  and d.alpaca_account_label = %s
  and e.alpaca_account_label = %s
  and coalesce(
        e.order_feed_last_event_ts,
        e.last_update_at,
        e.updated_at,
        e.created_at
      ) >= %s
  and coalesce(
        e.order_feed_last_event_ts,
        e.last_update_at,
        e.updated_at,
        e.created_at
      ) < %s
  {execution_symbol_clause}
order by coalesce(
    e.order_feed_last_event_ts,
    e.last_update_at,
    e.updated_at,
    e.created_at
)
