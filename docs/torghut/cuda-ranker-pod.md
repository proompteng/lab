# Torghut CUDA Ranker Pod Notes

The cluster 3090 is not available to the regular Torghut service pod as a normal
CUDA container device. The GPU node is ARM Talos, the NVIDIA host driver/toolkit
path is disabled, and KubeVirt exposes the GPU as PCI passthrough:

- resource: `nvidia.com/GA102_GEFORCE_RTX_3090`
- current consumer pattern: `argocd/applications/saigak/virtualmachine.yaml`
- KubeVirt setup: `argocd/applications/kubevirt/kustomization.yaml`
- GPU operator mode: `argocd/applications/nvidia-gpu-operator/values.yaml`
- Torghut CUDA lane: `argocd/applications/torghut-cuda-ranker/`

A CUDA-backed Torghut ranker therefore needs a separate KubeVirt VM/pod lane,
not a flag on the current autoresearch container. The VM must request the same
GPU resource under `spec.template.spec.domain.devices.gpus`, boot an ARM64 image
with NVIDIA guest drivers, and expose a narrow ranker API or artifact exchange
that the whitepaper autoresearch workflow can call before replay selection.

`argocd/applications/torghut-cuda-ranker` defines that separate lane. It is a
KubeVirt `VirtualMachine` that will create a `virt-launcher` pod with:

- `architecture: arm64`
- node pin: `talos-192-168-1-85`
- GPU device: `nvidia.com/GA102_GEFORCE_RTX_3090`
- 12 vCPU cores, 48 GiB memory, and a local-path data disk
- guest boot verification through `nvidia-smi`

When enabled and started, KubeVirt will create a dedicated
`virt-launcher-torghut-cuda-ranker-*` pod, which is the actual Kubernetes pod
that owns the GPU device. The `platform` ApplicationSet keeps the app disabled
and the VM manifest keeps `spec.running: false`. Do not enable or start it while
`saigak` owns the only `nvidia.com/GA102_GEFORCE_RTX_3090` device. A second GPU
consumer will remain pending, or it will force an operational decision to stop
or migrate `saigak`.

Activation requires both changes:

1. Set the `torghut-cuda-ranker` ApplicationSet entry to `enabled: "true"`.
2. Set `argocd/applications/torghut-cuda-ranker/virtualmachine.yaml` to
   `spec.running: true`.

The current production authority stays unchanged: scheduler-v3 real replay,
post-cost ledgers, hard vetoes, portfolio oracle, runtime closure, and shadow or
paper evidence decide promotion. GPU ranking can only propose candidates; it
must not bypass replay or risk gates.
