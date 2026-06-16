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

## Pi Binary Smoke

The host `pi` binary supports custom OpenAI-compatible providers through
`models.json`. For a no-mutation smoke, create a temporary Pi config directory
instead of editing `~/.pi/agent`.

```bash
PI_TMP_DIR="$(mktemp -d /tmp/pi-flamingo-smoke.XXXXXX)"

cat > "$PI_TMP_DIR/settings.json" <<'JSON'
{
  "defaultProvider": "flamingo",
  "defaultModel": "qwen3-coder-flamingo",
  "defaultThinkingLevel": "off",
  "quietStartup": true,
  "enableInstallTelemetry": false
}
JSON

cat > "$PI_TMP_DIR/models.json" <<'JSON'
{
  "providers": {
    "flamingo": {
      "baseUrl": "http://flamingo.ide-newton.ts.net/v1",
      "api": "openai-completions",
      "apiKey": "flamingo-local",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "qwen3-coder-flamingo",
          "name": "Qwen3 Coder Flamingo",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 4096,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
JSON

PI_CODING_AGENT_DIR="$PI_TMP_DIR" \
PI_SKIP_VERSION_CHECK=1 \
PI_TELEMETRY=0 \
pi --provider flamingo \
  --model qwen3-coder-flamingo \
  --no-tools \
  --no-session \
  -p "Reply with exactly: pi-flamingo-ready"
```

Expected output:

```text
pi-flamingo-ready
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
