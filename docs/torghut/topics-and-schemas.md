# Torghut Kafka Topics & Schemas (Alpaca → TA)

## Topics

| Topic | Purpose | Partitions | RF | Retention | Compression | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| `torghut.trades.v1` | Alpaca trades (keyed by `symbol`) | 3 | 3 | 7d | lz4 | delete |
| `torghut.quotes.v1` | Alpaca quotes (keyed by `symbol`) | 3 | 3 | 7d | lz4 | delete |
| `torghut.bars.1m.v1` | 1m bars (+updatedBars) (keyed by `symbol`) | 3 | 3 | 30d | lz4 | delete |
| `torghut.status.v1` | forwarder status/heartbeat (keyed by `symbol` or `instance`) | 3 | 3 | 7d | lz4 | compaction optional |
| `torghut.ta.bars.1s.v1` | derived micro-bars | 1 | 3 | 14d | lz4 | delete |
| `torghut.ta.signals.v1` | TA indicators/signals | 1 | 3 | 14d | lz4 | delete |
| `torghut.ta.status.v1` | TA job status | 1 | 3 | 7d | lz4 | compaction optional |

Notes:
- Ordering is preserved per symbol by using Kafka message key = `symbol`.
- Use KafkaTopic CRs (Strimzi) for declarative management.

## Envelope (shared)
```json
{
  "ingest_ts": "2025-12-03T18:32:10.123Z",
  "event_ts": "2025-12-03T18:32:10.045Z",
  "feed": "iex",
  "channel": "trades",
  "symbol": "NVDA",
  "seq": 123456,
  "is_final": true,
  "source": "ws",
  "window": {"size": "PT1S", "step": "PT1S", "start": "...", "end": "..."},
  "payload": { /* type-specific */ },
  "version": 1
}
```

## Payload examples
- Trades:
```json
{"i":"ABC123","p":488.12,"s":100,"t":"2025-12-03T18:32:10.045Z"}
```
- Quotes:
```json
{"bp":488.10,"bs":300,"ap":488.14,"as":200,"t":"2025-12-03T18:32:10.040Z"}
```
- Bars (1m):
```json
{"o":488.0,"h":488.5,"l":487.8,"c":488.3,"v":5200,"t":"2025-12-03T18:32:00Z","is_final":false}
```
- Micro-bars (1s):
```json
{"o":488.1,"h":488.2,"l":488.0,"c":488.15,"v":320,"vwap":488.12,"count":8,"t":"2025-12-03T18:32:10Z"}
```
- TA signals:
```json
{
  "macd": {"macd":0.42,"signal":0.35,"hist":0.07},
  "ema": {"ema12":488.10,"ema26":487.95},
  "rsi14": 61.2,
  "boll": {"mid":488.0,"upper":489.2,"lower":486.8},
  "vwap": {"session":488.05,"w5m":488.12},
  "imbalance": {"spread":0.04,"bid_px":488.10,"ask_px":488.14,
                 "bid_sz":300,"ask_sz":200},
  "vol_realized": {"w60s": 0.18}
}
```
- TA status:
```json
{"watermark_lag_ms": 850, "last_event_ts": "2025-12-03T18:32:10Z", "status": "ok", "heartbeat": true}
```

## ClickHouse storage contract
The authoritative ClickHouse table for TA signals uses the envelope fields:
- `event_ts`, `ingest_ts`, `symbol`, `window`, `payload`, `seq`, `source`

Trading ingestion will read the envelope shape by default. For legacy flat tables
(`ts`, `macd`, `rsi`, `vwap`, `signal_json`), set `TRADING_SIGNAL_SCHEMA=flat` and
ensure `ts` is present. Prefer creating a view that aliases the envelope table to
flat columns if you have older consumers.

## Avro subject naming
- Use TopicNameStrategy (default) or per-topic subject: `<topic>-value`.
- Compatibility: backward (recommended) to allow additive fields.

Schemas stored in `docs/torghut/schemas/`:
- `ta-bars-1s.avsc`
- `ta-signals.avsc`
- `ta-status.avsc`

Registration helper: `docs/torghut/register-schemas.sh` (uses KARAPACE_URL env, defaults to `http://karapace.kafka.svc:8081`).

## Schema Registry workflow
- Register subjects before deploying Flink sinks/consumers to avoid 404s at startup.
- Keep schemas in repo (JSON or Avro IDL) and automate registration in CI or pre-sync script.
- For JSON consumers, permit unknown fields to allow additive evolution.

## Dedup keys
- Trades: `i`
- Quotes/Bars: `(event_ts, symbol)`
- Trade updates: order id (if enabled)

## Data quality monitors
- Per-symbol staleness: alert if no events for N seconds.
- Seq monotonicity: flag when `seq` decreases or jumps unexpectedly.
- Window completeness: expected count of trades per micro-bar; emit to status or metrics.

## Suggested KafkaTopic CR (example)
```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: torghut-trades-v1
  labels:
    strimzi.io/cluster: kafka
spec:
  partitions: 3
  replicas: 3
  config:
    cleanup.policy: delete
    compression.type: lz4
    retention.ms: 604800000 # 7d
    min.insync.replicas: 2
```

## Sizing & retention notes
- Signals 14d covers operational replay while keeping storage modest.
- Bars 30d allows backtests and recalibration of indicators.
- Status topics may use compaction + short retention for concise health history.
