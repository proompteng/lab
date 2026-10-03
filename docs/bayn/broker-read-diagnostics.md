# Broker response diagnostic evidence

The native Alpaca reader derives a small observational sidecar from account and USD fee responses it already fetches.
It does not issue diagnostic requests, change financial normalization or hashes, post accounting, or grant authority.
It uses the existing provider endpoint, account binding, HTTP budget and structured log sink. No alternate route or
additional credentials are introduced.

`brokerReadDiagnostic` logs use `bayn.broker-read-diagnostic.v1`. They contain provider/environment provenance and the
existing broker identity hash. Account IDs, activity IDs and request IDs are not logged in plaintext. Activity and
request hashes use the domain-separated canonical hash domains `bayn.fee-diagnostic-activity.v1` and
`bayn.fee-diagnostic-request.v1`. Each item includes its original response hash and observation time. Response hashes
can be correlated with existing read evidence; metadata from different responses is not presented as one atomic cut.

The allowlist covers optional fee status, subtype and timing fields and optional account `accrued_fees` and
`pending_reg_taf_fees`. Absence, null, invalid types and unrecognized values remain explicit. These optional fields
are not promised by the Trading API contract. Recognized strings are reported lexical values, never settlement or
booking authority. The description field contributes only presence/type and a non-authoritative REG/TAF/CAT prefix
category. Free text, unknown strings, raw response bodies, account numbers, credentials, absolute balances and
equity-minus-cash are excluded. Diagnostic fee decimals retain their reported precision without financial rounding.

The reader retains at most 128 fee identities, favoring newer reported dates. An event has at most 32 fee records and
16 KiB of serialized diagnostic content. `omittedRecords` counts excluded observations, not unique historical
identities; `pendingRecords` counts retained changes deferred to a later event. `retentionTruncated` is sticky for
the reader lifetime, and `incomplete` stays true after retention overflow even once pending records drain. Repeated
omission-only observations are silent after truncation has been reported. The first
flush occurs on a normal successful read at least 60 seconds after reader creation; later flushes are at most once
per 60 seconds. Changed metadata is coalesced; fresh timestamps and response hashes alone do not trigger another
event. A worker replacement can repeat a bounded snapshot. This sampled log is not complete financial history.

Raw JSON has only its existing request lifetime; safe sidecar state is in memory. Emitted evidence inherits the
existing log sink's access and retention. This code creates no new durable store or retention policy and does not
promise a log TTL. Extraction and sink defects cannot replace a provider result; cancellation is still propagated.
Failed HTTP reads, financial decoding, or account binding do not emit trusted diagnostic observations.

The account-keyed broker observation owner polls independently of execution authority. Normal deployment activation
activates that observer before waiting for the execution controller's successor pass. Therefore these diagnostics
can be collected by existing reads while execution activation is blocked. If the reader itself cannot run, there
is no diagnostic bypass or forced activation.

Provider references: [Trading API account activities](https://docs.alpaca.markets/us/docs/account-activities) and
[account fields](https://docs.alpaca.markets/us/docs/account-plans). Richer Broker API/SSE fields are not assumed to
exist on the Trading API. Changes to fee cash semantics, booked entries or authority require separate evidence and
review; this diagnostic path makes none of those changes.
