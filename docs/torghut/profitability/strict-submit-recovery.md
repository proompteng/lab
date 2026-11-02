# Strict Submit Recovery

Status: normative Slice 5 contract. Source, CI, image, GitOps, and live response-loss evidence are all required before
the slice is production-proven.

## Decision

An order submission whose broker response is missing or ambiguous is an unresolved economic fact. Torghut must recover
that fact through broker reads using the original deterministic client order ID. It must never create a replacement
client ID, call submit again, infer rejection from elapsed time, or delete the unresolved evidence.

This is stricter than the original roadmap wording. `expired` is an operator-visible unresolved projection, not an
automatic terminal outcome. Alpaca explicitly warns that a timed-out request may still have reached the market and
must not be resent or marked canceled before confirmation from Alpaca's trading team; see
[Broker API Trading](https://docs.alpaca.markets/us/docs/brokerapi-trading). Two negative reads therefore do not prove
that an order never existed.

Real-capital risk-increasing submission remains blocked. Slice 5 recovers submit ambiguity; it does not prove
profitability, accounting completeness, or the Slice 6 fencing of cancel, replace, and closeout mutations.

## One Durable Authority

Recovery extends the Slice 4 append-only receipt and, when present, its linked decision-submission claim. It does not
introduce another recovery table, queue authority, or broker-intent identity.

The immutable recovery identity is:

`broker route + account label + endpoint fingerprint + operation + original client request ID + sealed request hash`

The append-only `broker_mutation_receipt_events` stream owns receipt lifecycle truth. A linked
`trade_decision_submission_claim` is fenced and transitioned with the receipt. The PostgreSQL trigger and application
transaction both enforce the paired terminal transition; neither record may settle on its own.

The recovery route protocol exposes only:

- broker observation by the original client request ID;
- an independent local-activity read used only after broker absence;
- construction and persistence of a settlement from broker-observed evidence.

It exposes no submit, replace, cancel, or closeout method. `automatic_resubmission_attempted=false` is sealed into every
recovery observation and settlement envelope.

## State Contract

The public six-state projection is intentionally distinct from the four durable receipt states:

| Public projection   | Durable receipt state           | Meaning                                                                                   | Automatic terminal?                |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| `claimed`           | `claimed` or pre-I/O `released` | Broker I/O has not been proven to start                                                   | No                                 |
| `submitted_unknown` | `broker_io`                     | Broker I/O started; observation is absent, incomplete, conflicting, or not yet old enough | No                                 |
| `acknowledged`      | `settled`                       | Broker observation proves that the original order existed                                 | Yes                                |
| `rejected`          | `settled`                       | Broker observation explicitly reports rejection of the original order                     | Yes                                |
| `expired`           | `broker_io`                     | Two compatible complete absence observations passed the grace/spacing window              | No; operator confirmation required |
| `manual_review`     | `broker_io`                     | Indeterminate evidence exceeded the automatic review window                               | No; operator confirmation required |

`expired` in this table is not the Alpaca broker order status `expired`. If Alpaca reports an order with status
`expired`, the order existed, so submission recovery is `acknowledged`. Only an observed broker `rejected` status is an
automatic negative terminal.

An `expired` or `manual_review` receipt remains due on a long retry interval so later broker truth can reconcile it. It
continues to block entry. The only reviewed operator terminal is the narrow
[infrastructure-validation quarantine closure](validation-quarantine-closure.md): an unlinked, non-promotable
Alpaca-paper IOC may close its future-exposure quarantine after fresh exact-order, history, open-order, position, and
account proof. That outcome preserves order existence as unresolved and is unavailable to ordinary or live submits.

## Recovery Algorithm

1. Query due `submit_order` receipts for the routes owned by this process. Route and operation filtering happens in
   PostgreSQL before `LIMIT`, so older receipts for another runtime cannot starve the owned route.
2. Acquire a fenced recovery lease using a process owner, writer generation, token, and monotonically increasing epoch.
3. If the receipt links a decision-submission claim, acquire its recovery lease with the same token. If that fails,
   release the receipt lease and do no broker read or terminal write.
4. Read the broker by the exact original client order ID.
5. When an order is found, validate the client ID, symbol/coin, side, size, limit, every broker field present in the
   observation, account route, and stable broker status against the sealed request. A mismatch or unknown status is
   indeterminate, never best-effort.
6. When the exact lookup is absent, read bounded broker history. Only a complete bounded result may contribute to an
   absence observation. Conflicting broker IDs are indeterminate.
7. Only after broker absence, query independent durable activity. An Execution, order-feed event, or Hyperliquid order
   row conflicting with broker absence makes the result indeterminate.
8. A found order settles from broker truth. For a linked Alpaca claim, Execution persistence, pending order-feed event
   linkage, claim settlement, and receipt settlement commit atomically. A transaction failure rolls all of them back.
9. A negative or indeterminate read appends a nonterminal recovery observation and schedules another read. It never
   issues broker I/O other than reads.

Process death, lease expiry, or leader change is handled by the durable epoch and token fences. A stale owner cannot
append an observation or terminal settlement after a newer recovery owner acquires the receipt.

## Broker-Specific Evidence

### Alpaca

The exact identity read is Alpaca's
[order-by-client-order-ID endpoint](https://docs.alpaca.markets/us/reference/getorderbyclientorderid). A strict HTTP 404
is absence; malformed success payloads, timeouts, authentication failures, server errors, and unknown SDK behavior are
indeterminate.

After an exact absence, recovery reads one all-status order-history page bounded from five minutes before durable
`broker_io_started_at` through the observation time, with a maximum of 500 rows. A full page is incomplete. A single
matching client ID and broker order ID is found evidence; duplicates or conflicting IDs are indeterminate.

The accepted status taxonomy is explicit and follows Alpaca's documented
[order lifecycle](https://docs.alpaca.markets/us/docs/orders-at-alpaca) plus the SDK statuses `pending_review` and
`held`. `rejected` is broker-observed rejection. Every other known status proves order existence and reconciles the
submission. A future unknown status fails closed.

Alpaca account/activity streaming is a separate financial-state surface and may lag order state; see
[Activity SSE](https://docs.alpaca.markets/us/docs/activity-sse). Local Execution and order-feed evidence is therefore
used only as a conflict check after broker absence, not as a prerequisite for a found-order settlement.

### Hyperliquid

The exact identity read is `orderStatus` by CLOID. On an exact hit, recovery returns immediately and does not call
history or fills. On an exact miss, it reads `historicalOrders` and `userFillsByTime` over the durable I/O window. Each
surface is bounded at 2,000 rows; a full result is incomplete. Exact/history/fill matches are deduplicated by broker
order ID, and conflicting IDs are indeterminate. The contracts and status taxonomy come from the official
[Info endpoint](https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/info-endpoint).

A matching fill proves that the original order reached Hyperliquid, but one fill does not prove that the complete
requested quantity filled. Fill-only recovery therefore persists the conservative `accepted` order state, does not
invent a time-in-force value absent from the fill, and leaves terminal quantity and status to normal fill
reconciliation.

The runtime rate budget follows Hyperliquid's official
[rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits): 1,200
aggregate REST weight per minute, `orderStatus` weight 2, most info calls weight 20, and history/fill calls add one unit
per 20 returned rows. A worst-case miss costs `2 + (20 + 2000/20) + (20 + 2000/20) = 242` weight. Production therefore
runs at most one receipt per 60-second recovery interval, leaving at least 958 weight for ordinary runtime reads. The
worker uses batch size one and a ten-second per-request timeout. A top-level recovery failure becomes a fail-closed
dependency and cannot crash the main reconciliation/control cycle.

## Runtime And Readiness Contract

Recovery state is projected through `/trading/status`, scheduler metrics, and Hyperliquid runtime dependencies. The
original client order ID cannot re-enter broker I/O while its receipt is unresolved. Hyperliquid also treats its
route-scoped recovery dependency as an entry-readiness gate.

The `/trading/status` action-authority projection reports new entry blocked when any of the following is true:

- recovery is disabled or not wired;
- durable receipt status cannot be read;
- a receipt remains in `broker_io`, including `submitted_unknown`, `expired`, or `manual_review`;
- a recovery cycle reports a failed receipt or a top-level worker failure;
- linked claim/receipt state is inconsistent.

The status database query aggregates latest states in SQL and extracts only unresolved evidence fields in SQL. It
does not load every historical successful receipt. Recovery degradation must not take down the read-only control
surface or broker/account reconciliation. It blocks new entries while risk-reduction capability remains governed by
its separate authority contract.

## Tests Required For Merge

- lost response with an accepted/fill/canceled order settles the original ID and produces no second submission;
- explicit broker rejection settles as rejected;
- exact absence plus bounded history absence remains nonterminal;
- two compatible complete absence observations produce a nonterminal unresolved `expired` state for linked and unlinked
  receipts;
- incomplete pages, delayed local activity, unknown statuses, malformed payloads, conflicting IDs, and read failures
  remain indeterminate;
- a partial Hyperliquid fill proves submission without fabricating a fully filled terminal order;
- found broker truth does not depend on the local activity query succeeding;
- recovery owner death, lease expiry, stale epochs, and concurrent owners preserve one writer;
- linked Execution, order-feed linkage, claim, and receipt settlement are atomic and rollback-safe;
- foreign-route work cannot starve an owned route at batch size one;
- Hyperliquid exact hits skip heavyweight history/fill calls and service cadence enforces one worker run per interval;
- disabled or failed recovery blocks entries without crashing reconciliation;
- migration trigger tests reject partial or fabricated terminal transitions.

## Rollout And Independent Proof

The production proof chain is:

`source tests -> CI -> immutable image -> GitOps promotion -> Argo sync/health -> direct runtime status -> broker read -> CNPG receipt/claim history`

The controlled proof injects loss after a paper/sandbox submit reaches the broker but before the local response is
persisted. It must show exactly one original broker order, one deterministic client ID, one terminal receipt/claim pair,
and zero additional submit attempts. Broker readback and CNPG history are both required; either alone is insufficient.

For a pre-existing unresolved receipt, production validation is observation-only: query the exact original ID and let
the deployed worker append evidence. Do not create a new client ID or another broker mutation merely to make the proof
terminal. If and only if the receipt satisfies the paper-IOC validation boundary, use the separately reviewed operator
procedure; never relabel it broker-rejected.

## Rollback

Set the recovery worker disabled through GitOps while leaving the append-only data intact. Entry must remain blocked,
the status/control endpoint must remain available, and no unresolved receipt may be released, deleted, relabeled
rejected, or retried. Re-enable only after the fault is corrected and the same original IDs can be observed safely.
