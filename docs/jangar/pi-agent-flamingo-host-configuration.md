# Pi Agent Flamingo Host Configuration

Use this when running a host-side Pi or agent harness against the Turin
Blackwell GPU pod.

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
export OPENAI_COMPLETION_MODEL=qwen36-flamingo
export OPENAI_MODEL=qwen36-flamingo
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
  -d '{"model":"qwen36-flamingo","messages":[{"role":"user","content":"Reply with exactly: flamingo-ready"}],"max_tokens":16,"temperature":0}'
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
  }'
```

Expected tool-call result:

```json
{ "name": "add", "arguments": "{\"a\": 7, \"b\": 35}" }
```

## Client Context Budget

Keep Pi's `models.json` budget below the vLLM server context. The current
production target is 128K server context.

| vLLM `--max-model-len` | Pi `contextWindow` | Pi `maxTokens` | Status    |
| ---------------------- | -----------------: | -------------: | --------- |
| `131072`               |            `98304` |        `32768` | Current   |
| `196608`               |           `163840` |        `32768` | Candidate |
| `262144`               |           `229376` |        `32768` | Candidate |

Compaction must stay explicit in `settings.json` for Flamingo host runs:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

## Required Local Pi Customization

Pi needs a local provider entry because Flamingo is a private OpenAI-compatible
endpoint, not a built-in Pi model. Keep this customization minimal:

- required: one `flamingo` provider in `~/.pi/agent/models.json`
- required: default Pi model set to `qwen36-flamingo`
- required: Qwen chat-template thinking compatibility
- required: explicit compaction settings in `~/.pi/agent/settings.json`
- not required: custom Pi code, extra provider plugins, model aliases, or moving
  embeddings off Saigak

For this host, the permanent local Pi config should look like this:

```json
{
  "providers": {
    "flamingo": {
      "baseUrl": "http://flamingo.ide-newton.ts.net/v1",
      "api": "openai-completions",
      "apiKey": "flamingo-local",
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
          "name": "Qwen3.6 Flamingo",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 98304,
          "maxTokens": 32768,
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
```

`~/.pi/agent/settings.json` should keep Flamingo as the default and enable
medium thinking:

```json
{
  "defaultProvider": "flamingo",
  "defaultModel": "qwen36-flamingo",
  "defaultThinkingLevel": "medium",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

Verify the actual host config before a long run:

```bash
jq '{defaultProvider, defaultModel, defaultThinkingLevel, compaction}' ~/.pi/agent/settings.json

jq '.providers | with_entries(.value |= {
  baseUrl,
  api,
  compat,
  models: [.models[] | {id, contextWindow, maxTokens, reasoning, input}]
})' ~/.pi/agent/models.json

PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
pi --no-tools --no-session \
  -p "Reply with exactly: host-pi-flamingo-ready"
```

The smoke should return:

```text
host-pi-flamingo-ready
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
  "defaultModel": "qwen36-flamingo",
  "defaultThinkingLevel": "medium",
  "quietStartup": true,
  "enableInstallTelemetry": false,
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
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
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens",
        "thinkingFormat": "qwen-chat-template"
      },
      "models": [
        {
          "id": "qwen36-flamingo",
          "name": "Qwen3.6 Flamingo",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 98304,
          "maxTokens": 32768,
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
  --model qwen36-flamingo \
  --no-tools \
  --no-session \
  -p "Reply with exactly: pi-flamingo-ready"
```

Expected output:

```text
pi-flamingo-ready
```

## Pi Compaction Gate

Run the repo-local gate from the Mac host before using Flamingo for long Pi
sessions. It writes temporary `settings.json`, `models.json`, and session files,
then proves a follow-up turn can use a compaction summary without falling back to
overflow recovery.

```bash
bun run scripts/jangar/validate-pi-flamingo-compaction.ts
```

## Failure Handling

Do not restore an old model alias in host Pi config. If Flamingo is not
reachable, tool calls are not structured, or the GPU pod is restarting under
agent load, fix the Flamingo serving profile or switch the Flamingo server
runtime for the same Qwen3.6 model.
