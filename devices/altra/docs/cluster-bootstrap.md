# altra: install + join existing `galactic` cluster (control plane)

This runbook installs Talos on the `altra` node and joins it to the existing cluster
(`ryzen` cluster name, kubeconfig context `galactic`).

Goals:
- `altra` is installed to NVMe and joins the existing control plane/etcd.
- Kubernetes API stays reachable via the NUC HAProxy endpoint: `https://192.168.1.130:6443`
- `kubectl` continues to work by default with context name `galactic`

Assumptions:
- `ryzen` and `ampone` are already running Talos and form a working cluster.
- `altra` boots Talos in maintenance mode (ISO/USB/PXE) and has an IP on the LAN.
- The NUC (`kalmyk@192.168.1.130`) can run HAProxy (Docker).

Current inventory:
- `ryzen`: `192.168.1.194`
- `ampone`: `192.168.1.203`
- `altra`: `192.168.1.85`

## 0) Ensure the NUC load balancer includes `altra`

Follow:
- `devices/nuc/k8s-api-lb/README.md`

This should create a stable endpoint on the LAN:
- `192.168.1.130:6443` (TCP passthrough to control planes on `:6443`)

Reminder:
- Adding a new control plane requires:
  - adding it to the NUC HAProxy backends, and
  - adding its IP to `cluster.apiServer.certSANs` on the existing control planes
    (already reflected in `devices/*/manifests/controlplane-endpoint-nuc.patch.yaml`).

## 1) Generate join configs for `altra` (gitignored)

These files are intentionally gitignored:
- `devices/altra/controlplane.yaml`
- `devices/altra/talosconfig`

```bash
export ALTRA_IP='192.168.1.85'
export CP_SEED_IP='192.168.1.194'
export K8S_LB_IP='192.168.1.130'

# Extract the active control plane machineconfig and derive the cluster secrets bundle from it.
talosctl get machineconfig -n "$CP_SEED_IP" -e "$CP_SEED_IP" -o jsonpath='{.spec}' \
  | awk '/^---$/{exit} {print}' \
  > /tmp/galactic-base-controlplane.yaml

talosctl gen secrets --from-controlplane-config /tmp/galactic-base-controlplane.yaml \
  --output-file /tmp/galactic-secrets.yaml

# Generate a control plane config for `altra` using the existing cluster secrets.
talosctl gen config ryzen "https://$K8S_LB_IP:6443" \
  --with-secrets /tmp/galactic-secrets.yaml \
  --output-dir devices/altra \
  --output-types controlplane,talosconfig \
  --with-docs=false \
  --with-examples=false \
  --install-disk /dev/nvme0n1
```

## 2) Apply config to `altra` (first install)

```bash
# `altra` should be in maintenance mode when you run this.
talosctl apply-config --insecure -n "$ALTRA_IP" -e "$ALTRA_IP" \
  -f devices/altra/controlplane.yaml \
  --config-patch @devices/altra/manifests/hostname.patch.yaml \
  --config-patch @devices/altra/manifests/install-nvme0n1.patch.yaml \
  --config-patch @devices/altra/manifests/ephemeral-volume.patch.yaml \
  --config-patch @devices/altra/manifests/local-path.patch.yaml \
  --config-patch @devices/altra/manifests/vfio-modules.patch.yaml \
  --config-patch @devices/altra/manifests/allow-scheduling-controlplane.patch.yaml \
  --config-patch @devices/altra/manifests/controlplane-endpoint-nuc.patch.yaml \
  --mode=reboot
```

Note:
- The IP can change after reboot/install (DHCP). Use console/KVM to confirm the
  post-install IP if `talosctl` can’t connect.
 - `devices/altra/manifests/vfio-modules.patch.yaml` is required for KubeVirt GPU
   passthrough on Talos (it preloads `vfio_pci` so the GPU Operator VFIO manager
   can bind the GPU without `modprobe` privileges).

## 3) Update local Talos config to include all 3 nodes

```bash
talosctl config endpoint 192.168.1.194 192.168.1.203 192.168.1.85
talosctl config node 192.168.1.194 192.168.1.203 192.168.1.85
```

## 4) Verify `altra` joined

```bash
talosctl health
talosctl etcd members

kubectl config use-context galactic
kubectl get nodes -o wide
```
