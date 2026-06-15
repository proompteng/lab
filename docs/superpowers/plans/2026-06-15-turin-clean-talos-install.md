# Turin Clean Talos Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Turin cleanly from Talos maintenance mode onto the 4TB ORICO NVMe, with Tailscale and NVIDIA Talos extensions present from first boot, without wiping transferred Ceph OSD devices or repeating the failed route/DNS mistakes.

**Architecture:** Treat this as a staged install with hard gates: read-only inventory, local config cleanup, strict validation, one maintenance-mode apply, then post-reboot evidence. The first install uses only the LAN maintenance endpoint `100.100.244.171`; Tailscale is a bootstrapped service to validate after the node comes up, not the address used to apply the initial config.

**Tech Stack:** Talos `v1.13.4`, local `talosctl v1.13.3`, local Talos source checkout `/Users/gregkonush/github.com/talos` at `v1.14.0-alpha.1-75-gd4e0ca1ba` for reference only, Supermicro H14SSL-NT BMC, Kubernetes contexts `galactic-lan` and `galactic-tailscale`, Rook-Ceph, Tailscale Talos extension, NVIDIA Talos system extensions.

---

## Non-Negotiable Boundaries

- Do not run `talosctl bootstrap` for Turin. It joins existing cluster `ryzen`.
- Do not apply `devices/turin/manifests/tailscale-lan-policy-route.patch.yaml`.
- Do not patch live machine config in place to experiment with routes or DNS.
- Do not install Talos to the Kingston NVMe `nvme-KINGSTON_SNV3S1000G_50026B76878F0B27`.
- Do not pass `--user-disks-to-wipe` during install.
- Do not change Rook/Ceph GitOps manifests during the Talos OS install phase.
- Do not remove or purge old `talos-192-168-1-203` Ceph state during the Talos OS install phase.
- Do not print the contents of generated secret-bearing files:
  - `devices/turin/controlplane.yaml`
  - `devices/turin/talosconfig`
  - `devices/turin/manifests/tailscale-extension-service.yaml`

## Files

- Read-only reference: `/Users/gregkonush/github.com/talos/website/content/v1.14/reference/configuration/v1alpha1/config.md`
- Read-only reference: `/Users/gregkonush/github.com/talos/website/content/v1.14/reference/configuration/extensions/extensionserviceconfig.md`
- Read-only reference: `/Users/gregkonush/github.com/talos/website/content/v1.14/reference/configuration/network/hostnameconfig.md`
- Read-only reference: `/Users/gregkonush/github.com/talos/website/content/v1.14/reference/cli.md`
- Review: `devices/turin/docs/cluster-join-plan.md`
- Review: `devices/turin/docs/nvidia-gpu-on-talos.md`
- Review: `docs/runbooks/galactic-kubernetes-access.md`
- Review: `docs/runbooks/rook-ceph-on-talos.md`
- Review: `argocd/applications/rook-ceph/cluster-values.yaml`
- Keep local and gitignored: `devices/turin/controlplane.yaml`
- Keep local and gitignored: `devices/turin/talosconfig`
- Keep local and gitignored: `devices/turin/manifests/tailscale-extension-service.yaml`
- Use patch: `devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml`
- Use patch: `devices/turin/manifests/install-orico-13cbmek6hew8cn2x9akw.patch.yaml`
- Use patch after validation: `devices/turin/manifests/hostname.patch.yaml`
- Use patch: `devices/turin/manifests/etcd-lan-subnet.patch.yaml`
- Use patch: `devices/turin/manifests/kubelet-node-ip-lan-subnet.patch.yaml`
- Use patch: `devices/turin/manifests/kubelet-maxpods.patch.yaml`
- Use patch: `devices/turin/manifests/nvidia-kernel-modules.patch.yaml`
- Use patch: `devices/turin/manifests/time-servers.patch.yaml`
- Use patch after DNS validation: `devices/turin/manifests/tailscale-dns.patch.yaml`
- Remove or ignore: `devices/turin/manifests/tailscale-lan-policy-route.patch.yaml`

### Task 1: Confirm Maintenance-Mode Hardware Inventory

**Files:**
- Read: `devices/turin/docs/cluster-join-plan.md`
- Read: `argocd/applications/rook-ceph/cluster-values.yaml`

- [ ] **Step 1: Confirm Turin is reachable only through maintenance mode**

Run:

```bash
talosctl get machinestatus --insecure -n 100.100.244.171 -e 100.100.244.171 -o yaml
```

Expected:

```text
stage: maintenance
ready: true
```

If this fails, stop. Do not run install commands until the maintenance API responds on `100.100.244.171`.

- [ ] **Step 2: Capture disks and block devices without wiping**

Run:

```bash
talosctl get disks --insecure -n 100.100.244.171 -e 100.100.244.171 -o yaml
talosctl get blockdevices --insecure -n 100.100.244.171 -e 100.100.244.171 -o yaml
```

Expected disk evidence:

```text
ORICO 13CBMEK6HEW8CN2X9AKW exists
three Seagate 24TB HDD OSD devices exist if the transferred OSD cabling is present
KINGSTON SNV3S1000G 50026B76878F0B27 may exist before install; if it is absent,
preserve the no-Kingston Ceph recreate boundary and do not attempt old OSD adoption
```

If the ORICO disk is missing, stop. If the Kingston disk is the only NVMe visible, stop.

- [ ] **Step 3: Verify the install target is the ORICO by-id path**

Run:

```bash
sed -n '1,80p' devices/turin/manifests/install-orico-13cbmek6hew8cn2x9akw.patch.yaml
```

Expected:

```yaml
machine:
  install:
    disk: /dev/disk/by-id/nvme-ORICO_13CBMEK6HEW8CN2X9AKW
    wipe: true
```

If this file points at any raw `/dev/nvmeXn1` path or the Kingston by-id path, stop and correct the patch before continuing.

### Task 2: Confirm Existing Cluster Control Plane Before Join

**Files:**
- Read: `docs/runbooks/galactic-kubernetes-access.md`
- Read: `devices/galactic/docs/add-control-plane-node.md`

- [ ] **Step 1: Verify Kubernetes access through both configured contexts**

Run:

```bash
kubectl --context galactic-lan get nodes -o wide
kubectl --context galactic-tailscale get nodes -o wide
kubectl --context galactic-tailscale get --raw=/readyz?verbose
```

Expected:

```text
talos-192-168-1-194 Ready at 100.100.244.141
talos-192-168-1-85 Ready at 100.100.244.142
readyz returns ok
```

If `kubectl` cannot reach the cluster, stop and fix workstation cluster access before touching Turin.

- [ ] **Step 2: Verify existing etcd membership without changing it**

Run:

```bash
talosctl -n 100.100.244.141 -e 100.100.244.141 etcd members
talosctl -n 100.100.244.142 -e 100.100.244.142 etcd members
```

Expected:

```text
talos-192-168-1-194 is a voting member
talos-192-168-1-85 is a voting member
no stale voting member blocks quorum
```

If an old `203` etcd member is still present, stop and handle membership deliberately before joining Turin.

- [ ] **Step 3: Verify Ceph is only read during OS install planning**

Run:

```bash
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
```

Expected:

```text
Ceph command execution works
old talos-192-168-1-203 OSDs may still be down
no Ceph purge or Rook storage manifest change is made in this phase
```

### Task 3: Clean the Local Install Inputs Before Any Apply

**Files:**
- Modify after approval: `devices/turin/manifests/hostname.patch.yaml`
- Remove after approval: `devices/turin/manifests/tailscale-lan-policy-route.patch.yaml`
- Review: `devices/turin/manifests/tailscale-dns.patch.yaml`

- [ ] **Step 1: Remove the failed policy-route patch from the execution surface**

Run:

```bash
rm devices/turin/manifests/tailscale-lan-policy-route.patch.yaml
rg -n "tailscale-lan-policy-route|table: '52'|LinkConfig" devices/turin docs
```

Expected:

```text
rg returns no references to tailscale-lan-policy-route
rg returns no references to table: '52'
```

This file caused the previous route mistake. It must not be included in any generated command.

- [ ] **Step 2: Make hostname config match the generated Talos v1.13 config**

Keep `devices/turin/manifests/hostname.patch.yaml` as this exact content:

```yaml
apiVersion: v1alpha1
kind: HostnameConfig
auto: off
hostname: turin
```

Reason: the generated Talos v1.13 machine config includes automatic hostname behavior. Dry-run against Turin's maintenance API rejects a hostname patch without `auto: off` because `auto` and `hostname` both remain set after merge.

- [ ] **Step 3: Verify local generated files exist without printing secrets**

Run:

```bash
test -s devices/turin/controlplane.yaml
test -s devices/turin/talosconfig
test -s devices/turin/manifests/tailscale-extension-service.yaml
git check-ignore -v \
  devices/turin/controlplane.yaml \
  devices/turin/talosconfig \
  devices/turin/manifests/tailscale-extension-service.yaml
ls -l devices/turin/manifests/tailscale-extension-service.yaml
```

Expected:

```text
all three test commands exit 0
git check-ignore reports .gitignore entries for all three files
tailscale-extension-service.yaml mode is restricted to the local user
```

If `tailscale-extension-service.yaml` is missing, generate it from the authenticated terminal:

```bash
bun run packages/scripts/src/tailscale/generate-turin-extension-service.ts
```

Do not print the generated file.

- [ ] **Step 4: Validate DNS before using the DNS patch**

Run:

```bash
dig @100.100.100.100 registry.ide-newton.ts.net A +time=2 +tries=1
dig @1.1.1.1 factory.talos.dev A +time=2 +tries=1
dig @8.8.8.8 factory.talos.dev A +time=2 +tries=1
```

Expected:

```text
at least one resolver in tailscale-dns.patch.yaml resolves factory.talos.dev
100.100.100.100 resolves registry.ide-newton.ts.net only if that tailnet resolver is actually reachable from this network path
```

If `100.100.100.100` times out from the workstation or is not meant to be reachable before Tailscale is up, edit `devices/turin/manifests/tailscale-dns.patch.yaml` to known reachable resolvers for first boot:

```yaml
machine:
  network:
    nameservers:
      - 1.1.1.1
      - 8.8.8.8
```

### Task 4: Validate Talos Config Locally and Against Maintenance API

**Files:**
- Read without printing: `devices/turin/controlplane.yaml`
- Read: `devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml`
- Read: `devices/turin/manifests/install-orico-13cbmek6hew8cn2x9akw.patch.yaml`
- Read: `devices/turin/manifests/hostname.patch.yaml`
- Read: `devices/turin/manifests/etcd-lan-subnet.patch.yaml`
- Read: `devices/turin/manifests/kubelet-node-ip-lan-subnet.patch.yaml`
- Read: `devices/turin/manifests/kubelet-maxpods.patch.yaml`
- Read: `devices/turin/manifests/nvidia-kernel-modules.patch.yaml`
- Read: `devices/turin/manifests/time-servers.patch.yaml`
- Read without printing: `devices/turin/manifests/tailscale-extension-service.yaml`
- Read: `devices/turin/manifests/tailscale-dns.patch.yaml`

- [ ] **Step 1: Run strict local validation**

Run:

```bash
talosctl validate --mode metal --strict --config devices/turin/controlplane.yaml
```

Expected:

```text
no validation errors
```

If strict validation fails, stop and fix the generated config before applying anything to Turin.

- [ ] **Step 2: Dry-run the exact apply command against maintenance mode**

Run:

```bash
talosctl apply-config --dry-run --insecure \
  -n 100.100.244.171 \
  -e 100.100.244.171 \
  -f devices/turin/controlplane.yaml \
  --config-patch @devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml \
  --config-patch @devices/turin/manifests/install-orico-13cbmek6hew8cn2x9akw.patch.yaml \
  --config-patch @devices/turin/manifests/hostname.patch.yaml \
  --config-patch @devices/turin/manifests/etcd-lan-subnet.patch.yaml \
  --config-patch @devices/turin/manifests/kubelet-node-ip-lan-subnet.patch.yaml \
  --config-patch @devices/turin/manifests/kubelet-maxpods.patch.yaml \
  --config-patch @devices/turin/manifests/nvidia-kernel-modules.patch.yaml \
  --config-patch @devices/turin/manifests/time-servers.patch.yaml \
  --config-patch @devices/turin/manifests/tailscale-extension-service.yaml \
  --config-patch @devices/turin/manifests/tailscale-dns.patch.yaml \
  --mode=reboot
```

Expected:

```text
dry-run succeeds
the command output does not show a write failure
the command output does not mention tailscale-lan-policy-route.patch.yaml
```

If dry-run fails, stop. Do not switch to another NIC, do not route-patch the live node, and do not use Tailscale as the initial maintenance endpoint.

### Task 5: Apply the Clean Install Once

**Files:**
- Apply from: `devices/turin/controlplane.yaml`
- Apply patches listed in Task 4 only

- [ ] **Step 1: Reconfirm the ORICO disk immediately before apply**

Run:

```bash
talosctl get disks --insecure -n 100.100.244.171 -e 100.100.244.171 -o yaml | \
  rg -n "ORICO|13CBMEK6HEW8CN2X9AKW|KINGSTON|50026B76878F0B27"
```

Expected:

```text
ORICO 13CBMEK6HEW8CN2X9AKW is visible
KINGSTON 50026B76878F0B27 may be visible but is not the install target
```

- [ ] **Step 2: Apply the exact dry-run command without `--dry-run`**

Run only after explicit approval:

```bash
talosctl apply-config --insecure \
  -n 100.100.244.171 \
  -e 100.100.244.171 \
  -f devices/turin/controlplane.yaml \
  --config-patch @devices/turin/manifests/installer-image.tailscale-nvidia-lts.patch.yaml \
  --config-patch @devices/turin/manifests/install-orico-13cbmek6hew8cn2x9akw.patch.yaml \
  --config-patch @devices/turin/manifests/hostname.patch.yaml \
  --config-patch @devices/turin/manifests/etcd-lan-subnet.patch.yaml \
  --config-patch @devices/turin/manifests/kubelet-node-ip-lan-subnet.patch.yaml \
  --config-patch @devices/turin/manifests/kubelet-maxpods.patch.yaml \
  --config-patch @devices/turin/manifests/nvidia-kernel-modules.patch.yaml \
  --config-patch @devices/turin/manifests/time-servers.patch.yaml \
  --config-patch @devices/turin/manifests/tailscale-extension-service.yaml \
  --config-patch @devices/turin/manifests/tailscale-dns.patch.yaml \
  --mode=reboot
```

Expected:

```text
config apply is accepted
node reboots from the ORICO install target
```

If the apply command fails, stop and capture the exact error. Do not retry with a modified patch set.

### Task 6: Monitor First Boot Without Mutating

**Files:**
- Use Talos client config: `devices/turin/talosconfig`

- [ ] **Step 1: Watch local Talos state on the LAN address**

Run:

```bash
until talosctl --talosconfig devices/turin/talosconfig \
  -n 100.100.244.171 \
  -e 100.100.244.171 \
  get machinestatus -o yaml; do
  sleep 15
done
```

Expected:

```text
the node eventually reports a post-maintenance stage
ready becomes true after services settle
```

If it stays in `Booting` with `etcd` unhealthy, stop and collect logs. Do not patch routes or DNS live.

- [ ] **Step 2: Collect service state if boot is not clean**

Run:

```bash
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 service etcd status
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 service kubelet status
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 logs etcd --tail 120
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 logs kubelet --tail 120
```

Expected:

```text
etcd is running or the logs provide the first concrete blocker
kubelet is running or the logs provide the first concrete blocker
```

### Task 7: Validate Join, Tailscale, and Node IP Selection

**Files:**
- Read: `devices/turin/manifests/etcd-lan-subnet.patch.yaml`
- Read: `devices/turin/manifests/kubelet-node-ip-lan-subnet.patch.yaml`

- [ ] **Step 1: Verify etcd sees Turin on LAN addresses**

Run:

```bash
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 etcd members
talosctl -n 100.100.244.141 -e 100.100.244.141 etcd members
```

Expected:

```text
turin appears with peer/client address 100.100.244.171
turin is not stuck forever as an unhealthy learner
existing voters 100.100.244.141 and 100.100.244.142 remain healthy
```

- [ ] **Step 2: Verify Kubernetes node identity and IP**

Run:

```bash
kubectl --context galactic-tailscale get nodes -o wide
kubectl --context galactic-tailscale get node turin -o wide
```

Expected:

```text
node name is turin
InternalIP is 100.100.244.171
node becomes Ready
```

If the node registers with a Tailscale IP as InternalIP, stop and inspect the kubelet `validSubnets` path before any workload scheduling.

- [ ] **Step 3: Verify Tailscale extension after the base node is reachable**

Run:

```bash
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 get extensions | rg tailscale
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 service ext-tailscale status
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 logs ext-tailscale --tail 120
```

Expected:

```text
tailscale extension is installed
ext-tailscale is running
logs show login/control-plane success without accepting DNS from Tailscale
```

### Task 8: Validate NVIDIA Host Support Before GPU Operator Work

**Files:**
- Read: `devices/turin/docs/nvidia-gpu-on-talos.md`
- Read: `devices/turin/manifests/turin-talos-nvidia-lts-schematic.yaml`

- [ ] **Step 1: Verify NVIDIA Talos system extensions**

Run:

```bash
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 get extensions | rg -i "nvidia|container-toolkit"
```

Expected:

```text
nvidia-open-gpu-kernel-modules-lts is present
nvidia-container-toolkit-lts is present
```

- [ ] **Step 2: Verify the host sees the GPU and driver path**

Run:

```bash
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 read /proc/driver/nvidia/version
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 read /proc/modules | rg '^nvidia'
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 get pcidevices | rg -i 'nvidia|10de'
```

Expected:

```text
NVIDIA kernel module exists
RTX PRO 6000 or NVIDIA PCI ID is visible
```

Do not deploy or modify GPU Operator manifests until the host driver evidence is clean.

### Task 9: Keep Ceph Adoption Separate After OS Install

**Files:**
- Read: `docs/runbooks/rook-ceph-on-talos.md`
- Read: `argocd/applications/rook-ceph/cluster-values.yaml`

- [ ] **Step 1: Confirm Ceph health after Turin joins**

Run:

```bash
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
```

Expected:

```text
Ceph command execution still works
old 203 OSDs may still be down
no disks have been purged by the Talos OS install
```

- [ ] **Step 2: Collect final disk by-id inventory for the later Ceph plan**

Run:

```bash
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 get disks -o yaml
talosctl --talosconfig devices/turin/talosconfig -n 100.100.244.171 -e 100.100.244.171 get blockdevices -o yaml
```

Expected:

```text
ORICO OS disk is installed
transferred OSD HDDs remain present
Kingston metadata NVMe may be absent; if absent, do not attempt non-destructive old OSD adoption
```

Only after this evidence exists should a separate Rook/Ceph adoption plan modify `argocd/applications/rook-ceph/cluster-values.yaml`.

## Self-Review

- Spec coverage: the plan covers clean maintenance-mode install, ORICO-only OS target, Tailscale preinstall, NVIDIA extension validation, existing cluster checks, old `203` boundary, and Ceph non-mutation.
- Placeholder scan: operator placeholders are present only inside example shell commands.
- Risk check: the previous `tailscale-lan-policy-route.patch.yaml` path is explicitly removed from execution before validation.
- Version check: local `/Users/gregkonush/github.com/talos` is v1.14 alpha reference material; runtime install remains Talos `v1.13.4`, so `talosctl validate` and `apply-config --dry-run` are mandatory gates. The dry-run gate proved the hostname patch must retain `auto: off`.
