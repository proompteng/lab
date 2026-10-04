# Original receipt capture

Production capture is **HARD DISABLED**. No live composition acquires the recorder or passes its observer to Kafka or
the native controller. There is no environment switch. Enabling it requires a separately reviewed export and capture
qualification change.

The recorder retains metadata from one worker. Each capture has a new identity, a strictly increasing receipt sequence,
and explicit consumer assignment boundaries. Market receipts retain the consumer epoch and sequence, projection
sequence, topic, partition, offset, exact pre-UTF8 value hash and byte length, bootstrap state, and the native reducer's
accepted, rejected, or ignored disposition. A Kafka tombstone has a null hash and length. An empty payload has the
SHA-256 of zero bytes and length zero. They are different evidence.

Kafka samples its Effect clock once per record and gives that exact time to incorporation and capture. Equal
milliseconds remain equal. The versioned original-arrival cursor uses receipt sequence for ties and rejects mixed
capture identities, epochs, and legacy ordering. Legacy whole-file replay manifests reject unbound original-order receipts. The versioned original-capture adapter
binds a verified interval to its immutable export root. The existing reducer and evaluator remain the only
market interpretation path.

The native controller records synchronous schedule submission, pass start, completion, failure, and ignored delivery.
It retains the supplied tick unchanged, the effective command timestamp, existing invocation identity, and the native
schedule idempotency key. Capture adds no Restate journal entry, awaited clock, retry, or authority decision. A schedule
receipt records a submitted native send; it does not independently prove durable delivery or completion. Restate replay
can repeat schedule and terminal observations. A runtime-start receipt is emitted only inside the actual journal action.
Terminal observations distinguish whether that runtime action ran in this worker; replay-only observations invalidate
completeness. Consumers must retain repetitions and join by native identity rather than treating them as additional execution.

Admission is synchronous and bounded by receipt count and UTF8 byte size. A scoped Effect worker persists text chunks
outside execution. Chunks bind the preceding exact-byte hash. The append-only database identity is capture plus ordinal;
duplicate retries compare both SHA-256 and exact payload text. Different formatting is different evidence. Seals bind
the committed frontier. PostgreSQL triggers reject updates, deletes, truncation, and appends after a seal.

Every metadata seal durably declares `qualification: UNQUALIFIED` before its write begins. A successful acknowledgement
does not upgrade it. If the database commits a seal and its acknowledgement is lost, the stored bytes still cannot claim
qualified completeness. `verifyResearchCapture` reports `structurallyClosed` for a contiguous, closed metadata prefix
without recorded invalidations, but always returns `complete: false`. Structural closure says nothing about whether this
seal's acknowledgement arrived, raw export/readback, or full source and controller coverage. Qualification requires the
separate reviewed export protocol; this metadata-only API has no qualified seal variant.

The buffer limit counts retained serialized receipt bytes. Draining splits that bounded buffer using the exact UTF8
chunk envelope, receipt bytes, and comma separators, so no chunk exceeds the database's 4 MiB payload limit. Each receipt
is serialized for its admission size and once in its final chunk; splitting never repeatedly serializes growing prefixes.
Capture identities are limited to 512 characters, and the persistence decoder rejects oversized chunks before SQL.

Overflow, persistence timeout, lost acknowledgement, interruption, missing raw identity, assignment changes, journal replay, or clock
reversal make completeness unavailable. A missing seal has an unknown crash tail. A seal cannot omit an observed or
committed tail and claim completeness. Persistence uses the native cancellable Effect SQL operation and has no retry.
None of these outcomes changes trading, liquidation, native retry, or capital authority. A new worker cannot repair an
earlier worker's missing observations.

If finalization cannot read its clock or encode evidence, `finish` returns no seal and does not retry. No replacement
timestamp is invented. The owning scope retains its successful result or independently requested cancellation.

The optional raw sink extends this same recorder and worker. It is not acquired in production. Only explicit injection
requests pre-UTF8 values from the existing Kafka consumer; metadata-only capture keeps its original wire formats and
does not copy raw values. Admission validates the receipt's original hash and length before copying the bytes. The
terminal-position map retains only topic, partition and offset, never a payload. Null tombstones and zero-length values
remain distinct, and rejected, malformed and ignored records retain their exact original bytes.

Raw-mode market receipts include `bayn.kafka-original-transport.v1`. It retains the exact `timestampMs` value that the
Kafka adapter supplied to the reducer. Finite numbers remain numbers. Missing values, NaN, either infinity and negative
zero have explicit tags so JSON cannot turn them into null or silently omit them. This includes invalid producer clocks:
replay must reproduce their rejection instead of inferring a timestamp from the payload. Metadata-only receipts omit this
block. No leader-epoch qualification or offset-gap rule is added.

Raw admission reserves `4 * receipt UTF8 bytes + 3 * raw bytes + 512` bytes per entry and 64 KiB for envelopes and bounded SDK responses. The
reservation covers owned bytes, binary assembly, metadata/index serialization and bounded readback payloads. It remains
charged through in-flight writes, as does the receipt-count limit. It bounds application-owned payloads, not total
JavaScript or SDK RSS. A raw recorder needs a buffer larger than the envelope reserve; the existing 4 MiB maximum still
applies. Overflow rejects admission synchronously and invalidates only capture. There is no queue wait in execution.

Each drained chunk writes a content-addressed binary object, the exact metadata JSON, and a hash-linked range index.
Indexes bind receipt sequence to binary offset/length; the metadata binds original arrival, consumer epoch/sequence,
topic/partition/offset, disposition and hash. All three objects must pass readback before the SQL append, and that append
must acknowledge before the recorder advances its frontier. An immutable export manifest binds the last index and exact
metadata seal. Every index, manifest and seal is `UNQUALIFIED`, including stored objects whose acknowledgements are lost.
The verifier checks the existing metadata chain plus every binary range and always reports `complete: false`.

Raw-mode SQL seals also retain `bayn.research-capture-export-root.v1`, binding the last verified index hash and chunk
count to the immutable metadata frontier. The manifest references the exact seal bytes; the seal does not reference its
own manifest hash. `deriveResearchCaptureExportManifest` is the single writer/reader representation. Given the exact
durably read SQL seal, it derives the expected manifest bytes and content address. Derivation alone does not prove the
object exists. A reader must Get that object from the known bucket, traverse the index chain by content-addressed keys,
and verify every referenced raw/metadata object against the durable SQL chunks. No List or recorder status is needed.

A committed SQL seal remains recoverable if its acknowledgement or process state is lost. Reconstruction does not prove
that acknowledgement arrived and never upgrades `UNQUALIFIED`. A failed or unknown manifest write prevents the SQL seal;
orphan objects without that seal have an unknown crash tail. Missing objects, mismatched roots or corrupt bytes cannot
establish a verified export. Metadata-only seal bytes and hashes remain unchanged.

The existing whole-worker verifier still requires genuine consumer closure. Deriving a manifest from an UNQUALIFIED
sealed prefix does not fabricate `STOPPED`, prove a complete session, or authorize an original-arrival replay source.

The scoped S3 adapter accepts explicit bucket, endpoint, region and redacted credentials. It has no environment reader,
ambient credential provider, or live composition. Future wiring must use the verified native OBC's actual `BUCKET_NAME`,
not its claim name. Empty region maps to `us-east-1`. Keys are fixed content-addresses. There is one `PutObject` with
`If-None-Match: *` and SDK `maxAttempts: 1`, followed by one full `GetObject`. HTTP 412 is accepted only after exact length,
bytes and SHA-256 match. The adapter does not list, overwrite, delete or change permissions. Unknown Put outcomes are
not retried. Readback streams are bounded, destroyed on failure or abort, and never accumulated into a second full body.
SDK requests receive the Effect abort signal; scope release destroys the client. Error details exclude credentials.
Before SDK deserialization, response streams are bound to that abort signal. The SDK collector is limited to 8 KiB
for error and discarded response bodies, including PUT responses. Remote error codes and transport error names are
not retained. Oversized or stalled error bodies fail capture and their streams close.

The existing at-most-one-second write deadline contains the complete export-and-SQL operation, and finalization is
cached once. It is not a production throughput claim. A timeout, readback failure, SQL failure, restart or missing seal
leaves incomplete evidence and cannot change execution, retries, liquidation or capital authority.

This implementation does not assert a session is complete, qualify a strategy, or enable model calls. Before
production acquisition, qualification must prove every source frontier and control offset,
full controller lifecycle joins, restart/replay ambiguity handling, measured storage capacity, and bounded overhead.
Kafka retention alone cannot recover an earlier consumer's original timing. Object-store capacity and connectivity
alone do not satisfy these gates.

## Bounded native-visible replay

`makeKafkaMarketProjection(..., recorder).captureInterval(request)` is available only through explicit construction.
The live `KafkaMarketProjection` capability does not expose it, and production composition still acquires no recorder.
The request freezes the universe hash, expected topic partitions, and requested observation interval. The native
assignment must precede the interval. After its requested end, the existing consumer samples the read-committed latest
offsets. A cut is recorded only when the same valid epoch has incorporated every delivered message through a drained
SDK frontier that reaches that sample. A queued message, pending incorporation, failed lookup, changed inventory,
or invalid epoch leaves the cut unavailable.

`bayn.native-visible-input-cut.v1` binds the pinned SDK and its manual, read-committed, fail-on-error settings. Its
committed offsets are not broker high watermarks. Transaction and control offsets can create gaps in the delivered
stream. The adapter preserves those gaps without inventing records or claiming why an individual offset was absent.
The proof trusts the same SDK boundary as native execution. It requires every delivered consumer sequence and the
actual drained frontier. Additional messages delivered beyond the sampled committed fence remain in the interval
with their original observation times. Later commits are outside the claim.

`finish` can seal the recorder's immutable prefix while the Kafka worker continues. It stops admission without
inventing `STOPPED`, detaching the observer, or changing the epoch's raw transport mode. The whole-worker verifier
remains strict. `verifyResearchCaptureExportPrefix` verifies the sealed bytes without claiming worker closure.
`readResearchCaptureInterval` additionally requires the actual typed cut, continuous delivery, exact inventory,
original bytes, transport timestamps, and reproduced reducer dispositions. A seal or recorder status alone is not
an interval proof. Any recorded capture invalidation conservatively prevents import.

The reader derives the sole manifest address from the exact durable SQL seal, fetches that object and its referenced
seal, and walks the index chain. Each exported metadata chunk must equal its SQL counterpart. The caller supplies
bounded read functions and an aggregate object-byte budget. Each object remains limited to 4 MiB. This bound covers
input object bytes, not total JavaScript memory. No list, credential discovery, or production read path is added.

The adapter emits a gzip replay source and a separately hash-pinned source receipt. Version-two original arrivals
retain exact raw bytes, tagged transport time, receipt order, and native disposition. Existing historical cursor,
snapshot, and control-study code performs replay. Legacy delivery, regeneration, and original capture provenance
cannot be mixed. Tombstones retain their original evidence but fail the native epoch, so an interval spanning one
cannot become a valid replay source. A valid input interval does not imply sufficient decision evidence, complete
controller execution, or profitable strategy behavior. Controller receipts remain unchanged and their coverage is
`UNKNOWN`. Every capture seal, index, and export manifest remains `UNQUALIFIED`.

The native fixture derives topic counts from committed KafkaTopic configuration and the execution controller's
technical topic. It exercises the current 25-partition profile with committed, aborted, and open transactions,
malformed and empty values, then seals an interval while the consumer continues. Unit fixtures also cover the
22-partition profile without technical features, equal-time order, omission and frontier failures, and the existing
snapshot and mechanical control-study path. The control-study smoke deliberately retains missing-decision outcomes.

Run the capture unit tests with `bun test services/bayn/src/research-capture`. The PostgreSQL suite runs through
`test:postgres` against its guarded disposable native database. Existing Kafka and controller regression suites also
exercise the injected observer and verify unchanged execution when it is absent or faulty.

`bash services/bayn/scripts/test-native-receipts.sh` runs the native Kafka and Restate acceptance fixture. It requires
Docker, uses pinned official images, creates random fixture-only SCRAM credentials, publishes ports only on localhost,
and removes only its own containers. CI runs it in the required `native-receipts` job. Its Kafka test passes exact raw
bytes through the real consumer and incorporation owner. Its Restate test verifies schedule, runtime-start, and terminal
receipts against actual journal execution. The PostgreSQL tests also report the allocated size of bounded synthetic
chunks in the real text schema; that fixture measurement is not a production capacity qualification.
