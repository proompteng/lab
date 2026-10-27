# Bayn formal model

This directory contains the offline Lean model and executable used to check Bayn's production decisions. It is excluded
from the trading image. `lean-toolchain` pins Lean 4.35.0; `lake-manifest.json` pins Mathlib and its dependencies.

From this directory, run:

```sh
lake -q build
bash check.sh
```

From the repository root, run the production conformance tests with the built executable:

```sh
BAYN_FORMAL_EXECUTABLE="$PWD/services/bayn/formal/.lake/build/bin/bayn-model" \
  bun test services/bayn/src/system-assessment/formal-conformance.test.ts
```

The formal CI workflow runs both steps on Linux with `bubblewrap`. `check.sh` exports the built default targets in
a sandbox and passes the retained export to pinned `lake check --from-export ... --paranoid`. This separates the
export from Lake's pipe transport, which stalled locally while the child was blocked writing stdout. Build/export
and checker sandboxes retain read-only inputs, a writable build cache and no network. The exported environment is rechecked with the
official kernel, its hardened allocator variant, Lean4Lean, Nanoda, con-leche and con-ron. All must accept. Con-leche
has a machine-checked consistency proof; con-ron verifies a Rust implementation against its checking algorithm,
providing a different compiler and runtime. Con-ron's proof still trusts the Aeneas translation and unverified driver.
The complete suite also provides other checking implementations; these are offline build checks and add no trading
runtime latency. See [Lean's verification explanation](https://leodemoura.github.io/blog/2026-10-15-lean-now-ships-with-verified-kernels/)
and [con-ron's verification boundary](https://arena.lean-lang.org/checker/con-ron/).

The checkers verify proof terms against their definitions and permitted axioms. They do not observe broker executions
or validate a market model. Arena test results compare particular checker versions and workloads; they do not prove
soundness or replace checks of Bayn's own proof export with the pinned toolchain.

## Repeated momentum and native-control commitments

`Momentum.lean` models the exact numerator and denominator from
`deriveIntradayMomentumSignalMetrics`, the eligible set and winner used by
`strategy/repeated-momentum/signals.ts`, the rounded target and payoff admission in
`strategy/repeated-momentum/exit-plan.ts`, and the five native-control commitments in
`system-assessment/policy.ts`.

- `momentum_excess_is_unrounded` proves the exact cross-product identity. Eligibility requires positive absolute
  return, positive excess return, positive reference prices and an admissible quote. It never subtracts rounded
  basis-point scores to choose a candidate.
- `best_momentum_is_an_eligible_source` and `best_momentum_dominates_every_eligible_source` prove membership and
  maximum relative return. The latter uses positive denominators to prove transitivity of exact ratio comparison.
  `equal_momentum_scores_use_symbol_order` specifies tie comparison. The executable model selects recursively;
  conformance checks the production sorted result, including reversed input order and tied prices.
- `unfunded_momentum_never_reselects` retains abstention when the winner cannot be funded. The full native target
  producer and decoder are exercised with insufficient allocation, rather than inferring funding from a signal.
- `momentum_target_covers_frozen_profit_floor` and `momentum_target_exceeds_positive_acquisition` establish the
  exact ceiling of acquisition cost times 1.01. Conformance calls `momentumRequiredTargetNet` and decodes the actual
  `MomentumFundedExitPlanSchema` at values below, at and above the floor, including large integer amounts.
- `funded_momentum_retains_loss_and_possible_profit` preserves a loss outcome. The general zero-win-probability
  theorem and the nonzero-probability counterexample show that admitting a funded target does not establish positive
  expected profit. The executable check also evaluates the actual native plan through `binaryTradeEdge`.
- `admitted_native_control_preserves_all_commitments` preserves behavior, parameters, protocol, prompts and native
  execution identity. Both ablation and momentum are checked against all 32 combinations of changed commitments
  through the complete production registration validator. Exact unchanged identities are reachable.

The model consumes common-reference prices after native source reproduction, with quote admissibility already
computed. Source availability, evidence identities, PostgreSQL visibility, executable price increments, fees, routing
and recovery retain their separate production checks and proof/test mappings; the selection theorem does not assert
that arbitrary input rows are authentic. Hash equality assumes collision resistance and correctly identified source
material. None of these results supplies a market probability or establishes prospective economic qualification.

The PostgreSQL/TigerBeetle suite also runs a compiled Node replay command through a complete synthetic momentum
episode. It checks executable identity, entry and exit fills, a flat close, exact reconciliation, no provider calls,
and a positive execution profit made negative by the declared data cost. This exercises the command and accounting
boundaries; it does not replace the complete twenty-session matched-control stress assessment.

## Frozen deployed control

`Qualification.lean` models all six frozen commitments: strategy, parameters, protocol, execution model, prompts,
and continuation/exits. `deployed_control_admission_preserves_every_identity` requires every identity to match;
changing any component rejects admission. Conformance exercises all 64 changed/unchanged combinations through
`validateSystemRegistration`, including the one admitted unchanged registration.

`Economics.lean` models the original six-decimal share quantity as exactly 1,000 current quantity atoms per unit.
`frozen_quantity_roundtrip`, `frozen_quantity_is_exact`, and `frozen_notional_value_is_preserved` prove exact conversion
and preservation of half-up notional rounding. The executable comparison calls production `frozenQuantityAtoms` and
`notionalMicros`, including zero, rounding boundaries and values above JavaScript's exact integer range.

The frozen engine, full original protocol, observed release times, fills, accounting and complete twenty-session
synthetic replay retain their required integration checks in the parent implementation. These arithmetic and identity
proofs do not authenticate an arbitrary report, supply market probabilities or establish prospective qualification.

## Model and implementation mapping

All theorem names below are in namespace `Bayn`. The conformance tests invoke production functions rather than a second
TypeScript implementation of the model.

| Model                                             | Production boundary                                                                                                                                 | Proofs and behavioral checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Economics.lean`                                  | `src/operating-costs.ts` and `src/system-assessment/economics.ts`                                                                                   | `profit_conservation`, `qualification_conservative`, `invoice_replaces_tariff`, `account_paid_operating_cost_is_deducted_once`, `binary_edge_break_even`; executable comparison of signed economics and probability-weighted expectancy.                                                                                                                                                                                                                                                                                                            |
| `Reliability.lean`                                | `src/system-assessment/reliability.ts`                                                                                                              | `reliability_error_budget`, `no_empty_perfect_reliability`, `small_populations_allow_no_failures`, `late_completion_is_failure`; executable comparison of the exact integer fraction. Schedule construction and source completeness are separate obligations.                                                                                                                                                                                                                                                                                       |
| `Bootstrap.lean`                                  | `src/jev/acceptance.ts`                                                                                                                             | `sampled_indices_in_range`, `frozen_sample_has_twenty_sessions`, `paired_samples_use_shared_indices`; executable comparison of the frozen seed, 10,000 circular-block samples, percentile bounds and attempt-adjusted tails.                                                                                                                                                                                                                                                                                                                        |
| `Qualification.lean`                              | `src/system-assessment/assessment.ts`                                                                                                               | `missing_evidence_cannot_qualify`, `safety_has_no_error_budget`, `losing_control_cannot_replace_absolute_profit`, `qualification_is_reachable`; complete synthetic success and rejected evidence, safety and reliability cases.                                                                                                                                                                                                                                                                                                                     |
| `Execution.lean` numeric and controller functions | `src/strategy/execution-model/fixed-point.ts`, `src/broker/alpaca/cash-reporting.ts`, `src/execution/order-terms.ts`, `src/execution/controller.ts` | Quantity rounding and cash conservation; stale epoch and foreign worker rejection; executable comparison of actual sizing, signed cash rounding, order terms and controller tick decisions.                                                                                                                                                                                                                                                                                                                                                         |
| `Execution.lean` timing                           | `src/system-assessment/realism.ts`                                                                                                                  | `supported_routing_follows_durable_decision`, `waiting_in_guard_cannot_hide_stale_quote`, `expired_admission_cannot_route`, `execution_timing_has_reachable_success`; executable comparison of persistence, guard, dispatch, quote, admission and fill boundaries.                                                                                                                                                                                                                                                                                  |
| `Mutations.lean`                                  | `src/execution/mutations/decisions.ts`                                                                                                              | Every mutation transition is compared against `allowsOutcomeEvent`. `uncertain_submission_accepts_only_recovery` and `uncertain_cancellation_accepts_only_recovery` constrain uncertainty. `outcome_replay_preserves_all_evidence` and `outcome_replay_cannot_change_dispatch` correspond to `sameMutationOutcome`, including omitted routing and a null dispatch time.                                                                                                                                                                             |
| `DecisionWork.lean`                               | `src/jev/observation-query.ts`, `src/system-assessment/schedule.ts`, `src/system-assessment/decision-work.ts`                                       | `signal_window_precedes_availability`, `first_signal_uses_completed_session_data`, `scheduled_windows_are_exact`, and `different_windows_cannot_share_a_due_time` cover the native schedule. `expired_hold_cannot_count`, `hold_is_visible_before_expiry`, and `hold_completion_is_reachable` cover hold completion timing. Executable conformance compares actual schedules, source windows, and hold timing. PostgreSQL tests cover committed visibility, account/controller identity, retained hold reproduction, and immutable first witnesses. |

The qualification example is deliberately synthetic. It establishes that the predicate is satisfiable; it is not an
assessment of Bayn's prospective trading performance.

`DecisionPersistence.lean` maps to `src/system-assessment/decision-admissions.ts`, the admission trigger in migration
159, and independent mutation admission in `src/execution/mutations/postgres/start.ts`. An immutable PostgreSQL
receipt attests that an owned decision source was committed before the admitted mutation. Once that independently
committed mutation has a routing outcome, its original producer routing time bounds decision commitment. The model
requires valid receipt identity, independent admission and ordered producer timestamps. A later database observation
does not reverse that causal ordering. Without a routing outcome or committed-source receipt, no bound is derived.
A persistence observation after routing alone leaves realism incomplete; one before decision creation is contradictory.

The executable comparison covers 384 receipt, transaction, routing and clock combinations using a reproduced native
decision document, plus the production realism classifier. Actual PostgreSQL tests compare admission eligibility
with the model for committed sources, uncommitted sources before and after savepoint release, and foreign ownership.
They also exercise rollback, receipt immutability and ambient-transaction rejection. Native exit tests separately
cover initial close and replanned close documents. These checks do not prove PostgreSQL or the broker adapter itself.
The causal conclusion assumes PostgreSQL visibility and that the coordinator routes only after independent admission
returns. The assessment exposes these assumptions and retains original producer routing timestamps as upper bounds,
rather than claiming an exact physical commit time.

`Qualification.lean` also maps `deployedControlPreserved` to the frozen-control admission rule in
`src/system-assessment/policy.ts`. `deployed_control_admission_preserves_every_identity` proves preservation of
strategy, parameter and protocol identities, `changed_deployed_parameters_are_rejected` rejects parameter drift,
and `original_deployed_control_is_reachable` prevents an always-rejecting definition. Executable conformance compares
the full TypeScript registration validator over all eight combinations of matching and changed identities.
Actual PostgreSQL tests additionally reject substitution, a missing control and duplicate controls through direct
SQL, then admit the original control. These checks establish identity admission; they do not prove the retained
image's availability or the equivalence of a rebuilt control. The retained evidence and execution boundary are in
the [assessment contract](../src/system-assessment/README.md#frozen-deployed-control).

`registeredRiskPreserved` in `Qualification.lean` maps to risk admission in `policy.ts`.
`admitted_risk_preserves_material_and_account` binds the normalized policy and account hashes;
`unapproved_risk_cannot_register` requires membership in the source-approved policy identities.
`admitted_risk_preserves_every_frozen_ceiling` and `expanded_turnover_cannot_register` enforce all five explicit
integer limits, including the $200,000 daily-turnover ceiling. A complete boundary example is accepted.
Conformance calls the full registration validator with the real production policy constructor, both retained and
expanded PAPER policies, foreign accounts, changed hashes and rehashed expanded limits. PostgreSQL tests reject
each ceiling exceeded by one microdollar and missing material through direct SQL, then retain the complete valid
policy in the first admitted attempt. Cryptographic collision resistance and authority-record authenticity are
external assumptions; these theorems do not grant capital or reconstruct those records.

The economics conformance suite also runs the production source binder and session evaluator for all four policy
accounts across twenty synthetic sessions. It removes submitted financial amounts and compares the resulting cash
bridges, actual profit and qualification profit with the Lean executable. Source-binding regressions separately cover
deposits, passive yield, account-paid expenses, missing cash-flow evidence and incompatible account or session scope.
These checks exercise the evidence join; they do not prove that a normalized invoice or cash-flow classification is
authentic. The retained source review remains an explicit assumption.

`advanceQualificationEquity` maps to the production cumulative equity calculation in `economics.ts` and its use by
`bindSystemSourceCut`. `qualification_window_conserves_profit` proves accumulation of every signed session result,
`negative_session_reduces_equity` preserves a losing session, and `unknown_prefix_remains_unknown` prevents later
profits from resetting a missing cumulative balance. A reachable example includes a losing trade session and a
zero-trade operating loss. Conformance compares 500 seeded known and unknown inputs, and source-binding tests check
the registered allocation, prior losses and missing evidence across the complete twenty-session window.

`Economics.lean` also maps `tariffMeetsFloor` to prospective tariff admission in `src/system-assessment/policy.ts`.
`accepted_tariff_preserves_cost_floor` proves that accepted rates cannot understate the frozen tariff charge for any
nonnegative input and output usage. `frozen_tariff_boundary` checks equality and one micro below the input-rate floor.
Executable conformance compares complete production registrations at the boundary and over seeded rate samples.
Registration tests cover all four policies and effective-period boundaries. Invoices still determine actual economics;
this admission rule constrains qualification tariffs only.

`DecisionWork.lean` maps `registeredMarketWindow` to the time boundary in `sourceFitsRegisteredSession`.
Evidence from either native market must fall in the same half-open registered session. The continuous crypto calendar
cannot extend those hours; opening, closing and empty-window examples are explicit. Conformance compares both native
market profiles at the boundaries and over seeded timestamps. Separate source-scope tests reject unknown feeds,
foreign universes, mismatched calendar types and incomplete registered market sets. The time theorem does not
authenticate the provider calendar or the input data.

`Mutations.lean` maps `mutationAuthority` to `decideMutationAuthority` in `src/execution/mutations/decisions.ts`.
The model distinguishes ordinary submission, bounded close submission and cancellation. An active kill rejects an
ordinary submission while retaining the existing bounded-close and cancellation paths. Missing authority, an OBSERVE
maximum or an unbound generation cannot admit a mutation. Accepted results preserve the account and generation.
Conformance exhausts all 196 combinations of the production enums, nullable generation fields and close-only mode.
The close-only flag does not prove that an order reduces risk; production sizing, ownership and final submission
checks enforce that separate requirement.

`Execution.lean` maps `boundAuthority` to `validateIntentAuthorityBinding` in `src/execution/mutation-authority.ts`.
`authority_binding_pass_is_exact` proves equality of account, strategy name and generation after this check passes.
Conformance covers every matching and mismatching combination and the production failure precedence.

`Authority.lean` maps to `makeExecutionAuthority` in `src/execution/authority.ts`. A mutation result requires a mutation
broker and granted capital. When a persisted grant is supplied, acceptance additionally requires the exact generation,
broker identity, all four strategy identity fields, no revocation and an observation in the half-open validity interval.
Conformance compares 3,848 cases across both broker environments, both access modes, absent and local capital,
persisted identity mismatches, revocation and millisecond time boundaries. Successful production results must preserve
their input identities and capital. The time model assumes canonical UTC timestamps already admitted by the schemas.
The production constructor also supports a local generation without a persisted grant; an explicit theorem preserves
that path rather than asserting persisted validation always occurs. Grant issuance, hash authenticity, persisted
admission and risk limits remain separate boundaries.

`ControllerTiming.lean` maps to `src/system-assessment/controller-latency.ts`. It proves nonnegative ordered durations,
that later durable visibility cannot improve the reported latency, rejection of invalid clocks, a valid empirical
p95 rank for every nonempty sample, and an unknown empty sample. Executable conformance covers clock boundaries and
seeded samples against the production functions. These proofs do not establish full-batch timing coverage or a
portfolio stress result. Native controller and PostgreSQL tests separately check original command retention, replay
after ambiguous commit, and capture of work that completes after its original window.

The same model maps `fullBatchDuration` to `fullBatchClockDuration` in `src/system-assessment/full-batch-latency.ts`.
Its theorems prove that completion bounds inference and every retained stage, duration is nonnegative, an additional
stage cannot shorten the measured batch, invalid or empty stage clocks stay unknown, and a complete example is
reachable. Conformance covers ordered and invalid clocks, signed timestamps and varying stage counts. Source-binding
tests separately cover actual native batch reproduction, submission uncertainty and recovery, missing work and
foreign identities. PostgreSQL tests establish committed batch visibility, including savepoints; storage visibility
alone does not establish semantic validity. The calibration does not establish a portfolio stress profit.

`replayDecisionReleaseAt` in the same model maps directly to `src/intraday-replay/decision-latency.ts`. Accepted releases
cannot precede either actual completion or the original command's p95 floor. Slower work keeps its actual completion;
invalid clocks and negative stress remain unknown, and every accepted result fits the JavaScript date range.
Executable conformance covers signed boundary values and seeded clocks. Native PostgreSQL and TigerBeetle tests
separately exercise still-valid batch and momentum source releases that trade, and expired releases that admit no order. These timing
properties do not prove that increasing latency always reduces profit or that a complete stress evaluation passes.

`ReplaySession.lean` maps to `assessBacktestSession` in `src/intraday-replay/backtest.ts`, also used by the latency
report verifier. A complete session requires zero failed or unavailable decision passes, supported valuations, exact
accounting and resolved mutations. A final window additionally requires no positions or open orders. The model
includes a complete example and distinguishes intermediate inventory from a flat final close. Conformance compares
all 16,384 combinations of the boolean and zero-versus-nonzero conditions with the production evaluator.
Artifact tests retain the exact twenty-session inventory, reproduce per-session costs and completion, and reject
an actual CLI report whose incomplete session is hidden behind a rehashed `COMPLETE` label. These checks establish
consistency of the retained report; they do not authenticate its runner or prove complete market-data capture.

`Ledger.lean` maps to `verifyExactTransfers` and `preflightTransfers` in `src/ledger-plan/verification.ts`.
It represents all twelve compared transfer metadata fields, including the full integer IDs and amounts. Exact
verification requires equal counts, unique IDs in both inventories and matching planned metadata. Preflight rejects
duplicate or changed records and returns only missing planned records in their original order. Replaying a fully
posted plan returns no new transfers. The server-assigned timestamp is deliberately outside metadata equality,
matching production. Conformance compares 1,263 inventories, metadata mutations and timestamps, including IDs and
amounts above JavaScript's safe integer range. The native TigerBeetle regression leaves one of two transfers posted,
closes the client, reconnects, resumes twice and verifies exact balances and counts. It also rejects changed amounts
under existing IDs without changing the recovered ledger. These proofs establish client verification and retry
decisions; TigerBeetle's atomic posting and durable storage remain service assumptions tested by the integration.

`Cycle.lean` maps current v4 cycles to `src/cycle/entry-admission.ts`, `src/cycle/transitions.ts` and the activation,
binding and completion functions in `src/cycle/store/decisions.ts`. The unused lease ends at the earlier of the
submission cutoff and sixty seconds after the later of cycle creation and the submission open. Bound work is not an
unused entry. Replaying activation preserves an active cycle; a new decision binding must still be active, unexpired,
before the cutoff and bound to the exact account, strategy, protocol, qualification and selected snapshot identities.
Completion requires a nondecreasing observation time, a bound decision and one matching durable document. Executed
completion additionally requires a planned result, no risk block and financial completion evidence.

Conformance covers 25 state transitions, 840 lifecycle/time cases, 1,494 binding cases and 1,296 completion-document
cases. It includes absent, duplicate and changed retained documents, selected versus fallback snapshots, both decision
modes, risk blocks, and attached versus explicitly supplied completion evidence. The full document-equivalence predicate
and durable evidence booleans are inputs to the Lean decision model; their schema/SQL implementations are not proven by
these theorems. The PostgreSQL cycle-store suite separately exercises concurrent acquisition, invalid transitions,
early expiry rejection, immutable authority slots, and exact persisted authority/risk admission. The old abstract
`cycleAdmissible` predicate was removed because it did not describe activation replay or the separate binding lease.

`Economics.lean` compares the production `makeOperatingCostReport` normalizer with the formal actual and
qualification profit equations. Session assessment and latency replay use that same normalizer. Conformance also
compares all eighty captured policy/session cash bridges and full cost totals, arbitrary signed monetary inputs,
and cumulative equity across losses and missing sessions. There is no separate TypeScript arithmetic implementation
used only by these tests.

`netTradingPnl` in `src/system-assessment/economics.ts` is the shared production calculation for session assessment
and source-bound operating-cost input. The executable model includes signed execution charges and an explicit signed
settlement-rounding adjustment. Theorems establish one-time settlement and refund attribution and cash-plus-inventory
conservation under the reconciled cost-basis identity. Generated conformance includes gains, losses, credits, rounding
in both directions and nonzero unrealized amounts. Actual transaction/settlement and source-binding regressions verify
that the reported inputs come from retained evidence. Flat closes remain a separate qualification requirement.
An accounting property test constructs actual fractional buy and sell transactions and posted cash settlements
across 300 seeded scenarios. It compares marked cash and remaining basis with the profit equation after each buy,
partial exit and flat close, including windows that start with inventory. The source-capture regression separately
retains a later session's cash fee and settlement obligation when its source fill belongs to an earlier session.

`Economics.lean` also proves that every captured mark eligible for the registered account, session interval and
evidence cut is retained, and that retained marks satisfy those scope constraints. `retainedFinancialMarks` in
`src/system-assessment/forward-evidence.ts` supplies the production path used by source binding. Conformance compares
500 seeded windows and an exhaustive account/time/cut boundary case. The integration regression retains a captured
$20,000 intraminute loss even when the packet omits it or supplies no marks. Conflicting simultaneous marks cannot
be selected away. These results do not supply absent broker valuations or establish their provenance.

`Valuation.lean` maps to `accountMarkValue` in `src/system-assessment/valuation.ts`. It proves cash-plus-inventory
conservation, downward rounding, flat-account cash identity, unrealized profit from actual cost basis, and rejection
of missing cash or missing or duplicated inventory.
A reachable fractional-position example and 1,004 executable conformance cases check the production function.
The PostgreSQL regression reads 35 original quote chunks across the reader's page boundary, checks causal selection
and retained provenance, and rejects another source revision or image. Quote freshness, liquidity and unsupported
coin-debit timing have behavioral tests. Source authenticity, complete account history and quote availability remain
evidence obligations; the arithmetic theorem does not establish those premises. A captured unknown valuation makes
the whole session mark path unresolved, so it cannot remove an unfavorable observation.

`CashHistory.lean` maps to `cashChangesAt` and `projectSessionCash` in `src/system-assessment/cash-history.ts`.
It proves rejection of invalid histories, times before coverage, future cuts and ambiguous debit intervals; preservation without complete
history or cash-flow coverage; conservation when projecting from an observed anchor in either direction; preservation
of known observations; and invalidation of all projected cash after an observed contradiction. A reachable backward
projection and 600 seeded executable cases exercise successful projections, missing evidence and failures. Source
binding tests reconstruct both endpoints across all eighty policy sessions and assess their financial totals. The
forward-performance reader test retains the actual verified settlement records used to build the movement history.
Completeness, source authentication, fee timing and cash-flow classifications remain explicit evidence obligations.

`CostAttribution.lean` maps to `proportionalCost` and `recognizeOperatingCosts` in
`src/system-assessment/cost-attribution.ts`. Theorems establish the nonnegative allocation domain, zero and complete
weights, bounded and monotone floor rounding, request recognition within the registered session, no early recognition
of an in-session request, bounded and monotone accumulated weights, and full recognition of every allocated cost at
close. Reachable metered and zero-trade examples retain invoice and fixed expenses. Executable conformance compares
560 signed and boundary proportional allocations plus 800 complete mark calculations using normalized invoices and
actual retained inference-receipt fixtures. These include rejected calls, zero usage, out-of-session starts, invalid
mark times and monetary amounts beyond JavaScript's exact Number range.

The same module proves that an accepted cost window has one fingerprint per document identity and includes that
document in every required recipient scope. `costWindowConsistent` in `src/operating-cost-window.ts` is the production
predicate. Conformance compares 1,000 arbitrary windows and 100 constructed valid windows. Reachable shared-invoice
and contradictory-allocation examples prevent an always-rejecting predicate from satisfying the test suite.
`validateOperatingCostWindow` binds invoice lines, credits, prepaid funding and payment artifacts to that predicate.
Both system assessment and replay economics invoke it before aggregating sessions. Their behavioral tests reject
invoice copies that shift all expenses to another session and retain the full cost of consistent shared invoices.

`allocateCostByWeights` in the same Lean module maps to the production function in
`src/system-assessment/cost-allocation.ts`. Its cumulative floor differences retain the exact net invoice total
with nonnegative allocations. The domain theorem requires nonnegative net consumption and nonempty positive weights;
reachable examples cover zero charge and a one-microdollar terminal remainder. Executable conformance compares
1,303 cases, including large integers and invalid domains. Registration freezes the ordered account/session weights,
service period, billing identity and basis artifact before the first open. Assessment and replay both validate
each invoice's allocations against that basis. Tests reject consistently retuned invoice copies as well as
contradictory copies; actual PostgreSQL tests verify artifact admission and immutable retention.

The cost proofs assume the prospectively reviewed service-period basis. They do not authenticate invoices, discover
invoices absent from every input, justify the allocation policy or synthesize absent provider clocks.
Regression tests separately reject
missing, substituted, duplicate and unpriced timing, an unregistered attribution rule and packet-supplied accrual
amounts. A missing positive-cost start leaves the intraday path incomplete even when the daily expense is known.
`positive_cost_without_start_cannot_be_recognized` proves that rule; zero-cost missing clocks remain reachable.
Conformance retains rejected historical calls whose actual dispatch clock is unknown.

`NativeArrival.lean` maps original-receipt ordering to `advanceHistoricalMarketCursor` in
`src/market-data/streaming/historical.ts`. Acceptance preserves the frozen capture and epoch, requires consecutive
consumer delivery and strictly increasing receipt sequence, rejects availability-clock regression, and retains
offset order for the next event's own partition. It cannot extend the registered source prefix or substitute supplied
times for original receipts. Conformance compares 1,350 actual cursor transitions, including 150 constructed valid
continuations with reachable prefixes. Existing native-arrival and historical replay tests separately exercise raw
bytes, transport identity and payload projection; those checks are outside this ordering theorem's domain.

`InferenceResolution.lean` maps to `makeJevResolution` in `src/jev/resolution.ts`. A recorded resolution binds the
exact request and receipt. An abandonment cannot precede the original expiry, and a later receipt cannot change that
deadline rule. Conformance compares 144 boundary cases, including 33 accepted resolutions, and verifies canonical
readback and altered-hash rejection. Actual PostgreSQL tests exercise concurrent admission, immutable first-committed
resolution, late receipt retention and process death after committed work. Recording a late financial receipt does
not authorize trading on an expired response.

`InferenceExpense.lean` maps the coverage reduction in `verifyInferenceExpenseCoverage` in
`src/inference-expense.ts`. For source-verified quotes, complete coverage requires exactly one current quote per
provider stage, verified ledger evidence and a known price. Receipt, handoff, request, provider stage, historical chart checkpoints and current stage claim, terminal and skip identities form the matching identity. Aggregate counts cannot erase an earlier missing, unverified or
unpriced stage. Conformance invokes
the actual quote constructors and coverage validator for completed, failed, abandoned, undispatched and late requests,
retained gap quotes, duplicate coverage and multiple parent requests. The undispatched cases count as zero only with
positive evidence that those stages were not dispatched; a missing charge remains unknown. Actual PostgreSQL/TigerBeetle tests separately verify late Jev
posting after a committed chart charge and recovery from partial postings without duplicate transfers.

Candidate and ablation cases also retain claim-only crashes, terminal receipts before handoff, abandonment and late
visual-stage usage, rejected responses with charges, and completed provider chains. An unresolved Jev stage has no frozen
quote yet and remains missing coverage. A retained claim-only quote cannot cover a later terminal receipt. Separate
theorems reject changed historical chart and current stage claim, terminal and skip identities; a reachable late-receipt example keeps the old gap quote
without counting it twice. Source-binding tests retain both checkpoint identities and unknown tariffs in the registered
session instead of converting incomplete usage or pricing into zero costs.

The expense coverage proof assumes the source-validation boundary has reproduced each frozen quote from its immutable
request graph and tariff. It does not authenticate invoices or prove the ledger client. Complete metered coverage is
also distinct from complete invoice-reconciled operating costs. An empty request cut has no missing provider stages,
but does not establish activity, profitability or edge.

`InferenceHandoff.lean` maps the transaction in `makeEntryInferenceJournal` in
`src/db/entry-inference-postgres.ts`. After source decoding, an admission commits the exact handoff and preserves the
resolution state. A repeated handoff cannot dispatch again, changed evidence is rejected, and abandonment permits
cost retention without another dependent dispatch. An ambient transaction is rejected because dependent inference
must observe an independently committed handoff. `two_committed_handoffs_allow_at_most_one_dispatch` proves the
serial transition property; PostgreSQL's request-row lock supplies the serialization boundary.
The resulting handoff admission does not replace the caller's clock checks: `evaluateClaimedEntryInference` still
rejects clock regression and withholds Jev dispatch when the original request expiry has passed.

`commitVisualClaim` models the preceding CHART and BASE_START dispatch transactions, including the independent-commit requirement,
source and claim clocks, original expiry, existing claim, resolution, handoff and already-frozen chart expenses.
`visual_dispatch_requires_original_deadline` proves every successful admission has a valid database admission clock
and no prior resolution, handoff or chart quote. `two_visual_claims_allow_at_most_one_dispatch` proves at-most-once
admission after a successful claim.
Reachable examples distinguish the final valid instant from expiry. Executable conformance compares the actual
PostgreSQL transaction and retained rows in 30 scenarios across both stages, including replay after expiry, changed claims, ambient
transactions, future claim times, abandonment and already-frozen stage quotes. Failed transactions retain the previous state.
The model assumes request identity, provider request content and hashes passed the production decoder; it does not
replace that source-validation boundary, including exact BASE_START predecessors and skip conflicts. Existing concurrent-admission and crash-recovery tests exercise serialization
and late terminal retention. The database checks its clock inside the transaction; this theorem does not bound the
later commit latency. The caller checks the original expiry again after the commit returns, before provider I/O.
The entry-inference tests exercise a commit that consumes the remaining deadline. Late cost evidence never renews
dispatch authority.

The same model's `entryCompletionAdmitted` maps to `verifyEntryCompletion` in
`src/jev/entry-inference-evidence.ts`. Candidate requests cannot claim `OMITTED_BY_POLICY`; a ready ablation request
requires that disposition, and a request without funded proposals requires `NOT_REQUESTED`. An ordinary candidate's
`NOT_DISPATCHED` requires original expiry. All accepted completions follow the committed handoff. A reachable ablation
case and 100 executable comparisons exercise both policies, ready and unprepared handoffs, every provider outcome,
clock regression and the original deadline boundary. These comparisons use valid provider material when received;
the model does not replace source hashes, chart derivation, provider response validation or inference availability.
Ablation requests retain their actual chart charge and require positive omission evidence before Jev usage is zero.
The active candidate cannot consume an ablation receipt. Native strategy construction and entry validation bind the
ablation's complete policy identity; both strategies share sizing, risk, protection, exits and accounting. Migration
153 also rejects candidate/ablation identity substitution at batch and request admission, and enforces provider-policy
completion at receipt insertion. The PostgreSQL tests exercise these guards through direct SQL as well as the
production batch store. Matched-control stress, exact image provenance and complete assessment integration remain
separate gates.

The private replay command selects the candidate, ablation or momentum identity explicitly. All three reuse the existing
`replayDecisionReleaseAt`/`ReplaySession` proof boundaries; the v3 stress protocol names a common candidate-calibrated floor
and preserves each policy's actual slower completion and costs. Behavioral tests reject policy relabeling, mixed
batch evidence and substituted cost scopes. Compiled CLI tests exercise all three identities against PostgreSQL and
TigerBeetle; registry and stopped-container tests bind each policy manifest entry to the same exact image bytes.
These image checks establish retained membership and execution evidence, not cryptographic collision resistance
or the authenticity of market inputs. A twenty-session momentum CLI fixture separately exercises actual replay fills,
protected exits, exact reconciliation and operating-cost attribution. Its locally compiled executable has no verified
image or execution receipt, so the assessment correctly withholds qualification stress economics. Complete matched-control
execution with those provenance bindings remains required for system-level integration.

The formal CI job runs an actual PostgreSQL conformance test with the built Lean executable. It compares sixteen
combinations of existing evidence, abandonment, outer transaction and changed valid handoff, verifies unchanged state
after rejection, and contends eight clients for one request. The observed outcomes must match the Lean transitions,
including exactly one dispatch admission. This tests the real transaction, rather than a TypeScript copy of its SQL.
The job also runs the native resolution restart and concurrency suite. Source decoding and chart/proposal derivation
remain separate from this durable-state theorem's domain.

`accepted_tariff_prices_every_instant_through_close` proves that the registered continuous tariff frontier
covers every instant from the first open through the final close. Gap, exact-close expiry and connected-interval
examples remain explicit. Conformance compares 36 registrations, including reversed tariff input order, with
the production registration validator. Model and provider selection, price floors and canonical tariff decoding
remain separate validation boundaries.

## Limits of the evidence

`NativeOrders.lean` maps to `resolveExecutionOrderTerms` and `bindExecutionEvidence` in system assessment.
The resolver receives normalized broker fields and sealed target fields independently. A bound order requires every
account, generation, decision, intent and symbol to match, and preserves the sealed parent quantity and limit.
Bracket and OCO theorems connect an actual bound result to both sealed exit prices and admissible leg quantities.
Missing-sibling and fractional-residual examples are reachable. Chronological disposal theorems prohibit consuming
future entry fills or spending the same inventory twice. Executable comparisons exercise the production resolver
and full bracket binder, including changed identities, groups, prices, quantities and early protective sales.
The comparison also passes independently approved OCO, stock stop and fractional crypto GTC stop plans into the
production resolver. It retains each protection intent's own decision identity instead of borrowing the entry ID.

`ProtectionIntents.lean` maps to `executionOrderPlans`. Accepted evidence preserves the complete original entry owner,
positive bounded quantity, sealed trigger and exit prices, native DAY/GTC duration, exact reconciliation and bounded
approval clocks. Reachable OCO and fractional crypto stop examples prevent vacuous success claims. Conformance uses
raw entry, plan, risk and reconciliation fields, including canonically rehashed owner, quantity, price and clock
changes. Expected content identities come from the existing canonical SHA-256 functions; the model compares those
strings and does not prove the hash implementation or authenticate an approval.

`Execution.lean` distinguishes spot quotes, native protection and reconciled liquidation. Conditional pricing requires
an actual SELL broker receipt, a verified source and causal availability. Spot pricing retains quote freshness.
Every case still requires decision persistence before routing, dispatch before the original admission deadline, and
fills within the retained order lifetime. Conformance covers both evidence kinds, both sides, all three pricing
variants, verified and absent sources, future availability and stale quotes.

`DecisionPersistence.lean` also maps the replacement admission trigger's independently committed risk approval and
its original validity interval. The actual PostgreSQL/model comparison uses a reproduced native entry under normal
constraints and verifies committed approval, approval written inside the admission transaction, missing approval and
expired approval. The compiled PostgreSQL/TigerBeetle producer separately captures native replacement intents,
admissions and all actual fills. These checks do not authenticate provider observations, normalized child identities,
risk inputs or reconciliation results, and do not establish queue priority.

`AccountProtection.lean` maps to `accountLossMicros` and `accountEntryProtectionReasons` in `src/risk.ts`. Its theorems
prove nonnegative losses, invariance under a common equity translation, equality at the limit, rejection one micro
above it, and a reachable protected account. Conformance compares both production breach reasons over signed equity
samples and exact boundaries. Native PostgreSQL tests separately verify the private receipt, source capture and
assessment of the reproduced admission. These arithmetic proofs do not authenticate the broker's equity observations.

A Lean theorem proves its formal statement for all values within its stated domain. Executable conformance tests compare
the model with production behavior over explicit boundaries, exhaustive finite cases and seeded generated examples.
They do not constitute a universal proof of the TypeScript compiler, PostgreSQL, broker or ledger implementation.

Completion of the full execution scope requires the complete implementation mappings, reachable cases and database and
distributed-system conformance checks described in [system assessment](../src/system-assessment/README.md).
The mapped handoff, resolution, ordering and expense coverage checks above do not establish that the full integration,
matched controls or native prospective evidence collection are complete.

Statistical bounds remain conditional on the registered sampling and market assumptions. Hashes establish content
identity; source capture and provenance checks must establish which actual evidence the model receives. Neither a
successful build nor independent kernel acceptance grants capital authority or establishes profitability.
