# Private registry

The registry keeps its existing single `registry-data` claim. HAProxy shares one
10 MiB/s upload budget across every mutation using a constant stick-table key.
Up to 32 blob requests can stream concurrently. Serializing them behind one
writer makes cold image/cache uploads wait long enough for clients to disconnect.

Manifest commits use a separate four-connection backend, and image reads use the
existing 100-connection backend. Client/server inactivity remains bounded at five
minutes. This bounds incoming payload traffic; it is not a bound on filesystem
metadata operations or total Ceph I/O.

The generated proxy ConfigMap has a content hash. Merge through required checks;
Argo rolls the existing single replica with its `Recreate` strategy. Expect a brief
registry interruption during that rollout. Keep image consumers on immutable
published artifacts. Recovery uses a reviewed Git revert and normal Argo sync;
do not change the claim or delete uploaded blobs.

Validate the traffic boundary with the deployed HAProxy version in an isolated
container. A slow upload holds its request open for eight seconds while three
16 MiB uploads run. The fixture uses four proxy threads. The test checks digests,
completion before the slow request, the aggregate upload budget, and concurrent
read access.

```sh
docker build -f argocd/applications/registry/tests/Dockerfile -t registry-pacing-test argocd/applications/registry
docker run --rm --network none --read-only --cap-drop ALL --tmpfs /tmp --tmpfs /control:uid=99,gid=99,mode=0770 --memory 128m --cpus 1 --pids-limit 128 registry-pacing-test
```

The same test fails with the former single-writer configuration and with a
per-stream limiter combined with concurrent writers.

The operator selected 10 MiB/s and waived the proposed sustained load trial.
This is a configured limit, not a measured shared-storage throughput ceiling.
Further increases require a coordinated 30-minute observation of current Ceph,
Kafka and database dependencies. Roll back to 5 MiB/s through GitOps if the higher
rate causes storage or Kafka stalls.

## Clean old images

`registry-cleanup` runs daily at **03:23 America/Los_Angeles**. One controller snapshots the configured image owners
and starts one worker in the existing `registry-maintenance` container. Progress streams into the Job log.
No helper Pod, registry restart, Argo hold or Deployment patch is part of a cleanup run.

The worker prepares with uploads open, refreshes workload and retained Kargo references, then closes the proxy's write
gate and drains accepted uploads. Reads remain available. Frozen validation and quarantine share a four-minute budget.
Uploads reopen before receipted quarantine files are physically deleted. The gate is persisted before it closes so a
proxy restart cannot reopen writes during quarantine. The Distribution listener binds only to loopback to prevent a
Pod-address bypass.

Keep at least five recent build tags per repository, all images uploaded within seven days, unknown human tags and
all images referenced by the explicit workload and retained Kargo protection contract. Retain platform manifests,
attestations and layers reachable from those roots. The existing claim, version 3 receipt identities and content checks
remain authoritative. An empty plan never closes the write gate.

The controller has list-only protection reads, access to the named claim and Pod exec. It cannot patch Argo or the
registry Deployment, or create and delete Pods. The worker holds one filesystem lock for its entire run. Interruption
cancels queued work and joins active filesystem tasks before writes reopen. If worker exit cannot be confirmed, the
controller reports failure and leaves the gate closed. A subsequent run recovers a stale gate only after acquiring the
same exclusive lock, then resumes durable quarantine purges.

See the [cleanup runbook](../../../docs/registry/manual-garbage-collection.md) for execution, recovery and native tests.
