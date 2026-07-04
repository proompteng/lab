# 208. Torghut Jangar Verification Carry Bridge And No-Delta Reentry Market (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut no-delta repair reentry, Jangar verification carry ingestion, routeable-candidate recovery, zero-notional
capital safety, rollout, rollback, validation, and cross-stage handoff.

Companion Jangar contract:

- `docs/agents/designs/202-jangar-verification-carry-export-and-repair-slot-reconciliation-2026-05-14.md`

Extends:

- `206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`
- `207-torghut-quant-plan-closeout-and-alpha-repair-reentry-handoff-2026-05-14.md`
- `docs/agents/designs/201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
- `199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md`
- `docs/agents/designs/194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md`

## Decision

I am selecting a **Jangar verification-carry bridge feeding Torghut's no-delta reentry market** as the next
architecture increment.

The live state has changed since the no-delta auction was designed. The auction now exists and is doing its safety
job. On 2026-05-14 around 16:11Z, `GET /trading/revenue-repair` returned `business_state=repair_only`,
`revenue_ready=false`, top queue item `repair_alpha_readiness`, value gate `routeable_candidate_count`, required
output `torghut.executable-alpha-receipts.v1`, and `max_notional=0`. The alpha closure settlement market was
`pending_no_delta`, the no-delta budget was `consumed`, `routeable_candidate_count` remained `0`, and the no-delta
reentry auction returned `reentry_decision=deny` with `selected_ticket=null`.

That denial is correct, but it exposes the new smallest blocker: Torghut reported
`jangar_verification_carry_unavailable`. At the same time, Jangar already had useful evidence. Its control-plane status
reported `execution_trust=degraded`, source rollout status `block`, open verify-trust foreclosure tickets, a denied
`torghut_no_delta_active` ticket, and repair-slot escrow blocked by
`selected_receipt_source_revenue_repair_ref_mismatch` plus
`material_reentry_receipt_missing_for_selected_executable_alpha`. In plain terms, Jangar can name the failure debt,
but Torghut cannot consume it as a stable release-condition witness.

The selected design makes Jangar export a compact `jangar.verify-trust-foreclosure-carry.v1` packet and makes Torghut
ingest that packet into `status_payload.jangar_verification_carry` before building
`torghut.no-delta-repair-reentry-auction.v1`. The packet is not a permission slip to trade. It is a zero-notional
proof-carry witness that lets the auction distinguish three cases:

1. Jangar carry unavailable or stale: keep denying reentry.
2. Jangar carry current but no release condition changed: keep denying duplicate no-delta repair.
3. Jangar carry current and a named release condition changed: select exactly one zero-notional ticket bound to the
   active alpha-readiness queue item or a named prerequisite to it.

The tradeoff is extra cross-plane plumbing. Torghut will depend on a bounded Jangar evidence packet for one branch of
its repair market. I accept that because the alternative is worse: repeating no-delta repairs or asking operators to
manually reconcile a Jangar foreclosure board with a Torghut auction. The business metric is not raw repair activity.
It is increased routeable post-cost profit evidence and live trading readiness without weakening capital safety.

## Governing Runtime Requirements

This contract implements the active swarm validation contract:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Value-gate mapping:

- `routeable_candidate_count`: primary gate. The bridge only matters when the top queue remains
  `repair_alpha_readiness`; selected tickets must target this gate or a named prerequisite that releases it.
- `zero_notional_or_stale_evidence_rate`: stale or unavailable Jangar carry remains denial evidence.
- `fill_tca_or_slippage_quality`: TCA work can win only when the carry and auction name it as a prerequisite to
  alpha-readiness release.
- `post_cost_daily_net_pnl`: no carry packet can promote paper or live capital without positive, current post-cost
  evidence.
- `capital_gate_safety`: every selected ticket carries `max_notional=0`, live submission remains disabled, and
  `simple_submit_disabled` stays a correct degraded readiness reason.

## Current Evidence

All evidence below was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records,
trading flags, AgentRuns, broker state, market data, or GitOps resources.

### Cluster And Rollout

- Workspace identity was `system:serviceaccount:agents:agents-sa`.
- Argo reported `jangar=Synced/Healthy`, `torghut-options=Synced/Healthy`, `agents=OutOfSync/Healthy`, and
  `torghut=OutOfSync/Healthy`. The out-of-sync apps were in active rollout, not unavailable.
- Torghut active serving deployment was `torghut-00397-deployment=1/1`, with sim
  `torghut-sim-00494-deployment=1/1`.
- Torghut active image digest was `sha256:f90bf4663eb0e7dabaaf30aeec222238beef81028c7ab4781217515a49a24af3`.
- Jangar deployment was `1/1` on image `registry.ide-newton.ts.net/lab/jangar:77e207de` with digest
  `sha256:0eaafd56bf7292502b142fb9ca0dff9f082a8c497539be62e7145f4411f4b41a`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Recent Torghut events showed rollout replacement, database migration startup, transient options-catalog and
  options-enricher readiness probe failures during rollout, one `torghut-ws-options` readiness 503, and a
  `torghut-profit-summary-feedback` workflow failure with exit code `2`.
- Recent Agents events showed discover and verify cron jobs completing, current implementation/verify jobs running,
  and an `agents` readiness probe timeout. The failure tail is still a launch-custody risk.
- The service account cannot create `pods/exec` in namespace `torghut`; privileged database inspection is not part of
  the acceptance path.

### Torghut Business Evidence

- `GET /trading/health` returned HTTP `503` with `status=degraded`.
- Healthy dependencies included Postgres, ClickHouse, Alpaca live broker status, static universe, readiness cache,
  optional empirical jobs, DSPy runtime, and optional quant evidence.
- The failing dependencies were `live_submission_gate=simple_submit_disabled` and
  `profitability_proof_floor=repair_only`; both are correct capital-safety holds.
- `GET /trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, top queue item
  `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, and value gate
  `routeable_candidate_count`.
- The top queue item required `torghut.executable-alpha-receipts.v1`, had `expected_unblock_value=2`, and carried
  `max_notional=0` with capital rule `zero_notional_repair_only`.
- Repair-bid settlement summarized `41` raw repair bids, `6` compacted lots, `5` selected lots, `3` dispatchable lots,
  `3` held lots, and `routeable_candidate_count=0`.
- Alpha closure settlement market status was `pending_no_delta`.
- No-delta budget state was `consumed`, with `used_attempts=1`, `remaining_attempts=0`, and release conditions
  `evidence_window_changes`, `blocker_set_changes`, `source_ref_changes`, and `required_receipt_changes`.
- The no-delta reentry auction returned `reentry_decision=deny`, `selected_ticket=null`, and reason codes
  `active_no_delta_release_key`, `no_release_condition_changed`, `zero_notional_reentry_ticket_not_selected`,
  `jangar_verification_carry_unavailable`, and `duplicate_no_delta_reentry_denied`.

### Jangar Evidence

- `GET /ready` returned `status=ok`, while preserving `business_state=repair_only`.
- `GET /api/agents/control-plane/status?namespace=agents` generated at `2026-05-14T16:11:25.232Z`.
- Jangar execution trust was `degraded`.
- Source rollout status was `block`, while the verify board's source rollout truth state was `converged`.
- The verify-trust foreclosure board was in `observe` mode and carried debt classes
  `execution_trust_degraded`, `stage_trust_degraded`, `plan_trust_degraded`, `verify_trust_degraded`,
  `source_rollout_truth_split`, `controller_witness_stale`, `route_stability_hold`, `torghut_business_repair_only`,
  `torghut_no_delta_active`, and `revenue_repair_settlement_custody_deny`.
- Foreclosure tickets were open for execution trust, stage trust, plan trust, verify trust, source rollout split,
  controller witness, route stability, Torghut repair-only state, and revenue-repair settlement custody. The
  `torghut_no_delta_active` ticket was denied, which is the correct duplicate-repair posture.
- Material gate digest allowed `serve_readonly` and `torghut_observe`, denied `dispatch_repair` because
  `alpha_closure_no_delta_budget_consumed` and `alpha_closure_no_delta_debt_active`, held normal dispatch and paper
  canary, and blocked live capital actions.
- Repair-slot escrow was blocked with no selected slot because the selected receipt source revenue-repair ref did not
  match and the material reentry receipt was missing for the selected executable alpha.

### Database And Data

- `GET /db-check` returned `ok=true`, `schema_current=true`, `account_scope_ready=true`,
  `schema_graph_lineage_ready=true`, `schema_missing_heads=[]`, `schema_unexpected_heads=[]`, and
  `schema_head_delta_count=0`.
- The DB surface is therefore not the top blocker. Schema currentness is necessary but insufficient.
- Data quality remains below capital grade because `routeable_candidate_count=0`, no-delta debt is active,
  release conditions are unchanged, and Jangar verification carry is unavailable to Torghut.

### Source And Test Surface

- Torghut's high-risk integration file is `services/torghut/app/main.py`, which assembles readiness, trading status,
  revenue repair, and consumer evidence.
- `services/torghut/app/trading/revenue_repair.py` already passes
  `status_payload.get("verify_trust_foreclosure_board") or status_payload.get("jangar_verification_carry")` into
  `build_no_delta_repair_reentry_auction`.
- `services/torghut/app/trading/no_delta_repair_reentry_auction.py` already degrades to
  `jangar-verification-carry:unavailable` when that payload is absent.
- The missing Torghut implementation surface is an evidence ingress that fetches or receives Jangar's compact carry,
  normalizes it into the trading status payload, and keeps stale or failed fetches as explicit denial evidence.
- Existing Torghut tests cover the no-delta auction, revenue-repair digest, consumer evidence, executable alpha
  receipts, alpha evidence foundry, alpha repair closure, and repair-bid settlement. The missing tests are the
  transport and freshness cases around imported Jangar carry.

## Problem

Torghut can now say "do not run the same alpha repair again." It cannot yet say "Jangar has a current foreclosure
ticket that makes a different zero-notional repair worth trying."

The concrete failure modes are:

1. Jangar exposes a verify-trust foreclosure board, but Torghut sees `jangar_verification_carry_unavailable`.
2. Torghut's no-delta auction has a release condition for `jangar_verify_foreclosure_ticket_current`, but no durable
   cross-plane packet satisfies it.
3. Jangar repair-slot escrow can block on source-ref and material-reentry mismatches without that mismatch becoming a
   Torghut auction prerequisite.
4. Operators can see `/ready=ok` and `/trading/health=503` at the same time, then manually stitch together whether
   this is serving health, material readiness, or capital safety.
5. A future implementation could solve this by polling a large Jangar status object on Torghut's hot path, creating a
   new reliability dependency instead of a bounded witness.
6. Direct database access is unavailable, so the bridge must rely on typed application witnesses and not on ad hoc SQL.

The next architecture has to turn Jangar failure debt into a compact, fresh, zero-notional auction input.

## Alternatives Considered

### Option A: Have Torghut Poll Jangar Control-Plane Status Directly

Torghut would call `/api/agents/control-plane/status?namespace=agents`, extract
`verify_trust_foreclosure_board`, and pass the whole board into the no-delta auction.

Advantages:

- Fast to implement.
- Reuses the board shape already emitted by Jangar.
- Gives Torghut access to all current failure debt.

Disadvantages:

- Couples Torghut's revenue-repair hot path to a large control-plane status route.
- Makes transient Jangar slowness look like Torghut evidence failure.
- Expands the cross-plane contract every time Jangar adds fields.
- Does not solve repair-slot source-ref reconciliation; it only moves the raw board.

Decision: reject as the primary contract. It is acceptable as a temporary implementation source only if Torghut
normalizes the response into the compact carry packet and caches it with a short TTL.

### Option B: Let Jangar Self-Launch The Next Repair Slot

Jangar would ignore Torghut's auction denial and allocate a repair slot from its own foreclosure board when it sees a
current ticket.

Advantages:

- Avoids a Torghut importer.
- Keeps launch custody in the control plane.
- Could retire Jangar-specific trust debt faster.

Disadvantages:

- Splits business evidence from launch custody.
- Risks launching work that Torghut still considers duplicate no-delta.
- Weakens the rule that `/trading/revenue-repair` is the live business evidence surface.
- Does not move `routeable_candidate_count` unless Torghut accepts the repair as a release-conditioned ticket.

Decision: reject.

### Option C: Compact Verification-Carry Bridge And Auction Ingress

Jangar emits a compact carry packet with one selected debt ticket, active no-delta key, source refs, freshness, action
class, validation command, and rollback target. Torghut imports only that packet into the no-delta auction.

Advantages:

- Directly clears the current `jangar_verification_carry_unavailable` blocker.
- Keeps `/trading/revenue-repair` as the business evidence authority.
- Avoids coupling Torghut to the full Jangar control-plane status schema.
- Gives deployer and verifier stages a single object to cite.
- Preserves zero-notional capital safety and duplicate no-delta denial.

Disadvantages:

- Adds one cross-plane transport and cache.
- Requires strict freshness and source-ref checks.
- Can keep denying useful repairs until Jangar exports a current packet.

Decision: select Option C.

## Architecture

The bridge has two additive contracts.

### Jangar Export

Jangar emits `jangar.verify-trust-foreclosure-carry.v1` on `/ready` and
`/api/agents/control-plane/status?namespace=agents`. A later implementation may expose a dedicated
`/api/agents/control-plane/torghut/verification-carry` route, but the payload shape must stay the same.

Required fields:

```text
schema_version: jangar.verify-trust-foreclosure-carry.v1
carry_id
board_id
generated_at
fresh_until
mode
status: current | stale | unavailable | blocked
namespace
selected_ticket:
  ticket_id
  debt_class
  state
  required_output_receipt
  dedupe_key
  validation_commands
torghut_context:
  consumer_evidence_ref
  alpha_repair_closure_board_ref
  active_no_delta_release_key
  selected_value_gate
  selected_hypothesis_id
action_class
decision
reason_codes
release_condition
max_notional
rollback_target
```

The packet is compact by design. It should not carry the full foreclosure ticket list, full material gate digest, full
repair-slot escrow, or full AgentRun inventory.

### Torghut Ingress

Torghut imports the packet into trading status as `jangar_verification_carry`.

Ingress rules:

1. Fetch the carry from a configured URL such as `TRADING_JANGAR_VERIFY_CARRY_URL`.
2. Enforce a short timeout and bounded stale cache. A failed fetch becomes `status=unavailable`, not an exception that
   breaks `/trading/revenue-repair`.
3. Reject packets with `fresh_until <= now` as `jangar_verification_carry_stale`.
4. Require `max_notional=0` before the packet can open a zero-notional auction ticket.
5. Require the packet's active no-delta key to match the Torghut active no-delta release key unless the packet states
   a source-ref, blocker-set, evidence-window, or required-receipt release condition.
6. Pass the normalized packet into `build_no_delta_repair_reentry_auction`.
7. Export the compact result on `/trading/revenue-repair` and `/trading/consumer-evidence`.

### Auction Behavior

The no-delta auction keeps the current default:

- unavailable carry denies reentry;
- stale carry denies reentry;
- current carry without a changed release condition denies duplicate no-delta reentry;
- current carry with a changed release condition may select one zero-notional ticket;
- nonzero notional blocks the ticket, even if every evidence condition is current.

The selected ticket must name one of:

- `jangar_verify_carry` for verification-debt foreclosure;
- `execution_tca_receipt` when Jangar carry names execution proof as the release prerequisite;
- `market_context_receipt` when the blocker set changed around market context;
- `empirical_receipt` when post-cost evidence is the active prerequisite;
- `schema_lineage_receipt` when lineage is the active prerequisite.

## Implementation Scope

Engineer stage should implement this as two PRs if ownership boundaries are split, or one PR if the same engineer owns
both surfaces.

Torghut responsibilities:

1. Add a small Jangar verification-carry client with timeout, TTL, stale-cache handling, and schema validation.
2. Wire the client into the trading status payload before `build_revenue_repair_digest`.
3. Keep fetch failures observable as `jangar_verification_carry_unavailable`.
4. Add tests proving current carry can satisfy `jangar_verify_foreclosure_ticket_current`, stale carry is denied,
   unavailable carry is denied, mismatched no-delta keys are denied unless a release condition changed, and all selected
   tickets keep `max_notional=0`.
5. Add consumer-evidence coverage for the compact auction ref after carry import.

Jangar responsibilities are defined in the companion document.

## Validation Gates

Local validation for Torghut implementation:

- `uv sync --frozen --extra dev`
- `uv run --frozen pytest services/torghut/tests/test_no_delta_repair_reentry_auction.py`
- `uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k no_delta`
- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k no_delta`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Post-rollout validation:

- `kubectl get applications.argoproj.io -n argocd torghut jangar agents`
- `kubectl get deploy -n torghut -o wide`
- `kubectl get deploy -n jangar -o wide`
- `curl -fsS http://jangar.jangar.svc.cluster.local/ready | jq '.verification_carry'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.no_delta_repair_reentry_auction'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.no_delta_repair_reentry_auction'`
- `curl -sS -o /tmp/torghut-health.json -w '%{http_code}' http://torghut.torghut.svc.cluster.local/trading/health`

Acceptance gates:

- Jangar emits a fresh carry packet with a non-null `carry_id`.
- Torghut no longer reports `jangar_verification_carry_unavailable` when Jangar carry is fresh.
- If release conditions are unchanged, Torghut still denies duplicate no-delta reentry.
- If a release condition changed, Torghut selects at most one zero-notional ticket.
- `routeable_candidate_count` either increases above `0` or a new no-delta debt records the changed release condition.
- `max_notional=0` and `simple_submit_disabled` remain true until post-cost and routeability evidence clear capital
  gates.

## Rollout

1. Ship Jangar carry export first in observe mode.
2. Prove `/ready` and control-plane status include the compact carry and that the full foreclosure board remains
   available for operator debugging.
3. Ship Torghut carry ingress with a configured URL and fail-closed behavior.
4. Keep the no-delta auction in observe mode until it has at least one fresh carry sample and one denial sample.
5. Promote images through normal CI and GitOps only.
6. Confirm Argo health, workload readiness, Jangar carry freshness, Torghut revenue repair, consumer evidence, and
   `/trading/health` capital holds after rollout.

## Rollback

Rollback is straightforward and must not require database mutation:

- unset or disable `TRADING_JANGAR_VERIFY_CARRY_URL`;
- keep Torghut treating missing carry as `jangar_verification_carry_unavailable`;
- keep `max_notional=0`;
- keep live submission disabled;
- leave the Jangar carry export in observe mode, or remove the route if it causes serving risk;
- fall back to existing no-delta auction duplicate-denial behavior.

## Risks

- **Hot-path coupling:** Torghut must cache and fail closed rather than block revenue repair on a slow Jangar route.
- **False release:** mismatched no-delta keys can open a ticket accidentally unless the implementation checks active
  key, source ref, blocker set, and receipt set together.
- **Overbroad payload:** exporting the full foreclosure board would make the contract brittle.
- **Operator confusion:** `/ready=ok` and `/trading/health=503` remain valid together. Docs and handoffs must name
  serving readiness separately from material and capital readiness.
- **No revenue delta:** the bridge may only replace `jangar_verification_carry_unavailable` with a stricter denial if
  release conditions remain unchanged. That is acceptable because it improves evidence truth and prevents duplicate
  no-delta work.

## Handoff

Engineer:

- Implement Jangar carry export from the companion contract and Torghut carry ingress here.
- Start with observe-mode payloads and focused unit tests before changing scheduling behavior.
- Do not select a repair ticket unless `max_notional=0`, the carry is fresh, and the auction release condition is
  explicit.

Deployer:

- Promote only through CI and GitOps.
- After rollout, capture Argo status, image digest, Jangar carry id, Torghut auction id, reentry decision, selected
  ticket, `routeable_candidate_count`, and `max_notional`.
- Treat a denied duplicate no-delta ticket as a valid safety outcome if the release condition did not change.

Smallest blocker preventing revenue impact:

- Torghut cannot consume Jangar's verify-trust foreclosure evidence as a fresh carry packet, so
  `routeable_candidate_count` remains `0` and no zero-notional reentry ticket can be selected.
