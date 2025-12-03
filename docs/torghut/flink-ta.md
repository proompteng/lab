# torghut Flink technical analysis service

Near–real-time Flink job (Flink 1.20 app-mode, managed by Flink K8s Operator 1.13) that consumes Alpaca-derived Kafka topics, builds 1s micro-bars, computes indicators, and emits TA topics consumable by torghut.

## Inputs
- `alpaca.trades.v1` – raw trades with `symbol`, `t` (event_ts), `p` (price), `s` (size), `id`, `is_final`.
- `alpaca.quotes.v1` – quotes with `symbol`, `t`, `bp`, `ap`, `bs`, `as`, `is_final`.
- `alpaca.bars.1m.v1` – 1m bars with `symbol`, `t`, `o/h/l/c`, `v`, `is_final` (used for backfill/validation only).

Watermarks: event-time on `t` with 2s allowed lateness; dedupe trades by `id` and quotes/bars by `(symbol,t)`.

## Outputs (Kafka)
| Topic | Partitions | RF | Compression | Retention | Schema | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `ta.bars.1s.v1` | per symbol (default 12) | 3 | lz4 | 30d | `schemas/ta/ta.bars.1s.v1.avsc` | micro-bars, exactly-once sink |
| `ta.signals.v1` | per symbol (default 12) | 3 | lz4 | 14d | `schemas/ta/ta.signals.v1.avsc` | indicators on top of micro-bars |
| `ta.status.v1` | 1 | 3 | lz4 | 7d (compacted) | `schemas/ta/ta.status.v1.avsc` | optional health/status side channel |

Fields (all timestamps ms since epoch):
- Envelope: `event_ts`, `ingest_ts`, `seq` (monotonic per symbol), `is_final`, `window { start,end }` (start inclusive/end exclusive).
- Bars: O/H/L/C, `volume`, `vwap`, `trade_count`, `spread_bps?`, `imbalance?`.
- Signals: O/H/L/C, `volume`, `vwap`, `ema12/ema26`, `macd`, `macd_signal`, `macd_hist`, `rsi14`, `boll_mid/upper/lower`, `vwap_session`, `vwap_rolling`, `spread_bps?`, `imbalance?`, `realized_volatility`.

### Sample payloads (JSON representation of Avro)
`ta.bars.1s.v1`
```json
{
  "symbol": "AAPL",
  "event_ts": 1733212345000,
  "ingest_ts": 1733212345102,
  "seq": 5321,
  "is_final": true,
  "window": { "start": 1733212344000, "end": 1733212345000 },
  "open": 193.12,
  "high": 193.24,
  "low": 193.08,
  "close": 193.21,
  "volume": 1820,
  "vwap": 193.16,
  "trade_count": 14,
  "spread_bps": 1.8,
  "imbalance": -0.12,
  "source_seq": "t:879234982" 
}
```

`ta.signals.v1`
```json
{
  "symbol": "AAPL",
  "event_ts": 1733212345000,
  "ingest_ts": 1733212345120,
  "seq": 5321,
  "is_final": true,
  "window": { "start": 1733212344000, "end": 1733212345000 },
  "open": 193.12,
  "high": 193.24,
  "low": 193.08,
  "close": 193.21,
  "volume": 1820,
  "vwap": 193.16,
  "ema12": 193.04,
  "ema26": 192.98,
  "macd": 0.06,
  "macd_signal": 0.04,
  "macd_hist": 0.02,
  "rsi14": 57.8,
  "boll_mid": 192.77,
  "boll_upper": 194.30,
  "boll_lower": 191.24,
  "vwap_session": 193.05,
  "vwap_rolling": 193.10,
  "spread_bps": 1.8,
  "imbalance": -0.12,
  "realized_volatility": 0.142,
  "source_seq": "t:879234982"
}
```

## Processing model
- **Watermarks**: `t` from Alpaca payloads; bounded out-of-orderness 2s; back-pressure monitored via watermark lag metrics.
- **Aggregation**: trades keyed by `symbol` → 1s tumbling window (event-time) computing O/H/L/C/V, VWAP, trade count.
- **Indicators**: keyed per symbol stateful process computing EMA12/26 → MACD(+signal/hist), RSI14 (smoothed), Bollinger 20/2, session & rolling VWAP, spread/imbalance from latest quote, realized volatility from trailing log-returns.
- **Deduplication**: trades deduped by `id`; quotes/bars deduped by `(symbol,event_ts)` with TTL state.
- **Semantics**: `KafkaSink` with `DeliveryGuarantee.EXACTLY_ONCE`, `acks=all`, `compression.type=lz4`, transactional id prefix `flink-ta-<cluster>`; `transaction.timeout.ms` >= checkpoint timeout + failover budget.
- **Checkpointing**: RocksDB state backend, 10s interval, externalized on cancel, target S3/MinIO path from env `CHECKPOINT_URI`.

## Config surface
| Env | Purpose | Example |
| --- | --- | --- |
| `KAFKA_BOOTSTRAP` | Kafka bootstrap list | `kafka-kafka-bootstrap.kafka:9092` |
| `KAFKA_USERNAME` / `KAFKA_PASSWORD` | SCRAM creds from `KafkaUser` secret |  |
| `KAFKA_TRUSTSTORE_PATH` / `KAFKA_TRUSTSTORE_PASSWORD` | TLS truststore mount | `/etc/tls/ca.jks` |
| `TRANSACTION_TIMEOUT_MS` | Kafka sink transaction timeout | `900000` |
| `CHECKPOINT_URI` | S3/MinIO checkpoint path | `s3a://torghut/flink-ta/ckpt` |
| `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_PATH_STYLE` | MinIO/S3 access |  |
| `PARALLELISM` | default parallelism override | `8` |
| `TOPIC_TRADES`, `TOPIC_QUOTES`, `TOPIC_BARS_1M` | input topics | overrides above defaults |
| `TOPIC_TA_BARS`, `TOPIC_TA_SIGNALS`, `TOPIC_TA_STATUS` | output topics | defaults to names above |
| `TRANSACTION_PREFIX` | Kafka producer transactional id prefix | `flink-ta` |

## Consumer notes (torghut)
- Use `isolation.level=read_committed` and `compression.type=lz4` consumer configs.
- Partitioning: hash on `symbol`; use the `window.start` + `symbol` combo for deterministic ordering.
- Dedupe: rely on `(symbol, seq)`; `seq` is monotonic per symbol.
- Watermark/latency: expect p99 `now - event_ts` ≤500 ms under nominal load; monitor via Prometheus metrics exposed by the jobmanager/taskmanager pods.

## Validation steps
- Local: `./mvnw -f services/flink-ta/pom.xml clean verify`
- Image: `docker build -t <registry>/flink-ta:dev services/flink-ta`
- Cluster smoke:
  - `kubectl get flinkdeployments -n torghut`
  - `argocd app get torghut-flink-ta`
  - `kubectl -n torghut logs deployment/torghut-flink-ta -c jobmanager`
  - Consume topics with SASL/TLS using the reflected `KafkaUser` secret and `isolation.level=read_committed`.

## Operational notes
- Kafka credentials and CA are reflected into `torghut` namespace; see `KafkaUser torghut-flink` and secret annotations.
- Tuning knobs: `PARALLELISM`, `buffer.timeout.ms`, watermark lateness, checkpoint interval, RocksDB memory options.
- Restart/upgrade via Argo CD sync; FlinkDeployment uses application mode with the shaded JAR baked into the image.
