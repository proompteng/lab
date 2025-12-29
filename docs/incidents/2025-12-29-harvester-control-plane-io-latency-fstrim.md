# 2025-12-29 Harvester Host IO Stall -> K3s Control Plane Latency Investigation

## Summary
K3s control planes reported frequent etcd "apply request took too long" warnings and showed elevated disk wait inside the VMs. The Harvester host `altra` was running `fstrim` against `/var/lib/harvester/defaultdisk` for an extended period, and the `fstrim` process was stuck in D state. That disk backs all VM volumes, including the control planes. The API VIP responded quickly and the control plane disks were healthy, so the investigation focused on host-level IO stalls.

## Scope / Environment
- Harvester cluster (single node): `altra` (192.168.1.85)
- K3s control planes (VMs): 192.168.1.150, 192.168.1.151, 192.168.1.152
- API VIP / load balancer: 192.168.1.200
- Harvester kubeconfig: `~/.kube/altra.yaml`

## Investigation Steps

### 1) Validate control planes are up
Commands:
```bash
ssh kalmyk@192.168.1.150 'systemctl is-active k3s'
ssh kalmyk@192.168.1.151 'systemctl is-active k3s'
ssh kalmyk@192.168.1.152 'systemctl is-active k3s'
```

Result:
- `k3s` was active on all three control planes.

### 2) Check apiserver readiness on each control plane
Commands:
```bash
ssh kalmyk@192.168.1.150 'sudo -n k3s kubectl get --raw /readyz?verbose'
ssh kalmyk@192.168.1.151 'sudo -n k3s kubectl get --raw /readyz?verbose'
ssh kalmyk@192.168.1.152 'sudo -n k3s kubectl get --raw /readyz?verbose'
```

Result:
- `readyz` passed on all three control planes (including `etcd` and `etcd-readiness`).

### 3) Inspect etcd latency warnings in k3s logs
Commands:
```bash
ssh kalmyk@192.168.1.150 'journalctl -u k3s --since "2 hours ago" | tail -n 200'
ssh kalmyk@192.168.1.151 'journalctl -u k3s --since "1 hour ago" | grep -E "apply request took too long" | tail -n 3'
ssh kalmyk@192.168.1.152 'journalctl -u k3s --since "1 hour ago" | grep -E "apply request took too long" | tail -n 3'
```

Observed examples:
- `kube-master-01`: `took: 420.928804ms`, `expected-duration: 100ms`
- `kube-master-02`: `took: 118.370096ms`, `expected-duration: 100ms`
- `kube-master-00`: repeated slow reads/writes in the 100–250ms range

### 4) Measure disk wait inside control plane VMs
Commands:
```bash
ssh kalmyk@192.168.1.151 'iostat -x 1 3'
ssh kalmyk@192.168.1.152 'iostat -x 1 3'
```

Observations:
- `iowait` spikes (7–12%) during samples.
- `vda` `w_await` up to ~27ms and `util` ~40–58%.

### 5) Validate VIP and direct apiserver health
Command:
```bash
python - <<'PY'
import time,subprocess
ips=['192.168.1.150','192.168.1.151','192.168.1.152','192.168.1.200']
for ip in ips:
    print('==', ip, '==')
    for i in range(5):
        start=time.time()
        p=subprocess.run(['curl','-sk','-o','/dev/null','-w','%{http_code}',f'https://{ip}:6443/healthz'],capture_output=True,text=True)
        dt=time.time()-start
        print(f'try {i+1}: http={p.stdout.strip()} time={dt:.3f}s')
PY
```

Result:
- All three control planes and the VIP returned `401` in ~0.03s.

### 6) Verify VIP is not assigned on control planes
Commands:
```bash
ssh kalmyk@192.168.1.150 'ip -4 addr show | grep -F "192.168.1.200" || echo "no VIP"'
ssh kalmyk@192.168.1.151 'ip -4 addr show | grep -F "192.168.1.200" || echo "no VIP"'
ssh kalmyk@192.168.1.152 'ip -4 addr show | grep -F "192.168.1.200" || echo "no VIP"'
```

Result:
- VIP not present on any control plane interface (handled by the LB).

### 7) Map control plane VM root disks to Longhorn volumes
Commands:
```bash
kubectl --kubeconfig ~/.kube/altra.yaml -n default get virtualmachine kube-master-00 -o yaml | rg -n "claimName"
kubectl --kubeconfig ~/.kube/altra.yaml -n default get pvc kube-master-00-root-2qcjn -o yaml | rg -n "volumeName|storageClassName"
kubectl --kubeconfig ~/.kube/altra.yaml -n longhorn-system get volumes.longhorn.io pvc-928c70bb-e3b9-47d5-9bde-e0d05c29a6f0 -o yaml | rg -n "robustness|state"

kubectl --kubeconfig ~/.kube/altra.yaml -n default get virtualmachine kube-master-01 -o yaml | rg -n "claimName"
kubectl --kubeconfig ~/.kube/altra.yaml -n default get pvc kube-master-01-root-52gqg -o yaml | rg -n "volumeName|storageClassName"
kubectl --kubeconfig ~/.kube/altra.yaml -n longhorn-system get volumes.longhorn.io pvc-7a5ad083-1caa-4fee-9a12-043569536a00 -o yaml | rg -n "robustness|state"

kubectl --kubeconfig ~/.kube/altra.yaml -n default get virtualmachine kube-master-02 -o yaml | rg -n "claimName"
kubectl --kubeconfig ~/.kube/altra.yaml -n default get pvc kube-master-02-root-t8xft -o yaml | rg -n "volumeName|storageClassName"
kubectl --kubeconfig ~/.kube/altra.yaml -n longhorn-system get volumes.longhorn.io pvc-397611d9-e598-48a3-a3d8-cc6b25ee4b85 -o yaml | rg -n "robustness|state"
```

Result:
- All three control plane volumes are `robustness: healthy` and `state: attached` (single-replica volumes).

### 8) Inspect Harvester host load and disk usage
Command:
```bash
kubectl --kubeconfig ~/.kube/altra.yaml debug node/altra -it --image=alpine \
  -- chroot /host sh -c 'hostname; uptime; df -h /var/lib/harvester/defaultdisk; top -b -n1 | head -n 5'
```

Observed:
- Load average ~46–49.
- `/var/lib/harvester/defaultdisk` at ~77% usage.
- CPU mostly idle (around 75%), suggesting load is IO-bound, not CPU-bound.

### 9) Identify D-state tasks on the host
Command:
```bash
kubectl --kubeconfig ~/.kube/altra.yaml debug node/altra -it --image=alpine \
  -- chroot /host sh -c 'ps -eo state,pid,comm,args | grep -E "^D" | head -n 20'
```

Observed:
- `fstrim` running in D state.

### 10) Confirm `fstrim` timer and service state
Command:
```bash
kubectl --kubeconfig ~/.kube/altra.yaml debug node/altra -it --image=alpine \
  -- chroot /host sh -c 'systemctl list-timers --all | grep -i fstrim; systemctl status fstrim.service --no-pager'
```

Observed:
- `fstrim.timer` triggered at **2025-12-29 01:33:20 UTC**.
- `fstrim.service` still active ~26 minutes later, with `fstrim` stuck in D state.

## Findings (Facts)
- All control planes are Ready, but etcd logs show persistent slow apply warnings (100–420ms) on all three masters.
- Control plane disks are healthy and attached (single-replica volumes).
- The Harvester host `altra` shows very high load averages (~46–49) while CPU stays mostly idle, indicating IO stalls.
- `fstrim` is running on `altra` and stuck in D state since **2025-12-29 01:33:20 UTC**.
- The trim target `/var/lib/harvester/defaultdisk` backs all VM disks, including the control planes.
- VIP / LB health checks were fast and consistent; VIP is not bound to any control plane interface.

## Working Theory
The stuck `fstrim` on the Harvester host is blocking IO on `/var/lib/harvester/defaultdisk`, creating disk latency for VM volumes. This manifests as elevated IO wait inside control plane VMs and etcd slow apply warnings. This hypothesis should be confirmed by stopping the trim and observing immediate reduction in IO wait and etcd warnings.

## Validation (Stop `fstrim` and measure)
### Baseline (before stopping)
At **2025-12-29 02:09:42–02:09:45 UTC**, etcd slow-apply warnings in the last 5 minutes:
- `kube-master-00`: 432
- `kube-master-01`: 156
- `kube-master-02`: 123

Commands:
```bash
ssh kalmyk@192.168.1.150 'date -u; journalctl -u k3s --since "5 min ago" | grep -c "apply request took too long"'
ssh kalmyk@192.168.1.151 'date -u; journalctl -u k3s --since "5 min ago" | grep -c "apply request took too long"'
ssh kalmyk@192.168.1.152 'date -u; journalctl -u k3s --since "5 min ago" | grep -c "apply request took too long"'
```

### Action
Stopped the trim service on the Harvester host:
```bash
kubectl --kubeconfig ~/.kube/altra.yaml debug node/altra -it --image=alpine \
  -- chroot /host sh -c 'date -u; systemctl stop fstrim.service; systemctl is-active fstrim.service'
```

Observed:
- `fstrim.service` transitioned to `failed` (stopped). Note: timer can re-activate it later.

### Host-level hard block (applied)
To prevent re-activation, `fstrim` was hard-blocked directly on the Harvester host via SSH:
```bash
ssh rancher@192.168.1.85 'sudo systemctl stop fstrim.service'
ssh rancher@192.168.1.85 'sudo systemctl disable fstrim.timer'
ssh rancher@192.168.1.85 'sudo systemctl mask fstrim.timer'
ssh rancher@192.168.1.85 'sudo systemctl mask fstrim.service'
```

Verification on host:
```bash
ssh rancher@192.168.1.85 'systemctl is-enabled fstrim.timer'
ssh rancher@192.168.1.85 'systemctl is-enabled fstrim.service'
ssh rancher@192.168.1.85 'systemctl status fstrim.timer --no-pager'
ssh rancher@192.168.1.85 'systemctl status fstrim.service --no-pager'
```

Observed:
- Both units are `masked`.
- `fstrim.service` shows it was terminated at **2025-12-29 02:09:53 UTC** (signal TERM).
- `fstrim.timer` shows masked and inactive after **2025-12-29 02:21:01 UTC**.

### After stop (1-minute window)
At **2025-12-29 02:11:11–02:11:15 UTC**, etcd slow-apply warnings in the last 1 minute:
- `kube-master-00`: 0
- `kube-master-01`: 0
- `kube-master-02`: 0

Commands:
```bash
ssh kalmyk@192.168.1.150 'date -u; journalctl -u k3s --since "1 min ago" | grep -c "apply request took too long"'
ssh kalmyk@192.168.1.151 'date -u; journalctl -u k3s --since "1 min ago" | grep -c "apply request took too long"'
ssh kalmyk@192.168.1.152 'date -u; journalctl -u k3s --since "1 min ago" | grep -c "apply request took too long"'
```

### IO wait inside a control plane VM after stop
Sample from `kube-master-01`:
- `iowait` dropped to ~0.76% (previous samples showed 7–12%).

Command:
```bash
ssh kalmyk@192.168.1.151 'iostat -x 1 3'
```

### After hard block (5-minute window)
At **2025-12-29 02:21:10–02:21:14 UTC**, etcd slow-apply warnings in the last 5 minutes:
- `kube-master-00`: 0
- `kube-master-01`: 0
- `kube-master-02`: 0

Commands:
```bash
ssh kalmyk@192.168.1.150 'date -u; journalctl -u k3s --since "5 min ago" | grep -c "apply request took too long"'
ssh kalmyk@192.168.1.151 'date -u; journalctl -u k3s --since "5 min ago" | grep -c "apply request took too long"'
ssh kalmyk@192.168.1.152 'date -u; journalctl -u k3s --since "5 min ago" | grep -c "apply request took too long"'
```

## Mitigation (Host OS, persistent)
Harvester documents filesystem trim risks for VM storage and recommends disabling `fstrim.timer` or randomizing trim execution to avoid synchronized IO stalls. It also documents that Harvester OS is immutable and that runtime changes must be mirrored in `/oem/90_custom.yaml` (or `/oem/99_custom.yaml` when upgrading from < v1.1.2) to persist across reboot.

### Runtime mitigation on the Harvester host
```bash
# Stop the current trim if it is running
systemctl stop fstrim.service

# Disable the timer to prevent the weekly run
systemctl disable fstrim.timer
```

### Persistent mitigation (Harvester OS)
1. Apply the runtime change (above).
2. Persist the change in Harvester OS config so it survives reboot:
   - Back up `/oem/90_custom.yaml` (or `/oem/99_custom.yaml` on older upgrades).
   - Update the file under `stages.initramfs[0].commands` to disable the timer at boot.

Example snippet:
```yaml
stages:
  initramfs:
    - commands:
        - systemctl disable fstrim.timer
```

If you prefer not to fully disable trim, Harvester recommends randomizing the timer schedule instead of running it simultaneously across hosts.

## References
- Harvester KB: filesystem trim risk and mitigations (disable `fstrim.timer`, randomize trim schedule). https://harvesterhci.io/kb/the_potential_risk_with_filesystem_trim/
- Harvester docs: immutable OS + persist changes via `/oem/90_custom.yaml` (`/oem/99_custom.yaml` for upgrades < v1.1.2). https://docs.harvesterhci.io/v1.5/install/update-harvester-configuration/

## Next Steps
1. Decide whether to disable or reschedule `fstrim.timer` to avoid future stalls (and re-enable once root cause is fixed).
2. Investigate why `fstrim` hangs on `/var/lib/harvester/defaultdisk` (NVMe health, storage controller logs, discard support behavior).
3. Monitor etcd slow-apply rate after the stop to ensure the latency drop is sustained.
