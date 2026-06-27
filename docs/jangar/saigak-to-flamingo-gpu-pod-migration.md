# Saigak To Flamingo GPU Pod Migration

This runbook records the hard migration where completion traffic moves to the
`flamingo` Kubernetes GPU pod and `saigak` becomes embeddings-only on the RTX
3090.

## Current Roles

`saigak` is a Kubernetes `StatefulSet` pinned to `talos-192-168-1-85`. It serves
Ollama through an embeddings-only proxy on port `11434` and must not expose chat
completion endpoints.

`flamingo` is a normal Kubernetes Deployment pinned to Turin's Blackwell GPU. It
serves a vLLM OpenAI-compatible API on:

```text
http://flamingo.flamingo.svc.cluster.local/v1
http://flamingo.ide-newton.ts.net/v1
```

The served completion model name is:

```text
qwen36-flamingo
```

## Embedding Contract

Keep embedding traffic on `saigak` with the existing 4096-dimensional model:

```text
OPENAI_EMBEDDING_API_BASE_URL=http://saigak.saigak.svc.cluster.local:11434/v1
OPENAI_EMBEDDING_MODEL=qwen3-embedding-saigak:8b
OPENAI_EMBEDDING_DIMENSION=4096
```

## Completion Migration Order

Move one consumer at a time after Flamingo itself is healthy:

1. Host-side Pi harness.
2. Jangar/OpenWebUI completion traffic.
3. Agents service canary.
4. Bumba completion traffic.
5. Torghut or other production workflows only after benchmark and tool-call
   evidence is stable.

Do not migrate multiple consumers in the same commit unless they are all passive
default-model references to the same already-healthy endpoint.

## Host-Side Pi Harness

Configure the harness to use the OpenAI-compatible endpoint:

```text
OPENAI_API_BASE_URL=http://flamingo.ide-newton.ts.net/v1
OPENAI_BASE_URL=http://flamingo.ide-newton.ts.net/v1
OPENAI_COMPLETION_MODEL=qwen36-flamingo
OPENAI_MODEL=qwen36-flamingo
OPENAI_API_KEY=flamingo-local
```

Do not point embedding settings at Flamingo.

Smoke:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/models
curl -fsS http://flamingo.ide-newton.ts.net/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen36-flamingo","messages":[{"role":"user","content":"Return only ready."}],"max_tokens":8,"temperature":0}'
```

## In-Cluster Consumers

Use the ClusterIP URL:

```text
OPENAI_API_BASE_URL=http://flamingo.flamingo.svc.cluster.local/v1
OPENAI_COMPLETION_MODEL=qwen36-flamingo
```

Keep embedding variables pointed at `saigak`.

For apps that use one base URL for both completions and embeddings, first split
completion and embedding configuration in that app. Do not point embedding calls
at Flamingo until the embedding migration exists.

## OpenWebUI

OpenWebUI is an in-cluster UI consumer for Flamingo. The GitOps values keep
Flamingo first and the Jangar gateway second as a separate hosted-model path:

```text
OPENAI_API_BASE_URLS=http://flamingo.flamingo.svc.cluster.local/v1;http://jangar.jangar.svc.cluster.local/openai/v1
OPENAI_API_KEYS=;
DEFAULT_MODELS=qwen36-flamingo
ENABLE_OLLAMA_API=false
```

Validation:

```bash
argocd --core app sync jangar --timeout 900
kubectl -n jangar rollout status statefulset/open-webui --timeout=10m
kubectl -n jangar exec open-webui-0 -- printenv OPENAI_API_BASE_URLS DEFAULT_MODELS ENABLE_OLLAMA_API
```

## Failure Handling

This is a hard completion migration. Do not restore old Flamingo model aliases
as normal desired state. If the Qwen3.6 endpoint fails:

- fix the vLLM serving profile,
- reduce concurrency before reducing context,
- test the documented MTP/KV-cache profiles one at a time,
- or switch Flamingo to SGLang for the same model and service contract.

Keep Saigak serving embeddings while completion serving is repaired. Do not
restore the retired Saigak completion model as desired state.

## Validation Per Consumer

For each migrated consumer, record:

- Commit or config change.
- Base URL and model name.
- Prompt used for smoke.
- Whether tool calls parsed successfully.
- First-token latency and end-to-end latency.
- Any failure-handling command used.

For Kubernetes consumers:

```bash
kubectl -n <namespace> rollout status deploy/<deployment> --timeout=10m
kubectl -n <namespace> logs deploy/<deployment> --tail=200 | rg -i 'flamingo|qwen36|error|tool'
```

For host-side consumers:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/models
```

## Saigak Completion Decommission Criteria

Do not treat completion migration as complete until all of these are true:

- No completion consumer depends on Saigak's Ollama model store.
- OpenWebUI, Jangar, Bumba, Agents, Torghut, and Synthesis configs have been audited.
- Saigak rejects `/v1/chat/completions` and `/api/generate`.
- Saigak `/v1/embeddings` returns 4096 dimensions and `/api/ps` shows GPU VRAM residency.
- A stability window has passed with Flamingo stable under normal agent load.
