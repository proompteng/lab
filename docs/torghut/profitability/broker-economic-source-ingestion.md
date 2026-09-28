# Broker Economic Source Ingestion

Status: Slice 7 implementation design

Last updated: 2026-07-16

## Decision

Torghut retains one order-update stream authority:

`Alpaca trade_updates -> Dorvud -> torghut.trade-updates.v2 -> OrderFeedIngestor`

It does not create a second Alpaca WebSocket client in the scheduler. The existing Dorvud stream already owns
authentication, reconnect, readiness, Kafka publication, and transport deduplication. Slice 7 adds immutable broker
source preservation at the point where Torghut consumes that stream and adds a read-only paginated account-activity
backfill as the independent recovery path.

This is a provider-constrained implementation, not a claim that order updates are a complete financial activity
stream. Alpaca's unified Activity SSE is the preferred complete source, but `/v2beta1/events/activities` requires
Broker API credentials. Torghut currently has Trading API credentials; a production paper-account probe against that
endpoint returned HTTP 404. Therefore `trade_updates` supplies a low-latency second observation only for fills and
corrections, while paginated Trading API account activities remain the complete source for fees, cash movements, and
corporate actions. Capital evidence must fail closed whenever that REST cursor is not current. If Broker API access is
provisioned, replace this constrained stream lane with Activity SSE and retain `trade_updates` only for order lifecycle.

The broker is the executed-economic authority. Strategy decisions, execution rows, and the existing runtime ledger are
linkage or projection surfaces; none of them may invent fills, fees, cash movements, corrections, or corporate actions.

## Verified broker contracts

The implementation follows Alpaca's official [trade-update WebSocket contract](https://docs.alpaca.markets/us/docs/websocket-streaming)
and [account-activity contract](https://docs.alpaca.markets/us/docs/account-activities), including the documented
[exclusive ascending page token](https://docs.alpaca.markets/us/reference/getaccountactivities-2).

Production paper-account readback established these details before implementation:

- the stream broker payload carries stable `event_id` and `execution_id` values;
- a fill's stream `execution_id` matches the UUID component of the corresponding REST account-activity ID;
- stream timestamps can contain nanoseconds while REST returns the same event at microsecond precision;
- fill order ID, symbol, side, event quantity, event price, and timestamp agree across the two sources;
- the REST request can consume most of its 10-second timeout, so it cannot run on the signal-decision or mutation-
  recovery critical path.
- the unified Activity SSE requires Broker API credentials and is not exposed by the configured Trading API endpoint.

## Immutable source record

`broker_account_activities` stores both source families:

- `trade_updates_ws`: the exact observed trade-update payload extracted from the Dorvud envelope after transport-only
  metadata is removed; Dorvud's `account_label` remains as source provenance;
- `account_activities_rest`: the exact REST activity document.

Each row contains:

- provider, source, broker environment, account label, and endpoint fingerprint;
- stable broker identity plus Kafka topic/partition/offset or REST page token;
- common normalized fields for orders, fills, cash, fees, corrections, and corporate actions;
- canonical source JSON and its SHA-256 digest;
- a second SHA-256 digest over cross-source economic identity fields;
- first-observed timestamp.

PostgreSQL rejects update, delete, and truncate operations. Its insert trigger verifies that canonical JSON decodes to
the stored JSON document and that its SHA-256 digest is correct. The mutable REST cursor is deliberately isolated in
`broker_account_activity_cursors`.

## Identity and deduplication

Stream identity uses the first available value in this order:

1. broker `event_id`;
2. broker `execution_id`;
3. Torghut's stable event fingerprint only as a legacy fallback.

Kafka sequence, ingest timestamp, topic offset, and Dorvud envelope metadata are excluded from broker identity and raw
payload hashing. This makes a reconnect redelivery idempotent even when the transport sequence changes. Re-observing
one broker identity with different broker bytes is a hard contradiction and prevents the Kafka cursor from advancing.

REST identity is Alpaca's activity ID. A repeated ID with the same payload is a duplicate; a repeated ID with different
bytes is a hard contradiction.

## Cross-source normalization

The normalized economic digest includes account scope, environment, activity type/subtype, UTC event time at
microsecond precision, settlement date, order ID, canonical symbol, side, event quantity, event price, net amount,
currency, and correction reference. It deliberately excludes source-specific IDs and transport metadata.

For fills, the stream normalizer uses event-level `qty` and `price`, not cumulative order quantity or average order
price. This makes the normalized multiset comparable to REST `FILL` activities across partial fills.

Alpaca stream timestamps can carry nanoseconds while the REST activity for the same execution is rounded to six
fractional digits. Torghut applies the broker-compatible half-up microsecond conversion before persisting `event_at` or
computing the normalized digest; Python's default nanosecond truncation is not an equivalence rule. Raw payload bytes
and their source hashes remain unchanged.

`scripts/verify_broker_economic_source_equivalence.py` compares the two fill multisets over an explicit UTC window. A
proof is complete only when both sources contain the same nonempty multiset. The report retains both sources' raw
payload hashes and reports every missing normalized hash.

## Runtime scheduling

REST backfill runs as one bounded background task per scheduler process:

- it starts after the first trading iteration;
- it never blocks signal decisions, order-feed consumption, broker mutation recovery, or emergency reduction;
- only one task may be in flight;
- one pass drains at most three pages, bounding normal shutdown by the per-request timeout budget;
- cursor row locking and compare-and-swap checks prevent a stale worker from advancing a changed scan;
- each completed scan overlaps the previous five minutes to absorb delayed broker activities.

Expected REST failures update cursor state and metrics but do not make Kubernetes readiness false. Economic authority
and later capital promotion must fail closed when the cursor is missing, scanning, errored, or stale.

## Required proof

Local and CI proof must cover:

- ascending page-token boundaries and bounded multi-page drain;
- restart from the durable page token;
- reconnect replay with changed transport sequence;
- out-of-order and duplicate order updates;
- hard contradiction on changed bytes for one broker identity;
- dividends, splits, corrections, fees, and cash-shaped activities;
- database-enforced hash validity and append-only behavior;
- stream/REST normalized fill equality with different timestamp precision;
- fail-closed CLI exit for empty or mismatched evidence;
- isolation of a slow or failed REST lane from trading and reconciliation loops.

Production proof requires a fresh paper lifecycle, an intentional stream-consumer interruption or replay, completed REST
backfill, a nonempty equivalent report, matching raw source hashes, and independent broker/CNPG readback. That proof is
Slice 7 evidence only; it does not establish ledger parity, strategy profitability, or capital promotion.

## Deferred to later slices

- Slice 8 owns the independent double-entry reducer and accounting identities.
- Slice 9 owns complete decision/order/fill linkage and classified manual activity.
- Slice 10 owns fresh full TigerBeetle economic parity and entry/promotion gating.
- No live-capital authority is granted by this ingestion path.
