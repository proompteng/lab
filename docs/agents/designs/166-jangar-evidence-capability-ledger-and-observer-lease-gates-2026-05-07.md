# 166. Jangar Evidence Capability Ledger And Observer Lease Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane observer capability, rollout confidence, least-privilege evidence access, material action
gates, Torghut capital observation bonds, validation, rollout, rollback, and stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/170-torghut-data-witness-capability-bonds-and-capital-observation-gates-2026-05-07.md`

Extends:

- `165-jangar-proof-settlement-broker-and-profit-repair-packet-gates-2026-05-07.md`
- `162-jangar-contract-witness-notary-and-material-action-gates-2026-05-07.md`
- `143-jangar-least-privilege-evidence-escrow-and-capital-proof-settlement-2026-05-07.md`
- `docs/torghut/design-system/v6/169-torghut-route-reacquisition-board-and-profit-repair-packets-2026-05-07.md`

## Decision

I am selecting an **evidence capability ledger with observer lease gates** as the next Jangar control-plane architecture
step.

The live control plane is not down. Jangar `/ready` reports healthy execution trust, sealed recovery warrants, and
fresh runtime kit projection watermarks. The agents service also reports healthy execution trust. Agents, controller,
and Jangar deployments are available, and the recent schedule cron jobs that were failing in the earlier NATS soak are
now completing. That is good progress, but it is not enough evidence to widen rollout or capital. The same read-only
assessment found recent controller readiness probe timeouts, material action verdicts holding normal dispatch and
merge-ready on missing workflow artifacts and stale controller witnesses, and several important evidence surfaces that
this runtime cannot observe directly: CNPG clusters, Knative services and revisions, pod exec into Postgres or
ClickHouse, and unauthenticated ClickHouse HTTP queries.

The design answer is to make observation rights first-class. Jangar should not treat a green service projection, a
forbidden API, and an authenticated SQL sample as the same evidence class. Each material action must cite an observer
lease that states which surface was observed, which permission or credential was used, when the lease expires, what
confidence it carries, and which smallest unblocker is needed when the lease is missing. The control plane can keep
serving and observation open with partial leases, but dispatch widening, merge-ready, paper canary, and any live
capital path must price the missing leases explicitly.

The tradeoff is operational friction. Some teams will want to avoid adding more status fields when typed service routes
already expose database and route state. I am choosing the ledger anyway because the failure mode is not lack of one
more health endpoint. The failure mode is false equivalence between observed truth and delegated truth. For the next
six months, Jangar needs to show not only whether the system is healthy, but whether the current actor has the evidence
rights needed to prove it.

## Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` emits `evidence_capability_ledger`.
- The ledger includes `ledger_id`, `namespace`, `generated_at`, `fresh_until`, `observer_identity`,
  `capability_leases`, `confidence_summary`, `missing_capability_debts`, `action_class_gates`, and
  `least_privilege_unblockers`.
- Every action-class verdict cites the leases that shaped its confidence.
- `serve_readonly` and `torghut_observe` may remain allowed with delegated database or trading projections.
- `dispatch_repair` can run only when the missing lease is itself the repair target or when a bounded proof packet
  names a non-observer repair.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` stay held when source rollout, controller heartbeat, workflow
  artifact, CNPG, or Knative leases are missing or stale.
- `paper_canary`, `live_micro_canary`, and `live_scale` stay held or blocked while Torghut data witness bonds are
  delegated-only, stale, or contradicted.
- Each missing lease names a smallest unblocker, such as read-only CNPG status, read-only Knative status, a typed
  service projection, or a scoped database credential.

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database
records, secrets, AgentRuns, GitOps resources, Torghut flags, or cluster state.

### NATS And Prior State

- The NATS context soak from 2026-05-05 said Jangar serving was available while execution trust, controller heartbeat,
  scheduled swarm jobs, workspace PVC watching, market-context freshness, and Torghut promotion readiness were degraded.
- Later memory entries show several architecture PRs were merged after that, including evidence-clock, rollout
  settlement, database witness, contract notary, stage clearinghouse, and proof settlement broker designs.
- The live state now differs from the soak: schedule cron jobs are completing again, and `/ready` reports execution
  trust healthy. The remaining gap is evidence completeness and confidence, not a broad scheduler outage.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-jangar-control-plane-discover`, based on `main` at `068aec918`.
- `kubectl auth whoami` identified `system:serviceaccount:agents:agents-sa`.
- Jangar deployments were available: `bumba=1/1`, `jangar=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`. Jangar pod `jangar-865f8f4768-bq94m` was `2/2 Running`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Recent agents events still showed readiness probe timeouts for `agents` and both controller replicas, plus a
  `FailedMount` for a Torghut verify pod whose expected input/spec ConfigMap was not found.
- Recent swarm schedule cron jobs completed: Jangar discover, implement, and verify jobs showed completed cron runs,
  and Torghut quant discover, plan, implement, and verify cron jobs also completed.
- AgentRuns in `agents` showed current discover, verify, and Torghut quant runs active while recent discover, plan,
  implement, and verify runs had succeeded.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` already assembles database status, controller health, watch
  reliability, workflow reliability, execution trust, runtime admission, source rollout truth, route stability, and
  material action verdicts.
- `services/jangar/src/server/control-plane-db-status.ts` runs an internal `select 1`, checks the Kysely migration
  table, and compares 28 registered migrations to 28 applied migrations.
- `services/jangar/src/server/kube-gateway.ts` has a typed Kubernetes read gateway and already distinguishes resource
  access as `ok`, `missing`, or `forbidden` for probed resources.
- `services/jangar/src/server/control-plane-runtime-admission.ts` emits runtime kits, admission passports, recovery
  warrants, runtime proof cells, and projection watermarks with five-minute freshness.
- The existing material action verdicts are already conservative: normal dispatch and merge-ready are held on source
  rollout truth, controller witness, watch, and workflow artifact reasons. The missing part is a durable ledger that
  explains which observation capabilities caused the confidence downgrade.

### Database And Data Evidence

- Jangar `/ready` reported execution trust healthy at `2026-05-07T22:10:01Z`, runtime kits healthy, sealed recovery
  warrants for serving/discover/plan/collaboration/implement/verify, and projection watermarks fresh until
  `2026-05-07T22:15:01Z`.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported database `configured=true`,
  `connected=true`, `status=healthy`, latency `12 ms`, 28 registered migrations, 28 applied migrations, and latest
  applied `20260505_torghut_quant_pipeline_health_window_index`.
- The same status response allowed `serve_readonly` and `torghut_observe`, but held `dispatch_repair`,
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`; it blocked `live_micro_canary` and
  `live_scale`.
- Torghut `/db-check` returned `ok=true`, schema head `0029_whitepaper_embedding_dimension_4096`, one schema branch,
  no missing or unexpected heads, lineage ready, and parent-fork warnings that remain tracked.
- Torghut `/trading/status` reported live mode, active running state, route reacquisition in `repair_only`, one
  probing symbol, four blocked symbols, three missing symbols, and `live_submit_enabled=false`.
- Direct DB and data observation was incomplete from this runtime. CNPG status lists were forbidden in `jangar` and
  `torghut`; Knative service, revision, and route lists were forbidden in `torghut`; pod exec into `jangar-db-1`,
  `torghut-db-1`, the Jangar app pod, the agents controller pod, and ClickHouse was forbidden; ClickHouse HTTP returned
  `401`; Postgres TCP endpoints were reachable but no read-only SQL credential was available.

## Problem

Jangar has improved from a system that conflated serving readiness with promotion readiness. It now has recovery
warrants, runtime proof cells, action clocks, and proof packets. The next failure mode is evidence access ambiguity.

Today the platform can say:

1. Jangar's own database projection is healthy.
2. Torghut's typed `/db-check` says schema is current.
3. This runtime cannot list CNPG clusters or exec into the database pods.
4. This runtime cannot list Knative revisions.
5. ClickHouse is reachable through services but requires authentication.

Those are five different evidence classes. If they collapse into one green or one red signal, operators lose the
ability to make precise decisions. A delegated typed projection may be sufficient for `serve_readonly`. It is not the
same as a direct read-only schema witness when deciding whether to widen dispatch, merge a control-plane repair, or
allow paper capital to rehearse a route repair.

## Alternatives Considered

### Option A: Widen The Agent Service Account

Give this runtime broad read-only access to CNPG, Knative, pods/exec, secrets, and data-plane clients.

Advantages:

- Fastest path to direct evidence.
- Reduces blocked assessment commands.
- Easy for humans to understand.

Disadvantages:

- Expands blast radius for every agent run.
- Encourages debugging through privileged pod exec instead of durable typed receipts.
- Does not tell downstream gates whether evidence came from a safe projection or a high-risk credential.

Decision: reject as the default architecture. Some leases may require new read-only grants, but grants must be scoped
and visible.

### Option B: Rely Only On Typed Service Projections

Treat Jangar `/ready`, Jangar control-plane status, Torghut `/db-check`, and Torghut `/trading/status` as sufficient
for all control-plane decisions.

Advantages:

- Preserves least privilege.
- Uses durable product interfaces.
- Avoids more Kubernetes RBAC work.

Disadvantages:

- A delegated projection can hide the fact that the current actor cannot independently verify a surface.
- It cannot prove Knative revision, CNPG, ClickHouse, or SQL witness availability when those surfaces matter.
- It keeps evidence confidence implicit.

Decision: useful baseline, but insufficient for material action and capital gates.

### Option C: Evidence Capability Ledger With Observer Lease Gates

Emit typed leases for each observation capability and make action confidence depend on the lease set.

Advantages:

- Preserves least privilege while making missing access visible.
- Lets action gates distinguish direct, delegated, synthetic, and unavailable evidence.
- Turns forbidden reads into repairable capability debt with smallest unblockers.
- Gives Torghut a clean way to require data witness bonds before capital.

Disadvantages:

- Adds another read model and payload to an already dense status route.
- Requires stable lease names and careful freshness windows.
- Can slow rollout when direct observation is unavailable even though service projections look healthy.

Decision: select Option C.

## Architecture

### EvidenceCapabilityLedger

Jangar emits:

```text
evidence_capability_ledger
  schema_version
  ledger_id
  namespace
  generated_at
  fresh_until
  observer_identity
  capability_leases
  confidence_summary
  missing_capability_debts
  action_class_gates
  least_privilege_unblockers
  rollback_target
```

### Observer Lease

Each lease includes:

```text
observer_lease
  lease_id
  capability
  surface
  namespace
  observation_mode
  access_result
  confidence
  observed_at
  fresh_until
  evidence_ref
  failure_reason
  smallest_unblocker
```

`observation_mode` values:

- `direct_api`: Kubernetes or service API read by the actor.
- `direct_query`: read-only SQL or ClickHouse query by the actor.
- `delegated_projection`: typed status route owned by a service.
- `synthetic_probe`: TCP, HTTP, or route probe that proves reachability but not semantics.
- `unavailable`: access forbidden, unauthorized, timed out, or missing.

`confidence` values:

- `high`: direct read or signed typed projection with fresh timestamp and no contradiction.
- `medium`: delegated projection or synthetic probe is fresh, but direct lease is missing.
- `low`: surface is reachable but semantic evidence is absent.
- `blocked`: mandatory lease is forbidden, unauthorized, stale, or contradicted.

### Mandatory Initial Capabilities

Engineer stage should implement these first:

- `kubernetes_core_workload_read`: deployments, pods, jobs, cron jobs, and events.
- `controller_heartbeat_read`: heartbeat rows or rollout fallback with freshness and source.
- `workflow_artifact_read`: ConfigMap and mounted artifact witness for runner jobs.
- `cnpg_cluster_status_read`: CNPG cluster and service status without secret access.
- `knative_revision_status_read`: Torghut live and sim service/revision/route status.
- `jangar_database_projection_read`: Jangar internal database and migration consistency.
- `torghut_db_check_projection_read`: Torghut schema head, lineage, and account-scope checks.
- `torghut_clickhouse_semantic_read`: authenticated ClickHouse summary or delegated ClickHouse receipt.
- `torghut_route_reacquisition_read`: route book, TCA summary, and repair candidates.
- `nats_collaboration_read`: NATS helper and channel availability.

### Action Gates

Action gates consume leases:

- `serve_readonly`: allow with fresh `jangar_database_projection_read` and `kubernetes_core_workload_read`.
- `torghut_observe`: allow with fresh Torghut typed projections even if direct CNPG or ClickHouse leases are missing.
- `dispatch_repair`: hold unless the repair targets one missing lease or cites a bounded proof packet.
- `dispatch_normal`: hold while workflow artifact, controller heartbeat, source rollout, or Kubernetes core leases are
  stale, missing, or medium confidence.
- `deploy_widen` and `merge_ready`: hold without high-confidence source rollout, controller, database projection, and
  workload leases.
- `paper_canary`: hold without Torghut data witness bonds for DB, ClickHouse, route, market context, quant stage, and
  Jangar proof packet.
- `live_micro_canary` and `live_scale`: block unless every capital-critical lease is high confidence and Torghut
  companion gates leave zero notional.

## Implementation Scope

Engineer stage should add:

- `services/jangar/src/server/control-plane-evidence-capability-ledger.ts`.
- Unit tests for direct, delegated, synthetic, forbidden, unauthorized, stale, and contradicted leases.
- Integration into `control-plane-status.ts` and material action verdict evidence references.
- A typed mapper from existing `KubeGateway` access results into leases.
- Torghut adapter leases for `/db-check`, `/trading/status`, `/trading/health`, typed quant health, and route
  reacquisition book.
- Least-privilege unblocker strings that do not require secret exposure.

Do not add broad service-account privileges as part of the first implementation. The first ring is a read model that
names missing leases and gates confidence.

## Validation Gates

Required local validation:

- `bunx oxfmt --check docs/agents/designs/166-jangar-evidence-capability-ledger-and-observer-lease-gates-2026-05-07.md docs/torghut/design-system/v6/170-torghut-data-witness-capability-bonds-and-capital-observation-gates-2026-05-07.md docs/torghut/design-system/v6/index.md`
- Targeted Jangar unit tests for lease classification and action gate confidence.
- Existing control-plane status tests still pass.

Required deployer validation after implementation:

- Fetch `/api/agents/control-plane/status?namespace=agents` and verify `evidence_capability_ledger.generated_at` is
  fresh.
- Confirm forbidden CNPG, Knative, exec, or ClickHouse observations appear as capability debt instead of disappearing.
- Confirm `serve_readonly` remains allowed when typed projections are fresh.
- Confirm `dispatch_normal`, `merge_ready`, and capital gates do not widen from delegated-only evidence.
- Confirm the smallest unblocker for each missing lease is precise and least-privilege.

## Rollout

Roll out in four rings:

1. **Shadow**: emit the ledger and compare action confidence with current material action verdicts.
2. **Repair-targeted**: allow `dispatch_repair` only for one missing capability lease or one proof packet.
3. **Widening confidence**: require high-confidence leases for `dispatch_normal`, `deploy_widen`, and `merge_ready`.
4. **Capital observation**: require Torghut companion data witness bonds before paper or live capital gates widen.

## Rollback

Rollback is a feature flag:

- Disable ledger enforcement and keep the ledger visible in observe-only mode.
- Fall back to existing material action verdicts.
- Preserve emitted leases as audit evidence.
- If ledger generation is slow, cap optional leases and keep mandatory lease debts explicit.

## Risks

- The ledger can become a checklist instead of an engineering tool. Keep every lease tied to an action gate or proof
  packet.
- Direct database leases can tempt broad credentials. Prefer typed read-only projections unless capital gates require
  independent witness.
- A missing observer lease is not always a service failure. The payload must separate `surface_unhealthy` from
  `observer_not_authorized`.
- Confidence can be gamed if teams mark delegated projections as high without freshness and ownership. Require
  timestamps, owner surface, and contradiction handling.

## Handoff To Engineer

Implement the ledger as a pure read model. The first regression should reproduce this live case: Jangar and agents
`/ready` are healthy, Jangar database projection is healthy, Torghut `/db-check` is current, but CNPG/Knative/pod exec
and direct ClickHouse reads are unavailable to the actor. Expected output: serving and Torghut observation stay open,
normal dispatch and merge-ready stay held, capital stays blocked, and missing leases name smallest unblockers.

## Handoff To Deployer

Deploy observe-only first. Capture one status payload and compare its missing leases to RBAC errors from the current
runtime. Do not widen service-account permissions in bulk. Add only the leases that implementation proves are required,
and keep paper/live capital closed until Torghut data witness bonds are fresh and high confidence.
