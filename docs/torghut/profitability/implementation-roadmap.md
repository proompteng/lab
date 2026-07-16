# Torghut Profitability Implementation Roadmap

Status: ordered implementation handoff.

Source baseline: `9f6487ada0cf9222b65cbb1ee9b10d50a09b216e`.

This roadmap converts the [adversarial system design](adversarial-profitability-system-design.md) and
[research and promotion design](research-validation-and-promotion-design.md) into independently reviewable,
PR-sized changes. The [audit snapshot](current-audit-snapshot-2026-07-14.md) is evidence for the ordering, not a
substitute for fresh runtime readback.

## Delivery Contract

Each slice has one principal invariant and must remain narrow enough to review, revert, and prove independently. A
slice is not complete when code or schema merely exists. Completion requires, in order:

1. the behavior is reachable from the production entry point;
2. regression, property, and fault-injection tests cover its failure boundaries;
3. required CI passes on the committed revision;
4. CI publishes an immutable image identity;
5. GitOps promotes that identity and Argo reports the expected revision;
6. a controlled runtime exercise reaches the new path;
7. capability-specific independent evidence proves the intended state transition: broker/capital reconciliation,
   immutable trial/replay reproduction, preserved storage hashes plus restore/failover, or the declared operational
   fault/SLO recovery;
8. the proof bundle records commands, timestamps, revisions, digests, and unresolved deltas.

The implementation must not increase capital authority merely because a slice ships. Capital stage changes are
separate, explicit decisions governed by the promotion ladder.

## Design And Review Discipline

These are implementation gates, not reasons to add ceremony or new architecture:

- Prefer one ordinary control path over special cases, keep functions single-purpose with bounded local state, and
  delete tricky code that exists only to preserve an obsolete shape. This applies the maintainability guidance in the
  [Linux kernel coding style](https://kernel.org/doc/html/next/process/coding-style.html) and Torvalds's emphasis on
  fixing the concrete problem in front of the engineer.
- Add an abstraction only when its small interface hides meaningful complexity or removes knowledge from callers. A
  shallow wrapper that merely renames or forwards fields must be folded into the owning module, following Ousterhout's
  [designing-abstractions guidance](https://web.stanford.edu/~ouster/CS349W/lectures/abstraction.html).
- Treat every implementation of a broker, evidence, storage, or execution protocol as behaviorally substitutable: it
  must preserve the protocol's preconditions, postconditions, invariants, and fail-closed semantics. Contract tests
  must run against every implementation, following Liskov and Wing's
  [behavioral-subtyping criterion](https://www.cs.cmu.edu/~wing/publications/LiskovWing94.pdf).
- Specify concurrent and durable workflows as explicit state transitions. State safety properties (what must never
  happen) separately from liveness properties (what must eventually happen), then test crash, retry, reordering, stale
  writer, and timeout schedules. Use a model checker only when the state space justifies it; do not create a formal
  model as decoration. This applies Lamport's
  [safety/liveness and state-machine method](https://www.microsoft.com/en-us/research/blog/leslie-lamport-receives-turing-award/).
- Separate behavior changes from structural cleanup. Refactor through small behavior-preserving steps on a green test
  base and keep each integration independently reversible, following Fowler's
  [refactoring discipline](https://www.martinfowler.com/books/refactoring.html).
- Tests must be deterministic, sensitive to externally visible behavior rather than implementation structure, cheap
  enough for the intended feedback loop, and predictive of deployment. Start focused, then cross the real database,
  broker contract, image, GitOps, and runtime boundary required by this roadmap, following Beck's
  [programmer-test principles](https://medium.com/@kentbeck_7670/programmer-test-principles-d01c064d7934).

Reviewers must reject duplicate authorities, shallow wrappers, test-only production options, broad exception
boundaries, unexplained state transitions, mocks used as economic proof, and abstractions whose deletion makes the
system easier to understand without losing a required invariant.

## Global Safety Posture

- Keep all live and candidate evidence-collecting risk-increasing submission disabled until Phase 0 exits. P0 broker
  fault exercises may use only an explicit, short-lived `InfrastructureValidationPermit` bound to a dedicated
  paper/sandbox account and tagged as non-promotable.
- Preserve reduce-only cancel, closeout, and emergency liquidation paths during every containment state.
- Keep Hyperliquid testnet-only until its identifiers, timestamps, and economic ledger reconcile independently.
- Do not infer capital stage from strategy IDs, deployment names, account names, namespaces, or environment variables.
- Do not repair historical data by overwriting evidence. Append corrections and retain original payload hashes.
- Roll back application behavior through GitOps. Never roll back a database migration by deleting economic evidence.
- Stop a rollout on any unexplained broker-versus-ledger settled delta, stale proof dependency, or loss of mutation
  fencing.

## Phase And Gate Summary

| Phase                                      | Slices | Capital posture                                    | Exit gate                                                                                                                                          |
| ------------------------------------------ | ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0: Contain and make truth observable      | 1-10   | Risk-increasing submission blocked                 | Durable mutation fencing, independent broker reducer, repaired lifecycle linkage, and fresh zero-unexplained-delta reconciliation                  |
| P1: Make research and runtime comparable   | 11-16  | Replay/shadow only; paper remains separately gated | HA evidence store, one economic policy and envelope, immutable point-in-time receipts, registered trials, and a selection-adjusted candidate board |
| P2: Prove execution and portfolio behavior | 17-18  | Shadow, then bounded paper only                    | Causal execution-policy evidence and portfolio allocator stress proof                                                                              |
| P3: Earn and ratchet capital               | 19-20  | Paper probation, then explicit micro-live grants   | Full-session paper evidence, reconciled micro-live economics, automatic demotion, and champion/challenger governance                               |

Effort classes below are planning estimates, not deadlines: `S` is a small focused PR, `M` spans a subsystem boundary,
and `L` requires coordinated schema/runtime/proof work. Market-session requirements are stated separately because wall
clock time cannot be compressed safely.

## P0: Contain And Make Economic Truth Observable

### Slice 1 - Freeze Capital And Publish A Safety Baseline

**Invariant:** no strategy can increase exposure while the audited proof chain is incomplete; reduce-only exits remain
available.

- Deliverable: make the current capital freeze explicit in GitOps and expose one typed reducer with separate
  `service_healthy`, `entry_allowed`, `reduce_only_allowed`, and `recovery_degraded` projections, including reason,
  effective policy revision, and timestamp through trading status. Define the infrastructure-validation permit schema,
  hard-bind it away from live accounts, and exclude its events from all candidate evidence.
- Primary surfaces: `argocd/applications/torghut/**`, `services/torghut/app/trading/**`, readiness/status tests, and the
  operator runbook.
- Tests: policy parsing, fail-closed entry behavior for missing or malformed authority, validation-permit attempts
  against live accounts or promotion evidence, and regressions proving an entry blocker neither removes a healthy
  control endpoint from Kubernetes service nor disables provable reduce-only closeout.
- Runtime proof: direct scheduler status and readiness, workload environment/config digest, rejected risk-increasing
  order, and accepted controlled reduce-only request without broker mutation when no position exists.
- Dependency: none. Effort: `S`.
- Rollback: revert the status/UI addition only; never restore risk-increasing submission as a rollback.

### Slice 2 - Add Typed `StrategyCapitalAuthority`

**Invariant:** strategy-scoped capital authority is explicit, typed, versioned, and enforced before risk-increasing
broker I/O.

- Deliverable: add the one canonical enum (`disabled`, `quarantined`, `research_only`, `replay_verified`,
  `shadow_allowed`, `paper_probation`, `paper_verified`, `micro_live_allowed`, `capital_allowed`, `scaled`) plus account,
  venue, notional, gross, net, order-rate, symbol, session, expiry, and reduce-only constraints. Map legacy
  `EvidenceEpochDecision` values conservatively and reissue legacy canary/live/scale decisions only when every new
  field and approval exists.
- Primary surfaces: `services/torghut/app/strategies/catalog.py`, `services/torghut/app/trading/evidence_epochs.py`,
  promotion/proof-floor/submission-council issuers and consumers, strategy schema/loaders, global live flags, trading
  policy evaluation, status payloads, and `argocd/applications/torghut/strategy-configmap.yaml`.
- Tests: complete caller inventory, one-to-one legacy mapping, unknown/partial states quarantined, schema compatibility,
  deny-by-default, expired grants, per-strategy isolation, and property tests that neither a legacy global flag nor a
  request outside any bound can reach the broker adapter.
- Runtime proof: two concurrently enabled strategies with different stages cannot inherit or cross-use one another's
  authority; status reports the exact authority digest.
- Dependency: slice 1. Effort: `M`.
- Rollback: retain the schema and set every strategy to `disabled`; do not restore a parallel legacy or name-derived
  authority.

### Slice 3 - Fix Autoresearch Completion Semantics

**Invariant:** a discarded, invalid, or unproved candidate can never satisfy the research objective or stop the search.

- Deliverable: compute objective satisfaction only after terminal candidate validation and persist the reason for every
  continuation or stop decision.
- Primary surfaces: `services/torghut/scripts/strategy_autoresearch_loop/run_strategy_autoresearch_loop.py`, its modular
  package, result writers, and focused tests.
- Tests: discarded candidate above the raw objective, valid candidate below it, valid candidate above it, interrupted
  runs, duplicate candidate identities, and deterministic resume.
- Runtime proof: a bounded replay containing an intentionally high-scoring discarded candidate continues and records a
  non-objective terminal state.
- Dependency: none; may proceed in parallel with slice 2. Effort: `S`.
- Rollback: disable automated stopping and require an explicit operator-selected terminal trial.

### Slice 4 - Wire Durable Claims And Receipts Into Submit

**Invariant:** every production order submission has a durable intent claim before the first broker mutation and a
receipt or unresolved state afterward.

- Deliverable: route all production submit entry points through one mutation coordinator using deterministic idempotency
  keys and transactional claim state.
- Primary surfaces: broker adapters and order-routing entry points under `services/torghut/app/**`, claim migrations,
  `services/torghut/tests/test_broker_mutation_receipts_unwired.py`, readiness metrics, and the
  [infrastructure-validation runbook](infrastructure-validation-runbook.md).
- Tests: process death before claim, after claim, during broker timeout, after broker acceptance, and before receipt
  persistence; duplicate request and concurrent-leader property tests.
- Runtime proof: fault-injected submissions under a short-lived `InfrastructureValidationPermit` produce one dedicated
  paper/sandbox order and one terminal claim, with zero unclaimed mutations, zero duplicated broker intents, and zero
  rows admissible as candidate evidence.
- Dependency: slice 2. Effort: `L`.
- Rollback: block submit and preserve unresolved claims for reconciliation; never retry blindly or delete claims.

### Slice 5 - Implement Strict Submit Recovery

**Invariant:** an ambiguous submit resolves through broker observation before any retry.

- Deliverable: add a recovery worker and state machine for `claimed`, `submitted_unknown`, `acknowledged`, `rejected`,
  `expired`, and `manual_review`; use client order IDs and broker activity as evidence.
- Primary surfaces: mutation coordinator, broker query/activity APIs, scheduler jobs, metrics, and operator actions.
- Tests: lost response with accepted order, lost response with no order, delayed activity, conflicting broker IDs,
  restart/re-election, and bounded recovery timeout.
- Runtime proof: injected response loss recovers the original paper order without producing a second order.
- Dependency: slice 4. Effort: `M`.
- Rollback: stop recovery retries, retain unresolved claims, and require manual broker reconciliation.
- Operator action: the only local terminal for absent evidence is the reviewed
  [paper-IOC validation quarantine closure](validation-quarantine-closure.md). It cannot settle linked, ordinary,
  promotable, non-IOC, or live-account submissions and does not claim broker rejection.

### Slice 6 - Fence Cancel, Replace, And Closeout Mutations

**Invariant:** submit is not the only fenced mutation; every broker-side state change is claimed, receipted, and
recoverable.

- Deliverable: extend the coordinator to cancel, cancel-all, replace, multi-leg unwind, reduce-only closeout, and
  emergency liquidation, including causal links to the original order. Add a per-action `RiskReductionPermit` derived
  from broker-observed orders/positions that forbids new symbols, side flips, and any gross/net exposure increase; it
  must remain issuable when candidate authority or profitability evidence is missing or expired. Validation descendants
  carry an exact-key root-and-parent lineage envelope enforced by PostgreSQL; mixed ordinary/validation account-wide
  cancellation remains live without relabeling ordinary activity, and each proven validation event remains outside
  candidate, trial, PnL, promotion, and ledger evidence.
- Primary surfaces: all broker mutation adapters, closeout/kill-switch paths, claim schema, and emergency runbooks.
- Tests: cancel/replace races with fills, partial-fill closeout, duplicate cancel, multi-leg partial failure, stale
  candidate authority, stale profitability/reconciliation evidence, no-side-flip and no-increase properties, forged or
  cross-scope validation ancestry, descendant order-feed exclusion, and broker outage during emergency reduction.
- Runtime proof: an infrastructure-validation paper/sandbox lifecycle exercises each mutation, reconciles a single
  causal chain, and remains excluded from every promotion/trial query.
- Lifecycle shape: preserve the original maximum-$1 known-null submit proof and use one separate maximum-$30 Alpaca
  paper lifecycle: filled limit IOC entry, zero-fill GTC close, replacement with rotated order ID, cancellation,
  partial broker close, and final flatten. Both planned reduction legs must remain at least $12 at the entry limit.
  Current broker asset minima and increments are runtime preconditions; cancel never becomes an order-identity parent,
  and an ambiguous mutation is never retried from the old observation.
- Dependency: slices 4-5. Effort: `L`.
- Rollback: keep submit blocked; preserve the already-fenced reduce-only closeout path and disable replace.

### Slice 7 - Ingest Immutable Broker Economic Activities

**Invariant:** the broker, not an internal strategy loop, is the source of truth for executed economics.

Detailed design: [Broker Economic Source Ingestion](broker-economic-source-ingestion.md).

- Deliverable: ingest account activities and order updates through streaming plus paginated backfill, append raw payloads
  with hashes, and normalize orders, fills, fees, cash movements, corrections, and corporate actions.
- Primary surfaces: Alpaca broker client/worker code, CNPG migrations, event schemas, Kafka topics if retained, and
  freshness/readiness metrics.
- Tests: reconnect and cursor recovery, pagination boundaries, out-of-order and duplicate events, correction events,
  split/dividend handling, and raw-payload immutability.
- Runtime proof: stream interruption followed by backfill yields the same normalized event multiset and source hashes.
- Dependency: may begin after slice 4; final integration depends on slice 6. Effort: `L`.
- Rollback: stop projection consumers but retain raw append-only events and cursor state.

### Slice 8 - Build An Independent Economic Ledger

**Invariant:** profitability is reconstructed from broker economic events by a reducer independent of trading decisions
and the existing runtime ledger.

- Deliverable: deterministic double-entry projections for positions, cash, equity, realized/unrealized P&L, fees,
  dividends, corrections, and corporate actions; retain both canonical and independent reducers.
- Primary surfaces: new isolated ledger package, CNPG migrations/views, reconciliation API, and deterministic replay CLI.
- Tests: golden broker fixtures, accounting identities, shuffled/duplicated events, partial fills, shorts, splits,
  dividends, corrections, restart determinism, and reducer differential tests.
- Runtime proof: two independently implemented projections converge to broker state from the same immutable activity
  set, with an enumerated explanation for every unsettled difference.
- Dependency: slice 7. Effort: `L`.
- Rollback: mark projections invalid and rebuild from raw events; never mutate the source event store.

### Slice 9 - Repair Order-Feed And Decision-Lineage Coverage

**Invariant:** each order/fill is causally linked where possible, and all unlinked external/manual activity is explicit
rather than silently excluded.

- Deliverable: populate stable execution, order, decision, strategy, claim, and broker-event links; backfill append-only
  repair receipts with confidence and provenance.
- Primary surfaces: `services/torghut/scripts/reconcile_cross_dsn_order_feed_links.py`, lifecycle import SQL/package,
  migrations, and coverage metrics.
- Tests: one-to-many partial fills, legacy null IDs, ambiguous matches, manual orders, corrections, and non-destructive
  repeatable backfill.
- Runtime proof: fresh paper activity achieves complete claim/order/fill/event linkage; historical residuals are
  classified, counted, and excluded from promotion when causal identity is unproved.
- Dependency: slices 6-8. Effort: `M`.
- Rollback: invalidate repair receipts by version; retain original rows and prior mappings.

### Slice 10 - Require Fresh Full TigerBeetle Parity

**Invariant:** protocol health and journal writes are not accepted as proof of economic parity.

- Deliverable: reconcile the full broker-derived economic projection against TigerBeetle balances/transfers, publish
  source watermark and age, and make freshness plus zero unexplained settled delta blocking dependencies for
  `entry_allowed`, accounting authority, and promotion. They must not make `service_healthy` or Kubernetes readiness
  false while the control/recovery endpoint can still serve safely.
- Primary surfaces: `services/torghut/scripts/audit_tigerbeetle_runtime_ledger_parity.py`, verification scripts,
  `argocd/applications/torghut/tigerbeetle-smoke-job.yaml`, scheduler entry/status projections, and GitOps schedules.
- Tests: missing transfers, duplicate transfers, stale watermark, source lag, correction events, and protocol-up/parity-
  down behavior.
- Runtime proof: scheduled parity completes from the broker event watermark through both ledgers and fails closed when a
  controlled discrepancy is introduced.
- Dependency: slices 8-9. Effort: `M`.
- Rollback: leave trading blocked and restore the last verified projection for inspection only, never for fresh proof.

## P1: Make Research And Runtime Comparable

### Slice 11 - Harden CNPG Evidence Storage And Recovery

**Invariant:** the economic evidence store has measured recovery characteristics and no single untested database failure
mode.

- Deliverable: benchmark the heavy lifecycle/reconciliation queries, add justified indexes or projections, define CNPG
  HA/backup/PITR objectives, and exercise restore into an isolated target.
- Primary surfaces: Torghut migrations, query plans, CNPG GitOps, backup/restore configuration, and database runbooks.
- Tests: migration graph, representative `EXPLAIN (ANALYZE, BUFFERS)`, replica/failover continuity, backup integrity,
  and isolated point-in-time restore.
- Runtime proof: recorded RPO/RTO exercise plus query latency and resource envelopes at current and projected volume.
- Dependency: stable schemas from slices 7-10. Effort: `L`.
- Rollback: revert performance settings/index use through a forward migration; preserve evidence and backups.

### Slice 12 - Define One Versioned Economic Policy

**Invariant:** replay, shadow, paper, and live use the same versioned session, sizing, fee, slippage, risk, and accounting
policy rather than divergent defaults.

- Deliverable: a typed `EconomicPolicy` artifact with immutable digest, including leverage, participation, sessions,
  fees, borrow, latency, slippage, stale-data behavior, and risk limits.
- Primary surfaces: strategy/runtime configuration, replay runners, broker adapters, promotion manifests, status, and
  GitOps. Remove the research/live gross-exposure mismatch.
- Tests: serialization compatibility, digest stability, default rejection, and cross-engine fixture parity.
- Runtime proof: the same fixture and policy digest produce identical pre-broker intents in replay, shadow, and paper.
- Dependency: slice 2. Effort: `M`.
- Rollback: pin the prior policy digest with all capital disabled; do not reintroduce stage-specific hidden defaults.

### Slice 13 - Persist Immutable Point-In-Time Data Receipts

**Invariant:** every result names the exact causal market, corporate-action, universe, feature, and code inputs available
at each decision time.

- Deliverable: dataset and feature receipts with event-time/arrival-time boundaries, source watermarks, universe version,
  adjustment policy, artifact hashes, and code/policy digests.
- Primary surfaces: replay importers, feature pipelines, ClickHouse/CNPG metadata, artifact storage, and research reports.
- Tests: look-ahead traps, late data, revised bars, delistings, corporate-action restatement, timezone/session edges, and
  receipt hash reproducibility.
- Runtime proof: an independent rerun from a receipt reproduces the exact input row set and feature matrix hash.
- Dependency: slice 12. Effort: `L`.
- Rollback: reject unreceipted trials; retain prior artifacts as non-promotable historical diagnostics.

### Slice 14 - Unify Engine Semantics With An Envelope Digest

**Invariant:** a candidate is not promoted when research and runtime transform the same signal differently.

- Deliverable: one versioned order-intent/execution envelope or a differential conformance layer that covers signal
  timing, session rules, rounding, sizing, costs, latency, order type, partial fills, and risk checks.
- Primary surfaces: replay execution packages, trading runtime, TCA calculation, policy artifacts, and parity tooling.
- Tests: golden event streams across replay/shadow/paper, randomized differential tests, and counterexamples for every
  former divergence.
- Runtime proof: envelope digests match for a controlled shadow/paper session and all differences are zero or explicitly
  classified as venue observations.
- Dependency: slices 12-13. Effort: `L`.
- Rollback: demote candidates to replay and block promotion when envelope parity is unknown.

### Slice 15 - Add A Registered Trial Ledger And Statistical Gates

**Invariant:** selection history, failed trials, degrees of freedom, and untouched test sets cannot be erased from the
promotion decision.

- Deliverable: immutable hypothesis/trial registration, purged walk-forward folds, embargo, family-aware search counts,
  Deflated Sharpe Ratio, probabilistic backtest-overfitting analysis, White Reality Check/Hansen SPA where applicable,
  negative controls, and signed terminal reports.
- Primary surfaces: autoresearch runner, candidate board, promotion validation, schemas, and reproducibility artifacts.
- Tests: deterministic folds, purge/embargo leakage, duplicate trial identity, hidden failed-trial deletion, synthetic
  null strategies, and known statistical fixtures.
- Runtime proof: seeded null candidates fail at the expected rate and a complete trial can be reproduced from receipts.
- Dependency: slices 3 and 13-14. Effort: `L`.
- Rollback: freeze promotion and retain all registered trials; never delete unfavorable history.

### Slice 16 - Rebuild The Candidate Board From Admissible Evidence

**Invariant:** a candidate cannot rank on duplicated, stale, tiny-sample, unlinked, or non-runtime evidence.

- Deliverable: regenerate the board using current ledger lineage, minimum sample/session requirements, selection-adjusted
  statistics, after-cost capacity, tail risk, and an explicit admissibility state.
- Primary surfaces: `services/torghut/scripts/whitepaper_autoresearch_runner/candidate_board_*`, profitability frontier
  scripts, promotion manifests, and operator reporting.
- Tests: duplicate ledger windows, overlapping samples, stale sources, below-minimum trades/days, missing costs, blocked
  lineage, and deterministic ranking.
- Runtime proof: the prior six tiny-sample blocker-free variants are either rejected with reasons or re-established on
  new independent evidence; no historical aggregate is presented as deployable P&L.
- Dependency: slices 8-10 and 13-15. Effort: `M`.
- Rollback: publish no champion; retain the previous board as a clearly marked non-authoritative snapshot.

## P2: Prove Execution And Portfolio Behavior

### Slice 17 - Run A Causal Execution-Policy Experiment

**Invariant:** execution changes are promoted on causal after-cost evidence, not aggregate correlation or simulated
fill-rate alone.

- Deliverable: randomized or matched shadow/paper comparison of order types, urgency, participation, and cancel/replace
  policies; preregister primary TCA outcomes and safety guardrails.
- Primary surfaces: execution router, TCA refresh pipeline, policy assignments, broker activity ledger, and experiment
  report.
- Tests: assignment determinism, no cross-arm leakage, arrival-price timing, censored orders, partial fills, fees, and
  adverse-selection horizons.
- Runtime proof: enough independent market sessions to estimate implementation shortfall and tails with confidence;
  zero missing expected-shortfall or lineage fields.
- Dependency: slices 7-10 and 12-16. Effort: `M` plus market sessions.
- Rollback: restore the prior envelope digest and demote the experimental policy; retain assignments and outcomes.

### Slice 18 - Implement Portfolio Risk Allocation And Capacity Limits

**Invariant:** portfolio capital is allocated by after-cost edge, covariance, liquidity, and drawdown constraints; no
strategy scales itself independently.

- Deliverable: centralized allocator with gross/net, factor, sector, symbol, turnover, participation, concentration,
  drawdown, volatility, correlation, and aggregate loss limits; conservative covariance shrinkage and stress scenarios.
- Primary surfaces: risk engine, capital authority, sizing, status/metrics, promotion manifests, and kill switches.
- Tests: correlated strategies, covariance singularity, liquidity shock, gap/volatility shock, stale inputs, allocator
  restart, bound monotonicity, and reduce-only behavior during breach.
- Runtime proof: shadow and paper portfolios respect every bound under recorded stress replay and live session movement;
  broker-derived exposures equal allocator observations.
- Dependency: slices 2, 10, 12, 16-17. Effort: `L`.
- Rollback: zero new allocation, preserve reduce-only exits, and revert to explicit per-strategy caps below the last
  proven aggregate envelope.

## P3: Earn And Ratchet Capital

### Slice 19 - Conduct Paper Probation

**Invariant:** paper authority is earned by a named candidate and expires; it is not inherited by a family or deployment.

- Deliverable: grant bounded `paper_probation` evidence-collection authority to one admissible champion and at least one
  null/challenger control, with automatic expiry, demotion, and daily proof bundles. It is not final promotion authority.
- Required entry: P0 and P1 complete; slices 17-18 pass; current market route healthy; fresh zero-delta reconciliation;
  no unresolved submission claims; policy and envelope digests match.
- Required observation: at least 20 source-backed trading days and 300 closed trades unless a stricter preregistered
  family-specific gate applies; multiple regimes/sessions; complete TCA and broker lineage.
- Exit proof: after-cost expectancy and tails pass preregistered selection-adjusted thresholds; drawdown, turnover,
  capacity, and reconciliation guardrails remain within limits; null controls do not show the same result. A pass
  creates `paper_verified`, not real-capital authority.
- Primary surfaces: capital grants, promotion validator, scheduler status, daily report/proof artifacts, and runbook.
- Dependency: slices 1-18. Effort: `M` plus the required market sessions.
- Rollback: automatic authority expiry or immediate demotion to shadow; close risk reduce-only and retain the full bundle.

### Slice 20 - Introduce Micro-Live Ratchets And Champion/Challenger Governance

**Invariant:** live capital starts at a loss-tolerant amount, scales only on new reconciled evidence, and automatically
shrinks faster than it grows.

- Deliverable: explicit human-approved micro-live grants, loss budget, notional ceiling, daily/weekly ratchet rules,
  champion/challenger allocation, shadow holdout, automatic demotion, and emergency revoke.
- Required entry: slice 19 reaches `paper_verified`; broker/account permissions verified; independent ledger and
  TigerBeetle parity fresh; recovery drill passes; no unresolved settled delta; SEC 15c3-5-style pre-trade controls and
  kill paths evidenced.
- Scale rule: each increase is a new experiment with a new authority version and expiry. Require stable after-cost edge,
  unchanged envelope parity, adequate sample, acceptable market impact, and no tail or reconciliation breach.
- Immediate demotion: unexplained economic delta, mutation-fencing loss, stale broker events, TCA lineage gap, limit
  breach, policy mismatch, drawdown breach, or statistically material edge decay.
- Runtime proof: broker-originated cash/position/P&L matches both ledgers; injected readiness and risk failures revoke
  new orders while reduce-only closeout remains operable.
- Dependency: slice 19 plus explicit capital-owner approval. Effort: `L` plus multiple market regimes.
- Rollback: revoke the grant, stop risk-increasing orders, reduce exposure within the approved closeout policy, and
  return the candidate to paper or shadow.

## Cross-Cutting Proof Bundle

Every slice that reaches the cluster must publish one immutable bundle containing the applicable fields below. Mark a
field `not_applicable` with a reason when the slice does not touch that authority; never manufacture a broker event for
a research-only change.

- repository commit, CI run, image digest, GitOps commit, Argo application revision, and pod image IDs;
- configuration, capital-authority, economic-policy, strategy, dataset, feature, and execution-envelope digests;
- exact test and fault-injection commands with outcomes;
- controlled runtime request IDs and mutation claims/receipts;
- broker activity cursor/watermark and raw-event hash range;
- canonical ledger, independent ledger, broker, and TigerBeetle reconciliation summaries;
- TCA completeness, order/fill/decision lineage coverage, and all residual rows with classifications;
- entry gate, exit gate, approver for any capital change, expiry, rollback trigger, and rollback evidence;
- known limitations and an explicit statement of which claims the bundle does **not** establish.

Proof bundles are append-only. A later successful bundle does not erase an earlier failure or unresolved delta.

## Program-Level Acceptance Criteria

The roadmap is complete only when all of the following are true on fresh evidence:

- every production broker mutation is fenced and recoverable, with no reachable bypass;
- broker economic events reconstruct cash, positions, equity, fees, and P&L through two independent reducers;
- broker, both reducers, and TigerBeetle have zero unexplained settled delta at a fresh watermark;
- every promotion result is point-in-time, reproducible, trial-registered, selection-adjusted, after-cost, and
  capacity-constrained;
- replay, shadow, paper, and live share one policy and execution envelope or have zero unexplained differential;
- capital authority is strategy-scoped, bounded, versioned, expiring, observable, and enforced before risk-increasing
  broker I/O;
- stale or missing economic evidence blocks risk increase but does not prevent reduce-only risk removal;
- paper and micro-live results survive preregistered minimum samples and market regimes without relying on duplicated
  windows or the same data used for selection;
- scaling, demotion, kill, recovery, database failover, and evidence restore have all been exercised rather than merely
  documented;
- an independent reviewer can reproduce the promotion decision from the proof bundle without trusting a dashboard or a
  self-reported strategy aggregate.

Until these criteria pass, Torghut may be a useful research and execution platform, but it must not represent itself as
a proven profitable production trading system.
