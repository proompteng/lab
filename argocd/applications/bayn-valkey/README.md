# Bayn Valkey

Dedicated Valkey 9.1 primary and replica, managed by chideat/valkey-operator v2.1.0.
The `bayn-valkey` Application tracks reviewed `main` independently of Bayn's Kargo
release. Valkey is a disposable cache; PostgreSQL, TigerBeetle and Kafka retain
their existing authority.

## Topology and availability

`valkey.yaml` selects `arch: replica`, one shard and two data pods. Required
anti-affinity places one pod on each eligible 100G host. Each requests 1Gi of
memory, caps the dataset at 512Mi and retains its existing 10Gi Ceph RBD volume.
`noeviction` rejects writes at capacity. AOF and scheduled RDB snapshots are
disabled for these expiring, disposable materializations. Diskless primary
replication also prevents the operator from injecting default snapshot schedules.
The two memory copies still require application replica acknowledgement before
PostgreSQL publishes their hashes. A complete cache restart requires a fresh
broker poll; there is no database payload fallback. Existing volumes and files
are retained.

There is no Sentinel or automatic promotion. A failed primary makes the cache
unavailable until recovery or an operator-managed manual promotion. Bayn bounds
cache requests and fails explicitly on missing or unavailable materializations;
the polling owner must publish a fresh cut before readers can proceed. A replica
alone does not guarantee automatic HA across two hosts.
Automatic failover requires independent voters; this deployment does not place
workloads on the reserved compute host or change its taints.

## Connection and access

- Primary: `rfr-bayn-valkey-readwrite.bayn.svc.cluster.local:6379`.
- Replica: `rfr-bayn-valkey-readonly.bayn.svc.cluster.local:6379`.
- TLS trust and client identity: Secret `bayn-valkey-client-tls`.
- Username: `default`; password: Secret `bayn-valkey-auth`, key `password`.
- Connection metadata: ConfigMap `bayn-valkey-connection`.

The application ACL permits data commands under `bayn:*` and bounded replication
acknowledgement with `WAIT`. It grants no cluster discovery or destructive
administration. The operator account remains separate. Passwords must contain
letters, digits and special characters and fit the operator's 32-character
limit. Generate replacements in memory and update only the encrypted value in
`auth-sealedsecret.yaml`, preserving Secret identity and strict sealing scope.
A synced SealedSecret does not prove User admission.

The operator makes the password Secret a dependent of its User. GitOps applies
only the Secret's patch annotation before reconciling the SealedSecret; it never
declares password data. Sealed Secrets uses
[patch mode](https://github.com/bitnami/sealed-secrets#patching-existing-secrets)
to supply the encrypted password without replacing the operator's owner reference
or finalizer. Keep this annotation in the sealed template as well. Do not add the
`managed` annotation: that would make the two controllers compete for ownership.

## Acceptance

The bounded, tokenless `bayn-valkey-acceptance-v3` Sync hook uses only the
application credential. It writes to the primary, waits for one replica acknowledgement on
the same connection, reads the replicated value and removes the synthetic key.
It also checks key-prefix rejection and rejection without a password. Keys
expire after ten minutes if the Job is interrupted.

`BeforeHookCreation` recreates an earlier completed or failed attempt on the
next full Application sync. If startup exceeds the five-minute Job deadline,
let the operator recover, then run a full reviewed sync of `bayn-valkey` to
rerun acceptance. Do not use a `--resource` selective sync for this check:
[Argo hooks do not run during selective sync](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/#hook-lifecycle-and-cleanup).
Successful Job history stays available until the next attempt.

After Bayn's image rollout, run its installed `valkey-command.js --broker` from
both API and execution replicas. The transport check writes and reads a 1 MiB
synthetic value with replica acknowledgement and expiry; the broker check reads
the actual fenced full and compact materializations. Tiny writes alone do not
exercise publication-sized traffic.

Apply reviewed configuration through this Application, then verify `appendonly`
is `no`, `save` is empty and `repl-diskless-sync` is `yes` on both data pods.
The operator applies these mutable settings without a required Pod restart.
Keep the one-second application deadline, TLS identity, ACL, `WAIT 1`, PostgreSQL
fences and retained volumes unchanged. A reverted persistence policy restores
disk writes through GitOps; missing or expired cache contents still require a
fresh poll rather than replaying historical trading evidence.

```sh
kustomize build argocd/applications/bayn-valkey > /tmp/bayn-valkey.yaml
bash scripts/kubeconform.sh /tmp/bayn-valkey.yaml
kubectl -n bayn get valkeys.rds.valkey.buf.red,failovers.valkey.buf.red
kubectl -n bayn get pods,pvc -l buf.red/name=bayn-valkey
kubectl -n bayn logs job/bayn-valkey-acceptance-v3
```

## Migration from the unused sharded cluster

The three original primaries were checked with the existing TLS application
credential and each reported `DBSIZE=0`. No Bayn process consumed that cluster.
Changing `arch` in place does not retire the operator's old Cluster child.
Argo's server disables replace syncs. Use three reviewed GitOps steps rather
than changing that server policy:

1. Temporarily set `Prune=true,Delete=false` on the Valkey and desired User.
   Verify Argo applied those annotations at the reviewed `main` revision.
2. Remove `valkey.yaml`, `user.yaml` and the acceptance Job from the
   Kustomization. Normal cascading pruning deletes the Valkey owner and its
   old Cluster and new Failover children. Verify both children and their pods
   are absent before continuing.
3. Restore the primary/replica resources with `Prune=false,Delete=false` and a
   new acceptance Job name. Verify the new Valkey UID, two Ready pods on
   separate hosts, a Ready User and passing authenticated acceptance.

Before pruning, verify the Valkey has no `delete-pvc` finalizer and all old
PVCs have no owner references. The old protected User has owner references to
the old Cluster and Valkey UIDs; cascading owner deletion garbage-collects
that User independently of Argo pruning. Retain the six old
`valkey-data-drc-bayn-valkey-*` volumes and the two replica volumes throughout
this rollout. Verify the old Cluster and old User are absent and Argo is
Synced/Healthy at each reviewed revision. Do not persist force/replace options
or change Application automation.

Upstream v2.1.0 can leave a foreground-deletion cycle: generated operator Users
wait for the Cluster/Failover to disappear while those parents wait for their
Users. If this occurs, wait for all cache Pods and StatefulSets to disappear
and for operator cleanup finalizers to clear. A separately authorized metadata
repair can then remove only `foregroundDeletion` from the two terminating child
objects, with UID, deletion timestamp and finalizer-list preconditions. Verify
all retained PVC/PV identities first and afterward. Let the operator clean its
User and Secret finalizers; never strip those or a delete-PVC finalizer. Do not
recreate the instance until both old children, all old Users and the old Valkey
owner are absent. Check the actual `bayn-valkey-auth` Secret before restoring
the User: a SealedSecret's stale `Synced` condition does not prove its Secret
survived owner cleanup. Reconcile the unchanged encrypted credential through
a reviewed Secret-template change if the Secret is absent; do not create a
plaintext Secret or rotate credentials to bypass admission.

Recovery uses a reviewed source reversion. If changing architecture again,
repeat the reviewed owner removal and recreation; changing `arch` in place
leaves stale children. Retained volumes remain available. Never prune volumes,
relax ACLs or use an operator credential to make an acceptance test pass.
Cache availability does not grant broker, strategy or capital authority.
