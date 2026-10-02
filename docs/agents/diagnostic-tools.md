# Read-only diagnostic tools

Agents Shell provides fixed-operation readers for existing workspace artifacts. They do not accept shell commands,
SQL, URLs, callbacks or executable code. They do not connect to databases, call providers, change cluster resources,
or publish evidence. Existing OAuth identity and scope checks still apply. MCP annotations describe the operations;
they do not replace authorization or host-side review.

## File pages

`file_read_range` accepts `path`, optional `sessionId`, `offset`, `maxBytes`, and `expectedVersion`. The default page
is 20,000 bytes and the hard maximum is 200,000 bytes. It returns UTF-8 text, the file size, a version fingerprint,
`nextOffset`, and `endOfFile`. Use the returned cursor and version for every subsequent page. The version binds file
identity, size and modification/change times; it is not a content hash.

The Linux reader checks the canonical workspace boundary and the opened `/proc/self/fd` target. It rejects external
symlink targets, hard-linked files, directories and other non-regular inputs. A file changed during a read or since
the supplied version fails closed. Pages never load the entire file. Invalid UTF-8 and a page too small for the next
character fail rather than silently replacing bytes. Internal symlinks whose resolved targets remain inside the
authorized root are permitted.

The existing `read_file` prefix reader uses the same descriptor and bounded-read implementation, retaining its
`path`, `content`, `bytes`, and `truncated` response shape. It now rejects the unsafe file forms above and does not
read a whole file merely to return a small prefix. All file readers enforce repo-session ownership on the canonical
target, including when the caller supplies a direct workspace path or an internal symlink instead of a session ID.
Ownership is checked again against the opened descriptor before reading, so a path swapped after the initial check
cannot redirect the read into another session.

## Evidence integrity

`evidence_inspect` accepts `path`, `format` (`json`, `ndjson`, or `json-stream`), optional `sessionId`, and optional
`expectedSha256`. It reads the complete file up to a 64 MiB hard limit. NDJSON is limited to 250,000 physical lines
and 1 MiB per line. `json-stream` accepts whitespace-separated JSON documents, including multiline documents emitted
by export tools; it is not line-delimited JSON. Every document is validated with the JSON parser, including the final
document. Streams and top-level arrays are limited to 250,000 documents and elements respectively. Malformed,
oversized, empty streams or hash-mismatched input returns an error, not a partial success.

The response contains the exact SHA-256, file identity, document-type counts, blank-line count and top-level array
element count. It does not return payload values or JSON parser excerpts. `completeFile` means every byte of that
file was read. It does not prove that an export captured every source record, reconciles financially, or covers an
entire session. Source receipts and domain-specific validation remain necessary.

## Command compatibility

The read-only `kubectl` tool accepts `-n example` and `--namespace=example` before the command, without rewriting
the forwarded arguments. The command and restricted `auth`/`rollout` subcommands are still checked against their
read-only allowlists. Missing namespace values, unknown leading flags and mutating operations remain rejected.

The Agents Shell image includes `/usr/bin/env` for executable scripts with an env shebang. This resolves interpreter
lookup failures in package scripts without changing executable permissions or routing them through a shell fallback.

## PostgreSQL log summaries

`postgres_log_summary` accepts an existing artifact `path`, inclusive UTC `startAt`, exclusive UTC `endAt`, optional
`sessionId`, and optional `expectedSha256`. The interval must be positive and no longer than 24 hours. Files are
limited to 32 MiB, 250,000 physical lines and 1 MiB per line. The reader supports CNPG PostgreSQL JSON records,
optionally prefixed by a Kubernetes UTC timestamp. Timestamp bounds and records retain up to nine fractional digits
during comparisons and in returned timestamps. Sub-millisecond intervals are not rounded to zero.

`statementDurationMs` includes only explicitly labeled `statement` and `execute` duration records. Parse and bind
timings have separate `parseDurationMs` and `bindDurationMs` aggregates. Bare duration records and unknown timing
suffixes remain in `unattributedDurationMs`; they are not assumed to be statement execution. PostgreSQL can emit
Parse, Bind and Execute durations independently, including without query text. See the
[PostgreSQL logging contract](https://www.postgresql.org/docs/18/runtime-config-logging.html).

The fixed parser returns severity counts, statement and COMMIT duration distributions, checkpoint/restartpoint
sync-duration distributions, replication-timeout counts, and the count of observed commits longer than one second.
Durations are milliseconds. Quantiles use nearest rank over retained in-range samples. No observed samples produce
null duration statistics, not zero latency. SQL text, database/user identifiers and raw log messages are not returned.

The response includes the complete file hash, first/last recognized timestamps, first/last in-range timestamps,
out-of-range counts, and malformed, unrecognized, undated and invalid-numeric record counts. It always returns
`sessionCoverage: "not_proven"`. A complete read of retained logs does not establish retention coverage or identify
the physical cause of a storage/replication stall. Unrecognized records and missing metrics remain evidence gaps.

## Validation and deployment

Synthetic file and in-memory MCP tests cover descriptor confinement, UTF-8 paging, changed-file detection, size
limits, integrity mismatch, record parsing, explicit coverage, excess-argument rejection, scope enforcement and the
absence of process execution in the new readers. Source fixtures contain no operational or account evidence.

Use the normal reviewed source, immutable image and GitOps release path. Verify the deployed tool catalogue and
synthetic tool behavior separately from infrastructure health. A local test or merged change does not establish
deployment or connector catalogue refresh. New readers do not authorize previously denied operations or guarantee
that a host will accept a particular request. Live database evidence collection is outside these offline tools.
