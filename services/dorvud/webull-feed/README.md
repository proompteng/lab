# Webull ingestion

This Kotlin service captures the free Webull OpenAPI US stock/ETF Nasdaq Basic feed in
`dorvud.webull.raw.v1`. The existing Flink market-data archive writes it to
`signal.webull_market_events_v1`. Bayn's Alpaca inputs, indicators, execution, and capital controls
have no Webull dependency.

## Coverage

The November 1, 2026 backend probe accepted 500 distinct streaming symbols: 100 on each of five
simultaneous sessions. Each session rejected an additional single symbol with
`TOO_MANY_SYMBOLS_SUBSCRIPTION`. That established subscription admission, not live delivery. The
collector records admission separately from delivery. Active-market probes on November 2 showed data
moving to the most recently updated session: reasserting 100 admitted symbols on session 0 started its
data; updating session 1 then stopped session 0's data while both connections remained online. The
verified concurrent delivering set was 100 symbols, despite 500 admissions. The collector therefore
uses one active connection and discovers its capacity from provider responses instead of assuming a
permanent total symbol cap. Additional idle connections do not count as delivered coverage.

Webull documents [five concurrent connections, a one-minute reconnect wait, and at most three pushes
per second per connection](https://developer.webull.com/apis/docs/market-data-api/data-streaming-api/).
The collector uses unique session IDs, reconnects after 60 seconds, and resubscribes explicitly.
[Subscription requests](https://developer.webull.com/apis/docs/reference/subscribe/) contain at most
100 symbols and request depth-one QUOTE and TICK without overnight access. Configured priority symbols
fill scarce slots first; remaining candidates are alphabetical. This feed does not establish
consolidated SIP/NBBO or complete all-exchange tick coverage.

Full v3 cursor pagination for COMMON_STOCK and ETF produced 55,381 rows and 12,295 distinct listed,
active candidates in the initial SDK probe. The later native collector probe validated 59 responses
and found 12,282 current candidates; these observed counts can change. Known OTC exchanges, other instrument types, and inactive
records are excluded with counts. Candidate status is provisional: every channel still needs API
admission and observed data. Catalog identity hashes the sorted symbol/instrument/exchange/type
mapping. Refresh happens daily; a failed refresh leaves existing sessions running.

Completed M1 [bars](https://developer.webull.com/apis/docs/reference/historical-bars/) are requested
for every candidate in batches of 20, with real-time entitlement required and PRE/RTH/ATH sessions.
The production stock-bar endpoint rejected 100 symbols with `ILLEGAL_PARAMETER` and
`symbols size must be between 1 and 20.`; a 20-symbol request succeeded. This limit is independent of
the streaming subscription batch size. A full catalog sweep spans several minutes, so the five-minute
window retains completed bars across those sweeps; `/coverage` reports each symbol's actual latest bar time.
Each batch uses a current completed UTC-minute cutoff and a five-minute recovery window, so later
batches do not remain pinned to an earlier sweep's window. Request pacing is
four calls/second for market data and less than one call/second for instrument pages, below the
[documented endpoint limits](https://developer.webull.com/apis/docs/rate-limits/). HTTP 429 respects
numeric or HTTP-date Retry-After without truncating long cooldowns, or waits 60 seconds. The final
429 cooldown also applies to subsequent batches. Bounded 5xx retries apply to read-only calls; uncertain subscription
failures reconnect instead of blindly repeating side effects.

One invalid symbol rejects a whole provider batch. Bisection isolates invalid symbols without
excluding valid peers. Invalid symbols are retried after catalog refresh. Empty responses remain
empty: no synthetic bars or implied coverage. Webull can include an older cached bar outside the
requested window. The raw response remains intact; coverage and archive observation indexes exclude
out-of-window and unfinished bars without discarding their completed peers. `/coverage` counts those
exclusions in `excludedOutOfWindowBars`. Malformed prices or non-minute timestamps still fail validation.
Expired recovery windows, disconnects, failures, and
unknown gaps across process starts are archived as collector gap records. Initial invalid-symbol
discovery can take several minutes; `/coverage` reports requested, observed, invalid, and uncovered
symbols independently.

## Capture and archive

Every successful market-data HTTP response and quote/tick/notice MQTT message retains exact native
bytes as base64, SHA-256, nanosecond receipt time, UUID capture identity, and transport provenance.
HTTP provenance includes the public endpoint, query, requested symbols, and body; MQTT provenance
includes session ID and topic. Authentication headers and secrets never enter the contract.
Numeric strings and raw provider timestamps remain unchanged. The protobuf inspector reads the
[provider's message fields](https://developer.webull.com/apis/docs/market-data-api/data-streaming-api/)
without converting prices or sizes to binary floating point.
MQTT observation indexes and freshness checks use `Basic.timestamp`, which the official SDK converts
from Unix milliseconds to UTC. Live stock `Tick.time` values contain only a clock such as `04:04:58`;
they remain in the native payload. MQTT latency measures the provider message timestamp against receipt,
without inferring a date or timezone for that clock. Completed bars use their native `time` field.

The HTTP signer follows the official Python SDK 3.0.4 HMAC-SHA256 implementation, verified against a
fixed independent vector and a real provider call. The older SHA1 prose example does not match the
working backend protocol.

Captures are bounded to 4 MiB and Kafka records/fetches to 8 MiB. At most 17 accepted captures
are retained across ingress and outstanding Kafka deliveries, matching the previous queue plus its
one pending delivery. One sender submits records in ingress order; independent acknowledgments return
capacity without waiting for another partition. Coverage advances only after Kafka acknowledges each
capture. Backpressure blocks producers. The `webull_kafka_ack_seconds` timer records actual producer
acknowledgment duration separately from downstream archive lag. An MQTT enqueue timeout retains the in-flight capture, disconnects,
and transfers it to the publisher before reconnecting, even if normal backpressure lasts beyond five
seconds. Only service shutdown imposes a drain deadline. Graceful shutdown stops inputs first and allows the independently
owned publisher up to 20 seconds to drain accepted captures; an exhausted deadline logs a gap.
Kafka retries preserve the capture UUID. Ambiguous acknowledgments
can still create multiple offsets for one UUID; these are identifiable capture retries.

Flink keeps a separate source/group and stable operator UIDs. Existing Alpaca operators are unchanged.
It validates the envelope hash and source identity before acknowledging progress. Malformed native
payloads remain archived with `REJECTED` status. Invalid envelopes fail the job rather than silently
committing their offsets. ClickHouse stores the original Kafka envelope and coordinates; `FINAL`
collapses archive retries of the same topic/partition/offset through ReplicatedReplacingMergeTree.
Physical storage can contain those duplicates until merges run. Unique capture IDs distinguish
publisher retries at different offsets. Kafka retains seven days; ClickHouse retains 30 days by
receipt time. Bars are validated against the captured completed request window.

## Credentials and delivery

The intended `webull-openapi-ingestion` item in the infra 1Password vault owns only `app-key` and
`app-secret`. The ExternalSecret imports exactly these two fields into the torghut namespace, with
`refreshPolicy: CreatedOnce` and `refreshInterval: 0s`. There is no vault-wide import or periodic
rotation sync. To rotate, update the approved 1Password item and recreate only its managed Kubernetes
Secret through an authorized operation; restart the collector afterward. Do not reset the existing
Webull application merely to copy its credentials. OpenAPI entitlement differs from terminal and
hosted MCP entitlement and must be checked in the account console.

Main builds publish the immutable `torghut-webull-feed` image through the shared OCI workflow. Its
Warehouse admits only eligible Kargo tags with matching source/revision and a CI receipt. The exact
Stage policy promotes to `kargo/torghut-webull-feed`, writes the digest and source revision, and updates
the corresponding Argo Application. The source's `unpublished` placeholder is never a deployment
artifact. Archive/schema changes use the existing torghut Kargo delivery path. The archive writer
needs INSERT only on the new table; grant approval is separate from source validation.

Deploy in this order: Kafka topic; reviewed ClickHouse schema/grant and archive image/config; collector
credential and eligible collector image. Recovery stops the collector through committed desired state,
leaving retained Kafka/ClickHouse data intact. No broker order path is present.

## Validation

From `services/dorvud`, use the pinned development shell:

```sh
./gradlew ktlintCheck :platform:test :webull-feed:test :technical-analysis-flink:test :webull-feed:installDist :technical-analysis-flink:uberJar
```

The tests exercise native Paho MQTT delivery and broker disconnect, native HTTP byte preservation,
rate limiting, redirect rejection, SDK signature parity, variable subscription ceilings, invalid-batch
isolation, exact decimal/timestamp serialization, unfinished-bar rejection, archive bindings, and
unchanged existing Flink operator IDs.

The installed main accepts `probe` for a bounded direct HTTP/MQTT authentication/admission check.
Do not run it alongside the production collector: another streaming subscriber using the same backend
key can take over delivery even when the production connection remains online.

The production service exposes `/healthz`, `/readyz`, `/coverage`, and `/metrics` on port 8080.
Readiness establishes recent Kafka acknowledgments and admitted connections; actual market delivery
requires inspecting the captured data. Coverage describes this process's acknowledged observations,
not ClickHouse completion, and raw timestamps of unrecognized formats are reported as unparsed.

Run `ai.proompteng.dorvud.webull.WebullFeedAppKt verify` using the deployed collector's classpath and
Kafka environment. Send a JSON object containing the existing authorized ClickHouse reader's
`username` and `password` on stdin through an approved secret path; never place them in argv or a
saved report. The verifier reads the last 50 Kafka records per partition without committing offsets,
plus a recent Kafka witness for each archived market channel so intervals between bar sweeps cannot
hide coverage. It
compares exact envelopes, hashes, identities, and nanosecond receipts with ClickHouse FINAL, and
reports sampled symbol coverage, source ages, archive lag, bytes, recent table coverage, and local
replica storage. Bar source age includes the completed bar's interval and collection cadence; it is
not wire latency. The verifier exits unsuccessfully until MQTT quotes, MQTT trades, and nonempty
completed bars are all observed with parsed recent provider times: within two minutes for MQTT
quotes/trades and six minutes for completed bars, measured against the verification clock and allowing
at most five seconds of future clock skew. Provider-to-receipt lag remains a separate diagnostic.
Old cached ticks or a delayed bar sweep cannot establish active-market acceptance. Run during
PRE/RTH/ATH market activity.

Runtime acceptance also requires the deployed revision/digest, a controlled restart/reconnect with
new session/subscription receipts, and archive replay readback. Local tests or admitted subscriptions
alone do not establish production acceptance. A closed market can leave active-market verification
pending after infrastructure deployment.

## Normalized research bars

The existing Flink archive additionally indexes validated completed M1 bars in
`signal.webull_market_events_v1.minute_bars`, preserving native decimal strings and `PRE`/`RTH`/`ATH` sessions.
`bar_requests` retains per-requested-symbol `OBSERVED`, `EMPTY`, `EXCLUDED`, `OMITTED` and `REJECTED` states.
Raw envelopes and source coordinates remain the archive identity; recovery repeats are collapsed at research read time.
Existing rows are not rewritten by adding these indexes; retained rejected captures require explicit replay through
the corrected archive decoder with their original envelope and Kafka coordinates.
