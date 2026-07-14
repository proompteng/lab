# Bumba and Temporal failure modes

Last updated: 2026-07-14

## Healthy data flow

1. Jangar records a default-branch push in `atlas.github_events`.
2. Bumba processes the oldest event for a repository and starts one `reconcileAtlasRepository` workflow.
3. The activity fetches the current `origin/main`, marks the one corpus `building`, and writes bounded batches under a
   fenced build ID.
4. A final transaction proves the complete Git manifest and embedding coverage, then marks the corpus `ready`.
5. The workflow makes the event's `atlas.ingestions` row terminal; only then may the consumer mark the event processed
   and advance to the next event for that repository.

Search is intentionally unavailable during `maintenance`, `building`, or `failed`. An available but stale corpus is not
a recovery mode.

All callers use one repository-scoped reconciliation workflow ID. A concurrent start must fail as already running; do
not work around that fence with a second workflow ID.

## Five-minute triage

```bash
export TEMPORAL_ADDRESS=temporal-grpc.ide-newton.ts.net:7233
export TEMPORAL_NAMESPACE=default

kubectl -n jangar get deploy bumba
kubectl -n jangar get pods -l app.kubernetes.io/name=bumba \
  -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,REASON:.status.containerStatuses[0].lastState.terminated.reason
kubectl -n jangar logs deploy/bumba --since=30m | tail -n 400

bun run packages/scripts/src/jangar/sync-temporal-routing.ts \
  --address "$TEMPORAL_ADDRESS" \
  --namespace "$TEMPORAL_NAMESPACE" \
  --task-queue bumba \
  --deployment-name bumba-deployment \
  --dry-run

kubectl cnpg psql -n jangar jangar-db -- -d jangar -c "
select name, default_ref, metadata
from atlas.repositories
where name = 'proompteng/lab';

select count(*) as unprocessed, min(received_at) as oldest
from atlas.github_events
where processed_at is null;

select status, count(*)
from atlas.ingestions
group by status
order by status;
"
```

Use an explicit namespace for every Kubernetes command.

## Routing is not complete

Symptoms:

- Bumba or Jangar remains unready after its Temporal poller starts.
- Logs report a current-build mismatch or routing propagation timeout.
- `routingConfigUpdateState` is not `COMPLETED`.
- New workflows remain scheduled without a workflow task start.

The worker itself selects its exact configured `TEMPORAL_WORKER_BUILD_ID` and waits for propagation before readiness or
event consumption. There is no bypass environment variable.

To select a known deployed build explicitly:

```bash
bun run packages/scripts/src/jangar/sync-temporal-routing.ts \
  --address "$TEMPORAL_ADDRESS" \
  --namespace "$TEMPORAL_NAMESPACE" \
  --task-queue bumba \
  --deployment-name bumba-deployment \
  --build-id '<build-id-from-the-running-worker-log>'
```

If propagation remains stuck, inspect Worker Deployment versions through the Temporal SDK or a current Temporal CLI.
A stale version may be deleted only when all of the following are proven:

- it is neither current nor ramping;
- its drainage state is `DRAINED`;
- no pinned workflow references it;
- a healthy poller exists on the intended current build.

Deleting the stale version should cause routing propagation to become `COMPLETED`. Never weaken the startup gate or use
the repository's pinned legacy CLI to infer Worker Deployment pollers; that CLI predates this API.

## Rebuild activity is running after its worker died

Symptoms:

- The Bumba container was `OOMKilled` or restarted.
- Temporal still reports a long-running `reconcileAtlasRepository` activity.
- The pending activity reports heartbeat timeout `0`, or no heartbeat time advances.
- Repository metadata remains `building` without increasing `preparedFiles`.

The hardened workflow schedules this activity with a 90-second heartbeat timeout. Its worker sends build ID, commit, and
persisted-file progress every 15 seconds. A new activity attempt reuses that heartbeat state and already committed batches.

For an old pre-heartbeat run, first prove that the worker attempt is dead. Terminate that exact workflow run with a reason;
do not start a duplicate while the original can still write. Deploy the heartbeat-capable worker, then start one rebuild:

```bash
bun run atlas:rebuild --repository proompteng/lab --ref main
```

The July 14 production incident followed this pattern: the worker retained thousands of prepared embeddings, was
OOM-killed, and Temporal could not detect the dead activity because its heartbeat timeout was zero. The accepted fix is
bounded batch persistence plus heartbeats, not a larger in-memory corpus or a second schema.

## Repository build lease is busy

Symptoms:

- An activity reports that another Atlas reconciliation is active.
- A later GitHub event waits behind an earlier event for the same repository.

This is expected serialization. Each batch checks the database build ID and target commit. Let the active workflow
finish or fail. A Temporal retry reuses its own build ID; an unrelated build can take over only after the database lease
expires. Do not clear the lease while its worker is alive.

## Event consumer is disabled

During cutover, this is expected:

```bash
kubectl -n jangar exec deploy/bumba -- printenv BUMBA_GITHUB_EVENT_CONSUMER_ENABLED
```

Keep the value `false` until a current-main rebuild and live `atlas:verify` both pass. When enabled, readiness must show
the consumer running. Main controls are:

- `BUMBA_GITHUB_EVENT_CONSUMER_ENABLED`
- `BUMBA_GITHUB_EVENT_POLL_INTERVAL_MS`
- `BUMBA_GITHUB_EVENT_BATCH_SIZE`
- `BUMBA_GITHUB_EVENT_MAX_DISPATCH_EVENTS_PER_TICK`
- `BUMBA_GITHUB_EVENT_MAX_DISPATCH_FAILURES`
- `BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS`

## Stale nonterminal ingestion

An event waits while its one reconciliation ingestion is nonterminal. Inspect exact workflow IDs before changing data:

```bash
kubectl cnpg psql -n jangar jangar-db -- -d jangar -c "
select e.delivery_id, e.repository, e.received_at,
       i.workflow_id, i.status, i.started_at, i.error
from atlas.github_events e
left join atlas.ingestions i on i.event_id = e.id
where e.processed_at is null
order by e.received_at, i.started_at;
"
```

If the Temporal run is still live, repair that run. If it is definitively closed and the ingestion row is stale, mark
only that row failed with an incident reason. The consumer will then settle the event. Never bulk-complete events merely
to clear a dashboard.

## `already_exists` on workflow start

The reconciliation workflow ID is deterministic per delivery. `already_exists` is benign when that exact workflow is
already recorded for the event; Bumba classifies it as already started. Other start failures remain retryable and keep
the event pending.

## Single-run inspection

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  workflow describe --workflow-id '<workflow-id>' --run-id '<run-id>'

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  workflow show --workflow-id '<workflow-id>' --run-id '<run-id>' --output json > /tmp/workflow-history.json
```

Interpretation:

- no workflow-task start: routing or poller failure;
- `ScheduleToStart` timeout: task-queue routing failure;
- heartbeat timeout after a pod exit: expected crash detection and activity retry;
- repeated activity failure with repository status `failed`: fix the concrete preparation, embedding, Git, or database
  error before retrying.
