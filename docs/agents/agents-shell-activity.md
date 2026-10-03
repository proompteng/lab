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

Shell jobs have generated `jobId`, authenticated owner, optional `sessionId` and advisory `agentId`. Labels never grant
access. Owners can list all their agents across sessions; optional filters narrow that view. Other subjects cannot
read, list or kill those jobs. Direct Git/kubectl processes have generated job IDs too. IDs are JSON fields, not Loki labels.

Native workers should use separate repository sessions and pass a short stable `agentId` on each `shell_start` or
`shell_run`, for example `{ "command": "bun test", "sessionId": "repo-example-12345678", "agentId": "test-worker" }`.
Use distinct labels for parallel workers. Unlabeled calls remain visible by owner, job and call IDs. These records
describe tool execution; they do not infer a native model's thinking or overall lifecycle.

```logql
{namespace="agents"} |= "agents-shell audit" | json | subjectHash="<owner-hash>" | jobId="<job-id>"
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

Ordering is per stream, not a total stdout/stderr interleave. Masking changes displayed length. The final event is the terminal source-byte checkpoint for masked tails and suppressed self-log frames, which need not emit a text chunk. Invalid UTF-8 uses
replacement characters and sets `encodingLoss`. A reconstruction hash is supplied only for unmasked, UTF-8-preserving
streams without self-log suppression. Missing frames/final events, sink/capture errors or hash mismatch mean completeness
is unverified. Neither successful local writes nor readiness prove end-to-end Loki delivery.

Only credential values are masked as `[REDACTED_CREDENTIAL]`, with counts; surrounding operational content stays visible.
The scanner handles known runtime credentials/common encoded forms, explicit credential fields/options, Authorization,
URL userinfo/query values and private-key blocks across chunks. It cannot guarantee detection of arbitrary unknown or
transformed secrets. Do not intentionally print secrets. OAuth headers/claims and MCP metadata are not exported.
Delegated model-log bodies are not mirrored by this operational exporter. Signed self-audit frames encountered during
log inspection are counted instead of recursively copied; original authorized tool output stays available. Ordinary
unsigned JSON is not suppressed.

## Reply caps, retention and failures

Replies default to 20,000 bytes per stream and allow up to 1 MiB; `outputLimitBytes` shows the applied cap. Shell jobs
retain a separate 4 MiB per-stream memory tail. Explicit-offset `shell_read` pages forward, returns actual start/next
byte offsets and never jumps to EOF. UTF-8 pages avoid splitting code points; incomplete live characters wait for more
bytes. Base64 mode retrieves exact retained arbitrary bytes. `HasMore` means another readable page, not a busy-poll cue.

A nonzero retention start/truncation flag identifies an expired in-memory prefix, not a Loki capture limit. Completed
history is limited to one hour, 64 jobs and a 64 MiB aggregate budget; live jobs stay available. Unknown/expired IDs are
reported explicitly. Process/pod restart clears this memory.

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

### Per-event admission and explicit credential contexts

Before copying, masking or serializing a generic event, a bounded traversal admits at most 8 MiB of JSON payload,
65,536 values and 64 nesting levels. Escapes and repeated subtrees count toward the budget; cycles/accessors are rejected.
The sanitized result is checked again before framing. A rejected event emits a small signed receipt with its original
event ID/type, `captureIncomplete: true`, `payloadTruncated: true`, rejection reason, observed byte lower bound and budgets.
It also increments the call's audit error count. The original MCP result and existing authorized retrieval/retention are
unchanged. This receipt is explicitly incomplete capture, not a replacement claiming to contain the original payload.
Normal multi-megabyte events below the bound remain complete. Continuous process output uses small chunks and is not
limited to 8 MiB per execution. Frame metadata is bounded independently so identifiers cannot amplify every fragment.

Credential contexts include Authorization/Proxy-Authorization and HTTP*AUTHORIZATION/PROXY_AUTHORIZATION, Cookie/Set-Cookie,
password/token/API/private-key fields, OAuth access/refresh/id tokens and client secrets, S3 secretAccessKey/secret_access_key,
explicit session/auth/reconnect/GitHub tokens and database/admin passwords, plus runtime *\_SECRET*ACCESS_KEY/*\_SECRET_KEY
families. Scalar `secretKey` is treated as credential-bearing even though some configurations use that ambiguous name for
an object key; reference objects (`secretKeyRef`, `secretRef`), names, paths, accessKeyId, pageToken, cancellationToken and
token counts remain visible. This is an explicit context table, not a blanket match for every field ending in Token.

The finite context table also covers standard PostgreSQL/MySQL/Redis credential variables, Tailscale auth keys,
passphrases, npm `_authToken`/`_auth`/`_password`, kubeconfig `client-key-data`, repository-specific SDK credential names,
and quoted JSON/YAML credential keys. Structured Kubernetes `name`/`value` pairs are masked only when `name` is an
explicit credential name; `valueFrom` references remain visible. A raw text stream is not a general JSON/YAML parser:
reordered or nested name/value containers and arbitrary transformations are not guaranteed to be recognized. Avoid
printing credential containers; the scanner's declared contexts do not imply universal secret detection.

Known Kubernetes Secret reads have a separate bounded structural path. Explicit `kubectl get secret(s)` stdout and
stderr are held up to 4 MiB until capture closes. JSON/YAML Secret data/stringData values (including SecretList items)
are masked by syntax ranges; metadata, key names and ConfigMaps retain their original text. A flat lexer limits tokens
and nesting before syntax-tree allocation; aliases are not expanded or exported. Malformed or oversized credential
output produces `captureIncomplete`/capture error rather than exporting a partially inspected prefix. The original
MCP output and authorized retention are unchanged; partial shell_read/result duplicates retain the original command
context and use the same rule. Default metadata/name/wide views remain visible. Custom templates, JSONPath and custom
columns can disguise credential values, so those explicit Secret projections are omitted from centralized output with
an incomplete-capture receipt. Ordinary non-Secret streams continue streaming immediately.

Simple commands support leading shell assignments, standard `env` assignment/options prefixes and literal `--raw`
Secret API paths. Prefixes use finite state; retained executable/argument words are bounded to 256 words and 4,096
characters per word. Ambiguous syntax after a recognized Secret read produces incomplete capture. Indirect wrappers,
`env -S` and arbitrary scripts remain outside this recognition path.

Structurally masked streams use terminal source-byte checkpoints (`sourceByteCheckpointOnly`), not a byte-for-byte
reconstruction claim; source hashes are omitted when values are masked. Escaped command newlines are normalized, but
this is not a full shell parser and cannot identify arbitrary indirect scripts or transformed credential sources.
User-authored delegated task/acceptance instructions remain operational inputs; they are not hidden model reasoning.
