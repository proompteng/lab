# Talos latest upgrade plan

This runbook plans the `galactic` Talos OS upgrade to the latest stable Talos
release. It is a plan only; it does not authorize an upgrade while the cluster
is degraded.

## Target

- Target Talos release: `v1.13.4`.
- Release date: 2026-06-09.
- Default upstream installer: `ghcr.io/siderolabs/installer:v1.13.4`.
- Cluster: `ryzen` / Kubernetes `galactic`.
- Primary Kubernetes context: `galactic-lan`.

Sources checked on 2026-06-16:

- Talos releases: <https://github.com/siderolabs/talos/releases>
- Talos upgrade guide:
  <https://docs.siderolabs.com/talos/v1.13/configure-your-talos-cluster/lifecycle-management/upgrading-talos>
- Talos support matrix:
  <https://docs.siderolabs.com/talos/v1.13/getting-started/support-matrix>
- Local access runbook: `docs/runbooks/galactic-kubernetes-access.md`
- Local Rook-Ceph runbook: `docs/runbooks/rook-ceph-on-talos.md`
- Local Turin Talos runbook: `devices/turin/docs/cluster-join-plan.md`

Talos OS upgrades are separate from Kubernetes upgrades. Do not change
Kubernetes minor versions as part of this runbook.

## Live snapshot

Read-only checks run on 2026-06-16 showed this state:

| Kubernetes node        | IP              | Talos | Kubernetes | Role          | Upgrade action |
| ---------------------- | --------------- | ----- | ---------- | ------------- | -------------- |
| `talos-192-168-1-194`  | `100.100.244.141` | `v1.12.4` | Ready | control plane | Upgrade to `v1.13.4` after gates pass |
| `talos-192-168-1-85`   | `100.100.244.142` | `v1.12.4` | NotReady, SchedulingDisabled | control plane, OSD host | Blocked until recovered |
| `turin`                | `100.100.244.171` | `v1.13.4` | Ready | control plane, OSD host | Already at target; validate only |

Current hard blockers:

1. `talos-192-168-1-85` is `NotReady`, unschedulable, and carries
   `node.kubernetes.io/unreachable` taints.
1. `talos-192-168-1-85` reports Talos `MachineStatus.spec.stage: upgrading`
   while still serving Talos `v1.12.4`.
1. Rook-Ceph is `HEALTH_WARN`: `noout` is set, one OSD host is down, three OSDs
   are down, 141 PGs are down/inactive, and data redundancy is degraded.
1. Several PDBs currently allow zero disruptions, including Rook-Ceph, Kafka,
   Tempo, ClickHouse/Keeper, and multiple database primaries.

Do not run `talosctl upgrade` on any node until those blockers are either fixed
or explicitly accepted in a maintenance decision record.

## Version and image policy

Use adjacent minor upgrades only. The current non-Turin nodes are `v1.12.4`, so
`v1.12.4 -> v1.13.4` is the supported path. If any node is older than `v1.12.x`
at execution time, upgrade it to the latest `v1.12` patch first, then to
`v1.13.4`.

Always pass the target image explicitly. Do not rely on the local `talosctl`
default image.

Use custom Image Factory installer images when the node has required system
extensions:

| Node profile | Source schematic | Required extensions | Target image form |
| ------------ | ---------------- | ------------------- | ----------------- |
| Ryzen / `talos-192-168-1-194` | `devices/ryzen/manifests/ryzen-tailscale-schematic.yaml` | Tailscale, AMD GPU, AMD ucode | `factory.talos.dev/metal-installer/<schematic-id>:v1.13.4` |
| Altra / `talos-192-168-1-85` | live schematic currently contains Tailscale only | Tailscale | `factory.talos.dev/metal-installer/<schematic-id>:v1.13.4` |
| Turin / `turin` | `devices/turin/manifests/turin-talos-nvidia-lts-schematic.yaml` | Tailscale, NVIDIA open LTS kernel modules, NVIDIA toolkit LTS | already `v1.13.4` |

Before upgrading `talos-192-168-1-85`, add or identify a durable Image Factory
schematic source for its live Tailscale-only image. Do not downgrade it to a
vanilla installer image, because that would remove node-level Tailscale on the
next install/upgrade path.

Use a `talosctl` version matching the source node version for issuing the
upgrade when practical. Keep `talosctl v1.13.4` available for post-upgrade
validation. A newer client can read the older nodes but emits compatibility
warnings.

## Preflight gate

Run all checks before each upgrade window:

```bash
export CTX=galactic-lan
export ROOK_TOOLS='deploy/rook-ceph-tools'

kubectl --context "$CTX" get nodes -o wide
kubectl --context "$CTX" get --raw='/readyz?verbose'
kubectl --context "$CTX" get pdb -A
kubectl --context "$CTX" -n rook-ceph get pods -o wide
kubectl --context "$CTX" -n rook-ceph exec "$ROOK_TOOLS" -- ceph -s
kubectl --context "$CTX" -n rook-ceph exec "$ROOK_TOOLS" -- ceph health detail
kubectl --context "$CTX" -n rook-ceph exec "$ROOK_TOOLS" -- ceph osd tree

talosctl config info
talosctl -n 100.100.244.141 -e 100.100.244.141 version
talosctl -n 100.100.244.141 -e 100.100.244.141 get machinestatus -o yaml
talosctl -n 100.100.244.141 -e 100.100.244.141 get extensions
talosctl -n 100.100.244.142 -e 100.100.244.142 version
talosctl -n 100.100.244.142 -e 100.100.244.142 get machinestatus -o yaml
talosctl -n 100.100.244.142 -e 100.100.244.142 get extensions
talosctl -n 100.100.244.171 -e 100.100.244.171 version
talosctl -n 100.100.244.171 -e 100.100.244.171 get machinestatus -o yaml
talosctl -n 100.100.244.171 -e 100.100.244.171 get extensions
```

The gate passes only when:

1. All intended upgrade targets are Kubernetes `Ready`.
1. No target node is already in Talos `stage: upgrading`.
1. Etcd has quorum and all expected members are healthy.
1. Rook-Ceph has no inactive, down, or undersized PGs.
1. Any explicit `noout`, `norecover`, `nobackfill`, or `pause` Ceph flags are
   understood and documented for the maintenance window.
1. No PDB with zero allowed disruptions protects a pod that must move off the
   target node during drain.
1. The target Image Factory installer image exists and can be pulled by the
   node.
1. A fresh etcd snapshot has been captured.

Capture the etcd snapshot from a healthy control-plane node:

```bash
talosctl -n 100.100.244.171 -e 100.100.244.171 etcd snapshot \
  /tmp/galactic-etcd-before-talos-v1.13.4-$(date -u +%Y%m%dT%H%M%SZ).db
```

## Blocker recovery lane

Do this before the Talos upgrade window. Keep it read-only until the actual
repair action is known.

For `talos-192-168-1-85`:

```bash
kubectl --context galactic-lan describe node talos-192-168-1-85
kubectl --context galactic-lan get pods -A -o wide \
  --field-selector spec.nodeName=talos-192-168-1-85

talosctl -n 100.100.244.142 -e 100.100.244.142 get machinestatus -o yaml
talosctl -n 100.100.244.142 -e 100.100.244.142 services
talosctl -n 100.100.244.142 -e 100.100.244.142 service kubelet status
talosctl -n 100.100.244.142 -e 100.100.244.142 logs kubelet --tail 200
talosctl -n 100.100.244.142 -e 100.100.244.142 dmesg
```

For Rook-Ceph:

```bash
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd stat
kubectl --context galactic-lan -n rook-ceph get pods -o wide
```

The recovery lane is complete only when `talos-192-168-1-85` is either healthy
and ready to upgrade, or deliberately excluded from the window with a written
reason and a confirmed safe quorum/storage posture.

## Upgrade order

Upgrade one node at a time. Do not launch parallel node upgrades in this
cluster. Rook-Ceph and the control plane both have quorum/disruption
constraints, and the Talos docs explicitly warn that components like Rook/Ceph
may not survive multiple near-simultaneous node reboots.

Preferred order after all gates pass:

1. Validate `turin` as the existing `v1.13.4` reference.
1. Upgrade `talos-192-168-1-194` from `v1.12.4` to `v1.13.4`.
1. Wait for Kubernetes, Talos, etcd, and Rook-Ceph to return to the acceptance
   criteria.
1. Upgrade `talos-192-168-1-85` only after its current `stage: upgrading` and
   NotReady state are resolved.
1. Re-run full acceptance criteria.

If a historical `talos-192-168-1-203` node appears again, stop and update the
inventory before continuing. Do not infer that `203` is an upgrade target from
old docs alone.

## Build target installer images

Build or refresh Image Factory schematics before the window:

```bash
RYZEN_SCHEMATIC_ID="$(
  curl -sS -X POST \
    --data-binary @devices/ryzen/manifests/ryzen-tailscale-schematic.yaml \
    https://factory.talos.dev/schematics \
    | jq -r .id
)"

RYZEN_IMAGE="factory.talos.dev/metal-installer/${RYZEN_SCHEMATIC_ID}:v1.13.4"
printf '%s\n' "$RYZEN_IMAGE"
```

For Turin validation only:

```bash
TURIN_SCHEMATIC_ID="$(
  curl -sS -X POST \
    --data-binary @devices/turin/manifests/turin-talos-nvidia-lts-schematic.yaml \
    https://factory.talos.dev/schematics \
    | jq -r .id
)"

TURIN_IMAGE="factory.talos.dev/metal-installer/${TURIN_SCHEMATIC_ID}:v1.13.4"
printf '%s\n' "$TURIN_IMAGE"
```

For Altra, identify the live Tailscale-only schematic source before execution.
If no source file exists, create one in a separate change and verify it matches
the live extension set.

## Upgrade command pattern

For each node, persist the installer image in machine config, then perform the
upgrade with the same image. This keeps the installed state and future reset
path aligned.

Example for `talos-192-168-1-194`:

```bash
cat >/tmp/ryzen-v1.13.4-installer.patch.yaml <<EOF
machine:
  install:
    image: ${RYZEN_IMAGE}
EOF

talosctl patch machineconfig \
  -n 100.100.244.141 \
  -e 100.100.244.141 \
  --patch @/tmp/ryzen-v1.13.4-installer.patch.yaml \
  --mode=no-reboot

talosctl upgrade \
  -n 100.100.244.141 \
  -e 100.100.244.141 \
  --image "$RYZEN_IMAGE" \
  --wait \
  --progress plain \
  --timeout 45m
```

Do not pass deprecated upgrade flags. For `v1.13`, prefer the streaming upgrade
API used by current `talosctl upgrade`.

Use the same shape for `talos-192-168-1-85` only after its blocker lane is
closed and its Altra target image has been confirmed.

## Per-node acceptance checks

Run these after each node returns:

```bash
NODE_IP='<node-ip>'
NODE_NAME='<kubernetes-node-name>'

talosctl -n "$NODE_IP" -e "$NODE_IP" version
talosctl -n "$NODE_IP" -e "$NODE_IP" get machinestatus -o yaml
talosctl -n "$NODE_IP" -e "$NODE_IP" get extensions
talosctl -n "$NODE_IP" -e "$NODE_IP" services
talosctl -n "$NODE_IP" -e "$NODE_IP" service kubelet status

kubectl --context galactic-lan get node "$NODE_NAME" -o wide
kubectl --context galactic-lan describe node "$NODE_NAME"
kubectl --context galactic-lan get pods -A -o wide \
  --field-selector spec.nodeName="$NODE_NAME"
```

The node passes only when:

1. Talos reports `v1.13.4`.
1. `MachineStatus` is `stage: running` and `ready: true`.
1. Required extensions are present for that hardware profile.
1. The Kubernetes node is `Ready`.
1. The node is not accidentally left cordoned unless a maintenance decision says
   it should stay cordoned.
1. No system pods are crash-looping due to missing runtime classes, extensions,
   or host drivers.

## Cluster acceptance checks

Run these after every node and again at the end:

```bash
kubectl --context galactic-lan get nodes -o wide
kubectl --context galactic-lan get --raw='/readyz?verbose'

talosctl -n 100.100.244.171 -e 100.100.244.171 etcd members
talosctl -n 100.100.244.171 -e 100.100.244.171 etcd status

kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context galactic-lan -n rook-ceph get pods -o wide
```

Final success criteria:

1. All live Talos nodes are on `v1.13.4`.
1. Kubernetes remains on the intended existing version.
1. All intended nodes are `Ready`.
1. Etcd has the expected voters and no failed members.
1. Rook-Ceph has no down OSDs, inactive/down PGs, or unexpected maintenance
   flags.
1. Node-level Tailscale still works, including image pulls from
   `registry.ide-newton.ts.net`.
1. GPU-related extensions remain loaded on the Ryzen and Turin hardware profiles.
1. Argo CD and critical stateful namespaces have returned to their pre-window
   health posture or better.

## Rollback and stop conditions

Stop immediately if any of these occur:

1. Etcd loses quorum or a control-plane member fails to rejoin.
1. A node stays NotReady after the upgrade timeout.
1. Rook-Ceph gains new inactive/down PGs or loses another OSD host.
1. Required system extensions disappear after reboot.
1. Workload drain blocks on PDBs and the window has no explicit approval to
   relax those workloads.

Rollback the last upgraded node only after confirming the node can still answer
the Talos API:

```bash
talosctl rollback -n <node-ip> -e <endpoint-ip>
talosctl -n <node-ip> -e <endpoint-ip> get machinestatus -o yaml
kubectl --context galactic-lan get node <kubernetes-node-name> -o wide
```

If the node cannot answer Talos API after a failed upgrade, use the BMC/console
path for that hardware and keep Kubernetes/Ceph changes frozen until the node's
boot state is known.

Do not clear Ceph flags, purge OSDs, remove etcd members, or delete Kubernetes
nodes as part of Talos rollback unless a separate recovery runbook says to do
that exact action for the observed failure.

## Evidence to save

Save a dated transcript or markdown note with:

1. The exact target release and installer image per node.
1. Preflight `kubectl get nodes -o wide`.
1. Preflight `ceph -s` and `ceph health detail`.
1. Etcd snapshot path.
1. Per-node `talosctl version`, `get machinestatus`, and `get extensions`
   before and after upgrade.
1. Final cluster acceptance checks.

Commit any durable runbook updates separately from the operational execution
evidence. Do not commit generated Talos configs, Tailscale auth material, BMC
credentials, or etcd snapshots.
