# 135. Jangar Database Witness And Schema Authority Exchange (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane database evidence, source-schema authority, rollout safety, material action gates,
read-only validation, Torghut capital handoff, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/139-torghut-profit-data-witness-and-forecast-repair-exchange-2026-05-07.md`

Extends:

- `134-jangar-evidence-census-and-projection-settlement-exchange-2026-05-07.md`
- `134-jangar-profit-clock-settlement-router-and-evidence-margin-arbiter-2026-05-07.md`
- `122-jangar-evidence-pressure-governor-and-data-cost-rollout-cells-2026-05-06.md`
- `100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md`

## Decision

I am selecting **database witness and schema authority exchange** as the next Jangar control-plane architecture step.

The previous evidence census made projection quality explicit across rollout, heartbeat, event, schedule, and database
statistics surfaces. The current evidence says the next failure mode is narrower and more dangerous: Jangar can prove
database health from inside the serving application, but an independent read-only operator cannot prove the same thing
from the runtime identity that has to assess and hand off the system. That is not a simple permission issue. It is an
authority gap inside a control plane that already uses database and source-schema leases for `dispatch_normal`,
`deploy_widen`, `merge_ready`, and `torghut_capital`.

At `2026-05-07T07:13Z`, `GET /api/agents/control-plane/status` reported the Jangar database configured, connected,
and healthy with `28` registered migrations, `28` applied migrations, and latest registered/applied migration
`20260505_torghut_quant_pipeline_health_window_index`. That is useful service-owned evidence. In the same run,
`kubectl cnpg psql -n jangar jangar-db` failed because `system:serviceaccount:agents:agents-sa` cannot create
`pods/exec` in `jangar`; `kubectl auth can-i create pods/exec -n jangar` returned `no`; and the CNPG
`jangar-db-ro` service had an EndpointSlice with `endpoints: null`. The app can say "database healthy", but the
operator and deployer do not have a current independent witness path.

The selected design adds a database witness exchange: a short-lived set of service-owned, cluster-owned, and
consumer-owned receipts that distinguish "the application can query the database" from "the control plane has enough
independent, read-only evidence to let material action rely on database truth." The tradeoff is one more authority
surface and one more set of reducer tests. I accept that because the current system already acts on database authority.
The right fix is not to pretend the authority is simpler than it is.

## Runtime Objective And Success Metrics

This contract reduces failure modes by separating database reachability, schema correctness, read-only auditability,
and action authority.

Success means:

- Jangar keeps serving when the app-owned database probe is healthy.
- `merge_ready`, `dispatch_normal`, `deploy_widen`, and `torghut_capital` can require a database witness quorum without
  granting broad pod exec or secret read to agent workloads.
- The status route names the difference between `service_db_healthy`, `independent_witness_missing`,
  `read_only_endpoint_absent`, `migration_drift`, `extension_drift`, `embedding_dimension_drift`, and
  `query_budget_exceeded`.
- The database witness can be validated with route, Kubernetes, and bounded SQL receipts, not with ad hoc secret dumps.
- Torghut paper/live capital consumes the same database witness receipt as Jangar material action verdicts.
- Deployer rollback can disable enforcement while keeping witness receipts visible.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, GitOps state, broker
state, trading flags, or AgentRun records.

### Cluster, Rollout, And Event Evidence

- `kubectl config current-context` was initially unset, so I installed an in-cluster context using the service-account
  token and verified `kubectl auth whoami` as `system:serviceaccount:agents:agents-sa`.
- `jangar` namespace pods were Running: `bumba`, `jangar`, `jangar-alloy`, `jangar-db-1`, Redis, Open WebUI,
  `symphony`, and `symphony-jangar`.
- `deployment/jangar`, `deployment/bumba`, `deployment/jangar-alloy`, `deployment/symphony`, and
  `deployment/symphony-jangar` were available.
- `agents` namespace deployments were available: `agents=1/1`, `agents-controllers=2/2`,
  and `agents-alloy=1/1`.
- `agents` still carried failed workload debt. Historical cron Jobs from roughly three hours earlier were Failed, but
  the latest Jangar and Torghut cron schedule Jobs completed in the current window.
- Recent agents events still showed readiness and liveness probe failures on `agents` and `agents-controllers`, plus
  `BackoffLimitExceeded` on individual scheduled stage attempts.
- `GET /api/agents/control-plane/status` reported rollout health healthy for `agents` and `agents-controllers`.
- The same status response reported watch reliability degraded over a `15` minute window: `2461` events, `0` errors,
  `4` restarts, and streams for `agentruns.agents.proompteng.ai`, `approvalpolicies.approvals.proompteng.ai`, and
  `job`.

### Database And Data Evidence

- `GET /api/agents/control-plane/status` reported:
  - `database.configured=true`
  - `database.connected=true`
  - `database.status=healthy`
  - `latency_ms=11`
  - `migration_table=kysely_migration`
  - `registered_count=28`
  - `applied_count=28`
  - `latest_registered=20260505_torghut_quant_pipeline_health_window_index`
  - `latest_applied=20260505_torghut_quant_pipeline_health_window_index`
- `kubectl cnpg psql -n jangar jangar-db -- -Atc "select current_database(), current_user, now();"` failed with:
  `pods "jangar-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot create resource "pods/exec"`
  in namespace `jangar`.
- `kubectl auth can-i create pods/exec -n jangar` returned `no`.
- `kubectl get svc,endpoints -n jangar` showed `jangar-db-r` and `jangar-db-rw` endpoints on `10.244.3.245:5432`,
  while `jangar-db-ro` had no endpoints.
- `kubectl get endpointslices -n jangar -l kubernetes.io/service-name=jangar-db-ro -o yaml` confirmed the
  `jangar-db-ro` EndpointSlice had `endpoints: null`.
- Direct database evidence from this runtime is therefore blocked. The current durable database evidence is
  service-owned route evidence, not an independent operator witness.

### Source Evidence

- `services/jangar/src/server/control-plane-db-status.ts` already performs `select 1`, discovers
  `kysely_migration` or `kysely_migrations`, compares registered/applied migrations, and emits `DatabaseStatus`.
- `services/jangar/src/server/kysely-migrations.ts` registers `28` migrations and requires `vector` plus `pgcrypto`.
- `services/jangar/src/server/atlas-store.ts` already checks `atlas.embeddings.embedding` and
  `atlas.chunk_embeddings.embedding` dimensions against `OPENAI_EMBEDDING_DIMENSION`.
- `services/jangar/src/server/control-plane-action-clock.ts` requires `database` and `source_schema` leases for
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `torghut_capital`.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` turns database connectivity and migration
  consistency into database/source-schema leases, including `source_schema.database_unroutable`.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` currently records
  `database_projection_ref` as `database:<status>:<migration_status>`, which is too coarse for independent witness
  authority.
- `services/jangar/src/server/supporting-primitives-controller.ts` is still the largest local risk surface at `3062`
  lines and owns schedule runner generation, runner status, admission refresh, CronJob/ConfigMap reconciliation, PVC
  state, and watch setup. The witness exchange should be implemented as a reducer consumed by status/verdict code, not
  as more branching in that controller.

## Problem

Jangar has database authority without database witness separation.

There are four different claims that are currently close together but not equivalent:

1. The serving process has a configured `DATABASE_URL`.
2. The serving process can run a current query.
3. The applied schema matches source migrations and required extensions.
4. An operator, engineer, deployer, or consumer can independently verify enough database truth to allow material
   action.

Today the status surface proves the first three from inside the app. It does not prove the fourth. That matters because
material action gates already use database/source-schema truth as a required domain. A merge-ready or deploy-widen
decision should not depend only on a black-box app-owned probe when the runtime cannot independently read the database,
the read-only service has no endpoint, and the control-plane watch layer is degraded.

The design goal is not to grant broad database access. The goal is to turn database proof into a least-privilege,
replayable witness contract.

## Alternatives Considered

### Option A: Grant Agents Broad `pods/exec` Or Secret Read

Pros:

- Fastest path to independent SQL checks.
- Matches existing `kubectl cnpg psql` runbooks.
- Gives troubleshooters direct visibility during incidents.

Cons:

- Expands blast radius for every AgentRun that inherits the service account.
- Makes database audit depend on ephemeral shell access and secret handling.
- Does not produce durable receipt ids for material action gates.
- Still leaves Torghut consumers reconstructing database truth from logs.

Decision: reject.

### Option B: Trust The Existing App-Owned Database Probe

Pros:

- Already implemented and passing in the current sample.
- Avoids new credentials, services, and reducers.
- Keeps status route latency low.

Cons:

- Does not distinguish app reachability from independent auditability.
- Cannot explain `jangar-db-ro` having no endpoints.
- Cannot prove bounded read-only access for deployer checks.
- Leaves `database_projection_ref` too coarse for capital authority.

Decision: reject.

### Option C: Database Witness And Schema Authority Exchange

Pros:

- Keeps app-owned database health as one witness instead of the only authority.
- Adds a narrow read-only witness path with statement timeouts and stable receipt schemas.
- Makes missing independent witness a first-class reason code instead of a hidden RBAC gap.
- Gives material action verdicts and Torghut capital gates the same database receipt id.
- Avoids broad pod exec or secret permissions.

Cons:

- Requires a new reducer, route payload, and tests.
- Requires calibration so read-only witness queries stay cheap.
- May hold material action during rollout when the app is healthy but witness quorum is incomplete.

Decision: select Option C.

## Architecture

Jangar emits a database witness exchange every status interval.

```text
database_witness_exchange
  exchange_id
  namespace
  generated_at
  fresh_until
  producer_revision
  service_db_witness_ref
  cluster_readonly_witness_ref
  schema_authority_receipt_ref
  consumer_ack_refs
  quorum_decision              # allow, allow_service_only, hold, block
  quorum_reason_codes
  material_action_effects
```

The service-owned witness is the current app probe expanded into a durable receipt.

```text
service_db_witness
  witness_id
  source_ref                   # jagnar:/api/agents/control-plane/status
  issued_at
  fresh_until
  database_configured
  connected
  latency_ms
  migration_table
  latest_registered
  latest_applied
  required_extensions          # vector, pgcrypto
  embedding_dimension_state
  query_budget_ms
  decision                     # allow, degraded, block
  reason_codes
```

The cluster read-only witness is explicitly separate.

```text
cluster_readonly_db_witness
  witness_id
  source_ref                   # kubernetes:endpointslice:jangar-db-ro or read-only route proxy
  issued_at
  fresh_until
  service_name
  endpoint_count
  authz_summary                # can_exec, can_portforward, can_read_projected_receipt
  read_only_role_ref
  bounded_query_receipt_refs
  decision                     # allow, missing, degraded, block
  reason_codes                 # read_only_endpoint_absent, exec_forbidden, witness_timeout
```

The schema authority receipt compares source, applied schema, extension state, and query-shape safety.

```text
schema_authority_receipt
  receipt_id
  source_revision
  registered_migration_count
  applied_migration_count
  latest_registered
  latest_applied
  missing_migrations
  unexpected_migrations
  required_extensions
  vector_dimensions
  material_table_stats
  query_budget
  decision                     # current, drifted, unknown, block
  reason_codes
```

Material action verdicts should include the exchange id, not only `database:healthy:healthy`.

```text
material_action_verdict
  database_witness_exchange_ref
  service_db_witness_ref
  cluster_readonly_witness_ref
  schema_authority_receipt_ref
  database_authority_level     # none, service_only, quorum
```

Initial action effects:

- `serve_readonly`: allow with `service_only` when route and app database are healthy.
- `dispatch_repair`: allow with `service_only` when repair is zero-notional and bounded.
- `dispatch_normal`: require database quorum after the shadow phase.
- `deploy_widen`: require database quorum and schema authority current.
- `merge_ready`: require service witness plus schema authority current in shadow; promote to quorum after a clean
  deployer window.
- `torghut_capital`: require database quorum plus Torghut consumer receipts before paper or live notional.

## Implementation Scope For Engineer Stage

Engineer stage should make this design actionable without broadening runtime privileges.

1. Add a `control-plane-database-witness` reducer under `services/jangar/src/server`.
2. Extend `DatabaseStatus` or add a sibling payload with service witness, cluster read-only witness, schema authority,
   and quorum decision.
3. Feed the reducer from existing app database checks, `getRegisteredMigrationNames`, bounded metadata queries, and
   Kubernetes EndpointSlice/authz evidence already available through the kube gateway.
4. Add route fields to `/api/agents/control-plane/status` without changing `/ready` serving semantics.
5. Add `database_witness_exchange_ref` to material action verdict epochs and final verdict evidence refs.
6. Keep enforcement in shadow mode first. Do not grant broad `pods/exec`, port-forward, or secret read.
7. Add tests proving:
   - service DB healthy plus missing read-only endpoint settles `database_authority_level=service_only`;
   - missing independent witness allows `serve_readonly` and `dispatch_repair` but holds `deploy_widen`;
   - migration drift blocks `merge_ready` and Torghut capital;
   - embedding dimension drift is reported as schema authority drift;
   - watch reliability degradation and database witness degradation produce separate reason codes.

## Validation Gates

Minimum local validation:

- `bun test services/jangar/src/server/__tests__/control-plane-db-status.test.ts` if added.
- `bun test services/jangar/src/server/__tests__/control-plane-material-action-verdict.test.ts`
- `bun test services/jangar/src/server/__tests__/control-plane-action-clock.test.ts`
- `bunx oxfmt --check docs/agents/designs/135-jangar-database-witness-and-schema-authority-exchange-2026-05-07.md`

Read-only runtime validation:

- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.database'`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.database_witness_exchange'`
  after implementation.
- `kubectl get endpointslices -n jangar -l kubernetes.io/service-name=jangar-db-ro -o yaml`
- `kubectl auth can-i create pods/exec -n jangar`
- `kubectl get pods -n jangar -o wide`
- `kubectl get deploy,cronjob,job -n agents`

Acceptance gates:

- `serve_readonly` remains available when the service DB witness is healthy.
- `deploy_widen` and `torghut_capital` do not claim database quorum when the independent witness is missing.
- Missing `jangar-db-ro` endpoints surface as `read_only_endpoint_absent`.
- The route exposes no secrets, DSNs, usernames, passwords, or raw SQL values beyond bounded counts and migration names.
- CI remains green and the PR changes stay under the review-size threshold unless a Codex review is requested and
  resolved.

## Rollout Plan

1. Ship the witness exchange in observe-only mode on the control-plane status route.
2. Compare witness exchange receipts against existing `database_projection_ref` for at least one deployer window.
3. Attach witness refs to material action verdicts while keeping decisions unchanged.
4. Enforce quorum for `deploy_widen` first because rollout blast radius is higher than read-only serving.
5. Enforce quorum for `torghut_capital` before any paper/live notional transition.
6. Enforce quorum for `merge_ready` only after deployer tooling consumes the receipt and CI has a stable read-only
   validation command.

## Rollback Plan

Rollback should be configuration-only.

- Keep service DB health and schema authority visible.
- Disable witness quorum enforcement and return material action to existing database/source-schema lease behavior.
- Keep `serve_readonly`, `dispatch_repair`, and `torghut_observe` available unless route or service DB health fails.
- Do not remove receipt fields immediately; mark them `decision=hold` or `decision=unknown` with reason
  `database_witness_enforcement_disabled`.
- If the route itself causes pressure, disable bounded metadata queries before disabling the whole status route.

## Risks And Tradeoffs

- A new witness reducer can create database pressure if it runs exact counts against hot tables. Use metadata queries,
  statement timeouts, and bounded sampling.
- A missing independent witness can hold deploy widening during otherwise healthy app operation. That is intentional for
  material actions, but it must not break serving.
- The read-only service may remain empty because the CNPG cluster has one instance. In that case the independent
  witness should use a service-owned read-only transaction receipt or a narrow projection route, not broad pod exec.
- If the witness exchange is too strict at first, it can stall engineer throughput. Start with shadow fields and promote
  enforcement by action class.
- If the route leaks DSNs or role details, the design fails. Receipts must carry stable refs and reason codes, not
  secrets.

## Handoff To Engineer

Build the witness exchange as a small reducer next to the existing DB status and material verdict reducers. Keep the
first implementation status-only. Do not add permissions as the first move. The acceptance test I care about is this:
with app DB healthy, `jangar-db-ro` empty, and `pods/exec` forbidden, Jangar should say `serve_readonly=allow`,
`dispatch_repair=allow`, and `deploy_widen`/`torghut_capital=hold` because independent database witness quorum is
missing.

## Handoff To Deployer

Treat this as a rollout-safety improvement, not a database migration. Validate the route first, then check the
EndpointSlice and authz evidence. Do not deploy a permission expansion to make the witness green unless the engineer
stage proves a narrower read-only receipt is insufficient. Roll back by disabling witness enforcement, not by reverting
serving database health.
