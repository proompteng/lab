# Graf Quarkus Migration

### Objective
- Describe how to replace the Ktor/Netty Graf service with a Quarkus-native runtime while keeping every `/`, `/healthz`, and `/v1/**` endpoint, onboarding the existing Neo4j/Temporal/MinIO/Codex workflows, and maintaining the bearer-token + RBAC guardrails that let Graf keep submitting Argo workflows.

### Context & Constraints
- The current runtime wiring lives in `services/graf/src/main/kotlin/ai/proompteng/graf/Application.kt:87`, `routes/GraphRoutes.kt:30`, and the helper services under `resources/`, `services/`, and `codex/` that assume a Ktor request/response lifecycle and the bearer-token guard defined in `ApiBearerTokenConfig`.
- Graf talks to Neo4j, MinIO, Argo, and OpenTelemetry from environment-bound config (`GrafConfiguration`) so the Quarkus module must reuse the same env vars plus the `graf-otel-config` secrets currently mounted by `argocd/applications/graf/knative-service.yaml` and `graf-quarkus-configmap.yaml`.
- Deployment runs through the `graf` service account in `argocd/applications/graf/service-account.yaml` with the `graf-workflows-clusterrolebinding.yaml` cluster role binding (Argo `workflows`/`workflowtemplates`, verbs `create/get/list/watch/patch`). Quarkus must keep those permissions or document the precise additions in the RBAC manifest without widening scope beyond workflow operations.

### Task Breakdown
1. **Route surface & business logic** – Replace `GraphRoutes.kt` with Quarkus resources (`services/graf/src/main/kotlin/ai/proompteng/graf/resources/GraphResource.kt`, `ServiceResource.kt`) that delegate to `GraphService` (`services/graf/src/main/kotlin/ai/proompteng/graf/services/GraphService.kt`) and reuse the Codex/AutoResearch launchers plus `codex/ArgoWorkflowClient.kt`. Confirm the new `GrafRouteTemplate` keeps the same request/response shape for `/v1` paths.
2. **Security & telemetry guards** – Wire the bearer-token guard through `security/SecurityProviders.kt`, and port the OTEL/metrics counters from `telemetry/GrafTelemetry.kt` to Quarkus request filters in `telemetry/TelemetryFilters.kt`. Ensure `GrafConfiguration.kt` continues to expose the Neo4j/MinIO/Argo settings and `GrafRouteTemplate` reproduces the existing logging/telemetry semantics.
3. **Build/runtime config** – Update `services/graf/build.gradle.kts`, `gradle.properties`, `settings.gradle.kts`, and `Dockerfile` to produce a Quarkus `quarkus-app` artifact; let the Knative image (`registry.ide-newton.ts.net/proompteng/graf:quarkus`) set `QUARKUS_HTTP_PORT`, `QUARKUS_HTTP_HOST`, `PORT`, and reuse the `graf-otel-config` + `graf-quarkus-config` config maps that define HTTP/CORS/OTEL settings.
4. **RBAC & deployment wiring** – Keep `argocd/applications/graf/knative-service.yaml` pointed at the new image while keeping the Neo4j/MinIO/OTEL/bearer-token secrets, and ensure `graf-workflows-clusterrolebinding.yaml` (or its ClusterRole) documents the existing verbs. Double-check the ServiceAccount mounts the token/CA paths Quarkus reads for Argo submission.

### Deliverables
- This plan document plus `docs/graf-quarkus-migration.md` summarizing the migration approach, RBAC expectations, and rollout steps.
- Updated `argocd/applications/graf` manifests: `knative-service.yaml`, `graf-quarkus-configmap.yaml`, and `kustomization.yaml` to deploy the Quarkus image with the required secrets/config.
- Gradle/Docker/quarkus runtime artifacts (`build.gradle.kts`, `Dockerfile`, Quarkus-specific configuration classes) that build the new Graf container and keep the existing bearer-token/Neo4j/MinIO wiring intact.
- RBAC notes confirming the `graf` service account still uses `argo-workflows-edit` (or expanded verbs) and that any new verbs needed by Quarkus are recorded in the manifest.

### Validation & Observability
1. Run `./gradlew :services:graf:check` (Quarkus validation + lint) and `./gradlew :services:graf:test` (graph/Codex unit suites).
2. Confirm `graf-quarkus-config`/`graf-otel-config` are mounted by the Knative service alongside the bearer-token, Neo4j, MinIO, and OTEL secrets before syncing.
3. After deployment, exercise `/`, `/healthz`, and `/v1/**` through the bearer tokens listed in the `graf-api` secret to ensure responses and OTEL counters still align with `GrafTelemetry` and `TelemetryFilters`.
4. Verify `logging`/`metrics` interceptors from `GrafRouteTemplate.kt` keep emitting the same counters to the OTEL endpoints in `graf-otel-configmap.yaml`.

### Risks & Contingencies
- Quarkus still depends on the mounted service account token/CA for Argo API calls; a missing mount breaks workflow submissions, so double-check the Knative pod spec and `graf` SA binding before rollout.
- RBAC drift may open cluster-scoped verbs; if any new permissions are required beyond `workflows`/`workflowtemplates`, document them in `graf-workflows-clusterrolebinding.yaml` and include rollback notes that revert to the narrow workflow-only verbs.
- Gradle/Docker changes must keep the same artifact repositories and env var names (Neo4j URI, MinIO endpoint, OTEL exporter) so downstream automation (CI, GitOps) doesn’t need further adjustments.

### Communication & Handoff
- Share this updated plan and the RBAC notes with the infra/security team so they know which manifests (ServiceAccount, ClusterRoleBinding, ConfigMap) will change before `argocd` syncs.
- Call out the required `graf-quarkus-config`, env vars, and RBAC coverage in the PR description so reviewers see how the new image continues to hit the existing OTEL/Argo stacks.
- Keep a single Codex progress comment anchored by `<!-- codex:progress -->` so reviewers track implementation status; mention the validation checklist and telemetry verification there.

### Ready Checklist
- [x] Dependencies clarified (feature flags, secrets, linked services)
- [x] Test and validation environments are accessible
- [ ] Required approvals/reviewers identified
- [x] Rollback or mitigation steps documented
