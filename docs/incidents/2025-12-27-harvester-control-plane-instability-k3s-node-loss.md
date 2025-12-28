# 2025-12-27 Harvester Control Plane Instability -> K3s Node Loss -> Longhorn Faults

## Summary
Harvester control plane instability on the single-node Harvester cluster (node `altra`) caused KubeVirt/Harvester controllers to restart and VMIs to be recreated. Two VMIs (`kube-worker-08`, `kube-worker-13`) failed to come up because the Harvester CSI driver was not registered during the restart, leaving their k3s nodes NotReady. Longhorn volumes for Kafka were faulted/detached, Kafka brokers were unavailable, and downstream services depending on Kafka (e.g., Froussard) could not produce. Non-destructive recovery was completed by recycling the failed VMIs; k3s nodes rejoined, Longhorn volumes reattached, and Kafka brokers started.

## Impact
- Multiple k3s nodes went NotReady, including nodes hosting Longhorn replicas for Kafka volumes.
- Longhorn marked Kafka volumes faulted/detached; Kafka quorum went down.
- Kafka-dependent services (e.g., Froussard) were unable to publish.
- Kubernetes API VIP at `192.168.1.200:6443` was unreachable; direct access to `kube-master-00` was required.

## Detection
- Longhorn UI showed many nodes down and volumes in `Faulted` state.
- Froussard logs reported Kafka producer connection failures.
- Harvester API returned 502/503 at the time of investigation.

## Timeline (PST)
- **2025-12-27 16:45:32**: Harvester host `altra` rke2 logged repeated HTTP 502s proxying to `10.52.0.30:9443` and `10.52.0.36:9443` (service endpoints refused connections). (00:45:32Z)
- **2025-12-27 16:48:04**: `virt-controller` lost leader lease (leaderelection timeout). (00:48:04Z)
- **16:51:24**: `kube-vip` reacquired leadership for `plndr-svcs-lock`. (00:51:24Z)
- **16:51:28**: Harvester controllers reacquired leader lease. (00:51:28Z)
- **16:51:29 - 16:51:46**: Harvester controller reported `steve` aggregation connection refused and stale API discovery errors. (00:51:29Z - 00:51:46Z)
- **16:51:59 - 16:52:07**: Host kernel logged multiple `device offline` and `Buffer I/O error` events across several disks, followed by SCSI device resets/reattaches. (00:51:59Z - 00:52:07Z)
- **16:52:06 - 16:52:12**: `virt-handler` failed to reach VMI command sockets for `kube-worker-08` and `kube-worker-13`. (00:52:06Z - 00:52:12Z)
- **16:52:21 - 16:52:30**: `virt-controller`/`virt-api` reported TLS certificate mismatch errors. (00:52:21Z - 00:52:30Z)
- **16:58:00**: `virt-controller` marked VMIs failed and applied start backoff. (00:58:00Z)
- **17:00**: Manual recovery by deleting failed VMIs; VMIs recreated and k3s nodes began to recover.
- **17:02**: Longhorn volumes for Kafka attached and healthy; Kafka brokers restarted.

## Root Cause (Hypothesis)
Harvester control plane instability (leader election churn, API timeouts) on the single-node Harvester cluster caused KubeVirt/Harvester components to restart and recreate VMIs. During the restart window, the Harvester CSI driver was not registered, so VMIs for `kube-worker-08` and `kube-worker-13` failed to start. Those k3s nodes stayed NotReady, Longhorn replicas were unavailable, and Kafka volumes faulted.

The underlying trigger for the Harvester control plane instability is still unknown, but host-level logs show a burst of disk I/O errors and device resets at **16:51:59–16:52:07 PST**, which strongly suggests a storage subsystem disruption on `altra` (likely causing API timeouts and controller churn).

## Contributing Factors
- Single-node Harvester control plane (no HA).
- Kafka volumes were single-replica with no Longhorn backups.
- K3s API VIP (`192.168.1.200`) was unavailable, requiring direct master access.

## Recovery Actions
1. Verified Harvester and VM status:
   ```bash
   kubectl --kubeconfig ~/.kube/altra.yaml get virtualmachines -A -o wide
   kubectl --kubeconfig ~/.kube/altra.yaml get vmi -A -o wide
   ```
2. Deleted failed VMIs so Harvester would recreate them:
   ```bash
   kubectl --kubeconfig ~/.kube/altra.yaml -n default delete vmi kube-worker-08 kube-worker-13
   ```
3. Validated VMIs returned to `Running` and k3s nodes rejoined:
   ```bash
   kubectl --kubeconfig ~/.kube/altra.yaml get vmi -n default -o wide | egrep 'kube-worker-08|kube-worker-13'
   kubectl --kubeconfig ~/.kube/config --server https://192.168.1.150:6443 --insecure-skip-tls-verify get nodes -o wide
   ```
4. Confirmed Longhorn volumes for Kafka became healthy/attached:
   ```bash
   kubectl -n longhorn-system get volume pvc-b38a47ce-9958-4c75-b594-afed64bb02b1 -o jsonpath='{.status.robustness} {.status.state} {.status.currentNodeID}'
   kubectl -n longhorn-system get volume pvc-c140f251-7aa8-4bf5-85b0-fd58efe8381d -o jsonpath='{.status.robustness} {.status.state} {.status.currentNodeID}'
   kubectl -n longhorn-system get volume pvc-40d29f68-1901-457b-8313-1ca1310861c6 -o jsonpath='{.status.robustness} {.status.state} {.status.currentNodeID}'
   ```
5. Observed Kafka brokers restarting:
   ```bash
   kubectl -n kafka get pods -o wide
   kubectl -n kafka logs kafka-pool-a-0 --tail=200
   ```

## Findings from Harvester Logs
- Harvester controller errors:
  - `Failed to dial steve aggregation server: dial tcp ... connection refused`
  - `Failed to read API for groups ... stale GroupVersion discovery`
- KubeVirt errors:
  - `virt-controller` failed to renew leader lease.
  - `virt-controller`/`virt-api` TLS cert mismatch: `private key does not match public key`.
  - `virt-handler` failed to reach VMI launcher sockets for `kube-worker-08` and `kube-worker-13`.
- Host-level evidence (journal/kernel on `altra`):
  - rke2 proxy 502s to `10.52.0.30:9443` and `10.52.0.36:9443` at **16:45:32 PST**.
  - Kernel `device offline` + `Buffer I/O error` events on multiple disks, followed by SCSI device resets/reattachments at **16:51:59–16:52:07 PST**.

## Follow-ups
- Pull host-level logs from `altra` (journal/syslog) around **16:45–16:55 PST** to identify the initial trigger.
- Investigate why `virt-controller`/`virt-api` reported TLS mismatches during restart.
- Add alerting for Harvester API latency and KubeVirt leader election churn.
- Increase Longhorn replica count and configure backups for Kafka volumes.
- Validate k3s API VIP (`192.168.1.200`) health monitoring.
