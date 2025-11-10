# Graf (Neo4j persistence service)

This Kotlin/Ktor microservice implements the persistence layer described in [docs/nvidia-supply-chain-graph-design.md](../../docs/nvidia-supply-chain-graph-design.md). It exposes CRUD/complement/clean endpoints, validates payload shapes, and writes changes to Neo4j using the official Java driver.

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

- Set `AGENT_ENABLED=true` plus either `AGENT_OPENAI_API_KEY` or `OPENAI_API_KEY`. Optional overrides: `AGENT_OPENAI_BASE_URL`, `AGENT_MODEL` (defaults to `gpt-5`), `AGENT_MAX_ITERATIONS`, `AGENT_GRAPH_SAMPLE_LIMIT`.
- Koog trace logs are enabled by default so every agent step/tool execution hits the service logs. Set `AGENT_TRACE_LOGGING=false` to disable. Use `AGENT_TRACE_LOG_LEVEL` (`INFO` or `DEBUG`; any other value falls back to `INFO`) to tune verbosity.
- When enabled, `POST /v1/autoresearch` kicks off the AutoResearch ReAct agent with the `graph_state_tool`. The agent follows the OpenAI Cookbook guidance for multi-step planners, runs on GPT-5 with **High** reasoning effort, and targets the entire NVIDIA relationship surface (partners, manufacturers, suppliers, investors, research alliances—not only supply chain tiers). Provide a JSON body:
  ```json
  {
    "objective": "Map NVIDIA's 2025 AI research alliances across universities and vendors",
    "focus": "research",
    "streamId": "ecosystem-west",
    "metadata": {
      "artifactId": "temporal://streams/ecosystem-west/2025-11-09"
    }
  }
  ```
  The API responds immediately (`202 Accepted`) with the Temporal workflow metadata (IDs, timestamps) so clients can poll progress asynchronously. A downstream worker writes the eventual plan to storage once the agent completes; the agent inspects the live Neo4j graph through the graph snapshot tool before suggesting updates.
