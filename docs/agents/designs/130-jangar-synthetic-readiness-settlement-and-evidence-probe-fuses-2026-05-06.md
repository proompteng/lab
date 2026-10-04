# 130. Jangar Synthetic Readiness Settlement And Evidence Probe Fuses (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar runtime readiness, synthetic evidence probes, material action admission, Torghut capital receipt
consumption, rollout safety, least-privilege validation, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/134-torghut-profitability-proof-floor-and-evidence-repair-market-2026-05-06.md`

Extends:

- `129-jangar-heartbeat-lane-escrow-and-material-verdict-stability-2026-05-06.md`
- `129-jangar-consumer-evidence-return-ledger-and-rollout-settlement-2026-05-06.md`
- `128-jangar-runtime-convergence-ledger-and-capital-gate-receipts-2026-05-06.md`
- `125-jangar-quant-proof-replication-and-capital-admission-firebreak-2026-05-06.md`

## Decision

I am selecting **synthetic readiness settlement with evidence probe fuses** as the next Jangar control-plane
architecture step.

The cluster is healthier than the earlier discover sample suggested: `deployment/jangar` was `1/1`,
`deployment/agents` was `1/1`, `deployment/agents-controllers` was `2/2`, and the Torghut live and sim serving pods
were `2/2` ready at `2026-05-06T20:40Z`. Jangar `/ready` returned `status=ok`, issued fresh serving and swarm
passports, and no longer reported the missing NATS runtime-kit condition observed earlier. That is good progress.

It is not enough for material trust. In the same run, the memory CLI initially failed through Jangar with a `500`
timeout before succeeding on retry, live Torghut `/readyz` and `/trading/health` returned `503`, Jangar quant health
was `degraded` with ingestion lag around `10549` seconds, and market context was `degraded` with stale technicals,
fundamentals, news, and regime domains. The service-level readiness path and the product-level evidence path are
therefore out of phase. Jangar can say "ready" while the evidence products that Torghut needs for capital authority are
not actually usable.

The selected design makes Jangar readiness a settled product rather than a route echo. Jangar will run bounded,
least-privilege synthetic probes for the critical evidence products it advertises, settle the results into short-lived
receipts, and fuse material action classes when those probes fail or disagree with runtime self-report. The tradeoff is
more moving parts in the control plane and a stricter path to normal dispatch. I accept it because the alternative is
letting green passports mask a broken evidence chain.

## Runtime Objective And Success Metrics

This contract increases Jangar reliability by reducing false-positive readiness and making rollout widening depend on
the same evidence surfaces downstream consumers actually use.

Success means:

- Jangar readiness distinguishes process availability from evidence-product usability.
- Material action classes consume a synthetic readiness settlement receipt, not only `/ready` or heartbeat status.
- Memory retrieval, Torghut live/sim readiness, quant health stages, market-context freshness, and controller rollout
  stability are probed with bounded timeouts and explicit freshness windows.
- Probe failures degrade only the affected action classes: read-only serving can remain available while dispatch,
  repair, rollout widening, paper, and live capital are held according to risk.
- Torghut receives stable Jangar receipts with reason codes, source URLs, expiry, and rollback target.
- Deployer validation works with namespace read/list and application routes; it does not require privileged pod exec or
  direct database mutation.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, trading flags, broker
state, GitOps manifests, or ClickHouse tables.

### Cluster And Rollout Evidence

- Runtime identity was `system:serviceaccount:agents:agents-sa`.
- `deployment/jangar`, `deployment/agents`, and `deployment/agents-controllers` were available at `1/1`, `1/1`, and
  `2/2`.
- Torghut had live revision `torghut-00244-deployment-556cc5c594-4kjls` and sim revision
  `torghut-sim-00344-deployment-68787fcc66-rmdp5` running with both containers ready.
- Recent Torghut events showed the prior `torghut-00243` revision scaling down and a late readiness probe failure on
  the old pod while the new revision was already serving.
- Recent Agents events showed continuing scheduled swarm jobs and controller/runtime attempts, including implement and
  plan jobs. This is a live control plane, not an idle lab.
- The service account cannot exec into Torghut or Jangar database pods, and it cannot list some Torghut workload kinds
  such as StatefulSets, FlinkDeployments, or Knative services. Jangar must publish validation receipts that do not
  depend on privileged operator paths.

### Route Evidence

- Jangar `/ready` returned `status=ok` and issued fresh admission passports for serving, swarm plan, swarm implement,
  and swarm verify.
- The first memory lookup in this lane failed with `Jangar memory retrieve failed (500)` and an operation timeout; a
  later retry succeeded. That is exactly the kind of false-positive readiness that a synthetic retrieval probe should
  catch.
- Live Torghut `/healthz` returned healthy earlier in the sample, but `/readyz` and `/trading/health` returned `503`
  at `2026-05-06T20:40Z`.
- Jangar quant health for account `PA3SX7FYNUTF`, window `15m`, returned `status=degraded`,
  `latestMetricsCount=144`, `metricsPipelineLagSeconds=7`, and `maxStageLagSeconds=10549`.
- The quant stage view showed compute healthy at `1` second lag, ingestion unhealthy at `10549` seconds lag, and
  materialization unhealthy at `21` seconds lag.
- Jangar market context health returned `overallState=degraded`. Technicals freshness was about `174089` seconds
  against a `60` second limit, fundamentals about `4777067` seconds against an `86400` second limit, news about
  `4410253` seconds against a `300` second limit, and regime about `174089` seconds against a `120` second limit.

### Database And Data Evidence

- Torghut `/db-check` returned `ok=true`, `schema_current=true`, and current/expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`.
- Earlier `/db-check` evidence also exposed migration parent fork warnings in the Alembic graph. The current route no
  longer emits warnings, but the contract should keep graph lineage checks in the readiness receipt because schema
  current is not the same as data ready.
- Direct Torghut Postgres, Jangar Postgres, and ClickHouse inspection through pod exec was forbidden by RBAC. The
  durable contract must therefore be route/projection based and self-auditing.
- Torghut live status reported empirical jobs healthy and fresh, but the live submission gate remained closed with
  `simple_submit_disabled`, capital stage `shadow`, and zero promotion-eligible hypotheses.
- TCA evidence was stale: live status reported `order_count=13775`, average absolute slippage about `568.6` bps, and
  `last_computed_at=2026-04-02T20:59:45Z`.

### Source Evidence

- `services/jangar/src/routes/ready.tsx` exposes process and runtime readiness but is not a synthetic product probe for
  each downstream evidence contract.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` already computes stage-level quant
  health from the latest metric store and quant pipeline health windows. It is ready to become a probe source.
- `services/jangar/src/routes/api/torghut/market-context/health.ts` and
  `services/jangar/src/server/torghut-market-context.ts` already compute domain freshness and risk flags. They are
  ready to become probe sources.
- `services/memories/retrieve.ts` proves the memory CLI path depends on Jangar `/api/memories`; readiness should probe
  the actual retrieval path, not only provider configuration.
- Existing Jangar design contracts already define heartbeat lane escrow, material action verdicts, and capital gate
  receipts. The missing product is a settled readiness receipt that tests the user-facing evidence routes before
  action admission.

## Problem

Jangar currently has a readiness route, runtime-kit checks, admission passports, heartbeat contracts, and material
verdicts. The missing architecture layer is a product-level settlement that proves those checks line up with the
evidence products consumers depend on.

The current failure modes are:

1. **Self-report optimism.** `/ready` can be green while memory retrieval, Torghut readiness, quant health, or market
   context is degraded.
2. **Route split-brain.** A service can expose `/healthz` while `/readyz`, `/trading/health`, and domain evidence routes
   fail.
3. **Evidence freshness drift.** Quant metrics can update while one stage has hours of ingestion lag.
4. **Rollout masking.** A newer revision can be ready while the previous revision still emits recent readiness failures.
5. **Least-privilege blind spots.** Normal validation cannot rely on pod exec or direct database reads.
6. **Consumer ambiguity.** Torghut needs to know whether Jangar is safe for observe, repair, paper, live micro, or
   rollout widening; one green status bit cannot carry that authority.

## Alternatives Considered

### Option A: Keep `/ready` As The Material Gate

Pros:

- Minimal implementation.
- Uses an existing route and admission-passport shape.
- Avoids new storage or reducer work.

Cons:

- Fails the observed memory timeout case.
- Treats Torghut route failures as external noise rather than advertised product failure.
- Cannot express partial availability by action class.
- Lets rollout widening and capital consumers depend on self-report instead of synthetic evidence.

Decision: reject.

### Option B: Widen RBAC And Let Operators Validate Directly

Pros:

- Gives humans rich diagnostic access.
- Can inspect databases, pods, logs, and stateful workloads directly.
- Useful during break-glass incidents.

Cons:

- Violates the least-privilege lane contract for routine validation.
- Does not create a durable product for Torghut or future consumers.
- Moves readiness judgment out of CI/CD and into manual operation.
- Does not reduce false-positive readiness in automated action admission.

Decision: reject.

### Option C: Synthetic Readiness Settlement With Evidence Probe Fuses

Pros:

- Tests the actual routes and CLI paths consumers use.
- Produces a compact receipt with action-class decisions, reason codes, and expiry.
- Preserves read-only serving when a downstream evidence product is degraded.
- Gives deployers a deterministic widen/hold rule under least-privilege access.
- Gives Torghut a concrete receipt to consume before paper or live capital.

Cons:

- Adds a reducer and one more receipt type.
- Requires timeouts and budgets to avoid making readiness itself a source of load.
- May hold normal dispatch during partial outages that previously passed `/ready`.

Decision: select Option C.

## Architecture

Jangar emits one synthetic readiness settlement per namespace, consumer class, and short window.

```text
synthetic_readiness_settlement
  settlement_id
  generated_at
  namespace
  window_start
  window_end
  producer_revision
  probe_set_digest
  route_self_report
  probe_results
  action_class_decisions
  debt_items
  rollback_target
  fresh_until
```

Each probe is bounded, typed, and least-privilege:

```text
evidence_probe_result
  probe_id
  probe_kind               # memory_retrieval, torghut_readyz, quant_health, market_context, rollout_stability
  target_ref
  source_url
  started_at
  completed_at
  timeout_ms
  status                   # pass, degraded, fail, timeout, skipped
  observed_freshness_s
  expected_freshness_s
  reason_codes
  sample_digest
```

Action classes consume the settled probe result:

- `serve_readonly`: requires Jangar process readiness and runtime kits; degraded evidence products are visible but not
  fatal.
- `dispatch_repair`: requires Jangar process readiness plus a named repair target and a non-expired probe result for
  the affected product.
- `dispatch_normal`: requires process readiness, memory retrieval success, stable controller receipt, and no failing
  required downstream product probe.
- `rollout_widen`: requires stable controller receipt, successful memory retrieval, no recent old-revision readiness
  failures, and successful route probes for all advertised consumers.
- `torghut_observe`: requires Jangar process readiness and a probe receipt that names any degraded Torghut evidence.
- `torghut_paper_canary`: requires Torghut live/sim readiness, quant health stages under thresholds, market context
  freshness under thresholds, empirical proof current, and no synthetic memory timeout.
- `torghut_live_micro`: requires all paper gates plus current execution settlement/TCA and an explicit rollback target.

The receipt is intentionally short-lived. A five-minute `fresh_until` is enough for Jangar UI, swarm admission, and
Torghut control-plane consumption. Longer-lived audit belongs in the event ledger, not the action receipt.

## Implementation Scope

Engineer stage should implement:

- A Jangar server module that runs the probe set with per-probe timeout and total budget.
- A durable or cached `synthetic_readiness_settlements` projection keyed by namespace, consumer class, and window.
- Route integration so `/ready` can include the latest settlement summary without blocking basic service readiness.
- Material action verdict integration so action classes consume settlement decisions.
- A Torghut-facing receipt shape with `settlement_id`, action class, decision, reasons, source refs, and `fresh_until`.
- Unit tests for pass, degraded, timeout, stale, and route-self-report-disagreement cases.

Deployer stage should implement:

- Rollout widening gates that require `rollout_widen=allow` for two consecutive settlement windows.
- Dashboards or alerts for probe failures by probe kind and action class.
- A rollback runbook that reverts the Jangar revision and marks downstream Torghut capital gates `shadow_only` when the
  settlement route is unavailable or contradictory.

Out of scope:

- Privileged pod exec as a normal validation path.
- Automatic mutation of Torghut trading flags.
- Treating a synthetic receipt as profitability proof. It is platform evidence only; Torghut still owns trading proof.

## Validation Gates

Engineer acceptance gates:

- Unit test: `/ready` can be green while `memory_retrieval` probe fails; `serve_readonly=allow`,
  `dispatch_normal=hold`, and reason `memory_retrieval_timeout` is emitted.
- Unit test: quant compute is fresh but ingestion exceeds the stage lag threshold; Torghut paper/live action classes are
  held with `quant_ingestion_lag`.
- Unit test: market context domains are stale; `torghut_observe=allow` and paper/live classes hold with domain-specific
  reason codes.
- Unit test: recent old-revision readiness failures block `rollout_widen` even when the new deployment is ready.
- Integration test: a synthetic receipt can be serialized, consumed by material verdict logic, and expired.

Deployer acceptance gates:

- Read-only validation command can fetch the settlement route and show each probe status without pod exec.
- Rollout canaries require two consecutive `rollout_widen=allow` receipts before widening.
- Jangar dashboards show probe timeout count, degraded action class count, and receipt age.
- Rollback to the previous Jangar revision changes downstream receipts to held or expired rather than leaving stale
  allow decisions.

## Rollout Plan

1. Ship probe runner in shadow mode. `/ready` remains unchanged, but the settlement is emitted and logged.
2. Compare settlement decisions with existing admission passports for at least one market session and one closed-session
   interval.
3. Gate `dispatch_normal` and `rollout_widen` on the settlement receipt while keeping `serve_readonly` independent.
4. Expose Torghut-facing receipt consumption in shadow-only mode.
5. Allow Torghut paper canary gates to consume the receipt after two clean settlement windows and matching Torghut proof
   floor evidence.

## Rollback Plan

- If probe runner load or latency becomes unsafe, disable synthetic probes and keep `/ready` process checks intact.
- If the settlement route is unavailable, material action verdicts treat settlement as expired and hold dispatch/paper/live
  classes.
- If a probe implementation is wrong, disable only that probe kind and emit `probe_disabled` debt; do not silently
  convert it to allow.
- If receipt consumers regress, revert the material-verdict integration and keep the receipt in shadow mode for audit.

## Risks And Mitigations

- **Risk: readiness probes become too expensive.** Mitigate with bounded timeouts, cache windows, and low-cardinality
  sample digests instead of full payload persistence.
- **Risk: partial outages block too much work.** Mitigate with action-class-specific decisions so read-only and repair
  remain available.
- **Risk: consumers confuse platform readiness with trading proof.** Mitigate by naming Torghut proof-floor gates
  separately and requiring both receipts for paper/live capital.
- **Risk: stale receipts survive rollback.** Mitigate with short `fresh_until`, producer revision, and rollback target in
  every receipt.
- **Risk: route probes reflect one account only.** Mitigate by making account/window explicit in the probe target and by
  requiring account-scoped receipts for Torghut capital classes.

## Handoff Contract

Engineer handoff:

- Build the synthetic readiness settlement module and tests in Jangar.
- Use current route modules as probe sources rather than duplicating quant or market-context logic.
- Keep `/ready` available for process readiness, but make material action verdicts consume settlement decisions.
- Do not require privileged Kubernetes or database access for normal proof.

Deployer handoff:

- Treat `rollout_widen=hold` as a rollout stop even when Kubernetes deployments are available.
- Require two fresh allow receipts before widening Jangar or enabling Torghut paper canary consumers.
- During incident response, publish the settlement id and reason codes instead of raw pod logs as the audit anchor.

Torghut consumer handoff:

- Consume Jangar synthetic readiness receipts as platform proof only.
- Require the companion Torghut proof-floor receipt before any paper or live notional.
- Hold capital at zero when the Jangar receipt is missing, expired, degraded for Torghut action classes, or produced by
  an unexpected revision.
