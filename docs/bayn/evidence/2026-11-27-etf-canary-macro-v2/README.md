# Bayn Wave 4D: Ultra-low-turnover canary and macro ETF research

**Evidence status: missing required inputs.** The pinned SIP manifest and its matching TSV
contain SMH and VNQ instead of the requested DIA and UUP. This is the same object documented in
[Wave 3C's freeze](https://github.com/proompteng/lab/blob/e021694cf3672ce556f4c1290d93632cd5134101/docs/bayn/evidence/2026-11-27-10yr-multi-asset-risk-premia/freeze.json).
Trading or signaling without UUP would remove the FX sleeve and dollar regime mechanism, not
test them. The runner refuses to generate a freeze or result on this incomplete universe. No
Holdout evaluation or profitability claim has been made.

The [protocol](protocol.md) registers 135 configurations spanning canary defensive allocation,
continuous cross-asset trend, credit/inflation/dollar timing, defensive sector rotation, and
a fixed-risk-budget ensemble. It sets the friction scenarios, SHY hurdle, turnover targets
and evidence gates before scoring. The historical tape is reused from Wave 3C; even a passing
result would not be independent evidence or authority to trade.

## Reproduction

Use an approved DIA/UUP SIP `adjustment=all` daily archive for the exact 2,741 primary sessions.
It must be gzipped, headerless and tab-separated in the same ordered per-symbol format:
symbol, UTC daily timestamp, open, high, low, close, volume, VWAP. Identify the export with
a stable nonsecret source ID. Keep the raw data outside the checkout; don't commit the
export, presigned URL or credentials.

```sh
study=services/bayn/tools/research-etf-canary-macro-v2.ts
evidence=docs/bayn/evidence/2026-11-27-etf-canary-macro-v2

bun "$study" --freeze "$evidence/freeze.json" --supplement "$source_id" "$bars_gz"
# Commit and push protocol.md, freeze.json, and the exact CLI and helper sources before scoring.
bun "$study" --score "$evidence/freeze.json" "$evidence/results.json" --supplement "$source_id" "$bars_gz"
```

The scorer checks the exact development receipt on `origin/codex/bayn-w4d-etf-risk-premia-v2`,
then independently reproduces it using the pinned code and inputs. It does not open Holdout
prices unless both checks pass. Each output path must be new.
