# Bayn TLA+ checks

Run from the repository root:

```sh
bun run --filter @proompteng/bayn verify:tla
```

The command requires Bun, Java 21 and curl. It downloads the official
[TLC 1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4), verifies the SHA-256 in
`toolchain.json`, checks every reachable state of all three configurations, checks temporal properties, injects six
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

| Model                | Interleavings and checks                                                                                                                                                                                                                                                                                                                                             | Production conformance                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Controller.tla`     | Duplicate or stale delivery, interrupted work, epoch/source replacement, deactivation, and completion racing replacement. No stale completion can advance durable state.                                                                                                                                                                                             | `decideExecutionControllerTick` and `completeExecutionControllerTick` in `src/execution/controller.ts`, including next sequence, preserved owner and completion-derived next due time.                           |
| `EntryRecovery.tla`  | Inputs arriving or losing readiness between polls, initial/later missing inputs, consumed windows, source unavailability, binding, expiry and terminal closure. Short retries stay within the original admission; a modeled decision requires a ready input and precedes expiry.                                                                                     | `decisionReadinessContinuationDelayMs` in `src/observe-composition/recovery-driver.ts`, with the production cycle, window and binding shapes.                                                                    |
| `MutationLedger.tla` | Authority/kill changes, submission or cancellation, uncertain outcomes and repeated recovery, worker restart, separate preflight reads and posting by two workers, partial posting in either order, metadata corruption and duplicate records. No second dispatch of the same mutation, unauthorized start, duplicate posting or incomplete accounting verification. | `decideMutationAuthority`, `decideMutationStartReplay` and `allowsOutcomeEvent` in `src/execution/mutations/decisions.ts`; `preflightTransfers` and `verifyExactTransfers` in `src/ledger-plan/verification.ts`. |

`../conformance/tla.test.ts` decodes every checked state's scalar view and invokes those production functions. Each view
retains every model variable, so it does not merge distinct states. Reachability assertions require admitted and
rejected paths, stale in-flight work, successful and expired cycles, uncertain submissions, killed bounded closes,
both partial-posting orders, verified complete posting, corrupt metadata and duplicates. Malformed, missing and empty
state dumps fail. No runtime implementation is generated from these models.

The negative controls remove completion ownership, short continuation, clock fairness, single-start, authority and
deterministic-ID deduplication guards in isolated model copies. Each must produce its expected invariant or temporal violation.
A parser error, checker crash or successful check does not count as detecting the defect. The reviewed model files
remain unchanged.

After the unchanged production code passes conformance, five child processes independently remove the controller
completion guard, delay a short entry retry, bypass mutation start replay, remove maximum-authority enforcement and
omit transfer amount comparison in the actual production modules.
A Bun preload loader changes only the child's imported module; source files on disk remain unchanged. Each control
must confirm its mutation loaded and fail the named conformance assertion. A surviving mutation, missing guard,
parser error, timeout or unrelated failure fails verification. Retained results include each assertion failure and
the original production module hash. These controls check the model-to-code comparison as well as the model's guards.

## Bounds, assumptions and limits

TLC exhaustively checks these finite instances. The controller explores two epochs, two source identities and
sequences zero through two. That sequence bound ends the modeled prefix and is not a production counter limit.
Entry recovery explores four one-second clock steps with the existing one-second retry and a three-second ordinary
poll. These are boundary-test inputs, not new runtime deadlines. Mutation/ledger checks explore one immutable
mutation, two restarting workers and two deterministic transfer records. Authority booleans represent the existing
maximum, effective authority, kill state, generation maximum and account binding predicates. The model does not
authenticate an account, grant, request, fill or transfer record.

There are no state constraints, symmetry reductions or disabled deadlock checks. TLC runs with one worker and a
fixed fingerprint polynomial. The checker reports the residual fingerprint-collision estimate in its retained log.
Finite checking does not prove arbitrary populations or unbounded executions.

Entry liveness assumes the clock advances fairly and an enabled expiry action eventually executes. Under those
explicit assumptions time reaches expiry and unused admission eventually closes. It does not assume that prices,
quotes, features or inference arrive. Mutation/ledger liveness assumes weak fairness of preflight and verification
and strong fairness of posting. Posting enabled infinitely often must eventually run, even when worker switches or
restarts interrupt individual attempts. A captured fill eventually reaches exact verification or an explicit integrity
block. There is no assumption that an unavailable broker eventually answers, and no unconditional recovery promise.

The admitted input and fill actions abstract validated production evidence. The controller model abstracts a durable
replacement as one transition and does not model Restate or PostgreSQL internals. ID-based deduplication and atomic
mutation admission remain explicit implementation assumptions. The real TigerBeetle integration test holds two clients
after both preflight reads, then releases both to post the same transfer IDs. It verifies exact native records and balances after concurrent posting and another replay. Existing PostgreSQL
tests retain mutation admission and concurrency checks. These model checks and finite conformance comparisons complement the Lean proofs and integration tests. They do not establish
empirical 99.9% reliability, zero observed safety violations, trading profitability, statistical edge or capital authority.
