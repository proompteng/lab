# Protective child projection replay receipt

Observed on 2026-11-26 between 09:07 and 09:09 UTC. This is a read-only historical compatibility check, not a
measurement of additional trading opportunities, realized latency improvement, or profit.

- Production source inspected: `d6316076f3668423dab04d6b65f3e95fd4da60fb`.
- Replayed implementation: `65e477fa72377c03362133a301a1c5f20dd702ed`, containing the implementation and lineage
  changes in `808d3da0c0` and `0616aab6653ea32cde78bc1a80d13e4440c6a538`.
- Historical frame window: `received_at >= 2026-11-24T00:00:00Z` and `< 2026-11-26T00:00:00Z`.
- Source: retained `broker_source_events`, `broker_source_event_projections`, `orders`, `broker_events`, and
  immutable `intents` in Bayn PostgreSQL. No account identifiers, order identifiers, credentials, or raw frames are
  reproduced in this receipt.

## Result

| Measurement | Count |
| --- | ---: |
| Retained `held` frames | 139 |
| Retained `accepted` frames | 85 |
| Total selected frames | 224 |
| Historical `UNSUPPORTED_EVENT` receipts | 3 |
| Historical `UNRESOLVED_GAP` receipts | 221 |
| Current SQL lookup proves an exact canonical child identity | 224 |
| Pure replay without canonical child proof returns `ProtectionBindingRequired` | 224 |
| Pure replay with eventual canonical proof returns `Project` | 224 |
| Replayed frames that fabricate or emit a fill | 0 |
| Exact raw order source timestamp already retained canonically | 17 |
| Normalized content hashes equal for those exact retained versions | 17 |
| Normalized content hash mismatches for those exact retained versions | 0 |
| Selected versions without an exact retained raw source timestamp | 207 |

All 224 candidates had one inherited parent intent binding and an eventual canonical child identity. The 17 hash
comparisons verify complete normalized order content, including the inherited parent and intent, against the actual
retained canonical event. The other 207 frames have no exact historical source version to compare; this check makes
no hash-equivalence claim for those absent versions.

## Reproduction procedure

The selected event cohort is exactly:

```sql
SELECT s.account_id, s.notification, p.outcome, p.reason,
       (s.notification->>'frameJson')::jsonb->'data' AS data
FROM broker_source_events s
JOIN broker_source_event_projections p USING (account_id, event_id)
WHERE s.event_kind = 'TradeUpdate'
  AND s.received_at >= '2026-11-24'::timestamptz
  AND s.received_at < '2026-11-26'::timestamptz
  AND (s.notification->>'frameJson')::jsonb->'data'->>'event'
      IN ('held', 'accepted');
```

For each event, the temporary export included its original notification, prior projection outcome and reason,
the latest retained child order with the same account, broker order ID and client order ID and a non-null parent,
and the immutable intent binding referenced by that child. The order shape used the current `OrderSchema`, with
database integer values rendered as strings and `observedAt` rendered as UTC milliseconds. The binding included
`intentId`, `clientOrderId`, `symbol`, `quantityAtoms`, and `protection`. Latest order selection used descending
`broker_events.source_sequence`.

Separately, the literal SQL inside `readProtectionOrder` in
`services/bayn/src/db/broker-observations.ts` at the replayed commit was extracted without changing its predicates
and evaluated as a lateral join over the same cohort. Only its three bound inputs were substituted with each
event's account, `data.order.id`, and `data.order.client_order_id`. This returned 224 rows and 224 non-null proofs.
It verifies the full parent-root, account, client, intent, symbol, direction, quantity, order type, duration and
immutable protection-price conditions used by the production lookup; matching a symbol or group ID alone is
insufficient.

The actual patched pure projector was then invoked in an isolated owned checkout:

```typescript
const withoutProof = projectBrokerTradeUpdate(notification, bindings)
const withProof = projectBrokerTradeUpdate(notification, bindings, canonicalChildOrder)
```

The resulting tags, emitted fill presence, prior receipts and frame event types were counted. For every `Project`,
the order's `contentHash` was compared with `broker_events.normalized_content_hash` when this exact source identity
already existed for the same account and `event_kind = 'ORDER'`:

```sql
source_event_id = 'order:' || data.order.id || ':' || data.order.updated_at
```

The concatenation above denotes the original JSON string values, preserving the raw provider timestamp precision.
No rounding, replacement of the historical version, or timestamp-only equality was used. The temporary raw export
and replay runner were removed after aggregation. The replay made no broker request and wrote no database state.

## Availability and financial limits

The proof lookup intentionally uses the canonical associations available on November 26. It does not establish
that those associations were present when each frame originally arrived on November 24 or 25. Real first-child
delivery can precede the submit response and canonical capture. The implementation requests reconciliation, releases
the writer fence and defers only recognized nonfinancial lifecycle observations until the original `receivedAt`
plus the configured operation timeout. It writes no projection receipt during that wait. Expiry without proof
remains fail-closed. Original-arrival recovery rates and execution latency must be measured in the next live PAPER
session after rollout.

The SQL child association proves identity, not accounting completeness. The session financial fence and complete
history requirements still apply; projection never posts money. Existing poisoned session receipts remain
immutable. Normal Kargo promotion updates the Bayn and broker-feed source pairing. `VerifiedBrokerFeed.collect()`
verifies the account, creates a new UUID session, authenticates and subscribes, then publishes a new `SessionReady`.
That replacement session can use the fast path only after its own boundary is financially reconciled. No manual
receipt deletion, gap reset, synthetic order or unguarded reconnect was performed.

## Verification associated with the implementation

The focused projector, Restate and order-version decision run passed 92 tests. The tests include zero-fill
`held`/`accepted` semantics; early child binding, invalid/mutated frames, bounded expiry, replay and persistence
failure; canonical parent propagation; and strict precision-equivalent full-content comparison. All-code and
production TypeScript checks, formatting, both lint modes, and the build passed. The final small test-only await
cleanup was followed by 47 passing Restate tests.

Sixteen PostgreSQL integration fixtures were added for exact child lineage, foreign/conflicting parents and terms,
and a child observed after the latest capture claim without granting financial coverage. They were not run against
production. Local PostgreSQL was unavailable; real PostgreSQL execution belongs to the exact combined-head CI
gate. A duplicate full-suite run was intentionally cancelled while the root integration run continued, after
2,698 passing and 1,428 skipped test reports with no failed test report; this partial run is not a full-suite pass.
