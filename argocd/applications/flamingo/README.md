# Flamingo

`flamingo` is the Turin Blackwell GPU model-serving application for coding
agents. It is a normal Kubernetes Deployment, not a KubeVirt VM.

## Production Target

- Node: `turin`
- GPU: `NVIDIA RTX PRO 6000 Blackwell Max-Q`, advertised as `nvidia.com/gpu: 1`
- RuntimeClass: `nvidia`
- Server: `vllm/vllm-openai:v0.23.0-x86_64-cu129`
- Image digest: `sha256:871762282db5bc464b5a3f0a59e41207ef25c2d95edf5f701e57a6bfc27b9496`
- Model: `unsloth/Qwen3.6-35B-A3B-NVFP4`
- Served model name: `qwen36-flamingo`
- Internal URL: `http://flamingo.flamingo.svc.cluster.local/v1`
- Tailnet URL: `http://flamingo.ide-newton.ts.net/v1`

This is a hard migration. Do not keep the previous served alias or previous
model as an active fallback in GitOps, Pi, AnyPi, or OpenWebUI config.

## Current Launch Profile

```text
--model unsloth/Qwen3.6-35B-A3B-NVFP4
--served-model-name qwen36-flamingo
--trust-remote-code
--dtype bfloat16
--max-model-len 262144
--gpu-memory-utilization 0.95
--kv-cache-dtype nvfp4
--max-num-seqs 16
--max-num-batched-tokens 16384
--enable-prefix-caching
--reasoning-parser qwen3
--enable-auto-tool-choice
--tool-call-parser qwen3_coder
--optimization-level 2
```

The production target is full 262K server context. If this profile fails,
reduce concurrency first by moving to `--max-num-seqs 8` and
`--max-num-batched-tokens 8192`. Do not reduce context below 262K unless both
vLLM KV/concurrency tuning and an SGLang validation path fail.

NUMA auto-binding is intentionally disabled. Live rollout proved that vLLM
0.23.0 cannot auto-detect Turin's GPU-to-NUMA topology and exits with
`NUMA binding was requested, but vLLM could not detect the GPU-to-NUMA topology
automatically`. Test NUMA only with explicit `--numa-bind-nodes` values after a
separate topology readback.

The active reasoning parser is `qwen3`, so reasoning text is returned through
the OpenAI-compatible reasoning field instead of being mixed into normal
assistant content. The active tool parser is `qwen3_coder`, which is the vLLM
Qwen3.5/Qwen3.6 recipe recommendation for automatic tool calling.
Reference: <https://docs.vllm.ai/projects/recipes/en/latest/Qwen/Qwen3.5.html>

## Rollout Gates

Run these checks before syncing:

```bash
kubectl get runtimeclass nvidia nvidia-cdi nvidia-legacy
kubectl get node turin -o json | jq '.status.allocatable["nvidia.com/gpu"], .metadata.labels["nvidia.com/gpu.product"]'
kubectl describe node turin | sed -n '/Allocated resources:/,/Events:/p'
kubectl -n flamingo exec deploy/flamingo -- df -h /models || true
```

Expected:

- `nvidia.com/gpu` allocatable is `1`.
- No non-Flamingo workload consumes the GPU.
- The model-cache PVC has enough free space for the Qwen3.6 NVFP4 artifact.

Render before sync:

```bash
mise exec helm@3 -- kustomize build --enable-helm argocd/applications/flamingo
bun run lint:flamingo-hard-migration
```

After sync:

```bash
kubectl -n flamingo rollout status deploy/flamingo --timeout=4h
kubectl -n flamingo get pod -o wide
kubectl -n flamingo logs deploy/flamingo --tail=300
kubectl -n flamingo exec deploy/flamingo -- nvidia-smi
```

Expected:

- The `flamingo` pod runs on `turin`.
- Node allocation shows `nvidia.com/gpu: 1`.
- Logs show the OpenAI API server listening on port `8000`.
- Logs do not show OOM loops, parser failures, sustained preemption, or KV
  starvation.

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
      -d "{\"model\":\"qwen36-flamingo\",\"messages\":[{\"role\":\"user\",\"content\":\"Return only the word ready.\"}],\"chat_template_kwargs\":{\"enable_thinking\":false},\"max_tokens\":16,\"temperature\":0}"
  '
```

Tailnet:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/models
curl -fsS http://flamingo.ide-newton.ts.net/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen36-flamingo","messages":[{"role":"user","content":"Say flamingo-ok."}],"chat_template_kwargs":{"enable_thinking":false},"max_tokens":16,"temperature":0}' \
  | jq -e '.choices[0].message.content | contains("flamingo-ok")'
```

Tool-call smoke:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen36-flamingo",
    "messages": [{"role": "user", "content": "Use the provided tool to add 7 and 35. Do not answer directly."}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "add",
        "description": "Add two integers.",
        "strict": true,
        "parameters": {
          "type": "object",
          "properties": {
            "a": {"type": "integer"},
            "b": {"type": "integer"}
          },
          "required": ["a", "b"],
          "additionalProperties": false
        }
      }
    }],
    "tool_choice": "auto",
    "max_tokens": 128,
    "temperature": 0
  }' | jq '.choices[0].message.tool_calls'
```

Expected: `tool_calls` is a non-empty array and arguments include `7` and `35`.
If this returns only prose or raw XML, do not accept the rollout; fix the
generic vLLM serving flags or image first.

## Pi And AnyPi Contract

Pi and AnyPi must use Qwen chat-template thinking controls for this endpoint:

```json
{
  "compat": {
    "supportsStore": false,
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "maxTokensField": "max_tokens",
    "thinkingFormat": "qwen-chat-template"
  },
  "models": [
    {
      "id": "qwen36-flamingo",
      "reasoning": true,
      "contextWindow": 229376,
      "maxTokens": 32768
    }
  ]
}
```

Default thinking level for agent work is `medium`. Pi sends this to vLLM as
`chat_template_kwargs.enable_thinking=true` and preserves Qwen thinking across
turns with `preserve_thinking=true`.

## Optimization Matrix

Record each run with the vLLM image digest, model revision, flags, concurrency,
prompt/output token counts, TTFT, output tokens per second, peak GPU memory, GPU
power draw, temperature, preemption count, and any OOM or parser failure.

Use the repo runner so output is comparable:

```bash
bun run flamingo:benchmark --profile=smoke
bun run flamingo:benchmark --profile=full --long-targets=180000,220000,229000
```

| Profile | Context | `gpu_memory_utilization` | `max_num_seqs` | `max_num_batched_tokens` | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `baseline-131k` | `131072` | `0.94` | `128` | `16384` | Pre-optimization baseline only |
| `context-262k-nvfp4` | `262144` | `0.95` | `16` | `16384` | Initial production candidate |
| `context-262k-lowseq` | `262144` | `0.95` | `8` | `8192` | Startup fallback if the initial candidate OOMs |
| `kv-262k-fp8` | `262144` | `0.95` | `16` | `16384` | Compare only after NVFP4 smokes pass |
| `kv-262k-auto` | `262144` | `0.95` | `16` | `16384` | Compare only after FP8 |
| `batch-262k-32k` | `262144` | `0.95` | `16` | `32768` | Promote only if TTFT and preemption stay acceptable |
| `mem-262k-097` | `262144` | `0.97` | `16` | `16384` | Promote only if no OOM or sustained preemption |

MTP candidate flags:

```text
--moe-backend marlin
--speculative-config {"method":"mtp","num_speculative_tokens":3,"moe_backend":"triton"}
```

KV-cache candidates must be checked against the pinned vLLM image before use:

```text
--kv-cache-dtype fp8
--kv-cache-dtype nvfp4
```

Do not combine MTP, KV-cache dtype, batching, and memory changes after the
initial 262K candidate. Change one variable, run the smoke suite, then run a
real AnyPi AgentRun.

## Completion Criteria

- `/v1/models` returns `qwen36-flamingo` with `max_model_len=262144`.
- Basic chat and structured tool calls work from cluster and tailnet.
- OpenWebUI defaults to `qwen36-flamingo`.
- Host Pi defaults to `qwen36-flamingo`.
- AnyPi provider defaults to `qwen36-flamingo`, 229376 input context, 32768 max
  output, and medium Qwen thinking against the 262K server context.
- One substantial AnyPi AgentRun produces a real code/test diff and validates.
- The benchmark table is updated with the final promoted flags.

## References

- [Unsloth Qwen3.6-35B-A3B-NVFP4](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-NVFP4)
- [vLLM tool calling](https://docs.vllm.ai/en/stable/features/tool_calling/)
- [vLLM optimization](https://docs.vllm.ai/en/stable/configuration/optimization/)
