# Pi Agent Flamingo Host Configuration

Use this when running a host-side Pi/agent harness against the Turin Blackwell
GPU pod.

## Endpoint

Use the Tailscale endpoint from the host:

```text
http://flamingo.ide-newton.ts.net/v1
```

Use the ClusterIP endpoint only from Kubernetes pods:

```text
http://flamingo.flamingo.svc.cluster.local/v1
```

## Host Environment

Set the OpenAI-compatible completion endpoint and model. Keep both base-url
aliases if the local harness supports either spelling.

```bash
export OPENAI_API_BASE_URL=http://flamingo.ide-newton.ts.net/v1
export OPENAI_BASE_URL=http://flamingo.ide-newton.ts.net/v1
export OPENAI_API_KEY=flamingo-local
export OPENAI_COMPLETION_MODEL=qwen3-coder-flamingo
export OPENAI_MODEL=qwen3-coder-flamingo
```

Do not move embeddings to Flamingo in this step. If the harness uses embedding
configuration, keep it on Saigak:

```bash
export OPENAI_EMBEDDING_API_BASE_URL=http://saigak.saigak.svc.cluster.local:11434/v1
export OPENAI_EMBEDDING_MODEL=qwen3-embedding-saigak:8b
```

## Smoke

Run these from the host before pointing long-running agents at the model:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/models

curl -fsS http://flamingo.ide-newton.ts.net/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-coder-flamingo","messages":[{"role":"user","content":"Reply with exactly: flamingo-ready"}],"max_tokens":16,"temperature":0}'
```

Tool-call smoke:

```bash
curl -fsS http://flamingo.ide-newton.ts.net/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3-coder-flamingo",
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
  }'
```

Expected tool-call result:

```json
{"name":"add","arguments":"{\"a\": 7, \"b\": 35}"}
```

## Rollback

For completion rollback to Saigak/Jangar-compatible routing:

```bash
export OPENAI_API_BASE_URL=http://saigak.saigak.svc.cluster.local:11434/v1
export OPENAI_BASE_URL=http://saigak.saigak.svc.cluster.local:11434/v1
export OPENAI_COMPLETION_MODEL=qwen3-main-saigak:30b-a3b
export OPENAI_MODEL=qwen3-main-saigak:30b-a3b
```

Rollback if Flamingo is not reachable, tool calls are not structured, or the
GPU pod is restarting under agent load.
