# Codex Agents MCP setup

Status: draft

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

`tools/list` must include these AgentRun tools:

- `create_agent_run`
- `list_agent_runs`
- `get_agent_run`
- `list_agent_run_resources`
- `get_agent_run_logs`
- `list_agent_run_terminal_events`
- `ack_agent_run_terminal_event`
- `rerun_agent_run`

The memory tools `persist_memory` and `retrieve_memory` should remain available.

## Smoke sequence

1. Call `create_agent_run` with a unique `deliveryId` and an AgentRun payload
   containing top-level `goal.objective`. Omit `goal.tokenBudget` when the run
   should have no token budget.
2. Call `get_agent_run` with the returned projection id.
3. Call `list_agent_runs` with `statuses: ["Pending", "Running", "Succeeded",
   "Failed"]` and a small `limit`.
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
