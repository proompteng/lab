# Graf Dependency Injection

Graf now boots [Koin](https://insert-koin.io/docs/reference/koin-ktor/ktor/) inside `Application.module()`. The container wires explicit modules for configuration, infrastructure clients, services, and a request scope that provides an audit context per call.

## Modules overview

- **Config module** (`ai.proompteng.graf.di.configModule`) reads each configuration object once (Neo4j, Temporal, Argo, MinIO) and exposes the shared `Json` instance.
- **Infrastructure module** (`ai.proompteng.graf.di.infrastructureModule`) builds Neo4j, MinIO, Kubernetes HTTP, and Temporal clients with `onClose` hooks so shutdown automatically releases the driver, HTTP client, and worker factory.
- **Service module** (`ai.proompteng.graf.di.serviceModule`) registers `GraphService`, Codex helpers, and the Temporal worker/activities using `createdAtStart = true` so the worker is registered and started when Koin launches.
- **Request scope module** (`ai.proompteng.graf.di.requestScopeModule`) binds `AuditContext` using `requestScope {}` so every call can inject `call.auditContext()` for logging, tracing, or instrumentation.

## Adding a new binding

1. Determine whether the dependency belongs to configs, external clients, or domain services.
2. Add a `single { }`, `factory { }`, or `scoped { }` definition to the appropriate module inside `services/graf/src/main/kotlin/ai/proompteng/graf/di/`.
3. If the dependency needs cleanup, chain `.onClose { }` to the definition so Koin can dispose it with the application.
4. Inject the component via `by inject<T>()` inside `Application.module()` or any other consumer (including routes or workers) once the module is part of the installed list.
5. Update `docs/graf-di.md` (and this list) if you add a new logical layer so future contributors understand where to extend wiring.

## Request-scoped data

`AuditContext` stores the request ID, authenticated principal, and `Authorization` header. Access it via `call.auditContext()` inside routes, services, or Koin-provided classes whenever you need per-call metadata.

## Verifying modules

`services/graf/src/test/kotlin/ai/proompteng/graf/di/ModulesTest.kt` uses `KoinTestExtension` plus `koin.checkModules {}` to ensure every definition can be resolved with safe overrides. Run `GRAF_API_BEARER_TOKENS=\"test\" ./gradlew :services:graf:test --tests ai.proompteng.graf.di.ModulesTest` to execute the check locally (the env var keeps `ApiBearerTokenConfig` from failing in CI).

For feature tests or helpers that depend on the container, reuse the same overrides (`standardTestOverrides`) so they rely on the same mocked infrastructure clients.

## References

- Ktor + Koin guide (request scope, plugin configuration): [https://insert-koin.io/docs/reference/koin-ktor/ktor/](https://insert-koin.io/docs/reference/koin-ktor/ktor/)
- Release notes (4.0.3) describing request-scope and SLF4J logger improvements: [https://insert-koin.io/blog/releases/koin-4.0.3/](https://insert-koin.io/blog/releases/koin-4.0.3/)
