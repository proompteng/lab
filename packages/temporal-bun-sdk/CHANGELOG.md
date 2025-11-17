# Temporal Bun SDK Changelog

_This file is automatically updated by the Temporal Bun SDK release workflow._

## 1.0.0 (2025-11-17)

### Features
* Ship the Effect-powered workflow runtime with deterministic replay, sticky caches, and failure isolation so long-running workloads behave like the Node SDK.
* Deliver production worker orchestration including heartbeating activities, concurrency controls, and sticky queue awareness via the `temporal-bun-worker` CLI.
* Stabilize the Connect-powered Temporal client plus Bun CLI entry points so teams can bootstrap namespaces, workers, and workflow invocations without Node.
* Bundle native Bun builds that expose workflow/activity helpers, client factories, and release automation-ready build artifacts under `dist/`.

### Bug Fixes
* _None in this release._

### Documentation
* Add GA release guidance, support policy, and architecture references throughout the README and production-design documentation (#1818).

### Known Issues
* Workflow Updates APIs remain in flight; follow progress in issue #1814 before depending on update handlers in production.
* Inbound workflow signal + query handlers are still tracked in issue #1815, so GA adopters should not rely on deterministic processing of inbound signals/queries yet.
* Dedicated query-only workflow tasks are not yet implemented; see issue #1816 for the planned RespondQueryTaskCompleted support.
* Expanded workflow command coverage (cancellations, search attribute upserts, side effects, patches, local activities) is scoped under issue #1817 and will land post-GA.
