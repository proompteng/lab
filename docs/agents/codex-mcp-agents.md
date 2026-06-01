# Codex Agents MCP setup

Status: Current (2026-05-31)

Docs index: [README](README.md)

## Purpose

Expose the live Agents control plane to Codex as a streamable HTTP MCP server so
Codex can create and operate cluster `AgentRun` resources without shelling out to
`kubectl` for the success path.

## Endpoint

The default operator endpoint is the Tailscale-backed Agents service:

```bash
http://agents.ide-newton.ts.net/mcp
```

The in-cluster service URL remains `http://agents.agents.svc.cluster.local`.

## Codex config

Register the streamable HTTP MCP server:

```bash
codex mcp add agents --url http://agents.ide-newton.ts.net/mcp
```

Inspect the stored config:

```bash
codex mcp get agents
```

The MCP handshake should expose server `agents-control-plane`.

## Required tools

`tools/list` must include these tools:

- `persist_memory`
- `retrieve_memory`
- `create_agent_run`
- `list_agent_runs`
- `get_agent_run`
- `list_agent_run_resources`
- `get_agent_run_logs`
- `list_agent_run_terminal_events`
- `ack_agent_run_terminal_event`
- `rerun_agent_run`

Some clients may expose a filtered subset of these tools as first-class client
tools. When debugging availability, check the MCP server directly with
`tools/list` before assuming the server is missing a tool.

## Create payload shape

`create_agent_run` accepts the same top-level payload as `POST
/v1/agent-runs`, plus the required MCP `deliveryId`. For inline runs, pass the
inline implementation body directly as `payload.implementation`; the API wraps
that object as `spec.implementation.inline`.

Correct MCP shape:

```json
{
  "deliveryId": "mcp-smoke-20260531",
  "payload": {
    "agentRef": { "name": "codex-spark-agent" },
    "implementation": {
      "text": "Verify the Agents MCP create path without making source changes."
    },
    "goal": {
      "objective": "Verify the Agents MCP create path."
    },
    "runtime": { "type": "workflow" },
    "vcsPolicy": { "required": false, "mode": "none" },
    "workflow": {
      "steps": [
        {
          "name": "verify",
          "parameters": { "stage": "verify" },
          "timeoutSeconds": 300
        }
      ]
    },
    "ttlSecondsAfterFinished": 600,
    "parameters": {
      "stage": "verification"
    }
  }
}
```

Do not send Kubernetes-manifest shape inside the MCP payload, such as
`payload.implementation.inline.text`; that nests incorrectly as
`spec.implementation.inline.inline`.

Do not set `payload.parameters.prompt`. The MCP server rejects prompt
parameters before calling the AgentRun API. Use `payload.implementation.text`
or `payload.implementationSpecRef.name`.

If a run requests `payload.secrets`, `payload.vcsRef`, or a VCS policy that
needs credentials, also pass `secretBindingRef` or set
`payload.policy.secretBindingRef`. VCS runs must set
`payload.parameters.repository`.

## Dry run behavior

`create_agent_run` has an optional `dryRun` parameter that is forwarded to the
Agents API. Do not assume it is side-effect free until the API behavior is
verified in the target environment; a 2026-05-31 live check with
`dryRun: true` returned success while still materializing an AgentRun resource.
Use a short TTL and delete any verification resource explicitly when testing
create behavior.

## Smoke sequence

1. Call `create_agent_run` with a unique `deliveryId` and an AgentRun payload
   containing top-level `goal.objective`. Omit `goal.tokenBudget` when the run
   should have no token budget.
2. Call `get_agent_run` with the returned projection id.
3. Call `list_agent_runs` with `statuses: ["Pending", "Running", "Succeeded",
   "Failed"]` or `agentName`, plus a small `limit`. The backing API requires at
   least one of `statuses` or `agentName`; `limit` alone is not enough.
4. Call `get_agent_run_logs` with the live AgentRun resource name and
   `tailLines: 5`.
5. Call `list_agent_run_terminal_events` with a stable consumer name.
6. When the created run appears terminal, call `ack_agent_run_terminal_event`
   with that event id and consumer.

## Log behavior

`get_agent_run_logs` is a snapshot read, not a stream. `tailLines: 5` fetches
the last five retained log lines. If the AgentRun pod has already been removed,
the response is still successful but has `pods: []` and `logs: ""`.

Use `agentctl run logs <name> --follow` for streaming logs until an HTTP/SSE MCP
bridge exists.
