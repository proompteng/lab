# Bayn test-suite audit — Wave 18A

## Baseline and result

The baseline is `a92be10d351664e607c3d7d81d3f12c00aa07415`. Both runs used Bun 1.4.3 with no external integration
fixtures or broker credentials. The full inventory includes the normal `src` and `tools` suites, plus formal
conformance and the production Node smoke tests:

```sh
cd services/bayn
bun test src tools formal scripts --parallel=8 --timeout=15000 --reporter=junit --reporter-outfile=/tmp/bayn-audit.xml
```

| Scope                        | Before: files | After: files | Before: passed | After: passed | Before: skipped | After: skipped |
| ---------------------------- | ------------: | -----------: | -------------: | ------------: | --------------: | -------------: |
| Normal unit run: src + tools |           639 |          639 |          7,040 |         7,040 |           1,826 |          1,826 |
| All Bayn TypeScript tests    |           647 |          647 |          7,042 |         7,042 |           1,908 |          1,908 |

No files or registered cases qualified for deletion. The one prune removes a second identical call and assertion
in the [broker normalization test](../../services/bayn/src/simulation-reconciliation/broker-normalization.test.ts).
The pure function still runs once for each of the two row orders in that case, against the same expected result.
No distinct input, assertion, or test case was removed.

## Why tests skip

The JUnit inventory reports 1,908 skips across 107 files. The skip registrations are conditional: they stand in for
disposable stores, native binaries, or artifacts that the credential-free run does not create. No unconditional
`describe.skip`, `test.skip`/`it.skip`, or TODO registrations were found. Counts below group by the file's owning
fixture; a few files have cases with additional prerequisites.

| Fixture missing in the audit run                                          |   Files |     Skips | Where it is exercised                                                                                                                                        |
| ------------------------------------------------------------------------- | ------: | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Isolated PostgreSQL (some cases also require a Lean model or TigerBeetle) |      74 |     1,709 | [PostgreSQL shards](../../services/bayn/tools/test-postgres.ts), with additional cases owned by formal, streaming, or ledger CI                              |
| Lean model executable or TLC's checked reachable-state dump               |       7 |        82 | [Formal workflow](../../.github/workflows/bayn-formal.yml)                                                                                                   |
| TigerBeetle, plus PostgreSQL for durable replay                           |      12 |        70 | [Ledger groups](../../services/bayn/tools/test-ledger.ts); the cumulative account-history check is an optional loopback run                                  |
| Restate admin and ingress; some cases also need PostgreSQL or Kafka       |       7 |        23 | [Market replay](../../services/bayn/scripts/test-market-data-replay.sh) and [streaming](../../services/bayn/scripts/test-streaming-integrations.sh) fixtures |
| ClickHouse archive, including the JDBC fixture and Dorvud feature jar     |       4 |        18 | `archive-integration` in [Bayn CI](../../.github/workflows/bayn-ci.yml)                                                                                      |
| Built replay image and native execution observer                          |       2 |         5 | `replay-execution-observer` in [Bayn CI](../../.github/workflows/bayn-ci.yml)                                                                                |
| Native OpenCode binary (`BAYN_TEST_OPENCODE_BINARY`)                      |       1 |         1 | [OpenCode image verification](../../nix/images/opencode.nix)                                                                                                 |
| **Total**                                                                 | **107** | **1,908** |                                                                                                                                                              |

The largest group is database coverage, not retired tests: the OBSERVE migration matrix alone accounts for 343
skips, followed by durable broker observations (107) and blocked-cycle persistence (98). Older policy and protocol
names aren't evidence of dead coverage. Migration, replay, and retained-record tests still protect persisted bytes,
hashes, and fail-closed adoption of historical data. Live execution, broker, accounting, reconciliation, risk,
B0/F4/O1/v3, audit, and hash-locked research coverage all remain in place.

## CI routing

- **Fast PR:** every changed path, including the old path of a move, is under `services/bayn/tools/` or `docs/bayn/`
  and is an offline input. This runs lint, type checking, and Bun/Python tools unit tests without disposable services.
  CI drivers and integration tests, production build/acceptance inputs, and broker/Restate mutation tools under
  those directories are not eligible.
- **Full:** service source (including tests), migrations, Bayn GitOps, workflow changes, and Bayn changes that mix
  offline inputs with files outside the allowlist (including `nix/`). The full tier still requires the proof
  jobs, all four PostgreSQL shards, streaming and market replay, archive and ledger integration, the replay image
  and execution observer, source and contract checks, and GEPA. Merge groups, dispatches, and release callers
  always use this tier.

The required check is still **Bayn release gate**. It requires success from every selected job and a skipped
result from every unselected job. Skips inside credential-free test runs do not replace the full-tier jobs that
supply those fixtures.
