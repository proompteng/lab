# Bayn CNPG backup and restore

Bayn owns `Cluster/bayn-db`, `ObjectStore/bayn-db`, and `ObjectBucketClaim/cnpg-bayn-db` in namespace `bayn`. All three
are protected from ordinary Argo prune/delete operations. They must only be removed through an explicitly approved
evidence-retention change. The database has two synchronous amd64 instances; loss of the standby blocks writes instead
of acknowledging unreplicated evidence.

The platform app installs Barman Cloud Plugin 0.13.0 in the same namespace as the CloudNativePG 1.30 operator. Its
manager and injected sidecar images are pinned by multi-architecture digest. Bayn uses the plugin API from its first
backup, avoiding the native Barman API that CloudNativePG removes in 1.31.

Upstream contracts: [CloudNativePG 1.30 release notes](https://cloudnative-pg.io/docs/1.30/release_notes/v1.30/),
[Barman Cloud Plugin installation](https://cloudnative-pg.io/plugin-barman-cloud/docs/installation/),
[Barman Cloud Plugin usage](https://cloudnative-pg.io/plugin-barman-cloud/docs/usage/), and
[required CNPG network ports](https://cloudnative-pg.io/docs/1.30/security/#exposed-ports).

## Primary checks

```sh
kubectl -n cloudnative-pg rollout status deployment/barman-cloud
kubectl -n bayn get objectbucketclaim cnpg-bayn-db
kubectl -n bayn get objectstore.barmancloud.cnpg.io bayn-db
kubectl -n bayn get cluster bayn-db
kubectl -n bayn get pods -l cnpg.io/cluster=bayn-db -o wide
kubectl -n bayn get scheduledbackup bayn-db-daily
kubectl -n bayn get backup -l cnpg.io/cluster=bayn-db
kubectl -n bayn get secret bayn-db-app -o go-template='{{.metadata.name}}{{"\\t"}}{{.type}}{{"\\n"}}'
kubectl cnpg status -n bayn bayn-db
kubectl cnpg psql -n bayn bayn-db -- -d bayn -Atqc \
  "select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = 'bayn_app'"
```

The expected role row is `bayn_app|f|f|f`. `kubectl cnpg status` must report
`barman-cloud.cloudnative-pg.io` under Plugins status and successful WAL archiving. Never print Secret data. In Mimir,
both instances must be present and healthy:

```promql
count(up{cluster="bayn-db",job="cnpg-postgres"} == 1) == 2
```

## Isolated restore drill

Use a unique UTC suffix for every drill. Never point a recovery Cluster at `serverName: bayn-db-live` for new backups;
the recovery Cluster has no backup stanza and only reads that archive.

1. Seed one non-application proof row on the primary:

   ```sh
   kubectl cnpg psql -n bayn bayn-db -- -d bayn -v ON_ERROR_STOP=1 -c \
     "create schema if not exists restore_probe; create table if not exists restore_probe.evidence (proof_id text primary key, proof_value text not null); insert into restore_probe.evidence values ('PROOF_ID', 'PROOF_VALUE') on conflict (proof_id) do update set proof_value = excluded.proof_value;"
   ```

2. Request and wait for a named backup:

   ```sh
   kubectl cnpg backup -n bayn bayn-db --backup-name bayn-db-proof-UTC_SUFFIX --backup-target prefer-standby \
     --method=plugin --plugin-name=barman-cloud.cloudnative-pg.io
   kubectl -n bayn wait --for=jsonpath='{.status.phase}'=completed backup/bayn-db-proof-UTC_SUFFIX --timeout=30m
   ```

3. Add a temporary, uniquely named recovery `Cluster` and matching ingress-only `NetworkPolicy` to a reviewed GitOps
   change. The policy permits only its own peers, the CNPG operator on ports 5432/8000, and Alloy on 9187. Use one
   instance, the same pinned image and storage class, and this recovery source:

   ```yaml
   bootstrap:
     recovery:
       source: bayn-db-source
       backup:
         name: bayn-db-proof-UTC_SUFFIX
       database: bayn
       owner: bayn_app
   externalClusters:
     - name: bayn-db-source
       plugin:
         name: barman-cloud.cloudnative-pg.io
         parameters:
           barmanObjectName: bayn-db
           serverName: bayn-db-live
   ```

4. After Argo reports the recovery Cluster healthy, query the exact proof row through `kubectl cnpg psql`. Record the
   primary and recovery Cluster UIDs, backup name/ID, start/end timestamps, source image digest, proof row, and recovery
   duration in PROOMPT-358.

5. Remove the temporary manifest through GitOps only after the evidence is recorded. Deleting the recovery Cluster or
   its PVC requires explicit approval. Never alter or delete `bayn-db`, `cnpg-bayn-db`, or another service's storage as
   part of the drill.
