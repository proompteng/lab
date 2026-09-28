# Point-In-Time Replay Data Receipts

Status: Slice 13 implementation contract. Capital authority remains blocked.

## Decision

Extend the existing replay tape as the single immutable research-data artifact. Do not add a feature store, database
table, controller, scheduler, or second receipt service.

A promotion-grade replay tape uses manifest schema `torghut.replay-tape-manifest.v2` and contains one
`torghut.point-in-time-data-receipt.v1`. The receipt binds the exact source rows and feature matrix to the observation
cutoff, source revisions, feed, calendar, universe, corporate actions, adjustment policy, code, feature pipeline, and
economic policy. Legacy tapes remain readable for diagnosis, but the paper-probation boundary rejects them.

This design does not claim profitability. It removes a path by which incorrect joins, late backfills, or revised rows
could manufacture apparent alpha.

## Evidence That Forced The Change

### Existing authority and history

Replay tapes were introduced in commit `6d1f12c954` to reuse one ClickHouse extraction across candidate trials. Later
changes added fail-closed day/symbol coverage and bounded source queries. The artifact already owns canonical row bytes,
a content SHA-256, query digest, source versions, feature schema, cache identity, and load-time verification. Replacing
it with a registry service would duplicate authority and add no causal information.

The old materializer still had three correctness gaps:

1. it read every retained revision from `ReplacingMergeTree` tables;
2. it joined signals to microbars without `seq`; and
3. it discarded the two source arrival timestamps, so a later rerun could not reconstruct what was knowable at a
   cutoff.

### Live ClickHouse audit

The live `torghut.ta_signals` and `torghut.ta_microbars` tables are
`ReplicatedReplacingMergeTree(..., ingest_ts)`, ordered by `(symbol,event_ts,seq)`. Background merges are not a
query-time correctness contract. ClickHouse explicitly documents that replacement is asynchronous/best-effort and
recommends query-time deduplication with `FINAL` or key-based `argMax`; an observation cutoff additionally requires
selecting the latest revision whose arrival is at or before that cutoff.

At observation cutoff `2026-07-18T19:45:00Z`, a live audit over events from `2026-07-15T00:00:00Z` found:

| Check | Result |
| --- | ---: |
| deduplicated signal identities | 194,678 |
| old `ANY` join: same sequence | 148,557 |
| old `ANY` join: wrong sequence | 26,155 |
| old `ANY` join: no microbar | 19,966 |
| exact-sequence join: correct matches | 174,712 |
| exact-sequence join: missing microbar | 19,966 |
| microbar event identities with more than one sequence | 20,910 |
| maximum sequences for one event identity | 4 |

The exact join removes the false matches and exposes genuine source gaps. A receipt rejects any selected row without
both source arrivals instead of silently substituting a different sequence or null feature.

Late arrival is material, not theoretical. Daily p99 signal arrival lag for the retained July 8-17 window ranged from
79,012 to 442,349 seconds because recovery/backfill rows arrived days after event time. A query based only on event time
therefore leaks data that was unavailable in an earlier observation.

The generated exact-row query and deduplicated coverage query were executed against the live schema. The final
24-column exact-row query returned one bounded row with both source-arrival and selected-row-version maps, and the
coverage query returned the complete 14-column diagnostic contract. These were real ClickHouse executions, not mocked
SQL assertions.

## Causal Row Contract

One observation cutoff is captured before coverage selection or row extraction. Both source tables use:

```sql
WHERE ingest_ts <= :observation_cutoff
ORDER BY symbol, event_ts, seq, ingest_ts DESC, version DESC
LIMIT 1 BY symbol, event_ts, seq
```

Signals and microbars then join on the complete identity:

```text
symbol + event_ts + seq + source + window_size
```

The emitted `SignalEnvelope.ingest_ts` is the maximum of the selected signal and microbar arrival timestamps. The
payload preserves each source timestamp under `_source_ingest_ts` and each selected `UInt32 version` under
`_source_versions`. Both maps are covered by the exact input-row hash. A complete row must satisfy:

- timezone-aware `event_ts <= source arrival <= observation cutoff` for both sources;
- envelope availability equals the maximum source arrival;
- no duplicate `(symbol,event_ts,seq,source)` identity;
- symbol membership in the frozen universe; and
- both `ta_signals` and `ta_microbars` selected row revisions, source-table versions, and watermarks.

Coverage diagnostics use the same cutoff and revision-selection rule. They cannot count retained revisions as extra
coverage.

## Receipt Contract

The receipt records:

- event-time and arrival-time minimum/maximum boundaries;
- observation cutoff and availability policy;
- feed identity and timezone;
- calendar version and SHA-256;
- universe version, symbols, and SHA-256;
- corporate-action version and SHA-256;
- adjustment-policy identity and SHA-256;
- source-table versions and per-source event/arrival watermarks;
- code, feature-pipeline, feature-schema, and economic-policy digests;
- replay-tape content SHA-256;
- exact ordered input-row-set SHA-256; and
- exact ordered source-feature-matrix SHA-256.

The feature-matrix hash excludes the `hpairs_replay_tape_features` load-time projection because that field is derived
from a separately serialized block. Hashing it again would create a duplicate causal authority. The tape content hash
still covers the serialized projection, and the feature schema/code digests bind its transformation.

`PointInTimeReceiptSpec` is an explicit immutable input. The materializer does not invent missing feed, universe,
corporate-action, adjustment, code, or policy metadata. Supplying the spec makes the receipt mandatory; incomplete
metadata or causal rows fail before an artifact is replaced.

## Promotion And Compatibility

- Manifest v1 and unreceipted v2 tapes remain readable historical diagnostics.
- Loading a receipted tape recomputes the content, row-set, feature-matrix, watermark, and receipt hashes.
- The consistent-profitability frontier carries the receipt anchors into its dataset witness and candidate evaluation
  lineage.
- Paper probation rejects missing or incomplete point-in-time receipt anchors. `allow_stale_tape` cannot override the
  explicit receipt-required validator.
- No receipt grants capital authority. Economic parity, engine parity, trial/statistical gates, paper runtime evidence,
  broker reconciliation, and all final promotion gates remain independent blockers.

CNPG does not receive a second dataset registry in this slice. The existing replay manifest is the immutable artifact;
Slice 15's trial ledger may reference its receipt digest. Persisting the same mutable metadata in two stores would
create reconciliation work without improving reproducibility.

The older `dataset_snapshot` receipt remains a coarse freshness/coverage projection while consumers still use it. It
is not causal promotion authority. It should be deleted only after every consumer reads the replay receipt or the
Slice 15 trial ledger; deleting it now would break active diagnostics without removing an authority conflict.

## Verification Matrix

Automated tests cover:

- deterministic receipt, row-set, and feature-matrix hashes across independent materializations;
- look-ahead and negative feature age;
- arrivals after the observation cutoff;
- revised/duplicate identities;
- missing or changed selected source-row revisions;
- missing source arrivals;
- out-of-universe/delisted symbols;
- naive timezone rejection;
- corporate-action restatement changing receipt identity;
- tampered receipt rejection;
- legacy tape readability with mandatory promotion rejection;
- exact sequence join, as-of filtering, and revision deduplication in generated SQL; and
- independent verifier acceptance and expected-hash mismatch rejection.

Production acceptance requires two independent materializations with the same cutoff and lineage inputs to produce the
same content, input-row-set, feature-matrix, and receipt hashes, followed by verification inside the promoted image.

## Rollback

Rollback is fail-closed: revert the reader/writer while leaving all unreceipted artifacts non-promotable and capital
disabled. Never restore the sequence-omitting `ANY` join or accept current-state `ReplacingMergeTree` output as a
historical as-of view.

## External References

- [ClickHouse: common getting-started mistakes and query-time deduplication](https://clickhouse.com/blog/common-getting-started-issues-with-clickhouse)
- [ClickHouse: why background merges do not provide immediate query correctness](https://clickhouse.com/resources/engineering/clickhouse-optimize-table-final)
- [Feast: point-in-time joins](https://docs.feast.dev/getting-started/concepts/point-in-time-joins)
