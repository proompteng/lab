# Effect services (Context.Tag + Layer)

This server codebase uses Effect’s **service pattern**:

- Define an interface for the capability.
- Create a `Context.Tag(...)` for it.
- Provide a **live implementation as a `Layer`** (preferred for “real” wiring).
- In tests, override the service with `Effect.provideService(Tag, fake)`.

## Why this pattern

- Removes module-level singletons and hidden global state.
- Makes dependencies explicit and easy to override in tests.
- Centralizes error mapping at the boundary (service ↔ handler).
- Keeps `handle*` functions composable by exposing an `Effect` entrypoint.

## Canonical shape (used in Jangar)

**1) Define the tag + service type**

- Example: `src/server/thread-state.ts` exports:
  - `ThreadStateService` (interface)
  - `ThreadState` (`Context.Tag(...)`)
- Example: `src/server/worktree-state.ts` exports:
  - `WorktreeStateService` (interface)
  - `WorktreeState` (`Context.Tag(...)`)

**2) Provide a live layer**

- Example: `src/server/thread-state.ts` exports:
  - `ThreadStateLive` (`Layer.scoped(...)`)
- Example: `src/server/worktree-state.ts` exports:
  - `WorktreeStateLive` (`Layer.scoped(...)`)

Notes:
- Prefer `Layer.sync` / `Layer.effect` for simple services.
- Prefer `Layer.scoped` when you need to acquire/release resources (connections, timers, file handles, etc.).
- If you need **lazy initialization** (only when the feature is used), do it inside the service implementation (e.g. keep a `let cached = null` inside the `Layer` factory), not as a top-level IIFE singleton.

**3) Expose an Effect entrypoint and a thin runtime wrapper**

- Example: `src/server/chat.ts` exports:
  - `handleChatCompletionEffect(request)` – returns an `Effect` that requires services
  - `handleChatCompletion(request)` – thin wrapper that runs the effect on a shared `ManagedRuntime`

Notes:
- **Do not** build “live” layers inside every request handler invocation if the service holds resources (e.g. Redis clients).
- Prefer a module-level `ManagedRuntime.make(Layer.mergeAll(...))` and call `runtime.runPromise(effect)` per request, so services are reused and scoped finalizers run when the runtime is disposed (e.g. during shutdown or tests).

**4) Test overrides**

- Example: `src/server/__tests__/chat-completions.test.ts` overrides:
  - `ThreadState` via `Effect.provideService(ThreadState, fakeThreadState)`
  - `WorktreeState` via `Effect.provideService(WorktreeState, fakeWorktreeState)`

This keeps tests isolated and avoids mutating module globals like `setFoo(...)` / `resetFoo(...)`.
