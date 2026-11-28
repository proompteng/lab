# Wave 10D: orthogonal ETF Pillar 3

**Input blocked; Holdout has not been opened.** The [protocol](protocol.md) registers 34 trials across rates,
commodities/FX, sector relative strength, and ensembles. The two requested frozen manifests list 27 primary ETFs
and the DIA/UUP pair. Neither lists **TIP**, which is indispensable to the registered breakeven and combined
rates signals. There is no development freeze, performance result, or promotion decision. Scoring the other
families now would expose Holdout before the full grid can be frozen.

| Frozen `agents-artifacts/bayn-research-datasets/` prefix | Manifest SHA-256                                                   | TIP coverage          |
| -------------------------------------------------------- | ------------------------------------------------------------------ | --------------------- |
| `2026-11-27-sip-10yr-sp100/`                             | `ffaa9d30d69d38307f69ec77f07c12cdd82c7407131a110bc3b88421b0f1676e` | Not in the ETF roster |
| `2026-11-27-sip-10yr-sp100-supplement-dia-uup/`          | `ea0324abff46b2a44ea718dfbac625b9c434a1d21addc77eb5491d0249a79355` | Only DIA and UUP      |

## Resume without changing the grid

Supply an explicitly approved, immutable Alpaca SIP daily `adjustment=all` TIP export covering exactly the
registered 2,741 sessions. The runner expects `tip.tsv.gz` in the same headerless TSV format as the DIA/UUP
supplement and `MANIFEST.json` with:

- `schema: "bayn.wave10d.tip.v1"`, `symbol: "TIP"`, `feed: "sip"`, `adjustment: "all"`, `timeframe: "1Day"`
- `first: "2016-01-04"`, `last: "2026-11-25"`, `sessions: 2741`
- `gzipSha256` and `rawSha256`: lowercase SHA-256 of compressed and uncompressed bars

Provide the approved manifest SHA-256 separately. Use the existing read-only artifact credentials for the two
daily objects and the published B0 reference tapes.

```sh
runner=services/bayn/tools/research-10yr-orthogonal-pillar3.ts
evidence=docs/bayn/evidence/2026-11-27-10yr-orthogonal-pillar3
bun "$runner" --develop --output "$evidence/freeze.json" \
  --tip-source "$TIP_SOURCE" --tip-manifest-sha256 "$TIP_SHA256"
bunx oxfmt --write "$evidence/freeze.json"
# Commit and push the protocol and development freeze before running the next command.
bun "$runner" --score --output "$evidence/results.json" \
  --tip-source "$TIP_SOURCE" --tip-manifest-sha256 "$TIP_SHA256"
bunx oxfmt --write "$evidence/results.json"
```

Scoring requires the working receipt to equal the bytes committed in `HEAD` and its canonical content hash
to match a development-only replay. It does not depend on the original feature branch or the pre-squash commit.
The scorer has no trading capability and does not modify live strategy code.
