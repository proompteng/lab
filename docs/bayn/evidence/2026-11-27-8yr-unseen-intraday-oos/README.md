# Wave 4E — blind archive admission

**No verdict.** The supplied eight-year archive does not have the frozen Wave 3B universe. The blind 5m object was
not opened or scored. Do not use a subset replay to claim that the registered engines were verified or that the
2016–2026 equity curve was stitched.

The [protocol](protocol.md) and [freeze receipt](freeze.json) fix the roster, dates, parameters and execution
model before any blind bars are requested.

| Metadata comparison                                 | Result                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Declared universe                                   | 62 names in each manifest, only **45** in common.                                            |
| Missing from the blind manifest                     | ALAB, ARKK, CEG, CRDO, GEV, HOOD, INTC, MSTR, NET, SNOW, SOFI, SPOT, USO, VRT, VST, XBI, XLY |
| Unexpected names in the blind manifest              | ADBE, BAC, COST, CRM, DELL, DIA, GS, HD, HYG, INTU, JPM, LLY, QCOM, SLV, TXN, UNH, XOM       |
| Missing Wave 3B stocks already listed by 2023-12-29 | **11:** CEG, CRDO, HOOD, INTC, MSTR, NET, SNOW, SOFI, SPOT, VRT, VST                         |

Of the **13** missing Wave 3B stocks, only ALAB and GEV were not yet listed. The **11** already-listed stock
omissions matter: absence of INTC changes the 21-name live-v2 approximation, and the other omissions change OR5's
RVOL ranking, reversion's cross-sectional IQR and either book's selection. SNDK is declared, with no rows as expected
for the current security before its 2025 regular-way listing.

Reproduce the read-only manifest check from the repo root with the mounted artifact credentials:

```sh
bun services/bayn/tools/research-8yr-unseen-intraday-oos.ts --audit
```

It exits nonzero on the pinned manifest and does not request a bar object. To unblock scoring, provide an immutable
split-adjusted Alpaca SIP 5m export for the exact frozen 62-name roster, with a manifest attesting coverage for
each already-listed name and a pinned calendar for the same 2,012 official sessions. The row count and object
checksum must come from that export, not from the mismatched one. No existing alternative 2016–2023 five-minute
object was found under the published `bayn-research-datasets/` prefix.

The scorer is wired separately from the metadata audit. It verifies that the exact code revision and the unchanged
strategy freeze are published on the study branch before requesting tape. Once an admissible input receipt is bound,
`--score --output <new JSON file>` writes the annual and aggregate metrics, exact LOSO reruns, bootstrap, attribution
and stitched daily curves. No results file is present for the rejected archive. Fixtures exercise the fill and admission
rules; passing them does not establish economic performance.
