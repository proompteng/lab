# Ofz

Ofz provides the central authorization API, independent audit exporter, shared SpiceDB service and official
SpiceDB Playground in the `ofz` namespace. The platform ApplicationSet owns the namespace. Kargo promotes
the immutable API image and complete reviewed configuration to `kargo/ofz`; Argo reconciles that branch.
The API begins fenced. Publishing this configuration does not establish a completed Tengri cutover.

## Components

| Component | Configuration |
| --- | --- |
| SpiceDB | Three replicas of upstream `v1.56.2`, pinned to its multi-architecture image digest |
| PostgreSQL | CNPG PostgreSQL 18.6, three instances, one required synchronous standby, 30 GiB per instance |
| Backups | Barman Cloud plugin, WAL archived within 60 seconds, daily base backup at 10:30 UTC, 35-day recovery window on Ceph S3 |
| Playground | Two replicas of upstream `v0.3.1`, pinned to its multi-architecture image digest |
| Authorization API | Two replicas, exact SPIFFE mTLS, SQL-backed sessions and policy commands |
| Audit exporter | Two replicas with one SQL lease, versioned COMPLIANCE archive on Ceph S3 |
| Browser endpoint | <https://ofz.ide-newton.ts.net>, through the lab's Tailscale ingress |
| SpiceDB API | `ofz.ofz.svc.cluster.local:50051` for gRPC and port `8443` for the HTTP gateway |

Playground runs SpiceDB and the `zed` CLI in the browser through WebAssembly. Its schemas, test relationships, and
assertions are independent of the live service. It receives no SpiceDB credentials. Use its download and import
controls to preserve work. Shared-link storage and an admin interface for the live database are not provisioned.

The upstream Playground image runs with a non-root user and a read-only filesystem. `playground-nginx.conf` replaces
its entrypoint-generated Nginx configuration so only `/tmp` needs a writable mount.

These are upstream platform images. Reviewed changes pin their versions and digests directly, as with the SpiceDB
operator. Their upstream versions remain pinned in source; the repository-owned API and exporter image follows Kargo.

## Credentials and data

CNPG generates `ofz-db-app`. The SpiceDB operator reads its `uri` key directly. Both migration jobs and serving pods
verify PostgreSQL's TLS certificate with `ofz-db-ca`. `track_commit_timestamp=on` enables the SpiceDB Watch API.

The WAL buffer is 16 MiB, matching one WAL segment. Forced archive switches pad the segment, so a smaller buffer can
cause repeated buffer evictions and small writes while authorization commits wait. `fdatasync` lets the primary and
standbys batch WAL writes before their durable flush. WAL I/O timing is enabled for live
readback through `pg_stat_io`. PostgreSQL still requires `fsync`, full-page writes and one synchronous standby.
Changing `wal_buffers` requires a CNPG rolling restart and switchover; verify all three instances, replication and
actual authenticated app requests after reconciliation. Reverting these parameters through Git follows the same
rollout and preserves the database and workspace volumes.

`ofz-spicedb-key` contains the API preshared key. Its namespace-bound SealedSecret is committed here. The preshared key
grants access to the whole SpiceDB API; only the Ofz API and owner bootstrap jobs receive it. The native API uses plaintext
transport inside the cluster and has no ingress route. Browser access uses Tailscale HTTPS and requires tailnet access.
The Tailscale operator provisions the private DNS name and certificate without a separate Pi-hole entry.

The database, its inherited resources and backup ObjectStore are retained during Argo pruning or Application deletion.
Ceph provides database storage, physical base backups and WAL. The private S3 gateway serves the
`ofz-database-backups` bucket through a separate namespace-scoped writer. Thirty-day COMPLIANCE retention protects
immutable versions. The old `cnpg-ofz` bucket remains protected and is outside the active destination.

Tengri consumes the typed Ofz API. The final schema is maintained in
[`services/ofz/schema.zed`](../../../services/ofz/schema.zed); controllers and BFFs hold no native SpiceDB key.
The [control-plane runbook](control-plane/README.md) describes managed roles, checksum-bound migration hooks,
archive credentials and fenced bootstrap. The [Ceph recovery store](../../../services/ofz/recovery.md)
holds both the audit archive and separate database buckets. These backups share the live database storage's failure
domain. PostgreSQL persists the native relationship datastore and the separate `ofz_control`
and `tengri_control` databases. Application roles have distinct schema/table permissions.

Separated Tengri pools require two connections per process for schema/readiness and leadership operations,
in addition to request writes. The managed controller role permits 42 connections, covering two replicas and one
rolling-update surge with twelve request and two coordination connections each. The supervisor role permits 24 connections for six slots with two
request and two coordination connections each. Apply this role limit through the Ofz promotion before deploying
the separated Tengri pools. CNPG updates the roles online and rolls the three database instances to apply the
220-connection server limit. This leaves 32 connections beyond simultaneous application rolling surges.
Verify all three instances are ready and report 220 connections before the Tengri rollout. Database privileges,
credentials and runtime migration checksums stay unchanged. Reverting the pool separation precedes any reduction
of these connection budgets.

## Validate before deployment

```bash
nix develop -c kustomize build argocd/applications/ofz > /tmp/ofz.yaml
nix develop -c scripts/kubeconform.sh /tmp/ofz.yaml argocd/applicationsets/platform.yaml
kubeseal --context galactic-tailscale --controller-name sealed-secrets \
  --controller-namespace sealed-secrets --validate \
  < argocd/applications/ofz/spicedb-preshared-key-sealedsecret.yaml
```

The render contains no Namespace. Validate the `SpiceDBCluster` and CNPG `Cluster` against the installed CRD schemas
as well as kubeconform. The SpiceDB operator, CNPG operator, Barman Cloud plugin, Sealed Secrets, Ceph,
and Tailscale operator must be available before the first reconciliation.

## Verify the deployed service

After an authorized rollout, check the exact Argo revision, running image digests, three database instances, three
SpiceDB replicas, two Playground replicas, and the completed initial backup. Verify the Ceph recovery buckets
before reconciliation. The sync waves install writer credentials before PostgreSQL, then let the SpiceDB operator
migrate the datastore and start the service. Verify an isolated physical restore before the Tengri identity cutover.

```bash
kubectl --context galactic-tailscale -n argocd get application ofz
kubectl --context galactic-tailscale -n ofz get cluster,spicedbcluster,deployment,pods,backup,ingress
kubectl --context galactic-tailscale -n ofz port-forward service/ofz 18443:8443
```

In a second terminal, run the bootstrap API check:

```bash
export OFZ_TEST_TOKEN="$(kubectl --context galactic-tailscale -n ofz get secret ofz-spicedb-key \
  -o jsonpath='{.data.preshared_key}' | base64 --decode)"
python3 argocd/applications/ofz/verify-api.py --endpoint http://127.0.0.1:18443
unset OFZ_TEST_TOKEN
```

The following historical bootstrap check refuses an existing application schema. Do not run it after Ofz bootstrap. On a new instance it tests schema writes, relationship writes,
allowed and denied checks, revocation at the returned revision, and rejected credentials. It then removes its test
relationships and schema. Stop the port-forward after validation. After application integration, use that
application's permission fixtures instead of this bootstrap check.

Open Playground and load an example. Confirm that its schema, relationships, assertions, and expected relations
validate. Change an assertion to the wrong result and confirm a failure, then restore it. Reload the browser and
verify that the saved local workspace reopens. A successful page response alone does not prove WebAssembly execution.

## Recovery

For a Playground-only failure, revert its manifest or configuration through a reviewed Git change.
Before a SpiceDB downgrade, check upstream datastore migration compatibility. Restore the database into a separate
CNPG cluster if the prior SpiceDB version cannot read its schema. Preserve the original database and backups until
the replacement passes permission checks. Removing the Application does not authorize deleting retained data.
