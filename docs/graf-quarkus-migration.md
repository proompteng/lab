# Graf Quarkus Migration

## Summary
- Replaced the old Ktor stack with a Quarkus-native module that reuses the existing Neo4j, Temporal, MinIO, AutoResearch, and Codex logic but exposes the REST surface via JAX-RS resources and CDI beans.
- Added request/response filters that keep the same OTEL counters, logging semantics, and bearer-token guard while the Graf HTTP routes still live under `/`, `/healthz`, and `/v1`.
- Gradle now uses the Quarkus BOM, Kotlin serialization support, and produces a `quarkus-app` artifact that the updated image (`registry.ide-newton.ts.net/proompteng/graf:quarkus`) runs.

## Config
- Introduced `graf-quarkus-config` with Quarkus HTTP/CORS settings; the Knative service loads it with the existing `graf-otel-config` data.
- The service sets `QUARKUS_HTTP_PORT`/`QUARKUS_HTTP_HOST` (in addition to `PORT`) so the runner listens on the expected port while reusing the same Neo4j, MinIO, and OTEL secrets.
- Service account token/CA paths, bearer-token secrets, and OTEL exporters remain untouched so Graf keeps submitting Argo workflows via the existing `argo-workflows` namespace values.

## RBAC
- No new verbs were added. `graf` still binds to the `argo-workflows-edit` ClusterRole via `graf-workflows-clusterrolebinding.yaml`, which provides `create/get/list/watch/patch` on Argo `workflows`/`workflowtemplates`.
- Keep reviewing `argo-workflows-edit` if Graf ever needs additional cluster-scoped resources, but the Quarkus rewrite does not touch extra APIs.

## Validation & Observability
1. `./gradlew :services:graf:check` (build + lint + Quarkus platform validation).
2. `./gradlew :services:graf:test` (temporal/graph logic tests).
3. Confirm Graf pods/staging jobs mount `graf-quarkus-config`/`graf-otel-config`, the `graf` service account, and the MinIO/Neo4j/OTEL secrets before syncing.
4. After deployment, hit `/`, `/healthz`, and `/v1` endpoints through the bearer token(s) listed in `graf-api` to make sure responses and OTEL counters stay intact.

## Risks & Rollback
- Quarkus still depends on the service account token/CA so double-check the Knative service mounts before rollout.
- If any RBAC regression appears, revert `graf-workflows-clusterrolebinding.yaml` or the `graf` SA binding back to the narrower workflow verbs.
