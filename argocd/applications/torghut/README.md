# Torghut

This directory contains the Argo CD application resources for the `torghut` namespace.

## Live API and scheduler ownership

The Knative `Service/torghut` is a stateless API reader (`TORGHUT_PROCESS_ROLE=api`). It must never start trading or
reconciliation loops. `Deployment/torghut-scheduler` is the only workload configured with
`TORGHUT_PROCESS_ROLE=scheduler`; it uses `Recreate` rollout semantics and starts at zero replicas for P0a containment.
The API proxies `/trading/status` and `/metrics` to that scheduler and returns `503` when it is unavailable; it never
manufactures runtime state from its dormant local scheduler object.

Rollout is deliberately two-stage. First promote and prove the scheduler-free API image while the scheduler
Deployment remains at zero. Then perform the documented one-time emergency removal of legacy Knative revisions and
prove that no scheduler loop remains. Only after those checks pass may a follow-up GitOps change scale the advisory-
locked scheduler Deployment to one replica. Do not add a persistent revision-cleanup Job or combine those stages.
Do not restore `autoscaling.knative.dev/minScale` on the API template: the annotation is copied onto immutable
revisions and was the reason stale revisions remained hot. Activate the current API revision with an explicit request
when rollout proof needs a running pod.

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
