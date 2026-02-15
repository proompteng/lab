# altra Talos bootstrap (3 nodes, endpoint behind NUC LB)

This runbook bootstraps a 3-node Talos cluster named `altra`.

Goals:
- Kubernetes API is reachable via the NUC HAProxy endpoint: `https://192.168.1.130:6444`
- `kubectl` works by default (merged into `~/.kube/config`) with context name `altra`

Assumptions:
- All 3 nodes boot Talos in maintenance mode first (ISO/USB/PXE) and get an IP.
- You will install Talos to the correct disk for each node.
- The NUC (`kalmyk@192.168.1.130`) can run HAProxy (Docker).

## 0) Configure the NUC load balancer for altra

Follow:
- `devices/nuc/k8s-api-lb-altra/README.md`

This should create a stable endpoint on the LAN:
- `192.168.1.130:6444` (TCP passthrough to control planes on `:6443`)

## 1) Generate `altra` secrets + machine configs (gitignored)

These files are intentionally gitignored:
- `devices/altra/secrets.yaml`
- `devices/altra/controlplane.yaml`
- `devices/altra/worker.yaml`
- `devices/altra/talosconfig`

```bash
# 1) Generate a secrets bundle (keep it out of Git).
talosctl gen secrets --output-file devices/altra/secrets.yaml

# 2) Generate configs for the cluster behind the NUC LB endpoint.
talosctl gen config altra https://192.168.1.130:6444 \
  --with-secrets devices/altra/secrets.yaml \
  --output-dir devices/altra \
  --output-types controlplane,worker,talosconfig \
  --with-docs=false \
  --with-examples=false \
  --install-disk <install_disk>
```

Notes:
- If the 3 nodes are all control planes, you will apply `devices/altra/controlplane.yaml` to all of them.
- If you have workers, apply `devices/altra/worker.yaml` to workers.

## 2) Apply configs to the 3 nodes (first install)

For each node while it's in maintenance mode:

```bash
# Control plane example (maintenance mode)
talosctl apply-config --insecure -n <node_ip> -e <node_ip> \
  -f devices/altra/controlplane.yaml \
  --mode=reboot
```

If you have a worker node:

```bash
talosctl apply-config --insecure -n <worker_ip> -e <worker_ip> \
  -f devices/altra/worker.yaml \
  --mode=reboot
```

## 3) Bootstrap etcd (run once)

Pick one control plane node IP (`<cp1_ip>`) and run bootstrap exactly once:

```bash
talosctl bootstrap -n <cp1_ip> -e <cp1_ip>
```

## 4) Write kubeconfig (context name `altra`, endpoint via NUC LB)

```bash
talosctl kubeconfig -n <cp1_ip> -e <cp1_ip> \
  --force \
  --force-context-name altra \
  ~/.kube/config

kubectl config use-context altra
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
kubectl get nodes -o wide
```

The `server:` should be `https://192.168.1.130:6444`.

## 5) Verify Talos health

```bash
talosctl config endpoint <cp1_ip> <cp2_ip> <cp3_ip>
talosctl config node <cp1_ip> <cp2_ip> <cp3_ip>

talosctl health
talosctl etcd members
```

