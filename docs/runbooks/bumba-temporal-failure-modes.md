# Bumba + Temporal Failure Modes Runbook

Last updated: 2026-02-22

## Scope

This runbook covers recurring failure modes in:

- `services/bumba` (Temporal worker + GitHub event consumer)
- Temporal worker deployments/task queue routing for `bumba`
- Atlas tables used by Bumba (`atlas.github_events`, `atlas.ingestions`)
- Related but separate noise from GitHub review worktree refresh failures in `services/jangar`

## Data Flow (What Must Stay Healthy)

1. Jangar webhook ingest writes rows into `atlas.github_events` with `processed_at IS NULL`.
2. Bumba event-consumer polls those rows and starts one `enrichFile` workflow per changed file path.
3. Workflows update `atlas.ingestions` (`running` -> terminal `completed|failed|skipped`).
4. Event-consumer marks `atlas.github_events.processed_at` once all ingestions are terminal.

If any step stalls, new workflows appear to stop.

## Fast Triage (5 Minutes)

Set Temporal defaults:

```bash
export TEMPORAL_ADDRESS=temporal-grpc.ide-newton.ts.net:7233
export TEMPORAL_NAMESPACE=default
```

Check queue and pollers:

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  task-queue describe --task-queue bumba --select-all-active --select-unversioned
```

Check deployment routing:

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  worker deployment describe --name bumba-deployment -o json
```

Check pending events + nonterminal ingestions:

```bash
kubectl cnpg psql -n jangar jangar-db -- -d jangar -c "
select count(*) as unprocessed from atlas.github_events where processed_at is null;
select count(*) as nonterminal
from atlas.ingestions
where status in ('accepted','running');
"
```

Check Bumba logs:

```bash
kubectl logs -n jangar deploy/bumba --since=30m | tail -n 400
```

## Failure Mode 1: Temporal Routing Drift

Symptoms:

- New workflows start but fail with activity `ScheduleToStart timeout`.
- Queue has no backlog dispatch despite active workload.
- Pollers are on one build ID, while `currentVersionBuildID` points to another.

How to confirm:

1. `task-queue describe` shows poller build IDs for `workflow`/`activity`.
2. `worker deployment describe` shows `routingConfig.currentVersionBuildID`.
3. Values do not match.

Immediate fix:

```bash
bun run packages/scripts/src/jangar/sync-temporal-routing.ts \
  --task-queue bumba \
  --deployment-name bumba-deployment \
  --migrate-unversioned-running \
  --reason "incident recovery: sync bumba routing"
```

Prevention:

- Run routing sync after every Bumba deploy.
- Alert if `currentVersionBuildID` has no active pollers.

## Failure Mode 2: Activity Routing to Wrong Build (Historical SDK Bug)

Symptoms:

- Workflow run is pinned/versioned, but activities still timeout with `ScheduleToStart`.
- Unversioned activity queue has no pollers.

Root cause:

- Older Temporal Bun SDK builds could emit activity commands without forcing workflow build routing.

Status:

- Fixed in current code path (`packages/temporal-bun-sdk/src/workflow/commands.ts` uses `useWorkflowBuildId: true`).

Actions:

- Ensure deployed Bumba image contains the fixed SDK.
- If old runs are stuck, sync routing and migrate running executions as needed.

## Failure Mode 3: Event-Consumer Starvation on Nonterminal Ingestions

Symptoms:

- `bumba` looks idle.
- `atlas.github_events` has old `processed_at IS NULL` rows.
- Few old events block newer events from dispatch.

Root cause:

- Consumer waits when an event already has nonterminal ingestions.
- Default stale threshold is long (`BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS`, default 12h).

How to confirm:

```bash
kubectl cnpg psql -n jangar jangar-db -- -d jangar -c "
with pending as (
  select id, delivery_id, repository, received_at
  from atlas.github_events
  where processed_at is null
),
running as (
  select event_id, count(*) as running_cnt, min(started_at) as oldest_started
  from atlas.ingestions
  where status in ('accepted','running')
  group by event_id
)
select p.id, p.delivery_id, p.repository, p.received_at, r.running_cnt, r.oldest_started
from pending p
left join running r on r.event_id = p.id
order by p.received_at asc;
"
```

Immediate recovery:

- Mark stale nonterminal rows `failed`.
- Then mark events `processed_at` if all ingestions are terminal.

Example (30m stale threshold):

```bash
kubectl cnpg psql -n jangar jangar-db -- -d jangar -c "
with stale as (
  update atlas.ingestions i
  set status='failed',
      error = case
        when i.error is null or i.error = '' then 'manual stale reconciliation'
        when i.error like 'manual stale reconciliation%' then i.error
        else i.error || ' | manual stale reconciliation'
      end,
      finished_at = coalesce(i.finished_at, now())
  where i.status not in ('completed','failed','skipped')
    and i.event_id in (select id from atlas.github_events where processed_at is null)
    and i.started_at < now() - interval '30 minutes'
  returning i.event_id
),
ready as (
  select distinct s.event_id as id from stale s
)
update atlas.github_events e
set processed_at = now()
where e.id in (
  select r.id
  from ready r
  where not exists (
    select 1 from atlas.ingestions i
    where i.event_id = r.id
      and i.status not in ('completed','failed','skipped')
  )
);
"
```

Prevention:

- Reduce `BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS` from 12h to an operationally safe lower value.
- Alert on nonterminal ingestions older than threshold.

## Failure Mode 4: Bootstrap `upsertIngestion` Failure Leaves Stale State (Fixed)

Symptoms:

- Workflow fails very early.
- `atlas.ingestions` can stay `running` for the same `workflow_id`.

Root cause (pre-fix):

- Initial `upsertIngestion(status='running')` could fail before failure-finalization logic ran.

Fix:

- PR [#3505](https://github.com/proompteng/lab/pull/3505), merge commit `d32f478a3e3872533f221e505c1c9ede17662d55`.
- File: `services/bumba/src/workflows/index.ts`.
- Regression tests: `services/bumba/src/workflows/index.test.ts`.

If observed on older deployments:

- Reconcile stale rows (Failure Mode 3 recovery SQL).
- Deploy a build that includes PR #3505.

## Failure Mode 5: `already_exists` Start Errors

Symptoms:

- Logs contain:
  - `failed to start enrichFile workflow`
  - `[already_exists] Workflow execution is already running`
  - `retaining event for retry after dispatch failures`

Meaning:

- Usually benign duplicate-start collisions.
- Workflow IDs are deterministic per `(delivery_id, file_path)`, so duplicate starts collide by design.

When to act:

- Act only when starts fail for reasons other than `already_exists`.
- If repeated attempts show `started=0`, inspect Temporal availability/routing immediately.

## Failure Mode 6: Consumer Not Running / Disabled

Symptoms:

- No workflows triggered despite new webhook rows.
- Readiness reports consumer unhealthy.

Checks:

```bash
kubectl logs -n jangar deploy/bumba --since=15m | rg -n "event-consumer|disabled|tick failed"
kubectl exec -n jangar deploy/bumba -- wget -qO- http://127.0.0.1:3001/readyz
```

Expected:

- `consumer.required=true`, `consumer.running=true`, `status=ok` when enabled.

Main knobs:

- `BUMBA_GITHUB_EVENT_CONSUMER_ENABLED`
- `BUMBA_GITHUB_EVENT_POLL_INTERVAL_MS`
- `BUMBA_GITHUB_EVENT_BATCH_SIZE`
- `BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS`

## Failure Mode 7: GitHub Review Worktree Snapshot Refresh Failures (Not Bumba)

Symptoms:

- Logs:
  - `[github-review-ingest] worktree snapshot refresh failed`
  - `Unable to resolve git ref: <ref>`

Root cause:

- Missing/deleted head ref (for example, stale PR head branch or release ref).
- Jangar intentionally backs off repeated refresh attempts for missing refs.

Impact:

- Affects GitHub review snapshot enrichment.
- Does **not** directly block Bumba Temporal workflow dispatch.

Code references:

- `services/jangar/src/server/github-review-ingest.ts`
- `services/jangar/src/server/github-review-handlers.ts`
- `services/jangar/src/server/__tests__/github-review-ingest.test.ts`

## Workflow-Level Debug (Single Run)

Given a UI URL:

`http://temporal/namespaces/default/workflows/<workflowId>/<runId>/history`

Inspect status + failure:

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  workflow describe --workflow-id "<workflowId>" --run-id "<runId>"
```

Dump history and inspect timeout events:

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  workflow show --workflow-id "<workflowId>" --run-id "<runId>" --output json > /tmp/wf.json

jq '.events[] | select(.eventType=="EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT")' /tmp/wf.json
```

Interpretation:

- `ScheduleToStart timeout`: queue routing/poller availability issue.
- `ScheduleToClose` with `StartToClose` cause: activity started, then timed out while running or retrying.

## Operational Guardrails (Recommended)

- Add alert on `atlas.ingestions` nonterminal age over threshold.
- Add alert when `atlas.github_events` `processed_at IS NULL` oldest age exceeds SLO.
- Add deploy-time routing sync for Bumba task queue.
- Keep this runbook updated whenever incident response introduces a new mitigation path.
