# Buzz production operations

Buzz is deployed to the `buzz` namespace by the `buzz` Argo CD application. It is private to the
`ide-newton.ts.net` tailnet at `wss://buzz.ide-newton.ts.net`.

## Ownership and immutable inputs

- Helm chart: `oci://ghcr.io/block/buzz/charts/buzz:0.1.6`
  (`sha256:88b96378cabd6b64c9bb8da9824a608daac3b0965d2aa17019e70248c07d517c`).
- Relay image:
  `registry.ide-newton.ts.net/lab/buzz:sha-dba56ff36e19307d93a738c9005aaa3cbfa718df`
  (`sha256:16d08bf8e2772a93924de1a49746a034d3410387d6095b214ed2e798aa7d6cfb`, lab revision
  `dba56ff36e19307d93a738c9005aaa3cbfa718df`).
- The derivative image preserves upstream runtime index
  `ghcr.io/block/buzz@sha256:29fe13981a726fe43642fe03cbd6cc87142579a90bbf9897e3c1b370d1037428`
  and replaces only `buzz-relay`, built from upstream revision
  `acfbb1bb6af54cb29cb152496ff43b8285dcb8cf` with the bounded Ceph RGW patch.
- `BUZZ_GIT_S3_COMPATIBILITY=ceph-rgw` enables the compatibility boundary. Remove the derivative and this setting
  after upstream ships equivalent quoted-ETag and conditional-conflict handling and the production A3 conformance
  test passes on the upstream image.
- `RELAY_OWNER_PUBKEY` is public and committed in `argocd/applications/buzz/values.yaml`.
- The owner's `nsec` is stored only in the human-owned `buzz-owner` item in the 1Password `Private` vault.
- `buzz-runtime` in the 1Password `infra` vault contains the stable relay private key, Git hook HMAC secret, and
  Redis password. External Secrets may read that item.
- CNPG and Ceph OBC credentials remain generated Kubernetes Secrets. The `buzz-kubernetes` SecretStore lets
  External Secrets combine them into `buzz-secrets` without copying credentials into Git.

Do not rotate `BUZZ_RELAY_PRIVATE_KEY` during a routine release: doing so changes the relay identity. Do not expose or
paste the owner `nsec` into a shell, Git, Kubernetes, or an automation log.

## Deployment

The ApplicationSet intentionally starts Buzz with manual reconciliation. After the change is merged:

```sh
argocd app get buzz --refresh
argocd app diff buzz
argocd app sync buzz --prune=false
argocd app wait buzz --health --sync --timeout 1800
```

Never apply the rendered manifests directly. The namespace is owned by the ApplicationSet and protected from pruning.
The two OBCs, CNPG cluster, Redis PVC, and generated runtime Secret have explicit deletion protection.

## Acceptance

Run every Kubernetes command with the namespace explicitly set.

The CNPG status endpoint is reachable only from the three host-networked kube-apiserver node addresses listed in
`allow-kubernetes-api-cnpg-status`. Update those `/32` entries whenever a control-plane node address changes; otherwise
cross-node `kubectl cnpg status` pod-proxy requests will fail while same-node requests can appear healthy.

```sh
kubectl -n buzz get externalsecret,secretstore
kubectl -n buzz get objectbucketclaim
kubectl -n buzz get cluster.postgresql.cnpg.io,scheduledbackup.postgresql.cnpg.io,backup.postgresql.cnpg.io
kubectl -n buzz get redis.redis.redis.opstreelabs.in
kubectl -n buzz get deployment,pod -o wide
kubectl -n buzz get ingress buzz
```

Required state:

- `buzz-objects` and `cnpg-buzz-db` are `Bound`.
- `buzz-kubernetes`, `buzz-redis-auth`, and `buzz-secrets` are `Ready`.
- `buzz-db` reports three ready instances, one primary, one synchronous standby, and a healthy continuous archive.
- The immediate `buzz-db-daily-*` backup is `completed`.
- `buzz-redis` is ready, accepts only authenticated commands, and has AOF enabled.
- Two Buzz relay pods are Ready on different nodes.
- The Tailscale Ingress has an assigned device and a valid tailnet TLS certificate.

Validate the relay from a tailnet-connected workstation:

```sh
curl --fail --silent --show-error \
  --header 'Accept: application/nostr+json' \
  https://buzz.ide-newton.ts.net/
```

Use a Nostr client that supports NIP-42 to confirm an unauthenticated request is challenged and the dedicated owner
identity authenticates successfully. Verify `up{job="buzz-relay",namespace="buzz"}` and
`redis_up{job="buzz-redis",namespace="buzz"}` in Mimir. The general `CloudNativePgWalArchiveBacklog` alert covers Buzz
WAL archival; `BuzzPostgresBackupStale` covers the daily backup.

## Backup and restore proof

Confirm the latest backup and archive:

```sh
kubectl -n buzz get backup.postgresql.cnpg.io \
  -l cnpg.io/cluster=buzz-db \
  --sort-by=.status.stoppedAt
kubectl cnpg status buzz-db -n buzz
```

After the desktop smoke test has created representative data, take a named on-demand backup and wait for its phase to
become `completed`:

```sh
kubectl cnpg backup buzz-db -n buzz \
  --method plugin \
  --plugin-name barman-cloud.cloudnative-pg.io \
  --backup-target prefer-standby \
  --backup-name buzz-db-acceptance-UTC_TIMESTAMP
```

For acceptance, restore into a temporary cluster named `buzz-db-restore-proof`; never restore over `buzz-db`. Use the
same pinned PostgreSQL image, a new 20 GiB `rook-ceph-block` volume, and this recovery bootstrap:

```yaml
bootstrap:
  recovery:
    source: buzz-db-backup
    database: buzz
    owner: buzz
externalClusters:
  - name: buzz-db-backup
    plugin:
      name: barman-cloud.cloudnative-pg.io
      parameters:
        barmanObjectName: buzz-db
        serverName: buzz-db-live
```

Apply the proof resource through a temporary committed GitOps change or an explicitly approved emergency procedure.
Wait for it to become healthy, connect with `kubectl cnpg psql`, and verify representative relay rows. Delete only the
temporary proof cluster after recording evidence; never delete the source OBC or bucket.

## Resilience proof

Perform one disruption at a time and wait for full recovery between steps:

1. Delete one Buzz relay pod and verify the desktop client reconnects while the other replica stays available.
2. Delete the Redis pod, wait for AOF-backed recovery, then verify messages fan out across both relay replicas.
3. Run `kubectl cnpg promote buzz-db <healthy-replica> -n buzz` for a controlled switchover and verify writes continue.
4. Complete the restore proof above.
5. Observe pod restarts, Buzz logs, Redis metrics, CNPG metrics, WAL archive state, and Mimir alerts for 60 minutes.

Only after all checks pass should a follow-up Git change set the Buzz ApplicationSet entry to `automation: auto`.

## Desktop onboarding

On an Apple Silicon Mac connected to `ide-newton.ts.net`, obtain the current official DMG from the latest Buzz GitHub
release using the in-app Browser. Verify the published SHA-256 before mounting it, then require both `codesign` and
`spctl` to succeed before copying `Buzz.app` to `/Applications`.

Persist `wss://buzz.ide-newton.ts.net` as the community relay. The user must paste the owner `nsec` from 1Password;
automation must not read it. Confirm the derived public key exactly equals `RELAY_OWNER_PUBKEY` and that the owner is a
relay member.

The Codex runtime must reach `READY`. If Buzz reports the adapter missing, install the Buzz-supported
`@zed-industries/codex-acp@0.16.0`. Select Codex as the default harness, `gpt-5.6` when it is advertised, and medium
reasoning; otherwise retain the runtime's advertised default model.

Before declaring readiness, create normal and private channels, exercise messages/reactions/search across a restart,
round-trip a checksummed media file, clone and push a disposable Git workspace, and have a Codex agent read channel
context and post a benign response under its own identity.

## Rollback

Rollback is a Git revert followed by Argo reconciliation. Preserve the relay identity, both Ceph buckets, CNPG PVCs,
Redis PVC, and backups. Never downgrade an incompatible database schema in place. Restore the prior backup into a new
CNPG cluster and repoint Buzz only after compatibility is proven. Runtime objects and database backups share the same
Ceph failure domain; off-site disaster recovery is intentionally out of scope for this installation.
