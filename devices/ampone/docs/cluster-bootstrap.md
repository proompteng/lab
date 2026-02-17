# AmpereOne Talos install + join existing cluster (virtual media / ISO)

This runbook installs Talos on the AmpereOne device ("ampone") and joins it to the
existing cluster.

Cluster inventory / canonical join procedure:
- `devices/galactic/README.md`

Assumptions:
- You can reach the BMC (example: `192.168.1.224`) for virtual media / boot control.
- You have a Talos metal ISO available.
- The cluster control plane endpoint is fronted by the NUC load balancer at `https://192.168.1.130:6443`:
  - `devices/nuc/k8s-api-lb/README.md`

## 1) Boot Talos installer (maintenance mode)

1. In the BMC Remote KVM, mount the Talos `.iso` via "CD Image" / "Start Media".
2. Reboot and boot from the virtual CD/DVD device (UEFI boot menu or boot override).
3. Wait for Talos maintenance mode to come up and note the node IP (`<node_ip>`, example: `192.168.1.203`).

## 2) Generate Talos configs for the existing cluster (gitignored)

These files should not be committed:
- `devices/ampone/controlplane.yaml`
- `devices/ampone/worker.yaml`
- `devices/ampone/talosconfig`

If you don't have the original `secrets.yaml` used to create the cluster, derive a
secrets bundle from the existing control plane machine config (sensitive; keep it
out of Git):

```bash
# Extract only the first document of the current controlplane machineconfig.
# (The full machineconfig may include additional docs that are not needed here.)
talosctl get machineconfig -n 192.168.1.194 -e 192.168.1.194 -o jsonpath='{.spec}' \
  | awk '/^---$/{exit} {print}' > /tmp/ryzen-base-controlplane.yaml

talosctl gen secrets \
  --from-controlplane-config /tmp/ryzen-base-controlplane.yaml \
  --output-file /tmp/galactic-secrets.yaml

# Generate machine configs for the existing cluster (cluster name is "ryzen").
talosctl gen config ryzen https://192.168.1.130:6443 \
  --with-secrets /tmp/galactic-secrets.yaml \
  --install-disk /dev/nvme0n1 \
  --output-dir devices/ampone \
  --output-types controlplane,worker,talosconfig \
  --with-docs=false \
  --with-examples=false
```

## 3) Apply config (install + join)

Apply these patches:
- `devices/ampone/manifests/install-nvme0n1.patch.yaml` (install to `/dev/nvme0n1`, wipe)
- `devices/ampone/manifests/allow-scheduling-controlplane.patch.yaml`
- `devices/ampone/manifests/controlplane-endpoint-nuc.patch.yaml` (endpoint + apiserver cert SANs)
- `devices/ampone/manifests/hostname.patch.yaml`
- `devices/ampone/manifests/ephemeral-volume.patch.yaml` (cap system `/var` to 200GB)
- `devices/ampone/manifests/local-path.patch.yaml` (allocate remainder to local-path user volume)

```bash
talosctl apply-config --insecure -n <node_ip> -e <node_ip> \
  -f devices/ampone/controlplane.yaml \
  --config-patch @devices/ampone/manifests/install-nvme0n1.patch.yaml \
  --config-patch @devices/ampone/manifests/allow-scheduling-controlplane.patch.yaml \
  --config-patch @devices/ampone/manifests/controlplane-endpoint-nuc.patch.yaml \
  --config-patch @devices/ampone/manifests/hostname.patch.yaml \
  --config-patch @devices/ampone/manifests/ephemeral-volume.patch.yaml \
  --config-patch @devices/ampone/manifests/local-path.patch.yaml \
  --mode=reboot
```

## 4) Verify join

```bash
talosctl version -n 192.168.1.203 -e 192.168.1.203
talosctl health -n 192.168.1.203 -e 192.168.1.203

talosctl etcd members -n 192.168.1.194 -e 192.168.1.194

kubectl get nodes -o wide
```

Do not run `talosctl bootstrap` again; it only happens once per cluster.
