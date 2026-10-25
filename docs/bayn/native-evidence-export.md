# Native evidence export

Bayn's evidence collector retains the original native arrival journal outside execution. It runs as the
`bayn-evidence` CronJob in namespace `bayn`, using the same immutable image and Kargo promotion as Bayn.
It has one database connection, a global page budget and a three-minute work deadline. Kubernetes allows
one active job and does not retry a failed job. The next scheduled job resumes verified checkpoints.

This is evidence retention. Receipts remain `UNQUALIFIED`; copying a recorded prefix does not establish
complete market, controller or session coverage, accounting reconciliation or economic improvement.
The collector does not create financial study reservations or rerun failed inference.

## Reader authority

The dedicated CNPG-managed `bayn_evidence` identity has two connections, no inherited role, superuser,
database-creation, role-creation, replication or RLS-bypass privileges. Its `bayn-evidence-db` Secret supplies
`username`, `password` and `fqdn-uri`. Prepare a distinct password as strict-scope encrypted desired state
through the existing secret path. Install the credential, create the role and apply grants only after approving
this new identity and its exact scope. The proposer keeps its existing separate role.

After CNPG creates the role, the approved administration path runs
[grant-evidence-reader.sql](../../services/bayn/tools/grant-evidence-reader.sql) against database `bayn`.
It grants only CONNECT, schema USAGE and SELECT on twelve tables:

- `native_arrival_epochs`, `native_arrival_chunks`, `native_arrival_ends`.
- `autonomous_cycles`, `intraday_candidate_observations`, `jev_batch_plans`, `jev_batch_results`,
  `autonomous_cycle_shadow_decisions`.
- `jev_evaluation_requests`, `jev_evaluation_receipts`, `jev_evaluation_resolutions`, `inference_expense_quotes`.

The separate evaluation journals retain responses and failures even when a batch never receives a terminal
result. The native study exporter reads the cycle, observation and batch graph; decision and cost evidence
use their native readers. SELECT authority does not grant broker, capital, accounting-posting or
research-claim authority.

Both export commands require `bayn_evidence`. Their connection URLs force UTC and read-only transactions
on every connection, including reconnects. The table grants remain the write boundary even if a client
changes its own read-only setting. Real PostgreSQL tests check the exact SELECT set and denied trading
deletion, accounting reads, research-claim reads and schema creation.

The arrival collector receives only the reader URI and existing private capture-bucket credentials.
It has no mounted Kubernetes token or model/broker credential. Its network policy permits DNS, Bayn
PostgreSQL and the existing Ceph object store. It exposes no listener.

## Arrival archive

```sh
bayn-evidence-export --capture <native-capture-id> --maximum-pages 16
bayn-evidence-export --arrivals-since 2026-10-24 --maximum-pages 256
```

The second form discovers every retained epoch that was recorded since the supplied UTC date or whose
last original arrival overlaps it. Indexed tail reads avoid scanning the full chunk table. A catalog above
1,024 captures fails instead of truncating. The catalog and its observation time are retained before export.
The page budget applies across the entire run; deferred capture IDs remain explicit.

Each read takes at most eight chunks. The exporter verifies the epoch's original bytes and identity, then
retains each chunk's original compressed bytes, header and content hash. It enforces ordinal, hash-link,
consumer-sequence and availability order across pages. Every immutable object uses a conditional write and
exact GET readback in the owner-only private bucket.

Objects live under `native-evidence/v1/arrivals/<capture-id>/`. Pages are content addressed and link their
previous page. The cursor uses conditional ETag updates. Resuming checks its hash, original database anchor
and retained last page before extending it. A stale concurrent writer fails. A crash before checkpoint
publication reuses the same verified page; a crash after publication resumes the next ordinal.

Original end receipts retain `STOPPED`, `INCOMPLETE` and `consumerScopeCompleted` values. Missing end receipts
stay missing. `caughtUpToReadCut` describes a read boundary, not a completed consumer or session. An
independent audit must walk every page and verify the full source and session denominators before using
the archive as evaluation evidence.

Each command first writes `native-evidence/v1/attempts/<uuid>/started.json`. It then retains its catalog and
completed summary, or attempts to retain an incomplete failure marker. If storage becomes unavailable,
a started attempt without a completed summary remains incomplete. Checkpoints and original pages are
retained; the exporter does not change the trading journal.

## Independent archive audit

Run the verifier from the pinned checkout with only the existing object-store configuration. It needs
neither PostgreSQL access nor model or broker credentials:

```sh
bun services/bayn/tools/native-arrival-archive-audit.ts \
  --capture <native-capture-id> --receipt <export-receipt-hash> \
  --maximum-pages 1000 --source-revision <verified-checkout-revision>
```

Pin the collector's receipt hash before starting. The audit follows every content-addressed page back to
ordinal zero, independent of the collector's mutable cursor and database. It reads one page and decodes one
chunk at a time. The explicit page budget is an admission limit; reaching it fails without a completed audit.
Increase it deliberately for larger retained prefixes, up to 100,000 pages. Every referenced object must have
its exact capture, key, byte length and SHA-256. Original compressed bytes, record hashes, consumer sequence,
epoch and availability ordering must reproduce. Missing old pages, substituted bytes, skipped prefixes,
conflicting end receipts and a receipt beginning inside a page all fail.

The report counts every delivery by the original topic and partition, including zero-delivery partitions,
accepted, ignored, rejected, tombstone and assignment-invalidated records. Counts include redeliveries;
they are neither unique market events nor trade opportunities. It retains the original end receipt and the
exporter's read-cut limit. A bounded prefix may verify completely while the consumer continues beyond it.
The verifier retains its started/completed or failed attempt and a private content-addressed report with
exact GET readback. The report binds both producer and verifier source revisions and the pinned receipt.

`completeRetainedPrefixBytesVerified` establishes the archived prefix's integrity. Session coverage remains
false, controller coverage remains unknown and qualification remains `UNQUALIFIED`. Independent source,
session, timing, decision and cost evidence is still required for the registered evaluation.

## Native session export

The published image also includes the native session command:

```sh
bayn-jev-study-export --session YYYY-MM-DD --output /private/new-session-directory
```

It exports the complete recorded cycle/batch cut, including no-batch cycles, management, exclusions,
abstentions and pending results. It binds raw data bytes and inventory counts in the native receipt. A new
private directory is required. This command does not claim complete source/controller coverage.
Run it separately with the account identifier and filesystem allowance described in the
[session export procedure](study-evidence-export.md#execution-and-storage); the arrival CronJob has neither.

Timing collection and verification remain a separate boundary. Retain original Tempo responses before
their retention window expires and pair them with exact stored decisions through the
[v2 timing exporter](matched-entry-study.md#export-a-retained-native-timing-witness). The arrival CronJob
does not by itself preserve a complete timing cohort or qualify a comparison. Keep incomplete timing,
unknown costs and failed financial reservations explicit.
