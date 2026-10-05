# View agents-shell activity

Open [Grafana Explore](https://grafana.k8s.proompteng.ai/explore), select **Loki**, and run:

```logql
{namespace="agents"} |= "agents-shell audit" | json
```

Schema version 2 exports ordinary tool arguments, commands, argv, paths, source/patch contents, results, errors and
complete child stdout/stderr. The former arbitrary-text omission policy is removed. This uses the existing private
Grafana/Loki audience and pod-log pipeline; it does not change OAuth, scopes or sharing permissions.

## Follow an agent or execution

`subjectHash` comes from authenticated identity. `requestId` and `toolCallId` correlate MCP calls, including errors,
and are also returned in `_meta["agents-shell/trace"]`. A request rejected before reaching this server has no execution
receipt; upstream cancellations must be diagnosed separately.

HTTP receipts use the same generated `requestId`, returned as `x-agents-shell-request-id`, and the message
`agents-shell http request`. `started` precedes authorization; fixed `phase` receipts locate authorization,
connection, transport and cleanup. `aborted` records a request-signal observation once, without the reason, and
does not stop a job. `failed` records an exception escaping a handler phase without its private text.
`completed` records the constructed response's status and duration, not proof that the caller received it.
Only fixed methods and paths are recorded; HTTP headers, query strings, bodies and user agents are excluded.
SDK errors returned as responses are visible through completion status and need not emit an exception receipt.

Shell jobs have generated `jobId`, authenticated owner, an automatic `taskId`, an owned `sessionId` and advisory `agentId`. Labels never grant
access. Owners can list all their agents across sessions; optional filters narrow that view. Other subjects cannot
read, list or cancel those jobs. Direct Git/kubectl processes have generated job IDs too. IDs are JSON fields, not Loki labels.

Native workers use separate repository sessions and pass the returned `sessionId` to every repository tool.
`exec` always requires an owned session, including commands whose cwd is outside the seed repository.
`git_write` and `apply_patch` also require an owned session. The session ID supplies `taskId` automatically; an optional
`agentId` labels parallel workers and never grants access. Native commands without a repository session use their
generated job ID for task identity. These records describe tool execution; they do not infer a native model's thinking or overall lifecycle.

The server exposes one generated catalog through the direct endpoint and tunnel. `tools/list` and tool replies include
`_meta["agents-shell/catalog"]` with version `0.2.2` and a SHA-256 fingerprint of the catalog. After an authorized rollout,
refresh both connector catalogs and compare these receipts; a cached connector catalog is not proof of deployed parity.
Use `git_write` with an owned `sessionId` for `ls-remote`. Git configuration can rewrite URLs and execute configured
helpers, so remote inspection requires execution authority.
`git cat-file` permits raw object and batch inspection while rejecting filter and textconv execution.
`git rev-list` permits explicit commit-listing options and rejects output files, external diff drivers, and alternate-ref commands.

The old `shell_run`, `shell_start`, `shell_read`, `shell_kill` and `shell_status` tools are removed.

The shell image runs Tini as PID 1 to reap orphaned command descendants. SIGTERM and SIGINT stop the HTTP listener,
close active HTTP connections, reject new or queued work, and kill active shell and native process groups before Bun exits. Image publication
verifies orphan reaping and clean termination against the built Linux container on both architectures.

```logql
{namespace="agents"} |= "agents-shell audit" | json | subjectHash="<owner-hash>" | jobId="<job-id>"
```

```logql
{namespace="agents"} |= "agents-shell audit" | json | taskId="<task-id>"
```

```logql
{namespace="agents"} |= "agents-shell audit" | json | agentId="<agent-label>"
```

```logql
{namespace="agents"} |= "agents-shell audit" | json | toolCallId="<call-id>"
```

- `tool_call_started` records authorization and authorized input
- `tool_call_finished` records outcome, duration and authorized result or exact error
- `shell_job_started` / `shell_job_finished` record command, cwd, identity, exit/signal/timeout and capture errors
- `process_output` records stdout/stderr independently of MCP reply caps
- `process_output_finished` records byte/chunk totals, masking/self-log counts, encoding loss and sink/capture errors

## Reassemble and verify

Each event has an `eventId`. Small events contain `payload`. Larger payloads use bounded JSON frames with
`payloadFragment`, `fragmentIndex`, `fragmentCount` and `payloadBytes`; no prefix is silently dropped. Job, stream and
sequence fields remain on every fragment so Grafana filters include the whole event. Expand raw lines to inspect
payloads/fragments. Grafana's line limit is a query/page limit: page a bounded time range until all expected frames arrive.

1. Deduplicate by `(eventId, fragmentIndex)` for fragments, or `eventId` for ordinary events
2. Require every fragment; join `payloadFragment` in index order, verify `payloadBytes`, then parse JSON
3. Group output by job and stream, requiring contiguous `sequence` values and source-byte checkpoints
4. Join `payload.text`; compare against the final byte/chunk totals and SHA-256

Ordering is per stream, not a total stdout/stderr interleave. The final event is the terminal source-byte checkpoint for suppressed self-log frames, which need not emit a text chunk. Invalid UTF-8 uses
replacement characters and sets `encodingLoss`. A reconstruction hash is supplied only for UTF-8-preserving
streams without self-log suppression. Missing frames/final events, sink/capture errors or hash mismatch mean completeness
is unverified. Neither successful local writes nor readiness prove end-to-end Loki delivery.

Operational commands, argv, source, results, errors and stdout/stderr are exported raw. Credential-shaped fields,
values, encoded containers and Kubernetes Secret documents retain their original content. There is no credential
masking or Secret-specific omission path. OAuth headers/claims and MCP transport metadata are not operational payloads.
Delegated model-log bodies are not mirrored by this operational exporter. Signed self-audit frames encountered during
log inspection are counted instead of recursively copied; original authorized tool output stays available. Ordinary
unsigned JSON is not suppressed.

## Reply caps, retention and failures

Use one execution API:

```json
{
  "requestKey": "test-20261004-1",
  "command": "bun test",
  "sessionId": "repo-example-12345678",
  "waitMs": 1000,
  "maxBytes": 20000
}
```

`exec` starts once per authenticated owner, session and `requestKey`. It waits up to `waitMs` (0–30,000 ms, default 1000)
for admission and completion, returning a running job (`state: "running"`, `ok: null`) or terminal receipt
(`state: "exited" | "cancelled" | "timed_out"`, boolean `ok`). The timeout still defaults to 60 seconds and caps at 1800;
`waitMs` only bounds how long the caller waits. Retry an uncertain call with the same key and execution input to retrieve
the same job. Retain the original execution arguments; previews may be truncated. Completed replay works after session
close. Changing command, cwd, timeout or agent label returns `IDEMPOTENCY_CONFLICT`. Capacity pressure returns
`CAPACITY_BUSY` and `retryAfterMs`, with bounded admission waiting and no unbounded queue. A command waiting for capacity
may start after another retry receives `CAPACITY_BUSY`; retry the same key until the original call resolves.

Pass the returned `jobId` and opaque `cursor` to `read`. It resumes both streams at raw byte offsets and can wait up to
30,000 ms for readable output or completion; its default is 0. Continue with each new cursor. Invalid, mismatched or
future cursors are rejected. UTF-8 pages avoid splitting code points and hold incomplete live characters until more
bytes arrive. Set `outputEncoding: "base64"` on exec or read for exact arbitrary bytes; offsets always count source bytes.
`HasMore` means another readable page. Use waiting when no page is ready. Retrying an `exec` returns its initial output
page; cursor reads are the continuation mechanism.

`maxBytes` bounds the serialized exec/read MCP result, including structured/text content, metadata and both streams.
It defaults to 20,000 bytes, accepts 4096–1,048,576, and reserves space for trace and audit receipts. A budget that fits
metadata but cannot advance a readable retained stream fails explicitly; retry with a larger `maxBytes`. Replies carry a
bounded `commandPreview` and `commandHash` instead of echoing the entire command. Native CLI replies also use these
fields and report `outputCaptureError`, `auditErrors` and `captureIncomplete`; their `maxOutputBytes` remains a per-stream
cap. Command success and capture completeness are separate. Capture receipts do not establish end-to-end Loki delivery.

`status` lists metadata including bounded `commandPreview` and `commandHash`, without stdout/stderr, in pages of at most
8 KiB, with a cursor and `hasMore`. A short command may fit entirely in its preview. Reuse the same filters for subsequent
pages. `cancel` sends SIGTERM to the process group, escalates to SIGKILL after one second, waits for completion, and returns
the terminal receipt. Repeated cancellation returns the same receipt.

When running in Kubernetes without an existing kubeconfig, shell startup creates an `in-cluster` context from the mounted
ServiceAccount namespace, CA and token file. The generated config points at the token file so projected token rotation
continues to work. Its `KUBECONFIG` is inherited by `exec` and the native Kubernetes tools.

Completion receipts and idempotency keys remain available for one hour after **completion**, independently of output
history. Up to 10,000 receipts are retained; new executions receive capacity pressure rather than evicting unexpired
receipts. Each stream retains a 4 MiB tail; at most 64 completed jobs retain buffers within a 64 MiB aggregate budget
including live buffers. `AGENTS_SHELL_MAX_CONCURRENT_JOBS` accepts 1–8 (default 4), which keeps all live tails within that budget. Invalid output, timeout or concurrency limits fail at configuration load. Eviction follows completion order and preserves live output. A nonzero retention start or
truncation flag identifies a lost in-memory prefix; the completion receipt still reports the outcome. Process/pod restart
clears receipts, keys and buffers. Unknown or expired job IDs are explicit.

Every audit event family uses one bounded 16 MiB stdout queue and stops submitting frames when the Writable reports backpressure. Complete events that exceed remaining admission capacity are rejected with explicit counters. MCP `_meta["agents-shell/audit"]` reports pending/rejected frames, write failures and whether that call's frame watermark flushed; later concurrent calls do not hold an earlier call open. Flush waiting is bounded to 10 seconds, and a stalled sink rejects new admissions until it drains. The stdout sink honors backpressure. Ten seconds of blocked export stops the affected command with a capture error.
Timeout termination escalates past ignored SIGTERM. Post-exit drain accounts for progress/backpressure and reports when
remaining descendant pipes must close. These failures are not classified as user cancellation.

Alloy forwards stdout to existing Loki storage. Collector/transport failures, Kubernetes log rotation and retention can
still cause gaps: verify counts/hashes from Loki for important executions. The optional duplicate JSONL file is disabled
by default and in production to avoid unlimited shared-workspace disk growth. Operators enabling it must manage retention;
write failures are reported. This change does not delete an existing audit file.

Before rollout, finish sessions and preserve unpushed work. Production uses one replica with `Recreate` and an `emptyDir`
workspace; replacement removes local files and stops jobs. Already-ingested Loki events survive shell replacement under
Loki retention. Follow [release automation](../release-automation.md), then verify concurrent credential-free output larger
than reply caps by reassembling its Loki events and comparing final hashes.

### Per-event admission

Before copying or serializing a generic event, a bounded traversal admits at most 8 MiB of JSON payload,
65,536 values and 64 nesting levels. Escapes and repeated subtrees count toward the budget; cycles/accessors are rejected.
The prepared result is checked again before framing. A rejected event emits a small signed receipt with its original
event ID/type, `captureIncomplete: true`, `payloadTruncated: true`, rejection reason, observed byte lower bound and budgets.
It also increments the call's audit error count. The original MCP result and existing authorized retrieval/retention are
unchanged. Normal multi-megabyte events below the bound remain complete. Continuous process output uses small chunks
and is not limited to 8 MiB per execution. Frame metadata is bounded independently so identifiers cannot amplify every fragment.

User-authored delegated task/acceptance instructions remain operational inputs; they are not hidden model reasoning.
