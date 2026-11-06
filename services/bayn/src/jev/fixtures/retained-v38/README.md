# Original v38 execution evidence

These synthetic fixtures were captured independently with original v38 production constructors and strict
`decodeExecutionDecisionDocument` / target decoders. They are immutable regression inputs, not live account data.
The candidate, ablation and repeated-momentum controls all produced protected entry intents and complete
protective-stop close documents under the baseline implementation.

## Captures and identities

The Bun 1.4.3 captures and both crypto captures use unchanged Bayn production sources at
`8f87974758c4490bbfc9549fc7c44ba5f02f871a`. The other Nix Node 24.11.1 captures use
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
| `entry-crypto-bun.json.gz`              | Bun 1.4.3                                         |         245,187 | `8190e6d80bfa29d7c2f11d5521977e7bedb43071d6f3858574fad7bd699f7413` |
| `entry-crypto-node.json.gz`             | Nix Node 24.11.1                                  |         245,187 | `79a832650d6e5deebbe4d1b1acbceee7a48d3661e33c63024460aa037e7f5e2d` |

The candidate entry uses the original `persistenceDocumentFixture`. The Bun control entries use the original
`executionLifecycleFixture` with `makeEntryAblationRuntime` or `makeRepeatedMomentumRuntime`. Complete exits use
`makeProtectiveStopDocumentFixture` against the original production builder, and Node control entry uses
`controlDocumentFixture` against those original sources. The standalone exit target preserves the existing
wide-spread protective-stop case. Both crypto documents use the baseline `cryptoPersistenceDocumentFixture`.
The adjacent crypto metadata records complete `process.versions`, original source and helper/bundle hashes.

Adjacent `*.provenance.json` files preserve the original capture metadata: source/base revisions, runtime,
canonical/gzip byte lengths and SHA-256 values, deterministic gzip parameters and compiled harness hashes.
The original capture paths are provenance only; tests load checked-in files from this directory.

The document `contentHash` excludes its own field and therefore differs from the whole-file digest.
Both identities and exact canonical bytes are pinned in `retained-v38-execution.test-support.ts` and the Node
test helper. Do not regenerate these files with a successor implementation or rewrite them to match a new decoder.

## Runtime-bound chart bytes

PNG `IDAT` compression differs between Bun 1.4.3 and production Nix Node 24.11.1 even with identical source bars,
decoded scanlines and non-IDAT chunks. Those PNG bytes are part of request identity. Node's version number alone
also does not identify its compressor: the official Node 24.11.1 Linux build uses bundled
`1.3.1-470d3a2`; the production Nix build uses shared zlib `1.3.1`.

`node-build-parity.provenance.json` records an independent original-v38 decoder check, SHA-verified official Node
archive, full runtime/library metadata and PNG hashes. The same original Nix fixture passes the old Nix decoder
and fails the old official-Node decoder. Both produce the same decoded scanlines and non-IDAT chunks, but their
IDAT streams are 5,329 and 5,314 bytes respectively. This is a pre-existing byte-identity boundary, not a new
retained-verifier difference or a portability guarantee.

`scripts/retained-v38-node.test.ts` builds the Node verifier and runs a bounded, cleaned-up child process over
all seven original production-compatible entry/exit cases, including native crypto and the public financial
projection. `nix/images/bayn.nix` runs `test:production-runtime` unconditionally during both architecture image
builds, with its exact production Node first on the child PATH. The script is included in service type, format
and lint checks. Its temporary bundle and these synthetic input files are not copied into the shipped image.

Bun unit regressions retain all seven original native/control/crypto documents, current admission
rejection, exact policy identity and outer-rehashed tampering. The original momentum fixture passes both original
Bun and Nix Node decoders and is reused unchanged. No test dynamically skips a mismatched runtime or accepts
alternate hashes. Existing operator commands already invoke the image's Node bundles. This correction changes
neither renderer/compression policy nor operator launchers.
