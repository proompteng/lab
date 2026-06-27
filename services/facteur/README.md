# facteur

`facteur` is a Go service that mediates Discord bot commands into Agents `AgentRun` submissions. It follows the [Discord interaction lifecycle](https://discord.com/developers/docs/interactions/receiving-and-responding), keeps domain intake state in its own Postgres schema, and delegates runtime execution to the Agents service.

## Layout

- `cmd/facteur`: Cobra-based CLI entrypoints.
- `internal`: Internal packages for configuration, Discord routing, Agents dispatch, and session storage.
- `config`: Example configuration files and schema references (role map schema lives at `schemas/facteur-discord-role-map.schema.json`).
- `Dockerfile`: Multi-stage build for containerizing the service.

Refer to the repository docs for detailed integration guidance and follow-up tasks.

## Running locally

```bash
cd services/facteur
go run . serve --config config/example.yaml
```

The `--config` flag is optional if you provide the required `FACTEUR_*` environment variables. Press `Ctrl+C` to stop the server; it will shut down gracefully.

Set `FACTEUR_POSTGRES_DSN` to point at a Postgres instance before starting locally. The server applies embedded migrations on boot so the schema stays in sync. When you do not want local commands to submit AgentRuns, export `FACTEUR_DISABLE_DISPATCHER=true`. A simple local setup uses Postgres on `127.0.0.1:6543/postgres` with the `facteur` role:

```bash
# Terminal 1 – Postgres
docker run --rm -d --name facteur-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 6543:5432 postgres:16

# Terminal 2 – Redis
docker run --rm -d --name facteur-redis -p 6379:6379 redis:7

# Terminal 3 – run migrations and serve
export FACTEUR_POSTGRES_DSN='postgres://postgres:postgres@127.0.0.1:6543/postgres?sslmode=disable'
go run ./cmd/facteur migrate --config config/example.yaml
go run . serve --config config/example.yaml
```

To run migrations without launching the HTTP server, invoke:

```bash
go run ./cmd/facteur migrate --config config/example.yaml
```

### Docker Compose sandbox

A convenience Compose stack lives at `services/facteur/docker-compose.yml`; it starts Postgres 18 with pgvector, Redis 8, and the Facteur server with the correct environment wiring (including `FACTEUR_DISABLE_DISPATCHER=true` to skip AgentRun submission during local runs). From the repository root run:

```bash
docker compose -f services/facteur/docker-compose.yml up -d --build
# ...
docker compose -f services/facteur/docker-compose.yml down --volumes --remove-orphans
```

## Observability

Facteur boots with OpenTelemetry telemetry enabled. Traces and metrics are exported via OTLP/HTTP, targeting the in-cluster observability deployment by default. The Knative manifest supplies the following environment variables:

- `OTEL_SERVICE_NAME=facteur`
- `OTEL_SERVICE_NAMESPACE` (populated from the pod namespace)
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://observability-tempo-gateway.observability.svc.cluster.local:4318/v1/traces`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://observability-mimir-gateway.observability.svc.cluster.local/otlp/v1/metrics`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://observability-loki-loki-distributed-gateway.observability.svc.cluster.local/loki/api/v1/push`

When running locally, point these values at your observability environment to keep telemetry flowing. The service emits counters such as `facteur_command_events_processed_total`, `facteur_command_events_failed_total`, and `facteur_command_events_dlq_total`, and wraps the Fiber HTTP server with OTEL middleware so HTTP requests appear in traces.

Cluster deployments rely on a namespace-scoped Grafana Alloy deployment (`argocd/applications/facteur/overlays/cluster/alloy-*.yaml`) to forward Knative pod logs to the observability Loki gateway (`observability-loki-loki-distributed-gateway`), since the Knative stack does not configure log shipping on its own.

### AgentRun dispatch

Discord command dispatch submits an `AgentRun` to the Agents service at `codex_implementation_orchestrator.agents_base_url`. The default production target is the `codex-agent` Agent in the `agents` namespace using the Agents-owned runtime.

## Container image

The service ships as `registry.ide-newton.ts.net/lab/facteur`. Pushes to `main` that touch `services/facteur/**` or `.github/workflows/facteur-build-push.yaml` trigger the `Facteur Docker Build and Push` workflow. The workflow builds linux/amd64 and linux/arm64 on native ARC runners, publishes per-arch tags, and assembles the final OCI index tags for `sha-<commit>` and `latest`. Rotate the image in Kubernetes by updating tags in `argocd/applications/facteur/overlays/cluster/kustomization.yaml` or allow Argo tooling to reference the desired tag.

## Deploying

The easiest way to ship a new build is the automation script in `packages/scripts`:

```bash
# From the repository root
bun packages/scripts/src/facteur/deploy-service.ts
```

It will:

1. Build `registry.ide-newton.ts.net/lab/facteur:<current commit>` (override with `FACTEUR_IMAGE_TAG`).
2. Push the image.
3. `kubectl apply -k argocd/applications/facteur/overlays/cluster` to reconcile config/Redis/Kafka sources.
4. `kn service apply` the refreshed image so a new revision rolls out.

The new revision will apply database migrations on startup using `FACTEUR_POSTGRES_DSN`. Monitor the first pod logs for `migration …` messages to confirm goose finished before traffic arrives. Run `go run ./cmd/facteur migrate` ahead of time if you want to validate the schema without rolling pods.

If you prefer to drive the deployment manually, you can still fall back to `kn service apply -f argocd/applications/facteur/overlays/cluster/facteur-service.yaml`, but you must ensure the container image tag in `argocd/applications/facteur/overlays/cluster/kustomization.yaml` is updated first.

## Infrastructure dependencies

`argocd/applications/facteur/overlays/cluster/facteur-redis.yaml` requests a standalone Redis instance managed by the OT-Container-Kit Redis Operator. The Knative Service targets the generated ClusterIP service (`redis://facteur-redis:6379/0`). Ensure the platform `redis-operator` Application remains healthy before syncing facteur; it must be available to reconcile the custom resource.

CloudNativePG delivers application credentials via the `facteur-vector-cluster-app` secret. The Knative Service maps the secret’s `uri` key into `FACTEUR_POSTGRES_DSN`, so keep that secret in sync before rolling deployments or running the standalone `facteur migrate` command.
