# 179. Jangar Session Evidence Auction And Route Canary Notary (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture Lead
Scope: Jangar control-plane reliability, Torghut quant repair dispatch, source-to-serving evidence custody, safer
rollouts, NATS/Jangar visibility, and capital-action admission.

Companion Torghut contract:

- `docs/torghut/design-system/v6/183-torghut-session-open-route-microcanaries-and-profit-evidence-notary-2026-05-08.md`

Extends:

- `178-jangar-source-serving-parity-escrow-and-route-independent-launch-passports-2026-05-08.md`
- `177-jangar-evidence-quality-admission-ledger-and-degradation-backpressure-2026-05-08.md`
- `172-jangar-evidence-reconciliation-broker-and-capital-action-firewall-2026-05-08.md`
- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`

## Decision

I am selecting **a session evidence auction with a route canary notary** as the next Jangar control-plane architecture
step for Torghut quant.

The cluster is no longer in the hard-brownout state captured by earlier swarm messages. At 2026-05-08T08:11Z, Argo CD
reported `jangar`, `agents`, `agents-ci`, `symphony-jangar`, `torghut`, `torghut-options`, and `symphony-torghut` as
`Synced` and `Healthy`. Jangar `/ready` reported `execution_trust.status=healthy`, the collaboration runtime kit
included `/usr/local/bin/codex-nats-publish` and `/usr/local/bin/codex-nats-soak`, and active Jangar and agents
deployments were available on the promoted `03eea88e` image digests.

The remaining risk is more subtle and more expensive: Jangar can launch work while the proof economy is not selecting
the highest-value repair. The agents namespace still showed recent readiness-probe timeouts on `agents` and
`agents-controllers`, scheduled Torghut/Jangar runs had failed attempts before later success, and current AgentRuns for
the two swarms summarized as `Succeeded=410`, `Failed=10`, and `Running=5`. Torghut itself is serving, but it is
capital-safe rather than revenue-active: live readiness is degraded, the proof floor is `repair_only`, and live notional
is zero.

The selected design makes Jangar treat each market session as an auction for scarce launch capacity. Before Jangar
dispatches Torghut implementation, verification, or rollout widening work, it must notarize a session evidence epoch
that prices each candidate repair by expected value-gate movement, runtime trust, route-canary status, and rollback
cost. Work that does not improve `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`,
`fill_tca_or_slippage_quality`, `capital_gate_safety`, or eventually `post_cost_daily_net_pnl` should not consume the
next high-trust execution slot.

The tradeoff is that this adds an admission layer before useful work starts. I accept that cost because the current
failure mode is not lack of activity. It is activity that can be green at the pod/CI level while leaving Torghut with
zero notional, stale scoped proof, and unranked route repairs.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, trading flags, or GitOps
manifests.

### Control Plane And Runtime Evidence

- Branch `codex/swarm-torghut-quant-discover` started clean at `origin/main`
  `d63fb1c866c3c1bbe79ff647eaa4727818f36222`.
- Jangar `/health` returned `status=ok`.
- Jangar `/ready` returned `status=ok`, `execution_trust.status=healthy`, a healthy self-hosted memory provider, and a
  healthy collaboration runtime kit containing the NATS publish and soak binaries.
- Argo CD reported the Jangar, agents, and Torghut-facing apps as `Synced` and `Healthy`.
- Active deployments were available:
  - `deployment/jangar`: `1/1`, image `jangar:03eea88e@sha256:30c7b317...`
  - `deployment/agents`: `1/1`, image `jangar-control-plane:03eea88e@sha256:94aaf528...`
  - `deployment/agents-controllers`: `2/2`, image `jangar:03eea88e@sha256:30c7b317...`
- Recent agents events still included readiness-probe timeouts for `agents` and both `agents-controllers` replicas.
- AgentRun inventory for Torghut quant and Jangar control-plane prefixes returned `Succeeded=410`, `Failed=10`,
  `Running=5`.
- NATS context had the prior shared state: earlier May 5 evidence saw degraded execution trust and unavailable workflow
  runtimes; current readiness confirms that specific hard blocker has cleared.

### Torghut Evidence Jangar Must Price

- Torghut live active revision was `torghut-00302`, runtime build commit `809276e6db88bf4546f3fc6c75bd16c54815fb1d`,
  on digest `sha256:056d6b0bc237adec3e3aa5e89a3f08ee81523ec18d8374c4a4e7d072e436f0f3`.
- Live `/readyz` returned degraded because the live submission gate was closed by `simple_submit_disabled` and proof
  floor remained `repair_only`.
- Live `/trading/status` reported `capital_state=zero_notional`, `max_notional=0`, three hypotheses, zero
  promotion-eligible hypotheses, and two rollback-required hypotheses.
- Live execution TCA reported 7,334 orders, 7,245 filled executions, average absolute slippage about 13.82 bps versus
  an 8 bps guardrail, one probing route (`AAPL`), four blocked routes (`AMD`, `AVGO`, `INTC`, `NVDA`), and three
  missing routes (`AMZN`, `GOOGL`, `ORCL`).
- Jangar unscoped quant health was fresh, but Torghut's scoped live proof floor still carried
  `quant_pipeline_degraded` with a large stage lag. Sim had `quant_latest_metrics_empty` and an empty route universe.
- Torghut `/db-check` reported the schema current at head `0029_whitepaper_embedding_dimension_4096`; direct CNPG exec,
  secret listing, and ClickHouse unauthenticated queries were unavailable to this observer identity.

## Problem

Jangar has regained enough execution health to run work, but it does not yet price work by the exact proof gap that
blocks Torghut revenue.

The current system can say:

- Jangar is ready.
- Torghut is serving.
- CI can be green.
- Argo can be synced.
- Torghut capital is still zero-notional.

That is safe but incomplete. A control plane that only sees readiness and PR status can spend its next run on work that
does not reduce the smallest revenue blocker. A control plane that only sees Torghut proof floor can overreact to
expected after-hours staleness or retry noise. Jangar needs a session-level broker that can compare the cost and value
of repair work before it launches agents, widens rollout rings, or asks deployers to promote.

The present failure modes are:

1. Retry-success ambiguity: scheduled AgentRuns can succeed after failed attempts, leaving reliability debt invisible
   to downstream admission.
2. Route-proof ambiguity: Torghut can have internal route repair books while scoped Jangar/Torghut quant proof remains
   degraded.
3. Dispatch-value ambiguity: fresh launch capacity can be spent on low-value docs or broad refactors when the next
   value gate requires scoped quant/TCA repair.
4. Capital-boundary ambiguity: a healthy Jangar runtime must not imply paper or live Torghut capital can move.
5. Data-access ambiguity: direct DB shells may be unavailable, so the control plane must distinguish application
   receipt evidence from missing observer credentials.

## Alternatives Considered

### Option A: Keep Jangar Dispatch Based On Runtime Readiness And PR Checks

This preserves current behavior: if Jangar is healthy, NATS works, and CI is green, continue launching work normally.

Advantages:

- Lowest implementation cost.
- Keeps throughput high.
- Avoids a new admission ledger.

Disadvantages:

- Does not reduce the current Torghut revenue blocker.
- Treats pod readiness and profit evidence as equivalent readiness.
- Does not record retry-success debt before assigning more work.

Decision: reject. This is acceptable for generic repository tasks, but not for Torghut capital work.

### Option B: Freeze All Torghut Work Until Proof Floor Passes

Jangar could refuse all Torghut implement and verify runs until live proof floor leaves `repair_only`.

Advantages:

- Simple capital safety.
- Prevents the control plane from creating noisy work.
- Easy to enforce.

Disadvantages:

- Blocks zero-notional repair work that is exactly how the proof floor gets repaired.
- Does not rank which missing receipt should be fixed first.
- Makes Jangar less useful when the system is safe but revenue-inactive.

Decision: reject as the broad policy. Use it only for paper/live capital admission, not for observe-mode repair.

### Option C: Session Evidence Auction With Route Canary Notary

Jangar creates a session evidence epoch before material Torghut work. The epoch collects runtime trust, recent run
settlement, Torghut proof-floor receipts, scoped quant health, route/TCA state, consumer-evidence canary status, and
rollback constraints. It then admits only bounded work whose expected effect maps to the configured value gates.

Advantages:

- Makes scarce execution slots compete on business value.
- Separates live/paper capital admission from zero-notional repair admission.
- Converts retry noise into an explicit dispatch budget.
- Lets Jangar keep serving while refusing unsafe rollout widening.

Disadvantages:

- Adds a new admission receipt and notary surface.
- Requires careful UX so operators see why a run was admitted, delayed, or rejected.
- Requires implementation in both Jangar and Torghut contracts.

Decision: select Option C.

## Architecture

Jangar owns a `session_evidence_auction_epoch` record:

```text
session_evidence_auction_epoch
  epoch_id
  generated_at
  fresh_until
  market_session
  jangar_ready_state
  execution_trust_state
  collaboration_runtime_kit_state
  recent_run_settlement
  torghut_revision
  torghut_consumer_evidence_state
  torghut_proof_floor_state
  scoped_quant_health_state
  route_tca_state
  alpha_readiness_state
  capital_gate_state
  dispatch_budget
  admitted_repair_bids[]
  rejected_bids[]
  rollback_target
```

Each `admitted_repair_bid` carries:

```text
repair_bid
  bid_id
  value_gate
  expected_gate_delta
  target_symbol
  target_account
  target_window
  required_receipts
  expected_runtime_cost
  max_notional
  admission_decision
  reason_codes
```

Rules:

- If Jangar `/ready` is not healthy, only control-plane recovery work is admitted.
- If collaboration runtime kits are missing NATS, no cross-swarm handoff is marked complete.
- If recent run settlement shows failed attempts above the session budget, Jangar admits repair work only when it has a
  bounded owner, bounded files, and a value-gate mapping.
- If Torghut proof floor is `repair_only`, live and paper capital actions are rejected, but zero-notional route/quant
  repair can be admitted.
- If scoped quant health is degraded while unscoped quant health is fresh, the admitted work must target account/window
  receipt repair rather than generic quant status.
- If route/TCA is above slippage guardrail, threshold loosening is rejected unless a separate risk waiver names the
  expected slippage cost and keeps notional at zero.

## Failure-Mode Reduction

This design reduces specific current failure modes:

- Readiness probe noise no longer disappears after a later success; it consumes dispatch budget until the epoch records
  a healthy settlement window.
- A healthy Jangar runtime no longer widens Torghut action authority by implication; the epoch must include Torghut
  capital state.
- Stale or empty scoped quant evidence is no longer hidden by fresh unscoped quant metrics.
- Direct database access failures are classified as observer-access limitations when application receipts are current,
  not as proof-floor pass evidence.
- Route repairs are selected by expected gate delta instead of newest failure.

## Validation Gates

Engineer validation must prove:

- `session_evidence_auction_epoch` can be built from Jangar `/ready`, AgentRun settlement, Torghut consumer evidence,
  quant health, proof floor, and route/TCA payloads.
- Admission rejects live/paper capital work when Torghut capital state is `zero_notional`.
- Admission allows zero-notional scoped quant and route/TCA repair bids when they map to value gates.
- Recent failed attempts affect dispatch budget without blocking already-running critical recovery work.
- Unit tests cover healthy runtime, retry-debt, missing NATS, degraded scoped quant, route slippage breach, and direct DB
  observer-access limitation.

Deployer validation must prove:

- The Jangar readiness surface still reports `execution_trust=healthy` only when runtime prerequisites are present.
- NATS progress/handoff messages remain visible in Jangar.
- Torghut live notional remains zero until Torghut proof floor and capital gates pass.
- Rollout widening cannot be authorized from unscoped quant health alone.

Value gates:

- `routeable_candidate_count`: admitted bids must declare which symbol/account/window can move from missing or blocked
  to probing or routeable.
- `zero_notional_or_stale_evidence_rate`: epoch must count stale scoped quant, consumer-evidence, route/TCA, and alpha
  receipt states.
- `fill_tca_or_slippage_quality`: route bids must include current and target slippage guardrail evidence.
- `capital_gate_safety`: max notional remains `0` for repair-only epochs.
- `post_cost_daily_net_pnl`: no positive PnL claim is allowed until a paper or live receipt ties route proof to
  post-cost realized or simulated PnL.

## Rollout

1. Implement observe-only epoch materialization in Jangar.
2. Add tests and an API view that returns the latest epoch without changing AgentRun scheduling.
3. Wire admission decisions into Torghut-specific swarm dispatch as warnings.
4. Promote to blocking mode for paper/live capital and rollout widening.
5. Promote to repair-dispatch priority only after two sessions show correct bid ranking and no lost critical work.

The first implementation milestone should not mutate Torghut trading flags or Kubernetes resources. It should emit
receipts and tests only.

## Rollback

Rollback is a normal PR revert of the Jangar admission code or feature-flag disablement of blocking mode.

Rollback triggers:

- Jangar refuses control-plane recovery work because Torghut proof is degraded.
- The epoch marks live/paper capital admissible while Torghut proof floor is `repair_only`.
- NATS progress messages stop appearing in Jangar.
- Dispatch latency rises enough to miss the next market-session repair window.

Rollback target:

- Jangar returns to observe-only epoch generation.
- Torghut capital remains governed by existing proof floor and submission gates.
- No direct Kubernetes or database mutation is used to unwind the change.

## Risks

- The auction can become another dashboard if not tied to admission and handoff contracts.
- Expected gate deltas can be wrong until enough repair outcomes are observed.
- Over-weighting retry debt can starve useful work during noisy infrastructure windows.
- Under-weighting slippage repair can create attractive-looking route counts that do not improve post-cost profit.

Mitigations:

- Start observe-only and compare predicted versus actual gate movement.
- Require every admitted bid to name one value gate and rollback target.
- Keep capital gates independent from dispatch gates.
- Add a human-readable reason trail for admitted and rejected bids.

## Handoff Contract

Engineer stage:

1. Add a Jangar epoch builder under the control-plane server layer.
2. Read Torghut proof and quant surfaces through existing typed clients.
3. Include recent AgentRun settlement and readiness-probe debt in dispatch budget.
4. Add tests for the failure modes listed above.
5. Keep the first PR observe-only.

Deployer stage:

1. Verify Jangar, agents, Torghut, Torghut options, and Symphony apps are synced and healthy after rollout.
2. Verify the epoch reports current Torghut revision, proof-floor state, route/TCA state, and capital state.
3. Verify NATS progress and handoff updates remain visible.
4. Confirm no paper/live Torghut capital action is admitted while proof floor is `repair_only`.
