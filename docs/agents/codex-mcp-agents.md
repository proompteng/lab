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
- `cancel_agent_run`
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
Agents API. `dryRun: true` and `dryRun: "All"` validate the request and return
the normalized AgentRun preview, policy/admission result, and resolved workload
image without creating an AgentRun resource, projection record, Job, audit row,
or idempotency reservation.

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
the last five retained log lines. For a Codex Job with retained artifacts, the same call reads an authenticated S3
log tail after Pod cleanup. `source` is `pod` or `artifact`; `truncated` identifies
a partial archive tail. Artifact reads are bounded to 512 KiB and 5,000 lines.
An absent live Pod and absent archive return `404`, rather than an empty success.
Pod and container filters remain enforced against the retained snapshot.

Use `agentctl run logs <name> --follow` for streaming logs until an HTTP/SSE MCP
bridge exists.

## Essential runner telemetry

Codex workers emit JSONL events to stdout and the runner log. The existing Alloy
collector forwards stdout through Loki. Events include tool activity, bounded
output, cumulative usage, rate-limit snapshots, and a heartbeat every ten seconds.
The notification observer remains attached across native goal continuation turns.

For Job runtimes with authorized artifact storage, `get_agent_run` exposes
`resource.status.runner.telemetry` while the worker is active. The worker publishes
to an S3 key derived from the namespace and exact AgentRun UID. The API reads that bounded snapshot with the run-authorized
`agents-artifacts` Secret; it never writes progress into the Kubernetes AgentRun status.
The snapshot is retained in `agentRun.payload.resource.status.runner.telemetry`
after resource cleanup. Terminal runner status carries the final snapshot.
Termination files are bounded to 4 KiB of compact UTF-8 JSON. When a larger
status is needed, the file carries a SHA-256 reference to a structured terminal
event in the same container's logs. The controller resolves and validates that
event before retaining the full status; it retries unavailable or mismatched
references instead of accepting incomplete metadata. Log reads are bounded to 1 MiB.

The snapshot includes heartbeat and last-activity timestamps, active tools and
start times, thread and turn IDs, configured model and reasoning effort, cumulative
input/cache/output counters, and the latest account quota window. Usage totals are
authoritative snapshots, not increments to sum. Quota describes the shared account
limit identified by `limitId`; it is not usage attributed to one run. `finished`
means the telemetry producer stopped; the AgentRun outcome remains separate.

Live publication uses the existing artifact credentials and bucket. Kubernetes
permissions stay unchanged, including the optional chart-managed runner Role's
read-only access. Audience-scoped identity projections also retain live progress
when the run authorizes artifact storage. Runs without artifact storage retain
local/stdout and terminal telemetry. Publication failures are logged and counted
without failing the task. Heartbeat liveness and model/tool activity have separate
timestamps. Live reads are bounded to 32 KiB, and missing startup snapshots remain
unknown until the worker publishes them.

With the existing `agents-artifacts` Secret and a keyed `runner-result` artifact,
the runner archives the completed JSONL log at `<result-key>.events.jsonl` on both
success and caught failure paths. The API reads only the configured storage bucket
with the run-authorized artifact Secret. Abrupt process or node loss can prevent
that final upload; the existing Loki stream remains independent. Missing archives
and storage failures are returned explicitly. Final text and test/PR references
remain in the existing result artifact; telemetry does not invent a delivery verdict.

## ChatGPT Oracle delegation

The authenticated `agents-shell` endpoint and its tunnel expose `create_agent_run`,
`get_agent_run`, `get_agent_run_logs`, and `cancel_agent_run`. These tools use the
same schemas, validation, and Agents API handlers as this MCP endpoint.

Use a stable `deliveryId` for retries. Submit `payload.runtime.type: job` and put
the complete task in `payload.implementation.text`. Omit `goal.tokenBudget` unless
the user requests a token budget. Keep the returned projection ID for subsequent
status and cancellation calls. The old `agent_start`, `agent_status`, `agent_read`,
and `agent_cancel` tools are removed.

The Codex worker runs `codex app-server` inside the Kubernetes Job. The shared
runtime and generated protocol types are pinned to Codex `0.166.0`.

For a retained result, include the allowed `agents-artifacts` Secret alongside
`codex-auth`, and set `parameters.artifactKey` to a unique object key for the run.
Use `secretBindingRef: codex-github-token`. The Codex provider uploads
`/workspace/.agent/result.json` to the existing `agents-artifacts` bucket. The JSON
contains the app-server thread ID, terminal turn ID, and observed response text.
The response text is limited to 64,000 characters. `responseTruncated` identifies
an incomplete response. Log retention is separate.

`status.runner.result` carries a preview of up to 256 characters for direct MCP
retrieval. Its `truncated` flag identifies a partial preview. The complete retained
response remains in the artifact, subject to the separate 64,000-character limit.

Read `get_agent_run` after completion to persist its final resource snapshot and
artifact references in the projection. The projection remains readable after the
Kubernetes resource expires. Filesystem paths alone do not establish retention.

`cancel_agent_run` persists cancellation intent before it requests deletion of
the recorded Kubernetes UID. A `Cancelling` response means cleanup is pending.
Read `get_agent_run` until it reports a terminal state. Cancellation preserves
completed results and rejects a replacement resource with a different UID.
Repeated cancellation is safe. Worker termination still requires checking its
owned runtime resources.

Use the bounded live verifier after the reviewed release reaches the cluster:

```bash
bun run packages/scripts/src/agents/verify-oracle-delegation.ts \
  --delivery-id oracle-acceptance-unique-id --preview
bun run packages/scripts/src/agents/verify-oracle-delegation.ts \
  --delivery-id oracle-acceptance-unique-id --output /tmp/oracle-receipt.json
```

For Pro acceptance, first submit the preview's exact arguments from the Pro chat
through `agents-shell-tunnel`. Then run the verifier with the same delivery ID.
The verifier retries the submission and checks terminal state plus retained
artifact references after resource cleanup. It does not prove artifact contents
or the originating Pro model. Verify those separately. `--mode failure` requests
an intentionally missing VCS base ref. `--mode cancel` cancels a running worker.
The verifier uses a ten-minute deadline and requests cancellation on timeout.
