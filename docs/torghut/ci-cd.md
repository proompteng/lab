# CI/CD for Torghut Forwarder and Flink TA

> Note: Canonical Torghut design docs live in `docs/torghut/design-system/README.md` (v1). This file is a practical,
> command-oriented companion focused on build/release steps.

## WS service (Kotlin, multi-project)
- Code: `services/dorvud/websockets/` (root gradle project: `services/dorvud/`)
- Build (dist packaging): `cd services/dorvud && ./gradlew :websockets:installDist`
- Tests: `cd services/dorvud && ./gradlew :websockets:test`
- Lint: `cd services/dorvud && ./gradlew ktlintCheck`
- Docker: `cd services/dorvud && docker build -t <registry>/torghut-ws:<tag> -f websockets/Dockerfile .`
- Smoke: `bun run smoke:torghut-ws` (requires `KAFKA_USERNAME`/`KAFKA_PASSWORD`; optional overrides exist in the script)
- Release: update image (prefer digest pinning) in `argocd/applications/torghut/ws/**`, then ArgoCD sync.

## Flink TA job
- Code: `services/dorvud/technical-analysis-flink/` (Flink job main class is set in gradle)
- Build (fat jar): `cd services/dorvud && ./gradlew :technical-analysis-flink:uberJar`
- Tests: `cd services/dorvud && ./gradlew :technical-analysis-flink:test`
- Lint: `cd services/dorvud && ./gradlew ktlintCheck`
- Docker: `cd services/dorvud && docker build -t <registry>/torghut-ta:<tag> -f technical-analysis-flink/Dockerfile .`
- Release: update image in `argocd/applications/torghut/ta/flinkdeployment.yaml`, then ArgoCD sync.

## Torghut trading service (Python/FastAPI)
- Code: `services/torghut/`
- Tests: `cd services/torghut && uv run pytest`
- Typecheck: `cd services/torghut && uv run pyright`
- Docker: `cd services/torghut && docker build -t <registry>/torghut:<tag> .`
- Release: update image in `argocd/applications/torghut/knative-service.yaml`, then ArgoCD sync.

## Tag bump automation
- Prefer digest pinning for production rollouts; keep tags as human-friendly labels only.
- Automation can fetch digests and patch kustomizations (for example with `yq -i`), then commit.
- Argo sync order: operator (if changed) → forwarder → Flink TA.

## Schema registration
- Keep Avro/JSON schemas in `docs/torghut/schemas/`.
- Use `docs/torghut/register-schemas.sh` to register with Karapace before deploying producers/consumers.

## Environments
- Overlays per env supply: Alpaca endpoint (paper/live), Kafka bootstrap, MinIO endpoint/bucket, image tags, alert thresholds.
- Keep topic names and schemas identical across environments to simplify promotion.
