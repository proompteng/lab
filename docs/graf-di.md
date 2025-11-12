# Graf CDI wiring

Graf now relies on Quarkus CDI producers instead of the earlier manual wiring. The new layout keeps configuration parsing, client construction, and service wiring in separate modules:

- `ConfigProducers.kt` reads each of the environment-backed configs (`Neo4jConfig`, `TemporalConfig`, `ArgoConfig`, and `MinioConfig`) once per JVM, plus the shared Kotlinx `Json` serializer used by Argo/MinIO helpers.
- `ClientProducers.kt` builds the Neo4j driver, Neo4j client, MinIO client, Kubernetes `HttpClient`, Temporal stubs, Temporal workflow client, and worker factory. Runtime resources are closed with `@PreDestroy`, while the `@ArgoServiceAccountToken` qualifier packages the service account token for other beans.
- `ServiceProducers.kt` wires up `GraphService`, `MinioArtifactFetcher`, `ArgoWorkflowClient`, `CodexResearchActivities`, `CodexResearchService`, and the `AutoResearchLauncher` implementation by injecting the already-produced configs/clients. Each producer is scoped as a singleton so downstream resources can rely on a single instance per application.

A `GrafRequestContext` request-scoped bean stores the active request ID, bearer principal, and OpenTelemetry trace/span IDs. The `GrafRequestContextFilter` runs per request, reads `X-Request-Id`/`Authorization`, and populates the context so any bean can `@Inject` the request metadata.

### Adding new beans
1. If you need a new config object, add it to `ConfigProducers` so it is built once and available to other producers.
2. For new clients (HTTP, database, SDKs), add a `@Singleton @Produces` method to `ClientProducers` and clean up in `@PreDestroy` if needed.
3. For services that depend on multiple clients/configs, add a producer function to `ServiceProducers` and mark it `@Singleton`. Prefer constructor injection over manual instantiation.
4. If you need access to the request-scoped metadata, inject `GrafRequestContext`. For per-request initialization, extend `GrafRequestContextFilter` or register another `ContainerRequestFilter` annotated with `@Priority` after the request context filter runs.

### Temporal worker lifecycle
`GrafConfiguration` now only controls the Temporal worker startup/shutdown. It injects the worker factory plus the already-registered activities (via CDI) and starts/tears down the factory at application startup/shutdown.
