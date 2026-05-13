# 186. Jangar Repair-Bid Admission And Settlement Custody (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, Torghut repair-bid settlement consumption, zero-notional dispatch custody,
duplicate-run suppression, rollout proof, merge/deploy readiness, validation, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`

Extends:

- `185-jangar-clock-settled-repair-dispatch-and-rollout-custody-2026-05-12.md`
- `184-jangar-rollout-evidence-escrow-and-proof-repair-admission-2026-05-12.md`
- `../torghut/design-system/v6/188-torghut-route-evidence-clearinghouse-and-execution-freshness-market-2026-05-12.md`

## Decision

I am selecting **repair-bid admission with settlement custody** as the next Jangar control-plane architecture step.

Jangar is serving, but serving is not the same as trustworthy Torghut dispatch. `GET /ready` returned HTTP 200 and
leader election was healthy, while `execution_trust.status=degraded` because Jangar and Torghut implement stages were
stale. Torghut remained `Synced/Degraded`, `/readyz` returned HTTP 503, and `/trading/revenue-repair` reported a
route evidence clearinghouse packet with `55` selected repair bids, `routeable_candidate_count=0`, and
`zero_notional_or_stale_evidence_rate=1.0`.

That is enough information to block normal work, but not enough information to launch the right repair work. If Jangar
dispatches directly from raw Torghut reason codes, it can overproduce AgentRuns, duplicate repairs already in flight,
or treat a generic `degraded` reason as a concrete launch target. Jangar should launch only compacted zero-notional
lots that Torghut has settled into a value gate, output receipt, dedupe key, TTL, and rollback target.

The decision is to make `repair_bid_settlement_ledger` the Jangar launch contract for Torghut repair work. Jangar will
continue read-only serving under degraded execution trust, hold normal dispatch and deploy widening, and allow bounded
repair dispatch only when a Torghut compacted lot is current, zero-notional, not already active, and tied to a required
output receipt.

The tradeoff is lower run volume. I accept that because the system is currently bottlenecked on evidence quality and
dispatch trust, not scheduler capacity.

## Read-Only Evidence Snapshot

All assessment commands were read-only. I did not mutate Kubernetes resources, database rows, GitOps resources,
broker state, trading flags, or AgentRun objects.

### Cluster And Runtime

- Runtime Kubernetes reads used `system:serviceaccount:agents:agents-sa`.
- Argo reported `torghut` `Synced/Degraded`, while `torghut-options` was `Synced/Healthy`.
- Torghut core pods were running, but recent events still showed rollout probe failures and ClickHouse PDB conflicts.
- Jangar `/ready` returned `status=ok`; leader election was healthy.
- Jangar `execution_trust.status=degraded` because `jangar-control-plane:implement` and `torghut-quant:implement`
  were stale.
- Jangar memory provider was configured against the self-hosted embedding endpoint, but the repo memory helper returned
  HTTP 500 on retrieve attempts from this workspace.
- Torghut `/trading/revenue-repair` produced a route evidence clearinghouse packet with `55` selected repair bids,
  zero routeable candidates, and `repair_only` capital.

### Source

- Jangar already has serving readiness, execution-trust, admission-passport, runtime-kit, and projection watermark
  surfaces in `/ready`.
- The dispatch gap is not a missing status page. It is the absence of an admission rule that requires compacted Torghut
  lot ids before launching Torghut quant repair runs.
- Jangar should not re-score Torghut routeability or capital. It should validate the Torghut settlement ledger,
  suppress duplicate dedupe keys, and emit launch receipts.

### Data And Dispatch

- Torghut database proof shows why launch custody matters: current trade decisions exist, but executions stopped on
  `2026-04-02`, TCA stopped on `2026-05-08`, promotions have `allowed_rows=0`, research/evidence receipt tables are
  empty, and empirical jobs are stale.
- ClickHouse guardrail metrics show fresh TA data at `2026-05-12 18:48:40 UTC`, so a data surface can be current while
  routeability remains blocked.
- The current repair set includes quant pipeline, TCA, rollout image, empirical, promotion, feature, drift, schema,
  and generic degraded reasons. Those are not independent launch units.

## Problem

Jangar owns launch custody, but Torghut owns routeability and capital truth. The control plane needs a narrow contract
between those responsibilities.

The current failure modes are specific:

1. A raw Torghut repair bid can be dispatched even when a compacted lot would show another run already owns the dedupe
   key.
2. A generic reason code can become a repair run without a value gate or output receipt.
3. Green Jangar serving health can hide stale implement-stage trust.
4. Deployer and verifier can see a PR merge or image promotion while Torghut settlement remains `repair_only`.
5. Normal dispatch can resume too early if it checks the raw clearinghouse packet but not the settlement ledger.
6. AgentRuns can increase evidence volume without reducing `zero_notional_or_stale_evidence_rate`.

## Alternatives Considered

### Option A: Dispatch From Raw Clearinghouse Bids

Jangar would accept every Torghut raw bid as a dispatchable repair target.

Advantages:

- Simple bridge from current runtime output to scheduler input.
- Preserves all Torghut reason codes.
- Requires little new reducer logic in Jangar.

Disadvantages:

- Encourages duplicate runs.
- Forces Jangar to infer root causes from Torghut reason vocabulary.
- Makes run volume a false proxy for evidence repair.

Decision: reject. Raw bids are audit evidence, not launch authority.

### Option B: Block All Torghut Dispatch Until Execution Trust Is Green

Jangar would serve read-only status and launch no Torghut repair work while execution trust is degraded.

Advantages:

- Strong safety posture.
- Easy to enforce.
- Prevents accidental normal dispatch.

Disadvantages:

- Blocks the zero-notional repairs needed to make execution trust useful to Torghut.
- Pushes the system back to manual triage.
- Does not retire stale implement-stage debt.

Decision: reject as the normal posture. Keep it as an emergency fallback if settlement ledgers are malformed.

### Option C: Admit Only Settled Torghut Repair Lots

Jangar consumes Torghut `repair_bid_settlement_ledger` and launches only current compacted lots with zero notional,
dedupe keys, TTLs, output receipts, and validation commands.

Advantages:

- Preserves Torghut as capital authority.
- Gives Jangar a clear launch contract.
- Reduces duplicate repairs and uncited normal dispatch.
- Maps every launch to the swarm value gates.
- Lets deployer and verifier distinguish serving health from dispatch readiness.

Disadvantages:

- Requires Jangar scheduler and deploy surfaces to understand settlement ledger freshness.
- Adds one admission receipt.
- Will hold some superficially useful repair work until Torghut compacts it.

Decision: select Option C.

## Architecture

Jangar publishes `repair_bid_admission_receipt`:

```text
repair_bid_admission_receipt
  schema_version = jangar.repair-bid-admission-receipt.v1
  receipt_id
  generated_at
  fresh_until
  repository
  branch
  swarm_name
  stage
  action_class                  # serve_readonly | dispatch_repair | dispatch_normal | deploy_widen | merge_ready | paper_support | live_support
  decision                      # allow | repair_only | hold | block
  torghut_settlement_ledger_ref
  torghut_compacted_lot_refs[]
  active_dedupe_keys[]
  admitted_lot_ids[]
  held_lot_ids[]
  denied_reason_codes[]
  max_parallelism
  max_runtime_seconds
  max_notional = 0
  validation_commands[]
  rollback_gate
```

Jangar also emits a per-run `repair_lot_dispatch_ticket`:

```text
repair_lot_dispatch_ticket
  ticket_id
  admission_receipt_id
  torghut_lot_id
  lot_class
  target_value_gate
  dedupe_key
  required_output_receipt
  launch_allowed
  launch_reason
  stop_conditions[]
  max_runtime_seconds
  max_notional = 0
  expected_gate_delta
  rollback_target
```

Decision rules:

- `serve_readonly` can remain allowed when Jangar is healthy.
- `dispatch_repair` is allowed only for current Torghut compacted lots with `max_notional=0`, one output receipt, a
  target value gate, and a dedupe key that is not active.
- `dispatch_normal`, `deploy_widen`, `paper_support`, and `live_support` are held while Torghut settlement is
  `repair_only`, stale, missing, malformed, or unresolved.
- `merge_ready` may cite green CI but cannot claim operational readiness without a current Torghut settlement ledger
  and Jangar admission receipt.
- A raw clearinghouse reason code is never enough to launch an AgentRun.

## Implementation Scope

Engineer milestone 1:

- Add a pure Jangar reducer for `repair_bid_admission_receipt`.
- Consume the compact Torghut settlement summary, selected lot ids, dedupe keys, output receipt names, and freshness
  bounds.
- Expose per-action-class decisions in the control-plane status surface.
- Add tests proving read-only serving remains allowed while normal dispatch, deploy widening, paper support, and live
  support are held on unsettled Torghut repair lots.

### Implementation Note (2026-05-13)

Engineer milestone 1 is implemented in shadow/observe mode. Jangar now parses Torghut
`repair_bid_settlement_ledger` from `/trading/consumer-evidence`, builds `repair_bid_admission_receipt` rows for each
action class, and emits `repair_lot_dispatch_ticket` records only for current compacted lots that are zero-notional,
deduped, and tied to exactly one required output receipt.

The first implementation is deliberately capital-safe: `serve_readonly` and `torghut_observe` can remain allowed,
`dispatch_repair` is allowed only when at least one admitted compacted lot exists, and `dispatch_normal`,
`deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` stay held or blocked while Torghut
settlement is stale, missing, malformed, repair-only, or contains unsettled lots. The new admission state is exposed in
Jangar `/ready` and the control-plane status payload so deployer and verifier runs can cite the same custody surface.

Engineer milestone 2:

- Wire Torghut quant repair schedule generation to require `repair_lot_dispatch_ticket`.
- Reject raw-bid dispatch without a compacted lot id.
- Add active dedupe-key tracking so retries cannot duplicate a current repair lot.
- Add deployer validation output that ties Argo, runtime kit, Torghut `/readyz`, settlement ledger, and dispatch ticket
  refs together.

## Validation Gates

Local validation for Jangar PRs:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-negative-evidence-router.test.ts`
- `bun run --cwd services/jangar test -- src/routes/ready.test.ts`
- `bunx oxfmt --check services/jangar/src docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`

Deploy validation:

- Jangar `/ready` exposes repair-bid admission state.
- Torghut `/trading/revenue-repair` exposes `repair_bid_settlement_ledger`.
- An uncited Torghut repair schedule is denied.
- A duplicate dedupe key is held while a current lot is active.
- `dispatch_repair=allow` applies only to zero-notional compacted lots.
- `dispatch_normal`, `deploy_widen`, `paper_support`, and `live_support` remain held until Torghut routeability and
  capital settlement allow them.

## Rollout And Rollback

Roll out in shadow mode first:

- Emit admission receipts without denying existing schedules.
- Compare predicted denials against actual Torghut repair launches for one market session.
- Enable deny mode for raw-bid dispatch only after shadow evidence shows duplicate or uncited launches.
- Keep zero-notional compacted repair available.

Rollback:

- Disable repair-bid admission enforcement.
- Keep Jangar serving and Torghut capital at `max_notional=0`.
- Fall back to existing material-action verdicts and Torghut route evidence clearinghouse summaries.
- If settlement ledgers are stale or malformed, block normal dispatch and allow only read-only serving until the prior
  stable Jangar revision is restored.

## Risks

- Scheduler adoption can lag reducer emission; keep shadow mode until uncited schedules are visible.
- Dedupe-key expiry can be too strict or too loose. TTL must be explicit and observable.
- The Jangar receipt must not become a second capital authority. It only admits launches; Torghut owns notional.
- Memory helper retrieval failed during assessment, so handoff must record memory-service connectivity as an audit
  gap even though Jangar `/ready` reports the provider configured.

## Handoff

The next Jangar implementation improves `capital_gate_safety` and `zero_notional_or_stale_evidence_rate` by preventing
raw, duplicate, or uncited Torghut repair dispatch. The first measurable revenue-adjacent effect is fewer stale repair
runs and a smaller, receipt-backed path to `routeable_candidate_count > 0`. The smallest blocker preventing revenue
impact is unsettled repair authority: Torghut has enough negative evidence to choose repair work, but Jangar needs a
compacted lot contract before dispatch can improve routeability instead of adding noise.
