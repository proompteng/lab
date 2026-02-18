# Add a control plane node to `galactic` (Talos cluster name `ryzen`)

This runbook is the canonical, reproducible procedure to add a new control plane
node to the existing cluster.

Assumptions:
- Existing control planes are healthy and reachable:
  - `ryzen` (`192.168.1.194`)
  - `ampone` (`192.168.1.203`)
- NUC HAProxy endpoint is up: `https://nuc:6443` and `https://192.168.1.130:6443`
- The new node is booted into Talos maintenance mode and you know its LAN IP.

## 0) Update NUC HAProxy backends

Edit `devices/nuc/k8s-api-lb/haproxy.cfg` and add the new control plane backend:

```text
server <new_name> <new_ip>:6443 check
```

Deploy to the NUC:

```bash
scp devices/nuc/k8s-api-lb/haproxy.cfg kalmyk@192.168.1.130:~/k8s-api-lb/haproxy.cfg
ssh kalmyk@192.168.1.130 'cd ~/k8s-api-lb && docker compose up -d'
```

## 1) Ensure API server cert SANs include the new node IP

The cluster API endpoint is the LB (`nuc` / `192.168.1.130`), but kube-apiserver certs
also need SANs for each control plane IP.

1. Add the new IP to `cluster.apiServer.certSANs` patch used by the cluster:
   - `devices/ryzen/manifests/controlplane-endpoint-nuc.patch.yaml`
   - `devices/ampone/manifests/controlplane-endpoint-nuc.patch.yaml`
2. Apply the patch to **each** existing control plane without reboot:

```bash
talosctl patch machineconfig -n 192.168.1.194 -e 192.168.1.194 \
  --patch @devices/ryzen/manifests/controlplane-endpoint-nuc.patch.yaml \
  --mode=no-reboot

talosctl patch machineconfig -n 192.168.1.203 -e 192.168.1.203 \
  --patch @devices/ampone/manifests/controlplane-endpoint-nuc.patch.yaml \
  --mode=no-reboot
```

## 2) Generate a join config for the new control plane

If you don’t have the original `secrets.yaml`, derive a secrets bundle from the
live control plane machineconfig (sensitive; keep it out of Git):

```bash
export CP_SEED_IP='192.168.1.194'

talosctl get machineconfig -n "$CP_SEED_IP" -e "$CP_SEED_IP" -o jsonpath='{.spec}' \
  | awk '/^---$/{exit} {print}' \
  > /tmp/galactic-base-controlplane.yaml

talosctl gen secrets --from-controlplane-config /tmp/galactic-base-controlplane.yaml \
  --output-file /tmp/galactic-secrets.yaml \
  --force
```

Then generate a `controlplane.yaml` for the existing cluster endpoint:

```bash
export K8S_LB_ENDPOINT='nuc' # or '192.168.1.130'

talosctl gen config ryzen "https://$K8S_LB_ENDPOINT:6443" \
  --with-secrets /tmp/galactic-secrets.yaml \
  --output-dir <device_dir> \
  --output-types controlplane,talosconfig \
  --with-docs=false \
  --with-examples=false \
  --install-disk /dev/nvme0n1
```

## 3) Apply config (install + join)

Apply config while the new node is still in maintenance mode:

```bash
talosctl apply-config --insecure -n <new_ip> -e <new_ip> \
  -f <device_dir>/controlplane.yaml \
  --config-patch @<device_dir>/manifests/install-nvme0n1.patch.yaml \
  --config-patch @<device_dir>/manifests/allow-scheduling-controlplane.patch.yaml \
  --config-patch @<device_dir>/manifests/controlplane-endpoint-nuc.patch.yaml \
  --config-patch @<device_dir>/manifests/hostname.patch.yaml \
  --mode=reboot
```

Important:
- The node IP may change after install/reboot (DHCP). Use console/KVM to confirm
  the post-install IP before troubleshooting.

## 4) Update local Talos client defaults

Keep Talos defaults pointing at all control planes:

```bash
talosctl config endpoint 192.168.1.194 192.168.1.203 <new_ip_after_install>
talosctl config node 192.168.1.194 192.168.1.203 <new_ip_after_install>
```

## 5) Validate

```bash
kubectl config use-context galactic
kubectl get nodes -o wide

# Talos health must be run against a single node (or use the flags explicitly).
talosctl health -n 192.168.1.194 -e 192.168.1.194
talosctl etcd members -n 192.168.1.194 -e 192.168.1.194
```
