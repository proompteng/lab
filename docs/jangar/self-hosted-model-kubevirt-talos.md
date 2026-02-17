# Self-Hosted Embeddings On Talos (Altra RTX 3090) via KubeVirt + Saigak

Date: 2026-02-16
Status: Design

## Context

Jangar memories (`/api/memories`) depend on an OpenAI-compatible embeddings backend (`OPENAI_API_BASE_URL`).

The previous “self-hosted model” setup in this repo references a Harvester-based VM (`docker-host`) and Harvester PCI passthrough runbooks. We are now running on Talos, so that documentation is not directly executable.

Goal: run the embeddings model in a KubeVirt VM scheduled onto the Talos node `altra` (with the RTX 3090), with GPU passthrough to the VM, and install Saigak in the VM to expose an OpenAI-compatible endpoint for Jangar.

## Goals

1. Restore Jangar memories API reliability by making embeddings available at a stable, in-cluster address.
2. Make the setup reproducible (GitOps first, minimal manual steps).
3. Use GPU passthrough for the model VM.

## Non-Goals

1. Multi-node GPU scheduling or HA model serving.
2. Fine-grained GPU sharing (MIG/vGPU) unless required later.
3. Replacing Saigak with an in-cluster Ollama chart (we are explicitly choosing “VM + Saigak”).

## Architecture

1. Talos node `altra` provides the physical GPU.
2. KubeVirt runs a VM (“model VM”) on Kubernetes.
3. NVIDIA GPU Operator provisions the node for VM passthrough (VFIO manager binds GPUs to `vfio-pci`; node label `nvidia.com/gpu.workload.config=vm-passthrough` selects the mode).
4. KubeVirt advertises and permits the passthrough resource via `KubeVirt.spec.configuration.permittedHostDevices.pciHostDevices` (KubeVirt's built-in device-plugin; `externalResourceProvider: false`).
5. The VM runs Ubuntu and exposes the Saigak proxy (`:11434`) on the pod network.
6. A Kubernetes `Service` targets the VM launcher pod so cluster workloads can reach `http://<svc>:11434/v1`.
7. Jangar uses that service as `OPENAI_API_BASE_URL`, with the embeddings model `qwen3-embedding-saigak:0.6b` (1024d).

## Repository Inputs (Existing)

1. KubeVirt + CDI apps: `argocd/applications/kubevirt/kustomization.yaml`, `argocd/applications/cdi/kustomization.yaml`, and entries (currently disabled) in `argocd/applicationsets/platform.yaml`.
2. Saigak (installed inside the VM): `services/saigak/`.
3. Jangar config expects a self-hosted embeddings base URL: `argocd/applications/jangar/deployment.yaml` contains `OPENAI_API_BASE_URL`, `OPENAI_EMBEDDING_MODEL`, and `OPENAI_EMBEDDING_DIMENSION`.
4. Talos node-level Tailscale extension tooling (if needed for private pulls / Tailscale-only services): `devices/altra/manifests/tailscale-system-extension.patch.yaml`, `devices/altra/manifests/tailscale-extension-service.template.yaml`, `packages/scripts/src/tailscale/generate-altra-extension-service.ts`, and `devices/galactic/docs/tailscale.md`.

## Known External References (Source Of Truth)

1. KubeVirt host devices / GPU assignment: https://kubevirt.io/user-guide/compute/host-devices/
2. NVIDIA GPU Operator with KubeVirt (vm-passthrough, vfio manager, sandbox device plugin): https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-operator-kubevirt.html
3. Talos NVIDIA GPU docs (for OSS driver support; may or may not be needed for VM passthrough): https://docs.siderolabs.com/talos/v1.12/configure-your-talos-cluster/hardware-and-drivers/nvidia-gpu/

## Execution Plan (GitOps-First)

### Phase 0: Reality Check

1. Confirm `altra` is a Talos node in the Kubernetes cluster and identify its architecture.
2. Confirm the GPU is present on `altra` (PCI vendor/device IDs) and that IOMMU is enabled.
3. Confirm Jangar is actually failing due to embeddings backend (example check: `curl -H 'accept: application/json' "http://jangar.../api/memories?query=test&limit=1"` returns `500`).

### Phase 1: Enable KubeVirt + CDI

1. In `argocd/applicationsets/platform.yaml`, set `kubevirt.enabled: "true"` and `cdi.enabled: "true"`.
2. Ensure the `kubevirt` and `cdi` namespaces are PodSecurity compatible (KubeVirt components often require privileges).
3. Sync Argo apps and verify KubeVirt CRDs exist, `virt-operator`/`virt-api`/`virt-controller` are running, and CDI DataVolume imports succeed.

### Phase 2: Prepare `altra` For VM GPU Passthrough

1. Ensure Talos config enables IOMMU and required modules for VFIO (exact kernel args depend on platform).
2. Label the node `altra` for GPU Operator mode: `nvidia.com/gpu.workload.config=vm-passthrough`.
3. Deploy NVIDIA GPU Operator configured for KubeVirt passthrough (VFIO manager enabled).
4. Verify kubelet advertises the passthrough resource on `altra` (via KubeVirt's built-in device-plugin).

Notes:
1. For VM passthrough, the host typically uses `vfio-pci`, not the NVIDIA datacenter driver.
2. NVIDIA drivers are required inside the guest (Ubuntu VM) to use the GPU.

### Phase 3: Configure KubeVirt Permitted Devices

1. Patch the `KubeVirt` CR to include the GPU passthrough resource in `spec.configuration.permittedHostDevices.pciHostDevices`.
2. Set `externalResourceProvider: true` for the device resource so allocation is controlled by the device plugin.

### Phase 4: Create The Saigak VM

Namespace:
Create a dedicated namespace via ApplicationSet-managed metadata (preferred), or via an Argo app that owns the namespace.

VM resources (GitOps):
1. `DataVolume` root disk (Ubuntu cloud image) via CDI.
2. A persistent data disk (PVC) used for the Ollama model cache and Saigak config.
3. `VirtualMachine` with node affinity to `altra`, a GPU device under `spec.template.spec.domain.devices.gpus` (with `deviceName` matching the advertised resource), and cloud-init that installs NVIDIA drivers inside the VM, installs Docker plus the compose plugin, and installs Saigak and starts the compose stack.

Exposure:
1. `Service` pointing to the VM launcher pod port `11434`.
2. Optional: a Tailscale `Service` (k8s-operator) if you need access from outside the cluster.

### Phase 5: Repoint Jangar To The In-Cluster Saigak Endpoint

1. Update `argocd/applications/jangar/deployment.yaml`:
Set `OPENAI_API_BASE_URL=http://<saigak-service>.<ns>.svc.cluster.local:11434/v1`, `OPENAI_EMBEDDING_MODEL=qwen3-embedding-saigak:0.6b`, and `OPENAI_EMBEDDING_DIMENSION=1024`.
2. Sync `argocd/jangar` and verify Jangar can embed (both `GET /api/memories?...` and `POST /api/memories` return `200`).

## Validation Checklist

1. KubeVirt: `kubectl -n kubevirt get pods`, and `kubectl get crd | rg kubevirt`.
2. GPU Operator: `kubectl -n <gpu-operator-ns> get pods`, and `kubectl describe node altra | rg -n "nvidia\\.com|gpu"`.
3. Saigak VM: `kubectl -n <ns> get dv,pvc,vm,vmi -o wide`, `kubectl -n <ns> get pods -o wide`, and from inside cluster `curl -fsS http://<saigak-svc>:11434/api/version`.
4. Jangar: `kubectl -n jangar logs deploy/jangar -c app --tail=200 | rg -i "embed|embedding|ollama|openai|error"`, and `curl -H 'accept: application/json' "http://jangar.../api/memories?query=test&limit=1"`.

## Failure Modes (Expected)

1. VM won’t start on `altra`:
GPU resource not advertised, or KubeVirt permitted device list missing.
2. GPU present but unusable inside VM:
Guest drivers missing or mismatched, or GPU not actually attached (wrong `deviceName`).
3. Saigak up but embeddings model missing:
`ollama list` doesn’t contain `qwen3-embedding-saigak:0.6b`.
4. Jangar still returns `/api/memories` 500:
Base URL wrong, or Saigak proxy not exposing a `/v1/embeddings` compatible endpoint.

## Migration Notes (Docs)

1. `docs/harvester-gpu-pci-passthrough.md` is Harvester-specific and should be marked deprecated once the Talos-based path is implemented.
2. `docs/jangar/ollama-docker-host.md` assumes a Harvester VM; it should be replaced by a Talos/KubeVirt VM runbook once this design is implemented.
