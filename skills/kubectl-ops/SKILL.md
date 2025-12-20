---
name: kubectl-ops
description: Kubernetes kubectl operations, debugging, inspection, and safe mutations (apply/patch/rollout), including PVC/VolumeAttachment triage in this repo. Use when running or suggesting kubectl commands, or when diagnosing cluster resource issues.
---

## Baseline checks
- Confirm context/namespace before changes: `kubectl config current-context`, `kubectl get ns`.
- Prefer read-only first: `kubectl get`, `kubectl describe`, `kubectl get events --sort-by=.lastTimestamp`, `kubectl logs`.
- Capture resource ownership (ArgoCD/Helm) before mutating: `kubectl get <kind> <name> -o yaml | rg ownerReferences|helm|argocd`.

## Safe mutation workflow
- If GitOps-managed, edit manifests in repo and sync with ArgoCD; document any emergency kubectl edits and reconcile back to Git.
- Use targeted patches: `kubectl patch <kind> <name> --type merge|json -p '<patch>'`.
- For rollouts: `kubectl rollout restart <kind>/<name>` and `kubectl rollout status ...`.
- Avoid destructive actions unless requested; prefer scale-to-zero before deleting stateful workloads.

## Storage and PVC triage
- Identify owning PVC/PV: `kubectl get pvc -A | rg <pvc-id>`; `kubectl get pv <pv> -o yaml`.
- Check Longhorn volume state (if present): `kubectl -n longhorn-system get volumes.longhorn.io <vol> -o yaml`.
- Clear stale CSI attachments only when safe: `kubectl delete volumeattachment <name>`.
- When fsck is required, run it from a privileged hostPath pod on the node that has the device.

## Common diagnostics
- Pod scheduling: `kubectl describe pod <pod>` and look for `FailedMount`, `FailedAttachVolume`, `ImagePullBackOff`.
- Node health: `kubectl get nodes -o wide` and inspect taints.
- Service reachability: `kubectl get svc -n <ns>` and verify endpoints.

## Notes
- Prefer explicit namespaces (`-n <ns>`) and labels (`-l key=value`).
- Use `--validate=false` only when API validation is temporarily unavailable.
