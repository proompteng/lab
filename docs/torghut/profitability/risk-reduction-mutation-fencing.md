# Risk-Reduction Broker Mutation Fencing

Status: Slice 6 implementation contract.

This document defines the production contract for cancel, replace, targeted close, account flatten, and emergency
liquidation. It extends the durable broker-mutation receipt protocol introduced by Slices 4 and 5. It does not grant
entry authority, claim profitability, or make an unresolved broker result safe to retry.

## Outcome

Every reachable broker mutation follows one path:

`fresh broker observation -> action-specific permit -> durable receipt -> broker-I/O fence -> one adapter call ->
terminal settlement or observation-only recovery`

There is one coordinator and one receipt state machine. Cancel, replace, and closeout do not get parallel claim tables,
retry loops, or broker-specific safety authorities. Broker adapters remain responsible for translating an already
authorized action into the exact SDK call; they cannot issue authority or mutate without both required capabilities.

## Engineering Discipline

The implementation applies six complementary engineering principles:

- Linus Torvalds: keep control flow obvious, functions single-purpose, and special cases out of core paths.
- John Ousterhout: put observation validation, exposure math, sealing, and one-use enforcement behind one deep permit
  module instead of distributing shallow checks across callers.
- Barbara Liskov and Jeannette Wing: every broker adapter must preserve the same mutation preconditions,
  postconditions, and failure semantics; swapping Alpaca for Hyperliquid cannot weaken the contract.
- Leslie Lamport: model safety separately from liveness. An unresolved mutation may stop progress, but it cannot
  authorize a duplicate mutation or increased exposure.
- Martin Fowler: refactor the existing submit coordinator in small behavior-preserving steps while focused tests stay
  green.
- Kent Beck: prefer deterministic behavior tests and fault schedules that predict deployment outcomes over tests that
  merely mirror implementation details.

Primary references: [Linux kernel coding style](https://kernel.org/doc/html/next/process/coding-style.html),
[Ousterhout on deep modules](https://web.stanford.edu/~ouster/CS349W/lectures/abstraction.html),
[Liskov and Wing on behavioral subtyping](https://www.cs.cmu.edu/~wing/publications/LiskovWing94.pdf),
[Lamport on specification and concurrency](https://www.microsoft.com/en-us/research/blog/leslie-lamport-receives-turing-award/),
[Fowler on refactoring](https://www.martinfowler.com/books/refactoring.html), and
[Beck on programmer-test principles](https://medium.com/@kentbeck_7670/programmer-test-principles-d01c064d7934).

## Authorities

Two independent one-use capabilities are required at the broker adapter boundary:

1. `BrokerMutationIoPermit` proves that the durable receipt won the I/O transition.
2. `RiskReductionPermit` proves that the exact mutation is monotonic against a fresh broker observation.

Neither capability implies the other. A valid reduction permit without a durable I/O permit cannot reach the broker;
a durable I/O permit without a matching reduction permit cannot call a reduction mutation. Candidate authority,
profitability evidence, TCA freshness, and ledger completeness are intentionally absent from permit issuance. They gate
entries, not provable exposure reduction.

The permit is process-local, short-lived, HMAC-authenticated, and atomically consumed once. It binds:

- broker route, account, endpoint fingerprint, operation, target, and canonical action hash;
- canonical broker-observation hash, observation time, and expiry;
- the observed symbols and order or position identities;
- conservative gross and net exposure before and after the planned action.

The same observation and reduction evidence is embedded in the canonical mutation request, so the durable receipt and
ephemeral permit bind the same economic action.

## Observation Contract

Observations are immutable typed values, not arbitrary SDK dictionaries.

- An order observation names broker order ID, client order ID when present, symbol, side, original quantity, filled
  quantity, remaining quantity, limit price when relevant, status, and observation time.
- A position observation names symbol, signed quantity, and positive conservative unit notional. Alpaca derives unit
  notional from broker market value divided by absolute quantity. Hyperliquid uses the broker-observed mark price.
- A snapshot names route, account, endpoint, observation time, completeness, and bounded orders/positions.

Account-wide actions require a complete bounded snapshot. Reaching the configured broker page bound is incomplete, not
evidence that no additional open orders or positions exist. An unavailable or stale position snapshot cannot authorize
a guessed close quantity. Hyperliquid position observation first discovers the authoritative perp-DEX catalog through
`perpDexs`, then reads account state for the core DEX and every returned builder DEX; a malformed catalog or position
payload is incomplete and fails closed. Hyperliquid cancellation queries the exact `orderStatus` by OID or CLOID; it
does not infer absence from a possibly large account-wide open-order list. Canceling an exactly identified observed open
order may still proceed because it cannot increase filled exposure. See the official
[Hyperliquid info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) and
[perpetuals info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals).

## Mutation Rules

### Cancel one order

The target must exactly match an observed open order. Cancel is risk-neutral in exposure arithmetic but prevents
additional exposure. A duplicate cancel that observes the order already terminal settles `already_satisfied` without a
broker call. An ambiguous cancel remains in `broker_io` until observation proves the target is no longer open.

### Cancel all orders

The permit seals the complete set of observed open-order identities. An empty complete set settles
`already_satisfied`. Partial broker cancellation is unresolved; recovery compares the sealed target set with a fresh
complete open-order snapshot. New unrelated orders never make the old mutation look successful.

### Replace

Replacement is deliberately repricing-only: it preserves symbol, side, and the observed remaining quantity. The
unused notion of an independently authorized replacement quantity is not part of this slice because Alpaca does not
receive such a quantity from Torghut's production path. A replacement of a risk-reducing order must also remain
opposite the complete observed position and cannot cross zero. Price can change; identity, side, and remaining exposure
cannot widen. Replace is disabled when these conditions cannot be observed and proven.

### Close one position

The action symbol must already exist, side must oppose the signed position, and quantity must be positive and no larger
than the observed absolute quantity. Conservative gross exposure after the action cannot exceed gross exposure before
it. The action cannot cross zero or create a position in a new symbol.

### Close all positions and multi-leg unwind

Every nonzero observed position has exactly one opposing planned leg, and every planned leg names an observed symbol.
Aggregate gross exposure must decrease and the completed plan must not increase absolute net exposure. A partial broker
success is not retried from the old snapshot: it remains unresolved, then recovery re-observes positions before any new
permit is issued.

An acknowledged account flatten is submitted once for a given symbol, side, and quantity state. Confirmation polls do
not cancel and replay that same action. If broker readback proves a monotonic partial fill, Torghut cancels any remaining
open close order, confirms cancellation, and may authorize the smaller residual position as a new economic action. An
unchanged, expanded, side-flipped, or new-symbol state is never a blind retry and fails closed after the confirmation
budget.

A single-leg close can increase absolute portfolio net exposure when flattening one leg of a hedged book. Torghut does
not hide this arithmetic. Such a close requires a sealed multi-leg plan whose completed aggregate does not increase
absolute net exposure, or it remains blocked for operator reconciliation.

## Causal Identity

The canonical request seals both the planned action and the exact broker observation used to authorize it. Orders carry
broker order ID and client order ID when present; positions carry symbol, signed quantity, and conservative unit
notional. These fields are covered by the existing canonical-intent hash. Torghut does not invent an originating
receipt for an aggregate broker position or an external order, and it does not add a second causal-link table. Known
Torghut order ancestry remains recoverable from the sealed client order ID and existing receipt or submission-claim
records.

Order-targeted and position-targeted infrastructure-validation mutations retain their non-promotable marker and
validation workflow identity throughout the causal chain. Account-wide cancellation events are classified per order.
Candidate, trial, PnL, and promotion queries must exclude every validation descendant, not only the initial submit.

### Validation-Descendant Lineage

Validation lineage is carried inside the existing canonical mutation intent; it is not a second coordinator, claim
table, or evidence authority. The envelope names the immutable validation root, the immediately preceding receipt and
broker order, the exact permit identity, and `promotable=false`. PostgreSQL accepts it only when all of these are true:

- the root is an acknowledged or broker-reconciled, risk-neutral Alpaca paper validation submit in the same account
  and endpoint;
- the root permit ID and digest match; the root was created inside that permit's validity window, while later
  risk-reducing descendants remain available after it expires;
- the immediate parent is terminal, belongs to the same root chain, produced the named broker order ID, and is either
  the root submit or an order-creating replace/close descendant; cancel receipts never become order identity;
- cancel or replace targets that parent order, while close targets the root plan's sole symbol; and
- the envelope has exactly the documented keys, with no caller-supplied extensions.

The existing known-null IOC submit plan can parent cancel or replace only. It can never parent a close: it proves zero
fill and therefore has no position ancestry. Close lineage remains database-blocked until the dedicated lifecycle plan
schema and runner establish a bounded fill on the sole symbol. The follow-up guard must verify persisted tagged fill
and reconciled position evidence; recognizing a plan-schema string alone is not position proof.

Account-wide cancel remains available for every complete snapshot because it is a safety operation whose broker scope
can race beyond the observed order set. Its receipt is never relabeled wholesale as validation. Each validation
cancellation event is excluded independently from the existing root or replacement order ancestry. Cancel receipts
never become order-identity parents because cancellation creates no broker order. Order-feed ingestion resolves
order-creating descendants by settled broker order ID as well as the root `ivp-...` client ID. The same database-proven
marker prevents execution/decision linkage and TigerBeetle journaling for every validation event.

A broker trade update can race ahead of local receipt settlement. The order feed may classify the root update from the
exact validation client ID plus the broker-observed order ID so ingestion continues and the event remains excluded, but
that provisional evidence cannot authorize a descendant. Lineage construction remains blocked until the durable root
receipt is acknowledged or broker-reconciled with an order reference.

These checks prove evidence isolation and causal ancestry. They do not prove that the paper lifecycle runner exercised
replace, cancel, partial close, or flatten. That remains a separate runtime gate below.

### Bounded Alpaca-Paper Lifecycle

The existing known-null validation plan remains a maximum-$1 zero-fill submit proof. It is not widened or repurposed:
Alpaca's current crypto minimum-order economics can make that plan too small to establish position ancestry. A separate
lifecycle plan has a hard $5 entry-notional and loss cap, and runtime preflight re-reads the asset's current minimum
size, quantity increment, and price increment before any mutation. If the entry, partial close, residual close, or
prices do not fit both Alpaca's metadata and PostgreSQL `numeric(20, 8)`, the runner fails before broker I/O.

The runner starts only from one active Alpaca paper account with no positions and no open orders, then executes this
single control path:

1. submit one permit-bound limit IOC buy and require an exact full fill at or below its limit;
2. submit one full-position GTC limit sell far enough above the entry limit to remain open with zero fill;
3. replace only that resting order's price, require Alpaca to return a new order ID, and prove the original ID became
   `replaced`;
4. cancel the replacement and prove the account has no open orders;
5. close an exact partial quantity derived from the current broker position and reconcile the residual `position_qty`;
6. close the sole residual position, then prove no position, no open order, and a tagged flat-position event.

Cancel is a branch in the receipt chain, not an order-identity parent: the partial close names the terminal replacement
receipt as its parent because cancellation creates no broker order. The successful proof contains exactly six terminal
mutation receipts and five order-creating broker identities. Every fill marker names the exact terminal receipt that
created its broker order, the immutable validation root, and the permit identity. The order-feed `position_qty` value
must match the fresh broker observation before either close capability is issued.

No lifecycle broker mutation is blindly retried. A failure before a later independent reduction invokes the ordinary
fenced cancel-all/flatten safety path from a new broker observation. An ambiguous final flatten remains unresolved and
the runner stops after one broker call; it does not claim a known-null terminal state. A report is emitted only after
CNPG proves the complete receipt chain and proves zero execution, decision, submission-claim, TigerBeetle, or untagged
event leakage.

The broker assumptions come from Alpaca's official [crypto trading](https://docs.alpaca.markets/us/docs/crypto-trading),
[order lifecycle](https://docs.alpaca.markets/us/docs/orders-at-alpaca), and
[trade-update streaming](https://docs.alpaca.markets/v1.4.2/docs/websocket-streaming) documentation. Runtime readback,
not the documentation snapshot, remains authoritative for account state, asset increments, order IDs, fills, and
positions.

## State And Recovery

The existing receipt states remain sufficient:

```text
claimed --durable I/O fence--> broker_io --terminal response--> settled
   |                               |
   +--preflight satisfied----------+--lease expiry--> observation-only recovery
```

Safety rules:

- a primary or recovery lease authorizes database transitions, never a second broker mutation;
- an adapter must translate a definitive non-retryable broker refusal into the shared explicit-rejection contract, so
  the coordinator atomically settles `rejected`; timeouts, rate limits, transport loss, and server failures remain
  ambiguous `broker_io` rather than pretending success or rejection;
- recovery observes exact broker identities and sealed target sets; it never calls cancel, replace, or close;
- an incomplete lookup records `indeterminate` and preserves `broker_io`;
- side flip, increased quantity, conflicting replacement identity, or increased exposure requires manual review;
- unresolved cancel, replace, or close blocks new entries for the affected account while further independently proven
  reduction remains eligible.

Broker-specific terminal evidence:

- Alpaca cancel uses the exact order ID; cancel-all is only terminal after all sealed IDs are absent from a complete
  open-order snapshot. Replace is terminal when the desired replacement fields and causal order relationship are
  observed. Close is terminal when the exact position is reduced or flat without a side flip. A successful replace or
  close response without its broker order ID remains unresolved; a generated request ID is not order identity.
- Hyperliquid cancel uses the exact order ID and coin. Reduce-only close is terminal only after broker position
  observation proves the bounded reduction; the SDK's `reduce_only` flag is necessary but not sufficient evidence.

## Failure Schedules

The required deterministic tests cover:

- fill racing cancel or replace;
- duplicate cancel and already-terminal preflight;
- partial-fill closeout and no-cross-zero enforcement;
- process death before I/O, after broker acceptance, and before settlement;
- multi-leg partial failure followed by re-observation;
- stale candidate, profitability, TCA, and reconciliation evidence with a valid reduction observation;
- forged, mismatched, expired, and reused reduction permits;
- generated no-new-symbol, no-side-flip, no-gross-increase, and no-net-increase cases;
- broker outage during emergency reduction with a durable unresolved receipt and zero blind retry.

Tests exercise public behavior and durable state. They do not patch around the adapter boundary or accept a status flag
as proof.

## Rollout And Proof

The capability is proven only when all of the following are true:

1. every reachable Alpaca and Hyperliquid cancel, replace, close, flatten, governance, kill-switch, and maintenance
   mutation requires both capabilities;
2. focused, property, PostgreSQL transition, and fault tests pass, followed by all Torghut CI and type profiles;
3. the immutable image is promoted through GitOps and the scheduler reports the exact source and digest;
4. a bounded paper/sandbox validation chain exercises submit, replace, cancel, partial close, and final flatten;
5. broker readback and CNPG receipts reconcile one causal chain with no duplicate mutation;
6. every validation descendant is independently proven absent from candidate, trial, PnL, and promotion evidence.

Until that proof is complete, `reduction_fencing_proven` remains false and risk-increasing submission remains blocked.
Rollback disables replace and entries while preserving the previously proven fenced submit-based closeout path.

## Deliberate Non-Goals

- No claim that reduction fencing creates alpha or profitability.
- No general workflow engine, saga framework, route quarantine, or second mutation coordinator.
- No blind retry policy for broker mutations.
- No dependence on candidate or profitability authority for strictly proven reduction.
- No automatic account-wide flatten when one strategy leg fails; targeted unwind is preferred.
