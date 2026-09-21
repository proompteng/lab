# Workflow suspension and replay

Activities, Nexus operations, durable timers, and signal waits suspend an Effect
fiber until Temporal supplies a result. Waiting does not enter `Effect.catchAll`
or `Effect.catchAllCause`, and it does not run `Effect.ensuring` finalizers. A real
activity failure still enters the recoverable error channel. Normal Effect
completion and interruption retain their finalizer behavior.

The worker reconstructs workflow execution from history for each task. It groups
results and signals at `WorkflowTaskStarted` boundaries and resumes the workflow
after each group. Failed and timed out workflow tasks do not create committed
replay boundaries. Jobs from those attempts remain available at the next task.

This ordering matters for parallel workflows. For `A.then(C)` running alongside
`B`, the first task schedules `A` and `B`. A later completion of `A` can then
schedule `C`. Replay preserves that order even when all activity results are
already present in history. A signal delivered later also cannot change an
earlier `signals.drain` batch.

Update handlers use the same activation scheduler. A handler can await an
activity or timer across workflow tasks, and a successful main workflow waits
for pending update handlers before completing. Legacy queries fetch history to
reconstruct workflow state before evaluating their resolver.
Query resolvers cannot consume signals with `waitFor`, `on`, or `drain`, even
when a signal is buffered. These calls return a read-only query violation
instead of suspending the query. Signal consumption during workflow replay
still reconstructs the state that queries read.

## Supported waits

Use the workflow context's activity, Nexus, timer, and signal APIs for durable
waiting. Put network calls and other external I/O in activities. Async local
activities remain bounded by the workflow task budget described in the README.

Raw `Effect.sleep`, `Effect.never`, native timers, and arbitrary external async
operations are not durable waits. Strict workflow guards reject the native
timer and I/O APIs they invoke. Turning guards off or using warn mode does not
make those operations replayable. Discarding a workflow task does not cancel
external resources that such code already created.

## Effect runtime ownership

Each workflow task owns a controlled scheduler and its workflow and update
fibers. Once replay reaches a durable wait, the worker discards those fibers
without interrupting them. Interrupting at this point would run workflow
finalizers before the workflow had finished.

Effect 3 keeps unfinished root fibers in a strong global set. The SDK removes
only its owned fibers from that set so discarded tasks can be collected. This
uses Effect's internal `effect/FiberScope/Global` registration contract through
`effect/GlobalValue`. The adapter checks the registry shape and fails explicitly
if the contract is unavailable. It never clears the whole registry.

The SDK pins Effect to `3.22.1` because this ownership contract is internal.
An Effect upgrade must pass `tests/workflow/activation-runtime.test.ts` as well
as the executor and integration suites. The lifecycle tests exercise real
interruption, late delivery after disposal, garbage collection of suspended
parent and daemon fibers, and preservation of unrelated Effect roots.

## Upgrade validation

Replay representative running workflows before deploying this runtime change.
Pay particular attention to workflows whose cause handlers or finalizers
previously emitted commands when an activity or signal was merely pending.
Those commands reflected the suspension defect and can differ from the corrected
execution. Closed executions retain their recorded outcome.

The regression tests are executable workflow tests. The integration suite runs
parallel activity chains, caught suspension, and signal batches against Temporal.
It also shuts down a worker waiting for a signal and creates a fresh worker on
the same task queue before resuming the workflow. This restart test recreates the
worker runtime in the test process; it does not simulate killing the process.
