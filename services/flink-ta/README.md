# flink-ta

Flink 1.20 application-mode job that consumes Alpaca Kafka feeds, builds 1s micro-bars, computes TA indicators, and publishes `ta.bars.1s.v1` / `ta.signals.v1` topics for torghut.

## Development

```bash
cd services/flink-ta
./mvnw -DskipTests package   # builds shaded jar at target/flink-ta.jar
./mvnw clean verify          # runs unit + mini-cluster tests
```

Build the container (shaded jar already baked into `/opt/flink/usrlib/flink-ta.jar`):

```bash
docker build -t <registry>/flink-ta:dev services/flink-ta
```

Key env vars (see `FlinkTaJob`): `KAFKA_BOOTSTRAP`, `KAFKA_USERNAME`, `KAFKA_PASSWORD`, `KAFKA_TRUSTSTORE_PATH`, `CHECKPOINT_URI`, `TRANSACTION_PREFIX`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`.
