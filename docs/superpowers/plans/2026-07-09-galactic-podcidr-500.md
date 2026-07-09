# Galactic Pod CIDR 500 Pod Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `galactic-tailscale` Talos/Kubernetes cluster to a new non-overlapping Pod CIDR with `/23` per-node PodCIDRs and enable a 500 pod kubelet cap on the high-density node path.

**Architecture:** Keep the current Flannel `host-gw` networking model and Kubernetes host-scope NodeIPAM. Use a new global Pod CIDR so the old `/24` allocations under `10.244.0.0/16` cannot overlap with new `/23` allocations. Treat this as a maintenance-window network migration, not a rolling no-downtime config flip.

**Tech Stack:** Talos machine config, Kubernetes kube-controller-manager NodeIPAM, kubelet `maxPods`, Flannel `--kube-subnet-mgr`, kube-proxy `nftables`, Argo CD GitOps, Rook-Ceph preflight checks.

---

## Current State

Live readback from this planning pass:

- Current context: `galactic-tailscale`
- Nodes:
  - `turin`: `podCIDR=10.244.0.0/24`, `allocatable.pods=200`, active non-completed pods at the cap.
  - `talos-192-168-1-194`: `podCIDR=10.244.3.0/24`, `allocatable.pods=200`.
  - `talos-192-168-1-85`: `podCIDR=10.244.5.0/24`, `allocatable.pods=200`.
- Controller managers run `--allocate-node-cidrs=true` and `--cluster-cidr=10.244.0.0/16`.
- No live `--node-cidr-mask-size-ipv4` is set, so Kubernetes uses the IPv4 default `/24`.
- Flannel runs in `kube-system` with `--kube-subnet-mgr` and `net-conf.json` set to `Network: 10.244.0.0/16`.
- kube-proxy runs with `--cluster-cidr=10.244.0.0/16` and `--proxy-mode=nftables`.
- ARC currently has pending `arc-amd64` runners blocked by scheduler events including `Too many pods` on `turin`; the smaller amd64 node is also short on CPU/memory for the standard runner shape.

Research constraints:

- Kubernetes kube-controller-manager defaults IPv4 node CIDR mask size to `/24`; `--node-cidr-mask-size-ipv4=23` is the control-plane knob for `/23` node blocks. Source: https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/
- kubelet `maxPods` is the maximum number of pods that can run on a kubelet and defaults to 110. Source: https://kubernetes.io/docs/reference/config-api/kubelet-config.v1beta1/
- Kubernetes large-cluster guidance says the designed envelope includes no more than 110 pods per node. A 500 pod cap is therefore an intentional high-density exception that must be validated locally. Source: https://kubernetes.io/docs/setup/best-practices/cluster-large/
- Talos supports `cluster.network.podSubnets`, `cluster.controllerManager.extraArgs`, and `machine.kubelet.extraConfig` in machine config. Source: https://docs.siderolabs.com/talos/v1.13/reference/configuration/v1alpha1/config
- Talos machine config can be patched live with `talosctl patch machineconfig` / `talosctl apply-config`; `--mode=no-reboot` fails if the field cannot be applied live. Source: https://docs.siderolabs.com/talos/v1.13/configure-your-talos-cluster/system-configuration/editing-machine-configuration
- Flannel `--kube-subnet-mgr` uses Kubernetes node PodCIDRs; its config `Network` must match the cluster Pod CIDR. Source: https://github.com/flannel-io/flannel/blob/master/Documentation/configuration.md
- Kubernetes issue #90922 documents why changing node CIDR mask size in-place inside the same cluster CIDR can create overlapping allocations. Source: https://github.com/kubernetes/kubernetes/issues/90922
- Talos' documented scale-down path is `talosctl reset` followed by `kubectl delete node`; reset gracefully cordons/drains, leaves etcd when needed, and deregisters the node from Talos discovery, but Kubernetes node deletion is still required. Source: https://docs.siderolabs.com/talos/v1.13/deploy-and-manage-workloads/scaling-down
- Talos reset is destructive and supports `--graceful` (default true), `--reboot`, and targeted `--system-labels-to-wipe` flags. Source: https://docs.siderolabs.com/talos/v1.13/configure-your-talos-cluster/lifecycle-management/resetting-a-machine
- Talos' documented scale-up path is to boot the machine, apply the current `controlplane.yaml` or `worker.yaml` with `talosctl apply-config --insecure`, and let it join automatically without bootstrapping again. Source: https://docs.siderolabs.com/talos/v1.13/deploy-and-manage-workloads/scaling-up

## Chosen Target

Use:

- New global Pod CIDR: `10.246.0.0/16`
- Per-node PodCIDR mask: `/23`
- Kubelet cap on every live node: `maxPods: 500`
- Initial 500 pod scope: all live nodes: `ryzen` / `talos-192-168-1-194`, `altra` / `talos-192-168-1-85`, and `turin`

Rationale:

- A `/23` has 512 IPv4 addresses. After network/broadcast and CNI bridge/gateway use, it still leaves enough room for a `maxPods=500` kubelet cap because host-network pods count toward maxPods but do not consume PodCIDR addresses.
- Reusing `10.244.0.0/16` while changing from `/24` to `/23` is not safe for a live partial migration because existing `/24` allocations can overlap with new `/23` allocations.
- `10.246.0.0/16` avoids the current `10.244.0.0/16` pod network, the `10.96.0.0/12` service network, Tailscale `100.64.0.0/10`, and the LAN `192.168.1.0/24`. It must still be checked against any local static routes before execution.
- Setting 500 everywhere removes pod-density as a scheduler limiter on every current node. CPU and memory requests still gate placement independently, so this change does not make under-sized nodes fit ARC runners that exceed their allocatable CPU or memory.

Execution split:

- Current execution: merge the tracked `maxPods: 500` patches and this plan, then live-patch only kubelet `maxPods` on `ryzen`, `altra`, and `turin`. PodCIDRs remain on the current `10.244.*.0/24` allocations during this step.
- Future maintenance window: migrate to `10.246.0.0/16` with `/23` node PodCIDRs by using Talos-supported node reset/deregistration and fresh registration. Do not live-flip the cluster CIDR or node CIDR mask in place.

## Files To Change

- Modify: `argocd/applications/flannel-cni/kube-flannel-cfg.yaml`
  - Change `data.net-conf.json.Network` from `10.244.0.0/16` to `10.246.0.0/16`.
- Create: `devices/galactic/manifests/pod-network-10-246-nodecidr-23.patch.yaml`
  - Cluster-wide Talos patch for `cluster.network.podSubnets` and `cluster.controllerManager.extraArgs.node-cidr-mask-size-ipv4`.
- Modify:
  - `devices/altra/manifests/kubelet-maxpods.patch.yaml`
  - `devices/ryzen/manifests/kubelet-maxpods.patch.yaml`
  - `devices/turin/manifests/kubelet-maxpods.patch.yaml`
  - Change `machine.kubelet.extraConfig.maxPods` from `200` to `500`.
- Modify:
  - `devices/altra/manifests/README.md`
  - `devices/ryzen/docs/cluster-bootstrap.md`
  - `devices/turin/README.md`
  - Update maxPods references from 200 to 500 and note this is a high-density exception.
- Create: `devices/galactic/docs/podcidr-500-migration.md`
  - Operator runbook with preflight, maintenance execution, rollback, and validation commands.

Do not change ARC runner maxRunners as part of this migration. Pod capacity and GitHub runner concurrency are separate controls.

## Task 1: Add GitOps And Talos Config Changes

**Files:**
- Modify: `argocd/applications/flannel-cni/kube-flannel-cfg.yaml`
- Create: `devices/galactic/manifests/pod-network-10-246-nodecidr-23.patch.yaml`
- Modify: `devices/altra/manifests/kubelet-maxpods.patch.yaml`
- Modify: `devices/ryzen/manifests/kubelet-maxpods.patch.yaml`
- Modify: `devices/turin/manifests/kubelet-maxpods.patch.yaml`
- Modify: `devices/altra/manifests/README.md`
- Modify: `devices/ryzen/docs/cluster-bootstrap.md`
- Modify: `devices/turin/README.md`

- [ ] **Step 1: Create a fresh implementation branch**

Run:

```bash
git fetch origin main
git switch -C codex/galactic-podcidr-500 origin/main
```

Expected: branch `codex/galactic-podcidr-500` is tracking fresh `origin/main`.

- [ ] **Step 2: Update the repo-managed Flannel network**

Edit `argocd/applications/flannel-cni/kube-flannel-cfg.yaml` so `net-conf.json` is exactly:

```yaml
  net-conf.json: |-
    {
      "Network": "10.246.0.0/16",
      "Backend": {
        "Type": "host-gw"
      }
    }
```

Reason: Argo CD owns this ConfigMap. If this file remains `10.244.0.0/16`, Argo can revert the live Flannel config during or after the migration.

- [ ] **Step 3: Add the cluster network Talos patch**

Create `devices/galactic/manifests/pod-network-10-246-nodecidr-23.patch.yaml`:

```yaml
cluster:
  network:
    podSubnets:
      - 10.246.0.0/16
  controllerManager:
    extraArgs:
      node-cidr-mask-size-ipv4: "23"
```

Reason: `cluster.network.podSubnets` is the Talos source for the control-plane and kube-proxy Pod CIDR, while `node-cidr-mask-size-ipv4` changes the per-node allocation size to `/23`.

- [ ] **Step 4: Update all live node kubelet pod caps**

Edit these files to the same content:

- `devices/altra/manifests/kubelet-maxpods.patch.yaml`
- `devices/ryzen/manifests/kubelet-maxpods.patch.yaml`
- `devices/turin/manifests/kubelet-maxpods.patch.yaml`

```yaml
machine:
  kubelet:
    extraConfig:
      maxPods: 500
```

Reason: the target is a 500-pod node cap on all current nodes. CPU and memory requests still prevent oversized workloads from landing on nodes that cannot fit them.

- [ ] **Step 5: Update device docs**

In `devices/turin/README.md`, change the maxPods bullet to:

````markdown
- `devices/turin/manifests/kubelet-maxpods.patch.yaml` (set kubelet `maxPods` to 500 for the high-density scheduling path)
````

In `devices/altra/manifests/README.md` and `devices/ryzen/docs/cluster-bootstrap.md`, change existing maxPods text from `200` to `500`.

Add this sentence near each device's Kubernetes/Talos notes:

````markdown
The 500-pod kubelet cap is a deliberate high-density exception; validate `/23` PodCIDR allocation and node pressure before increasing ARC runner concurrency.
````

- [ ] **Step 6: Validate the config diff**

Run:

```bash
git diff --check
kustomize build argocd/applications/flannel-cni
bunx oxfmt --check \
  argocd/applications/flannel-cni/kube-flannel-cfg.yaml \
  devices/galactic/manifests/pod-network-10-246-nodecidr-23.patch.yaml \
  devices/altra/manifests/kubelet-maxpods.patch.yaml \
  devices/ryzen/manifests/kubelet-maxpods.patch.yaml \
  devices/turin/manifests/kubelet-maxpods.patch.yaml
```

Expected:

- `git diff --check` has no output.
- `kustomize build` renders the ConfigMap with `Network: 10.246.0.0/16`.
- `oxfmt --check` passes for the touched YAML files.

- [ ] **Step 7: Commit**

Run:

```bash
git add \
  argocd/applications/flannel-cni/kube-flannel-cfg.yaml \
  devices/galactic/manifests/pod-network-10-246-nodecidr-23.patch.yaml \
  devices/altra/manifests/kubelet-maxpods.patch.yaml \
  devices/ryzen/manifests/kubelet-maxpods.patch.yaml \
  devices/turin/manifests/kubelet-maxpods.patch.yaml \
  devices/altra/manifests/README.md \
  devices/ryzen/docs/cluster-bootstrap.md \
  devices/turin/README.md
git commit -m "fix(galactic): prepare 500 pod cidr migration"
```

Expected: one commit with only the config changes above.

## Task 2: Write The Operator Migration Runbook

**Files:**
- Create: `devices/galactic/docs/podcidr-500-migration.md`

- [ ] **Step 1: Create the runbook header and risk statement**

Create `devices/galactic/docs/podcidr-500-migration.md` with:

````markdown
# Galactic PodCIDR 500-Pod Migration Runbook

This runbook migrates `galactic-tailscale` from `10.244.0.0/16` with `/24` node PodCIDRs to `10.246.0.0/16` with `/23` node PodCIDRs, and raises `altra`, `ryzen`, and `turin` kubelet caps to 500 pods.

This is a maintenance-window migration. Do not treat it as a zero-downtime rolling change. Existing nodes already have `/24` PodCIDRs, and upstream Kubernetes NodeIPAM can overlap old `/24` allocations with new `/23` allocations if the mask is changed inside the same CIDR. This runbook uses a new Pod CIDR and recreates node registrations to avoid that class of failure.

Do not run this during Ceph recovery, Talos upgrade work, or active ARC queue pressure that cannot be paused.
````

- [ ] **Step 2: Add preflight commands**

Append:

````markdown
## Preflight

Confirm context and current PodCIDRs:

```bash
kubectl config current-context
kubectl get nodes -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR,PODS:.status.allocatable.pods,READY:.status.conditions[-1].type
```

Expected before migration:

```text
galactic-tailscale
talos-192-168-1-194   10.244.3.0/24   200
talos-192-168-1-85    10.244.5.0/24   200
turin                 10.244.0.0/24   200
```

Confirm no route overlap for the target Pod CIDR from every node:

```bash
for node in 100.100.244.190 100.100.244.141 100.100.244.142; do
  echo "== $node =="
  talosctl -n "$node" -e 100.100.244.190 read /proc/net/fib_trie | rg '10\\.246\\.' || true
done
```

Confirm control-plane and storage health:

```bash
talosctl -n 100.100.244.190 -e 100.100.244.190 health
talosctl -n 100.100.244.190 -e 100.100.244.190 etcd members
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
```

Expected:

- Talos health passes.
- Etcd has quorum.
- Ceph is `HEALTH_OK` or has only explicitly accepted non-network maintenance warnings.

Freeze high-churn schedulers:

```bash
kubectl -n arc scale autoscalingrunnerset.actions.github.com/arc-amd64 --replicas=0
kubectl -n arc scale autoscalingrunnerset.actions.github.com/arc-arm64 --replicas=0
kubectl -n arc scale autoscalingrunnerset.actions.github.com/analysis-arm64 --replicas=0
kubectl -n arc get autoscalingrunnersets,ephemeralrunnersets,pods -o wide
```

If the ARC CRD does not allow direct `scale`, patch min/max runners in the ARC Helm values through GitOps or pause the controller path instead of force-deleting live runner pods.
````

- [ ] **Step 3: Add backup commands**

Append:

````markdown
## Backup

Take an etcd snapshot before any CIDR change:

```bash
snapshot="/tmp/galactic-pre-podcidr-$(date +%Y%m%d%H%M%S).db"
talosctl -n 100.100.244.190 -e 100.100.244.190 etcd snapshot "$snapshot"
ls -lh "$snapshot"
```

Save the current live network objects:

```bash
kubectl -n kube-system get cm kube-flannel-cfg -o yaml > /tmp/kube-flannel-cfg.pre-podcidr.yaml
kubectl -n kube-system get ds kube-flannel -o yaml > /tmp/kube-flannel-ds.pre-podcidr.yaml
kubectl -n kube-system get ds kube-proxy -o yaml > /tmp/kube-proxy-ds.pre-podcidr.yaml
kubectl get nodes -o yaml > /tmp/nodes.pre-podcidr.yaml
```
````

- [ ] **Step 4: Add live change commands**

Append:

````markdown
## Apply Cluster CIDR And Node maxPods

Patch all current control-plane nodes with the new cluster Pod CIDR and `/23` allocation mask:

```bash
for node in 100.100.244.190 100.100.244.141 100.100.244.142; do
  talosctl patch machineconfig \
    -n "$node" \
    -e 100.100.244.190 \
    --patch @devices/galactic/manifests/pod-network-10-246-nodecidr-23.patch.yaml \
    --mode=no-reboot
done
```

Patch every live node's kubelet cap:

```bash
talosctl patch machineconfig \
  -n 100.100.244.141 \
  -e 100.100.244.190 \
  --patch @devices/ryzen/manifests/kubelet-maxpods.patch.yaml \
  --mode=no-reboot

talosctl patch machineconfig \
  -n 100.100.244.142 \
  -e 100.100.244.190 \
  --patch @devices/altra/manifests/kubelet-maxpods.patch.yaml \
  --mode=no-reboot

talosctl patch machineconfig \
  -n 100.100.244.190 \
  -e 100.100.244.190 \
  --patch @devices/turin/manifests/kubelet-maxpods.patch.yaml \
  --mode=no-reboot
```

Sync or apply the repo-managed Flannel ConfigMap:

```bash
kubectl apply -k argocd/applications/flannel-cni
kubectl -n kube-system get cm kube-flannel-cfg -o jsonpath='{.data.net-conf\.json}{"\n"}'
```

Expected ConfigMap output contains `10.246.0.0/16`.

Verify generated control-plane args changed:

```bash
kubectl -n kube-system get pod -l component=kube-controller-manager -o json \
  | jq -r '.items[] | .metadata.name as $n | .spec.containers[] | select(.name=="kube-controller-manager") | $n, (.command // [] | .[]), (.args // [] | .[])' \
  | rg 'kube-controller-manager|cluster-cidr|node-cidr-mask'

kubectl -n kube-system get ds kube-proxy -o json \
  | jq -r '.spec.template.spec.containers[] | select(.name=="kube-proxy") | (.command // [] | .[]), (.args // [] | .[])' \
  | rg 'cluster-cidr|proxy-mode'
```

Expected:

- Controller-manager uses `--cluster-cidr=10.246.0.0/16`.
- Controller-manager uses `--node-cidr-mask-size-ipv4=23`.
- kube-proxy uses `--cluster-cidr=10.246.0.0/16`.
````

- [ ] **Step 5: Add node re-registration procedure**

Append:

````markdown
## Recreate Node Registrations

Run one node at a time. Do not proceed to the next node until the current node has the new `/23` PodCIDR and pod networking passes smoke tests.

Use the Talos-supported remove/add lifecycle. Do not try to clear `spec.podCIDR` manually, patch Kubernetes node objects, or restart kubelet against an existing node registration.

Recommended order:

1. `talos-192-168-1-194` / `100.100.244.141`
2. `talos-192-168-1-85` / `100.100.244.142`
3. `turin` / `100.100.244.190`

For each node, prepare a current machine config before resetting it. Use the same generated config and config patches that own the node today, including the new PodCIDR patch and that node's `kubelet-maxpods.patch.yaml`.

Then run the remove/add sequence:

```bash
node_name='<kubernetes-node-name>'
reset_node_ip='<current-talos-node-ip>'
maintenance_ip='<post-reset-maintenance-ip>'
endpoint='100.100.244.190'
machine_config='<path-to-current-controlplane-or-worker-yaml>'

# Talos reset defaults to --graceful=true: it cordons/drains, leaves etcd when
# applicable, and deregisters the node from Talos discovery.
talosctl reset \
  -n "$reset_node_ip" \
  -e "$endpoint" \
  --reboot \
  --system-labels-to-wipe STATE \
  --system-labels-to-wipe EPHEMERAL

kubectl delete node "$node_name"

# After the machine reboots into maintenance mode, apply the current config.
talosctl apply-config \
  --insecure \
  -n "$maintenance_ip" \
  -e "$maintenance_ip" \
  -f "$machine_config" \
  --config-patch @devices/galactic/manifests/pod-network-10-246-nodecidr-23.patch.yaml \
  --mode=reboot

kubectl wait --for=condition=Ready "node/$node_name" --timeout=10m
kubectl get node "$node_name" -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR,PODS:.status.allocatable.pods

kubectl -n kube-system delete pod \
  --field-selector spec.nodeName="$node_name" \
  -l k8s-app=flannel \
  --ignore-not-found

kubectl -n kube-system delete pod \
  --field-selector spec.nodeName="$node_name" \
  -l k8s-app=kube-proxy \
  --ignore-not-found

kubectl -n kube-system wait --for=condition=Ready pod \
  --field-selector spec.nodeName="$node_name" \
  -l k8s-app=flannel \
  --timeout=5m

kubectl -n kube-system wait --for=condition=Ready pod \
  --field-selector spec.nodeName="$node_name" \
  -l k8s-app=kube-proxy \
  --timeout=5m

kubectl uncordon "$node_name"
```

`maintenance_ip` might be a LAN DHCP address instead of the previous Tailscale IP because wiping `STATE` removes the machine config and Tailscale identity until the config is applied again. Confirm it from console, DHCP leases, or the BMC before rejoining the node.

If a full disk wipe is intentional instead of the targeted `STATE`/`EPHEMERAL` reset, omit the `--system-labels-to-wipe` flags and be ready to boot the node from ISO/PXE before `apply-config --insecure`. Do not choose that path for this cluster unless console access and install media are already confirmed.

Expected per-node results:

- `talos-192-168-1-194` gets a `10.246.x.0/23` PodCIDR and reports `allocatable.pods=500`.
- `talos-192-168-1-85` gets a `10.246.x.0/23` PodCIDR and reports `allocatable.pods=500`.
- `turin` gets a `10.246.x.0/23` PodCIDR and reports `allocatable.pods=500`.

If any node re-registers with `10.244.*` or `/24`, stop. The controller-manager or Talos patch did not apply correctly.
````

- [ ] **Step 6: Add network smoke tests**

Append:

````markdown
## Network Smoke Tests

Create one smoke pod per node:

```bash
for node in talos-192-168-1-194 talos-192-168-1-85 turin; do
  kubectl -n default run "podcidr-smoke-$node" \
    --image=busybox:1.36 \
    --restart=Never \
    --overrides="{\"spec\":{\"nodeName\":\"$node\",\"containers\":[{\"name\":\"busybox\",\"image\":\"busybox:1.36\",\"command\":[\"sleep\",\"3600\"]}]}}"
done
kubectl -n default wait --for=condition=Ready pod -l run --timeout=5m
kubectl -n default get pods -o wide | rg 'podcidr-smoke'
```

Test cross-node pod connectivity and service DNS:

```bash
for pod in $(kubectl -n default get pods -o name | rg 'podcidr-smoke'); do
  kubectl -n default exec "$pod" -- nslookup kubernetes.default.svc.cluster.local
  kubectl -n default exec "$pod" -- wget -qO- --timeout=5 https://kubernetes.default.svc --no-check-certificate
  kubectl -n default exec "$pod" -- ip addr
  kubectl -n default exec "$pod" -- ip route
done
```

Expected:

- Smoke pod IPs are under `10.246.0.0/16`.
- DNS resolves `kubernetes.default.svc.cluster.local`.
- Service access reaches the Kubernetes API service.

Clean up:

```bash
kubectl -n default delete pod -l run --ignore-not-found
```
````

- [ ] **Step 7: Add ARC restore and validation**

Append:

````markdown
## Restore ARC And Validate Capacity

Restore ARC runner ranges through the owning GitOps values, then verify runner scheduling:

```bash
kubectl -n arc get autoscalingrunnersets,ephemeralrunnersets,pods -o wide
kubectl get nodes -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR,PODS:.status.allocatable.pods
```

Submit a small controlled ARC workload before allowing a full queue:

```bash
gh run list -R proompteng/lab --limit 10
kubectl -n arc get pods -o wide -w
```

Expected:

- Pending ARC pods no longer report `Too many pods` for arch-matching nodes.
- Pod IPs for new ARC runners are under `10.246.0.0/16`.
- If ARC still fails scheduling, the remaining blocker should be CPU/memory/resource requests, not pod density.
````

- [ ] **Step 8: Add rollback procedure**

Append:

````markdown
## Rollback

Rollback is clean only before any node has been re-registered with `10.246.0.0/16`. After one node has new PodCIDR allocation, rollback requires re-registering that node again under the old CIDR.

If validation fails before node re-registration:

```bash
git checkout origin/main -- argocd/applications/flannel-cni/kube-flannel-cfg.yaml
kubectl apply -k argocd/applications/flannel-cni

cat >/tmp/pod-network-10-244-nodecidr-24.patch.yaml <<'YAML'
cluster:
  network:
    podSubnets:
      - 10.244.0.0/16
  controllerManager:
    extraArgs:
      node-cidr-mask-size-ipv4: "24"
YAML

for node in 100.100.244.190 100.100.244.141 100.100.244.142; do
  talosctl patch machineconfig \
    -n "$node" \
    -e 100.100.244.190 \
    --patch @/tmp/pod-network-10-244-nodecidr-24.patch.yaml \
    --mode=no-reboot
done
```

If validation fails after a node has been re-registered:

1. Keep the node cordoned.
2. Reapply the old `10.244.0.0/16` patch.
3. Delete and re-register only that node.
4. Restart Flannel and kube-proxy on that node.
5. Confirm the node is back on `/24`.
6. Only then uncordon or decide to restore from etcd snapshot.
````

- [ ] **Step 9: Commit the runbook**

Run:

```bash
git add devices/galactic/docs/podcidr-500-migration.md
git commit -m "docs(galactic): add podcidr 500 migration runbook"
```

Expected: one docs commit after the config commit.

## Task 3: Open PR And Gate On Review

**Files:**
- Read: `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: Fill the PR template**

Run:

```bash
tmp="$(mktemp)"
cp .github/PULL_REQUEST_TEMPLATE.md "$tmp"
```

Edit `$tmp` so the body contains:

```markdown
## Summary

- raises `altra`, `ryzen`, and `turin` kubelet `maxPods` patches to 500
- updates device docs so bootstrap/reapply paths describe the 500-pod cap
- documents the future `10.246.0.0/16` `/23` PodCIDR migration and Talos-supported reset/rejoin procedure

## Testing

- `git diff --check`
- `bunx oxfmt --check devices/altra/manifests/kubelet-maxpods.patch.yaml devices/ryzen/manifests/kubelet-maxpods.patch.yaml devices/turin/manifests/kubelet-maxpods.patch.yaml`
- markdown fence validation for `docs/superpowers/plans/2026-07-09-galactic-podcidr-500.md`

## Rollout

After merge, patch the three live Talos machine configs with the tracked `kubelet-maxpods.patch.yaml` files using `--mode=no-reboot`, then verify `status.allocatable.pods=500`. Do not change PodCIDRs, Flannel, or controller-manager CIDR flags in this rollout.

## Risks

- 500 pods/node exceeds Kubernetes' documented large-cluster design target of 110 pods/node, so this is an intentional local high-density exception.
- This PR does not perform the PodCIDR migration; the future CIDR change remains a maintenance-window procedure.

## Rollback

Revert the kubelet maxPods patches to the previous value and patch the live Talos machine configs again with `--mode=no-reboot`.
```

Scan for placeholders:

```bash
rg -n 'TODO|TBD|<|>|\[ \]' "$tmp"
```

Expected: no placeholder output that came from the template.

- [ ] **Step 2: Push and open PR**

Run:

```bash
git push -u origin codex/galactic-podcidr-500-plan
gh pr create \
  -R proompteng/lab \
  --title "fix(galactic): raise kubelet pod cap to 500" \
  --body-file "$tmp"
```

Expected: ready PR, not draft.

- [ ] **Step 3: Wait for checks**

Run:

```bash
gh pr checks -R proompteng/lab --watch
```

Expected: mandatory checks pass before merge.

## Task 4: Execute Current MaxPods-Only Change

**Files:**
- Read: `devices/altra/manifests/kubelet-maxpods.patch.yaml`
- Read: `devices/ryzen/manifests/kubelet-maxpods.patch.yaml`
- Read: `devices/turin/manifests/kubelet-maxpods.patch.yaml`

- [ ] **Step 1: Merge only after CI is green**

Run:

```bash
gh pr merge <PR_NUMBER> --squash -R proompteng/lab
```

Expected: PR merged to `main`.

- [ ] **Step 2: Pull fresh main in the operation worktree**

Run:

```bash
git fetch origin main
git switch main
git pull --ff-only origin main
```

Expected: local files include the merged plan and maxPods patches.

- [ ] **Step 3: Patch maxPods live without changing PodCIDRs**

Run:

```bash
talosctl patch machineconfig \
  -n 100.100.244.141 \
  -e 100.100.244.190 \
  --patch @devices/ryzen/manifests/kubelet-maxpods.patch.yaml \
  --mode=no-reboot

talosctl patch machineconfig \
  -n 100.100.244.142 \
  -e 100.100.244.190 \
  --patch @devices/altra/manifests/kubelet-maxpods.patch.yaml \
  --mode=no-reboot

talosctl patch machineconfig \
  -n 100.100.244.190 \
  -e 100.100.244.190 \
  --patch @devices/turin/manifests/kubelet-maxpods.patch.yaml \
  --mode=no-reboot
```

- [ ] **Step 4: Verify maxPods changed and PodCIDRs did not**

Run:

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR,PODS:.status.allocatable.pods
```

Expected values for this maxPods-only execution:

- `talos-192-168-1-194` reports `PODS=500` and keeps its existing `10.244.*.0/24` PodCIDR.
- `talos-192-168-1-85` reports `PODS=500` and keeps its existing `10.244.*.0/24` PodCIDR.
- `turin` reports `PODS=500` and keeps its existing `10.244.*.0/24` PodCIDR.

Do not patch `cluster.network.podSubnets`, `node-cidr-mask-size-ipv4`, or the Flannel ConfigMap during this step.

## Task 5: Execute Future PodCIDR Maintenance Window

**Files:**
- Read: `devices/galactic/docs/podcidr-500-migration.md`

- [ ] **Step 1: Run the runbook exactly during a dedicated maintenance window**

Run the sections in `devices/galactic/docs/podcidr-500-migration.md` in this order:

1. Preflight
2. Backup
3. Apply Cluster CIDR And Node maxPods
4. Recreate Node Registrations
5. Network Smoke Tests
6. Restore ARC And Validate Capacity

Expected final state:

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR,PODS:.status.allocatable.pods
kubectl -n kube-system get cm kube-flannel-cfg -o jsonpath='{.data.net-conf\.json}{"\n"}'
kubectl -n arc get pods -o wide
```

Expected values:

- All node PodCIDRs are `10.246.*.0/23`.
- `altra`, `ryzen`, and `turin` all report `PODS=500`.
- Flannel ConfigMap reports `Network: 10.246.0.0/16`.
- New ARC runner pods receive `10.246.*` pod IPs.
- ARC pending pods no longer have `Too many pods` for arch-matching nodes.

## Task 6: Post-Migration Soak

**Files:**
- Modify if needed: `devices/galactic/docs/podcidr-500-migration.md`

- [ ] **Step 1: Watch pressure and control-plane stability for 24 hours**

Run periodically:

```bash
kubectl top nodes
kubectl get --raw /readyz?verbose | tail -n 40
kubectl -n kube-system logs -l k8s-app=flannel --tail=200
kubectl -n kube-system logs -l k8s-app=kube-proxy --tail=200
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n arc get autoscalingrunnersets,ephemeralrunnersets,pods -o wide
```

Expected:

- No kubelet pressure conditions on `altra`, `ryzen`, or `turin`.
- No Flannel lease or route errors.
- No kube-proxy nftables sync storm.
- Ceph remains healthy.
- ARC scheduling failures, if any, are CPU/memory/request-fit failures rather than pod density.

- [ ] **Step 2: Decide whether ARC concurrency can increase**

Only after the 24-hour soak, decide whether to increase ARC `maxRunners`. Do not change ARC concurrency during the CIDR migration itself.

## Final Verification Checklist

- [ ] `kustomize build argocd/applications/flannel-cni` renders `10.246.0.0/16`.
- [ ] kube-controller-manager args show `--cluster-cidr=10.246.0.0/16`.
- [ ] kube-controller-manager args show `--node-cidr-mask-size-ipv4=23`.
- [ ] kube-proxy args show `--cluster-cidr=10.246.0.0/16`.
- [ ] `kubectl get nodes` shows all live nodes on `10.246.*.0/23`.
- [ ] `kubectl get nodes` shows `status.allocatable.pods=500` for `altra`, `ryzen`, and `turin`.
- [ ] Flannel pods are ready on every node.
- [ ] kube-proxy pods are ready on every node.
- [ ] Cross-node smoke pods can resolve DNS and reach `kubernetes.default.svc`.
- [ ] ARC runner pods can schedule on arch-matching nodes without `Too many pods`.
- [ ] Ceph is healthy after the migration.

## Non-Goals

- Do not migrate from Flannel to Cilium in this change.
- Do not increase ARC `maxRunners` in this change.
- Do not increase ARC runner concurrency in this change.
- Do not attempt this as an unattended Argo sync.
