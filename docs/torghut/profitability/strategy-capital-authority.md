# Torghut Strategy Capital Authority

Status: Normative implementation contract for profitability roadmap Slice 2.

System boundary: [adversarial profitability system design](adversarial-profitability-system-design.md).

## Decision

A risk-increasing broker order requires an active, immutable `StrategyCapitalAuthority` bound to the exact ORM
strategy, account, account mode, venue, symbols, limits, session, expiry, evidence identities, issuer, and independent
approver. The global live-submission gate remains necessary but is never sufficient.

Strategy names such as `@paper`, `@research`, and `@prod` are descriptive catalog data. They do not grant authority.
Research results, runtime-ledger thresholds, TCA summaries, readiness, Argo health, and TigerBeetle parity are evidence
inputs only. None can independently set capital authority.

Historical simulation does not perform broker I/O and does not consume a capital grant. Cancellation and strictly
exposure-reducing operations use the separate risk-reduction permit defined by roadmap Slice 6.

## Canonical Stages

The exact stage vocabulary is:

1. `disabled`
2. `quarantined`
3. `research_only`
4. `replay_verified`
5. `shadow_allowed`
6. `paper_probation`
7. `paper_verified`
8. `micro_live_allowed`
9. `capital_allowed`
10. `scaled`

`disabled` through `shadow_allowed` carry no broker fields, no notional, no account, no venue, no proof bindings, and
remain `reduce_only=true`. `paper_probation` and `paper_verified` may authorize only a bound paper account.
`micro_live_allowed`, `capital_allowed`, and `scaled` may authorize only a bound live account. A broker-stage record
with `reduce_only=true` remains unable to authorize a risk increase.

Stage order is not a mutable state machine. Every changed grant is a newly issued immutable record with a new
`authority_id`, digest, approval, and expiry. Activating a record updates only the strategy's explicit pointer.

## Authority Payload

The canonical payload is `torghut.strategy-capital-authority.v1` and includes:

- `authority_id`, `strategy_ref`, `candidate_ref`, and `evidence_epoch_id`;
- stage, account label, account mode, venue, and allowed symbols;
- maximum order, gross, net, and capital-drawdown amounts;
- maximum orders per minute and per session;
- timezone, weekdays, and non-overnight session window;
- UTC issuance and expiry;
- policy, evidence, image, data, and execution SHA-256 bindings plus the full Git commit;
- independent issuer and approver;
- `reduce_only` and explicit blockers.

Serialization is canonical JSON with sorted keys and compact separators. `authority_digest` is the SHA-256 digest of
that payload. Missing, malformed, stale, mismatched, tampered, unsupported, or unreadable data fails closed.

The catalog's exact `strategy_id` is the runtime candidate binding; when no distinct catalog identity exists, the ORM
strategy name is the candidate identity. Broker stages must match that identity. The bound evidence epoch must exist as
an unblocked, unexpired append-only row for the same account and stage scope, and the SHA-256 of its stored payload must
match `proofs.evidence_digest`. A copied ID or an evidence row whose denormalized fields disagree with its payload is
not accepted.

## Persistence

Migration `0064_strategy_capital_authority` creates `strategy_capital_authorities` and
`strategies.active_capital_authority_id`. It also adds the exact authority ID, digest, decision, and evaluation time to
each `trade_decisions` row. These columns are the durable pre-broker reservation used for rate limits; event time and
accepted executions are not substitutes for an attempted broker mutation.

The authority table is insert-only:

- `authority_id` and `authority_digest` are unique;
- the strategy foreign key is restrictive;
- database triggers reject `UPDATE` and `DELETE`;
- the active pointer is a composite restrictive foreign key that cannot cross strategy IDs;
- a decision's authority ID, digest, and strategy ID form a composite foreign key to the exact strategy-scoped
  immutable grant;
- evidence epochs used by grants are database-guarded against `UPDATE` and `DELETE`;
- downgrade refuses to destroy a nonempty authority history.

The catalog loader inserts an authority idempotently. Reusing an `authority_id` for different content fails instead of
silently rewriting history. A catalog entry with no authority receives a deterministic quarantine record. Missing,
malformed, or unappliable catalog data immediately selects deterministic quarantine records for every persisted
strategy and clears the loader's cached digest. If quarantine itself cannot be persisted, the scheduler cycle fails
instead of continuing with the previous grant.

Existing `StrategyCapitalAllocation`, `StrategyPromotionDecision`, and evidence-epoch rows remain historical evidence.
They are not rewritten, do not project a capital stage, and are not consulted as broker authority. A complete new
authority must be independently issued and selected before any legacy evidence can participate in a broker grant.

### Production migration safety

Revision `0064` is an online, retry-safe migration because `trade_decisions` is a live multi-gigabyte table. The
migration contract is:

- run each revision in its own Alembic transaction and put the online DDL in an explicit autocommit block; Alembic
  documents that entering an autocommit block commits prior work, so every statement after that boundary must be safe
  to retry;
- set a five-second `lock_timeout`, so a busy table causes a failed deployment and retry instead of an unbounded
  scheduler write outage;
- add the four nullable decision columns without defaults in one metadata-only `ALTER TABLE`, which PostgreSQL does
  without a table rewrite;
- add the four checks and composite foreign key as `NOT VALID`, then validate them separately. PostgreSQL enforces a
  not-valid constraint for new writes while skipping the initial scan, and `VALIDATE CONSTRAINT` uses a lock that does
  not exclude concurrent inserts, updates, or deletes;
- build only the query-serving partial index, with
  `WHERE strategy_capital_authority_allowed IS TRUE`, using `CREATE INDEX CONCURRENTLY`. Historical rows with no
  authority verdict do not consume index space or future index-maintenance work;
- detect and remove an invalid interrupted concurrent index before retry, and skip already-present columns,
  constraints, triggers, and valid indexes;
- run the required PostgreSQL integration test in CI. It must prove a complete upgrade, a second idempotent upgrade,
  immutable history, exact constraint validation, the partial-index predicate, a forced lock timeout, the retained
  `0062` revision after partial progress, and successful retry to `0063`.

These choices follow the production PostgreSQL 17 major version's documented
[`ALTER TABLE ... NOT VALID` and `VALIDATE CONSTRAINT`](https://www.postgresql.org/docs/17/sql-altertable.html),
[`CREATE INDEX CONCURRENTLY`](https://www.postgresql.org/docs/17/sql-createindex.html), and
[`lock_timeout`](https://www.postgresql.org/docs/17/runtime-config-client.html) behavior, plus Alembic's
[`autocommit_block`](https://alembic.sqlalchemy.org/en/latest/api/runtime.html#alembic.runtime.migration.MigrationContext.autocommit_block)
transaction warning. A green unit test that only inspects emitted method calls is not release evidence.

The immediate predecessor, `0063_options_archive_final_idx`, follows the same autocommit, timeout, structural-index
verification, invalid-index cleanup, and retry contract. The pre-cutover live readback was approximately 6.0 GiB and
3.97 million planner-estimated rows for `torghut_options_contract_catalog`, plus 1.9 GiB and 154,339 exact rows for
`trade_decisions`. The GitOps migration Job therefore has a one-hour active deadline; its former 15-minute deadline
could terminate a healthy 45-minute concurrent index statement. This changes only the failure budget for the PreSync
hook. It does not bypass migration failure, permit direct deployment, or increase capital authority.

## Immediate Pre-Broker Evaluation

For every risk-increasing order, the scheduler performs this conjunction immediately before broker submission:

```text
global operational gate
AND exact strategy row resolution
AND active authority row exists
AND payload digest and denormalized row fields match
AND strategy/candidate/account/mode/venue/symbol bindings match
AND exact evidence epoch identity, payload digest, account, stage, blockers, and freshness match
AND code commit and OCI image digest match the running scheduler
AND issuance <= now < expiry
AND current session is open
AND order/gross/net/loss bounds pass
AND per-minute and per-session usage bounds pass
AND reduce_only is false
AND authority blockers are empty
```

Projected exposure uses signed current position market values plus the proposed order. The loss bound uses the larger
of current account drawdown from the daily start and from the persisted high-water equity; absence of that state denies
the order. Missing order notional, position market value or its quantity/price derivation, loss state, runtime build
identity, usage counts, or venue mapping also denies the order.
The exact verdict, authority ID, digest, stage, timestamp, and reason codes are persisted on the trade decision before
broker I/O. A strategy-row lock serializes evaluation and reservation. A shared lock then proves that the same grant
remains active through broker submission and rechecks expiry, session, runtime artifact, and evidence freshness. Its
successful hold timestamp replaces the preliminary evaluation timestamp, so catalog rotation, revocation, or expiry
cannot cross that boundary without a durable denial. Rate limits count allowed broker attempts,
including broker rejections, rather than only accepted executions; the current decision is excluded by exact ID, while
prior attempts at the same timestamp are included.

The scheduler does not infer authority from strategy suffixes, evidence payload booleans, global live mode, or the
selected adapter name. Adapter identity only selects the venue that must match the already-issued grant.

`code_commit`, `image_digest`, and `evidence_digest` have independent runtime comparators in this slice. Policy, data,
and execution-envelope digests remain immutable issuance bindings until the canonical economic policy and parity
surfaces land in roadmap Slices 10 and 11. The production catalog therefore issues no broker stage in Slice 2, and no
later broker grant is acceptable until those prerequisite comparators plus the durable mutation-claim protocol are
deployed and proven.

## Evidence Separation And Deleted Debt

The former `promotion_authority.py` exposed `capital_allowed_authority()` without a strategy, account, venue, limits,
expiry, proofs, approval, persistence, or broker-path consumer. It was therefore not production authority and was
deleted.

Offline import and reporting callers now use `evidence_collection_policy.py`. That module can mark source collection,
paper probation, or evidence admissibility, but every legacy capital boolean it projects is hard-false. Runtime-window
imports persist all new capital allocations at `shadow` with multiplier `0`; evidence passing no longer creates a
canary or live allocation.

## Catalog Baseline

The production catalog declares every strategy explicitly:

- the three enabled paper-intended strategies are `shadow_allowed` with `p0_capital_freeze` and
  `paper_probation_not_issued` blockers;
- enabled research strategies are `research_only` with `p0_capital_freeze` and `research_only` blockers;
- disabled strategies are `disabled` with `strategy_disabled` blockers.

This deliberately produces distinct enabled stages in runtime status while keeping active broker grants at zero.
Sync mode does not delete historical strategy rows that remain referenced by decisions. It disables every unlisted row
and selects a deterministic `disabled` authority. The pre-migration production readback on 2026-07-13 contained 17
strategy rows: the 14 catalog entries plus three already-disabled historical identities; one of those identities owns
147,591 historical decisions and must not be deleted as “cleanup.” Expected post-cutover status is therefore nine
enabled strategies, `shadow_allowed=3`, `research_only=6`, `disabled=8`, and zero broker grants unless the live row set
changes before rollout.

## Operational Readback

Direct scheduler `GET /trading/status` exposes `strategy_capital_authorities` with a bounded list of exact strategy
references, authority IDs, digests, stages, validity, account modes, venues, expiry, blockers, and active broker-grant
count. API-process status continues to proxy the scheduler; the stateless API does not invent local authority state.

Production proof requires all of the following:

1. migration hook success and healthy CNPG cluster;
2. each catalog strategy has the intended exact stage and digest;
3. at least two enabled strategies report distinct safe stages;
4. `active_broker_grant_count=0` for the P0 freeze;
5. a controlled risk-increasing attempt with no grant is blocked before broker activity;
6. the decision contains the matching denial verdict;
7. no new broker mutation receipt, broker order, execution, or economic event exists for that denial;
8. image digest, source revision, Argo revision, and scheduler build identity match.

A unit test, green CI, or status payload alone is not production proof.

## Promotion And Revocation

Issuance requires a new reviewed artifact and independent approval. Any policy, candidate, strategy code, image,
dataset, execution envelope, account, venue, symbol set, limit, time window, or proof change requires a new authority.

Revocation selects a new safe authority record, disables the strategy, or closes the global operational gate. Existing
authority rows remain immutable for attribution. Expiry is fail-closed and does not automatically fall back to a prior
grant.

No authority guarantees profitability. It only bounds which already-validated strategy may place a risk-increasing
order under the declared evidence and risk envelope.
