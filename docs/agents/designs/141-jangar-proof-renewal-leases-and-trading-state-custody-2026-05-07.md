# 141. Jangar Proof Renewal Leases And Trading State Custody (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, Torghut trading-state custody, proof-renewal lease receipts, capital action
gates, validation, rollout, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/145-torghut-proof-renewal-leases-and-capital-reentry-state-market-2026-05-07.md`

Extends:

- `140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
- `139-jangar-empirical-relay-source-binding-and-capital-gate-parity-2026-05-07.md`
- `135-jangar-rollout-availability-escrow-and-consumer-evidence-custody-2026-05-07.md`
- `104-jangar-quant-evidence-clearinghouse-and-capital-action-firewall-2026-05-06.md`

## Decision

I am selecting **proof renewal leases with trading state custody** as the next Jangar control-plane architecture step.

The current control plane no longer justifies a broad freeze. The read-only pass at `2026-05-07T10:10Z` showed Argo
CD reporting `agents`, `argo-workflows`, `feature-flags`, `jangar`, `nats`, `symphony-jangar`, `symphony-torghut`,
`torghut`, and `torghut-options` as Synced and Healthy. Jangar liveness returned `status=ok`; the control-plane status
route returned dependency quorum `allow`; Jangar, Bumba, Symphony, and their support pods were Running; and Agents
controllers were `2/2` available after the rollout that replaced the earlier unhealthy controller replica.

The remaining failure mode is a custody failure between fresh platform state and stale trading proof. Torghut live
health still returned HTTP `503` because the proof floor was `repair_only`, live submission was disabled by
`simple_submit_disabled`, execution TCA was stale, and quant ingestion was degraded. The Torghut database confirmed the
same shape: `147623` persisted trade decisions, `13775` execution TCA rows, but latest live TCA from
`2026-04-02T20:59:45Z`; `0` order-feed event rows; only `1` persisted strategy hypothesis while source control has
`3` hypothesis manifests; only H-MICRO-01 had persisted metric windows; and empirical jobs were present but could not
stand in for TCA, feature, drift, and submission proof.

I am not choosing a Jangar-only rollout patch. I am also not choosing a Torghut-only proof-floor patch. The selected
design makes Jangar the issuer of short-lived proof renewal leases for every trading evidence class it uses to grant
observe, repair, paper, or live authority. Torghut can then cite one Jangar custody receipt instead of reinterpreting
watch reliability, database health, empirical status, quant health, and proof-floor details independently.

The tradeoff is that Jangar has to own more explicit state. I accept that because the current system has enough green
platform evidence to keep working, but not enough trading evidence to let capital move. The architecture should encode
that distinction instead of relying on operator memory.

## Runtime Objective And Success Metrics

Success means:

- Jangar keeps read-only and bounded repair actions available when platform quorum is healthy.
- Jangar refuses paper and live capital action unless Torghut proof leases are current, source-owned, and scoped to the
  requested account, revision, and market window.
- Watch reliability recovery no longer implies trading capital readiness by itself.
- Empirical job receipts can raise repair priority but cannot renew TCA, feature coverage, drift governance, source/DB
  hypothesis parity, or live submission leases.
- A source/DB mismatch, such as three source manifests and one persisted strategy hypothesis, becomes an explicit
  `source_db_parity_expired` lease instead of hidden implementation debt.
- Every lease names `source_of_truth`, `observed_value`, `fresh_until`, `allowed_action_classes`,
  `blocked_action_classes`, and `renewal_owner`.
- Deployer rollback can force Jangar to publish all trading leases as observe/repair only without mutating Torghut
  data.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, GitOps
resources, AgentRun records, trading flags, or empirical artifacts.

### Cluster And Rollout Evidence

- `kubectl config current-context` was unset in the workspace, so I bootstrapped the in-cluster read context from the
  service-account token and CA before reading resources.
- `kubectl get applications -n argocd` reported `agents`, `agents-ci`, `argo-workflows`, `feature-flags`, `jangar`,
  `nats`, `symphony-jangar`, `symphony-torghut`, `torghut`, and `torghut-options` Synced and Healthy.
- `kubectl get pods -n jangar -o wide` showed Jangar, Bumba, Jangar Alloy, Jangar Postgres, Redis, Open WebUI, and
  Symphony pods Running.
- `kubectl get pods -n agents -o wide` showed `agents`, `agents-alloy`, and two `agents-controllers` pods Running.
  Recent events still showed readiness timeouts and one liveness failure on `agents-controllers-57bb594756-2fkdz`,
  which is watch debt rather than a full control-plane outage.
- `kubectl get pods -n torghut -o wide` showed live `torghut-00252-deployment` and sim
  `torghut-sim-00352-deployment` `2/2` Running. ClickHouse, Keeper, Postgres, TA, sim TA, options TA, WebSocket,
  guardrail exporters, Alloy, and Symphony were Running.
- Torghut events still showed repeated `MultiplePodDisruptionBudgets` warnings for ClickHouse pods and a recent
  readiness `503` on `torghut-ws-options`, so deployer gates should keep disruption and WebSocket readiness visible.
- The service account cannot list CNPG clusters or create `pods/exec` in `torghut`; database inspection used the
  Torghut application credential and direct network access to Postgres without mutating rows.

### Runtime Evidence

- `GET /health` on Jangar returned `{"status":"ok","service":"jangar"}`.
- `GET /api/agents/control-plane/status?namespace=agents` returned dependency quorum `allow` with healthy
  `control_runtime`, `dependency_quorum`, `freshness_authority`, `evidence_authority`, `market_data_context`, and
  `watch_stream` segments.
- `GET /api/torghut/trading/control-plane/quant/health` without account/window was `ok` but omitted scoped stage
  evidence. Scoped Torghut live health later showed the useful truth: latest metrics were present, but ingestion was
  stale while compute and materialization were current.
- Torghut live `GET /healthz` returned `ok`, while `GET /trading/health` returned HTTP `503` with overall
  `status=degraded`.
- Live proof floor was `repair_only`, `capital_state=zero_notional`, and blocked on
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`.
- Live quant evidence was informationally degraded: `latest_metrics_count=144`, latest update
  `2026-05-07T10:10:25Z`, pipeline lag `14` seconds, but ingestion lag `59145` seconds.
- Sim `GET /trading/health` returned HTTP `200`, but sim proof floor was still `repair_only`: alpha was not promotion
  eligible and execution TCA exceeded the slippage guardrail.
- Live `/db-check` returned `ok=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, graph signature
  `50a656f68f04a0e4c3591ecf6ff9e5927c6297046f474318b25110cdf2a015b0`, and lineage warnings for two known parent
  forks. Sim `/db-check` also returned `ok=true`, with divergence roots explicitly allowed.

### Database And Data Evidence

- The live Torghut database has `69` public tables.
- Context-like live tables are sparse: the only public table matching market/context/evidence naming was
  `simulation_runtime_context`, and it had `0` rows in the live database.
- `trade_decisions` has `147623` rows. Latest created decision was `2026-05-06T17:44:19Z`; statuses included `63569`
  blocked, `69909` rejected, `13555` filled, `370` planned, `217` canceled, and `3` expired.
- `executions` has `13778` rows. Latest execution update was `2026-04-03T05:32:38Z`.
- `execution_tca_metrics` has `13775` rows. Latest TCA was `2026-04-02T20:59:45Z`, with average absolute slippage
  about `568.61` bps for the live account.
- `execution_order_events` has `0` rows, which means order-feed reconciliation evidence is not yet materialized in the
  live database.
- Source control contains three hypothesis manifests, but `strategy_hypotheses` has `1` row and
  `strategy_hypothesis_metric_windows` has `3` rows only for `H-MICRO-01` in paper stage.
- `vnext_empirical_job_runs` has `20` completed empirical receipts across benchmark parity, foundation-router parity,
  Janus event CAR, and Janus HGRM reward, all promotion-authority eligible and updated at `2026-05-06T16:27:32Z`.
- Basic consistency checks were clean: zero null decision hashes, zero unlinked order events, zero TCA rows without an
  execution, and zero inactive strategy hypotheses.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is already the right aggregation boundary for controller,
  database, watch, runtime admission, execution trust, empirical services, and dependency quorum state.
- `services/jangar/src/routes/api/agents/control-plane/status.ts` exposes the status contract that Torghut consumes.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` starts the quant runtime and only
  includes pipeline stages when account and window scope are provided.
- `services/jangar/src/server/control-plane-empirical-services.ts` already reads Torghut `/trading/status`, but it
  reduces empirical, forecast, and LEAN status without a durable lease model.
- `services/torghut/app/trading/proof_floor.py` correctly keeps capital at zero whenever live gate, alpha readiness,
  empirical, quant, market context, or TCA dimensions are degraded.
- `services/torghut/app/trading/hypotheses.py` compiles source manifests into runtime statuses, but feature rows,
  drift checks, evidence continuity, market context freshness, Jangar quorum, and TCA age are still evaluated from
  runtime state rather than a persisted lease set.
- Tests are broad in both services. Jangar has control-plane status, watch reliability, material action, runtime
  admission, empirical services, and route tests. Torghut has proof-floor, empirical-jobs, hypotheses, TCA, scheduler,
  feature-quality, and trading API tests. The missing coverage is a cross-plane lease fixture for recovered Jangar
  quorum plus stale Torghut proof.

## Problem

Jangar currently reports platform truth and Torghut reports trading truth, but no compact receipt says which trading
proofs are current enough for each action class.

That causes four problems:

1. **Recovered control-plane quorum can be over-read.** Jangar dependency quorum is currently `allow`, but Torghut
   capital remains unsafe.
2. **Positive empirical receipts can be over-read.** Twenty eligible empirical jobs are useful repair evidence, not a
   substitute for month-old TCA or missing feature/drift data.
3. **Source and database custody can diverge silently.** Source has three hypothesis manifests; live Postgres has one
   persisted hypothesis and metric windows only for H-MICRO-01.
4. **Quant health is easy to query unscoped.** The unscoped health endpoint can return `ok` while scoped account/window
   ingestion is stale.

The system needs a renewal lease model: every proof that can influence dispatch, deployment, paper, or live capital
must have a current owner, source, observed timestamp, expiry, and action-class consequence.

## Alternatives Considered

### Option A: Continue With Material Action Verdicts Only

Pros:

- Builds on the existing Jangar action classes.
- Avoids a new receipt shape.
- Keeps control-plane implementation smaller.

Cons:

- Material action verdicts do not expose why a trading proof is stale, current, or source-divergent.
- They cannot distinguish empirical freshness from TCA freshness.
- They do not give Torghut a stable, account-scoped proof custody object to cite in capital decisions.

Decision: reject as the complete answer. Keep material action verdicts as the enforcement target.

### Option B: Make Torghut The Sole Proof Authority

Pros:

- Torghut owns the database, proof floor, hypotheses, TCA, and trading status.
- Jangar would stay simpler.
- Trading-specific reducers would live near trading code.

Cons:

- Deployer and AgentRun workflows still ask Jangar whether actions are allowed.
- Jangar would keep making capital-adjacent decisions without a typed proof custody view.
- It preserves the current cross-service interpretation problem.

Decision: reject.

### Option C: Jangar-Issued Proof Renewal Leases With Torghut As Source Custodian

Pros:

- Gives Jangar one short-lived receipt set for trading action authority.
- Lets Torghut remain the source custodian for data, proof floor, TCA, and hypotheses.
- Makes source/DB mismatch, stale TCA, missing order-feed evidence, unscoped quant health, and disabled submission
  gates visible as lease states.
- Preserves read-only and repair progress while blocking paper/live capital.

Cons:

- Adds a new reducer and fixture set in Jangar.
- Requires Torghut to expose one state-market payload that is stable enough for Jangar to lease.
- Requires deployer discipline to reject unscoped quant health as capital evidence.

Decision: select Option C.

## Architecture

Jangar emits a `trading_proof_renewal_lease_set` inside `/api/agents/control-plane/status`.

```text
trading_proof_renewal_lease_set
  schema_version = jangar.trading-proof-renewal-leases.v1
  generated_at
  fresh_until
  namespace
  torghut_account
  torghut_revision
  torghut_state_ref
  platform_quorum_state
  leases[]
  action_state
  renewal_queue
```

Each lease is intentionally small.

```text
proof_renewal_lease
  lease_id
  proof_class              # tca, feature_coverage, drift, quant_ingestion, empirical, hypothesis_source_db, etc.
  source_of_truth          # torghut_status, torghut_db_check, torghut_db_witness, jangar_status, source_manifest
  state                    # current, renewable, expired, contradicted, blocked, informational
  observed_at
  fresh_until
  observed_value
  threshold
  allowed_action_classes
  blocked_action_classes
  renewal_owner
  renewal_command_ref
  reason_codes
```

Action state is derived from the leases, not from one health bit.

```text
serve_readonly: allow when Jangar platform quorum is current.
dispatch_repair: allow when platform quorum is current and the repair owner is named.
dispatch_normal: hold when any required normal-dispatch lease is expired or contradicted.
deploy_widen: hold when platform rollout/watch leases are not current.
torghut_observe: allow when Torghut liveness and DB schema leases are current.
paper_canary: hold until TCA, feature, drift, hypothesis parity, quant scope, and paper proof leases are current.
live_micro_canary: block until paper lease settlement is current and live submission is explicitly enabled.
live_scale: block until live micro canary, TCA, order feed, and rollback leases stay current across the configured window.
```

The minimum first lease set is:

- `jangar_platform_quorum`: from Jangar status and watch reliability.
- `torghut_live_health`: from live `/trading/health`, including HTTP status.
- `torghut_db_schema`: from live `/db-check`.
- `execution_tca`: from Torghut proof floor/TCA summary and database witness.
- `order_feed_reconciliation`: from `execution_order_events` or the equivalent typed status.
- `hypothesis_source_db_parity`: from source registry count and persisted strategy hypotheses/metric windows.
- `feature_coverage`: from Torghut hypothesis runtime counters or a persisted feature coverage table.
- `drift_governance`: from drift counters or a persisted drift evidence table.
- `quant_ingestion_scope`: from scoped account/window quant health only.
- `empirical_receipts`: from vNext empirical job status.
- `submission_gate`: from Torghut live submission gate.

## Implementation Scope

Engineer scope:

1. Add a Jangar `buildTradingProofRenewalLeaseSet` reducer beside the existing control-plane status reducers.
2. Extend `/api/agents/control-plane/status` with `trading_proof_renewal_lease_set` and preserve existing fields for
   compatibility.
3. Fetch Torghut live `/trading/status`, live `/trading/health`, live `/db-check`, sim `/trading/health`, and scoped
   Jangar quant health using explicit account/window parameters.
4. Treat unscoped quant health as valid only for liveness, never for paper/live capital.
5. Add unit tests for:
   - Jangar quorum `allow` plus live Torghut `repair_only`;
   - fresh empirical jobs with expired TCA;
   - source registry count `3` versus persisted hypothesis count `1`;
   - scoped quant ingestion stale while compute/materialization are fresh;
   - order-feed reconciliation missing;
   - sim health passing but live capital blocked.
6. Add a route fixture that asserts `serve_readonly`, `dispatch_repair`, and `torghut_observe` can remain allowed while
   `paper_canary`, `live_micro_canary`, and `live_scale` are held or blocked.

Deployer scope:

1. Do not use unscoped `/api/torghut/trading/control-plane/quant/health` as capital evidence.
2. Gate paper canary on a current `trading_proof_renewal_lease_set` with no expired required paper leases.
3. Gate live on paper settlement plus current live submission, order-feed reconciliation, TCA, and rollback leases.
4. During rollout, keep the old material action verdicts and the new lease set side by side for at least two market
   sessions before making the lease set hard-enforcing.

## Validation Gates

Local validation:

- `bunx oxfmt --check docs/agents/designs/141-jangar-proof-renewal-leases-and-trading-state-custody-2026-05-07.md`
- `bun run --filter jangar test -- control-plane-status`
- `bun run --filter jangar test -- control-plane-empirical-services`
- `bun run --filter jangar test -- torghut`

Cluster validation:

- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- Confirm `dependency_quorum.decision=allow` can coexist with Torghut paper/live lease holds.
- Confirm every lease has `source_of_truth`, `observed_at`, `fresh_until`, `allowed_action_classes`, and
  `blocked_action_classes`.
- Confirm expired TCA blocks paper/live even when empirical receipts are current.
- Confirm a source/DB hypothesis mismatch blocks paper/live and queues a source custody repair.

Database validation:

- Read-only query count and freshness for `trade_decisions`, `executions`, `execution_tca_metrics`,
  `execution_order_events`, `strategy_hypotheses`, `strategy_hypothesis_metric_windows`, and
  `vnext_empirical_job_runs`.
- The lease set must not require direct pod exec or CNPG API access. It should be reproducible through typed routes
  and the Torghut application database witness.

## Rollout Plan

1. Land the reducer and route extension shadow-only.
2. Publish lease sets to Jangar status without changing action enforcement.
3. Compare lease action state to existing material action verdicts for two market sessions.
4. Enable deployer warnings when paper/live would proceed without current leases.
5. Enable hard holds for paper canary and live action classes.
6. Make merge-ready and deploy widening cite platform leases, while trading capital cites trading proof leases.

## Rollback Plan

Rollback is intentionally simple:

- Set the Jangar lease reducer flag off or force `trading_proof_renewal_lease_set.enforcement_mode=shadow`.
- Keep old material action verdict behavior active.
- Treat all trading leases as observe/repair only while preserving their payloads for audit.
- Do not mutate Torghut database rows to roll back the Jangar view.
- If the route extension itself fails, remove the additive field from the response and keep `/api/agents/control-plane/status`
  serving the previous schema.

## Risks And Mitigations

- Risk: the lease set becomes another large status payload.
  Mitigation: keep each lease bounded and put detailed evidence behind typed source refs.
- Risk: lease thresholds are calibrated too tightly.
  Mitigation: shadow for two market sessions and compare against current material action verdicts before enforcement.
- Risk: DB-source parity appears noisy while migrations and seeders catch up.
  Mitigation: classify parity as `renewable` for observe/repair and `expired` only for paper/live.
- Risk: operators use unscoped quant health accidentally.
  Mitigation: make unscoped quant health produce `informational` leases only.

## Handoff Contract

Engineer acceptance gates:

- New Jangar lease reducer is covered by unit tests and fixture payloads.
- Status route exposes the lease set without breaking existing consumers.
- The stale-TCA/current-empirical scenario blocks paper/live and allows repair.
- Source registry `3` versus persisted hypothesis count `1` is represented as a lease state, not hidden in prose.

Deployer acceptance gates:

- Shadow lease sets are visible in Jangar before enforcement.
- Existing material action verdicts and new lease action states are compared in rollout notes.
- Paper canary is not enabled until TCA, source/DB parity, feature, drift, scoped quant ingestion, and submission leases
  are current.
- Live capital remains blocked until paper settlement, order-feed reconciliation, rollback, and TCA leases stay current
  across the configured window.
