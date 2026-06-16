# Saigak To Flamingo GPU Pod Migration

This runbook migrates completion traffic from the `saigak` KubeVirt VM to the
`flamingo` Kubernetes GPU pod. It does not migrate embeddings.

## Current Roles

`saigak` is a KubeVirt `VirtualMachine` pinned to `talos-192-168-1-85`. It serves
Ollama on port `11434` and backs several existing consumers.

`flamingo` is a normal Kubernetes Deployment pinned to Turin's Blackwell GPU. It
serves a vLLM OpenAI-compatible API on:

```text
http://flamingo.flamingo.svc.cluster.local/v1
http://flamingo.ide-newton.ts.net/v1
```

The first served model name is:

```text
qwen3-coder-flamingo
```

## Do Not Move Embeddings Yet

Keep embedding traffic on `saigak` until a separate embedding migration handles
model choice, dimensions, index rebuilds, and database compatibility.

Keep these values unchanged during this migration:

```text
OPENAI_EMBEDDING_API_BASE_URL=http://saigak.saigak.svc.cluster.local:11434/v1
OPENAI_EMBEDDING_MODEL=qwen3-embedding-saigak:8b
```

## Completion Migration Order

Move one consumer at a time, starting with the lowest-risk host-side harness.

1. Host-side pi harness.
2. Jangar/OpenWebUI completion traffic.
3. Agents service canary.
4. Bumba completion traffic.
5. Torghut or other production workflows only after benchmark and tool-call
   evidence is stable.

Do not migrate multiple consumers in the same commit or rollout.

## Host-Side Pi Harness

Configure the harness to use the OpenAI-compatible endpoint:

```text
OPENAI_API_BASE_URL=http://flamingo.ide-newton.ts.net/v1
OPENAI_BASE_URL=http://flamingo.ide-newton.ts.net/v1
OPENAI_COMPLETION_MODEL=qwen3-coder-flamingo
OPENAI_MODEL=qwen3-coder-flamingo
```

If the harness has a separate API key setting, use a local dummy value. vLLM does
not require a real key on this endpoint, but many OpenAI-compatible clients
refuse an empty one:

```text
OPENAI_API_KEY=flamingo-local
```

Do not point embedding settings at Flamingo. If the host has embedding variables,
leave them on `saigak` until the embedding migration is designed.

Smoke:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/models
curl -fsS http://flamingo.ide-newton.ts.net/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-coder-flamingo","messages":[{"role":"user","content":"Return only ready."}],"max_tokens":8}'
```

## In-Cluster Consumers

Use the ClusterIP URL:

```text
OPENAI_API_BASE_URL=http://flamingo.flamingo.svc.cluster.local/v1
OPENAI_COMPLETION_MODEL=qwen3-coder-flamingo
```

Keep embedding variables pointed at `saigak`.

For apps that use one base URL for both completions and embeddings, first split
completion and embedding configuration in that app. Do not point embedding calls
at Flamingo until the embedding migration exists.

## OpenWebUI

OpenWebUI is the first in-cluster UI consumer migrated to Flamingo. The GitOps
values keep Flamingo first and the Jangar gateway second:

```text
OPENAI_API_BASE_URLS=http://flamingo.flamingo.svc.cluster.local/v1;http://jangar.jangar.svc.cluster.local/openai/v1
OPENAI_API_KEYS=;
DEFAULT_MODELS=qwen3-coder-flamingo
ENABLE_OLLAMA_API=true
OLLAMA_BASE_URLS=http://saigak.saigak.svc.cluster.local:11434
```

Validation:

```bash
argocd --core app sync jangar --timeout 900
kubectl -n jangar rollout status statefulset/open-webui --timeout=10m
kubectl -n jangar exec open-webui-0 -- printenv OPENAI_API_BASE_URLS DEFAULT_MODELS OLLAMA_BASE_URLS
```

Rollback by restoring:

```text
OPENAI_API_BASE_URL=http://jangar.jangar.svc.cluster.local/openai/v1
DEFAULT_MODELS=gpt-5.5
```

## Rollback Values

Rollback completion traffic to `saigak` with:

```text
OPENAI_API_BASE_URL=http://saigak.saigak.svc.cluster.local:11434/v1
OPENAI_COMPLETION_MODEL=qwen3-main-saigak:30b-a3b
```

Keep embedding rollback values as:

```text
OPENAI_EMBEDDING_API_BASE_URL=http://saigak.saigak.svc.cluster.local:11434/v1
OPENAI_EMBEDDING_MODEL=qwen3-embedding-saigak:8b
```

Rollback criteria:

- Flamingo pod restarts repeatedly.
- `/v1/models` or `/v1/chat/completions` fails.
- Tool-call responses are not parseable by the consumer.
- GPU memory, power, or thermal behavior is unstable under expected concurrency.
- Completion latency regresses enough to block agent workflows.

## Validation Per Consumer

For each migrated consumer, record:

- Commit or config change.
- Base URL and model name.
- Prompt used for smoke.
- Whether tool calls parsed successfully.
- First-token latency and end-to-end latency.
- Any rollback command used.

For Kubernetes consumers:

```bash
kubectl -n <namespace> rollout status deploy/<deployment> --timeout=10m
kubectl -n <namespace> logs deploy/<deployment> --tail=200 | rg -i 'flamingo|qwen3-coder|error|tool'
```

For host-side consumers:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/models
```

## Saigak Decommission Criteria

Do not decommission `saigak` until all of these are true:

- No completion consumer depends on `qwen3-main-saigak:30b-a3b`.
- Embeddings have a separately validated replacement or embeddings explicitly
  remain on a smaller dedicated service.
- OpenWebUI, Jangar, Bumba, Agents, Torghut, and Synthesis configs have been
  audited.
- `saigak` PVC contents have been backed up or declared disposable.
- A rollback window has passed with Flamingo stable under normal agent load.

Until then, keep `saigak` running as the rollback and embedding service.
