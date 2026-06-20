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
--max-model-len 131072
--gpu-memory-utilization 0.94
--max-num-seqs 128
--max-num-batched-tokens 16384
--enable-prefix-caching
--enable-auto-tool-choice
--tool-call-parser hermes
--optimization-level 2
--numa-bind
```

The production floor is 128K context. If this profile fails, reduce concurrency
first. Do not restore the old model as the desired state.

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
      -d "{\"model\":\"qwen36-flamingo\",\"messages\":[{\"role\":\"user\",\"content\":\"Return only the word ready.\"}],\"max_tokens\":8,\"temperature\":0}"
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
    "model": "qwen36-flamingo",
    "messages": [{"role": "user", "content": "Use the provided tool to add 7 and 35. Do not answer directly."}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "add",
        "description": "Add two integers.",
        "parameters": {
          "type": "object",
          "properties": {
            "a": {"type": "integer"},
            "b": {"type": "integer"}
          },
          "required": ["a", "b"]
        }
      }
    }],
    "tool_choice": "auto",
    "max_tokens": 128,
    "temperature": 0
  }' | jq '.choices[0].message.tool_calls'
```

Expected: `tool_calls` is a non-empty array and arguments include `7` and `35`.

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
  "contextWindow": 98304,
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

| Profile | Context | `gpu_memory_utilization` | `max_num_seqs` | `max_num_batched_tokens` | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `baseline-128k` | `131072` | `0.94` | `128` | `16384` | Current production target |
| `batch-128k-32k` | `131072` | `0.94` | `128` | `32768` | Promote if TTFT stays acceptable |
| `seq-128k-256` | `131072` | `0.94` | `256` | `32768` | Promote only if no preemption churn |
| `mtp-128k` | `131072` | `0.94` | `128` | `32768` | Add MTP flags below if tool calls stay valid |
| `context-192k` | `196608` | `0.94` | `64` | `32768` | Test after 128K is stable |
| `context-262k` | `262144` | `0.94` | `64` | `32768` | Promote only if AgentRuns stay stable |

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

Do not combine MTP, KV-cache dtype, and context increases in one rollout. Change
one variable, run the smoke suite, then run a real AnyPi AgentRun.

## Completion Criteria

- `/v1/models` returns `qwen36-flamingo`.
- Basic chat and structured tool calls work from cluster and tailnet.
- OpenWebUI defaults to `qwen36-flamingo`.
- Host Pi defaults to `qwen36-flamingo`.
- AnyPi provider defaults to `qwen36-flamingo`, 96K input context, 32K max
  output, and medium Qwen thinking against the 128K server context.
- One substantial AnyPi AgentRun produces a real code/test diff and validates.
- The benchmark table is updated with the final promoted flags.

## References

- [Unsloth Qwen3.6-35B-A3B-NVFP4](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-NVFP4)
- [vLLM tool calling](https://docs.vllm.ai/en/stable/features/tool_calling/)
- [vLLM optimization](https://docs.vllm.ai/en/stable/configuration/optimization/)
