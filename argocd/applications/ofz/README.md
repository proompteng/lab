# Ofz

Ofz provides the shared SpiceDB service and the official SpiceDB Playground in the `ofz` namespace.
The platform ApplicationSet owns its namespace and reconciles these manifests from `main`.

## Components

| Component | Configuration |
| --- | --- |
| SpiceDB | Three replicas of upstream `v1.56.2`, pinned to its multi-architecture image digest |
| PostgreSQL | CNPG PostgreSQL 18.6, three instances, one required synchronous standby, 20 GiB per instance |
| Backups | Barman Cloud plugin, continuous WAL archiving, daily base backup at 10:30 UTC, 14-day retention |
| Playground | Two replicas of upstream `v0.3.1`, pinned to its multi-architecture image digest |
| Browser endpoint | <https://ofz.ide-newton.ts.net>, through the lab's Tailscale ingress |
| SpiceDB API | `ofz.ofz.svc.cluster.local:50051` for gRPC and port `8443` for the HTTP gateway |

Playground runs SpiceDB and the `zed` CLI in the browser through WebAssembly. Its schemas, test relationships, and
assertions are independent of the live service. It receives no SpiceDB credentials. Use its download and import
controls to preserve work. Shared-link storage and an admin interface for the live database are not provisioned.

The upstream Playground image runs with a non-root user and a read-only filesystem. `playground-nginx.conf` replaces
its entrypoint-generated Nginx configuration so only `/tmp` needs a writable mount.

These are upstream platform images. Reviewed changes pin their versions and digests directly, as with the SpiceDB
operator. No repository image build or Kargo promotion is involved.

## Credentials and data

CNPG generates `ofz-db-app`. The SpiceDB operator reads its `uri` key directly. Both migration jobs and serving pods
verify PostgreSQL's TLS certificate with `ofz-db-ca`. `track_commit_timestamp=on` enables the SpiceDB Watch API.

`ofz-spicedb-key` contains the API preshared key. Its namespace-bound SealedSecret is committed here. The preshared key
grants access to the whole SpiceDB API; distribute it only to trusted backend services. The API uses plaintext
transport inside the cluster and has no ingress route. Browser access uses Tailscale HTTPS and requires tailnet access.
The Tailscale operator provisions the private DNS name and certificate without a separate Pi-hole entry.

The database, its inherited resources, the backup ObjectStore, and the bucket claim are retained during Argo pruning
or Application deletion. Ceph provides both database storage and the backup bucket. These backups do not protect
against loss of the entire Ceph cluster.

No application permission schema or service integration is installed. Define and review those contracts with the
first consuming application.

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
SpiceDB replicas, two Playground replicas, and the completed initial backup. The sync waves create the bucket and
credentials before PostgreSQL, then let the SpiceDB operator migrate the datastore and start the service.

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

The check refuses an existing application schema. On a new instance it tests schema writes, relationship writes,
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
