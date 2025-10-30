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

Set `FACTEUR_POSTGRES_DSN` to point at a Postgres instance before starting locally. The server applies embedded migrations on boot so the schema stays in sync.

To run migrations without launching the HTTP server, invoke:

```bash
go run ./cmd/facteur migrate --config config/example.yaml
```

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

## Container image

The service ships as `registry.ide-newton.ts.net/lab/facteur`. Pushes to `main` that touch `services/facteur/**` or `.github/workflows/facteur-build-push.yaml` trigger the `Facteur Docker Build and Push` workflow, which cross-builds (linux/amd64 + linux/arm64) using the local Dockerfile and pushes tags for `main`, `latest`, and the commit SHA. Rotate the image in Kubernetes by updating tags in `kubernetes/facteur/overlays/cluster/kustomization.yaml` or allow Argo tooling to reference the desired tag.

## Deploying

The easiest way to ship a new build is the automation script in `packages/scripts`:

```bash
# From the repository root
bun packages/scripts/src/facteur/deploy-service.ts
```

It will:

1. Build `registry.ide-newton.ts.net/lab/facteur:<current commit>` (override with `FACTEUR_IMAGE_TAG`).
2. Push the image.
3. `kubectl apply -k kubernetes/facteur/overlays/cluster` to reconcile config/Redis/Kafka sources.
4. `kn service apply` the refreshed image so a new revision rolls out.

The new revision will apply database migrations on startup using `FACTEUR_POSTGRES_DSN`. Monitor the first pod logs for `migration …` messages to confirm goose finished before traffic arrives. Run `go run ./cmd/facteur migrate` ahead of time if you want to validate the schema without rolling pods.

If you prefer to drive the deployment manually, you can still fall back to `kn service apply -f kubernetes/facteur/base/service.yaml`, but you must ensure the container image tag in `kubernetes/facteur/overlays/cluster/kustomization.yaml` is updated first.

## Infrastructure dependencies

`kubernetes/facteur/base/redis.yaml` requests a standalone `Redis` instance managed by the OT-Container-Kit Redis Operator. The Knative Service targets the generated ClusterIP service (`redis://facteur-redis:6379/0`). Ensure the platform `redis-operator` Application remains healthy before syncing facteur; it must be available to reconcile the custom resource.

CloudNativePG delivers application credentials via the `facteur-vector-cluster-app` secret. The Knative Service maps the secret’s `uri` key into `FACTEUR_POSTGRES_DSN`, so keep that secret in sync before rolling deployments or running the standalone `facteur migrate` command.
