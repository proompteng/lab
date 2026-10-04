# Temporal worker runtime

This image adds CPU and memory reporting to Temporal's internal Go SDK workers. The upstream 1.31.2 server creates
workers without a system resource provider, so their SDK heartbeats report zero usage and the UI displays
"Missing Dependency". Worker heartbeats are already enabled; a dynamic configuration or UI setting cannot supply
the missing provider.

The build pins Temporal 1.31.2 at `19a774302c613da9adc4436ab14278ccdca8e0a5`, keeps Go SDK 1.41.1, and adds
`gopsutil` 4.24.8. The SDK discovers its resource provider through the workflow slot supplier's `HasSysInfoProvider`
interface. The adapter wraps the existing tuner, or reconstructs the SDK's fixed tuner from the existing execution
limits, and supplies one shared host collector. CPU and memory are fractions of the host's actual capacity. A
100-millisecond snapshot cache keeps workers sharing a process from resampling CPU counters against each other.
Sampling errors propagate to the SDK's heartbeat warnings.

The worker has no resource limits. Temporal's `contrib/sysinfo` 0.1.0 treats an unlimited Linux cgroup memory limit
as a finite denominator and reports an almost zero memory fraction. Version 0.1.1 retains that collector and also
raises the Temporal API dependency beyond the server's generated client contract. The host collector reads real
CPU and memory statistics directly, preserving the existing Temporal API version and avoiding an invented cgroup
percentage.

Slot limits, reservations, and poller settings retain their existing semantics. The UI identifies
the wrapped workflow supplier as `Custom`. It still reserves a fixed number of slots; resource-based automatic
concurrency is not enabled.

Only the `temporal-worker` Deployment consumes this image. Frontend, history, matching, schema tools, Cassandra, and
Elasticsearch retain their reviewed images and configuration. The runtime inherits upstream's image and entrypoint
and replaces `/usr/local/bin/temporal-server` with the patched binary.

## Worker Deployment routing

The routing patch fixes a race between the deployment workflow's signal listener and continue-as-new. Go SDK 1.41.1
can reserve a signal in a blocked selector before `HasPending()` sees it. If an update finishes in the same workflow
task, the main coroutine can serialize the next run before the listener handles `propagation-complete`. The next run
then retains an already-completed routing revision indefinitely.

Before continuing as new, the patched workflow waits for an acknowledgment from that same listener and rechecks its
existing completion conditions. A workflow version marker preserves replay of existing histories. The patch does not
relax Bumba's `routingConfigUpdateState=COMPLETED` readiness gate.

Already-retained revisions need explicit reconciliation. A same-current `SetWorkerDeploymentCurrentVersion` request
with a fresh conflict token uses the existing deployment lock to preserve the current routing configuration. For each
retained version, an activity sends that unchanged configuration to every retained task queue and type, waits for
Matching's propagation check at the returned user-data version, and verifies the exact routing configuration by
readback. Only verified pending revisions at or below that configuration's revision are cleared. Version records,
workflow histories, drainage state, and pinned-workflow routing are preserved.

Each version's reconciliation has a two-minute schedule-to-close limit, including retries. An error leaves that
version's unverified revisions pending. Earlier versions that were fully verified may remain reconciled. A retry
therefore resumes the remaining work without clearing unverified state.

### Recover a retained propagation completion

1. Verify the reviewed worker image, successful image CI, exact Kargo Freight and promoted revision, and live worker
   image. Confirm that the intended current Bumba build has a healthy poller; task-queue membership alone is not proof
   of poller health. Record the exact deployment, build, routing revision, and pending state immediately before recovery.
2. Use the public `DescribeWorkerDeployment` response to obtain its current build and conflict token. Submit
   `SetWorkerDeploymentCurrentVersion` for that same build with that token, an authorized identity, and both
   `allowNoPollers=false` and `ignoreMissingTaskQueues=false`. For a managed deployment, use its manager identity.
   Temporal CLI 1.7.3 does not expose the conflict-token argument; use the repository SDK's deployment client.
3. Read back the same current build and routing revision, `routingConfigUpdateState=COMPLETED`, Bumba readiness,
   and recent workflow-task execution. Verify the application behavior required by the incident before closing it.

Bumba's current startup code only polls when the current build already matches. Its restart retries do not invoke
this recovery automatically. A different-current promotion retains its ordinary behavior. Recovery is an explicit
same-current operation and must not be combined with a routing change or bypass flags.

If the request times out, inspect the deployment and its internal workflow before retrying. The activity may still be
running. Keep the recovery-capable image until the internal recovery run has continued as new, including after a
partial failure. An older image cannot replay a run that has scheduled the new reconciliation activity. Do not roll
back to a pre-patch image during that run; either wait for its bounded completion and verify the next run's compatible
history, or use a rollback image that retains the recovery workflow code. Do not cancel, reset, terminate, or replace
internal workflow state to shorten this boundary.

## Validation

```sh
docker build --target evidence --output type=local,dest=.artifacts/temporal-worker services/temporal-worker
docker build -t temporal-worker-proof services/temporal-worker
docker run --rm --entrypoint temporal-server temporal-worker-proof --version
```

The tests prove fixed slot limits and provider sharing, then run an actual SDK worker against an isolated loopback
gRPC receiver. Its `RecordWorkerHeartbeat` request must contain memory usage matching the actual host within one
percentage point, memory above zero, and valid CPU usage.
The heartbeat test fails with the unmodified upstream factory because memory usage is zero. The receiver never
connects to the production cluster or starts a production workflow.

The routing image gate first runs the same-task signal regression against unmodified upstream routing code and
requires its retained-revision assertion to fail. It then applies the patch and runs the complete worker-deployment
tests and upstream replay corpus. Additional tests cover multiple queued signals, no signal, old version markers,
exact queue/type/version propagation checks, partial failure, timeouts, retries, managed identities, idempotence,
and concurrent routing changes.

The three routing replay fixtures were captured from an isolated Temporal 1.31.2 dev server with stub activities.
They cover successful reconciliation, a partial failure, and retry from the continued run. Replay compares the full
serialized continued state, including retained revisions. No production history is committed. To regenerate them
inside the pinned source tree with these test files, start a disposable server on `127.0.0.1:17233`, then run:

```sh
TEMPORAL_ROUTING_REPLAY_CAPTURE_ADDRESS=127.0.0.1:17233 \
  go test -count=1 -run '^TestCaptureRoutingReconciliationReplays$' ./service/worker/workerdeployment
```

The capture helper refuses non-loopback addresses. Normal tests only replay the saved fixtures and make no server
connection. The image evidence includes `routing-baseline.log`, `routing.log`, and the existing heartbeat proof.

## Delivery and live verification

The [image workflow](../../.github/workflows/temporal-worker-images.yml) tests and builds both native architectures.
Only successful `main` builds publish the immutable run-qualified Kargo alias. The `lab-delivery/temporal-worker`
Warehouse pairs the image receipt with its source commit; its Stage writes only the worker image entry and promotes
`kargo/temporal-worker`. The existing Temporal Argo Application follows that branch. Its retained upgrade resources
and automation remain part of the reviewed source.

An authorized rollout follows the [release contract](../../docs/release-automation.md). Verify the exact eligible
image, Freight, Stage commit, Argo revision, and worker pod image before checking the product behavior:

```sh
temporal --address temporal-grpc.ide-newton.ts.net:7233 --namespace default worker list --output json
temporal --address temporal-grpc.ide-newton.ts.net:7233 --namespace default worker describe \
  --worker-instance-key <new-worker-instance-key> --output json
```

Select the running `temporal-system@temporal-worker-...@default` worker. Within the normal 60-second heartbeat
interval, `hostInfo.currentHostMemUsage` must be above zero and CPU usage must be within zero to one. A CPU fraction
of zero is valid while idle and may be omitted from JSON. Open that new worker's UI page and confirm resource usage
appears and the dependency warning disappears. A restart changes the worker instance key, so the retired worker's
page is not proof of the new image.

For rollback, re-promote a previously verified Freight through Kargo only after satisfying the routing-history
compatibility boundary above. Keep recovery-compatible workflow code while a reconciliation run is in flight.
Do not directly change the live Deployment image.

Primary contracts: [host resource reporting](https://docs.temporal.io/cloud/worker-health#enable-host-resource-reporting),
[SDK 1.41.1 heartbeat provider lookup](https://github.com/temporalio/sdk-go/blob/v1.41.1/internal/internal_worker.go),
and [server 1.31.2 worker factory](https://github.com/temporalio/temporal/blob/v1.31.2/common/sdk/factory.go).
