# Temporal worker resource reporting

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

Slot limits, reservations, poller settings, and workflow behavior retain their existing semantics. The UI identifies
the wrapped workflow supplier as `Custom`. It still reserves a fixed number of slots; resource-based automatic
concurrency is not enabled.

Only the `temporal-worker` Deployment consumes this image. Frontend, history, matching, schema tools, Cassandra, and
Elasticsearch retain their reviewed images and configuration. The runtime inherits upstream's image and entrypoint
and replaces `/usr/local/bin/temporal-server` with the patched binary.

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

For recovery, re-promote a previously verified Freight through Kargo. For the initial enrollment, restore the reviewed
upstream worker image and Temporal's previous source revision through a reviewed Git change if the first release
fails. Do not directly change the live Deployment image.

Primary contracts: [host resource reporting](https://docs.temporal.io/cloud/worker-health#enable-host-resource-reporting),
[SDK 1.41.1 heartbeat provider lookup](https://github.com/temporalio/sdk-go/blob/v1.41.1/internal/internal_worker.go),
and [server 1.31.2 worker factory](https://github.com/temporalio/temporal/blob/v1.31.2/common/sdk/factory.go).
