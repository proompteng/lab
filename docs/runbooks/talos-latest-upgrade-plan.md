# Talos latest upgrade plan

This runbook tracks the `galactic` Talos OS upgrade to the latest stable Talos
release. It documents the process proven on Ryzen and the remaining production
gates for Altra. It does not authorize an upgrade while the cluster is degraded
or while drain blockers remain unresolved.

## Target

- Target Talos release: `v1.13.4`.
- Release date: 2026-06-09.
- Default upstream installer: `ghcr.io/siderolabs/installer:v1.13.4`.
- Cluster: `ryzen` / Kubernetes `galactic`.
- Primary Kubernetes context: `galactic-lan`.

Sources checked on 2026-06-17; live status refreshed on 2026-06-19:

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

Read-only checks after the Ryzen window on 2026-06-19 showed this state:

| Kubernetes node       | IP                | Talos     | Kubernetes | Role                    | Upgrade action                               |
| --------------------- | ----------------- | --------- | ---------- | ----------------------- | -------------------------------------------- |
| `talos-192-168-1-194` | `100.100.244.141` | `v1.13.4` | Ready      | control plane           | Complete; validate only                      |
| `talos-192-168-1-85`  | `100.100.244.142` | `v1.12.4` | Ready      | control plane, OSD host | Pending; upgrade only after Altra gates pass |
| `turin`               | `100.100.244.171` | `v1.13.4` | Ready      | control plane, OSD host | Already at target; validate only             |

Current Altra gates:

1. `talos-192-168-1-85` is still running Talos `v1.12.4`, while its live
   machine config already points `machine.install.image` at a `v1.13.4` Image
   Factory installer. Do not trust that drift blindly. Regenerate the Altra
   target image from `devices/altra/manifests/altra-tailscale-schematic.yaml`
   and patch the machine config immediately before the actual upgrade.
1. A server-side drain dry-run on 2026-06-19 still hit PDB blockers on Altra:
   `tsag-db-1`, `jangar-db-1`, `posthog-db-1`, Knative `activator` and
   `webhook`, Tempo ingesters, `torghut-tigerbeetle-0`, the ClickHouse
   operator, and `forgejo-runners-arm64-0`.
1. The CNPG blockers have a known zero-data-loss pattern from Ryzen: create
   replicas, wait for them, promote a replica off the target node, drain, then
   restore the singleton posture after acceptance.
1. The non-database blockers need an explicit per-workload action before Altra:
   scale temporary HA where supported, add capacity, or accept a written
   maintenance outage for singleton runner/TigerBeetle workloads. Do not use
   `--disable-eviction`, `--force`, or manual pod deletion to bypass them.

Do not run `talosctl upgrade` on Altra until those blockers are fixed or
explicitly accepted in a maintenance decision record.

## Ryzen execution record

Ryzen was upgraded successfully on 2026-06-19 using the replica-first process.
The evidence directory was:

```text
/tmp/ryzen-talos-v1.13.4-20260618T222737Z
```

Final accepted state:

1. Talos server version: `v1.13.4`.
1. `MachineStatus`: `stage=running`, `ready=true`.
1. Kubernetes node: `Ready`, schedulable, no maintenance taint.
1. Required Ryzen extensions: `kata-containers`, `glibc`, `tailscale`,
   `amdgpu`, `amd-ucode`, and schematic
   `317c1c8cf1562c7ce77b79d6f0af8315c336151b6f752f44f84e52deeccf1c16`.
1. AMD GPU capacity remained `1`.
1. Etcd retained three non-learner voters.
1. Rook-Ceph returned to `HEALTH_OK`, 6/6 OSDs up/in, and all PGs
   `active+clean`.
1. Temporary CNPG, Knative, Tempo, ClickHouse PDB, Forgejo runner, and Argo CD
   maintenance patches were restored.

The durable lesson from Ryzen is that the node OS step is short, but the
production work is the drain preparation and cleanup. Treat Altra the same way:
read-only preflight, workload capacity, successful drain dry-run, etcd snapshot,
Talos upgrade, acceptance, and restoration.

## Version and image policy

Use adjacent minor upgrades only. The current non-Turin nodes are `v1.12.4`, so
`v1.12.4 -> v1.13.4` is the supported path. If any node is older than `v1.12.x`
at execution time, upgrade it to the latest `v1.12` patch first, then to
`v1.13.4`.

Always pass the target image explicitly. Do not rely on the local `talosctl`
default image.

Use custom Image Factory installer images when the node has required system
extensions:

| Node profile                  | Source schematic                                                | Required extensions                                           | Target image form                                          |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Ryzen / `talos-192-168-1-194` | `devices/ryzen/manifests/ryzen-tailscale-schematic.yaml`        | Kata Containers, glibc, Tailscale, AMD GPU, AMD ucode         | `factory.talos.dev/metal-installer/<schematic-id>:v1.13.4` |
| Altra / `talos-192-168-1-85`  | `devices/altra/manifests/altra-tailscale-schematic.yaml`        | Tailscale                                                     | `factory.talos.dev/metal-installer/<schematic-id>:v1.13.4` |
| Turin / `turin`               | `devices/turin/manifests/turin-talos-nvidia-lts-schematic.yaml` | Tailscale, NVIDIA open LTS kernel modules, NVIDIA toolkit LTS | already `v1.13.4`                                          |

Do not downgrade Altra or Ryzen to a vanilla installer image. Altra depends on
node-level Tailscale, and Ryzen depends on Kata Containers, glibc, Tailscale,
AMD GPU/ucode extensions, and kernel args.

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

## Proven production process

Use this sequence for every remaining node. This is the process that succeeded
on Ryzen.

1. Refresh live truth: node versions, `MachineStatus`, extensions, API readyz,
   etcd members, Ceph health, Ceph flags, target-node pods, and PDBs.
1. Generate the target Image Factory installer from the repo schematic for that
   hardware profile.
1. Capture evidence under a dated `/tmp` directory.
1. Pause Argo automation only for apps whose live specs will be patched during
   maintenance. If an app is generated by an ApplicationSet, patch the
   ApplicationSet generator, not only the generated Application.
1. Cordon the target node only after preflight is green.
1. Add drain-safe capacity: CNPG replicas and promotions, temporary HA for
   Knative/Tempo/operator workloads, and a written decision for singleton
   workloads that cannot be kept available.
1. Run `kubectl drain --dry-run=server` and stop on any PDB violation.
1. Capture an etcd snapshot from a healthy control-plane node.
1. Patch `machine.install.image` to the exact target installer image with
   `--mode=no-reboot`.
1. Run `talosctl upgrade` with the same image.
1. Wait for Talos, Kubernetes, etcd, GPU/extensions, and Ceph acceptance.
1. Restore temporary workload posture, uncordon if needed, restore Argo
   automation, and run final acceptance.

## Pre-execution recovery lane

Do this before the Talos upgrade window. Keep it read-only until the actual
repair action is known. This lane is a verification gate, not part of the normal
Talos upgrade.

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
1. Keep `talos-192-168-1-194` in validation-only mode; it is already upgraded.
1. Upgrade `talos-192-168-1-85` from `v1.12.4` to `v1.13.4` only after the
   Altra drain blockers are cleared.
1. Re-run full acceptance criteria.

If a historical `talos-192-168-1-203` node appears again, stop and update the
inventory before continuing. Do not infer that `203` is an upgrade target from
old docs alone.

## Build target installer images

Build or refresh Image Factory schematics before the window:

### Ryzen image

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

### Altra image

```bash
ALTRA_SCHEMATIC_ID="$(
  curl -sS -X POST \
    --data-binary @devices/altra/manifests/altra-tailscale-schematic.yaml \
    https://factory.talos.dev/schematics \
    | jq -r .id
)"

ALTRA_IMAGE="factory.talos.dev/metal-installer/${ALTRA_SCHEMATIC_ID}:v1.13.4"
printf '%s\n' "$ALTRA_IMAGE"
```

### Turin image

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

The Altra source is tracked at
`devices/altra/manifests/altra-tailscale-schematic.yaml`.

## Node upgrade commands

For each node, persist the installer image in machine config, then perform the
upgrade with the same image. This keeps the installed state and future reset
path aligned.

### Ryzen: `talos-192-168-1-194`

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
  --drain-timeout 20m \
  --timeout 45m
```

Expected post-upgrade extension set includes:

1. `kata-containers`
1. `glibc`
1. `tailscale`
1. `amdgpu`
1. `amd-ucode`

### Altra: `talos-192-168-1-85`

```bash
cat >/tmp/altra-v1.13.4-installer.patch.yaml <<EOF
machine:
  install:
    image: ${ALTRA_IMAGE}
EOF

talosctl patch machineconfig \
  -n 100.100.244.142 \
  -e 100.100.244.142 \
  --patch @/tmp/altra-v1.13.4-installer.patch.yaml \
  --mode=no-reboot

talosctl upgrade \
  -n 100.100.244.142 \
  -e 100.100.244.142 \
  --image "$ALTRA_IMAGE" \
  --wait \
  --progress plain \
  --drain-timeout 20m \
  --timeout 45m
```

Expected post-upgrade extension set includes:

1. `tailscale`

Do not pass deprecated upgrade flags. For `v1.13`, prefer the streaming upgrade
API used by current `talosctl upgrade`.

If `talosctl upgrade --wait` fails before starting the upgrade while waiting for
an actor ID, verify that the node is still on the old version and
`MachineStatus` is still `running/ready=true`, then retry with `--wait=false`.
Do not retry blindly after the node has started upgrading or rebooting.

## Altra execution checklist

Use these Altra-specific variables:

```bash
export CTX=galactic-lan
export ALTRA_NODE=talos-192-168-1-85
export ALTRA_IP=100.100.244.142
export TURIN_IP=100.100.244.171
export TS="$(date -u +%Y%m%dT%H%M%SZ)"
export EVIDENCE_DIR="/tmp/altra-talos-v1.13.4-${TS}"
mkdir -p "$EVIDENCE_DIR"

export ALTRA_SCHEMATIC_ID="$(
  curl -sS -X POST \
    --data-binary @devices/altra/manifests/altra-tailscale-schematic.yaml \
    https://factory.talos.dev/schematics \
    | jq -r .id
)"
export ALTRA_IMAGE="factory.talos.dev/metal-installer/${ALTRA_SCHEMATIC_ID}:v1.13.4"
printf '%s\n' "$ALTRA_IMAGE" | tee "$EVIDENCE_DIR/altra-image.txt"
```

Capture Altra preflight:

```bash
kubectl --context "$CTX" get nodes -o wide | tee "$EVIDENCE_DIR/nodes.before.txt"
kubectl --context "$CTX" get --raw='/readyz?verbose' | tee "$EVIDENCE_DIR/readyz.before.txt"
kubectl --context "$CTX" get pods -A --field-selector "spec.nodeName=${ALTRA_NODE}" -o wide \
  | tee "$EVIDENCE_DIR/altra-pods.before.txt"
kubectl --context "$CTX" get pdb -A | tee "$EVIDENCE_DIR/pdb.before.txt"

talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" version | tee "$EVIDENCE_DIR/altra-version.before.txt"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get machinestatus | tee "$EVIDENCE_DIR/altra-machinestatus.before.txt"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get extensions | tee "$EVIDENCE_DIR/altra-extensions.before.txt"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get machineconfig -o yaml \
  | tee "$EVIDENCE_DIR/altra-machineconfig.before.yaml"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" service etcd | tee "$EVIDENCE_DIR/etcd-service.before.txt"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" etcd members | tee "$EVIDENCE_DIR/etcd-members.before.txt"

kubectl --context "$CTX" -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s --format json-pretty \
  | tee "$EVIDENCE_DIR/ceph.before.json"
kubectl --context "$CTX" -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd dump --format json-pretty \
  | tee "$EVIDENCE_DIR/ceph-osd-dump.before.json"
```

Known Altra drain blockers from the 2026-06-19 dry-run:

1. CNPG singleton primaries: `jangar/jangar-db`, `posthog/posthog-db`,
   `tsag/tsag-db`.
1. Knative: `activator` and `webhook` PDBs.
1. Observability: Tempo ingester PDBs.
1. Torghut: `torghut-tigerbeetle-0`.
1. ClickHouse: ClickHouse operator PDB.
1. Forgejo runners: `forgejo-runners-arm64-0`.

Resolve CNPG the same way Ryzen was resolved:

```bash
cat >"$EVIDENCE_DIR/cnpg-altra-targets.tsv" <<'EOF'
jangar	jangar-db
posthog	posthog-db
tsag	tsag-db
EOF

while read -r ns cluster; do
  kubectl --context "$CTX" -n "$ns" patch clusters.postgresql.cnpg.io "$cluster" \
    --type merge -p '{"spec":{"instances":2}}'
  kubectl --context "$CTX" -n "$ns" wait pod -l "cnpg.io/cluster=${cluster}" \
    --for=condition=Ready --timeout=30m
  candidate="$(
    kubectl --context "$CTX" -n "$ns" get pods -l "cnpg.io/cluster=${cluster},role=replica" -o json \
      | jq -r --arg node "$ALTRA_NODE" '.items[] | select(.spec.nodeName != $node) | .metadata.labels["cnpg.io/instanceName"]' \
      | head -1
  )"
  test -n "$candidate"
  kubectl cnpg --context "$CTX" -n "$ns" promote "$cluster" "$candidate"
  until [ "$(kubectl --context "$CTX" -n "$ns" get cluster "$cluster" -o jsonpath='{.status.currentPrimary}')" = "$candidate" ]; do
    sleep 5
  done
done <"$EVIDENCE_DIR/cnpg-altra-targets.tsv"
```

Resolve the non-CNPG blockers explicitly. Save original objects before every
temporary patch, and pause Argo automation for the owning apps at the
ApplicationSet/root layer before applying live changes.

Knative Serving uses `80%` PDBs for singleton `activator` and `webhook`
deployments. Use the operator HA knob, then prove both PDBs allow at least one
disruption:

```bash
kubectl --context "$CTX" -n knative-serving patch knativeserving.operator.knative.dev knative-serving \
  --type merge -p '{"spec":{"high-availability":{"replicas":5}}}'
kubectl --context "$CTX" -n knative-serving rollout status deployment/activator --timeout=15m
kubectl --context "$CTX" -n knative-serving rollout status deployment/webhook --timeout=15m
kubectl --context "$CTX" -n knative-serving get pdb activator-pdb webhook-pdb \
  | tee "$EVIDENCE_DIR/knative-pdb.after-ha.txt"
```

Tempo ingesters currently run both replicas on Altra and the PDB has
`maxUnavailable: 0`. Scale out first, then allow one disruption:

```bash
kubectl --context "$CTX" -n observability get pdb observability-tempo-ingester -o yaml \
  >"$EVIDENCE_DIR/tempo-ingester-pdb.before-temp-patch.yaml"
kubectl --context "$CTX" -n observability get statefulset observability-tempo-ingester -o yaml \
  >"$EVIDENCE_DIR/tempo-ingester-statefulset.before-temp-scale.yaml"

kubectl --context "$CTX" -n observability scale statefulset/observability-tempo-ingester --replicas=4
kubectl --context "$CTX" -n observability rollout status statefulset/observability-tempo-ingester --timeout=15m
kubectl --context "$CTX" -n observability patch pdb observability-tempo-ingester \
  --type merge -p '{"spec":{"maxUnavailable":1}}'
kubectl --context "$CTX" -n observability get pods -l app.kubernetes.io/component=ingester,app.kubernetes.io/name=tempo -o wide \
  | tee "$EVIDENCE_DIR/tempo-ingester-pods.after-scale.txt"
```

The ClickHouse operator is a singleton Deployment protected by
`maxUnavailable: 0`. Scale it to two replicas and temporarily allow one
disruption:

```bash
kubectl --context "$CTX" -n clickhouse-operator get pdb clickhouse-operator -o yaml \
  >"$EVIDENCE_DIR/clickhouse-operator-pdb.before-temp-patch.yaml"
kubectl --context "$CTX" -n clickhouse-operator scale deployment/clickhouse-operator-altinity-clickhouse-operator \
  --replicas=2
kubectl --context "$CTX" -n clickhouse-operator rollout status deployment/clickhouse-operator-altinity-clickhouse-operator \
  --timeout=15m
kubectl --context "$CTX" -n clickhouse-operator patch pdb clickhouse-operator \
  --type merge -p '{"spec":{"maxUnavailable":1}}'
kubectl --context "$CTX" -n clickhouse-operator get pods -o wide \
  | tee "$EVIDENCE_DIR/clickhouse-operator-pods.after-scale.txt"
```

`torghut-tigerbeetle-0` has no replica-first path in this runbook. Treat it as
a maintenance outage unless a separate TigerBeetle HA plan exists. If the outage
is accepted, temporarily relax only its PDB:

```bash
kubectl --context "$CTX" -n torghut get pdb torghut-tigerbeetle -o yaml \
  >"$EVIDENCE_DIR/torghut-tigerbeetle-pdb.before-temp-patch.yaml"
kubectl --context "$CTX" -n torghut patch pdb torghut-tigerbeetle \
  --type merge -p '{"spec":{"minAvailable":0}}'
```

`forgejo-runners-arm64-0` is the only ARM64 Forgejo runner on Altra. Do not
pretend it has HA on the current hardware. If runner downtime is accepted for
the node upgrade, relax only the ARM64 runner PDB:

```bash
kubectl --context "$CTX" -n forgejo-runners get pdb forgejo-runners-arm64 -o yaml \
  >"$EVIDENCE_DIR/forgejo-runners-arm64-pdb.before-temp-patch.yaml"
kubectl --context "$CTX" -n forgejo-runners patch pdb forgejo-runners-arm64 \
  --type merge -p '{"spec":{"minAvailable":0}}'
```

Do not proceed until the dry-run drain succeeds:

```bash
kubectl --context "$CTX" drain "$ALTRA_NODE" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --dry-run=server \
  --timeout=10m | tee "$EVIDENCE_DIR/drain-dry-run.txt"
```

After the dry-run passes, snapshot etcd and upgrade:

```bash
talosctl -n "$TURIN_IP" -e "$TURIN_IP" etcd snapshot \
  "$EVIDENCE_DIR/galactic-etcd-before-altra-talos-v1.13.4-${TS}.db"

cat >"$EVIDENCE_DIR/altra-v1.13.4-installer.patch.yaml" <<EOF
machine:
  install:
    image: ${ALTRA_IMAGE}
EOF

talosctl patch machineconfig -n "$ALTRA_IP" -e "$ALTRA_IP" \
  --patch @"$EVIDENCE_DIR/altra-v1.13.4-installer.patch.yaml" \
  --mode=no-reboot

talosctl upgrade -n "$ALTRA_IP" -e "$ALTRA_IP" \
  --image "$ALTRA_IMAGE" \
  --wait \
  --progress plain \
  --drain-timeout 20m \
  --timeout 45m
```

Altra is accepted only when it reports Talos `v1.13.4`, `MachineStatus` is
`running/ready=true`, `tailscale` is still present, Kubernetes is `Ready` and
schedulable, etcd still has three voters, Ceph has no OSD or PG regression, and
all temporary workload changes have been restored.

Restore Altra temporary changes after acceptance:

```bash
while read -r ns cluster; do
  target="${cluster}-1"
  if kubectl --context "$CTX" -n "$ns" get pod "$target" >/dev/null 2>&1; then
    kubectl --context "$CTX" -n "$ns" wait pod "$target" --for=condition=Ready --timeout=15m
    if [ "$(kubectl --context "$CTX" -n "$ns" get cluster "$cluster" -o jsonpath='{.status.currentPrimary}')" != "$target" ]; then
      kubectl cnpg --context "$CTX" -n "$ns" promote "$cluster" "$target"
      until [ "$(kubectl --context "$CTX" -n "$ns" get cluster "$cluster" -o jsonpath='{.status.currentPrimary}')" = "$target" ]; do
        sleep 5
      done
    fi
    kubectl --context "$CTX" -n "$ns" patch clusters.postgresql.cnpg.io "$cluster" \
      --type merge -p '{"spec":{"instances":1}}'
  else
    echo "KEEPING ${ns}/${cluster} at current instances; ${target} is missing"
  fi
done <"$EVIDENCE_DIR/cnpg-altra-targets.tsv"

kubectl --context "$CTX" -n knative-serving patch knativeserving.operator.knative.dev knative-serving \
  --type json -p='[{"op":"remove","path":"/spec/high-availability"}]'

kubectl --context "$CTX" -n observability scale statefulset/observability-tempo-ingester --replicas=2
kubectl --context "$CTX" -n observability patch pdb observability-tempo-ingester \
  --type merge -p '{"spec":{"maxUnavailable":0}}'

kubectl --context "$CTX" -n clickhouse-operator scale deployment/clickhouse-operator-altinity-clickhouse-operator \
  --replicas=1
kubectl --context "$CTX" -n clickhouse-operator patch pdb clickhouse-operator \
  --type merge -p '{"spec":{"maxUnavailable":0}}'

kubectl --context "$CTX" -n torghut patch pdb torghut-tigerbeetle \
  --type merge -p '{"spec":{"minAvailable":1}}'
kubectl --context "$CTX" -n forgejo-runners patch pdb forgejo-runners-arm64 \
  --type merge -p '{"spec":{"minAvailable":1}}'
```

Final cleanup verification:

```bash
kubectl --context "$CTX" -n knative-serving get deploy activator webhook -o wide
kubectl --context "$CTX" -n knative-serving get pdb activator-pdb webhook-pdb
kubectl --context "$CTX" -n observability get statefulset observability-tempo-ingester
kubectl --context "$CTX" -n observability get pdb observability-tempo-ingester
kubectl --context "$CTX" -n clickhouse-operator get deployment,pdb,pods -o wide
kubectl --context "$CTX" -n torghut get pdb torghut-tigerbeetle
kubectl --context "$CTX" -n forgejo-runners get pdb forgejo-runners-arm64
```

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
