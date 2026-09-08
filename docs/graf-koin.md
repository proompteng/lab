# Graf Koin wiring

Graf bootstraps a dedicated Koin container that owns configuration objects, long-lived infrastructure clients, service classes, and the per-request context scope. The layout keeps modules focused and lets us reason about cold-start performance explicitly.

- `grafConfigModule()` registers all environment-driven configs (`Neo4jConfig`, `TemporalConfig`, `ArgoConfig`, `MinioConfig`) plus the shared Kotlinx `Json` serializer under the `GrafQualifiers.Json` qualifier.
- `grafClientModule()` constructs the external clients (Neo4j driver/client, MinIO client, Kubernetes `HttpClient`, Temporal service stubs/client, worker factory) and registers shutdown hooks with `GrafLifecycleRegistry` so resources close cleanly when `GrafKoin.stop()` runs.
- `grafServiceModule()` wires Graf-domain services (`GraphService`, `MinioArtifactFetcher`, `ArgoWorkflowClient`, `CodexResearchActivities`, `CodexResearchService`, `AutoResearchService`) using constructor injection. Each binding is a `single`, so injecting the same type twice returns the same instance.
- `grafRequestScopeModule()` defines the scoped `GrafRequestContext`. The `GrafRequestContextFilter` creates a fresh Koin scope per request, populates request ID / bearer info / trace IDs, stores the scope on the request, and tears it down in the response filter.

### Cold-start optimization

`GrafApplication` now performs three explicit steps before handing control to Quarkus:

1. `GrafKoin.start()` loads all Koin modules so definitions are available immediately.
2. `GrafWarmup.prime()` fetches the heavy singletons (`GraphService`, `WorkflowClient`, `ArgoWorkflowClient`, `MinioClient`, `AutoResearchLauncher`) concurrently, then triggers best-effort warmups for `GraphService` (Neo4j ping) and `CodexResearchService` (Temporal `GetSystemInfo`). Doing this up front avoids work on the first REST request and shifts the cost into process startup.
3. `GrafTemporalBootstrap.start()` provisions the Temporal worker, registers activities, and records shutdown hooks for the worker factory, service stubs, and telemetry exporter.

If you add a new expensive singleton that should be ready before the first request, update `GrafWarmup` to touch it.

### Adding new bindings

1. **Config**: extend `grafConfigModule()` with a new `single` if the object reads from the environment once per JVM. Keep parsing side-effect free.
2. **Clients**: extend `grafClientModule()` and register a shutdown hook via `GrafLifecycleRegistry.register { ... }` for anything that implements `Closeable` or has an explicit shutdown API.
3. **Services**: extend `grafServiceModule()` and, if appropriate, `bind` the implementation to an interface so resources/tests can depend on abstractions.
4. **Request-scoped data**: prefer using `GrafRequestContextHolder.get()` inside request-handling code. If you need extra per-request state, add fields to `GrafRequestContext` and populate them inside the filter, or create another scope alongside `GrafScopes.Request`.

### Temporal worker lifecycle

`GrafTemporalBootstrap` replaces the earlier `GrafConfiguration` class. It uses the Koin container to obtain the worker factory, activities, and configs, starts the worker exactly once, and registers shutdown hooks so Temporal resources are closed before `GrafKoin.stop()` tears down the container.
