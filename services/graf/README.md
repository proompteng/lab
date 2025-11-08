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

## Container image
Build and push using the shared script so it tags the image that Argo CD pulls:
```bash
bun packages/scripts/src/graf/build-image.ts
```
The entrypoint is `bin/graf` from Gradle's `installDist`, and the runtime image is a distroless Java 21 runtime.
