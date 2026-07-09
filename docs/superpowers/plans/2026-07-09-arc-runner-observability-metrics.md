# ARC Runner Observability Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce normal lab ARC runner CPU requests where benchmarks support it, and make Kubernetes/container runner metrics available in the `observability` Argo CD application for ongoing CI sizing.

**Architecture:** Keep runtime CPU limits unchanged so jobs are not throttled by this request change. Install kube-state-metrics plus an observability-owned Alloy collector that scrapes kube-state-metrics and kubelet/cAdvisor, filters to runner sizing metrics, and remote-writes to the existing Mimir gateway. Provision a Grafana dashboard and Mimir alert rules from the same observability app so the signal is owned by GitOps.

**Tech Stack:** Argo CD, Kustomize Helm integration, kube-state-metrics chart `7.3.0`, Grafana Alloy `v1.11.2`, Grafana Mimir, Grafana dashboards, GitHub Actions ARC.

---

## Benchmark Summary

The ARC request change lowers only scheduler requests for the normal `arc-amd64` and `arc-arm64` scale sets:

- `runner.requests.cpu`: `4` to `2`
- `dind.requests.cpu`: `4` to `2`
- CPU limits remain `runner=8`, `dind=12`
- Memory, storage, labels, and `maxRunners=25` remain unchanged

Kubernetes CPU requests do not cap runtime CPU. They decide whether a pod can schedule. Runtime speed is affected by CPU limits and by actual node contention.

Recent GitHub Actions baseline, last five successful runs where available:

| Workflow job                         | Runner      | Average |
| ------------------------------------ | ----------- | ------: |
| `agents-build-push` controller image | `arc-amd64` |  219.8s |
| `agents-build-push` controller image | `arc-arm64` |  472.8s |
| `agents-build-push` runner image     | `arc-amd64` |  210.6s |
| `agents-build-push` runner image     | `arc-arm64` |  380.8s |
| `jangar-build-push` Nix image        | `arc-amd64` |  465.8s |
| `jangar-build-push` Nix image        | `arc-arm64` |  862.4s |
| `torghut-build-push` Nix image       | `arc-amd64` |  169.2s |
| `torghut-build-push` Nix image       | `arc-arm64` |  202.4s |
| `Temporal Bun SDK CI` test           | `arc-arm64` |  551.6s |

Live Kubernetes benchmark, same runner image and dind sidecar:

| Profile                 | Scheduled |  CPU avg | Docker avg | Total avg |
| ----------------------- | --------: | -------: | ---------: | --------: |
| `amd64` current `4+4`   |       8/8 | 1226.4ms |   3302.1ms |  4536.0ms |
| `amd64` candidate `2+2` |       8/8 | 1226.0ms |   4017.4ms |  5251.1ms |
| `arm64` current `4+4`   |     11/12 | 1444.5ms |  10842.0ms | 12300.5ms |
| `arm64` candidate `2+2` |     18/25 | 1453.6ms |  19836.4ms | 21304.8ms |

Decision:

- CPU-bound work was flat: `amd64` changed by ~0.0%, `arm64` by ~0.6%.
- Docker-heavy synthetic work slowed on arm64 at higher density, but current `4+4` already fails to schedule even 12 pods; candidate `2+2` scheduled 18 pods before Altra reached 98% requested CPU.
- Proceed with `2+2` requests because the change improves scheduling without lowering CPU limits.
- Do not lower CPU limits from the current `runner=8`, `dind=12` without real Mimir P95/P99 data.
- Next performance optimization should split normal Nix/non-Docker runners from Docker/dind runners, because most Nix OCI workflows do not need dind but currently reserve it.

## Files

- Modify: `argocd/applications/arc/application.yaml`
  - Lower normal lab `arc-amd64` and `arc-arm64` runner/dind CPU requests.
- Modify: `argocd/applications/observability/kustomization.yaml`
  - Add kube-state-metrics Helm chart and cluster metrics resources.
- Create: `argocd/applications/observability/kube-state-metrics-values.yaml`
  - Configure kube-state-metrics resources and naming.
- Create: `argocd/applications/observability/cluster-metrics-alloy-rbac.yaml`
  - Grant Alloy read access for node, pod, service, endpoint, endpoint slice, and kubelet proxy scrapes.
- Create: `argocd/applications/observability/cluster-metrics-alloy-configmap.yaml`
  - Scrape kube-state-metrics, kubelet `/metrics`, and kubelet `/metrics/cadvisor`.
  - Keep only ARC sizing and existing kube alert metrics before remote_write.
- Create: `argocd/applications/observability/cluster-metrics-alloy-deployment.yaml`
  - Run the cluster metrics Alloy collector in the `observability` namespace.
- Create: `argocd/applications/observability/arc-runner-capacity-dashboard-configmap.yaml`
  - Provision Grafana dashboard `ARC Runner Capacity`.
- Modify: `argocd/applications/observability/grafana-values.yaml`
  - Mount the ARC dashboard.
- Modify: `argocd/applications/observability/graf-mimir-rules.yaml`
  - Alert when ARC metrics disappear, runner pods stay pending, or Altra requested CPU is saturated.

## Execution Tasks

### Task 1: ARC Request Reduction

- [x] Change normal `arc-arm64` runner CPU request from `4` to `2`.
- [x] Change normal `arc-arm64` dind CPU request from `4` to `2`.
- [x] Change normal `arc-amd64` runner CPU request from `4` to `2`.
- [x] Change normal `arc-amd64` dind CPU request from `4` to `2`.
- [x] Leave analysis runner requests unchanged at `1+1`.
- [x] Leave CPU limits unchanged.

### Task 2: Observability Metrics Pipeline

- [x] Install kube-state-metrics from the `observability` app.
- [x] Add an Alloy collector in the `observability` namespace.
- [x] Scrape kube-state-metrics for `kube_pod_container_resource_requests`, `kube_pod_container_resource_limits`, `kube_node_status_allocatable`, `kube_pod_status_phase`, `kube_pod_labels`, and deployment/restart metrics.
- [x] Scrape kubelet cAdvisor for `container_cpu_usage_seconds_total` and `container_memory_working_set_bytes`.
- [x] Remote-write the filtered metrics to the existing Mimir gateway.

### Task 3: Dashboards And Alerts

- [x] Add Grafana dashboard `ARC Runner Capacity`.
- [x] Add Mimir rule `ArcRunnerResourceMetricsMissing`.
- [x] Add Mimir rule `ArcRunnerPodsPending`.
- [x] Add Mimir rule `ArcArm64RequestedCpuSaturated`.

### Task 4: Validation

- [x] Run `kustomize build --enable-helm argocd/applications/observability`.
- [x] Run `kubectl apply --dry-run=server -f argocd/applications/arc/application.yaml`.
- [x] Run server dry-run validation for the new observability Alloy and dashboard manifests.
- [x] Parse the ARC dashboard JSON from `argocd/applications/observability/arc-runner-capacity-dashboard-configmap.yaml`.
- [x] Run `bunx oxfmt --check argocd/applications/arc/application.yaml argocd/applications/observability docs/superpowers/plans/2026-07-09-arc-runner-observability-metrics.md`.
- [ ] Open PR using `.github/PULL_REQUEST_TEMPLATE.md`.
- [ ] Merge with squash after checks pass.
- [ ] Refresh/sync `arc` and `observability` Argo CD apps.
- [ ] Verify `arc-amd64` and `arc-arm64` live runner templates have `runner=2`, `dind=2` CPU requests.
- [ ] Verify Mimir has these series in tenant `anonymous`: `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`, `kube_pod_container_resource_requests`, `kube_node_status_allocatable`.
