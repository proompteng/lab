# Omni on the NUC

This bundle installs a single-node, non-production Omni control plane on the NUC from repository-owned configuration.
It is intentionally independent of the Kubernetes clusters it manages, so an Omni outage does not stop those clusters.

## Architecture

- Omni `v1.10.4` runs with host networking, embedded etcd, SQLite secondary storage, and direct TUN access.
- The existing NUC Tailscale node is the only Omni network edge:
  - Tailscale Serve terminates private HTTPS for the UI/API and Kubernetes proxy and forwards the machine API as raw
    TCP.
  - SideroLink WireGuard binds directly to the NUC tail IP on UDP `50180`.
- `tsidp v0.0.15` provides Tailscale OIDC as a separate unprivileged container and persistent tsnet identity.
- Workload proxy and the unauthenticated local resource service are disabled.
- Container images are pinned to the release tag and the `linux/amd64` manifest digest.

This differs deliberately from Sidero's short Tailscale Compose example. That example places Omni behind a userspace
Tailscale HTTP proxy but advertises UDP `50180` without forwarding it. Omni's current configuration requires the
WireGuard advertised endpoint to be an IP address. The NUC-hosted design gives both Talos nodes and Omni a real
Tailscale interface and a direct UDP path.

| Endpoint | Exposure | Purpose |
| --- | --- | --- |
| `https://nuc.ide-newton.ts.net/` | Tailnet only | Omni UI and API |
| `grpc://100.78.240.108:8090` | Tailnet only | Raw TCP Machine/SideroLink API |
| `https://nuc.ide-newton.ts.net:8100/` | Tailnet only | Kubernetes API proxy |
| `100.78.240.108:50180/udp` | Tailnet only | SideroLink WireGuard |
| `127.0.0.1:8180` | NUC loopback | Cleartext Omni origin behind Serve |
| `127.0.0.1:2122` | NUC loopback | Metrics |

The Tailscale node address is installation state. `scripts/validate.sh` fails if it differs from `.env`, preventing
Omni from silently advertising a stale SideroLink endpoint.

## Source-controlled and private state

Tracked in this directory:

- `compose.yaml` and immutable image references
- `omni.yaml`, including listener, storage, and security defaults
- `tailscale-serve.json`
- bootstrap, validation, deployment, verification, and backup scripts
- the non-secret environment schema in `.env.example`

Never committed:

- `.env`: account UUID, admin email, OIDC client credentials, and temporary Tailscale auth key
- `/var/lib/omni/secrets/omni.asc`: the private etcd encryption key
- `/var/lib/omni/{etcd,sqlite,tsidp}`: persistent application and identity-provider state
- `/var/lib/omni/cluster-etcd-backups`: encrypted managed-cluster etcd snapshots
- `/var/lib/omni/backups`: archives containing all of the above secrets

Losing `omni.asc` makes an etcd backup unusable. Losing the tsidp state invalidates the registered OIDC client and
sessions. Back them up together.

## Prerequisites

- NUC: Ubuntu `24.04`, `x86_64`, Docker Engine, Compose v2, GnuPG, jq, curl, and `/dev/net/tun`
- NUC Tailscale identity online as `nuc.ide-newton.ts.net` at `100.78.240.108`
- Talos nodes joined to the same tailnet; `ryzen-1` and `turin-1` were observed there on `2026-08-22`
- MagicDNS and Tailscale HTTPS certificates enabled
- Tailscale policy from `tofu/tailscale/templates/policy.hujson.tmpl`, including `tag:omni-idp` and the tsidp grant
- a one-time auth key tagged `tag:omni-idp`

The NUC meets Sidero's small-installation hardware guidance. Ports `8090`, `8091`, `8092`, `8100`, and `50180/udp`
must remain available. Existing Nginx Proxy Manager owns host port `443`; Tailscale Serve operates on the tailnet
interface and intentionally owns the NUC's tailnet HTTPS endpoint.

## First installation

From a repository checkout on the workstation:

```bash
devices/nuc/omni/sync-to-nuc.sh
ssh kalmyk@nuc.ide-newton.ts.net
cd /home/kalmyk/omni
./scripts/bootstrap.sh
```

`bootstrap.sh` creates `/var/lib/omni`, a persistent account UUID, and the GPG encryption key. It never invents an
administrator identity or accepts legal terms.

Before starting tsidp:

1. Apply the checked-in Tailscale policy through `tofu/tailscale` after reviewing the live-policy diff. The current
   live ACL has drifted from the repository, so do not apply it blindly.
2. In the Tailscale admin console, create a non-reusable auth key tagged `tag:omni-idp`.
3. Set `OMNI_ADMIN_EMAIL` and `TSIDP_AUTH_KEY` in `/home/kalmyk/omni/.env`.
4. Start only the identity provider:

```bash
./scripts/bootstrap-tsidp.sh
```

Open `https://tsidp.ide-newton.ts.net`, create an OIDC client named `Omni`, and set the only redirect URI to:

```text
https://nuc.ide-newton.ts.net/oidc/consume
```

Put the generated client ID and secret into `.env` as `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. Clear
`TSIDP_AUTH_KEY`; the registered tsidp identity persists under `/var/lib/omni/tsidp` and no longer needs it.

Deploy exactly what is checked in:

```bash
./scripts/deploy.sh
```

The deploy script validates the current tail IP and secrets, pulls the pinned images, starts the containers, applies
the checked-in Tailscale Serve configuration, and runs the live checks.

Finally, open `https://nuc.ide-newton.ts.net/`. Omni blocks API actions until the first user accepts the EULA. Complete
that screen personally; the repository and scripts intentionally do not store or submit EULA acceptance identity.

## Routine operations

```bash
cd /home/kalmyk/omni
./scripts/validate.sh full
./scripts/verify.sh
docker compose --env-file .env ps
docker compose --env-file .env logs --tail 100 omni
docker compose --env-file .env logs --tail 100 tsidp
```

`verify.sh` proves both containers are running, the loopback origins answer, the checked-in Serve route model is
active, Omni owns its loopback API ports and UDP `50180` on the expected tail IP, and the local cluster-etcd backup
directory is mounted from `/var/lib/omni/cluster-etcd-backups` on the NUC. Tailscale 1.102 no longer accepts the legacy
Serve JSON through `serve set-config`; the deployment script treats that file as the desired route model and applies
the three routes through the supported imperative CLI.

Host-originated connections to the NUC's own Tailscale address can bypass Tailscale Serve and reach another listener
on the same host. Prove the actual tailnet route from a different peer after deployment:

```bash
curl --fail --silent --show-error --output /dev/null https://nuc.ide-newton.ts.net/
omnictl cluster status galactic
```

### Managed-cluster etcd backups

Omni stores encrypted managed-cluster etcd snapshots locally under `/var/lib/omni/cluster-etcd-backups`. The
`galactic` cluster template requests a snapshot every 24 hours. The local backend and the S3 backend are mutually
exclusive; this installation intentionally uses the local backend.

After deploying Omni or changing the cluster backup schedule, verify the backend and the latest `galactic` snapshot
from an authenticated workstation:

```bash
omnictl get etcdbackupoverallstatus -o yaml
omnictl get etcdbackupstatus galactic -o yaml
omnictl get etcdbackup --selector omni.sidero.dev/cluster=galactic
```

Require `configurationname: local`, an empty `configurationerror`, and a recent successful `lastbackuptime`. Omni does
not prune local snapshots automatically. Monitor NUC free space and establish a reviewed retention policy before
deleting any snapshot. A NUC-local snapshot protects cluster recovery but not NUC disk loss; copy the snapshot tree or
the required restore point to encrypted off-host storage when that additional failure-domain protection is required.

## Backup and restore

Run the complete repeatable backup workflow from an authenticated workstation:

```bash
./backup-to-nuc.sh galactic
```

The command verifies the local backend and live NUC runtime, requests a fresh managed-cluster etcd snapshot, waits for
Omni to report success, proves that the new snapshot exists under the cluster UUID on the NUC, then creates a
checksum-verified full-state archive. It finally waits for Omni and tsidp to recover and re-runs the NUC runtime
verification. The cluster name defaults to `galactic` and the explicit Omni context defaults to `default`;
`OMNI_CONTEXT`, `NUC_SSH_TARGET`, `NUC_OMNI_DIR`,
`OMNI_BACKUP_TIMEOUT_SECONDS`, and `OMNI_BACKUP_POLL_SECONDS` are explicit overrides.

The NUC-side archive primitive remains available for cases where a fresh managed-cluster snapshot is not required:

```bash
./scripts/backup.sh
```

The script briefly stops Omni and tsidp, archives `.env`, the encryption key, embedded etcd, managed-cluster etcd
snapshots, SQLite, and tsidp state, validates the archive checksum, then restarts only services that were running. A
non-blocking NUC lock rejects overlapping full-state backups. Managed Kubernetes clusters continue operating while
Omni is down. Archives are mode `0600` under `/var/lib/omni/backups`; copy each archive and checksum to encrypted
off-host storage. The archive preflight reserves at least 10 GiB beyond the uncompressed input size; override that
floor with `OMNI_BACKUP_MIN_FREE_BYTES` in the NUC `.env`. Every invocation creates a new timestamped archive; neither
script deletes snapshots or old archives.

For recovery, use a new NUC with the same Tailscale hostname and address, sync this directory, and bootstrap only the
host packages and directories. Do not start Omni. Copy the archive and checksum to the NUC, verify them, then restore
the repository-relative paths from the archive at the filesystem root:

```bash
sha256sum --check omni-YYYYMMDDTHHMMSSZ.tar.gz.sha256
docker compose --env-file .env down
sudo tar --extract --gzip --file omni-YYYYMMDDTHHMMSSZ.tar.gz --directory /
./scripts/deploy.sh
```

The archive restores `.env` to `/home/kalmyk/omni` and the five state directories to `/var/lib/omni`. Never start an
empty Omni instance against a restored account UUID, and never restore etcd without its matching `omni.asc`.

For an online etcd-only snapshot, follow Sidero's supported `etcdctl --endpoints http://localhost:2379 snapshot save`
procedure. The full-state script is preferred here because it also preserves SQLite and tsidp.

## Upgrade and rollback policy

1. Read every intervening Omni release note; Sidero supports sequential minor upgrades only.
2. Run `scripts/backup.sh` and copy the archive off-host.
3. Replace the Omni tag and `linux/amd64` manifest digest together in `compose.yaml`.
4. Run `scripts/validate.sh full`, then `scripts/deploy.sh`.
5. Verify UI login, machine connectivity, and a generated kubeconfig before considering the upgrade complete.

Omni downgrades are unsupported because database migrations may be irreversible. Recovery means restoring the entire
pre-upgrade backup with the pre-upgrade image, not pointing an older binary at migrated data. Upgrade tsidp separately;
it remains experimental before `v1.0.0`, so retain its exact state and pinned image during Omni changes.

## Primary references

- [Run Omni On-Prem](https://docs.siderolabs.com/omni/self-hosted/run-omni-on-prem)
- [Omni configuration reference](https://docs.siderolabs.com/omni/reference/omni-configuration)
- [OIDC login with Tailscale](https://docs.siderolabs.com/omni/security-and-authentication/oidc-login-with-tailscale)
- [Back Up Omni Database](https://docs.siderolabs.com/omni/self-hosted/back-up-omni-db)
- [Upgrade Omni](https://docs.siderolabs.com/omni/self-hosted/upgrading-omni)
- [tsidp](https://github.com/tailscale/tsidp)
