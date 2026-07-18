# Slice 13 Production Evidence: Point-In-Time Replay Data Receipts

Status: production-proven for deterministic point-in-time replay materialization and independent verification against
live Torghut market data. This proof does not establish adequate market-data coverage, strategy profitability, or
capital authority.

Evidence window: `2026-07-18T20:59:08Z` through `2026-07-18T21:22:04Z`.

## Invariant And Scope

Slice 13 requires each promotion-grade replay result to identify exactly which market rows and revisions were knowable
at one observation cutoff, and to bind those rows to the feed, calendar, universe, corporate actions, adjustment
policy, feature pipeline, feature schema, economic policy, and source code.

The implementation extends the existing replay tape instead of adding a feature store, database table, service,
controller, queue, or scheduler. Manifest-v1 and unreceipted tapes remain readable diagnostics, but paper probation
rejects them. This removes look-ahead and wrong-sequence paths; it does not manufacture missing data or alpha.

## Delivery Chain

| Boundary             | Evidence                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source PR            | [#12819](https://github.com/proompteng/lab/pull/12819), `feat(torghut): add point-in-time replay receipts`                                                                                                  |
| Source merge         | `ccf68fd19b15b738d9431644790a4af1e1d13d04`                                                                                                                                                                  |
| Final source-head CI | [run 29660412148](https://github.com/proompteng/lab/actions/runs/29660412148), all required Torghut jobs successful                                                                                         |
| Image build          | [run 29660745002](https://github.com/proompteng/lab/actions/runs/29660745002), amd64, arm64, and multi-architecture index successful                                                                        |
| Image identity       | `registry.ide-newton.ts.net/lab/torghut@sha256:257e8c5e98038f77390eecad92be6bd45f5662aa23e11969e379d963ed7dd334`                                                                                            |
| Release              | [run 29660870735](https://github.com/proompteng/lab/actions/runs/29660870735), successful                                                                                                                   |
| GitOps promotion     | [#12825](https://github.com/proompteng/lab/pull/12825), merged as `c99cf6bd0f42632bcc1d62826ebca7ca898de2e3`; [automatic merge run 29660926349](https://github.com/proompteng/lab/actions/runs/29660926349) |
| Argo                 | `Synced`, `Healthy`, operation `Succeeded` at `c99cf6bd0f42632bcc1d62826ebca7ca898de2e3`, completed `2026-07-18T21:10:55Z`                                                                                  |

The reviewed source head passed the complete CI matrix: bytecode and lint, all four full-test shards, both
autoresearch shards, five strict Pyright profiles, PostgreSQL mutation-fencing CAS, coverage, and the complexity,
security, dead-code, migration-graph, and file-length gates. Focused local validation was:

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen ruff format --check app tests scripts migrations
uv run --frozen ruff check app tests scripts migrations
uv run --frozen pytest -q tests/replay_tape tests/local_intraday_tsmom_replay tests/profitability_frontier
uv run --frozen python -m compileall -q app scripts tests
```

The focused suite reported `243 passed`. Structural Pylint, the 1,000-line limit, Vulture, the migration graph, and the
technical-debt ratchet also passed. The ratchet found zero Python files at or above 1,000 lines.

Two review failures were corrected before merge: missing replay metadata can no longer bypass the paper-probation
receipt gate, and supplying a point-in-time specification can no longer persist an incomplete receipt through a
default option. Regression coverage exercises both default paths.

The change also deleted blanket replay-package re-exports, unused decoder helpers, repetitive coverage SQL, redundant
hash fields, and the incomplete-receipt escape. The exact-row validator was simplified into direct time, identity, and
source-lineage checks. No suppression or parallel receipt authority was added.

## Live Lineage Inputs

Both materializations captured one observation cutoff before coverage selection and extraction:

`2026-07-18T21:14:15.309220+00:00`

The controlled input was `NVDA` on `2026-07-15` from feed `alpaca-iex`. The receipt bound these immutable identities:

| Input                         | Identity                                                                  |
| ----------------------------- | ------------------------------------------------------------------------- |
| Source code                   | `ccf68fd19b15b738d9431644790a4af1e1d13d04`                                |
| Economic policy               | `sha256:071068019c37c8f6e7d379529e6506661429d88bb082e876bfca2df221bc4d65` |
| Market calendar               | `sha256:4ded49c127691ce54e8e7ad39f9024faa30942acba767a131ca9dab2147ae79b` |
| Universe                      | `sha256:35e0376f4bb10f8d906f22d021911f6372bcef1c2857734fd373480718d55bef` |
| Corporate-action snapshot     | `sha256:547110087fd1f45592f02f4df3bd5c886a50d0920ec5733300359dba39a18b7e` |
| Adjustment policy             | `sha256:e29a991fd3523d8036b4db1555561a209a8d1e6d926499ea61885e8a6c03627b` |
| Feature pipeline              | `sha256:95c5e35c550472ac794cfb6958176ac18e97a4525c9c8f2b684c994edf8d8b2d` |
| Feature schema                | `378e31bba54f425b85a78d39aa67cfd9faaf0d5942157479783c0610a593e154`        |
| Source query                  | `d931676c39f8079b20b3e57555e82539743f3198a87644bdeaf1e7a68fbb0fa2`        |
| `torghut.ta_signals` schema   | `sha256:5dbd5bfe8a0b38a71a95b40815522356d27caa3c2bbd6d1d0469b82bd88a4f6c` |
| `torghut.ta_microbars` schema | `sha256:22e6a26a379e6fa7fbdc7ffb5a8ad94dfb9b0b4c2444ebb3c2f9cf7a6710d32c` |

The corporate-action input was an authenticated snapshot from Alpaca's
[current corporate-actions endpoint](https://docs.alpaca.markets/us/reference/corporateactions-1), captured before the
observation cutoff. It contained zero actions and no continuation page. The adjustment policy retained the raw,
unadjusted source values; neither input was inferred from the later market state.

Each source watermark contained 809 selected rows. Event time ran from `2026-07-15T13:32:42Z` through
`2026-07-15T19:59:59Z`; source arrival ran from `2026-07-15T13:32:42.185Z` through
`2026-07-15T19:59:59.097Z`. Every selected signal and microbar revision arrived by the cutoff and joined on the full
`symbol,event_ts,seq,source,window_size` identity.

## Deterministic Materialization And Independent Verification

Two fresh materializations ran independently inside the promoted scheduler image. They produced 809 rows each and
matched on every required anchor:

| Anchor                 | First materialization                                                     | Second materialization                                                    |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Row count              | `809`                                                                     | `809`                                                                     |
| Tape content SHA-256   | `bf45a3a5195b67c694e6f62fff2938f1ea2d72b291d6fd647b66cf2313f0ca18`        | `bf45a3a5195b67c694e6f62fff2938f1ea2d72b291d6fd647b66cf2313f0ca18`        |
| Receipt SHA-256        | `sha256:ccad254ad784f1791cdfe0f8e25ae98deab846cb719609b789a613d5ad136404` | `sha256:ccad254ad784f1791cdfe0f8e25ae98deab846cb719609b789a613d5ad136404` |
| Input-row-set SHA-256  | `sha256:376f9996c4e1eaf8ef49ba3c47addd725ce327cdb411f5ea3f4573722b2820ad` | `sha256:376f9996c4e1eaf8ef49ba3c47addd725ce327cdb411f5ea3f4573722b2820ad` |
| Feature-matrix SHA-256 | `sha256:d09d94026eecbd97d923696e3e8b0d3dfccd0cb455ef90830d908a665ca5a8dc` | `sha256:d09d94026eecbd97d923696e3e8b0d3dfccd0cb455ef90830d908a665ca5a8dc` |

The independent verifier loaded the finished artifact, recomputed the tape, input-row-set, feature-matrix, watermark,
and receipt hashes, and compared all four expected anchors. It returned:

```json
{
  "reason_codes": [],
  "row_count": 809,
  "status": "verified"
}
```

The verifier was then run against the unchanged tape with an intentionally wrong expected receipt hash. It exited
nonzero and returned exactly:

```json
{
  "reason_codes": ["expected_receipt_sha256_mismatch"],
  "status": "rejected"
}
```

A separate paper-probation negative control omitted replay metadata. It remained blocked with both independent reason
codes:

```json
{
  "reason_codes": ["missing_replay_tape_metadata", "missing_point_in_time_replay_receipt"],
  "status": "blocked"
}
```

The verifier boundary can be reproduced without trusting materializer console output:

```bash
kubectl -n torghut exec <scheduler-pod> -- \
  python /app/scripts/verify_point_in_time_replay_tape.py \
  --tape <materialized-tape> \
  --expected-content-sha256 bf45a3a5195b67c694e6f62fff2938f1ea2d72b291d6fd647b66cf2313f0ca18 \
  --expected-receipt-sha256 sha256:ccad254ad784f1791cdfe0f8e25ae98deab846cb719609b789a613d5ad136404 \
  --expected-input-row-set-sha256 sha256:376f9996c4e1eaf8ef49ba3c47addd725ce327cdb411f5ea3f4573722b2820ad \
  --expected-feature-matrix-sha256 sha256:d09d94026eecbd97d923696e3e8b0d3dfccd0cb455ef90830d908a665ca5a8dc
```

The controlled validation tapes were non-candidate artifacts. Their hashes and outcomes were retained here, and their
temporary in-pod directory was removed after verification rather than leaving garbage in the scheduler container.

## GitOps And Singleton Readback

The promoted image contains both the point-in-time implementation and its independent verifier. Live workload readback
after Argo convergence showed:

| Runtime          | Active object                  | Desired | Ready | Traffic |
| ---------------- | ------------------------------ | ------: | ----: | ------: |
| API              | `torghut-01535-deployment`     |       1 |     1 |    100% |
| Paper simulation | `torghut-sim-01607-deployment` |       1 |     1 |    100% |
| Scheduler        | `torghut-scheduler`            |       1 |     1 |     N/A |

Both Knative Services reported `Ready=True` with identical latest-created and latest-ready revisions. All older
Knative revision Deployments had zero desired replicas, and the earlier `torghut-01510` through `torghut-01515` objects
had been garbage-collected. One API revision, one deliberately separate simulation revision, and one scheduler were
active; there were no duplicate trading owners.

## Market-Data And Capital Verdict

The point-in-time machinery works, but the live input set is not adequate for profitability validation. At independent
cutoff `2026-07-18T20:54:45.651837+00:00`, the retained July 8-17 audit found no usable AAPL or META day. NVDA was the
only audited symbol with data, and no NVDA day met the existing requirement of at least 18,000 executable rows with a
maximum 120-second executable gap.

For `2026-07-15`, both source tables contained 16,276 selected rows, but only 809 rows were executable; 776 had sane
spread, quote-valid ratio was approximately `0.9592`, and the maximum executable gap was 392 seconds. On
`2026-07-16`, only 615 rows were executable and the maximum gap was 410 seconds.

This is a hard profitability blocker, not a verifier defect. Sparse executable coverage cannot support a credible
after-cost estimate or promotion decision, and a deterministic receipt does not make inadequate data sufficient.
Risk-increasing capital remains blocked. No broker order, account mutation, capital grant, or profitability claim was
made by this slice.

Rollback remains fail-closed: legacy tapes may be inspected but cannot become promotion evidence. Never restore the
sequence-omitting join, ignore arrival time, or accept a missing receipt to make a candidate pass.
