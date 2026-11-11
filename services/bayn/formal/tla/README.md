# Bayn TLA+ checks

Run from the repository root:

```sh
bun run --filter @proompteng/bayn verify:tla
```

The command requires Bun, Java 21 and curl. It downloads the official
[TLC 1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4), verifies the SHA-256 in
`toolchain.json`, checks every reachable state of all five configurations, checks temporal properties, injects nine
deliberate defects, and compares the checked state dumps with production TypeScript. Any download, checksum,
checker, fault-detection, parsing or conformance failure fails the command. Java and TLC are offline verification
dependencies and do not enter the trading image or decision path.

The reusable `bayn-formal.yml` workflow requires this command alongside the existing Lean and PostgreSQL checks.
Its aggregate result blocks the Bayn release gate on PRs and exact-main-revision image publication. CI retains model
inputs, state dumps, checker logs and negative-control counterexamples as an artifact named for the checked commit.
Locally, successful temporary results are removed; failures print their retained directory. Set
`BAYN_TLA_OUTPUT_DIR` to an empty directory to retain successful results too. Ordinary `bun test` skips the conformance
suite without checked dumps; it does not replace `verify:tla`.

## Models and production bindings

| Model                       | Interleavings and checks                                                                                                                                                                                                                                                                                                                                             | Production conformance                                                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Controller.tla`            | Duplicate or stale delivery, interrupted work, epoch/source replacement, deactivation, and completion racing replacement. No stale completion can advance durable state.                                                                                                                                                                                             | `decideExecutionControllerTick` and `completeExecutionControllerTick` in `src/execution/controller.ts`, including next sequence, preserved owner and completion-derived next due time.                                                                 |
| `RecoveryScheduler.tla`     | Failed bounded deliveries, delayed retry, stable dependency repair and deactivation, including recurring failures after the recovery counter saturates. Active failed owners retain a scheduled successor; fair delivery continues attempts and eventually observes stable repair.                                                                                   | `nextExecutionControllerRecoveryWindow` in `src/execution/controller.ts`, over every validated counter value including saturation. Restate handler tests separately verify successor scheduling, original issuance time and distinct retry identities. |
| `EntryRecovery.tla`         | Inputs arriving or losing readiness between polls, initial/later missing inputs, consumed windows, source unavailability, binding, expiry and terminal closure. Short retries stay within the original admission; a modeled decision requires a ready input and precedes expiry.                                                                                     | `decisionReadinessContinuationDelayMs` in `src/observe-composition/recovery-driver.ts`, with the production cycle, window and binding shapes.                                                                                                          |
| `MutationLedger.tla`        | Authority/kill changes, submission or cancellation, uncertain outcomes and repeated recovery, worker restart, separate preflight reads and posting by two workers, partial posting in either order, metadata corruption and duplicate records. No second dispatch of the same mutation, unauthorized start, duplicate posting or incomplete accounting verification. | `decideMutationAuthority`, `decideMutationStartReplay` and `allowsOutcomeEvent` in `src/execution/mutations/decisions.ts`; `preflightTransfers` and `verifyExactTransfers` in `src/ledger-plan/verification.ts`.                                       |
| `CancellationAdmission.tla` | Authority, immutable identity and clock changes between an isolated parent lookup and durable cancel admission. Only a current eligible snapshot admits one start; rejected and replayed requests do not add a start. Authority and time may change after admission.                                                                                                 | `expiredEntryCancellationAdmissionIsCurrent` in `src/execution/mutations/decisions.ts`, using the actual captured token and locked database facts.                                                                                                     |

`../conformance/tla.test.ts` decodes every checked state's scalar view and invokes those production functions. Each view
retains every model variable, so it does not merge distinct states. Reachability assertions require admitted and
rejected paths, stale in-flight work, successful and expired cycles, uncertain submissions, killed bounded closes,
both partial-posting orders, verified complete posting, corrupt metadata and duplicates. Malformed, missing and empty
state dumps fail. No runtime implementation is generated from these models.

The negative controls remove completion ownership, short continuation, clock fairness, single-start, authority,
deterministic-ID deduplication, continued recovery scheduling, recovery-delivery fairness and current cancellation
admission checks in isolated model copies.
Each must produce its expected invariant or temporal violation.
A parser error, checker crash or successful check does not count as detecting the defect. The reviewed model files
remain unchanged.

After the unchanged production code passes conformance, eight child processes independently remove the controller
completion guard, delay a short entry retry, bypass mutation start replay, remove maximum-authority enforcement and
omit transfer amount comparison, or truncate the recovery counter below its declared saturation point in the actual
production modules, or remove cancellation freshness or authority-version equality.
A Bun preload loader changes only the child's imported module; source files on disk remain unchanged. Each control
must confirm its mutation loaded and fail the named conformance assertion. A surviving mutation, missing guard,
parser error, timeout or unrelated failure fails verification. Retained results include each assertion failure and
the original production module hash. These controls check the model-to-code comparison as well as the model's guards.

## Bounds, assumptions and limits

TLC exhaustively checks these finite instances. The controller explores two epochs, two source identities and
sequences zero through two. That sequence bound ends the modeled prefix and is not a production counter limit.
Recovery scheduling explores all eight validated counter values, zero through seven, and two alternating delivery
parities so reaching the saturated counter cannot hide a stopped scheduler. One delivery abstracts its bounded
attempts; one clock step represents the existing thirty-second interval between recovery windows. This model
does not add a trading deadline or grant mutation authority.
Entry recovery explores four one-second clock steps with the existing one-second retry and a three-second ordinary
poll. These are boundary-test inputs, not new runtime deadlines. Mutation/ledger checks explore one immutable
mutation, two restarting workers and two deterministic transfer records. Authority booleans represent the existing
maximum, effective authority, kill state, generation maximum and account binding predicates. The model does not
authenticate an account, grant, request, fill or transfer record.

Cancellation admission explores nine authority cases, eight identity cases and four clock cases, including every
combination. The cases include clear PAPER authority, the existing system recovery restriction, operator holds,
generation and version changes, each bound identity field, BUY versus SELL, missing facts, future observations,
fresh evidence, exact expiry and expired evidence. The model captures eligibility when a start is committed; it
deliberately includes later authority/time changes without pretending that committed external I/O can be revoked.
The PostgreSQL implementation reads these facts after acquiring its existing writer, authority and intent locks,
uses `execution_account_commit_now(intent.account_id)` for freshness, and commits `CANCEL_STARTED` before broker I/O.
That existing volatile function uses current database wall time for live accounts and the bound source clock plus
measured elapsed work for isolated replay accounts, excluding paused source reads. The selector comes from the
locked durable intent, not caller-supplied time.
Database integration tests exercise those implementation boundaries. The model does not prove PostgreSQL locking, broker atomicity or
that a zero-fill observation prevents a fill racing a later cancellation. Subsequent reconciliation remains required.

There are no state constraints, symmetry reductions or disabled deadlock checks. TLC runs with one worker and a
fixed fingerprint polynomial. The checker reports the residual fingerprint-collision estimate in its retained log.
Finite checking does not prove arbitrary populations or unbounded executions.

Entry liveness assumes the clock advances fairly and an enabled expiry action eventually executes. Under those
explicit assumptions time reaches expiry and unused admission eventually closes. It does not assume that prices,
quotes, features or inference arrive. Mutation/ledger liveness assumes weak fairness of preflight and verification
and strong fairness of posting. Posting enabled infinitely often must eventually run, even when worker switches or
restarts interrupt individual attempts. A captured fill eventually reaches exact verification or an explicit integrity
block. There is no assumption that an unavailable broker eventually answers, and no unconditional recovery promise.

Recovery scheduling requires weak fairness of the recovery clock and delivery. Under a persistent outage it keeps
attempting while the owner remains active. Its eventual-success property is conditional on dependency repair that
then remains stable; deactivation ends that owner's obligation. Repair represents all prerequisites required for a
successful execution advance, including persistence, rather than merely a healthy transport. The model does not
prove Restate's timer durability, unique invocation IDs, the bounded attempts inside one delivery or the physical
thirty-second wall-clock delay. Handler regressions check successor payloads, bounded attempts, replay and original
issuance time; disposable Restate integration exercises native delivery. These checks do not formally verify the
Restate implementation. Source catch-up probes retain their separate bounded terminal behavior.

The admitted input and fill actions abstract validated production evidence. The controller model abstracts a durable
replacement as one transition and does not model Restate or PostgreSQL internals. ID-based deduplication and atomic
mutation admission remain explicit implementation assumptions. The real TigerBeetle integration test holds two clients
after both preflight reads, then releases both to post the same transfer IDs. It verifies exact native records and balances after concurrent posting and another replay. Existing PostgreSQL
tests retain mutation admission and concurrency checks. These model checks and finite conformance comparisons complement the Lean proofs and integration tests. They do not establish
empirical 99.9% reliability, zero observed safety violations, trading profitability, statistical edge or capital authority.
