# Graf Quarkus Migration — Current State

## Status Summary (November 11, 2025)

- ✅ Graf now runs entirely on Quarkus. All former Ktor route handlers have been replaced with Quarkus resources (`GraphResource`, `ServiceResource`) that delegate to the existing `GraphService`, Codex launchers, and AutoResearch workflows.
- ✅ JSON compatibility parity is restored: `KotlinSerializationConfig` produces a singleton `Json` instance with `ignoreUnknownKeys = true`, `explicitNulls = false`, and `encodeDefaults = true`, so `/v1/**` endpoints accept forward-compatible payloads exactly as before.
- ✅ HTTP/CORS and port settings come from `graf-quarkus-config` using uppercase Quarkus env keys (`QUARKUS_HTTP_*`, `QUARKUS_HTTP_CORS_*`), ensuring `envFrom` works and cross-origin clients keep functioning.
- ✅ Docker/Gradle toolchain updated to Kotlin 2.3.0, ktlint 14.0.1, and a Gradle 9.2 JDK25 builder + distroless Java 25 runtime; `quarkusBuild` artifacts are copied from `/workspace/build/quarkus-app`.
- ✅ Tests cover the new surface: `AutoResearchServiceTest`, `ServiceResourceTest`, and `KotlinSerializationConfigTest` guard the delegation logic, env wiring, and tolerant parsing. `./gradlew test` and `./gradlew koverXmlReport` pass locally, and Docker builds complete (`docker build -t graf-temp services/graf`).

## Runtime & API Surface

- `services/graf/src/main/kotlin/ai/proompteng/graf/resources/GraphResource.kt` now handles `/v1/entities`, `/v1/relationships`, `/v1/complement`, `/v1/clean`, `/v1/codex-research`, and `/v1/autoresearch`. Each method mirrors the former Ktor payloads and reuses `GrafRouteTemplate` for telemetry labels.
- `ServiceResource` keeps `/` and `/healthz` responses identical to the legacy service. Env reads go through `ServiceEnvironment.get(...)`, which eases testing and ensures PORT/version metadata reflects injected config.
- Serialization is provided via the CDI producer `KotlinSerializationConfig`. Because Quarkus injects this `Json` instance into RESTEasy Kotlin serialization, unknown keys no longer break existing clients (solving the regression called out in the code review).

## Security, RBAC, and Telemetry

- Bearer-token verification lives under `security/` and is wired into Quarkus filters exactly as before; no RBAC scope changes were required. The `graf` ServiceAccount plus `graf-workflows-clusterrolebinding` continue granting `create/get/list/watch/patch` on Argo `workflows` and `workflowtemplates`.
- `TelemetryFilters` and `GrafTelemetry` still apply OTEL spans/metrics for every route. The Knative deployment mounts `graf-otel-config` so Quarkus exporters can reach the same OTLP endpoints. Feature parity with the Ktor OTEL counters has been confirmed by exercising `/` and `/v1/entities` locally with the bearer token.

## Build, Config, and Deployment Notes

- Build entrypoint: `services/graf/build.gradle.kts` (Kotlin 2.3.0 plugins, ktlint 14.0.1, Kover 0.9.3). Ktlint/Kover tasks are part of CI, and `./gradlew test` is the primary validation command.
- Containerization: `services/graf/Dockerfile` performs a `quarkusBuild` inside `gradle:9.2-jdk25`, then copies `/workspace/build/quarkus-app` into `gcr.io/distroless/java25-debian12:nonroot`. This aligns with Knative’s expectation of a runnable `quarkus-run.jar`.
- Configuration: `argocd/applications/graf/graf-quarkus-configmap.yaml` now stores uppercase Quarkus env names (e.g., `QUARKUS_HTTP_CORS_ORIGINS`). Pods load it via `envFrom`, so adding new Quarkus properties only requires extending that ConfigMap. OTEL exporters remain in `graf-otel-config`.
- Deployment: the Knative service manifest still references the Quarkus image (`registry.ide-newton.ts.net/proompteng/graf:quarkus`), mounts Neo4j/MinIO secrets, and injects bearer-token material. No additional Kubernetes resources were required post-migration.

## Validation & Observability Checklist

1. `./gradlew test` — MUST run before every PR; covers Graph, Codex, AutoResearch, Service resources, and config producers.
2. `./gradlew koverXmlReport` — produces `build/reports/kover/report.xml` to track coverage (now ~45%, up from 43%).
3. `docker build -t graf-temp services/graf` — validates the multi-stage image and artifact copy path.
4. Post-deploy smoke: hit `/`, `/healthz`, `/v1/entities`, `/v1/autoresearch` with valid bearer tokens; verify logs include `GrafRouteTemplate` output and OTEL spans land in the collector supplied via `graf-otel-config`.

## Outstanding Items

- Identify any new reviewers required for long-term Quarkus ownership (still pending).
- Continue raising coverage on the remaining untested resources (GraphResource and ServiceResource integration paths currently rely on unit tests + manual verification).
- Keep the Codex progress comment (`<!-- codex:progress -->`) updated whenever additional rollout or telemetry validation happens.

## Rollback Strategy

- Container rollback: redeploy the previous Ktor image (tag recorded in Argo history) via `argocd app rollback graf <revision>`.
- Config rollback: reapply the historical `graf-configmap` if the uppercase Quarkus env vars cause issues; Quarkus tolerates lowercase keys only when mounted as `application.properties`, so revert to the old ConfigMap if needed.
- RBAC/Secret rollback: no changes were made, but the manifests live under `argocd/applications/graf`; re-syncing an earlier Git commit restores them.

This document now mirrors the actual Quarkus deployment rather than the initial plan. Update the “Outstanding Items” section as we close approvals or add new requirements.
