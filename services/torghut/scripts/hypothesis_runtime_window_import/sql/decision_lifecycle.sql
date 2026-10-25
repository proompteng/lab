select
    d.id,
    d.created_at,
    d.symbol,
    d.alpaca_account_label,
    s.name,
    d.decision_hash,
    d.decision_json
from trade_decisions d
join strategies s on s.id = d.strategy_id
where s.name = any(%s)
  and d.alpaca_account_label = %s
  and d.status = any(%s)
  and d.created_at >= %s
  and d.created_at < %s
  {decision_symbol_clause}
order by d.created_at
