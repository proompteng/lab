# torghut

FastAPI service scaffold for an autonomous Alpaca paper trading bot powered by Codex.

## Local dev (uv-native)
```bash
cd services/torghut
uv venv .venv
source .venv/bin/activate
uv pip install .

# configure env (DB_DSN defaults to local compose: postgresql+psycopg://torghut:torghut@localhost:15438/torghut)
export APP_ENV=dev
# optional:
# export DB_DSN=...               # override if not using local compose
# export APCA_API_KEY_ID=...
# export APCA_API_SECRET_KEY=...
# export APCA_API_BASE_URL=...

# shortcuts
# normal server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8181

# hot reload
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8181

# type checking
uv run pyright
```

Health checks:
- `GET /healthz` – liveness (default port 8181)
- `GET /db-check` – requires reachable Postgres at `DB_DSN` (default port 8181)

## Consuming TA streams

The `flink-ta` job emits `ta.bars.1s.v1` and `ta.signals.v1` Kafka topics keyed by `symbol`. Both carry the envelope
`event_ts`, `ingest_ts`, `seq`, `is_final`, and `window { start, end }` with milliseconds since epoch.

Example consumer (read committed + lz4) using `kafka-python`:

```python
from kafka import KafkaConsumer
import json

consumer = KafkaConsumer(
    "ta.signals.v1",
    bootstrap_servers="kafka-kafka-bootstrap.kafka:9092",
    security_protocol="SASL_SSL",
    sasl_mechanism="SCRAM-SHA-512",
    sasl_plain_username="torghut-flink",
    sasl_plain_password="<password>",
    value_deserializer=lambda m: json.loads(m.decode("utf-8")),
    key_deserializer=lambda m: m.decode("utf-8") if m else None,
    isolation_level="read_committed",
)

for msg in consumer:
    signal = msg.value
    # use signal['ema12'], signal['macd'], signal['rsi14'], etc.
```

Schemas live in `schemas/ta/`; see `docs/torghut/flink-ta.md` for the full contract and operational notes.
