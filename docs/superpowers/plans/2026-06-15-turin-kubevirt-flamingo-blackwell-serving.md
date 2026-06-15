# Turin KubeVirt And Flamingo Blackwell Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable ordinary KubeVirt VM scheduling on Turin and add `flamingo`, a Kubernetes GPU pod app for Blackwell-backed coding-agent model serving.

**Architecture:** KubeVirt gets only the component customization needed for `virt-handler` to run on Turin's control-plane-tainted node. Flamingo is a separate Argo CD application pinned to Turin's NVIDIA RuntimeClass and single Blackwell GPU, exposed through an OpenAI-compatible vLLM endpoint for host-side and future in-cluster agents.

**Tech Stack:** Argo CD ApplicationSet, Kustomize, KubeVirt `v1.8.2`, Talos `v1.13.4`, NVIDIA GPU Operator runtime classes, vLLM OpenAI server, Qwen3-Coder-Next-FP8, Tailscale LoadBalancer services.

---

## Boundaries

- Do not reboot Turin.
- Do not reinstall or patch live Talos machine config.
- Do not modify Ceph storage topology.
- Do not switch Turin into GPU passthrough mode.
- Do not migrate embeddings away from `saigak` in this change.
- Do not repurpose the existing `saigak` KubeVirt VM for the Blackwell card.

## Files

- Modify: `argocd/applications/kubevirt/kustomization.yaml`
- Modify: `argocd/applicationsets/platform.yaml`
- Create: `argocd/applications/flamingo/kustomization.yaml`
- Create: `argocd/applications/flamingo/deployment.yaml`
- Create: `argocd/applications/flamingo/service.yaml`
- Create: `argocd/applications/flamingo/tailscale-service.yaml`
- Create: `argocd/applications/flamingo/pvc.yaml`
- Create: `argocd/applications/flamingo/README.md`
- Create: `devices/turin/docs/kubevirt-on-turin.md`
- Modify: `devices/turin/README.md`
- Create: `docs/jangar/saigak-to-flamingo-gpu-pod-migration.md`

### Task 1: Save The Plan

- [x] **Step 1: Add this implementation plan under `docs/superpowers/plans/`.**

### Task 2: Enable KubeVirt Infra Scheduling On Turin

- [x] **Step 1: Patch `virt-handler` tolerations through `KubeVirt.spec.customizeComponents.patches`.**

Only `virt-handler` placement changes. Do not add global workload node placement and do not change `permittedHostDevices`.

Expected rendered KubeVirt spec includes:

```yaml
spec:
  customizeComponents:
    patches:
      - resourceType: DaemonSet
        resourceName: virt-handler
        type: strategic
        patch: '{"spec":{"template":{"spec":{"tolerations":[{"key":"CriticalAddonsOnly","operator":"Exists"},{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}]}}}}'
```

- [ ] **Step 2: After GitOps sync, verify `virt-handler` on Turin.**

```bash
kubectl -n kubevirt rollout status ds/virt-handler --timeout=10m
kubectl -n kubevirt get pod -o wide | rg 'virt-handler|turin'
kubectl get node turin -o json | jq -r '.metadata.labels["kubevirt.io/schedulable"]'
```

Expected: a `virt-handler` pod runs on `turin` and the node label is `true`.

- [ ] **Step 3: Run a temporary non-GPU VMI canary pinned to Turin, then delete it.**

The canary must not request GPUs, PVCs, or host devices.

### Task 3: Add Flamingo

- [x] **Step 1: Create the Argo CD app directory.**

The app pins a vLLM Deployment to Turin, requests exactly one GPU, mounts persistent cache storage, and exposes an OpenAI-compatible endpoint.

- [x] **Step 2: Register `flamingo` in the platform ApplicationSet.**

The app is manual sync, wave `2`, and uses managed namespace metadata with privileged Pod Security labels for NVIDIA runtime compatibility.

### Task 4: Document Migration And Operations

- [x] **Step 1: Add the Turin KubeVirt runtime checklist.**

Document that plain VM scheduling needs KVM, vhost, tun, and `virt-handler`, while GPU passthrough is a separate VFIO/IOMMU project.

- [x] **Step 2: Add the Saigak-to-Flamingo migration runbook.**

Document completion-only migration, rollback env values, validation order, and decommission criteria.

### Task 5: Validate

- [x] **Step 1: Render KubeVirt.**

```bash
kustomize build argocd/applications/kubevirt
```

Expected: render succeeds and includes `infra.nodePlacement.tolerations`.

- [x] **Step 2: Render Flamingo.**

```bash
kustomize build argocd/applications/flamingo
```

Expected: render succeeds and includes the pinned vLLM image, GPU limit, Turin node selector, and Tailscale service.

- [x] **Step 3: Render the platform ApplicationSet.**

```bash
bun run lint:argocd
```

Expected: Argo lint passes for the changed app set and applications.
