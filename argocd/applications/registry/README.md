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
docker run --rm --network none --read-only --cap-drop ALL --tmpfs /tmp --memory 128m --cpus 1 --pids-limit 128 registry-pacing-test
```

The same test fails with the former single-writer configuration and with a
per-stream limiter combined with concurrent writers.

The operator selected 10 MiB/s and waived the proposed sustained load trial.
This is a configured limit, not a measured shared-storage throughput ceiling.
Further increases require a coordinated 30-minute observation of current Ceph,
Kafka and database dependencies. Roll back to 5 MiB/s through GitOps if the higher
rate causes storage or Kafka stalls.

## Clean old images

`registry-cleanup` runs daily at **03:23 America/Los_Angeles**. Its CronJob,
service account, permissions and scripts are committed with this Application.
Runs cannot overlap; failed runs are retained and are not automatically retried.
Kubernetes can start the most recent missed run up to 24 hours late after
maintenance suspension or a controller interruption. Older missed runs are skipped.
Each run resumes receipted quarantine purges, prepares online, refreshes protected
references, collects for at most four minutes and purges with uploads open.
An empty plan skips the read-only restart. Missing protected content or a failed
read of a configured image owner fails the run before collection.
If collection reaches its deadline after writing a durable receipt, the controller
restores uploads, releases its hold and purges the partial batch online. Completion
reports `collectionTimedOut: true`. A missing or invalid receipt fails the run.
Restoration allows five minutes for the registry's existing startup probes.
Online preparation allows 45 minutes for cold filesystem metadata scans. The Job
keeps its two-hour deadline and allows seven minutes for shutdown recovery.

Protection reads only the workload and release resources named in
`packages/scripts/src/registry/protected_resources.json`. RBAC grants list access
to those exact resources. Cleanup does not enumerate CRDs or read unrelated
operators such as Valkey. Maintenance writes are confined to namespace `registry`
and the named `registry` Application in namespace `argocd`.

Preparation validates retained blobs once while traversing their manifest graph;
the candidate scan skips those already protected blobs. If preparation fails, the
Job log includes its exit status and final diagnostics before collection can start.
Recent revision links retain only manifest payloads that still exist. Missing
content referenced by retained tags, protected images or image indexes fails the run.

Keep at least five recent build tags per repository, every image uploaded in the
last seven days, and all digests referenced by workload templates or retained Kargo
Freight, Stage history, and promotions. Preserve the platform manifests and
attestations reachable from retained image indexes. Leave unknown tags alone.
Retention recognizes bare hashes, `sha-*`, `kargo-sha-*` and run-qualified build tags.

Use the [cleanup runbook](../../../docs/registry/manual-garbage-collection.md).
Preparation runs while uploads remain available. An owned maintenance hold limits
the final read-only phase to validating current roots and atomically moving eligible
tags and old unreferenced blobs into quarantine. The controller removes its helper before
restoring uploads and Argo reconciliation. The committed maintenance container has
a read-only CAS mount and a writable quarantine subpath. It prepares plans and
frees quarantined blocks online without a separate RWO attachment. Preserve the claim and verify protected images, a
completed push, a full pull and reclaimed capacity.
