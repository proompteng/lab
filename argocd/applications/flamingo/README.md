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

## Rollout Evidence

Recorded on 2026-06-16 after syncing the merged GitOps revisions.

KubeVirt:

- `virt-handler-cmn8v` is `1/1 Running` on `turin`.
- `turin` has `kubevirt.io/schedulable=true`.
- Existing `saigak` and `openclaw` VMIs remained `Running`.
- A temporary `turin-kubevirt-canary` VMI pinned to `turin` reached `Running`
  and was deleted after the check.

Storage:

- `rook-ceph.rbd.csi.ceph.com` and `rook-ceph.cephfs.csi.ceph.com` are both
  registered on `CSINode/turin`.
- The `flamingo-model-cache` PVC is bound to `rook-ceph-block` and attached on
  `turin`.
- The wider Ceph cluster remained in recovery during this rollout; no Ceph OSD,
  CRUSH, or Talos storage mutation was performed for Flamingo.

Flamingo:

- Argo CD app `flamingo` is `Synced` and `Healthy`.
- Pod `flamingo-bbb64fd75-sdmr6` is `1/1 Running` on `turin`.
- Final launch flags include:

```text
--max-model-len 32768 --gpu-memory-utilization 0.92 --max-num-seqs 256 --enable-prefix-caching --tool-call-parser qwen3_coder
```

- `/v1/models` works through both
  `http://flamingo.flamingo.svc.cluster.local/v1` and
  `http://flamingo.ide-newton.ts.net/v1`.
- Cluster-local chat smoke returned `cluster-ready`.
- Tailnet chat smoke returned `flamingo-ready` with HTTP `200`.
- Tailnet tool-call smoke returned a structured `add` function call with
  arguments `{"a": 7, "b": 35}`.
- `nvidia-smi` while idle after load reported
  `90458 MiB / 97887 MiB`, `49 C`, and `15.30 W`.
- vLLM reported `406,910` GPU KV-cache tokens and `12.42x` maximum concurrency
  for 32,768-token requests.

OpenWebUI:

- OpenWebUI is configured with Flamingo first in `OPENAI_API_BASE_URLS` and the
  Jangar gateway second as a rollback path.
- `DEFAULT_MODELS` is `qwen3-coder-flamingo`.
- `ENABLE_OLLAMA_API=true` keeps Saigak's Ollama endpoint available separately.
- Playwright UI smoke loaded `http://openwebui.ide-newton.ts.net`, observed
  selected model `qwen3-coder-flamingo`, submitted `Respond with exactly:
  openwebui-flamingo-ready`, and the page rendered `openwebui-flamingo-ready`.
- The captured OpenWebUI request used `POST /api/chat/completions` with
  `"model":"qwen3-coder-flamingo"` and upstream `urlIdx: 0`.
- Flamingo logs showed OpenWebUI pod IP `10.244.5.2` calling
  `GET /v1/models` and `POST /v1/chat/completions` with HTTP `200`.

Pi host harness:

- Host-side `pi` smoke used an isolated temporary `PI_CODING_AGENT_DIR` with a
  `flamingo` OpenAI-compatible provider pointed at
  `http://flamingo.ide-newton.ts.net/v1`.
- `pi --provider flamingo --model qwen3-coder-flamingo --no-tools --no-session
  -p "Reply with exactly: pi-flamingo-ready"` returned `pi-flamingo-ready`.

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

Current logs show vLLM using the default MoE config for this Blackwell SKU:

```text
Using default MoE config. Performance might be sub-optimal!
```

Treat a tuned MoE config as the next optimization change after this stable
serving rollout. Do not combine MoE tuning with another memory/context increase.

Round 4: fallback comparison.

Switch the model to `Qwen/Qwen3-Coder-30B-A3B-Instruct`, keep the served name
`qwen3-coder-flamingo`, and repeat the same benchmark set. Keep Next-FP8 unless
30B-A3B is materially more stable or faster for coding-agent tool workloads.
