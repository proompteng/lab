# View agents-shell activity

Open [Grafana Explore](https://grafana.k8s.proompteng.ai/explore), select the **Loki** data source, and run:

```logql
{namespace="agents"} |= "agents-shell audit" | json
```

Each JSON event includes `ts`, `event`, `schemaVersion`, a pseudonymous `subjectHash`, and `payload`.
Tool calls also include `requestId`, `toolCallId`, and `tool`. Expand a log line to inspect its operation and result metadata.
All tool arguments and derived command/argv fields are omitted from audit records. Arbitrary operands can contain
credentials or task text; executable aliases and wrappers prevent reliable classification. Authorized MCP responses
retain their original content.

Filter by a tool or follow one call:

```logql
{namespace="agents"} |= "agents-shell audit" | json | tool="shell_run"
```

```logql
{namespace="agents"} |= "agents-shell audit" | json | toolCallId="<call-id>"
```

| Event                                                               | Activity                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_call_started`                                                 | Every call's known tool name and authorization result. Arguments omitted.                                                                                                                                |
| `tool_call_finished`                                                | Outcome and duration for every call, plus sanitized result metadata for authorized calls. `error` means an MCP tool error. `failed` means process failure. `running` means a background job has started. |
| `shell_job_started`                                                 | Job ID and timeout; command and working directory omitted.                                                                                                                                            |
| `shell_job_finished`                                                | Job ID, duration, exit code, signal, timeout state, output byte counts, and truncation state.                                                                                                            |
| Existing Git, patch, search, kubectl, and repository-session events | Process and workspace activity associated with the current tool call.                                                                                                                                    |

For `shell_start`, use `payload.jobId` from its result to identify the job. Its later `shell_job_finished` event retains
the original call ID even after the initiating request has returned. `shell_read` and `shell_status` create their own
tool-call events. Successful reads, status checks, and cancellations have outcome `succeeded`, independently of the
observed process status. Result metadata retains the process status and exit code; missing jobs and rejected calls
have outcome `error`. HTTP metadata logs share `requestId` with their tool events.

## Interpret content and retention limits

The exporter retains only known metadata fields: generated UUIDs, Git hashes, validated timestamps, fixed outcomes
and statuses, process signals, finite numeric counters, and booleans. Unknown fields and arbitrary text are excluded.
Tool arguments, command/argv, file and patch bodies, echoed filenames, branches, worktrees, task text, stdin,
stdout/stderr, and MCP metadata are omitted. OAuth subjects are hashed; usernames and email claims are excluded.
This policy applies to both stdout and the optional local file, including later background-job reads. Authorized MCP
responses retain their original content. Inspect original input and retained output through the authorized caller.

The payload has a shared 12,000-byte budget, a maximum nesting depth of four, 20 jobs per array, and 30 fields per
object. `payloadTruncated=true` marks metadata lost to these bounds. Free-form text is omitted without parsing it.
`stdoutTruncated` and `stderrTruncated` describe the shell's separate output-buffer limits.

Alloy collects the JSON stdout events through the existing Agents pod-log pipeline. Once ingested, records follow
Loki retention and survive shell pod replacement. Logging is best effort and never makes a direct network call from
tool execution. Sink failures emit a warning and do not change the tool result.

`AGENTS_SHELL_AUDIT_LOG_PATH` optionally keeps the same sanitized events in a local JSONL file. Disabling that file
does not disable stdout events. The production workspace uses `emptyDir`, so its file and unpushed workspace changes
disappear when the pod is replaced. In-memory job output disappears when the process restarts.

Before releasing a shell image, finish active shell sessions and preserve their workspace changes. The production
deployment uses one replica with `Recreate`, and shutdown terminates its running shell jobs. Separate AgentRun worker
pods have their own lifecycle. Follow the normal reviewed image delivery path in [release automation](../release-automation.md).
