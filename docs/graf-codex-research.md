# Graf Codex Research Workflow

- Temporal: Graf starts a worker on `graf-codex-research`, connects to the in-cluster namespace (default `default`), and uses the Kubernetes service account token to push Argo workflows.
- Argo: the new `codex-research-workflow` template (see `argocd/applications/argo-workflows/codex-research-workflow.yaml`) accepts prompts, runs the Codex runner container, and writes a structured JSON artifact to `MinIO`.
- MinIO: Graf downloads the artifact from the configured bucket (production uses `argo-workflows`) using the same ServiceAccount credentials that power the Argo template.

## Configuration

Set the following secrets/configmaps for the Knative Graf service:

| Env var                                 | Description                                                                                | Default                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| `TEMPORAL_ADDRESS`                      | gRPC endpoint for Temporal frontend (`temporal-frontend.temporal.svc.cluster.local:7233`). | required                  |
| `TEMPORAL_NAMESPACE`                    | Namespace Graf worker should use.                                                          | `default`                 |
| `TEMPORAL_TASK_QUEUE`                   | Task queue the Codex research workflow listens on.                                         | `graf-codex-research`     |
| `TEMPORAL_IDENTITY`                     | Worker identity string sent to Temporal.                                                   | `graf`                    |
| `ARGO_API_SERVER`                       | Kubernetes API host (usually `https://kubernetes.default.svc`).                            | default                   |
| `ARGO_NAMESPACE`                        | Namespace where the Argo workflow lives.                                                   | `argo-workflows`          |
| `ARGO_WORKFLOW_TEMPLATE_NAME`           | Template Graf submits.                                                                     | `codex-research-workflow` |
| `MINIO_ENDPOINT`                        | MinIO URL (e.g., `http://observability-minio.minio.svc.cluster.local:9000`).               | required                  |
| `MINIO_BUCKET`                          | Archive bucket where Argo stores the artifact.                                             | required                  |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Credentials for Graf to talk to MinIO.                                                     | required                  |
| `MINIO_REGION`                          | Optional region hint passed to both Graf and the Argo template.                            | _unset_                   |
| `MINIO_SECURE`                          | `true/false` toggle when `MINIO_ENDPOINT` omits the scheme.                                | `true`                    |

Graf now bundles the Knative service account with a `Role`/`RoleBinding` in `argocd/applications/argo-workflows/codex-research-rbac.yaml` so it can create and poll workflows in `argo-workflows`.

## HTTP contract

```http
POST /v1/codex-research
Content-Type: application/json
{
  "prompt": "Summarize the February release notes",
  "metadata": {"source": "ops"}
}
```

**Response** (`202 Accepted`):

```json
{
  "workflowId": "graf-codex-research-<uuid>",
  "runId": "<temporal-run-id>",
  "argoWorkflowName": "codex-research-<uuid>",
  "artifactReferences": [
    {
      "bucket": "argo-workflows",
      "key": "codex-research/codex-research-<uuid>/codex-artifact.json",
      "endpoint": "http://observability-minio.minio.svc.cluster.local:9000"
    }
  ]
}
```

Graf returns the expected artifact reference immediately; downstream consumers can poll MinIO or watch Temporal history while Graf orchestrates the Argo/Codex run.

## Codex Graf helper

The Codex runtime now ships `codex-graf`, a Bun helper that can POST JSON payloads directly to the Graf HTTP API. It is installed inside the container at `/usr/local/bin/codex-graf` and accepts data via `--body`, `--body-file`, or STDIN.

```bash
cat payload.json \
  | codex-graf --endpoint /v1/entities \
    --graf-url http://graf.graf.svc.cluster.local \
    --token-file /var/run/secrets/codex/graf-token
```

`codex-graf` automatically sets `Content-Type: application/json`, masks the bearer token when logging, and respects the environment variables `CODEX_GRAF_BASE_URL` and `CODEX_GRAF_BEARER_TOKEN` when the CLI flags are omitted. Use it inside Argo/Temporal workflows or interactive sessions to persist Codex findings through the exposed `/v1/*` endpoints (entities, relationships, complement, clean, etc.) without invoking the `/v1/codex-research` route directly from Codex jobs.

## Argo workflow

`codex-research-workflow` lives in `argocd/applications/argo-workflows`. Operators can sync it with:

```bash
kubectl -n argo-workflows apply -f argocd/applications/argo-workflows/codex-research-workflow.yaml
kubectl -n argo-workflows apply -f argocd/applications/argo-workflows/codex-research-rbac.yaml
```

The template ships the prompt into the Codex container, unlocks `codex exec`, and captures `/workspace/lab/codex-artifact.json` as an S3 artifact. The artifact is wired into MinIO via template parameters so Graf can compute the bucket/key before the workflow finishes.

## Testing / Validation

- `./gradlew test` (Graf module) runs the new unit tests for the MinIO fetcher and artifact parser.
- `curl -X POST http://localhost:8080/v1/codex-research -H Content-Type: application/json -d '{"prompt":"validate","metadata":{"source":"inspect"}}'` should return a JSON payload with `workflowId`.
- Confirm the Graf metrics panels (request rate, Neo4j latency, Codex workflows) render after syncing `argocd/applications/observability/graf-graf-dashboard-configmap.yaml`.

## Telemetry

- Graf now emits scoped OpenTelemetry signals that reach the Tempo/Mimir/Loki gateways described under `argocd/applications/observability`. Logs include `trace_id`, `span_id`, and `request_id` so Grafana Alloy can correlate them in Loki.
- `GrafTelemetry` instruments the HTTP APIs, Neo4j client, Codex workflows, and MinIO artifact fetcher, exposing metrics such as `graf_http_server_requests_count`, `graf_neo4j_write_duration_ms`, `graf_codex_workflows_started`, and `graf_artifact_fetch_duration_ms`.
- Alerts defined in `graf-mimir-rules.yaml` fire on elevated 5xx ratios (`GrafHigh5xxRate`), lack of requests (`GrafNoRequests`), or service downtime (`GrafServiceDown`). Verify the deployment and dashboards stay healthy before promoting the release.
