# Graf Codex Research Workflow

- Temporal: Graf starts a worker on `graf-codex-research`, connects to the in-cluster namespace (default `default`), and uses the Kubernetes service account token to push Argo workflows.
- Argo: the new `codex-research-workflow` template (see `argocd/applications/argo-workflows/codex-research-workflow.yaml`) accepts prompts, runs the Codex runner container, and writes a structured JSON artifact to `MinIO`.
- MinIO: Graf downloads the artifact from the shared bucket (`argo-workflows` by default) using the same ServiceAccount credentials that power the Argo template.

## Configuration

Set the following secrets/configmaps for the Knative Graf service:

| Env var | Description | Default |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | gRPC endpoint for Temporal frontend (`temporal-frontend.temporal.svc.cluster.local:7233`). | required |
| `TEMPORAL_NAMESPACE` | Namespace Graf worker should use. | `default` |
| `TEMPORAL_TASK_QUEUE` | Task queue the Codex research workflow listens on. | `graf-codex-research` |
| `TEMPORAL_IDENTITY` | Worker identity string sent to Temporal. | `graf` |
| `ARGO_API_SERVER` | Kubernetes API host (usually `https://kubernetes.default.svc`). | default |
| `ARGO_NAMESPACE` | Namespace where the Argo workflow lives. | `argo-workflows` |
| `ARGO_WORKFLOW_TEMPLATE_NAME` | Template Graf submits. | `codex-research-workflow` |
| `MINIO_ENDPOINT` | MinIO URL (e.g., `http://observability-minio.minio.svc.cluster.local:9000`). | required |
| `MINIO_BUCKET` | Archive bucket where Argo stores the artifact. | `argo-workflows` |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Credentials for Graf to talk to MinIO. | required |

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
    --graf-url http://graf.graf.svc.cluster.local:8080 \
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

## NVIDIA prompt catalog

Graf ships a versioned catalog under `docs/codex`. `docs/codex/nvidia-prompt-schema.json` defines the metadata envelope that every prompt pack must satisfy (promptId, streamId, expectedArtifact, citations, scoringHeuristics, metadata). The six stream-specific packs (`foundries.json`, `odm-ems.json`, `logistics-ports.json`, `research-partners.json`, `financing-risk.json`, `instrumentation-vendors.json`) live in `docs/codex/nvidia-prompts` and mirror the high-level streams described in `docs/nvidia-supply-chain-graph-design.md`. When you edit or add prompts:

- validate the JSON against `docs/codex/nvidia-prompt-schema.json`
- keep `schemaVersion` incremented for non-backwards-compatible envelope changes
- update the metadata section (artifactIdPrefix, researchSource, priority, streamTag) so Graf can label Neo4j nodes before the Temporal workflow even runs

The Kotlin service loads this catalog at startup and binds it to `POST /v1/codex-research`, so prompt updates immediately change how Codex metadata is materialized in Neo4j.

## Graf prompt driver

`packages/scripts/src/graf/run-prompts.ts` is a Bun CLI that walks the catalog, validates each pack against `nvidia-prompt-schema.json`, and POSTs the payload to Graf's `/v1/codex-research`. The script:

- defaults to `http://localhost:8080` but honors `GRAF_BASE_URL`
- requires `GRAF_TOKEN` unless you are running with `--dry-run`
- supports `--prompt-id <id>` to target a single stream (e.g., `—prompt-id foundries`)
- logs promptId, workflowId, runId, and artifactReferences for Temporal/MinIO monitoring
- fails fast whenever Graf replies with a non-2xx HTTP status

Run it like this:

```bash
GRAF_BASE_URL=http://localhost:8080 GRAF_TOKEN=test \
  bun packages/scripts/src/graf/run-prompts.ts --dry-run
```

To drive production workloads, omit `--dry-run`, point `GRAF_BASE_URL` at the Graf service, and capture the logged workflow/run IDs plus any artifact references for Temporal operators.

## Capturing workflow evidence

The driver logs `promptId`, `workflowId`, `runId`, and the list of `artifactReferences`. Include those triples plus the corresponding Timed `artifactReferences` in PR verification so reviewers can correlate Temporal history with the catalog entry that generated it.

## Testing / Validation

- `./gradlew test` (Graf module) runs the new Kotlin unit tests covering ArgoWorkflowClient polling, Minio artifact fetching, and catalog-consistent persistence.
- `./gradlew koverHtmlReport` publishes coverage so you can point reviewers at the new lines exercising Argo retries, artifact decoding, and GraphService persistence.
- `GRAF_BASE_URL=http://localhost:8080 GRAF_TOKEN=test bun packages/scripts/src/graf/run-prompts.ts --dry-run` proves prompt loading and schema validation before hitting a live Graf instance.
