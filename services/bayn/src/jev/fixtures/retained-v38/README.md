# Original v38 execution evidence

These synthetic fixtures were captured independently with original v38 production constructors and strict
`decodeExecutionDecisionDocument` / target decoders. They are immutable regression inputs, not live account data.
The candidate, ablation and repeated-momentum controls all produced protected entry intents and complete
protective-stop close documents under the baseline implementation.

## Captures and identities

The Bun 1.4.3 captures use unchanged Bayn production sources at
`8f87974758c4490bbfc9549fc7c44ba5f02f871a`. The Node 24.11.1 captures use
`5d776325dda0bec3a44e4eae8efbbfa4961ff475`, based on that same revision with the original v38
decision/builder sources unchanged. Helpers for full control/exit construction are test-only extractions of
existing fixture construction; no successor production code was used to generate original evidence.

| File                                    | Original runtime                                  | Canonical bytes | SHA-256 of decompressed canonical JSON                             |
| --------------------------------------- | ------------------------------------------------- | --------------: | ------------------------------------------------------------------ |
| `entry-equity.json.gz`                  | Bun 1.4.3                                         |       1,523,926 | `265d5a690d7729a38d456dbe684b5d95fb0f56b4fe66bf8eef6f55923e03aaf0` |
| `exit-protective-stop-document.json.gz` | Bun 1.4.3                                         |          34,714 | `d88e147ced2f32dee0f01f529e835455b04453607ca6f3830da34a77154da655` |
| `exit-protective-stop-target.json.gz`   | Bun 1.4.3                                         |          12,568 | `765492ba111076a59162a58e34a77e7d69246d5e44e81ca49d3814b3b769ef01` |
| `entry-ablation-document.json.gz`       | Bun 1.4.3                                         |       1,458,989 | `a4340e022a6397202d175c2b8c2e9e1ccd8524e43f30d57a474b626cce92c9a8` |
| `entry-momentum-document.json.gz`       | Bun 1.4.3, also verified by original Node 24.11.1 |       1,061,094 | `1267f6cd0b904a80cfc34febd15df027a64033d6f3003540259d5888f94464db` |
| `node-entry-equity.json.gz`             | Node 24.11.1                                      |       1,523,926 | `313ee50a8740412c5fa69ccf4753dd5e53be99a6e578dc968857859a5ff4500e` |
| `node-exit-equity.json.gz`              | Node 24.11.1                                      |          34,714 | `f89e444fd3fe538346344f9c2f8e21dab6b995a9e901beb8374742300c7fbfad` |
| `node-entry-ablation.json.gz`           | Node 24.11.1                                      |       1,522,195 | `ce05d8ed4a7396abe7adf18f695401b8313004e34f7275dbfc396c17113b1fb7` |
| `node-exit-ablation.json.gz`            | Node 24.11.1                                      |          34,714 | `6b484aea69fda9cb2576e93ef149c7c2f6db7f6ac01fe0928d648e3e1923f9bd` |
| `node-exit-momentum.json.gz`            | Node 24.11.1                                      |          34,714 | `1f295ab9a50da75e4d0d87913a2f78e5181717ff6125d4548e181e54572d8941` |

The candidate entry uses the original `persistenceDocumentFixture`. The Bun control entries use the original
`executionLifecycleFixture` with `makeEntryAblationRuntime` or `makeRepeatedMomentumRuntime`. Complete exits use
`makeProtectiveStopDocumentFixture` against the original production builder, and Node control entry uses
`controlDocumentFixture` against those original sources. The standalone exit target preserves the existing
wide-spread protective-stop case.

Adjacent `node-*.provenance.json` files preserve the original capture metadata: source/base revisions, runtime,
canonical/gzip byte lengths and SHA-256 values, deterministic gzip parameters and compiled harness hashes.
The original capture paths are provenance only; tests load checked-in files from this directory.

The document `contentHash` excludes its own field and therefore differs from the whole-file digest.
Both identities and exact canonical bytes are pinned in `retained-v38-execution.test-support.ts` and the Node
test helper. Do not regenerate these files with a successor implementation or rewrite them to match a new decoder.

## Runtime-bound chart bytes

PNG `IDAT` compression differs between Bun 1.4.3 and Node 24.11.1 even with identical source bars,
decoded scanlines and non-IDAT chunks. Those PNG bytes are part of request identity. The Bun and Node candidate
and ablation entry fixtures are replayed with their original runtime; hashes are never substituted or accepted
with a tolerance. The original momentum fixture also passes the original Node decoder and is used unchanged in
both runtime regressions.

`retained-v38-node.test.ts` builds the Node verifier and runs a bounded, cleaned-up child process over all six
original Node-compatible entry/exit variants, including the public financial projection. Bun regressions cover
all six native/control entry/exit variants, current admission rejection, exact policy identity and outer-rehashed
tampering. Existing operator commands already invoke compiled Node bundles. This correction changes neither
the renderer/compression policy nor those launchers.
