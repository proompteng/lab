# Flamingo

`flamingo` is the Turin Blackwell GPU model-serving application for coding
agents. It is a normal Kubernetes Deployment, not a KubeVirt VM.

## Production Target

- Node: `turin`
- GPU: one physical `NVIDIA RTX PRO 6000 Blackwell Max-Q`; the device plugin may expose time-sliced `nvidia.com/gpu` replicas.
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
--gpu-memory-utilization 0.85
--kv-cache-dtype fp8
--safetensors-load-strategy eager
--max-num-seqs 16
--max-num-batched-tokens 16384
--max-num-partial-prefills 2
--max-long-partial-prefills 1
--long-prefill-token-threshold 8192
--enable-dbo
--dbo-decode-token-threshold 32
--dbo-prefill-token-threshold 512
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

The model weights are NVFP4, but the KV cache uses FP8. Live rollout proved that
`--kv-cache-dtype nvfp4` fails on this Blackwell Max-Q card with
`requires sm100f`; do not retry NVFP4 KV unless the vLLM/image/GPU capability
combination changes and is proven in a separate smoke.

Safetensors eager loading is forced because the model cache is RBD-backed but
appears to vLLM as local EXT4. Live rollout proved lazy checkpoint loading can
block for about 12 minutes in disk I/O before the HTTP server starts, and
`--safetensors-load-strategy prefetch` was slower than the lazy baseline on the
single 23 GiB shard. `eager` uses a different vLLM loader path that reads the
whole shard into RAM before yielding tensors.

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

- `nvidia.com/gpu` allocatable is non-zero.
- `flamingo` and the approved Plex transcode workload are the only expected
  Blackwell GPU consumers before tuning.
- `saigak` is not consuming a Turin/Blackwell GPU slot; it must remain the
  separate embeddings path.
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
    "messages": [{"role": "user", "content": "Use the lookup_status tool for id FLAMINGO-262K and no other tool."}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "lookup_status",
        "description": "Look up rollout status by id.",
        "strict": true,
        "parameters": {
          "type": "object",
          "properties": {
            "id": {"type": "string"}
          },
          "required": ["id"],
          "additionalProperties": false
        }
      }
    }],
    "tool_choice": "auto",
    "chat_template_kwargs": {"enable_thinking": false},
    "max_tokens": 128,
    "temperature": 0
  }' | jq '.choices[0].message.tool_calls'
```

Expected: `tool_calls` is a non-empty array and arguments include
`{"id":"FLAMINGO-262K"}`. If this returns only prose or raw XML, do not accept
the rollout; fix the generic vLLM serving flags or image first.

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
prompt/output token counts, TTFT, TPOT, output tokens per second, KV-cache usage,
prefix-cache hits, request wait/running gauges, GPU memory, GPU power draw,
temperature, and any OOM, parser, HTTP, or preemption failure.

Use the repo runner so output is comparable:

```bash
bun run flamingo:benchmark --profile=smoke
bun run flamingo:benchmark --profile=full --long-targets=180000,220000,229000
```

| Profile | Context | `gpu_memory_utilization` | `max_num_seqs` | `max_num_batched_tokens` | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `baseline-131k` | `131072` | `0.94` | `128` | `16384` | Pre-optimization baseline only |
| `context-262k-fp8-eager` | `262144` | `0.85` | `16` | `16384` | Current production baseline |
| `prefill-dbo-262k` | `262144` | `0.85` | `16` | `16384` | Explicit partial-prefill + DBO profile |
| `batch-262k-24k` | `262144` | `0.88` | `24` | `24576` | Test only after Saigak leaves Turin |
| `batch-262k-32k` | `262144` | `0.90` | `32` | `32768` | Promote only if TTFT, KV usage, and Plex remain acceptable |
| `mtp-262k-n1..4` | `262144` | `0.85` | `16` | `16384` | One MTP value per rollout; compare real acceptance length |

The default `full` benchmark profile now covers the InferenceX-inspired
serving shapes:

- warmups at concurrency `1/2/4/8/16` plus a long-prefill warmup;
- scheduler profile `4K` input / `512` output;
- scheduler profile `32K` input / `4K` output;
- scheduler profile `128K` input / `512` output;
- long-context recall at `180K`, `220K`, and `229K` when the default full
  target set is used.

### InferenceX Methodology Adaptation

InferenceX Qwen3.5 work is not copied flag-for-flag because it benchmarks a
different model scale and hardware topology. The reusable parts are:

- Qwen-specific reasoning and tool parsers stay active during every benchmark.
- Thinking mode is controlled through Qwen chat-template kwargs, not generic
  prose prompts.
- Throughput is judged on coding-agent-like prompt/output shapes, not only tiny
  random-token requests.
- Speculative decoding is measured by accepted-token and draft counters:
  `AL = 1 + accepted_draft_tokens / verification_drafts`.
- Synthetic acceptance is benchmark-only and must not be used as a production
  quality shortcut.

### Recorded Production Run

Run timestamp: `2026-06-27T22:37:01Z`.

Result artifact:
`/tmp/flamingo-vllm-long-20260627T223701Z/flamingo-smoke-2026-06-27T22-37-01-725Z.json`.

Launch profile:

```text
--max-model-len 262144
--gpu-memory-utilization 0.95
--kv-cache-dtype fp8
--safetensors-load-strategy eager
--max-num-seqs 16
--max-num-batched-tokens 16384
```

Observed startup:

- Lazy baseline loaded the single 23 GiB safetensors shard in `718.30s`.
- Forced prefetch did not complete the same shard after more than `16m`.
- Eager loading completed the shard in `26.08s` and full server startup in about
  `3m16s`.
- vLLM reported `65.38 GiB` available KV cache and `24.77x` maximum concurrency
  for 262,144-token requests.

Acceptance smokes:

| Check | Result |
| --- | --- |
| `/v1/models` | `qwen36-flamingo`, `max_model_len=262144` |
| Exact no-thinking chat | `qwen36-ready`, `80ms` |
| Medium thinking chat | `qwen36-thinking-ready`, `3973ms`, `745` completion tokens |
| Structured tool call | `lookup_status({"id":"FLAMINGO-262K"})`, `280ms` |
| Long-context recall | `220053` prompt tokens, `flamingo-long-220000`, `34389ms` |

Short coding-loop smoke benchmark:

| Metric | Value |
| --- | ---: |
| Prompts | `4` |
| Max concurrency | `2` |
| Total input tokens | `16427` |
| Total output tokens | `2048` |
| Mean TTFT | `220.86 ms` |
| p99 TTFT | `240.96 ms` |
| Output throughput | `294.09 tok/s` |
| Total token throughput | `2652.96 tok/s` |
| Mean TPOT | `6.38 ms` |
| Failed requests | `0` |

MTP candidate flags, tested one value at a time:

```text
--speculative-config {"method":"mtp","num_speculative_tokens":1}
--speculative-config {"method":"mtp","num_speculative_tokens":2}
--speculative-config {"method":"mtp","num_speculative_tokens":3}
--speculative-config {"method":"mtp","num_speculative_tokens":4}
```

Promote MTP only when all of these hold in the benchmark artifact:

- exact no-thinking, medium thinking, structured tool call, prefix-cache repeat,
  and long-context recall pass;
- `speculativeDecode.metricDelta.speculativeAcceptanceLength` is present;
- output throughput improves by at least `15%` against the same non-MTP profile;
- p99 TTFT regresses by no more than `10%`;
- a real AnyPi-style repo task still completes with a code/test diff.

KV-cache candidates must be checked against the pinned vLLM image before use:

```text
--kv-cache-dtype fp8
--kv-cache-dtype auto
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
