# Graf (Neo4j persistence service)

This Kotlin/Ktor microservice implements the persistence layer described in [docs/graf-knowledge-base-design.md](../../docs/graf-knowledge-base-design.md). It exposes CRUD/complement/clean endpoints, validates payload shapes, and writes changes to Neo4j using the official Java driver.

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
| `PORT` | HTTP port (default `8080`). |

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

Want to validate things locally? Point the OTLP env vars at a local collector/Tempo/Mimir/Loki stack before running the service:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics \
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:4318/v1/logs \
./gradlew run
```

## Local development
```bash
cd services/graf
gradle wrapper --gradle-version 8.5 # already committed; only needed if you regenerate
./gradlew clean build
tail -n +1 build/logs/*
./gradlew run
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
The entrypoint is `bin/graf` from Gradle's `installDist`, and the runtime image is a distroless Java 21 runtime.

## AutoResearch GPT-5 relationship planner

- Set `AGENT_ENABLED=true` plus either `AGENT_OPENAI_API_KEY` or `OPENAI_API_KEY`. Optional overrides: `AGENT_OPENAI_BASE_URL`, `AGENT_MODEL` (defaults to `gpt-5`), `AGENT_MAX_ITERATIONS`, `AGENT_GRAPH_SAMPLE_LIMIT`, and the new AutoResearch metadata vars documented in docs/graf-knowledge-base-design.md.
- Koog trace logs are enabled by default so every agent step/tool execution hits the service logs. Set `AGENT_TRACE_LOGGING=false` to disable. Use `AGENT_TRACE_LOG_LEVEL` (`INFO` or `DEBUG`; any other value falls back to `INFO`) to tune verbosity.
- When enabled, `POST /v1/autoresearch` kicks off the AutoResearch ReAct agent with the `graph_state_tool`. The agent follows the OpenAI Cookbook guidance for multi-step planners, runs on GPT-5 with **High** reasoning effort, and targets the broader Graf knowledge base (partners, manufacturers, suppliers, research alliances, and operational dependencies). Provide a JSON body:
  ```json
  {
    "objective": "Map 2025 supply chain alliances across universities and vendors",
    "focus": "research",
    "streamId": "knowledge-stream-west",
    "metadata": {
      "artifactId": "temporal://streams/knowledge-stream-west/2025-11-09"
    }
  }
  ```
  The API responds immediately (`202 Accepted`) with the Temporal workflow metadata (IDs, timestamps) so clients can poll progress asynchronously. A downstream worker writes the eventual plan to storage once the agent completes; the agent inspects the live Neo4j graph through the graph snapshot tool before suggesting updates.
- Retarget the AutoResearch prompt by changing `AGENT_KNOWLEDGE_BASE_NAME`, `AGENT_KNOWLEDGE_BASE_STAGE`, `AGENT_OPERATOR_GUIDANCE`, and `AGENT_DEFAULT_STREAM_ID` so the agent describes the desired domain and metadata tags without touching Kotlin.
