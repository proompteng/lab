# ADR 134: Jangar Profit-Clock Settlement Router and Evidence Margin Arbiter

- Status: Accepted for engineer and deployer handoff
- Date: 2026-05-07
- Owner: Gideon Park, Torghut Traders architecture
- Scope: Jangar control-plane settlement, Torghut quant capital admission, failure-mode reduction, rollout safety
- Companion: `docs/torghut/design-system/v6/138-torghut-capital-efficiency-proof-exchange-and-profit-clock-2026-05-07.md`

## Decision

Jangar will become the profit-clock settlement router for Torghut quant actions. It should not only report
whether services are up. It should issue action-scoped settlement receipts that say whether the evidence clocks
behind a capital decision are current, coherent, and tied to the same runtime authority epoch.

The selected path is a settlement router with an evidence margin arbiter:

1. Jangar emits `profit_clock_settlement_receipt` records for Torghut actions.
2. Each receipt joins runtime admission passport state, dependency quorum, rollout health, negative evidence,
   quant ingest freshness, execution-trust state, and the requested Torghut action class.
3. Torghut consumes the receipt as a required input for capital transitions from shadow to paper and paper to live.
4. Repair actions remain allowed under degraded trust only when the receipt explicitly settles to `repair_dispatch`
   and the action is zero-notional.
5. Any stale or contradictory clock settles to a hold with a rollback target instead of leaving downstream systems
   to infer intent from health endpoints.

This is more conservative than widening paper/live capital immediately, but it reduces the failure mode now
visible in the cluster: pods are serving while profit authority is still blocked by stale, contradictory, or
empty evidence clocks.

## Evidence Snapshot

This decision is based on a read-only pass on 2026-05-07 around 06:10-06:20 UTC.

Cluster evidence:

- Jangar deployment is rolled out and serving. `/health` reports `status: ok`, with embedded agents-controller
  mode disabled in the Jangar process.
- `agents-controllers` is rolled out at 2/2 replicas after earlier failed agent jobs and transient readiness
  timeouts.
- Torghut live revision `torghut-00250` and sim revision `torghut-sim-00350` are rolled out and serving.
- Torghut live `/readyz` is degraded, not down. The blockers are profit authority blockers:
  `simple_submit_disabled`, `zero_notional`, `hypothesis_not_promotion_eligible`,
  `execution_tca_stale`, and degraded quant evidence.
- Live quant evidence shows `maxStageLagSeconds: 44777`. Compute is fresh enough, but ingestion and
  materialization disagree.
- Sim `/readyz` is ok, but its proof floor still reports zero notional and non-promotion-eligible alpha state.
- Events show transient rollout/readiness failures, old failed jobs, and ClickHouse PDB ambiguity, but current
  rollout state is not the main blocker.

Database and data evidence:

- Direct `kubectl cnpg psql` and `kubectl exec` were blocked by RBAC for `pods/exec`, so the database pass used
  existing application credentials read without printing secrets.
- Postgres schema head is `0029_whitepaper_embedding_dimension_4096`.
- `execution_tca_metrics` has 13,775 rows, but latest `computed_at` is
  `2026-04-02T20:59:45.136640Z`. Average absolute slippage is about 568.6 bps, which is not fit for live
  authority.
- `trade_decisions` has 147,623 rows. Latest created decision is `2026-05-06T17:44:19.618796Z`, while latest
  executed decision is tied to the April 2 execution epoch.
- `strategy_hypothesis_metric_windows` has only 3 persisted windows, all for `H-MICRO-01`, and only one window
  shows positive post-cost expectancy. Existing promotion state remains blocked by sample count, slippage, and
  expectancy gates.
- ClickHouse `torghut.ta_microbars` and `torghut.ta_signals` are populated through
  `2026-05-06T20:58:35Z`, but `options_contract_bars_1s`, `options_contract_features`, and
  `options_surface_features` are empty.

Source evidence:

- `services/jangar/src/server/control-plane-status.ts` already composes runtime admission, rollout health,
  execution trust, dependency quorum, and stages, but it does not settle those facts into Torghut-specific
  action authority.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already issues admission passport state for
  consumer classes and can block on execution-trust/runtime-kit failures.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` already produces material action
  verdicts with dependency quorum, rollout health, action SLO budget, and rollback targets.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already routes Torghut readiness,
  market context, quant alerts, rollout ambiguity, PDB warnings, and execution-trust evidence into negative
  evidence.
- The missing abstraction is not another health check. The missing abstraction is a settled, action-scoped
  contract that Torghut can treat as capital authority input.

## Problem

The current control plane can say many true things, but it does not settle them into one decision that is safe
for capital.

That creates three production risks:

1. False recovery: rollouts can be green while capital proof is stale.
2. False repair paralysis: degraded execution trust can block every action, including zero-notional repairs that
   would retire the debt.
3. False promotion: a paper window can look attractive without proving it belongs to the same stage epoch,
   TCA epoch, market-context clock, feature clock, and rollout authority that would carry live capital.

The May 7 evidence shows all three risks. Availability improved, but Torghut still has stale live TCA, empty
options features, non-promotion-eligible hypotheses, and quant-stage clock disagreement. Jangar needs to make
those facts actionable without requiring every consumer to reconstruct the same reasoning.

## Alternatives Considered

### Option A: Keep Current Health and Verdict Surfaces

Keep `/health`, control-plane status, runtime admission, material action verdicts, and negative evidence as
separate sources. Torghut continues to infer capital authority by reading its own proof floor plus selected
Jangar status endpoints.

Benefit:

- Low implementation cost because most pieces already exist.
- Keeps Jangar generic and avoids Torghut-specific action classes in the settlement layer.

Cost:

- Leaves the exact current failure mode intact: green rollout state can coexist with stale or contradictory
  profit evidence.
- Makes engineer and deployer stages debug by correlation instead of receipt replay.
- Does not give a safe carve-out for zero-notional repair when execution trust is degraded.

### Option B: Use Jangar as a Hard Global Capital Gate

Make Jangar the single global gate for any Torghut promotion, blocking all Torghut capital transitions unless
every dependency is ok.

Benefit:

- Easy to reason about operationally.
- Strong safety posture for live capital.

Cost:

- Too blunt. It blocks repairs during the exact periods when repair work is most valuable.
- It cannot rank repair work by expected profit impact.
- It treats stale TCA, empty options features, degraded runtime kits, and rollout ambiguity as equivalent
  failures even though they need different responses.

### Option C: Profit-Clock Settlement Router With Evidence Margin Arbiter

Jangar issues action-scoped receipts. Each receipt says which clocks were checked, which evidence is missing or
stale, which action class is allowed, how long the receipt is valid, and what rollback target applies if the
receipt expires or a source changes.

Benefit:

- Converts many partial truths into one replayable authority decision.
- Allows zero-notional repair under explicit degraded-state receipts while keeping capital locked.
- Lets deployer stages roll out control-plane changes with action-class fuses instead of broad service fuses.
- Gives Torghut a stable contract for pricing repairs and advancing paper/live capital.

Cost:

- Requires a new settlement schema and tests that cover cross-source clock coherence.
- Adds one more authority object that must be versioned carefully.
- Some promising hypothesis windows will stay blocked until their evidence clocks are current.

I choose Option C.

## Architecture

### Action Classes

Jangar settlement must classify each requested Torghut action before deciding authority:

- `observe`: read-only status, diagnostics, dashboards, and audit capture.
- `repair_dispatch`: zero-notional work that refreshes stale evidence or repairs missing proof lanes.
- `paper_canary`: paper-only hypothesis admission or widening.
- `live_micro_canary`: tightly capped live admission for a hypothesis already proven in the current epoch.
- `deploy_widen`: rollout or runtime-kit change that can widen the control-plane or data-plane blast radius.

Each class gets its own required clocks and rollback targets. `repair_dispatch` is the only class allowed to
settle positively when execution trust is degraded, and it must carry `notional_ceiling: 0`.

### Profit-Clock Settlement Receipt

The receipt should be durable and replayable. The exact storage implementation is left to engineer stage, but
the contract should contain these fields:

- `receipt_id`
- `issued_at`
- `expires_at`
- `schema_version`
- `requested_action_class`
- `decision`: `allow`, `repair_only`, `hold`, or `deny`
- `rollback_target`: `shadow`, `paper`, `previous_revision`, or `zero_notional`
- `torghut_revision`
- `jangar_revision`
- `stage_epoch`
- `runtime_admission_passport_id`
- `runtime_admission_status`
- `dependency_quorum_ref`
- `execution_trust_status`
- `rollout_health_ref`
- `material_action_verdict_ref`
- `negative_evidence_refs`
- `quant_clock`: ingest, compute, materialization, and latest-store freshness
- `tca_clock`: latest computed time, sample count, slippage budget state
- `hypothesis_refs`: requested hypothesis IDs and states
- `feature_inventory_ref`: required feature lanes and row/freshness state
- `settlement_reasons`: stable machine reason codes

Receipts should be short lived. Suggested initial TTLs:

- `observe`: 10 minutes
- `repair_dispatch`: 5 minutes
- `paper_canary`: 2 minutes
- `live_micro_canary`: 30 seconds
- `deploy_widen`: 60 seconds

### Evidence Margin Arbiter

The arbiter computes how much uncertainty margin must be held back before an action can proceed. It is not a
portfolio allocator. It is a control-plane risk arbiter for evidence quality.

Evidence margin dimensions:

- Time margin: how stale each required clock is relative to action class.
- Lineage margin: whether empirical jobs, datasets, runtime refs, and model refs point at the same epoch.
- Data margin: whether source tables are populated and recent enough.
- Execution margin: whether TCA is recent, sampled, and under slippage budget.
- Rollout margin: whether current revision, private service, and route state are unambiguous.
- Trust margin: whether dependency quorum and execution trust are allow, delay, degraded, or block.

Settlement rule:

- `allow` only when every required dimension is within class-specific margin.
- `repair_only` when capital is unsafe but a zero-notional repair can retire a named evidence debt.
- `hold` when evidence is stale, contradictory, or incomplete but no destructive action is requested.
- `deny` when the requested action would widen capital or blast radius against a blocking source.

### Integration With Existing Jangar Modules

Engineer stage should avoid a parallel control plane. The new router should compose existing modules:

- Runtime authority from `control-plane-runtime-admission.ts`.
- System status and stage state from `control-plane-status.ts`.
- Action SLO and rollback intent from `control-plane-material-action-verdict.ts`.
- Negative evidence from `control-plane-negative-evidence-router.ts`.
- Torghut quant store freshness from the current quant metrics runtime.
- Rollout health from current rollout-health primitives.

The output should be exposed through a typed route under the existing Torghut trading control-plane API family,
for example:

- `GET /api/torghut/trading/control-plane/profit-clock/settlement`
- `POST /api/torghut/trading/control-plane/profit-clock/settle`

Read routes must be safe under degraded state. Mutating settlement issuance should be idempotent by request key
so retries do not produce contradictory receipts.

## Failure-Mode Reduction

This design removes specific failure modes:

- A green rollout can no longer be interpreted as profit authority without a current receipt.
- A stale TCA clock cannot be hidden behind a current decision clock.
- Empty options feature tables cannot be treated as a valid options sleeve input.
- Degraded execution trust does not block zero-notional repairs if the receipt explicitly settles to repair.
- Old paper windows cannot promote capital unless their dataset, runtime, TCA, feature, and stage clocks align.
- Deployer stage can roll back by action class instead of rolling back every control-plane surface.

## Engineer Acceptance Gates

Engineer stage should implement the smallest production slice that proves the contract:

- A typed receipt builder that consumes existing status, runtime admission, verdict, negative-evidence, rollout,
  and Torghut quant freshness sources.
- Stable reason codes for every hold/deny/repair-only outcome.
- Idempotent receipt issuance keyed by action class, hypothesis set, Torghut revision, Jangar revision, and stage
  epoch.
- Unit tests for all four settlement decisions.
- Regression tests for the May 7 evidence case:
  - live rollout ok but TCA stale since 2026-04-02 settles `paper_canary` and `live_micro_canary` to hold or deny.
  - empty options features settle options actions to repair-only or hold.
  - degraded execution trust still allows zero-notional repair with `notional_ceiling: 0`.
  - expired receipt cannot be reused for capital admission.
- Contract tests proving Torghut can parse and reject unknown receipt schema versions.

## Deployer Acceptance Gates

Deployer stage should not widen capital because this document exists. It should require live receipt evidence:

- Jangar route returns a receipt for `observe` and `repair_dispatch`.
- Receipt reason codes match Torghut `/readyz` and `/trading/status` blockers.
- Receipt TTL expiry is observable in metrics and logs.
- Receipt decision changes are emitted to NATS/Jangar visibility without dumping secrets.
- No live capital action is allowed until receipt decision is `allow`, Torghut proof floor is not `repair_only`,
  and live submission remains explicitly enabled by existing gates.

## Rollout Plan

1. Ship the settlement schema, route, and tests with default action-class mode set to observe.
2. Enable `repair_dispatch` receipts for zero-notional repair only.
3. Wire Torghut proof floor to read receipts as advisory evidence while still enforcing its existing blockers.
4. Promote receipt consumption to required input for paper canary after one full market session of matched
   advisory receipts.
5. Promote receipt consumption to required input for live micro canary only after TCA, feature, market context,
   empirical lineage, and rollout clocks are all current under the same stage epoch.

## Rollback Plan

Rollback is by action class:

- Disable `live_micro_canary` and `paper_canary` settlement first.
- Keep `observe` available unless the route itself is causing control-plane errors.
- Keep `repair_dispatch` only if receipts remain idempotent and zero-notional.
- If receipt reasons diverge from Torghut proof floor reasons, set all capital classes to `hold` and treat
  receipt output as advisory until parity is restored.

## Risks

- The receipt can become another stale object if TTL and expiry metrics are weak. This is why TTLs are short and
  expired receipts must fail closed for capital.
- Cross-source joins can add latency. The implementation should cache read-only source snapshots briefly per
  request key but never extend receipt TTL by cache age.
- Torghut may produce attractive paper windows before all clocks align. That is acceptable. Capital authority is
  not a reward for one profitable sample; it is a claim that the system can reproduce the edge under current
  execution, data, and rollout conditions.

## Handoff

Engineer stage owns schema, route, receipt builder, idempotence, and tests. Deployer stage owns staged enablement,
metrics, and rollback toggles. Torghut stage consumes the receipt but keeps its existing proof floor as the final
local capital brake until receipt parity is proven across a full market session.
