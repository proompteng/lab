# facteur

`facteur` is a Go service that mediates Discord bot commands into Argo Workflow executions. It follows the [Discord interaction lifecycle](https://discord.com/developers/docs/interactions/receiving-and-responding) and the [Argo Workflows submission model](https://argo-workflows.readthedocs.io/en/stable/) to translate slash commands into WorkflowTemplate runs. See `docs/facteur-discord-argo.md` for the end-to-end architecture and configuration contract.

## Layout

- `cmd/facteur`: Cobra-based CLI entrypoints.
- `internal`: Internal packages that will house configuration, Discord routing, Argo bridge logic, and session storage.
- `config`: Example configuration files and schema references (role map schema lives at `schemas/facteur-discord-role-map.schema.json`).
- `Dockerfile`: Multi-stage build for containerizing the service.

Refer to the repository docs for detailed integration guidance and follow-up tasks.

## Running locally

```bash
cd services/facteur
go run . serve --config config/example.yaml
```

The `--config` flag is optional if you provide the required `FACTEUR_*` environment variables. Press `Ctrl+C` to stop the server; it will shut down gracefully.

Set `FACTEUR_POSTGRES_DSN` to point at a Postgres instance before starting locally. The server applies embedded migrations on boot so the schema stays in sync. When you do not have a Kubernetes cluster handy, export `FACTEUR_DISABLE_DISPATCHER=true` so the Argo dispatcher is stubbed out and the service boots without a kubeconfig. A simple local setup uses Postgres on `127.0.0.1:6543/postgres` with the `facteur` role:

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

A convenience Compose stack lives at `services/facteur/docker-compose.yml`; it starts Postgres 18 with pgvector, Redis 8, and the Facteur server with the correct environment wiring (including `FACTEUR_DISABLE_DISPATCHER=true` to skip Argo during local runs). From the repository root run:

```bash
docker compose -f services/facteur/docker-compose.yml up -d --build
# ...
docker compose -f services/facteur/docker-compose.yml down --volumes --remove-orphans
```

Run the end-to-end Codex ingestion check (spins the stack, posts a sample task, and asserts persistence) with:

```bash
export FACTEUR_E2E_BASE_URL="http://127.0.0.1:18080"
export FACTEUR_E2E_POSTGRES_DSN="postgres://facteur:facteur@127.0.0.1:15432/facteur_kb?sslmode=disable"
go test -tags e2e ./services/facteur/test/e2e
```

### Codex knowledge base ingestion

Facteur persists Codex deliveries under `/codex/tasks` by normalising the `proompteng.froussard.v1.CodexTask` payload into `codex_kb.ideas`, `codex_kb.tasks`, and `codex_kb.task_runs`. The handler requires `FACTEUR_POSTGRES_DSN` and `redis.url`; each delivery must include a unique `delivery_id` so retries remain idempotent.

1. Ensure the service is running with Postgres and Redis reachable (see above).
2. Encode the sample payload provided in `docs/examples/codex-task.json`:
   ```bash
  buf beta protoc \
    --proto_path=proto \
    --encode proompteng.froussard.v1.CodexTask \
    proto/proompteng/froussard/v1/codex_task.proto \
     < docs/examples/codex-task.json \
     > /tmp/codex-task.bin
   ```
3. Send the request to the local server:
   ```bash
   curl -v \
     -H 'Content-Type: application/x-protobuf' \
     --data-binary @/tmp/codex-task.bin \
     http://127.0.0.1:8080/codex/tasks
   ```
4. Inspect persisted rows:
   ```bash
   psql "$FACTEUR_POSTGRES_DSN" -c "SELECT tasks.id, tasks.stage, task_runs.delivery_id FROM codex_kb.tasks JOIN codex_kb.task_runs ON task_runs.task_id = tasks.id;"
   ```

Replaying the same `delivery_id` results in a `202 Accepted` response with unchanged `task_run` IDs, confirming idempotent intake.

## Observability

Facteur boots with OpenTelemetry telemetry enabled. Traces and metrics are exported via OTLP/HTTP, targeting the in-cluster observability deployment by default. The Knative manifest supplies the following environment variables:

- `OTEL_SERVICE_NAME=facteur`
- `OTEL_SERVICE_NAMESPACE` (populated from the pod namespace)
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://observability-tempo-gateway.observability.svc.cluster.local:4318/v1/traces`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://observability-loki-loki-distributed-gateway.observability.svc.cluster.local/loki/api/v1/push`

When running locally, point these values at your observability environment to keep telemetry flowing. The service emits counters such as `facteur_command_events_processed_total`, `facteur_command_events_failed_total`, and `facteur_command_events_dlq_total`, and wraps the Fiber HTTP server with OTEL middleware so HTTP requests appear in traces.

Cluster deployments rely on a namespace-scoped Grafana Alloy deployment (`argocd/applications/facteur/overlays/cluster/alloy-*.yaml`) to forward Knative pod logs to the observability Loki gateway (`observability-loki-loki-distributed-gateway`), since the Knative stack does not configure log shipping on its own.

### Codex implementation orchestration

Implementation runs through the implementation orchestrator (`codex_implementation_orchestrator.enabled=true`, or the env alias `FACTEUR_CODEX_ENABLE_IMPLEMENTATION_ORCHESTRATION`) to submit the `github-codex-implementation` workflow with the same persistence + idempotency guarantees. When a Codex task is marked autonomous, Facteur switches to the `codex-autonomous` workflow template (configurable via `codex_implementation_orchestrator.autonomous_workflow_template`).

## Container image

The service ships as `registry.ide-newton.ts.net/lab/facteur`. Pushes to `main` that touch `services/facteur/**` or `.github/workflows/facteur-build-push.yaml` trigger the `Facteur Docker Build and Push` workflow, which cross-builds (linux/amd64 + linux/arm64) using the local Dockerfile and pushes tags for `main`, `latest`, and the commit SHA. Rotate the image in Kubernetes by updating tags in `argocd/applications/facteur/overlays/cluster/kustomization.yaml` or allow Argo tooling to reference the desired tag.

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
