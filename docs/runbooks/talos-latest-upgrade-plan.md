# Talos latest upgrade plan

This runbook is the production plan for upgrading the remaining Altra node in
the `galactic` Talos cluster. It also gates Kubernetes GPU pod enablement on
Altra. The upgrade is OS-only: do not change the Kubernetes minor version.

## Target

- Target node: `talos-192-168-1-85`.
- Target node IP: `100.100.244.142`.
- Target Talos release: `v1.13.5`.
- Target Kubernetes release: keep the existing `v1.35.0`.
- Target installer source:
  `devices/altra/manifests/altra-tailscale-nvidia-lts-schematic.yaml`.
- Target installer image:
  `factory.talos.dev/metal-installer/6e246b622304aee389cfed7ed4f13dd4dac4a751243ed43bae10d73c63195e7d:v1.13.5`.
- Primary Kubernetes context: `galactic-lan`.
- Fresh branch for this run: `codex/talos-altra-v1135-upgrade`.

Sources checked on 2026-07-03:

- Talos releases: <https://github.com/siderolabs/talos/releases>
- Talos Image Factory: <https://factory.talos.dev/>
- Talos upgrade guide:
  <https://docs.siderolabs.com/talos/v1.13/configure-your-talos-cluster/lifecycle-management/upgrading-talos>
- Talos Image Factory docs:
  <https://docs.siderolabs.com/talos/v1.13/learn-more/image-factory>
- Talos system extensions docs:
  <https://docs.siderolabs.com/talos/v1.13/build-and-extend-talos/custom-images-and-development/system-extensions>
- Local Rook-Ceph runbook: `docs/runbooks/rook-ceph-on-talos.md`
- Local Altra manifests: `devices/altra/manifests/`
- Local GPU operator app: `argocd/applications/nvidia-gpu-operator/`

The Image Factory stable recommendation is `1.13.5`. `1.14.0-alpha.2` is a
pre-release and is not a production target for this run.

## Current live state

Read-only checks on 2026-07-03 showed:

| Kubernetes node       | Tailscale IP      | Talos     | Kubernetes | Role                                   | Action                             |
| --------------------- | ----------------- | --------- | ---------- | -------------------------------------- | ---------------------------------- |
| `talos-192-168-1-194` | `100.100.244.141` | `v1.13.4` | `v1.35.0`  | control plane                          | Read-only peer                     |
| `talos-192-168-1-85`  | `100.100.244.142` | `v1.12.4` | `v1.35.0`  | control plane, OSD host, RTX 3090 host | Upgrade target                     |
| `turin`               | `100.100.244.190` | `v1.13.4` | `v1.35.0`  | control plane, OSD host, NVIDIA host   | Read-only peer and snapshot source |

Do not use stale Turin endpoint `100.100.244.171`; it is not reachable in the
current environment.

The current hard blockers are:

1. Rook-Ceph is `HEALTH_WARN` with `noout,noscrub,nodeep-scrub`, slow BlueStore
   alerts, recent crashes, and remapped PGs still recovering.
1. Altra's live machine config says `machine.install.disk: /dev/nvme1n1`, but
   live Talos volumes prove `STATE`, `META`, `EPHEMERAL`, and local-path are on
   `/dev/nvme0n1`.
1. `/dev/nvme1n1` backs Ceph DB/WAL LVM devices and must not be used as the
   Talos install disk.
1. A server-side drain dry-run blocks on Altra Rook-Ceph OSD pods,
   `torghut/torghut-tigerbeetle-0`,
   `forgejo-runners/forgejo-runners-arm64-0`, and
   `knative-eventing/eventing-webhook`.
1. Altra has NVIDIA PCI presence labels, but it does not currently advertise
   `nvidia.com/gpu` capacity. Kubernetes GPU pods on Altra are not enabled
   until the Talos NVIDIA extensions, device plugin, and smoke test pass.

## Non-negotiable rules

1. Upgrade only Altra in this run. Do not upgrade Ryzen or Turin.
1. Do not change Kubernetes versions.
1. Do not run `talosctl upgrade` while Ceph is recovering or while any Altra
   OSD PDB blocks drain.
1. Do not use `--disable-eviction`, `--force`, or manual pod deletion to bypass
   PDBs.
1. Do not use `/dev/nvme1n1` as the Talos install disk.
1. Do not remove etcd members, delete Kubernetes nodes, purge OSDs, or clear
   Ceph state as part of rollback without a separate recovery runbook.
1. Enable Altra GPU pods only after the node returns healthy on Talos `v1.13.5`
   with NVIDIA extensions loaded.

## Documentation and PR gate

Do this before any live upgrade action:

1. Update this runbook and the Altra installer patch to target `v1.13.5`.
1. Keep the Altra Image Factory schematic source at
   `devices/altra/manifests/altra-tailscale-nvidia-lts-schematic.yaml`.
1. Keep the corrected Altra install disk at `/dev/nvme0n1`.
1. Add the gated Altra NVIDIA device plugin to
   `argocd/applications/nvidia-gpu-operator/`.
1. Run basic repo checks for the changed files.
1. Open a PR from `codex/talos-altra-v1135-upgrade` using
   `.github/PULL_REQUEST_TEMPLATE.md`.
1. Merge only after required checks are green.

The PR documents and stages the safe desired state. It does not by itself
approve live upgrade execution if the Ceph or drain gates are still blocked.

## Variables

Use these variables for the live run:

```bash
export CTX=galactic-lan
export ALTRA_NODE=talos-192-168-1-85
export ALTRA_IP=100.100.244.142
export TURIN_IP=100.100.244.190
export TALOS_TARGET=v1.13.5
export TS="$(date -u +%Y%m%dT%H%M%SZ)"
export EVIDENCE_DIR="/tmp/altra-talos-v1.13.5-${TS}"
mkdir -p "$EVIDENCE_DIR"
```

Generate the Altra installer image from the repo schematic:

```bash
export ALTRA_SCHEMATIC_ID="$(
  curl -sS -X POST \
    --data-binary @devices/altra/manifests/altra-tailscale-nvidia-lts-schematic.yaml \
    https://factory.talos.dev/schematics \
    | jq -r .id
)"
export ALTRA_IMAGE="factory.talos.dev/metal-installer/${ALTRA_SCHEMATIC_ID}:${TALOS_TARGET}"
printf '%s\n' "$ALTRA_IMAGE" | tee "$EVIDENCE_DIR/altra-image.txt"
```

Current expected schematic ID for the checked-in Altra NVIDIA LTS schematic:

```text
6e246b622304aee389cfed7ed4f13dd4dac4a751243ed43bae10d73c63195e7d
```

## Preflight evidence

Capture all evidence before changing live state:

```bash
kubectl --context "$CTX" get nodes -o wide | tee "$EVIDENCE_DIR/nodes.before.txt"
kubectl --context "$CTX" get --raw='/readyz?verbose' | tee "$EVIDENCE_DIR/readyz.before.txt"
kubectl --context "$CTX" get pods -A --field-selector "spec.nodeName=${ALTRA_NODE}" -o wide \
  | tee "$EVIDENCE_DIR/altra-pods.before.txt"
kubectl --context "$CTX" get pdb -A | tee "$EVIDENCE_DIR/pdb.before.txt"
kubectl --context "$CTX" -n argocd get applications.argoproj.io -o wide \
  | tee "$EVIDENCE_DIR/argocd.before.txt"

talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" version \
  | tee "$EVIDENCE_DIR/altra-version.before.txt"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get machinestatus -o yaml \
  | tee "$EVIDENCE_DIR/altra-machinestatus.before.yaml"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get machineconfig -o yaml \
  | tee "$EVIDENCE_DIR/altra-machineconfig.before.yaml"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get disks -o yaml \
  | tee "$EVIDENCE_DIR/altra-disks.before.yaml"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get volumestatus -o yaml \
  | tee "$EVIDENCE_DIR/altra-volumestatus.before.yaml"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get extensions \
  | tee "$EVIDENCE_DIR/altra-extensions.before.txt"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" etcd members \
  | tee "$EVIDENCE_DIR/etcd-members.before.txt"
```

Abort unless all of these are true:

1. Altra is Kubernetes `Ready`.
1. API readyz passes.
1. Altra `MachineStatus` is `stage=running` and `ready=true`.
1. Etcd has three non-learner voters.
1. Live volume evidence proves `/dev/nvme0n1` is the Talos install disk.
1. Live disk evidence shows `/dev/nvme1n1` is Ceph DB/WAL backing storage, not
   Talos install storage.

Use these focused extraction commands to prove the disk gate:

```bash
yq '.spec.machine.install.disk' "$EVIDENCE_DIR/altra-machineconfig.before.yaml" \
  | tee "$EVIDENCE_DIR/altra-install-disk.before.txt"
yq -r '.spec | [.metadata.id, .parent, .location] | @tsv' \
  "$EVIDENCE_DIR/altra-volumestatus.before.yaml" \
  | tee "$EVIDENCE_DIR/altra-volume-parents.before.tsv"
yq -r '.spec | [.devPath, .symlinks[]?] | @tsv' "$EVIDENCE_DIR/altra-disks.before.yaml" \
  | rg 'nvme1n1|ceph|block.db|block.wal' \
  | tee "$EVIDENCE_DIR/altra-nvme1n1-ceph-evidence.before.tsv"
```

## Ceph gate

Capture Ceph state:

```bash
kubectl --context "$CTX" -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s \
  | tee "$EVIDENCE_DIR/ceph.before.txt"
kubectl --context "$CTX" -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail \
  | tee "$EVIDENCE_DIR/ceph-health.before.txt"
kubectl --context "$CTX" -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree \
  | tee "$EVIDENCE_DIR/ceph-osd-tree.before.txt"
kubectl --context "$CTX" -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd dump \
  | tee "$EVIDENCE_DIR/ceph-osd-dump.before.txt"
```

Do not continue until:

1. No PGs are `remapped`, `backfilling`, `backfill_wait`, `degraded`,
   `undersized`, `inactive`, or `down`.
1. No OSD is down or out.
1. `noout`, `norecover`, `nobackfill`, and `pause` are absent, or the exact
   remaining flag is documented as safe for this maintenance window.
1. The Altra OSD-host PDB no longer blocks a server-side drain dry-run.

Scrub-age warnings alone can be accepted. Active recovery, remapped PGs, OSD
loss, or OSD PDB blockage cannot be accepted for this Talos reboot.

## Drain gate

Run the dry-run before any cordon or live drain:

```bash
kubectl --context "$CTX" drain "$ALTRA_NODE" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --dry-run=server \
  --timeout=10m | tee "$EVIDENCE_DIR/drain-dry-run.before.txt"
```

Abort if any Ceph OSD pod is listed as an eviction blocker.

If the only remaining blockers are approved singleton non-Ceph workloads,
planned downtime is acceptable for:

1. `torghut/torghut-tigerbeetle-0`
1. `forgejo-runners/forgejo-runners-arm64-0`
1. `knative-eventing/eventing-webhook`

Save original objects before every temporary change:

```bash
kubectl --context "$CTX" -n torghut get pdb torghut-tigerbeetle -o yaml \
  >"$EVIDENCE_DIR/torghut-tigerbeetle-pdb.before.yaml"
kubectl --context "$CTX" -n forgejo-runners get pdb forgejo-runners-arm64 -o yaml \
  >"$EVIDENCE_DIR/forgejo-runners-arm64-pdb.before.yaml"
kubectl --context "$CTX" -n knative-eventing get pdb eventing-webhook -o yaml \
  >"$EVIDENCE_DIR/knative-eventing-webhook-pdb.before.yaml"
kubectl --context "$CTX" -n knative-eventing get deployment eventing-webhook -o yaml \
  >"$EVIDENCE_DIR/knative-eventing-webhook-deployment.before.yaml"
```

Prefer adding safe replica capacity for the Knative Eventing webhook:

```bash
kubectl --context "$CTX" -n knative-eventing scale deployment/eventing-webhook --replicas=2
kubectl --context "$CTX" -n knative-eventing rollout status deployment/eventing-webhook --timeout=15m
kubectl --context "$CTX" -n knative-eventing get pdb eventing-webhook \
  | tee "$EVIDENCE_DIR/knative-eventing-webhook-pdb.after-scale.txt"
```

Only after the maintenance decision accepts downtime, relax the singleton PDBs:

```bash
kubectl --context "$CTX" -n torghut patch pdb torghut-tigerbeetle \
  --type merge -p '{"spec":{"minAvailable":0}}'
kubectl --context "$CTX" -n forgejo-runners patch pdb forgejo-runners-arm64 \
  --type merge -p '{"spec":{"minAvailable":0}}'
```

Re-run the dry-run and stop unless it succeeds:

```bash
kubectl --context "$CTX" drain "$ALTRA_NODE" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --dry-run=server \
  --timeout=10m | tee "$EVIDENCE_DIR/drain-dry-run.after.txt"
```

## Patch Altra machine config

Patch both the corrected install disk and the target installer image:

```bash
cat >"$EVIDENCE_DIR/altra-v1.13.5-installer.patch.yaml" <<EOF
machine:
  install:
    disk: /dev/nvme0n1
    image: ${ALTRA_IMAGE}
EOF

talosctl patch machineconfig -n "$ALTRA_IP" -e "$ALTRA_IP" \
  --patch @"$EVIDENCE_DIR/altra-v1.13.5-installer.patch.yaml" \
  --mode=no-reboot

talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get machineconfig -o yaml \
  | tee "$EVIDENCE_DIR/altra-machineconfig.patched.yaml"
```

Abort unless the re-read machine config has:

```text
machine.install.disk: /dev/nvme0n1
machine.install.image: ${ALTRA_IMAGE}
```

## Snapshot, cordon, drain, upgrade

Snapshot etcd from healthy Turin:

```bash
talosctl -n "$TURIN_IP" -e "$TURIN_IP" etcd snapshot \
  "$EVIDENCE_DIR/galactic-etcd-before-altra-v1.13.5.db"
```

Cordon and drain only after the dry-run is clean:

```bash
kubectl --context "$CTX" cordon "$ALTRA_NODE"
kubectl --context "$CTX" drain "$ALTRA_NODE" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=20m | tee "$EVIDENCE_DIR/drain.txt"
```

Upgrade Altra:

```bash
talosctl upgrade -n "$ALTRA_IP" -e "$ALTRA_IP" \
  --image "$ALTRA_IMAGE" \
  --wait \
  --progress plain \
  --drain-timeout 20m \
  --timeout 45m | tee "$EVIDENCE_DIR/talos-upgrade.txt"
```

## Kubernetes GPU pod enablement

The repo-owned GPU Operator app disables chart-wide driver, toolkit, and device
plugin installation because Talos owns host NVIDIA drivers and the container
toolkit through system extensions. Altra GPU pods require all of this:

1. Talos extensions include `nvidia-open-gpu-kernel-modules-lts` and
   `nvidia-container-toolkit-lts`.
1. NVIDIA kernel modules are loaded on Altra.
1. The `nvidia` RuntimeClass still exists.
1. The gated `altra-nvidia-device-plugin` DaemonSet is allowed to schedule.
1. Altra advertises `nvidia.com/gpu: 1`.
1. A real Kubernetes pod requesting `nvidia.com/gpu: 1` runs successfully on
   Altra and can execute `nvidia-smi`.

Do not enable the Altra device plugin before Talos and Kubernetes acceptance.
The DaemonSet is gated by this label:

```text
platform.proompteng.ai/altra-gpu-container-ready=true
```

Enable it after the node returns healthy:

```bash
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get extensions \
  | tee "$EVIDENCE_DIR/altra-extensions.gpu-before-label.txt"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" read /proc/modules \
  | rg '^nvidia' | tee "$EVIDENCE_DIR/altra-nvidia-modules.after.txt"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" read /proc/driver/nvidia/version \
  | tee "$EVIDENCE_DIR/altra-nvidia-driver-version.after.txt"
kubectl --context "$CTX" get runtimeclass nvidia nvidia-cdi nvidia-legacy \
  | tee "$EVIDENCE_DIR/nvidia-runtimeclasses.after.txt"

kubectl --context "$CTX" label node "$ALTRA_NODE" nvidia.com/gpu.workload.config- --overwrite
kubectl --context "$CTX" label node "$ALTRA_NODE" \
  platform.proompteng.ai/altra-gpu-container-ready=true --overwrite
talosctl patch machineconfig -n "$ALTRA_IP" -e "$ALTRA_IP" \
  --patch @devices/altra/manifests/node-labels.patch.yaml \
  --mode=no-reboot
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get machineconfig -o yaml \
  | rg -C 3 'nodeLabels|altra-gpu-container-ready' \
  | tee "$EVIDENCE_DIR/altra-node-labels.machineconfig.after.txt"

# Preferred when Argo CLI is already pointed at the argocd namespace.
argocd --core app sync nvidia-gpu-operator --timeout 900

# If core-mode Argo CLI is not using the argocd namespace in this workspace,
# apply the repo-owned Altra resources directly and let Argo reconcile the app.
kubectl --context "$CTX" apply -f argocd/applications/nvidia-gpu-operator/altra-nvidia-device-plugin.yaml
kubectl --context "$CTX" -n gpu-operator rollout status ds/altra-nvidia-device-plugin --timeout=10m
kubectl --context "$CTX" -n gpu-operator get pods -l app=altra-nvidia-device-plugin -o wide \
  | tee "$EVIDENCE_DIR/altra-device-plugin.after.txt"
kubectl --context "$CTX" get node "$ALTRA_NODE" -o json \
  | jq -r '.status.capacity["nvidia.com/gpu"], .status.allocatable["nvidia.com/gpu"]' \
  | tee "$EVIDENCE_DIR/altra-gpu-capacity.after.txt"
```

The Altra device-plugin ConfigMap must not use time-slicing with `replicas: 1`.
NVIDIA device-plugin `v0.19.x` rejects that config with `number of replicas
must be >= 2`. For one physical RTX 3090 exposed as one Kubernetes GPU, keep
`argocd/applications/nvidia-gpu-operator/altra-nvidia-device-plugin.yaml` at:

```yaml
data:
  config.yaml: |
    version: v1
```

Run a Kubernetes GPU pod smoke test:

```bash
cat >"$EVIDENCE_DIR/altra-gpu-smoke-pod.yaml" <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: altra-gpu-smoke
  namespace: gpu-operator
spec:
  restartPolicy: Never
  runtimeClassName: nvidia
  nodeSelector:
    kubernetes.io/hostname: talos-192-168-1-85
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  containers:
    - name: cuda
      image: nvcr.io/nvidia/cuda:13.0.2-base-ubuntu24.04
      command:
        - nvidia-smi
        - -L
      resources:
        limits:
          nvidia.com/gpu: "1"
EOF

kubectl --context "$CTX" apply -f "$EVIDENCE_DIR/altra-gpu-smoke-pod.yaml"
kubectl --context "$CTX" -n gpu-operator wait pod/altra-gpu-smoke \
  --for=jsonpath='{.status.phase}'=Succeeded --timeout=10m
kubectl --context "$CTX" -n gpu-operator logs pod/altra-gpu-smoke \
  | tee "$EVIDENCE_DIR/altra-gpu-smoke.log"
kubectl --context "$CTX" -n gpu-operator delete pod/altra-gpu-smoke --wait=true
```

If the smoke pod image is not multi-arch for `linux/arm64`, stop and select a
validated CUDA image for Altra. Do not mark GPU pod enablement complete from the
device-plugin DaemonSet alone.

## Restore

Restore every temporary workload change:

```bash
kubectl --context "$CTX" -n torghut apply -f "$EVIDENCE_DIR/torghut-tigerbeetle-pdb.before.yaml"
kubectl --context "$CTX" -n forgejo-runners apply -f "$EVIDENCE_DIR/forgejo-runners-arm64-pdb.before.yaml"
kubectl --context "$CTX" -n knative-eventing apply -f "$EVIDENCE_DIR/knative-eventing-webhook-pdb.before.yaml"
kubectl --context "$CTX" -n knative-eventing apply -f "$EVIDENCE_DIR/knative-eventing-webhook-deployment.before.yaml"
kubectl --context "$CTX" -n knative-eventing rollout status deployment/eventing-webhook --timeout=15m
```

Uncordon only after Talos, Kubernetes, etcd, Ceph, and GPU gates pass:

```bash
kubectl --context "$CTX" uncordon "$ALTRA_NODE"
```

If the upgrade fails before acceptance, keep the node cordoned unless the
rollback/recovery lead explicitly decides otherwise.

## Final acceptance

Altra is accepted only when every check passes:

```bash
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" version \
  | tee "$EVIDENCE_DIR/altra-version.after.txt"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get machinestatus -o yaml \
  | tee "$EVIDENCE_DIR/altra-machinestatus.after.yaml"
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get extensions \
  | tee "$EVIDENCE_DIR/altra-extensions.after.txt"
kubectl --context "$CTX" get node "$ALTRA_NODE" -o wide \
  | tee "$EVIDENCE_DIR/altra-node.after.txt"
kubectl --context "$CTX" get --raw='/readyz?verbose' \
  | tee "$EVIDENCE_DIR/readyz.after.txt"
talosctl -n "$TURIN_IP" -e "$TURIN_IP" etcd members \
  | tee "$EVIDENCE_DIR/etcd-members.after.txt"
kubectl --context "$CTX" -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s \
  | tee "$EVIDENCE_DIR/ceph.after.txt"
kubectl --context "$CTX" -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail \
  | tee "$EVIDENCE_DIR/ceph-health.after.txt"
kubectl --context "$CTX" -n argocd get applications.argoproj.io -o wide \
  | tee "$EVIDENCE_DIR/argocd.after.txt"
kubectl --context "$CTX" get node "$ALTRA_NODE" -o json \
  | jq -r '.status.capacity["nvidia.com/gpu"], .status.allocatable["nvidia.com/gpu"]' \
  | tee "$EVIDENCE_DIR/altra-gpu.after.txt"
kubectl --context "$CTX" -n gpu-operator get pods -l app=altra-nvidia-device-plugin -o wide \
  | tee "$EVIDENCE_DIR/altra-device-plugin.final.txt"
```

Required outcomes:

1. Altra Talos reports `v1.13.5`.
1. Kubernetes remains `v1.35.0`.
1. Altra is `Ready`, schedulable, and not accidentally left cordoned.
1. Altra `MachineStatus` is `stage=running` and `ready=true`.
1. Extensions include `tailscale`, `nvidia-open-gpu-kernel-modules-lts`, and
   `nvidia-container-toolkit-lts`.
1. Altra advertises `nvidia.com/gpu: 1` capacity and allocatable.
1. A Kubernetes GPU smoke pod ran on Altra and logged `nvidia-smi -L`.
1. Etcd retains three non-learner voters.
1. Ceph has no new OSD or PG regression.
1. Argo apps return to the pre-window health posture or better.

## Rollback

Rollback trigger: Altra fails to boot, stays NotReady, loses required
extensions, fails the corrected install-disk gate, or causes Ceph/etcd
regression.

If the Talos API responds:

```bash
talosctl rollback -n "$ALTRA_IP" -e "$ALTRA_IP"
kubectl --context "$CTX" get node "$ALTRA_NODE" -o wide
talosctl -n "$ALTRA_IP" -e "$ALTRA_IP" get machinestatus -o yaml
```

If the Talos API does not respond, use the Altra BMC/console recovery path and
do not mutate Ceph or etcd until the boot state is known.

Do not remove etcd members, clear Ceph flags, purge OSDs, or delete the
Kubernetes node during rollback unless a separate recovery runbook is written
for the observed failure.

## Evidence retention

Keep all execution evidence under:

```text
/tmp/altra-talos-v1.13.5-${TS}
```

Do not commit generated Talos configs, Tailscale auth material, BMC credentials,
etcd snapshots, or live evidence transcripts. Commit only durable runbook and
GitOps manifest changes.
