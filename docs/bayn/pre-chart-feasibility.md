# Pre-chart entry feasibility

Bayn checks whether either existing source-anchored entry template can fund a proposal before dispatching the chart
provider. A source that cannot pass either template records `SOURCE_INFEASIBLE`. It has no chart response or dependent
Jev response. Its immutable handoff binds the original input and the prepared chart request hash, and both inference
expense stages record `NOT_DISPATCHED` with zero tokens and cost.

The predicate and the final proposal constructor share the same protective-price and liquidation-funding function.
Support recovery tests every source stop against the greatest observed resistance target. Conservative exit net value
is monotone in the target, so a lower observed resistance cannot rescue an unfundable maximum. Base breakout tests
all contiguous intervals of at least two source bars ending before the newest bar. It retains the requirement that
the current bid has broken the interval high. No model judgment, stop, target, fee, quote allowance, capital allocation,
claim deadline or submission/risk rule is relaxed. Numerically possible sources still require the original chart and
Jev judgments and all subsequent validation.

The predicate only rules out sources it can bound. An unselected source price outside the funding arithmetic's
representable range does not prove that every selectable proposal is unfundable. Such a source retains the existing
chart/proposal validation path. Other malformed input and funding failures remain typed failures.

`decodeEntryHandoff` independently recomputes the predicate before accepting `SOURCE_INFEASIBLE`. A resealed skip
for a fundable source fails validation. An inference completion cannot claim a received provider response for that
handoff. Late receipts remain usable for accounting only and never extend entry validity. Historical chart responses,
including the retained input-v1 financial read path, preserve their original prices, images, judgments and costs.

## Existing-data acceptance

The private native export frozen at `2026-10-26T00:10:38.309606Z` contains 684 v24 requests. Replaying it gives:

| Result                                                         | Requests |
| -------------------------------------------------------------- | -------: |
| Proven source infeasible, neither provider dispatched          |      664 |
| Possible source reaches terminating offline chart sentinel     |       20 |
| Originally funded requests retained with exact proposal hashes |        7 |
| Changed original proposal evaluations                          |        0 |
| Actual provider calls made by the verifier                     |        0 |

The verifier uses the real entry Effect, immutable handoff decoder, receipt decoder and expense projection for skipped
requests. Possible sources terminate at an offline sentinel before returning any model response. Historical input-v1
sources use their original renderer for preservation checks. For dispatch probes only, they are explicitly projected
to the current input-v4 format and question policy with the same source bars, prices, funding and economic protocol. Historical responses are never
assigned to those projected requests, and neither probe requests nor receipts are written to a trading database.

Build the verifier for Node and run it with the pinned Node runtime. Production PNG hashing uses Node's zlib; running
this historical-image verification directly under Bun does not reproduce production PNG hashes.

```sh
bun build services/bayn/tools/verify-entry-feasibility.ts \
  --target=node --external tigerbeetle-node --external @platformatic/kafka \
  --outfile services/bayn/dist/verify-entry-feasibility.mjs
node services/bayn/dist/verify-entry-feasibility.mjs <existing-native-export.ndjson.gz> <new-report.json>
```

The export consists of one JSON object per line with `request`, `receipt`, `handoff` and `resolution` fields. Each graph
is decoded through the native financial evidence reader before evaluation. Keep account evidence private; the dataset
is not committed. `actualProviderCalls=0` refers to the offline verifier. Normal production requests that remain
numerically possible continue through the existing provider path.

The cohort is development evidence for a dispatch optimization, not a prospective profitability experiment. Skipping
an impossible source saves inference work; it does not establish a Jev edge, a broker fill or profitability.

Current input-v5 exports must also include each row's original `stagedCheckpoint`. The verifier uses the owning
staged financial reader to validate the CHART and conditional BASE_START claims, receipts and skips, and the original
market-specific Jev questions. Missing stage evidence fails verification. Retained v1–v4 documents continue through
their financial-only readers with their original question contracts.

The current dispatch probe constructs the same initial CHART stage as execution. It never constructs the retired
all-end base-start matrix. For current-protocol handoffs, the initial request hash must match the original native
handoff. Report v3 includes the verified original evaluation hash, original Jev question names and projected initial
chart request hash. Original source-infeasible handoffs and incomplete provider graphs are validated by their owning
reader before probing; a failed or absent chart result cannot count as a preserved funded proposal. All probe provider
branches terminate at local sentinels. The probe cannot dispatch a model request or submit an order.

Run `bun test tools/verify-entry-feasibility.test.ts` from `services/bayn` for current equity and crypto questions,
missing-checkpoint rejection, authenticated undispatched costs, and retained financial evidence.

## Rollout and recovery

Use the normal immutable Bayn build and `lab-delivery/bayn` Kargo promotion through `kargo/bayn` and Argo. The gate changes
provider dispatch and evidence, not the economic acceptance policy. The original feasibility-only change required no
mandate or database migration. The funded-anchor migration uses input v4, handoff v3 and migration 152, retaining
`SOURCE_INFEASIBLE`, the native OBSERVE cutover and a new reviewed same-account mandate for the revised question policy.
Retained input-v2/v3 skips remain reproducible for financial audit. Handoff and expense tables enforce the original
request, immutable hash and provider-stage bindings.

Readers and the single execution writer must all use the promoted image. Older binaries do not decode the new
`SOURCE_INFEASIBLE` variant and fail closed if they encounter it during rollout. After the new variant is persisted,
recovery must use an image whose readers support it; do not rewrite retained evidence or blindly roll back to a
pre-gate reader. Preserve Kargo promotion lineage and normal authority, reconciliation and risk checks.

Runtime acceptance requires the promoted source/image, ready workloads, new natural `SOURCE_INFEASIBLE` handoffs,
completed `NOT_REQUESTED` Jev receipts and zero chart/Jev usage quotes for those requests. Do not trigger a paid model
call or a broker order to obtain an acceptance receipt.
