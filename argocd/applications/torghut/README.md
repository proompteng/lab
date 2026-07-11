# Torghut

This directory contains the Argo CD application resources for the `torghut` namespace.

## Live API and scheduler ownership

The Knative `Service/torghut` is a stateless API reader (`TORGHUT_PROCESS_ROLE=api`). It must never start trading or
reconciliation loops. `Deployment/torghut-scheduler` is the only workload configured with
`TORGHUT_PROCESS_ROLE=scheduler`; it uses `Recreate` rollout semantics and starts at zero replicas for P0a containment.
The API proxies only the scheduler-owned `/trading/status` surface and returns `503` while the scheduler is unavailable.
API `/metrics` is process-local API health telemetry, not scheduler or writer proof. Scheduler metrics are exposed
directly by `Service/torghut-scheduler` and are intentionally unavailable while its Deployment has zero replicas.

Rollout is deliberately two-stage. First promote and prove the scheduler-free API image while the scheduler
Deployment remains at zero. Then perform the documented one-time emergency removal of legacy Knative revisions and
prove that no scheduler loop remains. Only after those checks pass may a follow-up GitOps change scale the advisory-
locked scheduler Deployment to one replica. Do not add a persistent revision-cleanup Job or combine those stages.
Do not restore `autoscaling.knative.dev/minScale` on the API template: the annotation is copied onto immutable
revisions and was the reason stale revisions remained hot. Activate the current API revision with an explicit request
when rollout proof needs a running pod.

### P0a one-time legacy Knative revision cleanup

This is a one-time, operator-run cleanup after the scheduler-free API image is synced. It is not a recurring retention
mechanism. Do not implement it as a `Job`, `CronJob`, Argo hook, init container, or controller. Never delete revisions
by label: the deletion list must be pinned and each legacy revision must be named explicitly.

Run the procedure from one Bash shell with `kubectl`, `jq`, `curl`, and the `kubectl cnpg` plugin available. Any failed
command or assertion is a stop gate: leave `Deployment/torghut-scheduler` at zero, delete nothing else, and investigate.
Save the command output and the exact deleted revision list in the incident or rollout record.

#### 1. Prove GitOps convergence and scheduler containment

```bash
set -euo pipefail

NS=torghut
KSVC=torghut
SCHEDULER=torghut-scheduler

fail() {
  echo "P0a cleanup blocked: $*" >&2
  exit 1
}

ARGO_SYNC="$(kubectl -n argocd get application torghut -o jsonpath='{.status.sync.status}')"
ARGO_HEALTH="$(kubectl -n argocd get application torghut -o jsonpath='{.status.health.status}')"
[[ "$ARGO_SYNC" == "Synced" && "$ARGO_HEALTH" == "Healthy" ]] \
  || fail "Argo application is sync=$ARGO_SYNC health=$ARGO_HEALTH"

SCHEDULER_JSON="$(kubectl -n "$NS" get deployment "$SCHEDULER" -o json)"
SCHEDULER_DESIRED="$(jq -r '.spec.replicas // 0' <<<"$SCHEDULER_JSON")"
SCHEDULER_CURRENT="$(jq -r '.status.replicas // 0' <<<"$SCHEDULER_JSON")"
SCHEDULER_READY="$(jq -r '.status.readyReplicas // 0' <<<"$SCHEDULER_JSON")"
SCHEDULER_AVAILABLE="$(jq -r '.status.availableReplicas // 0' <<<"$SCHEDULER_JSON")"
[[ "$SCHEDULER_DESIRED" == "0" && "$SCHEDULER_CURRENT" == "0" \
  && "$SCHEDULER_READY" == "0" && "$SCHEDULER_AVAILABLE" == "0" ]] \
  || fail "scheduler is not fully at zero"

SCHEDULER_PODS="$(
  kubectl -n "$NS" get pods -l app.kubernetes.io/component=trading-scheduler -o json \
    | jq '[.items[] | select(.status.phase != "Succeeded" and .status.phase != "Failed")] | length'
)"
[[ "$SCHEDULER_PODS" == "0" ]] || fail "scheduler pods still exist"

SCHEDULER_ENDPOINTS="$(
  kubectl -n "$NS" get endpointslices \
    -l kubernetes.io/service-name="$SCHEDULER" -o json \
    | jq '[.items[].endpoints[]?.addresses[]?] | length'
)"
[[ "$SCHEDULER_ENDPOINTS" == "0" ]] \
  || fail "scheduler Service still has endpoints"
```

The empty scheduler endpoint is expected at this stage. Do not probe API `/metrics` for scheduler leadership; it is the
wrong process. Do not continue if the Deployment spec is nonzero even when its pods happen to be absent.

#### 2. Pin the new ready revision and its only traffic target

```bash
read_ksvc_state() {
  KSVC_JSON="$(kubectl -n "$NS" get ksvc "$KSVC" -o json)"
  KSVC_UID="$(jq -r '.metadata.uid // ""' <<<"$KSVC_JSON")"
  KSVC_GENERATION="$(jq -r '.metadata.generation // 0' <<<"$KSVC_JSON")"
  KSVC_OBSERVED_GENERATION="$(jq -r '.status.observedGeneration // 0' <<<"$KSVC_JSON")"
  KSVC_URL="$(jq -r '.status.url // ""' <<<"$KSVC_JSON")"
  API_HOST="${KSVC_URL#*://}"
  API_HOST="${API_HOST%%/*}"
  LATEST_CREATED="$(jq -r '.status.latestCreatedRevisionName // ""' <<<"$KSVC_JSON")"
  LATEST_READY="$(jq -r '.status.latestReadyRevisionName // ""' <<<"$KSVC_JSON")"
  KSVC_READY="$(
    jq -r '[.status.conditions[]? | select(.type == "Ready")][0].status // ""' \
      <<<"$KSVC_JSON"
  )"
  TRAFFIC_OK="$(
    jq -r --arg revision "$LATEST_READY" '
      (.spec.traffic | length) == 1
      and .spec.traffic[0].latestRevision == true
      and (.spec.traffic[0].percent // 0) == 100
      and (.spec.traffic[0].tag // "") == ""
      and (.spec.traffic[0].revisionName // "") == ""
      and (.status.traffic | length) == 1
      and .status.traffic[0].latestRevision == true
      and (.status.traffic[0].percent // 0) == 100
      and .status.traffic[0].revisionName == $revision
      and (.status.traffic[0].tag // "") == ""
      and (.status.traffic[0].url // "") == ""
      and
      all(.status.traffic[]?; (.tag // "") == "" and (.url // "") == "")
    ' <<<"$KSVC_JSON"
  )"

  [[ -n "$KSVC_UID" ]] || fail "Knative Service UID is empty"
  [[ "$KSVC_GENERATION" == "$KSVC_OBSERVED_GENERATION" ]] \
    || fail "KService generation=$KSVC_GENERATION observed=$KSVC_OBSERVED_GENERATION"
  [[ -n "$LATEST_READY" ]] || fail "latestReadyRevisionName is empty"
  [[ -n "$API_HOST" ]] || fail "Knative Service URL/host is empty"
  [[ "$KSVC_READY" == "True" ]] || fail "Knative Service Ready=$KSVC_READY"
  [[ "$LATEST_CREATED" == "$LATEST_READY" ]] \
    || fail "latestCreated=$LATEST_CREATED differs from latestReady=$LATEST_READY"
  [[ "$TRAFFIC_OK" == "true" ]] \
    || fail "traffic is not one untagged 100% latestReady target=$LATEST_READY"
  if [[ -n "${PINNED_KSVC_UID:-}" ]]; then
    [[ "$KSVC_UID" == "$PINNED_KSVC_UID" ]] \
      || fail "KService UID changed during cleanup"
    [[ "$KSVC_GENERATION" == "$PINNED_KSVC_GENERATION" ]] \
      || fail "KService generation changed during cleanup"
  fi
}

read_ksvc_state
PINNED_KSVC_UID="$KSVC_UID"
PINNED_KSVC_GENERATION="$KSVC_GENERATION"
PINNED_LATEST_READY="$LATEST_READY"

jq '{
  uid: .metadata.uid,
  generation: .metadata.generation,
  observedGeneration: .status.observedGeneration,
  latestCreatedRevisionName: .status.latestCreatedRevisionName,
  latestReadyRevisionName: .status.latestReadyRevisionName,
  specTraffic: [.spec.traffic[]? | {revisionName, latestRevision, percent, tag}],
  statusTraffic: [.status.traffic[]? | {revisionName, latestRevision, percent, tag, url}],
  ready: [.status.conditions[]? | select(.type == "Ready")][0].status
}' <<<"$KSVC_JSON"
```

Do not proceed when a newer revision is unready, traffic is split, traffic points to an older revision, or
`latestCreatedRevisionName` changes during the procedure.

#### 3. Activate and inspect the scheduler-free API

The Knative API has no `minScale`; send real traffic through the local Knative gateway to activate the pinned
revision. The stable `Service/torghut` is an `ExternalName` Service and cannot itself be used with `kubectl
port-forward`. The gateway port-forward plus the KService `Host` header creates no Kubernetes workload.

```bash
LOCAL_PORT="${LOCAL_PORT:-18181}"
PF_LOG="$(mktemp)"
METRICS_BODY="$(mktemp)"
STATUS_BODY="$(mktemp)"

kubectl -n istio-system port-forward service/knative-local-gateway \
  "$LOCAL_PORT":80 >"$PF_LOG" 2>&1 &
PF_PID=$!
cleanup_probe() {
  kill "$PF_PID" 2>/dev/null || true
  wait "$PF_PID" 2>/dev/null || true
  rm -f "$PF_LOG" "$METRICS_BODY" "$STATUS_BODY"
}
trap cleanup_probe EXIT

for _ in $(seq 1 30); do
  if curl -fsS -H "Host: $API_HOST" \
    "http://127.0.0.1:$LOCAL_PORT/healthz" >/dev/null; then
    break
  fi
  sleep 2
done

curl -fsS -H "Host: $API_HOST" \
  "http://127.0.0.1:$LOCAL_PORT/healthz" | jq -e '.status == "ok"'
curl -fsS -H "Host: $API_HOST" \
  "http://127.0.0.1:$LOCAL_PORT/readyz" | jq -e '.status == "ok"'
curl -fsS -H "Host: $API_HOST" \
  "http://127.0.0.1:$LOCAL_PORT/metrics" >"$METRICS_BODY"
[[ -s "$METRICS_BODY" ]] || fail "API-local metrics response is empty"
grep -qx 'torghut_api_process_ready 1' "$METRICS_BODY" \
  || fail "API-local readiness metric is missing"
grep -qx 'torghut_process_role_info{role="api"} 1' "$METRICS_BODY" \
  || fail "API-local role metric is missing"
if grep -q '^torghut_scheduler_leadership_' "$METRICS_BODY"; then
  fail "API metrics incorrectly expose scheduler leadership"
fi

STATUS_CODE="$(
  curl -sS -H "Host: $API_HOST" -o "$STATUS_BODY" -w '%{http_code}' \
    "http://127.0.0.1:$LOCAL_PORT/trading/status"
)"
[[ "$STATUS_CODE" == "503" ]] \
  || fail "expected /trading/status=503 with scheduler at zero; got $STATUS_CODE"
jq -e '
  .detail == "scheduler_runtime_unavailable"
  and .owner == "torghut-scheduler"
' "$STATUS_BODY"

cleanup_probe
trap - EXIT

kubectl -n "$NS" wait --for=condition=Ready pod \
  -l serving.knative.dev/revision="$PINNED_LATEST_READY" --timeout=180s

API_PODS_JSON="$(
  kubectl -n "$NS" get pods \
    -l serving.knative.dev/revision="$PINNED_LATEST_READY" -o json
)"
API_POD_COUNT="$(
  jq '[.items[]
    | select(.status.phase == "Running")
    | select(any(.status.containerStatuses[]?;
        .name == "user-container" and .ready == true))] | length' \
    <<<"$API_PODS_JSON"
)"
[[ "$API_POD_COUNT" == "1" ]] \
  || fail "expected one ready pinned API pod; found $API_POD_COUNT"
API_POD="$(
  jq -r '.items[]
    | select(.status.phase == "Running")
    | select(any(.status.containerStatuses[]?;
        .name == "user-container" and .ready == true))
    | .metadata.name' <<<"$API_PODS_JSON"
)"

REVISION_JSON="$(kubectl -n "$NS" get revision "$PINNED_LATEST_READY" -o json)"
DESIRED_IMAGE="$(jq -r '.spec.template.spec.containers[] | select(.name == "user-container") | .image' <<<"$KSVC_JSON")"
REVISION_IMAGE="$(jq -r '.spec.containers[] | select(.name == "user-container") | .image' <<<"$REVISION_JSON")"
REVISION_ROLE="$(
  jq -r '.spec.containers[] | select(.name == "user-container")
    | .env[] | select(.name == "TORGHUT_PROCESS_ROLE") | .value' \
    <<<"$REVISION_JSON"
)"
[[ "$REVISION_IMAGE" == "$DESIRED_IMAGE" ]] \
  || fail "pinned revision image differs from the Knative Service template"
[[ "$REVISION_ROLE" == "api" ]] \
  || fail "pinned revision TORGHUT_PROCESS_ROLE=$REVISION_ROLE"

jq '{
  revision: .metadata.name,
  image: [.spec.containers[] | select(.name == "user-container") | .image][0],
  env: [.spec.containers[] | select(.name == "user-container") | .env[]
    | select(.name | test("^(TORGHUT_PROCESS_ROLE|TRADING_ENABLED|TRADING_MODE|TRADING_SCHEDULER_RUNTIME_BASE_URL|APCA_API_BASE_URL)$"))]
}' <<<"$REVISION_JSON"

POD_ROLE="$(
  kubectl -n "$NS" exec "$API_POD" -c user-container -- \
    printenv TORGHUT_PROCESS_ROLE
)"
[[ "$POD_ROLE" == "api" ]] || fail "running pod role=$POD_ROLE"

API_LOGS="$(mktemp)"
kubectl -n "$NS" logs "$API_POD" -c user-container --since=30m >"$API_LOGS"
grep -q 'background_worker_owner=external' "$API_LOGS" \
  || fail "API did not report external background-worker ownership"
if grep -Eq 'Trading scheduler (starting|loop running)' "$API_LOGS"; then
  fail "scheduler loop startup found in pinned API logs"
fi
rm -f "$API_LOGS"
```

`/healthz`, `/readyz`, and API-local `/metrics` must succeed. `/trading/status` must fail closed with `503` because the
scheduler is deliberately absent. A `200` status response at this point is evidence of another scheduler and blocks
cleanup.

#### 4. Freeze and delete only the legacy revisions

Re-read the Service immediately before inventory and deletion. The pinned revision and traffic assertions must still
hold. Preflight delete permission, print the exact inventory, and record it before continuing.

```bash
read_ksvc_state
[[ "$LATEST_READY" == "$PINNED_LATEST_READY" ]] \
  || fail "latestReady changed after API proof"
[[ "$(kubectl auth can-i delete revisions.serving.knative.dev -n "$NS")" == "yes" ]] \
  || fail "current identity cannot delete Knative revisions"

kubectl -n "$NS" get revisions \
  -l serving.knative.dev/service="$KSVC" \
  -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp,READY:.status.conditions[?(@.type=="Ready")].status'

REVISIONS_JSON="$(
  kubectl -n "$NS" get revisions \
    -l serving.knative.dev/service="$KSVC" -o json
)"
LEGACY_REVISIONS="$(
  jq -r --arg keep "$PINNED_LATEST_READY" '
    [.items[] | select(.metadata.name != $keep)]
    | sort_by(.metadata.creationTimestamp)
    | .[].metadata.name
  ' <<<"$REVISIONS_JSON"
)"

echo "Pinned revision: $PINNED_LATEST_READY"
printf 'Legacy revisions approved for one-time deletion:\n%s\n' \
  "${LEGACY_REVISIONS:-<none>}"
```

If the printed list is wrong, empty unexpectedly, or contains the pinned revision, stop. Run the following deletion
block once. It intentionally has no label-based delete and rechecks latest-ready and traffic state before every
revision.

```bash
while IFS= read -r revision; do
  [[ -n "$revision" ]] || continue
  [[ "$revision" != "$PINNED_LATEST_READY" ]] \
    || fail "refusing to delete pinned revision"

  read_ksvc_state
  [[ "$LATEST_READY" == "$PINNED_LATEST_READY" ]] \
    || fail "latestReady changed before deleting $revision"
  jq -e --arg revision "$revision" '
    all(.status.traffic[]?;
      .revisionName != $revision and (.tag // "") == "" and (.url // "") == "")
  ' <<<"$KSVC_JSON" >/dev/null \
    || fail "legacy revision $revision remains directly routable"

  kubectl -n "$NS" delete revision "$revision" --wait=true
  LEGACY_PODS="$(
    kubectl -n "$NS" get pods \
      -l serving.knative.dev/revision="$revision" -o name
  )"
  if [[ -n "$LEGACY_PODS" ]]; then
    kubectl -n "$NS" wait --for=delete $LEGACY_PODS --timeout=180s
  fi
done <<<"$LEGACY_REVISIONS"
```

Do not take a fresh list and rerun the deletion block. If the Knative Service changes, stop and begin a new reviewed
rollout procedure; do not expand this cleanup transaction.

#### 5. Prove one API revision and zero scheduler writers

```bash
read_ksvc_state
[[ "$LATEST_READY" == "$PINNED_LATEST_READY" ]] \
  || fail "latestReady changed during cleanup"

FINAL_REVISIONS_JSON="$(
  kubectl -n "$NS" get revisions \
    -l serving.knative.dev/service="$KSVC" -o json
)"
FINAL_REVISION_COUNT="$(jq '.items | length' <<<"$FINAL_REVISIONS_JSON")"
FINAL_REVISION_NAME="$(jq -r '.items[0].metadata.name // ""' <<<"$FINAL_REVISIONS_JSON")"
[[ "$FINAL_REVISION_COUNT" == "1" \
  && "$FINAL_REVISION_NAME" == "$PINNED_LATEST_READY" ]] \
  || fail "revision inventory is not exactly the pinned latestReady revision"

NONLATEST_API_PODS="$(
  kubectl -n "$NS" get pods \
    -l serving.knative.dev/service="$KSVC" -o json \
    | jq --arg keep "$PINNED_LATEST_READY" '
        [.items[]
          | select(.metadata.labels["serving.knative.dev/revision"] != $keep)
          | select(.status.phase != "Succeeded" and .status.phase != "Failed")]
        | length'
)"
[[ "$NONLATEST_API_PODS" == "0" ]] || fail "non-latest API pods remain"

SCHEDULER_JSON="$(kubectl -n "$NS" get deployment "$SCHEDULER" -o json)"
[[ "$(jq -r '.spec.replicas // 0' <<<"$SCHEDULER_JSON")" == "0" \
  && "$(jq -r '.status.replicas // 0' <<<"$SCHEDULER_JSON")" == "0" \
  && "$(jq -r '.status.readyReplicas // 0' <<<"$SCHEDULER_JSON")" == "0" \
  && "$(jq -r '.status.availableReplicas // 0' <<<"$SCHEDULER_JSON")" == "0" ]] \
  || fail "scheduler Deployment is no longer fully at zero"

SCHEDULER_PODS="$(
  kubectl -n "$NS" get pods -l app.kubernetes.io/component=trading-scheduler -o json \
    | jq '[.items[] | select(.status.phase != "Succeeded" and .status.phase != "Failed")] | length'
)"
[[ "$SCHEDULER_PODS" == "0" ]] || fail "scheduler pods exist after cleanup"

SCHEDULER_ENDPOINTS="$(
  kubectl -n "$NS" get endpointslices \
    -l kubernetes.io/service-name="$SCHEDULER" -o json \
    | jq '[.items[].endpoints[]?.addresses[]?] | length'
)"
[[ "$SCHEDULER_ENDPOINTS" == "0" ]] || fail "scheduler endpoints exist after cleanup"

# DEFAULT_SCHEDULER_ADVISORY_LOCK_ID=-5582680098985332512 is represented
# by classid=2995148295, objid=1029058784, objsubid=1 in pg_locks.
WRITER_LOCK_COUNT="$(
  kubectl cnpg psql -n "$NS" torghut-db -- \
    -d torghut -At -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = '2995148295'::oid
          AND objid = '1029058784'::oid
          AND objsubid = 1
          AND granted;"
)"
[[ "$WRITER_LOCK_COUNT" == "0" ]] \
  || fail "scheduler advisory writer lock count=$WRITER_LOCK_COUNT"

kubectl -n "$NS" get ksvc "$KSVC" -o wide
kubectl -n "$NS" get revisions \
  -l serving.knative.dev/service="$KSVC" -o wide
kubectl -n "$NS" get deployment "$SCHEDULER" -o wide
echo "P0a cleanup proof passed: latest=$PINNED_LATEST_READY scheduler=0 writers=0"
```

If CNPG access is denied or any proof query is unavailable, the gate is not satisfied. Do not infer zero writers from
an absent metrics series. Keep the scheduler at zero until all checks can be rerun successfully. Scaling the dedicated
scheduler to one is a separate GitOps change after this cleanup proof is recorded.

The API and scheduler currently keep explicit environment entries so the live direct-env safety contract remains
auditable. `test_single_writer_scheduler_manifest.py` enforces exact parity except for the process role and the two
scheduler-only leadership settings; migrate both manifests to one typed generated source in a follow-up without
weakening that contract.

## TA replay workflow (canonical)

This is the single, canonical TA replay/backfill workflow that oncall should follow (and that an AgentRun can later
automate via PR + Argo sync). Other docs should link here instead of duplicating steps.

## Historical simulation workflow (GitOps controlled)

The Argo WorkflowTemplate `torghut-historical-simulation` is now managed as part of
`argocd/applications/torghut`.

The empirical workflow depends on the namespace-local sealed secret
`rook-ceph-rgw-argo-workflows` for Argo archive-log uploads. Keep that secret managed here so
workflow submissions in `torghut` do not rely on manual secret copies from `argo-workflows`.

The live TigerBeetle journal CronJob uses small supervised source slices. Keep the execution batch and order-event
max-batch settings conservative enough to finish under the watchdog; failed slices block the runtime ledger gate.

Trigger a simulation run via Argo:

```bash
argo submit --from workflowtemplate/torghut-historical-simulation -n argo-workflows \
  --parameter mode=plan \
  --parameter runId=sim-2026-02-28-01 \
  --parameter datasetManifestB64="$(base64 -w0 services/torghut/config/simulation/example-dataset.yaml)"
```

Apply/run mode:

```bash
argo submit --from workflowtemplate/torghut-historical-simulation -n argo-workflows \
  --parameter mode=apply \
  --parameter runId=sim-2026-02-28-01 \
  --parameter datasetManifestB64="$(base64 -w0 services/torghut/config/simulation/example-dataset.yaml)" \
  --parameter confirmPhrase=START_HISTORICAL_SIMULATION
```

Teardown mode:

```bash
argo submit --from workflowtemplate/torghut-historical-simulation -n argo-workflows \
  --parameter mode=teardown \
  --parameter runId=sim-2026-02-28-01 \
  --parameter datasetManifestB64="$(base64 -w0 services/torghut/config/simulation/example-dataset.yaml)"
```

The workflow output root can be overridden with `outputRoot` and replay/reapply behavior can be controlled with
`forceReplay` / `forceDump`.

By default, the workflow now targets the dedicated simulation surfaces managed in this app:
`Service/torghut-sim`, `FlinkDeployment/torghut-ta-sim`, and `ConfigMap/torghut-ta-sim-config`.
Supply explicit `runtime.*` overrides in the dataset manifest only when you intentionally need different
resource names.

### Argo Rollouts gate plane

Simulation gating now uses Argo Rollouts in phase 1:

- sync the platform app `argo-rollouts` before using the simulation workflow
- verify the Rollouts controller and CRDs are healthy
- keep `torghut-historical-simulation` as the orchestrator in `argo-workflows`
- use namespaced `AnalysisTemplate` / `AnalysisRun` resources in `torghut` for:
  - runtime readiness
  - activity success classification
  - teardown cleanliness

Phase 1 does not migrate `torghut-sim` or `torghut-ta-sim` to `Rollout` kinds. The dedicated simulation workloads
remain:

- Knative `Service/torghut-sim`
- `FlinkDeployment/torghut-ta-sim`

Required namespaced AnalysisTemplates:

- `torghut-simulation-runtime-ready`
- `torghut-simulation-activity`
- `torghut-simulation-teardown-clean`
- `torghut-simulation-artifact-bundle`

Canonical operator flow:

1. Sync Argo CD app `argo-rollouts`.
2. Verify Rollouts CRDs/controller are healthy.
3. Sync Argo CD app `torghut`.
4. Verify the AnalysisTemplates exist in namespace `torghut`.
5. Submit `torghut-historical-simulation`.
6. Observe both the Argo Workflow phases and the `AnalysisRun` objects in `torghut`.
7. Treat the `AnalysisRun` outcomes as the authoritative simulation gate results.

Quick checks:

```bash
kubectl get crd analysisruns.argoproj.io analysistemplates.argoproj.io -o name
kubectl get analysistemplate -n torghut
kubectl get analysisrun -n torghut
```

### Scope / target resources (as deployed)
- Kubernetes namespace: `torghut`
- Flink TA job: `FlinkDeployment/torghut-ta-sim` (`argocd/applications/torghut/ta-sim/flinkdeployment.yaml`)
- TA config: `ConfigMap/torghut-ta-sim-config` (`argocd/applications/torghut/ta-sim/configmap.yaml`)
- Trading service: Knative `Service/torghut-sim` (`argocd/applications/torghut/knative-service-sim.yaml`)
- Simulation gates: `AnalysisTemplate/*` and `AnalysisRun/*` in namespace `torghut`
- DB migration gate: `Job/torghut-db-migrations` (`argocd/applications/torghut/db-migrations-job.yaml`, Argo `PreSync` hook)
- Kafka namespace/tools: `kafka` (Strimzi); bootstrap `kafka-kafka-bootstrap.kafka:9092`
- Ceph RGW bucket: `ObjectBucketClaim/flink-checkpoints` (for Flink checkpoint/savepoint storage)

Kafka topics (v1):
- Inputs: `torghut.trades.v1`, `torghut.quotes.v1`, `torghut.bars.1m.v1`
- Outputs (derived): `torghut.ta.bars.1s.v1`, `torghut.ta.signals.v1`
- Status: `torghut.ta.status.v1`

Market-data freshness smoke:

```bash
MARKET_DATA_PRINT_SUMMARIES=false bun run smoke:torghut-market-data
```

The smoke tails Kafka through the Strimzi broker using Kubernetes Secret refs, fetches in-cluster WS/Torghut/Flink
surfaces through the TA pod by default, and fails during regular market hours when WS channels, Kafka source topics, TA
heartbeat, or accepted-source freshness are stale. Use `MARKET_DATA_FRESHNESS_MODE=observe` for after-hours diagnostics
without claiming regular-session proof.

### Replay window constraints (what can be replayed)
Replay is constrained by **both** Kafka retention (inputs) and ClickHouse TTL (outputs):
- **Kafka retention (inputs) is the hard limit:** if events aged out of Kafka, TA cannot replay them. v1 expected
  retention is **7–30 days** for ingest topics; confirm actual broker settings before assuming older data exists.
  See `docs/torghut/design-system/v1/component-kafka-topics-and-retention.md`.
- **ClickHouse TTL (outputs) limits how long replayed results persist:**
  - `ta_microbars`: TTL 30 days
  - `ta_signals`: TTL 14 days

If you replay data older than the ClickHouse TTL, it may be deleted during merges shortly after replay (see
`docs/torghut/design-system/v1/component-clickhouse-capacity-ttl-and-disk-guardrails.md`).
Record the planned replay start/end timestamps in your ticket and confirm they fit within both windows.

### Replay workflow runner script (non-destructive mode)

Use the replay runner for deterministic plan output and optional scripted actuation:

```bash
python3 services/torghut/scripts/ta_replay_runner.py --replay-id 2026-02-13-torghut-ops --mode plan
```

For profitability-proof replay work, run both read-only preflights and inspect the machine-readable
`replay_feasibility` verdict before any actuation:

```bash
python3 services/torghut/scripts/ta_replay_runner.py \
  --replay-id proof-coverage-check \
  --mode plan \
  --json \
  --check-clickhouse-coverage \
  --check-kafka-retention \
  --required-trading-days 25
```

When the preflights are supplied to `--mode apply`, the helper now fails closed unless
`replay_feasibility.non_destructive_replay_admission` is `true`. If `exact_replay_capture_ready` is already `true`,
capture exact replay/runtime-ledger artifacts instead of replaying. If the verdict is blocked by source retention,
missing preflights, or ClickHouse TTL, do not start replay; wait for new signal days, restore an archive-backed source,
or capture artifacts through an approved archive path.

To execute the same steps with kubectl patches (non-destructive mode only):

```bash
python3 services/torghut/scripts/ta_replay_runner.py \
  --replay-id 2026-02-13-torghut-ops \
  --mode apply \
  --confirm REPLAY_TA_CANARY
```

This script intentionally keeps defaults conservative and does not automate destructive Mode 2 actions.

### Safety gates (read first)
- **Trading safety (prerequisite):** if there is any uncertainty about signal correctness (stale/corrupt/partial), pause
  trading first and keep it paused until verification passes.
  - set `spec.replicas: 0` in `argocd/applications/torghut/scheduler-deployment.yaml`
  - keep `TRADING_MODE=paper` unless the recovery explicitly requires live mode
- **Unique consumer group required (hard requirement):** every replay/backfill must use a **new** `TA_GROUP_ID`
  (consumer-group isolation). Never reuse an old replay group id.
- **GitOps-first:** prefer changing manifests under `argocd/applications/torghut/**` and syncing via Argo CD.
  Emergency-only `kubectl patch` is allowed, but reconcile back to GitOps immediately after.
- **Not “one button destructive”:** default to Mode 1 (non-destructive). Mode 2 is explicitly destructive and requires an
  additional confirmation step + a recorded ticket/incident reference.

### Safety prerequisites and confirmations
Before touching the TA job or Kafka topics, record the following in your ticket/incident:
- `REPLAY_ID` (unique id used in group id + any backups), example: `2026-02-09T0315Z-INC1234`
- `PREV_TA_GROUP_ID` (current steady-state group id from `argocd/applications/torghut/ta/configmap.yaml`)
- `PREV_TA_AUTO_OFFSET_RESET` (current steady-state offset reset policy)
- Confirmation that trading is paused (or explicitly confirmed safe for paper-only replay)
- Confirmation of replay window feasibility (Kafka retention vs ClickHouse TTL; see above)
- If Mode 2 is required: explicit human approval + acknowledgement of destructive steps

### Inputs to capture (for rollback)
- `PREV_TA_GROUP_ID` (current steady-state group id from `argocd/applications/torghut/ta/configmap.yaml`)
- `PREV_TA_AUTO_OFFSET_RESET` (current steady-state offset reset policy)
- `REPLAY_ID` (unique id used in group id + any backups), example: `2026-02-09T0315Z-INC1234`
- Current TA job state: `running` vs `suspended`

### Mode 1 (recommended): Non-destructive replay/backfill (consumer-group isolation)
Goal: recompute TA outputs from retained Kafka inputs without deleting topics or Flink state.

1) Pause trading (recommended; required if signal correctness is uncertain)
   - `argocd/applications/torghut/scheduler-deployment.yaml`: set `spec.replicas: 0`, then Argo sync.
2) Suspend TA to stop writes while you switch group id
   - GitOps-first: set `spec.job.state: suspended` in `argocd/applications/torghut/ta/flinkdeployment.yaml`, then Argo sync.
   - Emergency-only:
     ```
     kubectl -n torghut patch flinkdeployment torghut-ta --type=merge -p '{"spec":{"job":{"state":"suspended"}}}'
     ```
3) Set a **fresh** replay consumer group + replay policy
   - Edit `argocd/applications/torghut/ta/configmap.yaml`:
     - `TA_GROUP_ID: "torghut-ta-replay-<REPLAY_ID>"`
     - `TA_AUTO_OFFSET_RESET: "earliest"`
   - Confirm the new `TA_GROUP_ID` has never been used before; never reuse an old replay group id.
4) Restart and resume TA (required to pick up ConfigMap env changes)
   - GitOps-first:
     - bump `spec.restartNonce` in `argocd/applications/torghut/ta/flinkdeployment.yaml`
     - set `spec.job.state: running`
     - Argo sync
   - Emergency-only restart nonce bump:
     ```
     kubectl -n torghut patch flinkdeployment torghut-ta --type=merge -p '{"spec":{"restartNonce":<bump>}}'
     ```
5) Verify replay progress and correctness (keep trading paused until green)
   - FlinkDeployment health:
     - `kubectl -n torghut get flinkdeployment torghut-ta`
   - ClickHouse freshness (examples):
     - `SELECT max(event_ts) FROM torghut.ta_signals WHERE symbol='NVDA';`
     - `SELECT max(event_ts) FROM torghut.ta_microbars WHERE symbol='NVDA';`
   - Expected behavior: lag will be high initially and should trend down toward real-time.

Notes:
- This mode may temporarily increase ClickHouse write volume and disk usage (replay inserts). Tables are designed for
  at-least-once and dedup via `ReplacingMergeTree`, but merges are not instantaneous.
- If you need a truly clean window (no duplicates / no stale partitions), treat that as a **separate explicitly
  destructive action** and follow `docs/torghut/design-system/v1/operations-ta-replay-and-recovery.md` plus ClickHouse
  change control.

### Mode 2 (emergency only): Destructive “replay from scratch”
This mode deletes derived Kafka topics and Flink checkpoint/savepoint state. Only use when Mode 1 is insufficient (for
example, corrupted checkpoint directory or irrecoverable derived-topic issues).

Before starting, get explicit human confirmation that the following are acceptable:
- Deleting/recreating **derived** topics: `torghut.ta.bars.1s.v1`, `torghut.ta.signals.v1`
- Deleting Flink checkpoint/savepoint directories under `s3a://flink-checkpoints/torghut/technical-analysis/...`

0) Pause trading (required)
- Set `spec.replicas: 0` in `argocd/applications/torghut/scheduler-deployment.yaml` and Argo sync.

1) Suspend the job (same as Mode 1)

2) Back up Flink state directories (so rollback is possible)
Precheck: identify a pod with S3 tooling available (`aws` CLI is simplest).
```
kubectl -n torghut get pods
```

Backup (example; use a unique prefix per replay):
```
kubectl -n torghut exec <pod-with-aws-cli> -- aws --endpoint-url http://rook-ceph-rgw-objectstore.rook-ceph.svc:80 s3 cp --recursive \
  s3://flink-checkpoints/torghut/technical-analysis/checkpoints \
  s3://flink-checkpoints/torghut/technical-analysis/backup/<replay-id>/checkpoints

kubectl -n torghut exec <pod-with-aws-cli> -- aws --endpoint-url http://rook-ceph-rgw-objectstore.rook-ceph.svc:80 s3 cp --recursive \
  s3://flink-checkpoints/torghut/technical-analysis/savepoints \
  s3://flink-checkpoints/torghut/technical-analysis/backup/<replay-id>/savepoints
```

3) Drop and recreate derived output topics (Kafka namespace `kafka`)
Precheck: identify a Kafka pod that has `kafka-topics.sh` available.
```
kubectl -n kafka get pods
```

```
kubectl -n kafka exec <kafka-pod> -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka-kafka-bootstrap.kafka:9092 \
  --delete --topic torghut.ta.bars.1s.v1

kubectl -n kafka exec <kafka-pod> -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka-kafka-bootstrap.kafka:9092 \
  --delete --topic torghut.ta.signals.v1

kubectl -n kafka exec <kafka-pod> -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka-kafka-bootstrap.kafka:9092 \
  --create --topic torghut.ta.bars.1s.v1 \
  --partitions 1 --replication-factor 3

kubectl -n kafka exec <kafka-pod> -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka-kafka-bootstrap.kafka:9092 \
  --create --topic torghut.ta.signals.v1 \
  --partitions 1 --replication-factor 3
```

4) Remove checkpoint/savepoint state directories (destructive; after backup only)
```
kubectl -n torghut exec <pod-with-aws-cli> -- aws --endpoint-url http://rook-ceph-rgw-objectstore.rook-ceph.svc:80 s3 rm --recursive \
  s3://flink-checkpoints/torghut/technical-analysis/checkpoints

kubectl -n torghut exec <pod-with-aws-cli> -- aws --endpoint-url http://rook-ceph-rgw-objectstore.rook-ceph.svc:80 s3 rm --recursive \
  s3://flink-checkpoints/torghut/technical-analysis/savepoints
```

5) Set a fresh replay consumer group and replay from the beginning (same requirement as Mode 1)
```
# argocd/applications/torghut/ta/configmap.yaml
TA_GROUP_ID: "torghut-ta-replay-<REPLAY_ID>"
TA_AUTO_OFFSET_RESET: "earliest"
```
Apply via GitOps (preferred), then restart via `spec.restartNonce` bump and set `spec.job.state: running`.

6) Verify replay progress and correctness (keep trading paused until green)
- FlinkDeployment health:
  - `kubectl -n torghut get flinkdeployment torghut-ta`
- ClickHouse freshness:
  - `SELECT max(event_ts) FROM torghut.ta_signals WHERE symbol='NVDA';`

### Rollback / recovery if replay fails
1) Stop the job:
   - Set `spec.job.state: suspended` (GitOps-first) or patch the FlinkDeployment.
2) Restore steady-state config (non-destructive rollback):
   - Revert `TA_GROUP_ID` to `PREV_TA_GROUP_ID` in `argocd/applications/torghut/ta/configmap.yaml`.
   - If you changed `TA_AUTO_OFFSET_RESET`, restore the previous value.
   - Bump `spec.restartNonce` in `argocd/applications/torghut/ta/flinkdeployment.yaml` to force restart.
   - Set `spec.job.state: running` and Argo sync.
3) If you used Mode 2 (deleted state), restore MinIO state from your backup prefix, then restart:
   - Copy `backup/<replay-id>/checkpoints` back to `.../checkpoints` in the `flink-checkpoints` bucket
   - Copy `backup/<replay-id>/savepoints` back to `.../savepoints` in the `flink-checkpoints` bucket
4) Verify with the checks above before unpausing trading.

If you performed destructive actions (topic deletion or ClickHouse deletion), rollback may require re-running the replay
or restoring from backups (see `docs/torghut/design-system/v1/disaster-recovery-and-backups.md`).
