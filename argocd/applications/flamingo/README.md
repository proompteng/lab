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

The model weights are NVFP4, but the KV cache uses FP8. Live rollout proved that
`--kv-cache-dtype nvfp4` fails on this Blackwell Max-Q card with
`requires sm100f`; do not retry NVFP4 KV unless the vLLM/image/GPU capability
combination changes and is proven in a separate smoke.

Safetensors eager loading remains a candidate, not a production default. The
model cache is RBD-backed but appears to vLLM as local EXT4, and earlier rollout
work showed lazy checkpoint loading can block for about 12 minutes in disk I/O
before the HTTP server starts. The July 3, 2026 DBO/eager candidate also
crash-looped, so isolate `--safetensors-load-strategy eager` in its own rollout
before promoting it.

The active reasoning parser is `qwen3`, so reasoning text is returned through
the OpenAI-compatible reasoning field instead of being mixed into normal
assistant content. The active tool parser is `qwen3_coder`, which is the vLLM
Qwen3.5/Qwen3.6 recipe recommendation for automatic tool calling.
Reference: <https://docs.vllm.ai/projects/recipes/en/latest/Qwen/Qwen3.5.html>

## Host CPU and Memory Sizing

The Deployment requests `4` CPU cores and `32Gi` of regular host RAM, with
limits of `8` cores and `40Gi`. These values do not reserve GPU VRAM;
`nvidia.com/gpu: 1` and `--gpu-memory-utilization` govern the GPU allocation and
vLLM's VRAM target. The production `--max-model-len 262144` profile is an
invariant and was not reduced during host-resource tuning.

The July 12, 2026 tuning run used isolated per-run prefix-cache salts and the
full benchmark profile: concurrency through 16, 4K/32K/128K scheduler cells,
and uncached 180K/220K/229K input probes with the configured 32K output budget.

- The `16/64` CPU control and `4/8` candidate produced equivalent scheduler
  throughput, TTFT, and TPOT within run-to-run noise.
- The `2/4` CPU candidate increased mean and p99 TTFT for the 32K scheduler cell
  by about 12% and 14%, respectively, so it was rejected.
- vLLM reported a `24.67 GiB` checkpoint. The container's measured host-memory
  peak was `31.65 GiB`: about `25 GiB` file-backed checkpoint cache and about
  `5 GiB` anonymous runtime memory.
- At `32Gi` requested and `40Gi` limited, the full profile completed with zero
  reclaim scans, working-set refaults, limit hits, OOMs, request errors,
  request aborts, or preemptions.

Cold-start validation completed on July 13, 2026 UTC. The vLLM container
restarted under the candidate cgroups, loaded all six checkpoint shards, and
became ready in about two minutes. Startup confirmed `max model len 262144`, a
`24.67 GiB` checkpoint, `23.23 GiB` of GPU model memory, and zero host-memory
limit or OOM events. The fully salted post-cold profile then matched the
original-resource control:

| Metric | `16/64` CPU, `128/256Gi` control | `4/8` CPU, `32/40Gi` candidate |
| --- | ---: | ---: |
| Prompt tokens/s | `4930.81` | `4904.96` |
| Generation tokens/s | `136.84` | `134.90` |
| 229K uncached probe | `37.338s` | `37.366s` |
| 4K scheduler output tokens/s | `565.82` | `567.77` |
| 32K scheduler output tokens/s | `270.95` | `287.56` |
| 128K scheduler output tokens/s | `34.91` | `35.19` |

The post-cold run had zero failed smokes, warmups, benchmarks, or gates, and
zero request errors, aborts, preemptions, memory-limit hits, reclaim scans, or
working-set refaults.

The `32Gi` request covers the measured working-set peak after GiB rounding; the
`40Gi` limit leaves more than 20% burst headroom. Kubernetes memory metrics
include active file cache, so do not interpret the full working set as vLLM
heap.

Revalidate this budget after changing the model, image, checkpoint loading
strategy, context/concurrency profile, or `/dev/shm` size. The required gate is
a cold model load followed by the same fully salted full-context benchmark,
without an OOM kill, restart loop, sustained throttling regression, or
checkpoint-cache thrash.

Do not enable concurrent partial prefill or DBO directly in this production
profile on the pinned vLLM image. The July 3, 2026 rollout with
`--max-num-partial-prefills 2` failed before engine startup with
`NotImplementedError: Concurrent Partial Prefill is not supported`. The
follow-up DBO/eager-only rollout also crash-looped. Keep those flags as isolated
shadow candidates until a newer vLLM image or single-variable rollout proves
support for this model/configuration.

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
bun run flamingo:benchmark --profile=smoke --candidate-id=baseline-live --fail-on-gate
bun run flamingo:benchmark --profile=full --candidate-id=<candidate> --baseline-result=<baseline.json> --long-targets=180000,220000,229000 --fail-on-gate
```

The runner assigns a distinct 256-bit `cache_salt` to each run and records it
in the result. This prevents a previous candidate's prefix cache from making a
later candidate appear faster while preserving within-run prefix-cache tests.

Do not run the `full` profile against production while Saigak is still resident
on Turin. On July 3, 2026, `full` reached `warmup-c16` and the vLLM engine died
with CUDA OOM in the FlashInfer fused-MoE path after only about `593 MiB` was
free on the physical Blackwell. Run `smoke` first, move Saigak off Blackwell,
then use `full` as the promotion gate for one candidate at a time.

`candidate-profiles.yaml` is the rendered GitOps source for safe rollout
profiles. It is a no-traffic ConfigMap, not a second model server, so Argo can
carry the policy without allocating another Blackwell GPU or changing the
production route.

| Profile | Context | `gpu_memory_utilization` | `max_num_seqs` | `max_num_batched_tokens` | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `baseline-131k` | `131072` | `0.94` | `128` | `16384` | Pre-optimization baseline only |
| `context-262k-fp8` | `262144` | `0.85` | `16` | `16384` | Current production baseline |
| `eager-262k` | `262144` | `0.85` | `16` | `16384` | Test `--safetensors-load-strategy eager` alone before promotion |
| `image-lane` | `262144` | `0.85` | `16` | `16384` | New official stable vLLM CUDA digest with current flags first |
| `batch-262k-24k` | `262144` | `0.88` | `24` | `24576` | Test only after Saigak leaves Turin |
| `batch-262k-32k` | `262144` | `0.90` | `32` | `32768` | Promote only if TTFT, KV usage, and Plex remain acceptable |
| `mtp-262k-n1..4` | `262144` | `0.85` | `16` | `16384` | One MTP value per rollout; compare real acceptance length |

### Recorded Live Optimization Run

Run date: `2026-07-03`.

Live precondition fixed first:

- `saigak` had drifted onto `turin` with a `nvidia.com/gpu` request while its
  PVC was local-path storage selected on `turin`.
- The safe live/GitOps correction is CPU-only `saigak` on `turin` until a real
  Altra 3090 storage migration exists.
- After the correction, the only GPU consumers were `flamingo` and Plex, and
  `saigak` still returned `4096`-dimension embeddings while blocking chat
  completions.

Fresh post-deconflict baseline artifacts:

| Artifact | Result |
| --- | --- |
| `/tmp/flamingo-real-opt-candidates/flamingo-baseline-deconflicted-smoke-2026-07-03T21-59-10-261Z.json` | `0` failed gates, `129.41` gen tok/s, `0` errors/aborts/preemptions |
| `/tmp/flamingo-real-opt-candidates/flamingo-baseline-deconflicted-full-2026-07-03T21-59-58-481Z.json` | `0` failed gates, `133.21` gen tok/s, `1,620,474` prompt tokens, `0` errors/aborts/preemptions |

Measured candidate outcomes on the same deployed model/image:

| Candidate | Live change | Artifact | Decision |
| --- | --- | --- | --- |
| `batch24576` | `--max-num-batched-tokens 24576` | `/tmp/flamingo-real-opt-candidates/flamingo-batch24576-smoke-2026-07-03T22-11-29-828Z.json` | Rejected: output throughput and p99 TTFT gates failed |
| `gmem086` | `--gpu-memory-utilization 0.86` | `/tmp/flamingo-real-opt-candidates/flamingo-gmem086-smoke-2026-07-03T22-16-12-023Z.json` | Rejected: KV capacity improved, but throughput and p99 TTFT gates failed |
| `mtp1-prefix-off` | `--no-enable-prefix-caching --speculative-config {"method":"mtp","num_speculative_tokens":1}` | `/tmp/flamingo-real-opt-candidates/flamingo-mtp1-prefix-off-mtp-al-2026-07-03T22-30-05-021Z.json` and `/tmp/flamingo-real-opt-candidates/flamingo-mtp1-prefix-off-smoke-2026-07-03T22-30-59-838Z.json` | Rejected: real AL was about `1.80`, but smoke throughput, p99 TTFT, and TPOT gates failed |
| `language-model-only-warm` | `--language-model-only` | `/tmp/flamingo-real-opt-candidates/flamingo-language-model-only-warm-smoke-2026-07-03T22-36-36-387Z.json` | Rejected as a performance promotion: quality gates passed, but throughput did not beat baseline threshold |
| `cudagraph-estimate-off-warm` | `VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS=0` | `/tmp/flamingo-real-opt-candidates/flamingo-cudagraph-estimate-off-warm-smoke-2026-07-03T22-43-00-169Z.json` | Rejected: larger KV cache did not improve throughput, and vLLM warned about unaccounted CUDA graph memory/OOM risk |

Final live state was restored to `baseline.args` and smoke-tested:
`/tmp/flamingo-real-opt-candidates/flamingo-baseline-restored-smoke-2026-07-03T22-50-51-537Z.json`
with `0` failed gates and `0` request errors/aborts/preemptions.

No vLLM launch-flag candidate was promoted from this run. The production
optimization that passed end-to-end is the Blackwell resource deconflict:
Saigak no longer consumes the physical Blackwell GPU, allowing the current
Qwen3.6 baseline to pass the full 262K profile that previously OOMed.

The default `full` benchmark profile now covers the InferenceX-inspired
serving shapes:

- warmups at concurrency `1/2/4/8/16` plus a long-prefill warmup;
- scheduler profile `4K` input / `512` output;
- scheduler profile `32K` input / `4K` output;
- scheduler profile `128K` input / `512` output;
- long-context recall at `180K`, `220K`, and `229K` when the default full
  target set is used.

`--profile=mtp-al` adds Qwen chat-template thinking-on/off MTP acceptance
cells. It only measures the deployed `--speculative-config`; synthetic
acceptance is not a production gate.

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

Do not combine MTP, KV-cache dtype, batching, memory, DBO, or concurrent partial
prefill changes after the initial 262K candidate. Change one variable, run the
smoke suite, then run a real AnyPi AgentRun.

Do not re-enable `--enable-dbo` in the single-GPU production profile. Do not
re-enable `--max-num-partial-prefills > 1` until the upgraded vLLM image proves
support in a canary startup and smoke. True prefill/decode disaggregation is a
separate `flamingo-pd-shadow` design that requires at least two physical free
GPUs after Plex preservation; time-sliced replicas are not enough.

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
