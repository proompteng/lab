---
name: verify-bayn-system
description: Verify Bayn execution admission, uncertain-order recovery, final broker authorization, reconciliation caches and retained PAPER policy registration. Use when changing their production code, SQL, state writers or formal checks, and before claiming these boundaries remain verified.
---

# Verify Bayn system

Check the execution boundary, not a whole-system safety or profitability claim. Unknown broker outcomes must not
create new admission or refresh permission. Every broker invocation requires its own committed start and final
authorization; a replay cannot invoke the broker again. Retained approved PAPER material must remain admissible,
while altered, foreign and unapproved material stays rejected.

## Run

1. Read `services/bayn/formal/README.md` and `services/bayn/formal/tla/README.md`. Inspect changes to the coverage
   below since the recorded source commit, including moved functions and new writers of the same state.
   A passing old model does not establish that the mapping is current.
2. Use the repository toolchain: Bun 1.4.2, Java 21 and installed workspace dependencies. The runner downloads and
   checksum-verifies the existing pinned TLC release. Set `BAYN_TEST_POSTGRES_URL` to an owned, disposable PostgreSQL 18
   database. The integration fixture runs production migrations and changes its test data; never use an application database.
3. From the repository root, run:

   ```sh
   bun run --filter @proompteng/bayn verify:system
   ```

   Set `BAYN_SYSTEM_OUTPUT_DIR` to an empty directory to retain a successful run. Failures retain their directory
   and print its location. Missing database configuration, failed checks, skipped required tests, unmatched mutation
   sites and mutations that survive all fail the command.

4. Read every TLA+ result with `/statechart`. Use that skill's current instructions to explain the checked behavior
   and shortest violating paths. Keep Bayn's pinned runner as the CI pass/fail authority. Do not copy `/statechart`
   commands, paths or options into Bayn scripts.
5. When risk registration, Lean definitions or Lean correspondence changes, also run the existing Linux proof gate:

   ```sh
   bun run --filter @proompteng/bayn verify:formal
   ```

   It requires the pinned Lean toolchain and bubblewrap on Linux. Its native PostgreSQL/TigerBeetle companion checks
   have separate CI invocations. `verify:system` does not replace those checks or any required release gate.

## Coverage and synchronization

Production source mapping reviewed at `f3570ef23fcf6699f3832c55414ca92efdd501b9`.
This records the covered source, not deployment, external broker correctness or every Bayn path.

| Obligation                                                 | Production code                                                                                                                                        | Verification                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact retained/live/current PAPER approval                 | `services/bayn/src/execution/risk-policy.ts`, `services/bayn/src/system-assessment/policy.ts`                                                          | Independent material fixtures and registration cases in `formal/conformance/lean.test.ts`; the Linux Lean comparison includes the retained branch |
| Independently committed start and replay permission        | `services/bayn/src/execution/mutations/postgres/start.ts`, `services/bayn/src/execution/coordinator.ts`, `services/bayn/src/execution/writer-fence.ts` | ExecutionBoundary model and actual coordinator/store calls against the production migrated PostgreSQL schema                                      |
| Uncertainty blocks another admission                       | `services/bayn/src/execution/mutations/decisions.ts`, `services/bayn/src/execution/mutations/postgres/start.ts`                                        | Hidden acceptance, replay and not-found recovery followed by a different intent                                                                   |
| Final authorization through transmission                   | `services/bayn/src/execution/runtime-program.ts`                                                                                                       | Model transaction ownership, revoked authorization with zero broker invocations, and post-transmission failure classification                     |
| Reconciliation permission cannot be renewed by uncertainty | `services/bayn/src/execution/broker-state-cache.ts`, `services/bayn/src/db/reconciliation.ts`                                                          | Actual cache tests and PostgreSQL own-start/other-mutation version checks                                                                         |

The formal files are `services/bayn/formal/tla/ExecutionBoundary.{tla,cfg}` and
`services/bayn/formal/conformance/execution-boundary.test.ts`.
Native cases live in `services/bayn/src/system-assessment/postgres.integration.test.ts` and use a recording broker
service, not a real broker account. `services/bayn/formal/verify-system.ts` runs the cases and production controls;
`services/bayn/formal/production-faults.ts` applies mutations only inside isolated child imports.

## Bounds and assumptions

The execution model uses one account, two distinct intents and two workers. Broker acceptance/fill and visibility
are separate from local admission and knowledge. Model actions preserve the independent start commit and the final
writer transaction held through transmission. A requested revocation is not a committed authority update while
the relevant locks remain held. Previously transmitted orders can still fill after a kill.

Containment at new admission and validity of an already admitted transmission are separate obligations.
SQL cache invalidation uses another event's `occurred_at >= reconciledAt`, not arbitrary database commit order.
A late observation predating a newer broker cut is not automatically proof of unsafe exposure. Match the model's
before/equal/after cases to that boundary rather than assuming every later commit invalidates a cache.

The new model covers submit and full fill, without partial quantities, cancellation or liveness. The model and finite
conformance do not prove PostgreSQL, Restate, TigerBeetle, Effect, the broker or complete/authentic
source capture. Recorded broker-service invocations do not prove exactly-once network delivery. Arithmetic limits,
arbitrary populations, native sibling fill/cancel behavior, wall-clock latency and profitable returns remain separate.

## Fault sensitivity and maintenance

The command first runs the unchanged checks, then deliberately breaks real production modules in child processes.
Each control must show its mutation marker exactly once and fail its named behavioral assertion. Parser failures,
fixture/setup errors, timeouts and an unrelated failed test are not detection. The source file hash must remain
unchanged, and the unchanged boundary cases must pass again afterward.

When adding or changing a guard, add a corresponding real-code control and follow this skill on that scratch
mutation before calling the check complete. Keep a reachable successful invocation and retained-policy acceptance;
a system that never acts can otherwise pass safety vacuously.

For a failing trace, replay its actions against the actual implementation. If an action cannot happen, correct the
model from the code. If the actions can happen and violate the intended contract, report the code defect; do not
weaken the property to obtain green output. Change a promise only with explicit source-backed evidence of intent.

Use `/maintain-formal-verification-skill` after merges or edits that skipped this check. Classify each result as
in sync, updated, bug or blocked. Move the recorded source commit only after reviewing every relevant code change,
confirming the action/transaction mapping, passing applicable checks and repeating fault sensitivity. Do not advance
it for a blocked Lean/database check or claim that a fast protocol pass covers unrun proof gates.
