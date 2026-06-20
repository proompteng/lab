# Large Model Multi-GPU Scaling

This runbook describes how to run one Flamingo model replica across two or four
NVIDIA RTX PRO 6000 Blackwell GPUs on `turin`. It is for model parallelism, not
for serving multiple independent replicas.

Keep OpenWebUI and other clients outside this path. They should continue to call
the `flamingo` OpenAI-compatible endpoint after the model server is proven.

## Decision

Use one `flamingo` pod that requests every GPU needed by the model. Start with
pipeline parallelism on PCIe-only Blackwell cards, then benchmark tensor
parallelism as an optimization.

| Installed GPUs | First production candidate | Benchmark alternatives |
| --- | --- | --- |
| 2x RTX PRO 6000 Blackwell Max-Q | `PP=2`, `TP=1` | `TP=2`, `PP=1` |
| 4x RTX PRO 6000 Blackwell Max-Q | `PP=4`, `TP=1` | `TP=2`, `PP=2`; `TP=4`, `PP=1` |

Reasoning:

- `flamingo` runs on one Kubernetes node, so vLLM can use native
  multiprocessing instead of Ray.
- RTX PRO 6000 Blackwell cards in Turin are PCIe-attached. Treat them as a
  PCIe/NCCL model-parallel group, not as an NVLink memory pool.
- Pipeline parallelism splits model layers across GPUs and is the safer first
  test on non-NVLink cards.
- Tensor parallelism can improve compute utilization, but it communicates every
  layer and can bottleneck or hang on PCIe/NCCL/P2P issues.

## Preflight

Run these checks before changing the GitOps manifest.

```bash
kubectl get runtimeclass nvidia nvidia-cdi nvidia-legacy

kubectl get node turin -o json | jq '{
  gpuCapacity: .status.capacity["nvidia.com/gpu"],
  gpuAllocatable: .status.allocatable["nvidia.com/gpu"],
  product: .metadata.labels["nvidia.com/gpu.product"],
  count: .metadata.labels["nvidia.com/gpu.count"]
}'

kubectl describe node turin | sed -n '/Allocated resources:/,/Events:/p'

kubectl -n gpu-operator exec ds/turin-nvidia-device-plugin -- nvidia-smi -L
kubectl -n gpu-operator exec ds/turin-nvidia-device-plugin -- nvidia-smi topo -m
```

Stop if any gate is red. Fix hardware, firmware, Talos, NVIDIA runtime, or
device-plugin visibility first.

## Common vLLM Arguments

Every multi-GPU candidate keeps the Qwen3.6 hard-migration target:

```yaml
args:
  - --host
  - 0.0.0.0
  - --port
  - "8000"
  - --model
  - unsloth/Qwen3.6-35B-A3B-NVFP4
  - --served-model-name
  - qwen36-flamingo
  - --trust-remote-code
  - --dtype
  - bfloat16
  - --max-model-len
  - "131072"
  - --gpu-memory-utilization
  - "0.94"
  - --max-num-seqs
  - "128"
  - --max-num-batched-tokens
  - "32768"
  - --enable-prefix-caching
  - --enable-auto-tool-choice
  - --tool-call-parser
  - hermes
  - --optimization-level
  - "2"
```

Add the parallelism flags for the shape under test.

## Two GPUs

Use this when `turin` has at least two free allocatable GPUs for `flamingo`.

First candidate:

```yaml
args:
  - --pipeline-parallel-size
  - "2"
  - --tensor-parallel-size
  - "1"
resources:
  requests:
    cpu: "32"
    memory: 256Gi
    nvidia.com/gpu: "2"
  limits:
    cpu: "96"
    memory: 384Gi
    nvidia.com/gpu: "2"
volumes:
  - name: shm
    emptyDir:
      medium: Memory
      sizeLimit: 32Gi
```

Benchmark this tensor-parallel alternative only after the pipeline-parallel
shape works:

```yaml
args:
  - --tensor-parallel-size
  - "2"
  - --pipeline-parallel-size
  - "1"
```

## Four GPUs

Use this when `turin` has at least four free allocatable GPUs for `flamingo`.

First candidate:

```yaml
args:
  - --pipeline-parallel-size
  - "4"
  - --tensor-parallel-size
  - "1"
resources:
  requests:
    cpu: "64"
    memory: 384Gi
    nvidia.com/gpu: "4"
  limits:
    cpu: "128"
    memory: 768Gi
    nvidia.com/gpu: "4"
volumes:
  - name: shm
    emptyDir:
      medium: Memory
      sizeLimit: 64Gi
```

Benchmark these alternatives after the `PP=4` shape works:

```yaml
# Hybrid: two tensor-parallel groups across two pipeline stages.
args:
  - --tensor-parallel-size
  - "2"
  - --pipeline-parallel-size
  - "2"
```

```yaml
# Full tensor parallelism. Highest PCIe communication risk.
args:
  - --tensor-parallel-size
  - "4"
  - --pipeline-parallel-size
  - "1"
```

The total GPU request must equal `tensor_parallel_size * pipeline_parallel_size`.

## Rollout

Render and inspect before Argo sync:

```bash
mise exec helm@3 -- kustomize build --enable-helm argocd/applications/flamingo > /tmp/flamingo-render.yaml
rg -n -- '--pipeline-parallel-size|--tensor-parallel-size|nvidia.com/gpu|sizeLimit|qwen36-flamingo' /tmp/flamingo-render.yaml
```

Sync through Argo CD after the diff is reviewed:

```bash
argocd app sync flamingo
kubectl -n flamingo rollout status deploy/flamingo --timeout=4h
kubectl -n flamingo get pod -o wide
kubectl describe node turin | sed -n '/Allocated resources:/,/Events:/p'
```

Expected:

- Exactly one `flamingo` pod is running.
- The pod runs on `turin`.
- Node allocation shows the intended `nvidia.com/gpu` count assigned to
  `flamingo`.
- The pod logs show all vLLM workers initialized and the OpenAI API server
  listening on port `8000`.

## Smoke Tests

Cluster-local model listing:

```bash
kubectl -n flamingo run flamingo-smoke \
  --rm -i --restart=Never \
  --image=curlimages/curl:8.11.1 \
  --command -- sh -c '
    curl -fsS http://flamingo.flamingo.svc.cluster.local/v1/models
  '
```

Single chat completion:

```bash
kubectl -n flamingo run flamingo-chat-smoke \
  --rm -i --restart=Never \
  --image=curlimages/curl:8.11.1 \
  --command -- sh -c '
    curl -fsS http://flamingo.flamingo.svc.cluster.local/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"qwen36-flamingo\",\"messages\":[{\"role\":\"user\",\"content\":\"Return only the word ready.\"}],\"max_tokens\":8,\"temperature\":0}"
  '
```

Tool-call smoke:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen36-flamingo",
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
    "max_tokens": 128,
    "temperature": 0
  }' | jq '.choices[0].message.tool_calls'
```

Expected: `tool_calls` is a non-empty array and the function argument includes
`"repo": "lab"`.

## Benchmark Matrix

Record each run before changing the next variable.

| Run | GPUs | TP | PP | Max model length | GPU memory utilization | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `2g-pp2` | 2 | 1 | 2 | `131072` | `0.94` | First 2-GPU candidate |
| `2g-tp2` | 2 | 2 | 1 | `131072` | `0.94` | Compare throughput and NCCL stability |
| `4g-pp4` | 4 | 1 | 4 | `131072` | `0.94` | First 4-GPU candidate |
| `4g-tp2-pp2` | 4 | 2 | 2 | `131072` | `0.94` | Balanced hybrid candidate |
| `4g-tp4` | 4 | 4 | 1 | `131072` | `0.94` | Highest PCIe/NCCL risk |

Capture:

- vLLM image digest and model revision.
- `nvidia-smi topo -m` output.
- vLLM startup worker logs.
- Time to first token.
- Output tokens per second at 1, 4, 8, and 16 concurrent requests.
- Peak GPU memory for each GPU.
- GPU power draw and temperature under load.
- Any NCCL warnings, P2P warnings, OOMs, worker exits, or health probe failures.

## Failure Handling

- If the pod is `Pending`, inspect node allocation, taints, and the exact
  `nvidia.com/gpu` request.
- If workers hang during startup, capture `NCCL_DEBUG=INFO` logs and compare
  `nvidia-smi topo -m` against the preflight output.
- If a tensor-parallel test hangs, roll back to the last pipeline-parallel
  candidate before changing driver, kernel, or IOMMU settings.
- If a pipeline-parallel test is stable but slow, tune `--max-num-seqs`,
  `--max-num-batched-tokens`, MTP, and KV-cache dtype before switching to full
  tensor parallelism.

## Source Notes

- vLLM documents tensor and pipeline parallelism for one model replica and
  recommends pipeline parallelism on non-NVLink GPUs when applicable:
  <https://docs.vllm.ai/en/v0.20.1/serving/parallelism_scaling/>
- SGLang exposes tensor parallelism through `--tp` and data parallelism through
  `--dp`; use `--tp` for one sharded model, not `--dp`:
  <https://sgl-project.github.io/advanced_features/server_arguments.html>
