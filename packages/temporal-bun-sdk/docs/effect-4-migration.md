# Upgrade to Effect 4

The SDK's Effect 4 release uses **Effect 4.0.0**. Version **0.11.5 uses
Effect 3.22.1** and remains available for existing workers. The public Effect,
Schema, Context and Layer types change with this release. Promise-facing client
calls keep their existing shapes.

## Existing workflow histories

**Do not replace an Effect 3 worker with an Effect 4 worker on an existing
execution's routing path. This is not a drop-in replay-compatible upgrade.**

Effect 3 recorded internal fiber-creation timestamps in the same deterministic
stream as workflow clock reads. Effect 4 has a different fiber graph, including
different concurrent-operation coordinator behavior. Old histories do not label
those internal samples. Skipping them could change a later user clock value or
hide nondeterminism, so this SDK keeps strict replay checks and rejects an
incompatible history.

The regression fixture `tests/fixtures/effect-3.22.1-activation-baseline.json`
was captured from the 0.11.5 implementation before migration. Its parallel
workflow is deliberately rejected with unconsumed clock samples. Separate
Effect 4 tests prove command order and signal batching across activation replay,
including suspended updates, timers, Nexus operations and worker restarts.

1. Keep existing executions on their original immutable Effect 3 worker build.
2. Replay representative histories before changing any worker routing. A passed
   history-ingestion test alone does not prove that a workflow can execute it.
3. Send new executions to a distinct Effect 4 build using `PINNED` behavior.
   Inspect execution overrides too: an `AUTO_UPGRADE` override can supersede a
   worker's pinned default.
4. For unversioned executions, use a separate new-start task queue or first
   complete a separately verified, Effect 3-compatible versioning migration.
   Changing a deployment's Current version is not sufficient isolation.
5. Do not assume continue-as-new or a canary pod is isolated. Verify their routing
   explicitly. The repository's Bumba/Jangar startup alignment can promote Current.

The repository intentionally retains Bumba and Jangar's production workflow
runtime on the verified 0.11.5 npm tarball. The SDK workspace and example use
Effect 4. The service package pins, TypeScript resolution and image smoke checks
must change together when a separately validated application migration is ready.

## Source migration

Install the same Effect 4 version used by the SDK in every package that passes
workflow Effects, schemas, services, layers, logger Effects or metric Effects
across its API. Do not pass Effect 3 values to an Effect 4 worker. Applications
that only use the Promise client may keep a separate Effect version behind that
Promise boundary.

Common changes include:

- `Effect.catchAll` becomes `Effect.catch`; `catchAllCause` becomes `catchCause`
- `Effect.async` becomes `Effect.callback`; `fork` becomes `forkChild` and
  `forkDaemon` becomes `forkDetach`
- `Context.Tag` becomes `Context.Service`; `Layer.scoped` becomes `Layer.effect`
- `Schema.decodeUnknown` becomes `Schema.decodeUnknownEffect`
- Multi-value `Schema.Literal(a, b)` becomes `Schema.Literals([a, b])` and
  `Schema.Union(a, b)` becomes `Schema.Union([a, b])`
- Use `Schema.Codec<T>` for SDK schema parameters that require a service-free
  encoded/decoded contract
- Effect 4's `Schema.Date` validates Date instances. Use `Schema.DateFromString`
  when the workflow's persisted input is an ISO string; do not change wire formats
  accidentally while renaming APIs

See the [official migration guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0/MIGRATION.md)
and [schema migration guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0/migration/schema.md).

## Workflow runtime contract

The SDK owns workflow scheduling. Do not replace `Scheduler.Scheduler`, set
`Scheduler.PreventSchedulerYield`, or start an independent Effect runtime inside
a workflow. Use structured workflow Effects and the SDK's durable activity,
timer, signal and Nexus APIs. Such scheduler overrides can bypass activation
ordering and disposal; they are not a supported workflow feature.

Durable suspension does not invoke failure handlers or finalizers. Genuine
interruption does. Late callbacks cannot continue a discarded activation, and
discarded parent/detached fibers are collectible without modifying global roots.
Native Effect timers remain prohibited in strict workflows. Effect 4's
`Effect.never` does not create a native timer and can remain suspended.
