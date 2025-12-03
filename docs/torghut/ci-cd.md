# CI/CD for Torghut Forwarder and Flink TA

## Forwarder (Python)
- Dockerfile: multi-stage; build with `docker build -t <registry>/torghut-forwarder:<tag> -f apps/torghut-forwarder/Dockerfile .` (path TBD).
- Tests: `pytest` (unit/dedup/envelope), optional integration hitting Alpaca paper feed.
- Lint/format: `bunx biome check <paths>` if TS present; `ruff`/`black` for Python if used.
- Publish: push image to registry; update kustomization image tag under `argocd/applications/torghut/forwarder/` and Argo sync.

## Flink TA job
- Build fat jar/image: `mvn package -Pflink` or `./gradlew shadowJar` (exact module TBD) then `docker build -t <registry>/flink-ta:<tag> -f apps/flink-ta/Dockerfile .`.
- Unit tests: indicator math (EMA/RSI/MACD/VWAP) deterministic tests.
- Integration: local mini-kafka + embedded Flink to verify envelope and sink.
- Publish: push image; update FlinkDeployment image tag in `argocd/applications/torghut/flink-ta/` and Argo sync.

## Tag bump automation
- Optional script: read latest image tags and patch kustomization with `yq -i` then commit.
- Argo sync order: operator (if changed) → forwarder → Flink TA.

## Schema registration
- Keep Avro/JSON schemas in `docs/torghut/schemas/`.
- Use script (see `scripts/register-schemas.sh`) to register with Karapace before deploying producers/consumers.

## Environments
- Overlays per env supply: Alpaca endpoint (paper/live), Kafka bootstrap, MinIO endpoint/bucket, image tags, alert thresholds.
- Keep topic names and schemas identical across environments to simplify promotion.
