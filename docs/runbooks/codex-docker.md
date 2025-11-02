# Codex Docker Sidecar Runbook

## Overview
Codex workflows rely on a rootless Docker sidecar that exposes `tcp://127.0.0.1:2375` (loopback-only) to the primary Codex container. The sidecar and Codex container share `/var/lib/docker` via an `emptyDir`; the Codex image mounts this volume read-only and ships the Docker CLI, Buildx, and Compose plugins. This runbook covers validation, recovery, and diagnostic steps for the container build path.

## Validating the Sidecar
1. Identify the workflow pod (stages carry the `codex.stage` label):
   ```bash
   kubectl get pods -n argo-workflows -l codex.stage
   ```
2. Exec into the Codex container and confirm environment variables:
   ```bash
   kubectl exec -n argo-workflows <pod> -c main -- env | grep DOCKER_
   ```
   Expect `DOCKER_HOST=tcp://127.0.0.1:2375`, `DOCKER_ENABLED=1`, and `DOCKER_TLS_VERIFY=0`.
3. Run smoke checks from the Codex container:
   ```bash
   kubectl exec -n argo-workflows <pod> -c main -- docker version
   kubectl exec -n argo-workflows <pod> -c main -- docker info
   kubectl exec -n argo-workflows <pod> -c main -- docker run --rm hello-world
   kubectl exec -n argo-workflows <pod> -c main -- docker build -f apps/froussard/Dockerfile.codex -t codex-universal:test /workspace/lab
   ```
   Capture output in the progress comment or incident ticket.

## Restarting the Rootless Daemon
1. Check the sidecar status:
   ```bash
   kubectl logs -n argo-workflows <pod> -c docker --tail=200
   ```
2. If the daemon is unhealthy, restart just the sidecar:
   ```bash
   kubectl exec -n argo-workflows <pod> -c docker -- pkill -f dockerd-rootless || true
   kubectl exec -n argo-workflows <pod> -c docker -- /bin/sh -ec 'mkdir -p "$XDG_RUNTIME_DIR" && exec dockerd-rootless.sh --host tcp://127.0.0.1:2375'
   ```
3. Confirm readiness via the main container (`docker info`) before resuming workflow steps.

## Collecting Diagnostics
- **Daemon logs:** `kubectl logs -n argo-workflows <pod> -c docker --since=30m`
- **Workflow logs:** `argo logs <workflow-name> --namespace argo-workflows`
- **Volume usage:**
  ```bash
  kubectl exec -n argo-workflows <pod> -c docker -- du -sh /var/lib/docker
  ```
- **Kyverno decisions:** `kubectl get polr -n argo-workflows` (if Kyverno is installed) to confirm the `codex-privileged-guardrails` policy admitted the pod.

## Escalation & Rollback
1. If multiple workflows fail `docker info`, pause new submissions and notify the platform on-call.
2. Roll back by removing the Docker env vars and sidecar entries from the WorkflowTemplates (use Git revert or feature flags) if the daemon cannot be restored quickly.
3. Capture all diagnostics and attach them to the GitHub issue or incident tracker before rollback.
