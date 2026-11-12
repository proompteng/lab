# Matched streaming migration evidence

These tools provide separate source-transport and financial-engine proofs. Neither measures the complete production
Dorvud WebSocket → Flink → Bayn → broker fill path. Do not add stage percentiles or describe offline cadence as streaming
latency. Synthetic provider responses never prove trading performance or profitability.

Use the repository's pinned Bun 1.4.2 and Node 24.11.1. Artifacts belong outside the shared checkout. No dependency
installation or second checkout is needed.

## Exact source and financial parity

From `services/bayn`, build both selected commits using the same current harness:

```sh
bun tools/streaming-benchmark-snapshot.ts <baseline-sha> <absolute-baseline-artifact-directory> exact
bun tools/streaming-benchmark-snapshot.ts <candidate-sha> <absolute-candidate-artifact-directory> exact
bun tools/streaming-benchmark-paired.ts <baseline-directory> <candidate-directory> <empty-report-directory> 5 all
```

The loader reads reachable Git objects without a checkout and records original source, compiled output, harness and
dependency hashes. Installed direct runtime dependency versions must exactly match the selected commit. The optional
`expose-fixture` mode adds only the two recorded replay-factory references; it is instrumented source, and the plain
financial comparison rejects it.

The paired runner alternates baseline/candidate ordering. Every attempt gets fresh isolated PostgreSQL and TigerBeetle
state, the same original market input, economic limits and controlled provider schedule. It retains unsuccessful and
unrun attempts and requires economic and candidate-outcome parity. Binding hashes may differ between source revisions;
the economic projection compared by the runner is explicit in its summary. Five samples make p95 the maximum by the
nearest-rank definition; this is descriptive, not a tail guarantee.

The financial worker executes the real financial engine and persistence with simulated broker ports. Its original
event clock advances with measured database/provider work. Physical CPU/wall measurements exclude initialization and
are reported separately. The worker uses an explicitly offline cadence; it does not exercise the current streaming
controller, deferred inference transport, production expense owner or provider HTTP.

## Kafka reconstruction and original quote deadlines

```sh
node <snapshot-directory>/streaming-benchmark-kafka.js <absolute-report.json> <selected-source-sha> usable peak \
  postgres://bayn@127.0.0.1:55438/<empty-owned-database_test>
```

The source probe creates and removes one disposable local Kafka container on port 19194. It requires an empty owned
local PostgreSQL database and leaves that database for readback; the caller must remove it. Docker operations are pinned
to the desktop's local socket. Synthetic SCRAM credentials have no external authority.

`peak` retains roughly 270,000 quote and 30,000 trade envelopes, calibrated to production rolling-count estimates and
aggregate native value sizes. Ignored padding matches those byte sizes; the synthetic price/symbol distribution is not
a representative strategy session. Uniform density inside the measured peak tail is not a measured 20-second peak.
`burst` keeps that full log and concentrates the busiest observed minute's quote-count estimate inside its last 20
seconds. This is a hypothetical conservative stress case; it runs one cold trial. `mean` and `tiny` are also available.
Full seeded per-topic offsets, timestamp spans,
counts and bytes are reported alongside what the production SDK actually seeks and consumes.

The unchanged retained log contains recent dense quotes up to one millisecond before its final original quote. A warm
projection receives that final tick, then five independent cold projections reconstruct the same window without new
input. Every cold trial uses the original historical anchor plus actual monotonic elapsed time. A bootstrap that misses
the original quote deadline is retained as a missing/expired opportunity. Stale queries must still fail freshness.
The first cold trial also pauses physically beyond the original quote deadline and must then fail freshness. Warm
preload precedes publication of that final tick and is timed separately. Successful cold cuts must retain the exact warm
provider rows; their new receipt/epoch identities are kept separately.

The probe includes actual SDK consumption, market projection, native raw hashing/compression/journaling and PostgreSQL
retention. When available in the selected source, it uses the actual conflated market-hint implementation with its first
delivery blocked. Per-trial metrics are appended before cleanup, and every capture must stop with equal observed/durable
sequence and no queued bytes. Container startup, record seeding and report writing are outside bootstrap timing.

Run CPU-heavy checks separately. Retain host-load context, exact snapshot manifests and all expected opportunity
outcomes. A provisional bundle built from dirty source is diagnostic evidence and must be rerun from the final exact
candidate before making a release claim.
