# Dorvud (placeholder)

Multi-project Kotlin service scaffold aligned to the Dorvud design outline. Modules:

- `platform`: shared foundations and configuration placeholders.
- `technical-analysis`: stub for analytics logic.
- `websockets`: stub for realtime gateway.
- `flink-integration`: stub for Flink job/integration wiring.

Each module currently exposes a minimal placeholder function and builds with Gradle 9.2.0 / Kotlin 2.3.0.

Local WS dev: copy `websockets/.env.local.example` to `.env.local`, fill Alpaca sandbox creds, and run `./gradlew :websockets:run` to stream into a local Kafka; `.env`/`.env.local` are auto-loaded (system env still wins). To get local infra only, run `docker compose -f websockets/docker-compose.local.yml up --build` for Kafka + UI, then start the forwarder separately with your env loaded; use symbol `FAKEPACA` for quick smoke.
