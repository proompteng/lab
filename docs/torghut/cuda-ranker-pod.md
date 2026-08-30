# Torghut CUDA Ranker Pod Notes

This lane is disabled. The cluster RTX 3090 is reserved for Saigak embeddings as
a normal Kubernetes `nvidia.com/gpu` container device on `talos-192-168-1-85`.
Do not re-enable this KubeVirt passthrough lane without first moving Saigak
embeddings off that GPU.

Historically, this used the KubeVirt PCI passthrough path. That resource is no
longer part of active desired state after the Saigak embeddings migration.

`argocd/applications/torghut-cuda-ranker` defines that separate lane. It is a
KubeVirt `VirtualMachine` that will create a `virt-launcher` pod with:

- `architecture: arm64`
- node pin: `talos-192-168-1-85`
- GPU device: none; this lane needs redesign before activation
- 12 vCPU cores, 48 GiB memory, and a local-path data disk
- guest boot verification through `nvidia-smi`

When enabled and started, KubeVirt will create a dedicated
`virt-launcher-torghut-cuda-ranker-*` pod, which is the actual Kubernetes pod
that owns the GPU device. The `platform` ApplicationSet keeps the app disabled
and the VM manifest keeps `spec.running: false`. Do not enable or start it while
`saigak` owns the only RTX 3090. A second GPU consumer will remain pending, or it
will force an operational decision to stop or migrate `saigak`.

Activation requires both changes:

1. Set the `torghut-cuda-ranker` ApplicationSet entry to `enabled: "true"`.
2. Set `argocd/applications/torghut-cuda-ranker/virtualmachine.yaml` to
   `spec.running: true`.

The current production authority stays unchanged: scheduler-v3 real replay,
post-cost ledgers, hard vetoes, portfolio oracle, runtime closure, and shadow or
paper evidence decide promotion. GPU ranking can only propose candidates; it
must not bypass replay or risk gates.
