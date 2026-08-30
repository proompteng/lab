# Retired Codex Docker Sidecar Runbook

## Overview

This runbook documents the retired Argo Codex workflow Docker sidecar. The generic Agents runtime no longer
ships this sidecar or its old privileged policy from shared `argo-workflows` GitOps. Keep this document only
for investigating historical workflow pods or archived incidents.

## Validate the daemon

1. Confirm connectivity:
   ```bash
   docker info
   docker version
   ```
2. Smoke test runtime:
   ```bash
   docker run --rm hello-world
   ```
3. Exercise buildx/build cache (uses the shared `/var/lib/docker` layer store):
   ```bash
   docker build -f services/jangar/Dockerfile.codex -t codex-universal:test .
   docker images | head
   ```

## Restart the sidecar

- If `docker info` hangs or errors, restart the workflow pod; the sidecar is ephemeral and rebuilds quickly.
- When debugging an in-flight workflow pod:
  ```bash
  kubectl -n argo-workflows logs <pod> -c docker
  kubectl -n argo-workflows exec -c docker <pod> -- ps -ef
  kubectl -n argo-workflows delete pod <pod>
  ```
- Future enhancement: wire a pre-stop hook that gracefully stops `dockerd-rootless.sh` to shorten recycle time.

## Collect logs & metrics

- Sidecar logs: `kubectl -n argo-workflows logs <pod> -c docker`.
- Codex container logs: `kubectl -n argo-workflows logs <pod> -c main` (Argo may name it differently; check `kubectl get pod -o yaml`).
- Capture `docker info` and `docker events` output in incident timelines; attach Argo workflow URL + node name for correlation.

## Safety notes

- Port 2375 is plaintext inside the pod network; do not publish it outside the pod. Keep network policies scoped to the workflow namespace.
- The retired sidecar ran privileged but used a rootless daemon. Current Agents runner images must not depend on
  this shared Argo workflow policy.
- If Pod Security Admission rejects the pod, confirm the namespace allows privileged pods for this service account before retrying.

## Rollout checklist (staging first)

- [ ] Dry-run Argo submission succeeds for the implementation template.
- [ ] `docker run hello-world` and the sample `docker build` complete in staging workflow runs; store logs with the run ID.
- [ ] Node pressure remains acceptable (check CPU/memory/ephemeral usage on the hosting node).
- [ ] After promotion, trigger Argo CD sync of workflow templates and RBAC manifests.
