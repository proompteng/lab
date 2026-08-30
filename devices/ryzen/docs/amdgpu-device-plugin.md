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

These DaemonSets are gated behind an explicit node label so they don't
CrashLoop on nodes without the `amdgpu` kernel driver loaded:

```bash
# Enable on the intended GPU node only.
kubectl --context ryzen label node <node-name> lab.proompteng.ai/amdgpu=true
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

## Fix: GPU present but `amdgpu` driver not loaded (Talos)

Symptom:

- `amdgpu-labeller-daemonset` CrashLoopBackOff with `amdgpu driver unavailable`
- `/sys/module/amdgpu` missing on the host
- Node has no `amd.com/gpu` capacity

Cause:

- On Talos, GPU drivers come from **system extensions** which only take effect
  on **install/upgrade**. Having a Kubernetes DaemonSet is not enough.

Procedure (Talos v1.12.4, non-deprecated boot-assets workflow):

1. Generate an Image Factory schematic that includes `siderolabs/amdgpu` and
   `siderolabs/amd-ucode` (we keep the schematic source in-repo):
   - `devices/ryzen/manifests/ryzen-tailscale-schematic.yaml`

   ```bash
   curl -sS -X POST --data-binary @devices/ryzen/manifests/ryzen-tailscale-schematic.yaml \\
     https://factory.talos.dev/schematics | jq -r .id
   ```

2. Patch the node to use the generated installer image.

   Note: do **not** use the deprecated `.machine.install.extensions` API. The
   Image Factory installer image embeds the required extensions.

   ```bash
   SCHEMATIC_ID=<id-from-step-1>

   cat > /tmp/ryzen-installer-image.patch.yaml <<EOF
   machine:
     install:
       image: factory.talos.dev/metal-installer/${SCHEMATIC_ID}:v1.12.4
   EOF

   talosctl patch machineconfig -n 192.168.1.194 -e 192.168.1.194 \\
     --patch @/tmp/ryzen-installer-image.patch.yaml --mode=no-reboot
   ```

3. If the node has stale deprecated fields from older configs, remove them via
   JSON patch (this does not require a reboot):

   ```bash
   cat > /tmp/ryzen-remove-install-extensions.jsonpatch.yaml <<'EOF'
   - op: remove
     path: /machine/install/extensions
   EOF

   cat > /tmp/ryzen-remove-install-extra-kernel-args.jsonpatch.yaml <<'EOF'
   - op: remove
     path: /machine/install/extraKernelArgs
   EOF

   talosctl patch machineconfig -n 192.168.1.194 -e 192.168.1.194 \\
     --patch @/tmp/ryzen-remove-install-extensions.jsonpatch.yaml --mode=no-reboot

   talosctl patch machineconfig -n 192.168.1.194 -e 192.168.1.194 \\
     --patch @/tmp/ryzen-remove-install-extra-kernel-args.jsonpatch.yaml --mode=no-reboot
   ```

   We keep kernel args in the Image Factory schematic, not in machine config.

4. Upgrade the node using the custom installer image (this reboots the node):

   ```bash
   talosctl upgrade -n 192.168.1.194 -e 192.168.1.194 \\
     --image factory.talos.dev/metal-installer/${SCHEMATIC_ID}:v1.12.4
   ```

5. Verify the OS-level driver is active:

   ```bash
   talosctl get extensions -n 192.168.1.194 -e 192.168.1.194
   talosctl read -n 192.168.1.194 -e 192.168.1.194 /proc/modules | rg '^amdgpu\\b'
   ```

6. Enable the Kubernetes DaemonSets on the intended GPU node:

   These manifests are gated behind `lab.proompteng.ai/amdgpu=true` so they
   don't CrashLoop on nodes without the driver.

   ```bash
   kubectl label node <node-name> lab.proompteng.ai/amdgpu=true
   ```

7. Verify Kubernetes sees the GPU:

   ```bash
   kubectl describe node <node-name> | rg -i 'amd.com/gpu'
   kubectl get node <node-name> -o json | jq -r '.status.capacity[\"amd.com/gpu\"]'
   ```

## Notes

These manifests were applied manually per request. If you want GitOps
management, create an Argo CD app that references these files.
