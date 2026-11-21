# Support-recovery quarantine cutover

This cutover removes the empirically losing `SupportRecovery` entry path without removing Jev. Jev remains the
structural chart and setup model. The executable strategy becomes responsible for one deterministic economic choice:
select the globally ranked setup or abstain. If the v41 winner is `SupportRecovery`, v42 records
`SUPPORT_RECOVERY_QUARANTINED` and selects nothing. It never promotes a runner-up.

This is a hard migration for current execution. Historical protocol readers remain only where immutable evidence must
still reproduce its original bytes. A retained decoder is not an executable fallback.

## Ownership and data flow

```mermaid
flowchart LR
  WS[Alpaca trade-update WebSocket] --> Feed[Single Dorvud broker ingress owner]
  Feed -->|signed, idempotent notify| Restate[Restate durable ingress]
  Restate --> Source[(Immutable broker source-event ledger)]
  Source --> Project[Exclusive per-account projector]
  Project --> Wake[Durable controller wake]
  Project --> Snapshot[Complete-history snapshot capture]
  Snapshot --> Reconcile[Canonical reconciliation]
  Reconcile --> Accounting[TigerBeetle accounting]

  Market[Completed market bars and quotes] --> Jev[Jev structural inference]
  Jev --> Select[One deterministic economic selector]
  Select -->|winner or abstain| Authority[Generation and risk authorization]
  Authority --> Execute[Mutation coordinator]
  Execute --> Broker[Alpaca PAPER]
  Broker --> WS
```

The source ledger is the single durable arrival truth. The projector may reduce known order events immediately, but
only complete-history reconciliation can post money until a later durable Activity SSE cut proves its ordered prefix,
cursor and correction chain. Jev does not own capital authority, broker state, accounting or qualification. The
selector does not fabricate an alternative when the top-ranked setup is quarantined. The mutation coordinator checks
the active generation again immediately before every side effect, so predecessor intents cannot submit after rollover.

## Immutable identities

| Field            | Settled v41                                                        | Successor v42                                                      |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Parameter schema | `bayn.jev.protocol.v41`                                            | `bayn.jev.protocol.v42`                                            |
| Behavior hash    | `76f0e134e622ada19cb1b087d83da60b54a36d33c86c6c0eee2642ee3fbd3e67` | unchanged                                                          |
| Parameter hash   | `004604dcc48754ff553976d366a4d7643a6a3a1157acac4b89acc879b56c4696` | `186b7751bc8220a5de918ce7b9d134cf40870ce3eb793a4212274a0c45a12b7e` |
| Protocol hash    | `b97dc08473946b82b89f9e4bfae09d18c4bae4ebd8b854f5a6b2b805e35a19c9` | `93cd004a573200e6191c75bc2a079fd2c93c553d3a5e6a99ca47dd5dd0983247` |

## Required delivery order

### 1. Deploy a recovery-capable v41 and settle its mandate

Migration 207 recognizes only the exact clear v41 PAPER identity above. It fails immediately when the shared mutation
fence is busy and bounds write-lock acquisition to 250 ms. Its write locks follow source-ingress order and do not block
ordinary readers. Under those fences it requires:

- terminal current-account intents and no pending or active cycle;
- zero broker and accounting inventory, a latest zero-position snapshot and no open current broker order;
- complete fill and transaction accounting, with no prepared cash, fee, accrual or correction posting left unfinished;
- a fresh exact reconciliation after the latest current-account mutation;
- at least one direct-stream `SessionReady`, a projection receipt for every durable source event, no late predecessor
  receipt outside the source ledger, and a canonical observation whose notification and financial fences cover the
  newest source event; and
- no unexpired unresolved Jev inference claim.

It atomically records an immutable account retirement, installs a PostgreSQL admission trigger that rejects every
later PAPER generation for that account, and records `effective=OBSERVE`, `kill=ACTIVE` and
`BLOCKED_STRATEGY_PROTOCOL_CUTOVER` without changing financial evidence. The exact matching mandate receives only
`ResumeRestricted`, never rearm or fresh activation, and therefore constructs a close-only driver. That driver owns
native settlement and a later exact reconciliation to a new clear OBSERVE generation. The database barrier also stops
a retained request replay or delayed activation from an older binary after rollover. Foreign requests and operator
restrictions remain rejected. Other identities and empty installations are no-ops.

Keep the request, kind and Kargo-updated build lineage on every settlement workload in this first reviewed GitOps
change. This makes the newly deployed v41 binary recovery-capable and removes any dependency on the old pod surviving
between PostgreSQL preflight and Restate controller rotation. Keep broker credentials read-only and configured capital
authority `none`; the retained exact mandate can recover only its already-bound generation because PostgreSQL rejects
new PAPER history for the retired account. Deliver only through main, immutable image publication, Freight, Kargo and
Argo. Before and after promotion, prove the exact revision,
direct-stream ledger/projection/fence coverage, flat inventory, complete posted accounting and clear OBSERVE recovery.
Capability on both rollout revisions is not dual ownership: the exclusive Restate controller and PostgreSQL writer
fence admit only one active recovery owner at a time.

After clear OBSERVE, the new revision's successful recovery, and predecessor drain are durably proven, make a separate
reviewed cleanup remove request, kind and lineage inputs from all workloads and delete the encrypted request. The
mandate-free cleanup must recheck literal clear OBSERVE inside exclusive controller rotation before it can take over.

### 2. Admit v42 without a mandate

After the deployed v41 settlement boundary and mandate-free cleanup are proven, deliver the v42 executable and its
admission migration with the mandate absent. New executable requests are v42-only; v41 readers remain only for
historical reproduction. The admission migration must require the same flat, settled, clear OBSERVE boundary and must
not rewrite v41 evidence.

Prove in the published production runtime that:

- a v41 `SupportRecovery` winner remains reproducible by the retained reader;
- the equivalent v42 batch abstains and records the quarantine reason;
- no lower-ranked candidate is promoted;
- base-breakout, resistance-rejection, exits, deadlines, protection and accounting are unchanged; and
- an old generation or queued predecessor intent cannot pass final mutation authorization.

### 3. Qualify, then optionally restore PAPER

Only after the exact v42 image and source are deployed in OBSERVE may a reviewed same-account activation request be
constructed through existing constructors. Restoring PAPER requires a separate reviewed migration that introduces a
new authorization epoch without deleting the immutable retirement, plus a separate reviewed change restoring the
sealed request, its annotation and all three activation inputs. Kargo promotion never grants capital authority.

Quarantining a historical loser is a risk-reduction hypothesis, not a proof of alpha. PAPER activation requires a
pre-registered, matched-session evaluation of v42, the actually deployed v41 incumbent and cash. Include spread,
slippage, regulatory and broker fees, borrow costs, inference expense and rejected/expired opportunity costs. Require
positive lower confidence bounds for all three fully costed comparisons:

1. v42 absolute net return;
2. v42 minus the v41 incumbent; and
3. v42 minus cash.

Report rising and falling sessions separately and require both long and short paths to remain executable and risk
bounded. If those bounds are not positive, remain in OBSERVE. Formal software proofs can establish determinism,
authority fencing, accounting conservation and abstention behavior; they cannot prove market edge.

## Rollback boundaries

Before migration 207 applies, restore only the complete reviewed v41 image, mandate and lineage through normal Kargo
delivery. After migration 207 applies, keep the mandate-bearing settlement release until native recovery reaches clear
OBSERVE; never restore or delete the mandate alone. After the mandate-free cleanup, roll back only to another
mandate-free v41 settlement-compatible image. After v42 admission, roll back only to a v42-compatible verified image.
After v42 PAPER activation, removal requires another exact-identity settlement transition. No rollback may reset
financial history, reuse a retired generation or bypass reconciliation.

Once the direct transport has passed live restart/reconnect acceptance and predecessor Restate invocations have drained,
remove the retained sealed mandate, temporary notification-receipt sink, order compatibility trigger and inert Kafka
topic in a separate hard cleanup. The later Activity SSE migration must install one durable owner and cursor before
deleting replica-local streams. These deletions reduce duplicate ownership; they do not weaken canonical reconciliation.
