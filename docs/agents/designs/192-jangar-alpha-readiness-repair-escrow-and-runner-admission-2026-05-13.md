# 192. Jangar Alpha Readiness Repair Escrow And Runner Admission (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar admission for Torghut alpha-readiness repair, runner capacity custody, zero-notional dispatch, outcome
settlement, rollout safety, validation, rollback, and Torghut handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/197-torghut-alpha-readiness-strike-ledger-and-routeable-candidate-ladder-2026-05-13.md`

Extends:

- `191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md`
- `189-jangar-terminal-debt-compaction-and-repair-outcome-escrow-2026-05-13.md`
- `188-jangar-typed-torghut-evidence-admission-and-repair-dispatch-2026-05-13.md`
- `186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`
- `164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md`

## Decision

I am selecting **alpha-readiness repair escrow** as the Jangar control-plane companion to Torghut's strike ledger.

The current live state is not a control-plane outage. Jangar is serving, the agents deployment is available, agents
controllers are `2/2` ready, and Argo reports Jangar healthy. The failure mode is subtler: runner capacity can be used
by lower-leverage repair lots while Torghut's business evidence says the top revenue blocker is
`hypothesis_not_promotion_eligible`. That is a control-plane reliability problem because Jangar can appear healthy
while starving the work that would improve `routeable_candidate_count`.

Jangar should admit one bounded promotion-custody repair when Torghut proves all of these facts:

- `/trading/revenue-repair` ranks `routeable_candidate_count` first;
- the `promotion_custody` lot exists and is held only by repair-slot economics;
- no active dedupe key already owns the account/window;
- Torghut carries `max_notional=0`, `capital_state=zero_notional`, and `simple_submit_disabled`;
- the required output receipt is `torghut.promotion-custody-decision-receipt.v1`.

The tradeoff is deliberate queue bias. Jangar will sometimes run a promotion-custody repair before a higher static
priority freshness lot. That is acceptable only because the revenue repair digest becomes the governing evidence
surface for this lane, the lane is zero-notional, and the result must settle as a typed receipt.

## Governing Runtime Requirements

This contract follows the swarm validation contract:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Jangar value-gate mapping:

- `routeable_candidate_count`: reserve one runner slot for the alpha-readiness strike when Torghut ranks this gate
  first.
- `zero_notional_or_stale_evidence_rate`: reject stale strike ledgers and require after-receipt freshness.
- `fill_tca_or_slippage_quality`: do not admit candidate advancement if Torghut says the target route TCA is blocked.
- `post_cost_daily_net_pnl`: require promotion custody to bind or deny post-cost proof.
- `capital_gate_safety`: refuse any strike packet with nonzero notional, paper/live enablement, or missing rollback
  target.

## Current Evidence

Evidence was collected read-only on 2026-05-13 around 20:10 UTC.

- Argo reported Jangar `Synced/Healthy` at revision `6f1aa11d5a128d7cb6e42aa4aeb67660a380d57e`.
- The Jangar deployment was available and running image `registry.ide-newton.ts.net/lab/jangar:42e2cafa`.
- The agents deployment was available and agents controllers were `2/2` ready on the same Jangar image family.
- The agents namespace remained noisy, with recent completed, error, and OOM-killed AgentRun pods across discover,
  implement, plan, and verify lanes. That noise is exactly why admission needs a bounded lane with dedupe and terminal
  receipts.
- Torghut was healthy at the deployment layer, but `/readyz` correctly returned HTTP 503 because live submission and
  proof-floor gates were still blocked.
- `/trading/revenue-repair` showed `business_state=repair_only`, `revenue_ready=false`, `routeable_candidate_count=0`,
  and top queue `repair_alpha_readiness`.
- The compacted Torghut repair ledger exposed a held `promotion_custody` lot with expected delta
  `retire_hypothesis_not_promotion_eligible`, target value gate `routeable_candidate_count`, and hold reason
  `selection_limit_exceeded`.

## Problem

Jangar already has typed Torghut evidence admission and repair-bid settlement, but it does not yet have a reliability
rule that says "the top revenue queue item must receive bounded runner capacity."

The concrete failure modes are:

1. Jangar can be healthy while dispatching repair work that does not touch the top business blocker.
2. Torghut can publish a `promotion_custody` lot, but static lot ordering can hold it behind less direct work.
3. Repeated failed or no-delta AgentRuns can consume capacity without a terminal promotion-custody settlement record.
4. Deployers can see a green control plane and a red revenue surface without knowing which system owns the next action.
5. A human may bypass `simple_submit_disabled` to force progress if the repair lane does not show an executable path.

This contract turns that into a small control-plane rule: one zero-notional strike, one dedupe key, one outcome receipt,
then release, roll forward, or burn credit.

## Alternatives Considered

### Option A: Leave Admission To Static Repair-Bid Priority

Jangar keeps consuming the existing selected and dispatchable repair lots exactly as ordered by Torghut's compacted
repair-bid settlement ledger.

Advantages:

- No new admission contract.
- Preserves current runner scheduling behavior.
- Minimizes immediate code changes.

Disadvantages:

- Does not respect the revenue repair queue when it conflicts with static lot priority.
- Keeps `promotion_custody` held when dispatch limits are full.
- Does not reduce the `routeable_candidate_count=0` failure mode.

Decision: reject. It is operationally simple but economically misaligned.

### Option B: Create A Dedicated Always-On Promotion Lane

Jangar reserves a permanent runner lane for promotion-custody work.

Advantages:

- Guarantees promotion work cannot be starved.
- Easy to reason about in scheduler metrics.
- Makes alpha-readiness work visible.

Disadvantages:

- Wastes capacity when alpha readiness is not the top blocker.
- Can overfit the control plane to one current failure mode.
- Risks bypassing better revenue work when TCA, source lineage, or rollout proof is actually higher leverage.

Decision: reject. The lane should be revenue-triggered, not always on.

### Option C: Revenue-Triggered Repair Escrow

Jangar admits exactly one promotion-custody strike when Torghut's revenue repair digest proves the top value gate is
`routeable_candidate_count` and the strike packet is capital-safe.

Advantages:

- Aligns runner capacity with the live business blocker.
- Preserves capital safety.
- Works with existing typed evidence and repair-bid settlement contracts.
- Makes success and failure terminal through a required receipt.
- Keeps the lane idle when another value gate is truly first.

Disadvantages:

- Requires Jangar to consume one more field from Torghut.
- Adds a preemption rule that must be tested carefully.
- Can delay generic evidence refresh when alpha readiness remains unresolved.

Decision: select Option C.

## Admission Contract

Jangar consumes `alpha_readiness_strike_ledger` from Torghut.

```text
alpha_readiness_strike_ledger
  schema_version = torghut.alpha-readiness-strike-ledger.v1
  generated_at
  fresh_until
  account_id
  window
  max_notional = 0
  selected_business_blocker.value_gate = routeable_candidate_count
  promotion_custody_lot_ref
  strike_slots[]
  required_after_receipts[]
  guarded_action_classes[]
  rollback_target
```

Admission is `allow_zero_notional_repair` only when:

1. the ledger is fresh;
2. the top business blocker is `routeable_candidate_count`;
3. the strike slot lot class is `promotion_custody`;
4. the strike slot required output is `torghut.promotion-custody-decision-receipt.v1`;
5. `max_notional` equals `0` at ledger, slot, and candidate levels;
6. guarded action classes include `paper_canary`, `live_micro_canary`, and `live_scale`;
7. no active dedupe key already exists;
8. Torghut's rollback target keeps `capital_state=zero_notional` and `live_submit_enabled=false`.

Every other state is `hold` or `block`. Jangar must not infer paper or live authority from this packet.

## Runner Capacity Rule

When the admission contract passes, Jangar reserves one runner slot:

```text
runner_capacity_reservation
  reservation_id
  account_id
  window
  value_gate = routeable_candidate_count
  lot_class = promotion_custody
  dedupe_key
  max_parallelism = 1
  ttl_seconds <= 900
  max_runtime_seconds <= 1200
  material_action = zero_notional_repair
  notional_authority = none
```

The reservation is lower priority than emergency safety work and higher priority than generic freshness repair while
the top revenue blocker remains alpha readiness.

The reservation ends when:

- a terminal promotion-custody receipt is accepted;
- the strike ledger expires;
- Torghut changes the top revenue blocker;
- a duplicate active run owns the dedupe key;
- capital safety fields drift from zero-notional.

## Outcome Settlement

Every admitted run must return:

```text
torghut.promotion-custody-decision-receipt.v1
  receipt_id
  strike_slot_id
  repair_lot_id
  agentrun_ref
  terminal_state = accepted | denied | no_delta | failed
  retired_reason_codes[]
  preserved_reason_codes[]
  routeable_candidate_count_before
  routeable_candidate_count_after
  zero_notional_or_stale_evidence_rate_before
  zero_notional_or_stale_evidence_rate_after
  post_cost_evidence_ref
  tca_evidence_ref
  market_context_ref
  quant_health_ref
  capital_effect = zero_notional_only
  next_action
```

Jangar settles the run as:

- `release_credit` if `routeable_candidate_count_after > routeable_candidate_count_before` and capital fields remain
  closed;
- `roll_forward` if the receipt preserves reason codes and names a smaller next blocker;
- `burn_credit` if the run returns no delta without a new blocker;
- `hold` if required fields are missing or stale;
- `block` if any notional, paper/live enablement, or rollback drift appears.

## Failure-Mode Reduction

This contract reduces specific control-plane failure modes:

- Starvation: `promotion_custody` cannot remain hidden behind static repair priority when it is the top revenue blocker.
- Duplicate work: the account/window/dedupe key admits at most one active strike.
- No-delta churn: every run must settle as accepted, denied, no-delta, or failed.
- Unsafe rollout: any nonzero notional or live-submit drift blocks admission.
- Ambiguous handoff: Torghut owns the strike ledger and receipts; Jangar owns admission, runner reservation, and
  terminal settlement.

## Implementation Scope

Engineer milestone:

1. Add a Jangar parser for `alpha_readiness_strike_ledger`.
2. Add an admission function that returns `allow_zero_notional_repair`, `hold`, or `block` with reason codes.
3. Add a runner reservation guard keyed by account, window, lot class, and dedupe key.
4. Add outcome settlement handling for `torghut.promotion-custody-decision-receipt.v1`.
5. Add tests:
   - allows one fresh zero-notional promotion-custody strike when revenue repair ranks `routeable_candidate_count`
     first;
   - blocks stale strike ledgers;
   - blocks nonzero notional at any packet level;
   - holds duplicate dedupe keys;
   - releases capacity after terminal receipt;
   - does not admit the lane when Torghut's top value gate changes.

Do not alter broad AgentRun scheduling defaults, live submission flags, or GitOps promotion behavior in this milestone.

## Validation Gates

Local validation:

- `bun test services/jangar/src/server/control-plane-torghut-consumer-evidence.test.ts`
- `bun test services/jangar/src/server/control-plane-torghut-repair-admission.test.ts`
- `bun run --filter jangar lint`
- `bunx oxfmt --check services/jangar/src/server/control-plane-torghut-consumer-evidence.ts services/jangar/src/server/control-plane-torghut-repair-admission.ts`

Post-rollout validation:

- Argo reports Jangar synced and healthy at the promoted image.
- Agents controllers are `2/2` ready.
- Jangar sees Torghut `/trading/consumer-evidence` and `/trading/revenue-repair`.
- A fresh strike ledger creates at most one zero-notional reservation.
- Duplicate dedupe keys hold, not launch.
- The outcome receipt settles the reservation.
- Torghut still reports `live_submission_allowed=false` and `max_notional=0`.

## Rollout

Roll out in three phases:

1. Parse-only: Jangar reads and logs the strike ledger, but does not reserve capacity.
2. Observe reservation: Jangar computes the reservation and exposes the decision, but does not launch a run.
3. Zero-notional launch: Jangar launches one promotion-custody strike per account/window when admission passes.

Promotion from one phase to the next requires:

- no parser errors for one full evidence TTL window;
- no nonzero notional packets;
- no duplicate active reservations;
- Torghut and Jangar Argo apps synced and healthy;
- Torghut `/db-check` schema current;
- Torghut revenue repair still ranking alpha readiness first.

## Rollback

Rollback is to disable strike-ledger consumption and return to existing repair-bid admission.

Required rollback state:

- Jangar stops admitting `promotion_custody` strike reservations.
- Existing active strike runs are allowed to finish only if they are already zero-notional; otherwise they are
  cancelled by the material-action firewall.
- Torghut keeps `capital_state=zero_notional`.
- Torghut keeps `simple_submit_disabled`.
- `paper_canary`, `live_micro_canary`, and `live_scale` remain held.

No database rollback is required for parse-only or observe phases. If launch phase has accepted receipts, retain them as
negative or positive audit evidence; do not delete them.

## Risks

- If Torghut's strike ledger is too broad, Jangar could reserve capacity for a vague promotion task. Mitigation:
  require exact lot id, value gate, dedupe key, and required output receipt.
- If admission ignores TCA, a candidate could advance despite poor execution quality. Mitigation: Torghut's packet must
  carry required TCA after-receipts and Jangar blocks any packet whose guardrails drift.
- If runner capacity is exhausted by other mission lanes, the strike could still wait. Mitigation: the reservation is a
  bounded priority lane while alpha readiness remains the top revenue blocker.
- If operators expect this to enable trading, they may over-read the result. Mitigation: every admission and receipt
  repeats `max_notional=0` and `notional_authority=none`.

## Handoff

Engineer handoff:

- Treat this as an admission and settlement change, not a trading enablement change.
- Start with parse-only and tests.
- Make nonzero notional a hard block.
- Do not launch more than one active promotion-custody strike per account/window/dedupe key.

Implementation note, 2026-05-13:

- The first production implementation adds the read-only Torghut `alpha_readiness_strike_ledger` to
  `/trading/revenue-repair`, mirrors the compact ledger into `/trading/consumer-evidence`, and teaches Jangar repair
  admission to reserve exactly one zero-notional `promotion_custody` dispatch ticket when revenue repair ranks
  `routeable_candidate_count` first.
- This lands in observe/admission accounting only. It does not enable paper or live trading, does not alter GitOps
  promotion behavior, and keeps `paper_canary`, `live_micro_canary`, and `live_scale` guarded by the existing material
  readiness gates.

Deployer handoff:

- Verify Jangar and agents controller readiness before enabling launch.
- Confirm Torghut still reports `simple_submit_disabled`, `capital_state=zero_notional`, and `max_notional=0`.
- Report success as improved `routeable_candidate_count` or a terminal receipt naming the smallest blocker that still
  prevents routeable candidate admission.
