# Codex Docker Sidecar Runbook

## Overview
- Codex workflow pods now ship with a rootless Docker sidecar (`docker:25.0-dind-rootless`) exposing `tcp://localhost:2375` with TLS disabled.
- The sidecar owns `/var/lib/docker` on an `emptyDir` volume; the main Codex container mounts it read-only to reuse layers without permitting mutation.
- `DOCKER_HOST=tcp://localhost:2375` is baked into the Codex image; `DOCKER_TLS_VERIFY` should be unset for the in-pod daemon (bootstrap treats `0`/`false` as unset). `DOCKER_ENABLED=1` is set by the docker-enabled WorkflowTemplates so bootstrap waits for the sidecar. Image default for `DOCKER_ENABLED` remains `0` to avoid blocking workflows without a daemon.

## Validate the daemon
1) Confirm connectivity:
   ```bash
   docker info
   docker version
   ```
2) Smoke test runtime:
   ```bash
   docker run --rm hello-world
   ```
3) Exercise buildx/build cache (uses the shared `/var/lib/docker` layer store):
   ```bash
   docker build -f apps/froussard/Dockerfile.codex -t codex-universal:test .
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
- Sidecar runs `privileged` but rootless daemon; RBAC binding `codex-docker-privileged` scopes usage to the Codex workflow service account.
- If Pod Security Admission rejects the pod, confirm the namespace allows privileged pods for this service account before retrying.

## Rollout checklist (staging first)
- [ ] Dry-run Argo submission succeeds for the implementation template.
- [ ] `docker run hello-world` and the sample `docker build` complete in staging workflow runs; store logs with the run ID.
- [ ] Node pressure remains acceptable (check CPU/memory/ephemeral usage on the hosting node).
- [ ] After promotion, trigger Argo CD sync of workflow templates and RBAC manifests.
