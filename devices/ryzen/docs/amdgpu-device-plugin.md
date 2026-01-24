# AMD GPU device plugin (Ryzen Talos)

This Ryzen Talos node uses a Radeon 8060S iGPU (Ryzen AI Max+ 395). The
AMD GPU Operator is **not** supported for Radeon/Ryzen devices; it targets
AMD Instinct GPUs only. Use the ROCm Kubernetes device plugin instead.

Refs:
- https://instinct.docs.amd.com/projects/gpu-operator/en/release-v1.3.0/index.html
- https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityryz/native_linux/native_linux_compatibility.html
- https://instinct.docs.amd.com/projects/k8s-device-plugin/en/latest/

## Manifests (pinned)

We vendor the upstream manifests under:
- `devices/ryzen/manifests/k8s/amdgpu-device-plugin.yaml`
- `devices/ryzen/manifests/k8s/amdgpu-device-labeller.yaml`

Images are pinned by digest for reproducibility (pulled from Docker Hub):
- `rocm/k8s-device-plugin@sha256:e42d51ddaf66af07a2d983eb10bbaf2a6068dbc4ddcf90ddbb1e91a396b0c447`
- `rocm/k8s-device-plugin@sha256:302ef02bff5190fbac61922fc6fe7e15a8b5936fa78b080472fb7931597ec7bb`

## Install (Ryzen cluster)

```bash
kubectl --context ryzen apply -f devices/ryzen/manifests/k8s/amdgpu-device-plugin.yaml
kubectl --context ryzen apply -f devices/ryzen/manifests/k8s/amdgpu-device-labeller.yaml
```

## Verify

```bash
kubectl --context ryzen -A get pods | rg -i 'amdgpu|labeller'

kubectl --context ryzen describe node ryzen | rg -i 'amd.com/gpu'

kubectl --context ryzen get node ryzen -o json | jq -r '.status.capacity["amd.com/gpu"]'
```

Expected:
- `amdgpu-device-plugin-daemonset` and `amdgpu-labeller-daemonset` Running in `kube-system`.
- Node labels like `amd.com/gpu.product-name=Radeon_8060S_Graphics`.
- Capacity `amd.com/gpu: 1`.

## Troubleshooting

- If pods run but `amd.com/gpu` capacity is missing, check plugin logs:
  `kubectl --context ryzen -n kube-system logs daemonset/amdgpu-device-plugin-daemonset`.
- Confirm Talos AMD GPU extensions are active:
  `talosctl get extensions -n 192.168.1.194 -e 192.168.1.194`.
- Confirm kernel args are present:
  `talosctl read -n 192.168.1.194 -e 192.168.1.194 /proc/cmdline`.

## Notes

These manifests were applied manually per request. If you want GitOps
management, create an Argo CD app that references these files.
