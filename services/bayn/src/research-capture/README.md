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
capture identities, epochs, and legacy ordering. Legacy whole-file replay and export manifests reject original-order
receipts until an independently qualified manifest can bind them. The existing reducer and evaluator remain the only
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

This patch does not export raw values, assert a session is complete, qualify a strategy, or enable model calls. Before
production acquisition, qualification must prove raw-byte export/readback, every source frontier and control offset,
full controller lifecycle joins, restart/replay ambiguity handling, measured storage capacity, and bounded overhead.
Kafka retention alone cannot recover an earlier consumer's original timing. Object-store capacity and connectivity
alone do not satisfy these gates.

Run the capture unit tests with `bun test services/bayn/src/research-capture`. The PostgreSQL suite runs through
`test:postgres` against its guarded disposable native database. Existing Kafka and controller regression suites also
exercise the injected observer and verify unchanged execution when it is absent or faulty.

`bash services/bayn/scripts/test-native-receipts.sh` runs the native Kafka and Restate acceptance fixture. It requires
Docker, uses pinned official images, creates random fixture-only SCRAM credentials, publishes ports only on localhost,
and removes only its own containers. CI runs it in the required `native-receipts` job. Its Kafka test passes exact raw
bytes through the real consumer and incorporation owner. Its Restate test verifies schedule, runtime-start, and terminal
receipts against actual journal execution. The PostgreSQL tests also report the allocated size of bounded synthetic
chunks in the real text schema; that fixture measurement is not a production capacity qualification.
