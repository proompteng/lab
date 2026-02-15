# Kubernetes installation

## Talos-based cluster (galactic)

The current home lab Kubernetes cluster is Talos-based and documented under `devices/galactic`.

Start here:
1. `devices/galactic/README.md`
1. `devices/galactic/docs/bootstrap-argocd.md`
1. `devices/galactic/docs/tailscale.md` (required if you reference `*.ts.net` registries in image references)
1. `docs/runbooks/rook-ceph-on-talos.md`

## Install k3sup

```bash
brew install k3sup
```

Generate a script to install a new cluster

```bash
k3sup plan hosts.json --servers 5 --user kalmyk > install.sh
```

Make install script executable

```bash
chmod +x install.sh
```

Install a new cluster

```bash
./install.sh
```

## Bootstrap GitOps (ArgoCD) – step by step

1. Apply ArgoCD base (HA install, image updater, Traefik IngressRoute, secrets):

```bash
kubectl apply -k argocd/applications/argocd
kubectl -n argocd get pods
```

2. Wait until ArgoCD is ready before proceeding:

```bash
kubectl -n argocd rollout status deploy/argocd-server --timeout=180s
kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=180s
```

3. Install MetalLB (provides External IPs for LoadBalancer Services like K3s Traefik):

```bash
kubectl apply -k argocd/applications/metallb-system
kubectl -n metallb-system rollout status deploy/controller --timeout=180s
kubectl -n metallb-system rollout status ds/speaker --timeout=300s
```

Notes:

- Edit `argocd/applications/metallb-system/ipaddresspool.yaml` to match your LAN range and avoid static IPs. Current pool: `192.168.1.100-192.168.1.149`.
- The K3s Traefik Service (`kube-system/traefik`) is type LoadBalancer and will be Pending until MetalLB assigns an External IP. After this step it should have an IP, e.g., `192.168.1.100`.

4. Apply the root Application (ApplicationSet) to sync the rest of the stack:

```bash
kubectl apply -f argocd/root.yaml
kubectl -n argocd get applications.argoproj.io
```

5. Monitor sync and platform components:

```bash
kubectl -n argocd get apps,applicationsets
kubectl -n argocd get pods -w
```

## K3sup flags explained (what we set and why)

The install script uses a set of high‑performance, safe defaults aligned with your current ArgoCD stack (Traefik, Flannel, MetalLB, local‑path still used by ARC).

Server flags (applied via `k3sup install` and server `k3sup join --server`):

- **--disable servicelb**: Remove the bundled klipper-lb so MetalLB can own LoadBalancer services without conflict.
- **--flannel-backend=host-gw**: Use simple L2 routing, avoiding VXLAN encapsulation and lowering east-west latency on flat LANs.
- **--etcd-arg=auto-compaction-mode=periodic** / **--etcd-arg=auto-compaction-retention=1h**: Compact etcd hourly to keep the datastore responsive.
- **--etcd-arg=quota-backend-bytes=8589934592**: Raise the etcd data size limit to ~8 GiB to accommodate the larger cluster safely.
- **--etcd-snapshot-schedule-cron="0 */6 * * *"** / **--etcd-snapshot-retention=20**: Take automated snapshots every six hours and retain ~5 days of restore points.
- **--kube-proxy-arg=proxy-mode=ipvs** / **--kube-proxy-arg=ipvs-scheduler=wrr**: Leverage IPVS with weighted round robin for scalable service routing.
- **--kubelet-arg=cpu-manager-policy=static** / **--kubelet-arg=topology-manager-policy=single-numa-node**: Pin Guaranteed pods to dedicated cores within the same NUMA domain to minimize jitter.
- **--kubelet-arg=reserved-cpus=0-1**: Hold two cores per node for the OS and control-plane daemons, aligning with the 8 vCPU sizing in `tofu/harvester/main.tf`.
- **--kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi** and **--kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi**: Reserve memory, CPU, and disk budget for critical services.
- **--kubelet-arg=container-log-max-size=10Mi** / **--kubelet-arg=container-log-max-files=3**: Rotate container logs aggressively to avoid filling the 150 GiB root disks.
- **--kubelet-arg=serialize-image-pulls=false**: Allow concurrent image downloads to speed up pod startups.
- **--node-taint=node-role.kubernetes.io/control-plane=true:NoSchedule**: Keep general workloads off the control-plane nodes unless they add an explicit toleration.

Agent flags (applied via `k3sup join` for workers):

- **--kubelet-arg=cpu-manager-policy=static** / **--kubelet-arg=topology-manager-policy=single-numa-node**: Match control-plane NUMA/CPU pinning behaviour for consistency.
- **--kubelet-arg=reserved-cpus=0-1**: Reserve the first two cores on each worker for system daemons, leaving six dedicated cores for workloads.
- **--kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi** and **--kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi**: Mirror control-plane resource cushions on the workers.
- **--kubelet-arg=container-log-max-size=10Mi** / **--kubelet-arg=container-log-max-files=3** / **--kubelet-arg=serialize-image-pulls=false**: Apply the same log and pull tuning cluster-wide.

IPVS prerequisites (Ubuntu usually has these modules):

```bash
sudo modprobe ip_vs ip_vs_rr ip_vs_wrr ip_vs_sh nf_conntrack
```

Verify kube‑proxy mode on a node:

```bash
kubectl -n kube-system get ds kube-proxy -o yaml | rg -n "--proxy-mode|--ipvs-scheduler"
```

## Harvester VMs with OpenTofu (plan/apply with parallelism)

For creating the Ubuntu VMs in Harvester via OpenTofu:

```bash
# Plan
tofu -chdir='./tofu/harvester' plan

# Apply with higher parallelism for faster ops
tofu -chdir='./tofu/harvester' apply -auto-approve -parallelism=30
```

Notes:

- If you see timeouts, reduce `-parallelism` (e.g., 10 or 5) or apply in batches using `-target`.
- zsh users: when using `-target`, quote or escape brackets to avoid globbing, e.g.:
  ```bash
  noglob tofu -chdir='./tofu/harvester' apply -auto-approve \
    -target 'harvester_virtualmachine.kube-cluster["kube-master-00"]' \
    -target 'harvester_virtualmachine.kube-cluster["kube-master-01"]' \
    -target 'harvester_virtualmachine.kube-cluster["kube-master-02"]'
  ```
- If a previous run failed, resources may be tainted for replacement. To keep current VMs, you can untaint then re-plan:
  ```bash
  tofu -chdir='./tofu/harvester' state list | awk '/^harvester_virtualmachine\./{print $1}' | \
    xargs -n1 tofu -chdir='./tofu/harvester' state untaint
  tofu -chdir='./tofu/harvester' plan
  ```

Set KUBECONFIG environment variable

```bash
echo "export KUBECONFIG=~/.kube/kubeconfig" >> ~/.zshrc
```

Check if cluster is running

```bash
 k get nodes
NAME             STATUS   ROLES                       AGE     VERSION
kube-master-00   Ready    control-plane,etcd,master   6m27s   v1.28.8+k3s1
kube-master-01   Ready    control-plane,etcd,master   6m7s    v1.28.8+k3s1
kube-master-02   Ready    control-plane,etcd,master   5m39s   v1.28.8+k3s1
kube-worker-00   Ready    <none>                      5m28s   v1.28.8+k3s1
kube-worker-01   Ready    <none>                      5m17s   v1.28.8+k3s1
kube-worker-02   Ready    <none>                      5m6s    v1.28.8+k3s1
kube-worker-03   Ready    <none>                      4m56s   v1.28.8+k3s1
kube-worker-04   Ready    <none>                      4m45s   v1.28.8+k3s1
kube-worker-05   Ready    <none>                      4m35s   v1.28.8+k3s1
```

## Tainting a node

To taint a node (for example, `kube-worker-08`) to prevent pod scheduling unless they have a matching toleration, use the following command:

```bash
kubectl taint nodes kube-worker-08 role=worker:NoSchedule
```

To remove the taint, you can use:

```bash
kubectl taint nodes kube-worker-08 role=worker:NoSchedule-
```

### Querying nodes for taints

To view the taints on all nodes in your cluster, you can use the following command:

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
```

See key and value of taint on a node

```bash
kubectl describe node kube-worker-08 | grep Taint
```

To see all pods on a specific node:

```bash
kubectl get pods --field-selector spec.nodeName=kube-worker-08
```
