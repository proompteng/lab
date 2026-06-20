# Graf Codex Research Workflow

- Temporal: Graf starts a worker on `graf-codex-research`, connects to the in-cluster namespace (default `default`), and owns the orchestration history for Codex research requests.
- Agents: Graf submits `AgentRun` resources through `POST /v1/agent-runs` on the Agents control plane. The `graf-codex-agent` provider runs the generalized Codex app-server harness and uploads the declared artifact.
- Artifacts: Graf downloads the artifact from the Agents-owned `agents-artifacts` bucket after the AgentRun reaches `Succeeded`.

## Configuration

Set the following secrets/configmaps for the Knative Graf service:

| Env var                              | Description                                                                                | Default                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `TEMPORAL_ADDRESS`                   | gRPC endpoint for Temporal frontend (`temporal-frontend.temporal.svc.cluster.local:7233`). | required                                 |
| `TEMPORAL_NAMESPACE`                 | Namespace Graf worker should use.                                                          | `default`                                |
| `TEMPORAL_TASK_QUEUE`                | Task queue the Codex research workflow listens on.                                         | `graf-codex-research`                    |
| `TEMPORAL_IDENTITY`                  | Worker identity string sent to Temporal.                                                   | `graf`                                   |
| `AGENTS_BASE_URL`                    | Agents control-plane URL.                                                                  | `http://agents.agents.svc.cluster.local` |
| `AGENTS_NAMESPACE`                   | Namespace where Graf AgentRuns are created.                                                | `agents`                                 |
| `AGENTS_GRAF_AGENT_NAME`             | Agent resource Graf submits against.                                                       | `graf-codex-agent`                       |
| `AGENTS_SERVICE_ACCOUNT_NAME`        | ServiceAccount used by the runner Job.                                                     | `agents-sa`                              |
| `AGENTS_SECRET_BINDING_REF`          | SecretBinding required by Agents admission.                                                | `codex-github-token`                     |
| `AGENTS_RUN_SECRETS`                 | Comma-separated secrets requested by the run.                                              | `github-token,codex-auth,graf-api,...`   |
| `AGENTS_RUN_POLL_TIMEOUT_SECONDS`    | Maximum wait for AgentRun completion.                                                      | `7200`                                   |
| `AGENTS_ARTIFACTS_ENDPOINT`          | S3-compatible artifact endpoint used by the Agents runner and Graf downloader.             | required                                 |
| `AGENTS_ARTIFACTS_BUCKET`            | Agents-owned bucket where the runner uploads Graf artifacts.                               | `agents-artifacts`                       |
| `AGENTS_ARTIFACTS_ACCESS_KEY_ID`     | Access key for Graf to download runner artifacts.                                          | required                                 |
| `AGENTS_ARTIFACTS_SECRET_ACCESS_KEY` | Secret key for Graf to download runner artifacts.                                          | required                                 |
| `AGENTS_ARTIFACTS_REGION`            | Optional region hint.                                                                      | _unset_                                  |
| `AGENTS_ARTIFACTS_SECURE`            | `true/false` toggle when `AGENTS_ARTIFACTS_ENDPOINT` omits the scheme.                     | `true`                                   |

Graf no longer creates or polls Argo Workflows for Codex research. Artifact upload and download now use the Agents artifact contract end to end.

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
  "agentRunName": "codex-research-<uuid>",
  "artifactReferences": [
    {
      "bucket": "agents-artifacts",
      "key": "codex-research/codex-research-<uuid>/codex-artifact.json",
      "endpoint": "http://observability-minio.minio.svc.cluster.local:9000"
    }
  ]
}
```

Graf returns the expected artifact reference immediately; downstream consumers can poll the Agents artifact bucket or watch Temporal history while Graf submits and monitors the Agents/Codex run.

## Codex Graf helper

The Codex runtime now ships `codex-graf`, a Bun helper that can POST JSON payloads directly to the Graf HTTP API. It is installed inside the container at `/usr/local/bin/codex-graf` and accepts data via `--body`, `--body-file`, or STDIN.

```bash
cat payload.json \
  | codex-graf --endpoint /v1/entities \
    --graf-url http://graf.graf.svc.cluster.local \
    --token-file /var/run/secrets/codex/graf-token
```

`codex-graf` automatically sets `Content-Type: application/json`, masks the bearer token when logging, and respects the environment variables `CODEX_GRAF_BASE_URL` and `CODEX_GRAF_BEARER_TOKEN` when the CLI flags are omitted. Use it inside AgentRun/Temporal workflows or interactive sessions to persist Codex findings through the exposed `/v1/*` endpoints (entities, relationships, complement, clean, etc.) without invoking the `/v1/codex-research` route directly from Codex jobs.

## Agents Runtime

Graf uses the generic Agents CRDs in `argocd/applications/agents`:

```bash
kubectl -n agents apply -f argocd/applications/agents/graf-codex-agentprovider.yaml
kubectl -n agents apply -f argocd/applications/agents/graf-codex-agent.yaml
```

The AgentProvider ships the prompt through the versioned runner contract, executes the Codex app-server adapter, and uploads `/workspace/lab/codex-artifact.json` as the `codex-artifact` output artifact. Graf computes the bucket/key before the AgentRun finishes and downloads that object after the run succeeds.

## Testing / Validation

- `./gradlew test` (Graf module) runs the new unit tests for the MinIO fetcher and artifact parser.
- `curl -X POST http://localhost:8080/v1/codex-research -H Content-Type: application/json -d '{"prompt":"validate","metadata":{"source":"inspect"}}'` should return a JSON payload with `workflowId`.
- Confirm the Graf metrics panels (request rate, Neo4j latency, Codex workflows) render after syncing `argocd/applications/observability/graf-graf-dashboard-configmap.yaml`.

## Telemetry

- Graf now emits scoped OpenTelemetry signals that reach the Tempo/Mimir/Loki gateways described under `argocd/applications/observability`. Logs include `trace_id`, `span_id`, and `request_id` so Grafana Alloy can correlate them in Loki.
- `GrafTelemetry` instruments the HTTP APIs, Neo4j client, Codex workflows, and MinIO artifact fetcher, exposing metrics such as `graf_http_server_requests_count`, `graf_neo4j_write_duration_ms`, `graf_codex_workflows_started`, and `graf_artifact_fetch_duration_ms`.
- Alerts defined in `graf-mimir-rules.yaml` fire on elevated 5xx ratios (`GrafHigh5xxRate`), lack of requests (`GrafNoRequests`), or service downtime (`GrafServiceDown`). Verify the deployment and dashboards stay healthy before promoting the release.
