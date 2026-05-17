# Temporal Bun SDK Feature Matrix

_Last updated: May 14, 2026_

| Feature                            | Status                                             | Evidence                                                                                                           |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Pure Bun worker runtime            | Supported                                          | `src/worker/runtime.ts`, `verify:production`, package-boundary tests.                                              |
| Workflow command context           | Supported                                          | `src/workflow/context.ts`, `tests/workflow/*.test.ts`, protocol golden tests.                                      |
| Deterministic time/random wrappers | Supported                                          | `src/workflow/guards.ts`, runtime guard tests, query guard matrix.                                                 |
| Workflow queries                   | Supported with strict read-only guards             | `tests/integration/query-only.integration.test.ts`, `tests/workflow/query-guard-matrix.test.ts`.                   |
| Workflow signals                   | Supported                                          | `tests/integration/signal-query.integration.test.ts`, `tests/workflow/signals-queries.test.ts`.                    |
| Workflow updates                   | Supported                                          | `tests/integration/workflow-updates.test.ts`, `tests/worker.update-protocol.test.ts`.                              |
| Activities                         | Supported                                          | `tests/integration/activity-lifecycle.integration.test.ts`, `tests/activities/lifecycle.test.ts`.                  |
| Heartbeats and cancellation        | Supported                                          | Activity lifecycle integration tests.                                                                              |
| Sticky queues/cache                | Supported                                          | `src/worker/sticky-cache.ts`, worker runtime integration tests, load report.                                       |
| Replay ingestion                   | Supported                                          | `src/workflow/replay.ts`, replay fixtures, replay corpus verifier.                                                 |
| Payload codecs                     | Supported                                          | JSON tunnel, gzip, AES-GCM tests and payload codec integration.                                                    |
| TLS/mTLS                           | Supported                                          | TLS config tests and docs.                                                                                         |
| Temporal Cloud Ops                 | Supported when endpoint credentials are configured | Cloud Ops integration is optional without credentials.                                                             |
| Worker build IDs/versioning        | Supported with strict pinned policy in production  | Worker runtime configuration and build-id registration tests.                                                      |
| Nexus operation commands           | Experimental                                       | Unit coverage exists; replay corpus and integration coverage must expand before default-choice recommendation.     |
| Release load proof                 | Supported with CI release load evidence            | `scripts/run-worker-load.ts`; CI uploads `worker-load/report.json`, and `verify:production` validates it.          |
| Extended environment proof         | Operational hardening gate                         | Run target-environment replay and load windows for unusually high-throughput or new platform/runtime combinations. |

Status language:

- `Supported`: maintained and release-gated.
- `Supported with ...`: supported under documented constraints.
- `Experimental`: API exists but needs broader corpus/integration evidence before
  default-choice recommendation.
- `Operational hardening gate`: not required for the default Bun integration
  recommendation, but required when workload/platform risk exceeds the release
  smoke profile.
