# Calendar-correct CosmosAlpha targets

Status: target generation and independent full-data verification, November 8, 2026.

The generator computes targets on each instrument's complete trading calendar before projecting index membership. It writes a new artifact and leaves prior trials and upstream source unchanged. This is a declared target-protocol correction, not an unchanged reproduction of the original return calculator.

## Frozen target rule

For a positive finite current close, select the first subsequent finite close inside the same split. A finite zero or negative endpoint invalidates the target; it is not skipped. Nonfinite closes represent missing observations. Returns spanning more than one calendar trading session are clipped to ±10%, preserving the reference suspension-compression rule. An adjacent-session return is not clipped, including a Friday-to-Monday return.

Each split starts with an empty endpoint state. An endpoint after its cutoff is unavailable, even if a later split has a valid price. Warmup and between-split rows have no admitted target. CSV rows retain their membership date, split, source masks, endpoint date, session distance, value and explicit status. Unknown masks remain unknown.

The implementation uses a discriminated target state in [the pure TypeScript kernel](../../packages/scripts/src/bayn/cosmosalpha-calendar-targets.ts). The [generator](../../packages/scripts/src/bayn/generate-cosmosalpha-targets.ts) decodes Qlib little-endian float32 files and writes a deterministic CSV and manifest. The manifest binds every consumed input file, the generator source, split definitions and CSV content. It excludes machine-specific source paths from the target identity. Existing output directories are rejected. A failed generation can leave an unsealed `.partial` CSV, but publishes no manifest.

## Reproduce

Create a private request JSON with the actual provider paths. Relative paths resolve against the request file.

```json
{
  "schemaVersion": "bayn.cosmosalpha-calendar-target-request.v1",
  "marketRoot": "cosmos-original-data/qlib_bin",
  "maskRoot": "cosmos-original-data/qlib_mask_bin",
  "fromDate": "2010-01-04",
  "splits": [
    { "name": "train", "startDate": "2010-04-01", "endDate": "2019-05-31" },
    { "name": "validation", "startDate": "2019-06-01", "endDate": "2020-12-31" },
    { "name": "test", "startDate": "2021-01-01", "endDate": "2025-12-31" }
  ]
}
```

```sh
bun packages/scripts/src/bayn/generate-cosmosalpha-targets.ts request.json fresh-target-directory
python3 packages/scripts/src/bayn/verify-cosmosalpha-targets.py \
  request.json fresh-target-directory --report fresh-verification.json
```

The verifier uses Python's standard library for binary decoding, independent forward endpoint lookup and exact numeric comparison. It does not import the generator. It independently reconstructs row coverage from the original calendar and membership intervals, recomputes every row, and checks input inventories, code identities and aggregate counts. Its report refuses to overwrite an existing file. A mismatch returns a failing exit status. Hash agreement alone cannot pass verification.

The optional native-reference readback also requires NumPy, available in the existing reference environment:

```sh
python3 packages/scripts/src/bayn/verify-cosmosalpha-targets.py \
  request.json fresh-target-directory \
  --native-reference native-source-summary.json native-artifacts-directory \
  --report fresh-native-verification.json
```

It verifies the retained native market and mask artifact hashes, decodes their validity arrays, checks complete membership coverage and compares every close and eligibility/universe mask with the original binaries.

## Observed full-data proof

The [verification receipt](evidence/2026-11-08-calendar-target-verification.json) covers all 1,165,440 projected rows and 800 instruments from January 2010 through December 2025. It verifies 2,403 source files, every endpoint/null state and all 1,122,941 finite labels with zero unexplained mismatches and zero numeric tolerance. The same 1,165,440 source price/mask rows also match the retained native snapshot. The report preserves 17,267 outside-split rows, 24,322 invalid-current rows and 910 cutoff rows rather than dropping them.

Target identity: `685c34e9aaa5f2c9d0d6d2ef380039ace15abd4b47235152102c23da6263e07e`.
CSV SHA-256: `806a92ffe7ce0bee3917883ba0b70b1fd93378708b719fe625b91f936de5bda1`.

The previously identified `sh600176` case on July 29, 2010 now ends on July 30, one trading session later, with return `0.00209464747811694`. The retained membership-filtered reference instead spanned 1,924 sessions and returned `2.0542520408909324`.

Twenty focused tests cover membership gaps, positive and negative suspension clipping, weekends, invalid endpoints, split boundaries and invariance to later-split prices. Integration tests check path-independent identities, unknown masks, source drift and output sealing. Deliberately changed values and deleted rows fail independent verification even after their hashes are resealed.

This proves target/source agreement under the stated rule. It does not certify industry point-in-time lineage, compare mining methods or establish an economic edge. Existing mining runs have not been migrated to these targets. Their next use requires an explicit new experiment identity.
