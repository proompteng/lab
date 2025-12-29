# Graf (Neo4j persistence service)

This Quarkus/Kotlin microservice implements the persistence layer described in [docs/nvidia-company-research.md](../../docs/nvidia-company-research.md). It exposes CRUD/complement/clean endpoints via RESTEasy Reactive, validates payload shapes, and writes changes to Neo4j using the official Java driver.

## Features
- `POST /v1/entities` / `POST /v1/relationships` for upserts with artifact provenance metadata.
- `PATCH` routes that merge property deltas and keep an `updatedAt` timestamp per mutation.
- Soft deletes (`DELETE /v1/{entities,relationships}/{id}`) annotate `deletedAt`/`deletedArtifactId` rather than removing nodes so Temporal workflows can audit.
- `POST /v1/complement` enriches nodes with hints while tagging the run, and `POST /v1/clean` marks stale or artifact-specific records for cleanup.
- `Neo4jClient` wraps the driver so the service can share a single connection pool and keep Kotlin coroutines off the IO dispatcher.

## Environment
| Variable | Purpose |
| --- | --- |
| `NEO4J_URI` | Bolt/Neo4j URI (e.g. `bolt://graf-neo4j.graf.svc.cluster.local:7687`). |
| `NEO4J_USER` | Username (defaults to `neo4j`). |
| `NEO4J_PASSWORD` | Password (required unless `NEO4J_AUTH` is supplied). |
| `NEO4J_AUTH` | Combined credentials (`neo4j/<password>`) emitted by the Helm chart Secret; overrides `NEO4J_USER`/`NEO4J_PASSWORD`. |
| `NEO4J_DATABASE` | Database name (defaults to `neo4j`). |
| `QUARKUS_HTTP_PORT` / `PORT` | HTTP port (defaults to `8080`; Quarkus reads both). |
| `QUARKUS_HTTP_CORS_*` | CORS toggles injected via `graf-quarkus-config`. |
| `GRAF_API_BEARER_TOKENS` | Comma/space-delimited bearer tokens for `/v1/**`. |
| `TEMPORAL_*`, `ARGO_*`, `MINIO_*` | See [docs/graf-codex-research.md](../../docs/graf-codex-research.md) for workflow + artifact requirements. |

## AutoResearch configuration

The AutoResearch prompt builder now sources every prompt label and metadata tag from environment variables. The baked-in defaults are vendor-agnostic (`Graf AutoResearch Knowledge Base` and `auto-research` for the stage/stream), so you can ship a neutral experience even before overriding the env vars.

- `AUTO_RESEARCH_KB_NAME` – Knowledge-base name shown in the prompt header and ROLE description (default `Graf AutoResearch Knowledge Base`).
- `AUTO_RESEARCH_STAGE` – Used for the `codex.stage` label and (after DNS-1123 sanitization) as the prefix on AutoResearch Argo workflows and metadata (defaults to `auto-research`).
- `AUTO_RESEARCH_STREAM_ID` – Stream value injected into the prompt text and every `codex-graf` payload (defaults to `auto-research`).
- `AUTO_RESEARCH_OPERATOR_GUIDANCE` – Fallback guidance added when the caller leaves `user_prompt` blank.
- `AUTO_RESEARCH_DEFAULT_GOALS` – Newline-separated numbered goals that replace the GOALS block inside the prompt.

After updating any of these values, redeploy Graf (for example, via `bun packages/scripts/src/graf/deploy-service.ts`) so the new configuration reaches the Knative service. Coordinate with the Graf deploy owners before flipping the stage/stream names that automation dashboards expect. See `docs/nvidia-company-research.md` for the general knowledge-base story (the old docs/nvidia-supply-chain-graph-design.md detail now lives in an NVIDIA appendix) and how to retarget the experience to another domain.

## Observability

Graf now boots an OpenTelemetry SDK that exports traces, metrics, and structured logs to the shared Tempo/Mimir/Loki stack managed under `argocd/applications/observability`. The service honors the following environment variables:

| Variable | Purpose |
| --- | --- |
| `OTEL_SERVICE_NAME` | Service name attached to every telemetry signal (defaults to `graf`). |
| `OTEL_SERVICE_NAMESPACE` | Service namespace (defaults to `graf`). |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource tags such as `deployment.environment=prod`. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Protocol used when talking to the Tempo/Mimir/Loki gateways (`http/protobuf`). |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Tempo OTLP traces endpoint. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Mimir OTLP metrics endpoint. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Loki ingestion endpoint. |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | Sampler strategy (default `parentbased_traceidratio` with argument `0.2`). |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval in milliseconds (default `10000`). |

Custom metrics exported by Graf include:

| Metric | Description |
| --- | --- |
| `graf_http_server_requests_count` | Request rate with labels for method, status, and route. |
| `graf_http_server_request_duration_ms` | Request latency histogram. |
| `graf_neo4j_write_duration_ms` | Neo4j write latency. |
| `graf_codex_workflows_started` | Codex workflow launches. |
| `graf_artifact_fetch_duration_ms` | MinIO artifact fetch latency. |

Logs are written in JSON via `net.logstash.logback.encoder.LoggingEventCompositeJsonEncoder` with `trace_id`, `span_id`, and `request_id` MDC fields emitted by the `CallId` + OpenTelemetry wiring, so Loki queries can correlate traces and logs. Grafana Alloy (deployed in the `graf` namespace) is responsible for shipping these JSON logs to Loki.

Want to validate things locally? Point the OTLP env vars at a local collector/Tempo/Mimir/Loki stack before running `quarkusDev`:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics \
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:4318/v1/logs \
./gradlew quarkusDev
```

## Local development
```bash
cd services/graf
# generate/update wrapper only if needed
./gradlew test
./gradlew quarkusDev          # hot-reload dev server on :8080
./gradlew clean quarkusBuild  # produces build/quarkus-app for container packaging
```

## Code coverage
- Run `./gradlew koverHtmlReport` (after `clean`/`build` or on its own). Kover executes unit tests and writes the HTML report to `build/reports/kover/html/index.html` so you can browse the per-class dashboard.
- To get a JaCoCo-compatible XML summary (e.g. for CI upload), run `./gradlew koverXmlReport`; the default XML path is `build/reports/kover/xml/report.xml`.

## Formatting
Run `./gradlew ktlintCheck` (the same plugin also supports `./gradlew ktlintFormat` if you want the auto-format step).

## Container image + deployment

1. Build & push the Graf image via the shared script:
   ```bash
   bun packages/scripts/src/graf/build-image.ts
   ```

2. Deploy the Knative service using `kn` (the helper rebuilds the image before deploying):
   ```bash
   bun packages/scripts/src/graf/deploy-service.ts
   ```
The runtime image copies `build/quarkus-app` into `gcr.io/distroless/java25:nonroot` and starts `quarkus-run.jar`.

## Startup behavior

- `GrafConfiguration` observes Quarkus' `StartupEvent` and pings Temporal, Neo4j, and MinIO during boot, eliminating the first-request cold start before readiness probes mark the pod healthy.

## AutoResearch Codex workflow

- `POST /v1/autoresearch` launches the same Temporal/Argo Codex workflow that powers `/v1/codex-research`, but it injects a curated prompt that tells Codex to keep expanding the Graf knowledge graph and to persist findings directly via the bundled `/usr/local/bin/codex-graf` CLI.
- The request body accepts a single optional field, `user_prompt`, which is appended to the base instructions. Example:
  ```json
  {
    "user_prompt": "Focus on HBM capacity expansions across ASE, Samsung, and SK hynix"
  }
  ```
- Response payload mirrors the Codex endpoint and includes Temporal workflow metadata plus the MinIO artifact reference:
  ```json
  {
    "workflowId": "wf-123",
    "runId": "run-123",
    "argoWorkflowName": "auto-research-123",
    "artifactReferences": [
      {
        "bucket": "argo-workflows",
        "key": "codex-research/auto-research-123/codex-artifact.json",
        "endpoint": "http://observability-minio.minio.svc.cluster.local:9000"
      }
    ],
    "startedAt": "2025-11-10T05:00:00Z",
    "message": "AutoResearch Codex workflow started"
  }
  ```
  - The injected prompt (see `AutoResearchPromptBuilder`) now reads branding from `AUTO_RESEARCH_KB_NAME`, uses `AUTO_RESEARCH_STAGE` for the `codex.stage` label and Argo workflow prefix, embeds whatever `AUTO_RESEARCH_STREAM_ID` you configure, and falls back to `AUTO_RESEARCH_OPERATOR_GUIDANCE` plus `AUTO_RESEARCH_DEFAULT_GOALS` when the caller omits `user_prompt`. It still asks Codex to log every POST with `artifactId`, `researchSource`, and the configured stream metadata, then summarize the persisted entities in `codex-artifact.json`. See `docs/nvidia-company-research.md` (the updated home for the previous docs/nvidia-supply-chain-graph-design.md narrative) for the broader knowledge-base story and the NVIDIA appendix.
