# Flamingo

`flamingo` is the Blackwell model-serving application for coding agents. It is a
normal Kubernetes GPU workload, not a KubeVirt VM.

## Runtime

- Node: `turin`
- GPU: `NVIDIA RTX PRO 6000 Blackwell Max-Q`, advertised as `nvidia.com/gpu: 1`
- RuntimeClass: `nvidia`
- Server: `vllm/vllm-openai:v0.23.0-x86_64-cu129`
- Image digest: `sha256:871762282db5bc464b5a3f0a59e41207ef25c2d95edf5f701e57a6bfc27b9496`
- Primary model: `Qwen/Qwen3-Coder-Next-FP8`
- Served model name: `qwen3-coder-flamingo`
- Internal URL: `http://flamingo.flamingo.svc.cluster.local/v1`
- Tailnet URL: `http://flamingo.ide-newton.ts.net/v1`

`Qwen/Qwen3-Coder-30B-A3B-Instruct` is the fallback only if the FP8 Next model
fails Blackwell image compatibility, OOMs at 32K context, or fails tool-call
smoke tests.

## Rollout Gates

Run the KubeVirt/Talos checks separately. Flamingo does not require Talos
reinstall, node reboot, VFIO rebinding, or GPU passthrough.

Before syncing this app:

```bash
kubectl get runtimeclass nvidia nvidia-cdi nvidia-legacy
kubectl get node turin -o json | jq '.status.allocatable["nvidia.com/gpu"], .metadata.labels["nvidia.com/gpu.product"]'
kubectl describe node turin | sed -n '/Allocated resources:/,/Events:/p'
```

Expected:

- `nvidia.com/gpu` allocatable is `1`.
- Current allocated `nvidia.com/gpu` is `0`.
- Product label is the Blackwell RTX PRO 6000 variant.

Render before sync:

```bash
kustomize build argocd/applications/flamingo
```

After sync:

```bash
kubectl -n flamingo rollout status deploy/flamingo --timeout=4h
kubectl -n flamingo get pod -o wide
kubectl describe node turin | sed -n '/Allocated resources:/,/Events:/p'
```

Expected:

- The `flamingo` pod runs on `turin`.
- Node allocation shows `nvidia.com/gpu: 1`.
- No other workload consumes the GPU.

## Smoke Tests

Cluster-local:

```bash
kubectl -n flamingo run flamingo-smoke \
  --rm -i --restart=Never \
  --image=curlimages/curl:8.11.1 \
  --command -- sh -c '
    curl -fsS http://flamingo.flamingo.svc.cluster.local/v1/models &&
    curl -fsS http://flamingo.flamingo.svc.cluster.local/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"qwen3-coder-flamingo\",\"messages\":[{\"role\":\"user\",\"content\":\"Return only the word ready.\"}],\"max_tokens\":8}"
  '
```

Tailnet:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/models
```

Tool-call smoke:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3-coder-flamingo",
    "messages": [{"role": "user", "content": "Call get_repo_status for lab."}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_repo_status",
        "description": "Return repository status.",
        "parameters": {
          "type": "object",
          "properties": {"repo": {"type": "string"}},
          "required": ["repo"]
        }
      }
    }],
    "tool_choice": "auto",
    "max_tokens": 128
  }' | jq '.choices[0].message.tool_calls'
```

Expected: `tool_calls` is a non-empty array and the function argument includes
`"repo": "lab"`.

## Optimization Rounds

Record each run with the vLLM image digest, model revision, flags, concurrency,
prompt/output token counts, TTFT, output tokens per second, peak GPU memory, GPU
power draw, and any OOM or parser failures.

Round 0: baseline smoke.

```bash
kubectl -n flamingo logs deploy/flamingo --tail=200
kubectl -n flamingo exec deploy/flamingo -- nvidia-smi
```

Round 1: Qwen3-Coder-Next-FP8 at 32K context.

Use the deployed flags:

```text
--max-model-len 32768 --gpu-memory-utilization 0.92 --max-num-seqs 256 --enable-prefix-caching --tool-call-parser qwen3_coder
```

Initial rollout evidence:

- `0.80` reached model load but failed before serving with
  `ValueError: No available memory for the cache blocks`.
- The Blackwell card reported about `97.9 GiB` total memory and vLLM held about
  `77.5 GiB` after loading the FP8 checkpoint.
- `0.92` created `344,797` GPU KV-cache tokens and reported `10.52x`
  maximum concurrency for 32K requests, but vLLM's default `max_num_seqs=1024`
  exceeded the Qwen3-Next Mamba cache block count.
- `--max-num-seqs 256` keeps the sequence cap below available Mamba cache
  blocks while preserving the observed 32K-context KV-cache budget.

Round 2: increase utilization and context only after Round 1 is stable.

Patch one flag at a time in Git:

```text
--gpu-memory-utilization 0.94
--max-model-len 65536
```

Do not combine utilization and context increases in one rollout.

Round 3: MoE tuning.

Only run this if vLLM logs indicate default MoE configuration or poor MoE
throughput. Save generated configs outside Git unless they are proven stable,
then mount them with `VLLM_TUNED_CONFIG_FOLDER`.

Round 4: fallback comparison.

Switch the model to `Qwen/Qwen3-Coder-30B-A3B-Instruct`, keep the served name
`qwen3-coder-flamingo`, and repeat the same benchmark set. Keep Next-FP8 unless
30B-A3B is materially more stable or faster for coding-agent tool workloads.
