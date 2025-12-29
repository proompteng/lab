# Kafka Broker Storage Recovery Runbook

## Overview
Use this runbook when a Kafka broker is crash-looping with storage I/O errors (for example, `meta.properties` read failures or `No available log directories to format`). The fastest recovery is to replace the broker volume and let Kafka re-sync from the remaining replicas. If you must preserve local data, attempt a filesystem repair first.

## Before you start
- Ensure at least two brokers are healthy before removing the failing broker (replication factor = 3, `min.insync.replicas = 2`).
- Capture logs and PVC identifiers for the incident timeline.

## 1) Triage the failing broker
```bash
kubectl -n kafka get kafka
kubectl -n kafka get pods -o wide
kubectl -n kafka logs kafka-pool-a-2 --tail=200
kubectl -n kafka describe pod kafka-pool-a-2
```
Confirm the I/O error in the broker logs and record the PVC name (usually `data-kafka-pool-a-2`).

## 2) Pause Argo CD autosync (recommended)
```bash
argocd app patch argocd/kafka --type json \
  --patch '[{"op":"remove","path":"/spec/syncPolicy/automated"}]'
```
Restore it after recovery.

## 3) Replace the broker volume (fastest path)
Scale the node pool down to remove the failing broker, delete its PVC, then scale back up.
```bash
kubectl -n kafka patch kafkanodepool pool-a --type merge -p '{"spec":{"replicas":2}}'

kubectl -n kafka delete pvc data-kafka-pool-a-2

kubectl -n kafka patch kafkanodepool pool-a --type merge -p '{"spec":{"replicas":3}}'
```
Wait for `kafka-pool-a-2` to recreate and reach `Ready`.

## 4) Optional: attempt filesystem repair before replacement
If you need to preserve the data volume, run fsck on the Longhorn device while the broker is scaled down.
```bash
PVC=data-kafka-pool-a-2
PV=$(kubectl -n kafka get pvc "$PVC" -o jsonpath='{.spec.volumeName}')
VOLUME=$(kubectl get pv "$PV" -o jsonpath='{.spec.csi.volumeHandle}')
NODE=$(kubectl -n longhorn-system get volume "$VOLUME" -o jsonpath='{.status.currentNodeID}')

kubectl -n longhorn-system apply -f - <<POD
apiVersion: v1
kind: Pod
metadata:
  name: fsck-${VOLUME}
  namespace: longhorn-system
spec:
  nodeName: ${NODE}
  restartPolicy: Never
  tolerations:
    - operator: Exists
  containers:
    - name: fsck
      image: alpine:3.20
      securityContext:
        privileged: true
      command:
        - sh
        - -c
        - |
          set -eux
          apk add --no-cache e2fsprogs
          e2fsck -f -y /dev/longhorn/${VOLUME}
      volumeMounts:
        - name: dev
          mountPath: /dev/longhorn
  volumes:
    - name: dev
      hostPath:
        path: /dev/longhorn
POD
```
If `NODE` is empty, attach the volume in Longhorn first or set `nodeName` manually to the node hosting the volume device.
If fsck fails or I/O errors persist, proceed with the volume replacement in step 3.

## 5) Verify Kafka and KafkaSource health
```bash
kubectl -n kafka get kafka
kubectl -n kafka get pods -o wide
kubectl -n jangar get kafkasource jangar-codex-completions
kubectl -n jangar describe kafkasource jangar-codex-completions | sed -n '/Conditions:/,/Events:/p'
```
Ensure Kafka reports `Ready=True` and the KafkaSource `Ready` condition is `True`.

## 6) Re-enable Argo CD autosync
```bash
argocd app set argocd/kafka --sync-policy automated --self-heal --auto-prune
```

## Notes
- Replacing a single broker volume will temporarily under-replicate partitions. Allow time for ISR to recover.
- If the broker keeps reusing a corrupted PVC, double-check that the PVC was deleted and that a fresh PV/volume was created.
