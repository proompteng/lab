# Torghut Forwarder Topics

Topic design optimised for downstream technical analysis and replay. All topics use replication factor 3 and `min.insync.replicas=2`.

## Topics

| Topic | Partitions | Retention | Cleanup | Key | Notes |
| --- | --- | --- | --- | --- | --- |
| `alpaca.trades.v1` | 12 | 3d | delete | trade `i` | Per-symbol ordering via key; drop duplicates on `i`. |
| `alpaca.quotes.v1` | 12 | 2d | delete | `(t, symbol)` | Dedup on event time + symbol. |
| `alpaca.bars.1m.v1` | 6 | 30d | compact+delete | `(t, symbol, is_final)` | Updated bar frames share the same key; final frames set `is_final=true`. |
| `alpaca.status.v1` | 3 | 7d | delete | status string | Connect/disconnect/reconnect and lag notifications. |

## Envelope

```
{
  "ingest_ts": "UTC ISO timestamp when forwarded",
  "event_ts": "Alpaca event timestamp",
  "channel": "trades|quotes|bars|trade_updates|status",
  "symbol": "ticker or * for status",
  "seq": 123,               # per-channel monotonically increasing counter
  "payload": { ... },       # normalized Alpaca payload
  "is_final": false,        # true for final bar frames
  "source": "alpaca",
  "key": "dedup key"      # mirrors Kafka message key for easy debugging
}
```

- Trades: `key = payload.i` (Alpaca trade id)
- Quotes: `key = (payload.t, symbol)`
- Bars: `key = (payload.t, symbol, is_final)` so compacted log keeps latest frame per window.
- Trade updates: `key = order id` when enabled.

## Partitioning

Kafka message key is set to the dedup key, which includes the symbol. This keeps all events for a symbol on the same partition while allowing idempotent writes.

## Status events

`alpaca.status.v1` carries operational events such as `connected`, `disconnected`, `resubscribed`, and `failed`, with context fields like `symbols`, `feed`, and errors. Consumers can alert on gaps using this stream.
