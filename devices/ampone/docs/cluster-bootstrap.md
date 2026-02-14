# AmpereOne Talos bootstrap (virtual media / ISO)

This runbook is a template for installing Talos on the AmpereOne device ("ampone").

Assumptions:
- You can reach the BMC (example: `192.168.1.224`) for virtual media / boot control.
- You have a Talos metal ISO available (Talos "metal" installer ISO).

## 1) Boot Talos installer

1. In the BMC Remote KVM, mount the Talos `.iso` via "CD Image" / "Start Media".
2. Reboot and boot from the virtual CD/DVD device (UEFI boot menu or boot override).
3. Wait for Talos maintenance mode to come up and note the node IP (`<node_ip>`).

## 2) Generate Talos config (gitignored)

These files should not be committed:
- `devices/ampone/controlplane.yaml`
- `devices/ampone/worker.yaml`
- `devices/ampone/talosconfig`
- `devices/ampone/node-machineconfig.yaml` (optional; local scratch)

Generate configs:

```bash
export TALOSCONFIG=$PWD/devices/ampone/talosconfig

talosctl gen config ampone https://<endpoint_ip>:6443 \
  --output-dir devices/ampone \
  --install-disk <install_disk>
```

## 3) Apply config (first install)

Apply the hostname patch (and any future patches you add under `devices/ampone/manifests/`):

```bash
export TALOSCONFIG=$PWD/devices/ampone/talosconfig

talosctl apply-config --insecure -n <node_ip> -e <node_ip> \
  -f devices/ampone/controlplane.yaml \
  --config-patch @devices/ampone/manifests/hostname.patch.yaml
```

## 4) Bootstrap Kubernetes (single-node example)

```bash
export TALOSCONFIG=$PWD/devices/ampone/talosconfig

talosctl bootstrap -n <node_ip> -e <node_ip>
talosctl kubeconfig -n <node_ip> -e <node_ip> -f
```

