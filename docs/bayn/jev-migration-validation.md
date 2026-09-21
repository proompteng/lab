# Jev migration validation

## Request recovery

The signal builder accepts the verified streaming or simulated snapshot type and reproduces its retained raw and
derived source evidence before constructing model input. Technical feature availability, window, source references
and content must reproduce the snapshot identity. A matching symbol alone is insufficient.

Jev evaluation requests require a persisted candidate observation matching the exact cycle, authority generation,
snapshot, candidate symbol and observation time. Excluded candidates cannot acquire a request. The store verifies the
observation's content hash before claiming the request and again on historical readback. Before creating or resuming
an inference claim, it also reconstructs the exact candidate/benchmark state and pinned questions from the retained
source. Valid metadata cannot disguise substituted model input. Historical request bytes remain readable for audit;
superseded input definitions cannot resume inference through the entry path.

Requests commit before inference. Each request has one immutable resolution: `RECORDED`, bound to its
receipt hash, or `ABANDONED`, with a recovery time at or after the request deadline. Receipt persistence and resolution
commit in the same transaction. Recovery and result recording lock the request row, so the first committed resolution
wins. These operations reject ambient transactions to preserve their independent commit boundary.

A provider response that arrives after abandonment remains in the receipt table for replay and cost analysis. It cannot
replace the abandoned resolution or authorize entry. A crash before a result commits leaves a pending request until
`recoverExpiredJevEvaluation` records abandonment after expiry. Recovery never issues another inference for that request.
`JevEvaluationStore.read` verifies historical request, receipt and resolution identities without applying a current-time
entry check. `evaluateJevOnce` continues to enforce freshness before returning usable inference.

The PostgreSQL integration tests kill separate workers after request and result commits, remove their temporary files,
then recover with a new process using only PostgreSQL. They also test concurrent recovery, late receipts, immutable
records, canonical migration of existing receipts and ambient-transaction rejection. These are persistence proofs; the
active trading strategy still requires Jev batch binding and runtime integration.

## Complete candidate batches

`makeJevTradingSignalBatch` takes the complete retained observation and a bounded expiry. It derives cycle,
generation, observation and protocol identities from that evidence, reconstructs the source once, and freezes every
candidate request or source exclusion. `reproduceJevTradingSignalBatch` requires the same complete observation and
rejects a rehashed plan with unrelated source hashes, changed input or an omitted candidate.

Batch results bind one outcome per planned candidate. Recorded failures, abandonment and unattempted candidates
remain visible. Selection requires all requested candidates to have usable recorded results and checks freshness
against the entire batch completion time and the current time after persistence. No candidate can be selected while
another result is missing. These pure contracts do not persist batches or grant authority; durable orchestration and
the native decision binding remain unfinished.

## Economic acceptance

[Acceptance v2](jev-migration-acceptance-v2.json) retains all absolute targets from
[v1](jev-migration-acceptance.json). It adds a paired lower confidence bound above $50 of incremental net profit per
session over each of the three controls. This is an additional research objective of more than $1,000 over twenty
sessions, with uncertainty considered. It is not an estimate of attainable profit.

The current branch contains the numerical checker and a provider client. It does not yet replace the active momentum
strategy or establish economic qualification. The repeated position lifecycle, complete decision-batch evidence,
production credential binding, deployment and prospective outcome evidence remain separate requirements.

## Run the numerical checker

From `services/bayn`:

```sh
bun tools/jev-acceptance.ts --protocol
bun tools/jev-acceptance.ts --input /absolute/path/to/session-summaries.json
```

The first command returns the canonical JSON hash of the frozen protocol. This differs from the SHA256 of its
formatted file bytes. The second reads `bayn.jev-acceptance-input.v1` and emits one JSON report to stdout. Errors go to
stderr. It exits successfully only for `NUMERICAL_TARGETS_PASSED`. That verdict covers numerical checks only and grants
no trading authority. A missing target returns `TARGETS_MISSED`; incomplete observations return `INCONCLUSIVE`.
Malformed input fails before a report is issued.

The input contract is defined by `JevAcceptanceInputSchema` in `services/bayn/src/jev/acceptance.ts`. It requires a
preregistration made after this acceptance protocol was frozen and before the first registered open, twenty ordered
session dates with opening and closing times, and exactly four policy series:

- `JEV`, the candidate.
- `DEPLOYED_BAYN`, the deployed strategy and its original lifecycle.
- `REPEATED_MOMENTUM`, the deterministic control with the candidate's execution and position management.
- `JEV_ABLATION`, the candidate with Jev outputs removed under rules fixed on development data.

Every series must contain the same twenty dates in the registered order, including zero-trade and blocked sessions.
Each complete session records actual completed episodes, filled buy-plus-sell notional, net P&L, opening and closing
equity, marked equity extrema, intraday drawdown, maximum mark gap and a separate p95 batch-latency stress result.
Session equity must continue from the $100,000 allocation and each previous close. Missing base, latency-stress or
minute-mark coverage prevents a numerical pass. An unresolved session must remain an explicit unresolved row.

The checker uses summaries, not raw fills or market events. Independently reproduce each summary from its referenced
evidence. Confirm exact flat reconciliation, complete fills and fees, executable-bid marks at least every minute,
and model and allocated data costs. Spread and slippage already reflected in execution prices must not be deducted
again. The additional ten-basis-point stress is deducted once from each filled dollar, including both sides.

The registration's plan hash must identify the exact candidate and control definitions, code, parameters, questions,
input representations, calendar, source data rules, universe, risk policy, execution and cost models, and selection
procedure. Verify those bytes and their registration time independently. The checker validates identifiers and
aligned numerical inputs; it cannot establish that supplied hashes name authentic evidence or that the calendar
contains every required market session. It also cannot independently establish matched exposure, quote-size units,
source arrival times, liquidity, accounting correctness or deployment identity.

## Statistical comparison

The checker draws 10,000 shared resamples of two-session circular blocks. Each resample contains twenty observations.
The candidate and all controls use the same sampled session indices, retaining paired comparisons. The protocol fixes
the PRNG, seed and empirical percentile rule. Absolute positive profit retains the original one-sided 95% lower-bound
check. The additional comparison uses an error allowance of `0.05 / (attempt * (attempt + 1))`, divided across the
three controls, and requires each resulting paired lower bound to exceed $50 per session.

Attempt numbers belong to an immutable migration-wide registry. Preserve every failed or inconclusive attempt and
never reset that number to obtain a larger allowance. This checker rejects attempts whose tail probability is below
the resolution of its frozen 10,000 draws. Changing that procedure requires a new protocol and untouched window.
Block resampling assumes that the selected block length captures enough dependence. Twenty sessions and a passing
bootstrap result do not guarantee future returns; retain the full daily series and assess this assumption during
independent research review.

The regression suite includes a synthetic counterexample. A candidate earns $300 every session while its control
alternates five-session blocks of +$900 and -$420. The candidate's $6,000 total passes the old $5,000 target and equals
1.25 times the control's $4,800. Its paired lower bound is negative, so v2 rejects it. These are test inputs, not
recorded trading results.

## Score response consistency

TypeSafe defines Score as the probability-weighted value of the ordered levels in its
[API contract](https://docs.typesafe.ai/api). The recorded provider probe includes a score of 1.63 whose reported
probabilities imply 1.65. Exact equality would reject that observed response.

Bayn therefore permits a rounding error of at most 0.005 per probability and per score. It computes the lowest and
highest possible weighted means within those intervals, enforcing total probability mass of one and probabilities
between zero and one. A score outside that feasible interval is rejected. This is an explicit Bayn tolerance, not a
TypeSafe guarantee of decimal precision. The original score and probability values remain unchanged in evidence.
The tests preserve all five recorded Score responses and reject contradictions, including a maximum score with all
probability on the lowest level.

## Reproduce focused checks

From the repository root:

```sh
bun test services/bayn/src/jev/contract.test.ts services/bayn/src/jev/acceptance.test.ts
```

The broader Bayn component checks remain required. Successful unit tests, a numerical pass on synthetic fixtures and
a valid provider response do not complete the production migration or the joint economic objective.
