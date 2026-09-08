# Infrastructure Validation Permit Runbook

Status: operator contract for non-promotable broker-control exercises.

This runbook exercises Torghut's shipped broker-mutation coordinator against a dedicated non-live account. It is not a
candidate trial, profitability evidence, paper-probation authority, or permission to increase real-capital exposure.
Ordinary risk-increasing submission remains blocked throughout the exercise.

## Authority Boundary

An exercise requires `torghut.infrastructure-validation-permit.v2`. The permit is immutable, expires within 15 minutes,
and has different `issued_by` and `approved_by` identities. Approval must come from the infrastructure owner; a research
agent, strategy, healthy route, global trading flag, or account name cannot self-authorize it.

The shipped Slice 4 submit proof accepts only this matrix:

| Venue  | Asset class | Account                                                 | Session      | Submit shape  | Absolute bound |
| ------ | ----------- | ------------------------------------------------------- | ------------ | ------------- | -------------- |
| Alpaca | `crypto`    | exact paper endpoint and broker-reported account number | `continuous` | buy limit IOC | at most `$1`   |

The reusable permit schema also recognizes Alpaca equity/regular-session and Hyperliquid testnet perpetual boundaries
for later exercises. The Slice 4 submit authority intentionally accepts neither route because it does not implement
their independent session and adapter proof. Do not substitute an account with existing orders or positions.

The Alpaca endpoint must canonicalize to exactly `https://paper-api.alpaca.markets`. A terminal SDK-style `/v2` is
removed before classification; the runtime rejects credentials, ports, alternate hosts, every other path, queries,
fragments, and a caller-supplied paper/live mode that conflicts with the URL.
The configured Torghut account label must equal Alpaca's returned `account_number`; endpoint classification alone is
not sufficient.

## Preconditions

Before issuing a permit, record and independently verify:

1. source merge, immutable image digest, promotion merge, active scheduler pod, and active container digest;
2. migration head includes `0068_validation_submit`;
3. scheduler `/healthz` and `/scheduler/readyz` are healthy, while ordinary entry authority remains false;
4. `TRADING_KILL_SWITCH_ENABLED` is false for the bounded exercise;
5. Alpaca returns the expected paper `account_number`, active account status, and active crypto status when applicable;
6. the account has zero positions and zero open orders;
7. the selected asset is active, tradable, and has the requested asset class;
8. no earlier receipt uses the proposed `permit_id` or deterministic client-order ID;
9. the scheduler cannot race the exercise: it is healthy, has no emergency stop latched, and is outside the configured
   scheduled closeout window;
10. the production order-feed ingestor that persists lifecycle fill ancestry remains healthy for the full exercise.

Stop if any identity is missing, aliased, or contradictory. Never infer paper safety from `TRADING_MODE`; the endpoint
and broker account response are authoritative. Kubernetes readiness does not prove scheduler non-interference: after
`TRADING_FLATTEN_START_TIME_ET`, or while an emergency stop is latched, the scheduler will correctly cancel and flatten
broker state and therefore cannot share the account with this exercise.

The scheduler currently owns the only production Kafka-to-PostgreSQL order-feed ingestor. Quiescing it would prevent
the lifecycle runner from proving persisted fill ancestry, so zero scheduler replicas is not an admissible state for
this exercise. If the normal closeout time has passed, merge a temporary GitOps change that moves only the scheduled
paper closeout and flat-confirmation times later than the bounded exercise. Keep exactly one scheduler replica, the
new-exposure cutoff, emergency stop, equity stops, ledger stop, and kill switch unchanged. Wait for Argo CD to
reconcile, require `/scheduler/readyz`, prove that ordinary entry authority remains false and no emergency stop is
latched, and independently reconfirm the account is flat.

Run the lifecycle only from the promoted API revision after proving its container image ID equals the scheduler image
digest. Whether the exercise succeeds or fails, independently read the broker account, restore the normal closeout
times through GitOps, and require `/scheduler/readyz` to recover before ending the operation. A validation runner,
permit, or API pod is never a replacement scheduler or an alternate order-feed authority.

## Build The Input

The input is one JSON object with `plan` and `permit`. Build the plan first, then compute the two immutable digests with
the deployed implementation:

```sh
kubectl -n torghut exec -i deployment/torghut-scheduler -c torghut-scheduler -- \
  python -c '
import json, sys
from app.trading.infrastructure_validation import InfrastructureValidationOrderPlan
from app.trading.infrastructure_validation import infrastructure_validation_order_plan_sha256
from app.trading.infrastructure_validation import infrastructure_validation_terminal_state_sha256
plan = InfrastructureValidationOrderPlan.model_validate(json.load(sys.stdin))
print(json.dumps({"test_plan_digest": infrastructure_validation_order_plan_sha256(plan),
                  "expected_terminal_state_digest": infrastructure_validation_terminal_state_sha256()},
                 sort_keys=True))
' < plan.json
```

Use this plan shape for the continuous-session crypto proof:

```json
{
  "schema_version": "torghut.infrastructure-validation-order-plan.v1",
  "venue": "alpaca",
  "asset_class": "crypto",
  "symbol": "BTC/USD",
  "side": "buy",
  "qty": "1",
  "order_type": "limit",
  "time_in_force": "ioc",
  "limit_price": "1",
  "stop_price": null
}
```

The limit makes the maximum executable notional `$1`; a fill still causes the proof to fail because the expected
terminal state is a known-null account. Do not widen the permit to compensate for broker rejection.

Create a permit with:

- a unique `permit_id`;
- `purpose=control_plane_validation`;
- the exact broker account number and paper URL;
- one symbol, `buy`, `limit`, `max_orders=1`, and `max_outstanding_intents=1`;
- `max_notional_usd=1` and `max_loss_usd=1` or lower;
- an issuance-to-expiry interval no longer than 15 minutes;
- the computed plan and terminal-state digests;
- `evidence_tag=non_promotable_validation` and `promotable=false`.

The permit digest, plan digest, expected terminal-state digest, and deterministic `ivp-...` client-order ID are sealed
into the durable canonical intent. PostgreSQL independently rejects promotable, widened, reused, expired, wrong-side,
wrong-session, wrong-endpoint, or structurally inconsistent validation receipts.

## Execute Once

Pipe the completed object to the active scheduler image:

```sh
kubectl -n torghut exec -i deployment/torghut-scheduler -c torghut-scheduler -- \
  python -m app.trading.infrastructure_validation_submit --input-file - < permit-and-plan.json
```

The runner performs these checks and state transitions:

1. validates the permit, plan, endpoint, configured label, broker account, asset, positions, and open orders;
2. races two coordinators over the same deterministic intent while holding the winner at the broker boundary;
3. requires the contender to be fenced before releasing exactly one broker call;
4. replays the terminal intent and requires `already_processed`;
5. resolves the broker order by the exact client-order ID and requires the same broker order ID, an allowed terminal
   status, and zero filled quantity;
6. waits for zero open orders and zero positions;
7. proves one settled mutation receipt, no trade-decision submission claim, execution, or trade decision, and no
   candidate-linked or TigerBeetle-journaled validation event;
8. emits a compact JSON report tagged `non_promotable_validation` and `promotable=false`.

An acknowledged receipt records the response observed at submit time; the independent client-order-ID read establishes
the later broker terminal state. Neither one substitutes for the other.

## Independent Readback

Capture the emitted client-order ID, permit ID, receipt ID, broker order ID, and timestamps. Query CNPG directly:

```sql
SELECT id, account_label, operation, risk_class, purpose, client_request_id,
       canonical_intent_sha256, created_at
  FROM broker_mutation_receipts
 WHERE client_request_id = '<client-order-id>';

SELECT sequence_no, event_type, state, settlement_outcome,
       broker_reference, recorded_at
  FROM broker_mutation_receipt_events
 WHERE receipt_id = '<receipt-id>'
 ORDER BY sequence_no;

SELECT
  (SELECT count(*) FROM trade_decision_submission_claims
    WHERE client_order_id = '<client-order-id>') AS submission_claims,
  (SELECT count(*) FROM executions
    WHERE client_order_id = '<client-order-id>') AS executions,
  (SELECT count(*) FROM trade_decisions
    WHERE decision_hash = '<client-order-id>') AS trade_decisions;

SELECT id, execution_id, trade_decision_id,
       raw_event -> '_torghut_evidence_contract' AS evidence_contract
  FROM execution_order_events
 WHERE client_order_id = '<client-order-id>';
```

Any matching order event must have `provenance=non_promotable_validation`, `authoritative=false`, `promotable=false`,
and null execution and trade-decision links. It must have no `tigerbeetle_transfer_refs` row. Independently query Alpaca
by client-order ID and re-read positions and open orders. A green Argo badge or a successful CLI exit is not
broker-economic proof by itself.

## Ambiguous Or Failed Outcome

- If failure occurs before broker I/O, retain the rejected/deferred receipt and correct the input only with a new
  permit ID.
- If broker I/O started and the response is missing or ambiguous, do not rerun the command or create a new client ID.
  Preserve the unresolved receipt and query Alpaca by the original deterministic ID. Slice 5 recovery owns resolution.
- If an order filled, an open order remains, or a position exists, stop. Do not claim success. Use an independently
  authorized risk-reduction path after fresh broker observation; never disguise a cleanup order as validation.
- If an event links to candidate data or reaches TigerBeetle, treat it as an evidence-contamination incident and keep
  capital blocked.
- Never delete a permit, receipt, event, or broker fact to make the proof pass.

## External Contract Checked

This implementation was checked on 2026-07-14 against Alpaca's official documentation:

- the [Account object](https://docs.alpaca.markets/us/docs/account-plans) exposes `account_number`, status, block flags,
  and crypto status;
- [Alpaca order rules](https://docs.alpaca.markets/us/docs/orders-at-alpaca) support limit IOC for crypto and describe
  terminal order states;
- the official [Order properties](https://docs.alpaca.markets/us/docs/brokerapi-trading) expose the broker order ID,
  client order ID, status, and cumulative `filled_qty` used by the zero-fill readback;
- the [Assets API](https://docs.alpaca.markets/us/reference/get-v2-assets-1) is served from the paper endpoint and
  identifies tradable assets by class;
- [client-order-ID lookup](https://docs.alpaca.markets/us/reference/getorderbyclientorderid) is the recovery identity.

Recheck these primary sources before changing the order envelope or interpreting a new broker response.

## Slice 6 Lifecycle Boundary

Migration `0071_validation_lineage` adds the database contract for non-promotable replace and targeted cancel, and
establishes the still-blocked boundary for targeted close and flatten descendants. Each descendant must name a terminal
immediate parent and broker-terminal validation root; the database independently checks account, endpoint, root permit
identity and submit-time window, broker order target, and root symbol.
Order-feed events from a settled descendant are excluded by broker order ID even when the broker client-order ID no
longer has the `ivp-` prefix.

Permit expiry prevents another validation submit; it does not strand an existing order or position. A descendant uses
the normal short-lived `RiskReductionPermit`, so cancel, monotonic replace, close, and flatten remain available after
the root permit expires. A root recovered from an ambiguous broker-I/O window is eligible once broker readback settles
it as `reconciled` with the exact broker order ID.

The known-null IOC plan in this runbook may parent cancel or replace, but never close. Because it requires zero fill, it
cannot prove position ancestry. Migration `0071` keeps close lineage blocked until the lifecycle runner's separate,
position-producing plan schema is installed.

The follow-up migration must not unlock close merely by accepting that schema name. It must bind the root broker order
to persisted non-promotable fill evidence, prove positive bounded cumulative fill on the sole symbol, and reconcile the
paper account's before/after position against that fill. Missing, zero, stale, cross-account, or cross-endpoint fill
evidence keeps close and flatten blocked.

This migration is necessary but is not the lifecycle proof. Do not manually compose descendant intents or infer that
Slice 6 is proven from migration presence. The bounded Alpaca-paper lifecycle runner, immutable image promotion, broker
readback, CNPG receipt chain, and independent absence from candidate/PnL/ledger evidence must all pass before
`reduction_fencing_proven` can become true.

The lifecycle creates a real transient paper position and resting order. Do not start it while the scheduler is in a
scheduled or emergency flatten state: the scheduler is supposed to cancel and close that state, which would split the
causal chain and invalidate the proof. Use the non-interference precondition above; never rely on timing the mutations
between scheduler polls.

### Live broker minimum correction

The first promoted lifecycle attempt on 2026-07-15 UTC disproved the original `$5` assumption. Alpaca paper returned
HTTP `403`, code `40310000`, and an explicit `$10` minimum-cost-basis rejection even though the Assets response's
`min_order_size` allowed the requested quantity. The attempt created no broker order, position, open order, execution,
or trade decision. The old adapter incorrectly collapsed that definitive response into ambiguous broker I/O; retain
that historical receipt and its absence observations rather than rewriting it.

Migration `0073_live_paper_bounds` raises only the lifecycle-plan ceiling to `$30`; the known-null submit proof remains
at `$1`. A lifecycle plan must keep the root order at or below `$30` and must allocate both the partial close and final
residual at a plan notional of at least `$12` each. The `$12` guard is a deterministic buffer over the observed `$10`
broker floor, not permission to skip fresh quote readback. Immediately before issuance, independently verify that the
entry limit is marketable and that both close quantities remain above the broker's current minimum cost basis. Stop if
those conditions cannot coexist under the `$30` root cap. Application authorization and the PostgreSQL receipt
authority constraint both enforce the two leg floors, including for direct forged-intent attempts.

For example, when BTC/USD is below `$70,000`, `qty=0.0004`, `limit_price=70000`, and
`partial_close_qty=0.0002` bind at most `$28` of paper exposure and give each planned close leg `$14` of plan notional.
Resting and replacement close limits must remain strictly above the entry limit and each other. Recompute the immutable
plan digest after every price or quantity change; never widen a signed permit in place.

For the initial submit only, an Alpaca HTTP `400`, `401`, `403`, `404`, or `422` response definitively refuses the
request and settles the receipt as `rejected`, without a fabricated broker reference or success callback. Every other
submit status, including conflict, timeout, rate-limit, transport, and server failures, remains ambiguous and stays in
`broker_io` for read-only reconciliation. These are the synchronous failures documented by the official
[order endpoint](https://docs.alpaca.markets/us/reference/createorderforaccount); live broker behavior remains the
authority when published minimum metadata and the order endpoint disagree.

That submit rule does not apply after a cancel, replace, close, or flatten mutation has been authorized. A reduction
endpoint can return `404` or `422` because its target filled, closed, disappeared, or otherwise became terminal while
the request raced broker state. Any error after reduction I/O therefore preserves the receipt in `broker_io`. Recovery
must re-read the sealed order or position identity and settle `acknowledged`, `already_satisfied`, `rejected`, or
`manual_review` from observed broker truth; it must never retry the mutation blindly.

### Crypto fee and close-all response correction

The next promoted attempt on 2026-07-15 UTC filled the exact `0.00045040` BTC/USD IOC, but the position became
`0.000449274` BTC. This is the documented broker contract: Alpaca charges the crypto fee against the asset credited by
a buy, and its current tier-one taker fee is `0.25%`. The fill was complete; treating gross fill quantity as net
position quantity was incorrect. The historical root receipt, fill event, cleanup receipt, and broker orders must
remain intact.

Alpaca's position endpoint also reports the same pair as slashless `BTCUSD` while order and order-feed evidence use
`BTC/USD`. Normalize that broker representation only when `asset_class=crypto`, and retain the original broker symbol
in the risk-reduction observation. A string mismatch must never be interpreted as an absent position.

A 2026-07-16 paper lifecycle then disproved asset-ID substitution for partial crypto closes: Alpaca resolved the UUID
to `BTC/USD` but returned `404 position not found`, while the independently fenced account-wide close immediately found
and flattened the same position. A targeted close must therefore keep canonical `BTC/USD` as its receipt and lineage
identity but send the exact freshly observed position symbol, currently `BTCUSD`, as the broker path segment. The
canonical and broker symbols are both sealed in the request evidence. A slash-delimited target reaching the SDK, a
missing observed broker symbol, or any canonical/broker mismatch fails before broker I/O.

The runner must therefore prove both quantities independently. The root order must still be terminal `filled` with
`filled_qty` exactly equal to the signed plan quantity. The resulting sole long position may equal the gross fill or be
smaller only within Alpaca's published maximum taker-fee bound plus one broker quantity increment for rounding. Every
resting, replacement, partial-close, residual, lineage, and terminal check uses the observed net position. Both actual
close legs must still exceed the `$12` observed-notional guard before the first reduction mutation. An increased
position, a larger unexplained debit, an invalid increment, or a leg below the guard fails closed and triggers only the
independently fenced cleanup path. See Alpaca's official
[Crypto Spot Trading Fees](https://docs.alpaca.markets/us/docs/crypto-fees).

Alpaca crypto quantities and fee-adjusted positions can contain nine fractional digits. Migration
`0074_crypto_qty_precision` widens only the four order-feed quantity columns to `numeric(21,9)` while preserving the
existing twelve integer digits; prices and notionals remain at their existing money precision. Do not round broker
positions to fit the old schema or use the raw event as a substitute for normalized durable evidence.

`DELETE /v2/positions` returns HTTP `207` with an array of close-position responses. A successful item can carry the
created order under its nested `body` even when top-level `order_id` is null. Settlement and lifecycle readback must
extract exactly one distinct order ID for this known-single-position proof and reject missing or ambiguous identities.
See Alpaca's official [Close All Positions](https://docs.alpaca.markets/us/reference/deleteallopenpositions-1)
contract. The 2026-07-15 cleanup did flatten the account; its initially unresolved receipt was later reconciled from
flat-account broker truth. That recovery proves safety, not lifecycle success, so a fresh permit and complete receipt
chain are still required.
