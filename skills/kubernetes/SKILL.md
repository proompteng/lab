---
name: kubernetes
description: Kubernetes operations with kubectl and related CLIs (debugging, inspection, safe mutations, and storage triage) in this repo. Use when running or suggesting kubectl commands, diagnosing cluster resource issues, or handling CNPG/Postgres access.
---

## Baseline checks
- Confirm namespace before changes: `kubectl get ns`.
- Prefer read-only first: `kubectl get`, `kubectl describe`, `kubectl get events --sort-by=.lastTimestamp`, `kubectl logs`.
- Capture resource ownership (ArgoCD/Helm) before mutating: `kubectl get <kind> <name> -o yaml | rg ownerReferences|helm|argocd`.

## Read-only helpers
- Tail logs with context: `kubectl logs <pod> -c <container> --since=1h --tail=200` (use `-f` to follow).
- Grep logs (ripgrep/grep): `kubectl logs <pod> -c <container> --since=1h | rg -i 'error|warn'` or `kubectl logs <pod> -c <container> --since=1h | grep -E 'error|warn'`.
- Crash-loop check: `kubectl logs <pod> -c <container> --previous`.
- Exec for live inspection: `kubectl exec -it <pod> -c <container> -- <command>` (keep `--` separator).
- Local access via port-forward: `kubectl port-forward svc/<name> 8080:80` (or `pod/<name>`).
- Quick resource usage: `kubectl top pods -n <ns>` / `kubectl top nodes` (requires Metrics Server).

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
- Use output formatting when needed: `-o json`, `-o yaml`, or `-o jsonpath=<template>`.
- Use `--validate=false` only when API validation is temporarily unavailable.
- CNPG access: use `kubectl cnpg psql -n <ns> <cluster> -- <psql args>` (the `-c` and other psql flags go after `--`).
