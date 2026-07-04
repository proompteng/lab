# 146. Torghut Submission Quorum Handoff And Profit Repair Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Decision

I am selecting **submission quorum handoff with profit repair gates** as Torghut's plan-stage architecture direction.

Torghut is operational enough to keep learning, but it is not capital-qualified. At `2026-05-07T10:23Z`, the live
revision `torghut-00253` and sim revision `torghut-sim-00353` were available, Postgres and ClickHouse were OK, Alpaca
was OK for live account `PA3SX7FYNUTF`, the Jangar universe was fresh with 12 symbols, the scheduler was running, and
empirical jobs were healthy.

The trading route still returned HTTP `503` with `status=degraded`. The live submission gate was closed by
`simple_submit_disabled`, proof floor state was `repair_only`, capital state was `zero_notional`, and the blocking
reasons were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`. Execution
TCA was last computed on `2026-04-02T20:59:45.136640Z`; average absolute slippage was about `568.61` bps against an
`8` bps guardrail; quant ingestion lag was `59,905` seconds; and zero hypotheses were promotion eligible.

The decision is to keep observe and zero-notional repair active, but make paper/live submission consume a Jangar repair
dividend handoff and a Torghut proof quorum. A repair has business value only when it retires a named blocker, improves
after-cost evidence, or moves a hypothesis toward promotion eligibility. The submission quorum is the final gate that
prevents empirical freshness or operational availability from bypassing stale execution, stale quant ingestion, missing
features, missing drift checks, or disabled submission.

The tradeoff is slower paper reentry. I accept that because the current system has enough negative evidence to say that
paper would not produce trustworthy profit proof.

## Runtime Objective And Success Metrics

Success means:

- Torghut can continue observe and zero-notional repair while paper/live submission remains closed.
- Every repair bid names the blocker it retires, affected hypothesis IDs, expected profit dividend, validation command
  or route, expiry, and required Jangar dividend refs.
- Paper submission requires a current Jangar handoff gate, current TCA, current account/window quant ingestion, feature
  rows, drift checks, forecast authority or explicit waiver, at least one promotion-eligible hypothesis, and paper
  submit explicitly enabled.
- Live submission requires paper settlement, after-cost guardrails, expected shortfall coverage, Jangar live action
  allow, no open capital repair leases, and live submit explicitly enabled.
- Repair ranking prefers after-cost capital unlock over static warning severity.
- Rollback keeps `capital_state=zero_notional` and `simple_submit_disabled`.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, ClickHouse tables, broker
state, trading flags, AgentRun records, GitOps resources, or empirical artifacts.

### Cluster And Runtime Evidence

- `kubectl -n torghut get pods,deploy,job,cronjob -o wide --ignore-not-found` showed `torghut-00253-deployment`
  available `1/1` and `torghut-sim-00353-deployment` available `1/1`.
- Older Torghut live revisions `00248` through `00252` and sim revisions `00348` through `00352` were scaled to `0/0`.
- `torghut-db-1`, ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog, options enricher, websocket
  services, guardrail exporters, Alloy, and Symphony were Running.
- The empirical artifact retention CronJob completed successfully about six hours before the assessment.
- Events repeatedly reported `MultiplePodDisruptionBudgets` for ClickHouse pods and `NoPods` for the Keeper PDB.
  That is not a trading gate by itself, but it is rollout-risk evidence for the deployer lane.

### Trading Health And Proof Evidence

- `GET http://torghut.torghut.svc.cluster.local/trading/health` returned HTTP `503`.
- Scheduler, Postgres, ClickHouse, Alpaca, universe, readiness cache, empirical jobs, and DSPy informational checks
  were OK.
- Alpaca account status was `ACTIVE` for account label `PA3SX7FYNUTF`.
- Universe source was Jangar, status `ok`, reason `jangar_fetch_ok`, `symbols_count=12`, and cache age `0`.
- Empirical jobs were healthy and non-required for readiness, with candidate
  `chip-paper-microbar-composite@execution-proof` and dataset snapshot
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Live submission was `allowed=false`, reason `simple_submit_disabled`, with `capital_stage=shadow`.
- Proof floor was `repair_only`, `capital_state=zero_notional`, `max_notional=0`.
- Proof-floor blockers were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and
  `simple_submit_disabled`.
- Quant evidence was informationally degraded: latest metrics count was `144`, metrics pipeline lag was `6` seconds,
  but max stage lag was `59,905` seconds and the ingestion stage was not OK.
- Execution TCA had `13,775` orders, last computed `2026-04-02T20:59:45.136640Z`, average absolute slippage about
  `568.61` bps, and slippage guardrail `8` bps.
- Alpha readiness had `3` hypotheses: `1` blocked, `2` shadow, `0` promotion eligible, and `3` rollback required.
- The dependency quorum decision was `unknown` because Torghut could not fetch Jangar status within its route budget.

### Database And Source Evidence

- Runtime dependency checks reported Postgres and ClickHouse OK.
- Direct database shell access is not available to this runner. `kubectl cnpg psql -n torghut torghut-db -- -c 'select now();'`
  failed because the service account cannot create `pods/exec` in namespace `torghut`.
- Source contains `31` Alembic version files in `services/torghut/migrations/versions`, including governance, TCA,
  empirical-job, options, simulation, strategy factory, claim graph, autoresearch, and embedding-dimension migrations.
- `services/torghut/app/main.py` assembles the trading health/status route and is `4,124` lines.
- `services/torghut/app/trading/proof_floor.py` builds the structured proof-floor receipt and repair ladder.
- `services/torghut/app/trading/autonomy/lane.py` is `7,377` lines and
  `services/torghut/app/trading/autonomy/policy_checks.py` is `6,072` lines, so the next repair scorer should be
  isolated from those orchestration-heavy modules.
- `services/torghut/app/models/entities.py` is the likely persistence boundary for future repair dividend and quorum
  records.
- Existing tests cover trading API shape, autonomy policy, proof floor, TCA policy, migration graph checks, feature
  quality, forecasting, and scheduler autonomy. The missing fixture is one reducer that ranks repair bids by expected
  after-cost capital unlock and rejects paper/live when a quorum member is stale.

## Problem

Torghut can list repair needs, but it does not yet turn those needs into a capital-safe submission quorum.

The failure modes are:

1. **Operational availability can mask profit invalidity.** The route, database, broker, universe, and empirical jobs
   can be healthy while execution TCA and hypothesis readiness still invalidate capital.
2. **Repair priorities are too static.** The proof floor has a ladder, but not a profit dividend ledger tied to
   hypothesis IDs and capital unlock.
3. **Jangar and Torghut proof are not consumed as one handoff.** Torghut needs a Jangar repair dividend ref before
   treating control-plane recovery as capital evidence.
4. **Paper can still look tempting after empirical success.** Empirical jobs are fresh, but paper without current
   TCA, quant ingestion, drift, feature coverage, and submission intent would create noisy evidence.
5. **Least-privilege validation is required.** The normal verifier cannot depend on database exec, ClickHouse shell, or
   secret reads.

## Alternatives Considered

### Option A: Promote Paper On Fresh Empirical Jobs

Pros:

- Fastest path to new observations.
- Uses real empirical artifacts that are currently healthy.
- Avoids new persistence and scoring logic.

Cons:

- Ignores stale execution TCA, high slippage, and missing expected shortfall coverage.
- Ignores quant ingestion lag and zero promotion-eligible hypotheses.
- Produces paper evidence that cannot be trusted for profit qualification.

Decision: reject.

### Option B: Freeze All Trading Repairs Until Every Proof Surface Is Healthy

Pros:

- Strong capital safety.
- Simple operator posture.
- Avoids spending runtime on ambiguous repairs.

Cons:

- Blocks the zero-notional repairs needed to recover proof surfaces.
- Leaves empirical evidence idle without ranking the next profit unlock.
- Forces humans to repeatedly combine Jangar and Torghut evidence by hand.

Decision: reject.

### Option C: Submission Quorum Handoff With Profit Repair Gates

Pros:

- Keeps observe and repair open while preserving capital safety.
- Ranks repair work by expected after-cost profit dividend.
- Requires a current Jangar handoff gate before submission gates can graduate.
- Makes paper and live submission depend on explicit proof dimensions.
- Fits route-only validation in the current RBAC model.

Cons:

- Requires a new repair scorer and quorum reducer.
- Requires guardrail calibration so expected profit dividend does not become arbitrary.
- Keeps paper closed longer while stale proof is repaired.

Decision: select Option C.

## Architecture

Torghut emits one submission quorum handoff per account, revision, and market window.

```text
submission_quorum_handoff
  handoff_id
  generated_at
  fresh_until
  account_label
  torghut_revision
  market_window
  jangar_handoff_gate_ref
  proof_floor_ref
  live_submission_gate_ref
  ranked_profit_repair_gates[]
  paper_quorum
  live_quorum
  rollback_target
```

Each profit repair gate is explicit about blocker, hypothesis, validation, and capital effect.

```text
profit_repair_gate
  gate_id
  blocker_code
  hypothesis_ids[]
  proof_dimension
  current_state
  target_state
  expected_profit_dividend_bps
  expected_capital_state_unlock
  required_jangar_dividend_refs[]
  validation_refs[]
  expires_at
```

The paper quorum requires:

- Jangar handoff gate current and not holding paper for control-plane witness reasons;
- execution TCA current and within slippage guardrails;
- account/window quant ingestion current;
- required feature rows present for the target hypothesis;
- drift checks current;
- forecast authority ready or an explicit waiver with owner and expiry;
- at least one hypothesis promotion eligible for paper;
- paper submit intentionally enabled.

The live quorum requires:

- paper settlement fresh;
- after-cost expectancy and expected shortfall coverage present;
- Jangar live action allow;
- no open repair lease touching capital authority;
- live submit intentionally enabled.

## Hypothesis Guardrails

- `H-CONT-01` cannot promote while `signal_lag_exceeded` or `tca_evidence_stale` is open. It needs signal feed proof
  and fresh TCA before any paper quorum can include it.
- `H-MICRO-01` cannot promote while drift checks, feature rows, required feature sets, signal freshness, or TCA are
  missing. Its repair gates should score feature coverage and drift governance higher than generic route health.
- `H-REV-01` cannot promote while market context, signal feed, or TCA evidence are stale. Its repair gates should
  price market-context freshness and TCA renewal before submission enablement.

## Implementation Scope

Engineer stage owns:

1. Add a pure reducer for `submission_quorum_handoff`, `profit_repair_gate`, paper quorum, and live quorum.
2. Feed the reducer from the existing proof-floor, alpha readiness, quant evidence, TCA, forecast, and live submission
   route payloads.
3. Consume Jangar repair dividend handoff refs as required proof for control-plane-dependent gates.
4. Keep scoring logic outside `main.py`, `autonomy/lane.py`, and `autonomy/policy_checks.py` where possible.
5. Add focused tests for stale TCA, stale quant ingestion, empirical-fresh-but-paper-blocked, Jangar handoff missing,
   and quorum pass after all proof dimensions recover.

Deployer stage owns:

1. Capture `/trading/health` and Jangar control-plane status before shadow emission.
2. Verify the handoff route emits the same paper/live holds as the current proof floor while proof is stale.
3. Keep `simple_submit_disabled` true until paper quorum passes and explicit paper intent is reviewed.
4. Keep live submission disabled until paper settlement and live quorum pass.

## Validation Gates

Required local checks for the engineer PR:

- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- Focused pytest coverage for proof floor, trading API, migration graph, and the new quorum reducer.

Required deployer checks:

- `kubectl -n torghut get pods,deploy,job,cronjob -o wide --ignore-not-found`
- `kubectl -n torghut get events --sort-by=.lastTimestamp`
- `curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://torghut.torghut.svc.cluster.local/trading/health`
- `curl -sS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents'`

## Rollout

1. Emit submission quorum handoff in shadow.
2. Confirm shadow paper/live decisions match the current proof-floor holds.
3. Rank zero-notional repair gates and publish expected dividend refs.
4. Enable paper only after quorum pass and explicit paper submit intent.
5. Enable live only after paper settlement, live quorum pass, and Jangar live action allow.

## Rollback

Rollback must:

- keep `capital_state=zero_notional`;
- keep `simple_submit_disabled`;
- preserve the last emitted handoff for forensics;
- fall back to the existing proof-floor repair ladder;
- require no direct database mutation.

## Risks

- Expected profit dividend scoring can become arbitrary if it is not tied to hypothesis guardrails and after-cost proof.
- Jangar status timeouts can leave dependency quorum unknown even when Jangar is healthy; the gate should treat unknown
  as no paper/live authority.
- PDB ambiguity around ClickHouse does not block the route today, but it is a rollout risk for data-plane maintenance.
- Direct DB exec is intentionally unavailable; route-level schema and freshness evidence must stay complete.

## Handoff

Engineer: implement the quorum reducer as a pure module fed by existing route payloads and add tests that keep empirical
freshness from bypassing stale TCA, stale quant ingestion, missing features, missing drift checks, or missing Jangar
handoff evidence.

Deployer: keep observe and zero-notional repair open. Do not enable paper or live submission until the quorum passes and
the Jangar companion action contract allows the matching capital class.
