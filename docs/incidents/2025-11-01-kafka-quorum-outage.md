# Incident Report: Kafka KRaft Quorum Corruption

- **Date**: 1 Nov 2025
- **Detected by**: Froussard readiness probes failing, lack of Codex workflow trigger after `execute plan`
- **Reported by**: gregkonush
- **Services Affected**: Kafka cluster (`kafka` namespace), dependent automations (Codex workflows), any producers/consumers using the shared Kafka brokers
- **Severity**: High – Kafka cluster unavailable

## Impact Summary

- Kafka brokers were crash-looping and marked `Degraded`; Codex workflows relying on Kafka events were not triggered.
- Froussard’s readiness probe failed because it could not connect to Kafka, preventing automatic Codex dispatch.
- No message ingestion or consumption for platform topics (`github.*`, `discord.*`, Argo workflows, etc.) during the outage window.

## Timeline (Pacific Time)

| Time                     | Event                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2025-11-01 14:56         | Strimzi rollout produced new revision `froussard-00062`; Kafka brokers began restarting.                                                                    |
| 2025-11-01 15:10         | Strimzi operator reported repeated reconciliation failures; brokers in `CrashLoopBackOff`.                                                                  |
| 2025-11-01 15:30         | User noticed `execute plan` comment did not trigger Codex workflow; investigation found Froussard readiness failing due to Kafka connection errors.         |
| 2025-11-01 15:35         | Confirmed Kafka brokers were unable to join the KRaft quorum; logs showed `Fatal error during broker startup` and corrupted `quorum-state`.                 |
| 2025-11-01 15:40 – 15:55 | Paused ArgoCD autosync for Kafka, scaled Strimzi components down, detached broker PVCs, manually repaired quorum metadata and replication checkpoint files. |
| 2025-11-01 15:56         | Restored quorum metadata (`quorum-state`) on all brokers, reset corrupted `replication-offset-checkpoint` files, remounted PVCs.                            |
| 2025-11-01 15:57         | Scaled brokers back up; all three brokers started successfully and formed quorum.                                                                           |
| 2025-11-01 15:58         | Restarted entity operator for clean state.                                                                                                                  |
| 2025-11-01 15:59         | Re-enabled ArgoCD autosync; Kafka application returned to `Synced/Healthy`.                                                                                 |
| 2025-11-01 16:00         | Confirmed Kafka `Ready=True` and Froussard readiness probe passing.                                                                                         |

## Root Cause

During the Strimzi restart, the KRaft metadata quorum files became corrupted:

- `quorum-state` on all brokers contained empty `clusterId` and stale `leaderEpoch` values (0/1163/1165 mismatches), causing brokers to fail registration.
- `replication-offset-checkpoint` files were filled with null bytes, triggering `KafkaStorageException` when brokers attempted to become leaders.

The exact trigger for the file corruption is unknown; likely caused by abrupt broker termination during disk writes while Longhorn volumes were attached.

## Remediation Actions

1. Suspended ArgoCD autosync (`argocd root` ApplicationSet) to prevent automated rollbacks.
2. Scaled Strimzi operator and Kafka node pool to zero; deleted StrimziPodSet to detach PVCs.
3. Mounted each broker PVC into privileged repair pods and:
   - Rebuilt `__cluster_metadata-0/quorum-state` with correct `clusterId`, `leaderEpoch`, and `appliedOffset`.
   - Reset `replication-offset-checkpoint` entries to `0\n0\n`.
4. Unmounted PVCs, removed repair pods, and scaled brokers/operator back up.
5. Restarted entity-operator after brokers healthy.
6. Re-enabled ArgoCD autosync (`automation=auto`, `--sync-policy automated --self-heal --auto-prune`).
7. Verified Kafka readiness, broker logs, and Froussard connectivity.

## Follow-up Actions

- **Investigate root cause**: Review Strimzi operator logs around 14:56–15:10 PT for evidence of abrupt restarts or volume issues.
- **Add health checks**: Implement monitoring/alerting for KRaft quorum registration failures and checkpoint corruption.
- **Document recovery runbook**: Convert this report into a formal playbook for future KRaft metadata repairs.
- **Schedule postmortem**: Meet with platform team to determine preventive steps (e.g., backups, graceful stop hooks, filesystem checks).
- **Verify downstream systems**: Run Kafka smoke tests (produce/consume) and confirm dependent services (Codex dispatcher, Karapace, Froussard) remain stable.

## Lessons Learned

- KRaft mode is sensitive to metadata file integrity; regular snapshots/backups are essential.
- ArgoCD autosync should be paused before manual remediation to avoid unintended rollbacks.
- Dedicated repair pods with privileged access streamline Longhorn volume debugging; keep templates ready.
- Entity operator will continue crashing until brokers are healthy; restarting it at the end ensures CRD synchronization.

## Relevant Commands

```bash
# Disable autosync and patch ApplicationSet entry
argocd app patch-resource argocd/root --group argoproj.io --kind ApplicationSet \
  --namespace argocd --resource-name platform \
  --patch '[{"op":"replace","path":"/spec/generators/0/list/elements/10/automation","value":"manual"}]' \
  --patch-type application/json-patch+json

argocd app patch argocd/kafka --type json \
  --patch '[{"op":"remove","path":"/spec/syncPolicy/automated"}]'

# Scale Strimzi components down
kubectl scale deployment strimzi-cluster-operator -n kafka --replicas=0
kubectl patch kafkanodepool pool-a -n kafka --type merge -p '{"spec":{"replicas":0}}'

# Mount PVC to repair pod (example for broker 0)
kubectl apply -f kafka-repair-0.yaml
kubectl exec kafka-repair-0 -n kafka -- bash -lc \
  'printf "%s\n" "{\"clusterId\":\"…\",\"leaderId\":-1,\"leaderEpoch\":1138,\"votedId\":-1,\"appliedOffset\":2997912,\"currentVoters\":[{\"voterId\":0},{\"voterId\":1},{\"voterId\":2}],\"data_version\":0}" > /mnt/data/kafka-log0/__cluster_metadata-0/quorum-state'
kubectl exec kafka-repair-0 -n kafka -- bash -lc \
  'printf "0\n0\n" > /mnt/data/kafka-log0/replication-offset-checkpoint'

# Restart Strimzi/Kafka
kubectl patch kafkanodepool pool-a -n kafka --type merge -p '{"spec":{"replicas":3}}'
kubectl scale deployment strimzi-cluster-operator -n kafka --replicas=1

# Re-enable autosync
argocd app patch-resource argocd/root --group argoproj.io --kind ApplicationSet \
  --namespace argocd --resource-name platform \
  --patch '[{"op":"replace","path":"/spec/generators/0/list/elements/10/automation","value":"auto"}]' \
  --patch-type application/json-patch+json
argocd app set argocd/kafka --sync-policy automated --self-heal --auto-prune
```
