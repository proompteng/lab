# Saigak Native GPU Runtime

Saigak now targets a native Kubernetes GPU pod on `talos-192-168-1-85` instead
of the KubeVirt passthrough VM. The VM manifest is kept stopped for rollback.

## Runtime contract

- Service: `http://saigak.saigak.svc.cluster.local:11434`
- Compatibility port: `11435` forwards to the same GPU-backed Ollama runtime.
- Completion alias: `qwen3-main-saigak:30b-a3b`
- Embedding alias: `qwen3-embedding-saigak:8b`
- Embedding dimension: `4096`

The readiness sidecar creates both aliases, runs a real embedding request, and
does not mark the pod ready unless `/api/ps` reports nonzero VRAM for the
embedding model. CPU-only embeddings are a failed rollout.

## Rollout order

1. Confirm Ceph and etcd are healthy enough for a reboot of
   `talos-192-168-1-85`.
2. Upgrade Altra to the NVIDIA Talos image and kernel module config in
   `devices/altra/manifests/`.
3. Verify host NVIDIA support:

   ```bash
   talosctl -n 100.100.244.142 -e 100.100.244.142 get extensions | rg 'tailscale|nvidia'
   talosctl -n 100.100.244.142 -e 100.100.244.142 read /proc/modules | rg '^nvidia'
   talosctl -n 100.100.244.142 -e 100.100.244.142 read /proc/driver/nvidia/version
   ```

4. Flip the node into native GPU mode:

   ```bash
   kubectl label node talos-192-168-1-85 lab.proompteng.ai/nvidia-gpu=true --overwrite
   kubectl label node talos-192-168-1-85 nvidia.com/gpu.workload.config=container --overwrite
   ```

5. Sync `nvidia-gpu-operator`, wait for `altra-nvidia-device-plugin`, and verify
   `nvidia.com/gpu: 1` is allocatable.
6. Sync `saigak` and wait for the native pod readiness gate.
7. Smoke:

   ```bash
   kubectl -n saigak exec deploy/saigak -c ollama -- nvidia-smi
   kubectl -n saigak exec deploy/saigak -c ollama -- ollama ps
   kubectl -n saigak run saigak-embedding-smoke --rm -i --restart=Never --image=curlimages/curl:8.16.0 -- \
     curl -fsS http://saigak.saigak.svc.cluster.local:11434/v1/embeddings \
       -H 'Content-Type: application/json' \
       -d '{"model":"qwen3-embedding-saigak:8b","input":"saigak gpu embedding smoke"}'
   ```

## Rollback

1. Scale `deployment/saigak` to zero.
2. Restore the Service selector to `kubevirt.io/domain=saigak`.
3. Set `virtualmachine/saigak` back to `spec.runStrategy: Always`.
4. Restore `nvidia.com/gpu.workload.config=vm-passthrough` if returning to the
   VM path.
